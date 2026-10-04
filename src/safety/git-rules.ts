import { checkTargets, optionValues, type SafetyContext } from './path-checks.ts';

/**
 * Git verdicts for `safe-run`. A denylist: it lists the forms that run a program, rewrite history,
 * or delete or overwrite work, and refuses every subcommand it does not know (aliases, `git-<name>`).
 */
type GitRule = (args: readonly string[], ctx: SafetyContext) => string | null;

/** Built-in subcommands; anything else may be an alias or a `git-<name>` helper that runs any program. */
const GIT_SUBCOMMANDS = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr',
  'check-ignore', 'check-ref-format', 'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-tree',
  'config', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'fetch', 'for-each-ref',
  'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree',
  'merge', 'merge-base', 'mv', 'name-rev', 'notes', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote',
  'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref', 'stash', 'status',
  'submodule', 'switch', 'symbolic-ref', 'tag', 'var', 'verify-commit', 'verify-tag', 'version', 'worktree',
]);
const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list', 'get', 'list']);
const GIT_CONFIG_WRITES = new Set(['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit', 'set', 'unset', 'edit', 'rename-section', 'remove-section']);
const PUSH_DESTRUCTIVE = ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '--prune'];
/** Merge strategies git ships; any other name makes git run a `git-merge-<name>` program. */
const MERGE_STRATEGIES = new Set(['ort', 'recursive', 'resolve', 'octopus', 'ours', 'subtree']);
/** Options that make git run a program or write a file somewhere git chooses, whatever the subcommand. */
const EXEC_OPTIONS: readonly { option: string; min: number }[] = [
  { option: '--upload-pack', min: 4 }, { option: '--receive-pack', min: 4 }, { option: '--exec', min: 4 },
  { option: '--ext-diff', min: 5 }, { option: '--open-files-in-pager', min: 6 },
  { option: '--template', min: 6 }, { option: '--no-verify', min: 8 },
];
const OUTPUT_OPTIONS: readonly { option: string; min: number }[] = [
  { option: '--output', min: 5 }, { option: '--output-directory', min: 12 }, { option: '--separate-git-dir', min: 6 },
];
/** Global options that take the next argument as their value. */
const GIT_VALUE_GLOBALS = new Set(['--namespace', '--super-prefix', '--attr-source']);
/** `xxx::address` makes git run `git-remote-xxx`; `ext::` runs any command line. */
const TRANSPORT_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;

/** `--fo` stands for `--force`: git accepts any unambiguous prefix of a long option. */
function isAbbrev(arg: string, full: string, min = 3): boolean {
  const name = (arg.split('=')[0] ?? '').toLowerCase();
  return name.length >= min && full.startsWith(name);
}

/** Letters of a bundled short option such as `-uf`; empty for anything else. */
function shortFlags(arg: string): string {
  return /^-[A-Za-z0-9]+$/.test(arg) ? arg.slice(1) : '';
}

function hasShort(args: readonly string[], letters: string): boolean {
  return args.some((arg) => [...shortFlags(arg)].some((letter) => letters.includes(letter)));
}

function hasLong(args: readonly string[], full: string, min = 3): boolean {
  return args.some((arg) => isAbbrev(arg, full, min));
}

/** Positional words, skipping options; `--` ends option parsing. */
function positionals(args: readonly string[]): string[] {
  const dashIndex = args.indexOf('--');
  const words = (dashIndex === -1 ? args : args.slice(0, dashIndex)).filter((arg) => !arg.startsWith('-'));
  return dashIndex === -1 ? words : [...words, ...args.slice(dashIndex + 1)];
}

function discardsWorktree(args: readonly string[]): boolean {
  return hasShort(args, 'f') || hasLong(args, '--force') || hasLong(args, '--discard-changes');
}

function isDestructivePushArg(arg: string): boolean {
  if (/^[+:]/.test(arg)) return true; // `+ref` forces, `:ref` deletes
  if (shortFlags(arg) !== '') return /[fd]/.test(shortFlags(arg));
  return PUSH_DESTRUCTIVE.some((option) => isAbbrev(arg, option));
}

/** `git config --get x`, `git config --list`, or a bare `git config user.name` (one key, no value). */
function isConfigRead(args: readonly string[]): boolean {
  if (args.some((arg) => GIT_CONFIG_WRITES.has(arg))) return false;
  return args.some((arg) => GIT_CONFIG_READS.has(arg)) || args.filter((arg) => !arg.startsWith('-')).length === 1;
}

/** Options that run a program or write somewhere git chooses; null when none is present. */
function universalProblem(subcommand: string, args: readonly string[], ctx: SafetyContext): string | null {
  if (args.some((arg) => TRANSPORT_HELPER.test(arg) || /=\w+::/.test(arg))) {
    return 'git transport helpers (ext::, fd::, ...) run other programs';
  }
  const exec = args.find((arg) => arg.startsWith('--') && EXEC_OPTIONS.some((rule) => isAbbrev(arg, rule.option, rule.min)));
  if (exec !== undefined) return `git ${exec.split('=')[0]} runs another program or skips hooks; run it yourself in your terminal`;
  const output = args.find((arg) => arg.startsWith('--') && OUTPUT_OPTIONS.some((rule) => isAbbrev(arg, rule.option, rule.min)));
  if (output !== undefined) return `git ${output.split('=')[0]} writes files where git is told to; run it yourself in your terminal`;
  const trees = optionValues(args, '', ['--git-dir', '--work-tree']);
  const outside = trees.length === 0 ? null : checkTargets(trees, ctx, 'point git at', { allowRoot: true, allowProtected: true });
  if (outside !== null && 'reason' in outside) return outside.reason;
  if ((subcommand === 'archive' || subcommand === 'format-patch') && hasShort(args, 'o')) {
    return `git ${subcommand} -o writes files where git is told to; run it yourself in your terminal`;
  }
  return null;
}

function checkoutRule(args: readonly string[]): string | null {
  const reason = 'git checkout that overwrites worktree files is blocked; run it yourself in your terminal';
  if (args.includes('--') || args.includes('.') || discardsWorktree(args)) return reason;
  if (hasShort(args, 'B') || hasShort(args, 'p') || hasLong(args, '--force-create') || hasLong(args, '--patch')) return reason;
  if (hasLong(args, '--ours') || hasLong(args, '--theirs')) return reason;
  // `checkout <rev> <path>` replaces files; `checkout -b <new> [<start>]` takes two words legitimately.
  return !hasShort(args, 'b') && positionals(args).length >= 2 ? reason : null;
}

function branchRule(args: readonly string[]): string | null {
  const reason = 'git branch force-delete, force-reset or force-rename can lose commits';
  const flags = args.map(shortFlags).join('');
  const forcing = flags.includes('f') || hasLong(args, '--force');
  return flags.includes('D') || flags.includes('M') || flags.includes('C') || forcing ? reason : null;
}

function tagRule(args: readonly string[]): string | null {
  const flags = args.map(shortFlags).join('');
  return flags.includes('d') || flags.includes('f') || hasLong(args, '--delete') || hasLong(args, '--force')
    ? 'git tag -d and -f remove or move tags' : null;
}

function rmRule(args: readonly string[], ctx: SafetyContext): string | null {
  if (hasShort(args, 'rf') || hasLong(args, '--recursive') || hasLong(args, '--force')) {
    return 'git rm -r and -f delete tracked files broadly; delete explicit paths with cws safe-run instead';
  }
  const paths = positionals(args);
  if (paths.length === 0) return 'git rm needs explicit paths';
  const checked = checkTargets(paths, ctx, 'git rm');
  return 'reason' in checked ? checked.reason : null;
}

function cloneRule(args: readonly string[], ctx: SafetyContext): string | null {
  if (hasShort(args, 'uc') || hasLong(args, '--config')) return 'git clone -u/-c runs programs or plants configuration';
  const words = positionals(args);
  if (words.length < 2) return null;
  const checked = checkTargets([words[1]!], ctx, 'clone into');
  return 'reason' in checked ? checked.reason : null;
}

function strategyRule(args: readonly string[]): string | null {
  const unknown = optionValues(args, 's', ['--strategy']).find((name) => !MERGE_STRATEGIES.has(name.toLowerCase()));
  return unknown === undefined ? null : `git merge strategy ${unknown} runs a git-merge-${unknown} program`;
}

function firstWord(args: readonly string[]): string | undefined {
  return positionals(args)[0]?.toLowerCase();
}

/** Subcommand rules: a reason when the call can discard work or plant code, otherwise null. */
const GIT_RULES: Readonly<Record<string, GitRule>> = {
  clean: () => 'git clean can erase untracked work broadly; delete explicit paths with cws safe-run instead',
  reset: (args) => (hasLong(args, '--hard') ? 'git reset --hard is blocked because it discards worktree changes' : null),
  push: (args) => (args.some(isDestructivePushArg) ? 'git push that forces, mirrors, prunes or deletes remote refs is blocked' : null),
  checkout: checkoutRule,
  switch: (args) => (discardsWorktree(args) || hasShort(args, 'C') || hasLong(args, '--force-create')
    ? 'git switch that discards worktree changes or resets a branch is blocked' : null),
  restore: () => 'git restore discards worktree changes; run it yourself in your terminal',
  stash: (args) => (['drop', 'clear'].includes(firstWord(args) ?? '') ? 'git stash drop and clear delete stashed work' : null),
  branch: branchRule,
  tag: tagRule,
  rm: rmRule,
  clone: cloneRule,
  config: (args) => (isConfigRead(args) ? null : 'git config writes are blocked: aliases and hooks set there run arbitrary programs'),
  rebase: (args) => (hasShort(args, 'x') || hasLong(args, '--exec') ? 'git rebase -x runs a command after each commit' : strategyRule(args)),
  bisect: (args) => (firstWord(args) === 'run' ? 'git bisect run executes a command the guard cannot inspect' : null),
  submodule: (args) => (firstWord(args) === 'foreach' ? 'git submodule foreach executes a command in every submodule' : null),
  gc: (args) => (hasLong(args, '--prune', 5) ? 'git gc --prune deletes unreachable objects for good' : null),
  reflog: (args) => (['expire', 'delete'].includes(firstWord(args) ?? '') ? 'git reflog expire/delete removes the only way back to lost commits' : null),
  worktree: (args) => (['remove', 'prune', 'move'].includes(firstWord(args) ?? '') ? 'git worktree remove/prune/move deletes or moves a working directory' : null),
  remote: (args) => (['remove', 'rm', 'prune'].includes(firstWord(args) ?? '') ? 'git remote remove/prune drops remote-tracking branches' : null),
  grep: (args) => (hasShort(args, 'O') ? 'git grep -O starts another program' : null),
  commit: (args) => (hasShort(args, 'n') ? 'git commit -n skips the hooks' : null),
  merge: strategyRule,
  pull: strategyRule,
  'cherry-pick': strategyRule,
  revert: strategyRule,
  mv: (args, ctx) => {
    const checked = checkTargets(positionals(args), ctx, 'move');
    return 'reason' in checked ? checked.reason : null;
  },
  bundle: (args, ctx) => {
    const target = positionals(args)[1];
    if (firstWord(args) !== 'create' || target === undefined) return null;
    const checked = checkTargets([target], ctx, 'write');
    return 'reason' in checked ? checked.reason : null;
  },
};

/** Where leading `-C`, `--git-dir` and `--work-tree` point git; null when all stay inside the project. */
function retargetProblem(globals: readonly string[], ctx: SafetyContext): string | null {
  const paths = optionValues(globals, 'C', ['--git-dir', '--work-tree']);
  if (paths.length === 0) return null;
  const checked = checkTargets(paths, ctx, 'point git at', { allowRoot: true, allowProtected: true });
  return 'reason' in checked ? checked.reason : null;
}

function gitGlobalProblem(globals: readonly string[], ctx: SafetyContext): string | null {
  if (globals.some((arg) => arg.startsWith('-c') || isAbbrev(arg, '--config-env', 4))) {
    return 'git -c and --config-env are blocked: inline config can define aliases and hooks that run arbitrary programs';
  }
  if (globals.some((arg) => arg.startsWith('--exec-path'))) return 'git --exec-path is blocked: it points git at other programs';
  return retargetProblem(globals, ctx);
}

/** Index of the subcommand: leading options, with the value of those that take one skipped. */
function subcommandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) {
    const arg = args[index]!;
    const takesNext = arg === '-C' || arg === '-c' || (!arg.includes('=') && (GIT_VALUE_GLOBALS.has(arg) || arg === '--git-dir' || arg === '--work-tree' || arg === '--config-env'));
    index += takesNext ? 2 : 1;
  }
  return index;
}

export function gitRule(args: readonly string[], ctx: SafetyContext): string | null {
  const index = subcommandIndex(args);
  const subcommand = args[index]?.toLowerCase();
  const rest = args.slice(index + 1);
  // The subcommand verdict comes first so `git -c x clean` still reads as a git clean.
  const rule = subcommand !== undefined && Object.hasOwn(GIT_RULES, subcommand) ? GIT_RULES[subcommand] : undefined;
  const subcommandProblem = rule?.(rest, ctx) ?? null;
  if (subcommandProblem !== null) return subcommandProblem;
  const globalProblem = gitGlobalProblem(args.slice(0, index), ctx);
  if (globalProblem !== null) return globalProblem;
  if (subcommand === undefined) return null;
  if (!GIT_SUBCOMMANDS.has(subcommand)) {
    return `git ${subcommand} is not a built-in git command; aliases and git-<name> helpers can run anything`;
  }
  return universalProblem(subcommand, rest, ctx);
}
