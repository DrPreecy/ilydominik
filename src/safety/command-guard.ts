import path from 'node:path';
import fs from 'node:fs';
import { CWS_DIR } from '../store/event-log.ts';

export interface SafetyContext {
  cwd: string;
  projectRoot: string;
  /**
   * True when cws itself runs exactly this argv with shell: false. Then `;` or `|` inside an
   * argument (a commit message, a log format) is plain text. A check-only verdict is often
   * followed by the caller retyping the command into a shell, so there they stay blocked.
   */
  runsWithoutShell?: boolean;
}

export interface SafetyDecision {
  ok: boolean;
  destructive: boolean;
  command: string;
  targets: string[];
  reason?: string;
  notes: string[];
}

const SHELL_OPERATORS = ['&&', '||', ';', '|', '<', '>'];
const DELETE_COMMANDS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'shred']);
const SHELL_ONLY_DELETES = new Set(['del', 'erase', 'rd', 'remove-item', 'ri']);
const MOVE_COMMANDS = new Set(['mv', 'move', 'move-item', 'mi']);
const SHELL_ONLY_MOVES = new Set(['move', 'move-item', 'mi']);
const MV_LONG_SWITCHES = new Set(['--force', '--no-clobber', '--verbose', '--interactive', '--update', '--no-target-directory']);
const REMOVE_ITEM_TARGET_FLAGS = new Set(['-path', '-literalpath']);
const REMOVE_ITEM_TARGET_PREFIXES = ['-path:', '-literalpath:'];
const REMOVE_ITEM_SWITCHES = new Set(['-recurse', '-force', '-whatif', '-verbose']);
const RM_LONG_SWITCHES = new Set(['--recursive', '--force', '--verbose', '--dir']);
/** Directories whose loss cannot be undone from inside the project. */
const PROTECTED_DIRS = ['.git', CWS_DIR];
/** Windows drops trailing dots and spaces and the `::$DATA` stream, so `rm.exe.` still runs rm.exe. */
const COMMAND_SUFFIX = /(?:[. ]+|::\$data|\.(?:exe|com|cmd|bat|ps1))$/i;
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** Programs that run another program or script the guard cannot see into. */
const LAUNCHERS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^(?:cmd|sh|bash|dash|ash|fish|ksh|mksh|zsh|csh|tcsh|pwsh.*|powershell.*)$/,
    reason: 'inline shell commands are blocked; pass the command and arguments directly to cws safe-run',
  },
  {
    pattern: /^(?:env|sudo|doas|su|runas|xargs|busybox|toybox|wsl|nohup|nice|ionice|timeout|stdbuf|chroot|setsid|time|watch|parallel)$/,
    reason: 'command wrappers run another program the guard cannot inspect; pass the inner command directly',
  },
  {
    pattern: /^(?:node|nodejs|deno|bun|python[0-9.]*|pythonw|py|pyw|perl[0-9.]*|ruby|php|lua|tclsh|osascript|cscript|wscript|mshta|rundll32)$/,
    reason: 'script interpreters can delete anything; review the script and run it yourself in your terminal',
  },
  {
    pattern: /^(?:npx|pnpx|bunx|uvx|pipx)$/,
    reason: 'package runners download and run code the guard cannot inspect; run it yourself in your terminal',
  },
];

type ArgsRule = (args: readonly string[]) => string | null;

const RUNNER_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  npm: ['exec', 'x'],
  pnpm: ['exec', 'dlx'],
  yarn: ['exec', 'dlx'],
};
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
const ROBOCOPY_DESTRUCTIVE = /^\/(?:mir|purge|move|mov)$/i;

/** Global git options that take the next argument as their value. */
const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
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

interface ParsedTargets {
  targets: string[];
  reason?: string;
}

function normalizeCommand(command: string): string {
  let name = path.win32.basename(command).toLowerCase();
  for (let previous = ''; previous !== name;) {
    previous = name;
    name = name.replace(COMMAND_SUFFIX, '');
  }
  return name;
}

function hasShellOperator(token: string): boolean {
  return SHELL_OPERATORS.some((op) => token === op || token.includes(op));
}

function hasWildcard(token: string): boolean {
  return /[*?[\]{}]/.test(token);
}

function resolvedPath(value: string, cwd: string): string {
  return path.resolve(path.isAbsolute(value) ? value : path.join(cwd, value));
}

function comparePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(child: string, parent: string): boolean {
  const c = comparePath(child);
  const p = comparePath(parent);
  const parentWithSep = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
  return c === p || c.startsWith(parentWithSep);
}

function isFilesystemRoot(target: string): boolean {
  const parsed = path.parse(path.resolve(target));
  return comparePath(target) === comparePath(parsed.root);
}

function block(command: string, destructive: boolean, reason: string, notes: string[] = []): SafetyDecision {
  return { ok: false, destructive, command, targets: [], reason, notes };
}

function allow(command: string, destructive: boolean, targets: string[], notes: string[] = []): SafetyDecision {
  return { ok: true, destructive, command, targets, notes };
}

function isDeleteSwitch(command: string, token: string): boolean {
  if (command === 'rm') return /^-[rRfivd]+$/.test(token) || RM_LONG_SWITCHES.has(token);
  if (command === 'remove-item' || command === 'ri') return REMOVE_ITEM_SWITCHES.has(token.toLowerCase());
  if (command === 'rmdir' && process.platform !== 'win32') return token === '-v' || token === '--verbose';
  if (command === 'rmdir' || command === 'rd') return /^\/[sq]$/i.test(token);
  return /^\/[fpq]$/i.test(token);
}

function deleteTargets(command: string, args: readonly string[]): ParsedTargets {
  const targets: string[] = [];
  const isPowerShellRemove = command === 'remove-item' || command === 'ri';
  const isCmdDelete = command === 'del' || command === 'erase' || command === 'rd'
    || (command === 'rmdir' && process.platform === 'win32');
  let operandsOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const lower = token.toLowerCase();
    if (token.length === 0 || token.includes('\0')) return { targets: [], reason: 'delete target must be a nonempty path without NUL characters' };
    if (operandsOnly) {
      targets.push(token);
      continue;
    }
    if (token === '--' && !isPowerShellRemove && !isCmdDelete) {
      operandsOnly = true;
      continue;
    }
    const prefixed = isPowerShellRemove
      ? REMOVE_ITEM_TARGET_PREFIXES.find((prefix) => lower.startsWith(prefix)) : undefined;
    if (prefixed) {
      const target = token.slice(prefixed.length);
      if (!target) return { targets: [], reason: `missing target for ${token}` };
      targets.push(target);
      continue;
    }
    if (isPowerShellRemove && REMOVE_ITEM_TARGET_FLAGS.has(lower)) {
      const next = args[index + 1];
      if (!next || next.startsWith('-') || next.includes('\0')) return { targets: [], reason: `missing or ambiguous target for ${token}` };
      targets.push(next);
      index += 1;
      continue;
    }
    if (isDeleteSwitch(command, token)) continue;
    if (token.startsWith('-') || (isCmdDelete && token.startsWith('/'))) {
      return { targets: [], reason: `unsupported or ambiguous ${command} option: ${token}; use explicit paths and supported flags` };
    }
    targets.push(token);
  }

  return { targets };
}

function physicalPath(value: string): string {
  try {
    fs.lstatSync(value);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.resolve(physicalPath(parent), path.basename(value));
  }
  return fs.realpathSync.native(value);
}

function physicalDeleteTarget(rawTarget: string, cwd: string): string {
  const absolute = path.isAbsolute(rawTarget) ? rawTarget : `${cwd}${path.sep}${rawTarget}`;
  const followsFinalDirectory = /[\\/]$|(?:^|[\\/])\.{1,2}$/.test(rawTarget);
  if (followsFinalDirectory) return physicalPath(absolute);
  return path.resolve(physicalPath(path.dirname(absolute)), path.basename(absolute));
}

/** Lexical problems with a target, before any path is resolved. */
function targetProblem(raw: string): string | null {
  if (hasWildcard(raw)) return `wildcard deletes are blocked: ${raw}`;
  if (DRIVE_RELATIVE.test(raw)) return `drive-relative paths are blocked because they resolve against that drive's current folder: ${raw}`;
  if (raw.replace(DRIVE_ABSOLUTE, '').includes(':')) return `a colon in a delete target is blocked (alternate data stream or device path): ${raw}`;
  const segments = raw.split(/[\\/]/);
  if (process.platform === 'win32' && segments.some((part) => part !== '.' && part !== '..' && /[. ]$/.test(part))) {
    return `Windows ignores trailing dots and spaces in names, so this target is ambiguous: ${raw}`;
  }
  return null;
}

/** The protected directory a path lies in, judged by every segment below `root`. */
function protectedDir(target: string, root: string): string | undefined {
  const relative = path.relative(root, target);
  if (relative === '' || path.isAbsolute(relative)) return undefined;
  const segments = relative.split(path.sep).map((part) => part.toLowerCase());
  return PROTECTED_DIRS.find((dir) => segments.includes(dir.toLowerCase()));
}

function realPathOrNull(value: string): string | null {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

/**
 * `mv` operands, sources and destination alike: moving a file out of the project loses it
 * here, and moving onto a file replaces it, so every operand gets the delete-path checks.
 */
function moveTargets(args: readonly string[]): ParsedTargets {
  const targets: string[] = [];
  let operandsOnly = false;
  for (const token of args) {
    if (token.length === 0 || token.includes('\0')) return { targets: [], reason: 'move operand must be a nonempty path without NUL characters' };
    if (operandsOnly) {
      targets.push(token);
    } else if (token === '--') {
      operandsOnly = true;
    } else if (/^-[finvuT]+$/.test(token) || MV_LONG_SWITCHES.has(token)) {
      continue;
    } else if (token.startsWith('-') || token.startsWith('/')) {
      return { targets: [], reason: `unsupported or ambiguous mv option: ${token}; use explicit paths and supported flags` };
    } else {
      targets.push(token);
    }
  }
  if (targets.length < 2) return { targets: [], reason: 'mv needs explicit source and destination paths' };
  return { targets };
}

/** Each raw path, resolved and checked; a reason string when any of them may not be touched. */
function checkTargets(rawTargets: readonly string[], ctx: SafetyContext, verb: string): { targets: string[] } | { reason: string } {
  const root = path.resolve(ctx.projectRoot);
  const targets: string[] = [];
  try {
    const physicalRoot = physicalPath(root);
    for (const rawTarget of rawTargets) {
      const problem = targetProblem(rawTarget);
      if (problem !== null) return { reason: problem };
      const target = resolvedPath(rawTarget, ctx.cwd);
      if (isFilesystemRoot(target)) return { reason: `refusing to ${verb} filesystem root: ${target}` };
      if (comparePath(target) === comparePath(root)) return { reason: `refusing to ${verb} the project root: ${root}` };
      if (!isSameOrInside(target, root)) return { reason: `refusing to ${verb} outside the project root: ${target}` };
      const physicalTarget = physicalDeleteTarget(rawTarget, ctx.cwd);
      if (comparePath(physicalTarget) === comparePath(physicalRoot)) return { reason: `refusing to ${verb} the physical project root` };
      if (!isSameOrInside(physicalTarget, physicalRoot)) return { reason: `refusing to ${verb} outside the physical project root (symlink or junction parent): ${target}` };
      // The real path also catches 8.3 short names such as GIT~1.
      const real = realPathOrNull(target);
      const guarded = protectedDir(target, root) ?? protectedDir(physicalTarget, physicalRoot)
        ?? (real === null ? undefined : protectedDir(real, physicalRoot));
      if (guarded !== undefined) return { reason: `refusing to ${verb} inside the protected ${guarded} directory: ${target}` };
      targets.push(target);
    }
  } catch (error: unknown) {
    return { reason: `cannot verify physical ${verb} paths: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { targets };
}

function assessDelete(command: string, args: readonly string[], ctx: SafetyContext): SafetyDecision {
  const moving = MOVE_COMMANDS.has(command);
  const parsed = moving ? moveTargets(args) : deleteTargets(command, args);
  if (parsed.reason) return block(command, true, parsed.reason);
  if (parsed.targets.length === 0) return block(command, true, 'delete command has no explicit target path');

  const checked = checkTargets(parsed.targets, ctx, moving ? 'move' : 'delete');
  if ('reason' in checked) return block(command, true, checked.reason);

  if (SHELL_ONLY_DELETES.has(command) || SHELL_ONLY_MOVES.has(command) || (command === 'rmdir' && process.platform === 'win32')) {
    return block(command, true, `${command} is shell-only and cannot run with shell: false; use a standalone executable such as rm or mv, or review and run the builtin yourself in your terminal`);
  }
  return allow(command, true, checked.targets, [`destructive command is limited to explicit paths inside the project root`]);
}

/** `--fo` stands for `--force`: git accepts any unambiguous prefix of a long option. */
function isAbbrev(arg: string, full: string, min = 3): boolean {
  const name = (arg.split('=')[0] ?? '').toLowerCase();
  return name.length >= min && full.startsWith(name);
}

/** Letters of a bundled short option such as `-uf`; empty for anything else. */
function shortFlags(arg: string): string {
  return /^-[A-Za-z0-9]+$/.test(arg) ? arg.slice(1) : '';
}

function discardsWorktree(args: readonly string[]): boolean {
  return args.some((arg) => shortFlags(arg).includes('f') || isAbbrev(arg, '--force') || isAbbrev(arg, '--discard-changes'));
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

function stashRule(args: readonly string[]): string | null {
  const action = args.find((arg) => !arg.startsWith('-'));
  return action === 'drop' || action === 'clear' ? `git stash ${action} deletes stashed work` : null;
}

function branchRule(args: readonly string[]): string | null {
  const flags = args.map(shortFlags).join('');
  const deleting = flags.includes('d') || args.some((arg) => isAbbrev(arg, '--delete'));
  const forcing = flags.includes('f') || args.some((arg) => isAbbrev(arg, '--force'));
  return flags.includes('D') || (deleting && forcing) ? 'git branch force-delete can lose unmerged commits' : null;
}

/** Subcommand rules: a reason when the call can discard work or plant code, otherwise null. */
const GIT_RULES: Readonly<Record<string, ArgsRule>> = {
  clean: () => 'git clean can erase untracked work broadly; delete explicit paths with cws safe-run instead',
  rm: () => 'git rm can delete tracked files and change the index; run it yourself in your terminal',
  reset: (args) => (args.some((arg) => isAbbrev(arg, '--hard')) ? 'git reset --hard is blocked because it discards worktree changes' : null),
  push: (args) => (args.some(isDestructivePushArg) ? 'git push that forces, mirrors, prunes or deletes remote refs is blocked' : null),
  checkout: (args) => (args.includes('--') || args.includes('.') || discardsWorktree(args)
    ? 'git checkout that overwrites worktree files is blocked; run it yourself in your terminal' : null),
  switch: (args) => (discardsWorktree(args) ? 'git switch that discards worktree changes is blocked' : null),
  restore: () => 'git restore discards worktree changes; run it yourself in your terminal',
  stash: stashRule,
  branch: branchRule,
  config: (args) => (isConfigRead(args) ? null : 'git config writes are blocked: aliases and hooks set there run arbitrary programs'),
};

function gitGlobalProblem(globals: readonly string[]): string | null {
  if (globals.some((arg) => arg.startsWith('-c') || isAbbrev(arg, '--config-env', 4))) {
    return 'git -c and --config-env are blocked: inline config can define aliases and hooks that run arbitrary programs';
  }
  if (globals.some((arg) => arg.startsWith('--exec-path='))) return 'git --exec-path is blocked: it points git at other programs';
  return null;
}

function gitRule(args: readonly string[]): string | null {
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) index += GIT_VALUE_GLOBALS.has(args[index]!) ? 2 : 1;
  const subcommand = args[index]?.toLowerCase();
  // The subcommand verdict comes first so `git -c x clean` still reads as a git clean.
  const subcommandProblem = subcommand === undefined ? null : GIT_RULES[subcommand]?.(args.slice(index + 1)) ?? null;
  if (subcommandProblem !== null) return subcommandProblem;
  const globalProblem = gitGlobalProblem(args.slice(0, index));
  if (globalProblem !== null) return globalProblem;
  if (subcommand !== undefined && !GIT_SUBCOMMANDS.has(subcommand)) {
    return `git ${subcommand} is not a built-in git command; aliases and git-<name> helpers can run anything`;
  }
  return null;
}

function runnerRule(subcommands: readonly string[]): ArgsRule {
  return (args) => (args.some((arg) => subcommands.includes(arg.toLowerCase()))
    ? 'package runners download and run code the guard cannot inspect; run it yourself in your terminal' : null);
}

/** Per-command rules for programs that are fine in general but destructive with some arguments. */
const COMMAND_RULES: Readonly<Record<string, ArgsRule>> = {
  git: gitRule,
  find: (args) => (args.some((arg) => FIND_ACTIONS.has(arg.toLowerCase())) ? 'find with -delete, -exec or -ok actions is blocked; delete explicit paths instead' : null),
  robocopy: (args) => (args.some((arg) => ROBOCOPY_DESTRUCTIVE.test(arg)) ? 'robocopy /MIR, /PURGE and /MOVE delete files at the destination' : null),
  ...Object.fromEntries(Object.entries(RUNNER_SUBCOMMANDS).map(([name, subcommands]) => [name, runnerRule(subcommands)])),
};

export function assessCommandSafety(argv: readonly string[], ctx: SafetyContext): SafetyDecision {
  const commandArg = argv[0];
  if (commandArg === undefined) return block('', false, 'no command provided');
  const command = normalizeCommand(commandArg);
  const args = argv.slice(1);

  const standalone = argv.find((token) => SHELL_OPERATORS.includes(token));
  if (standalone !== undefined) return block(command, false, `shell operator is not allowed in guarded commands: ${standalone}`);
  const embedded = ctx.runsWithoutShell === true ? undefined : argv.find(hasShellOperator);
  if (embedded !== undefined) {
    return block(command, false, `shell operator is not allowed in guarded commands: ${embedded}. ` +
      'If it is plain text (a message or format), run the command through `cws safe-run -- ...`, which passes arguments without a shell.');
  }

  const launcher = LAUNCHERS.find((entry) => entry.pattern.test(command));
  if (launcher !== undefined) return block(command, true, launcher.reason);

  const problem = COMMAND_RULES[command]?.(args) ?? null;
  if (problem !== null) return block(command, true, problem);

  if (DELETE_COMMANDS.has(command) || MOVE_COMMANDS.has(command)) return assessDelete(command, args, ctx);

  return allow(command, false, [], ['no destructive filesystem pattern detected']);
}
