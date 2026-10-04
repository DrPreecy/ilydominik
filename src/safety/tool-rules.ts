import { gitRule } from './git-rules.ts';
import { checkTargets, existsAsFile, operands, optionValues, type SafetyContext } from './path-checks.ts';

/**
 * Per-program verdicts for `safe-run`. A denylist plus a few allowlists (package managers, docker,
 * kubectl, reg), written for the classes the README claims: programs that run other programs,
 * and programs that overwrite or delete files. It cannot see what an allowed program does.
 */
export type ArgsRule = (args: readonly string[], ctx: SafetyContext) => string | null;

/** Programs that run another program or script the guard cannot see into. */
export const LAUNCHERS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^(?:cmd|sh|bash|dash|ash|rbash|fish|ksh|mksh|zsh|csh|tcsh|pwsh.*|powershell.*)$/,
    reason: 'inline shell commands are blocked; pass the command and arguments directly to cws safe-run',
  },
  {
    pattern: /^(?:env|sudo|doas|su|runas|xargs|busybox|toybox|wsl|nohup|nice|ionice|timeout|stdbuf|chroot|setsid|time|watch|parallel|corepack|start|call|command|eval|builtin|flock|unshare|nsenter|taskset|chrt|script|expect|systemd-run|pkexec|run0|launchctl|schtasks|at|forfiles|wmic|psexec)$/,
    reason: 'command wrappers run another program the guard cannot inspect; pass the inner command directly',
  },
  {
    pattern: /^(?:node[0-9._-]*|nodejs[0-9.]*|deno|bun|tsx|ts-node(?:-esm)?|vite-node|jiti|esno|babel-node|coffee|python[0-9.]*|pythonw|pypy[0-9]*|py|pyw|perl[0-9.]*|ruby|jruby|irb|php|lua|luajit|tclsh|wish|osascript|cscript|wscript|mshta|rundll32|awk|gawk|mawk|nawk|java|javaw|jshell|kotlin|scala|groovy|dotnet|dotnet-script|mono|csi|rscript|julia|dart|elixir|iex|erl|escript|ghc|ghci|runghc|swift|sqlite3)$/,
    reason: 'script interpreters can delete anything; review the script and run it yourself in your terminal',
  },
  {
    pattern: /^(?:npx|pnpx|bunx|uvx|pipx)$/,
    reason: 'package runners download and run code the guard cannot inspect; run it yourself in your terminal',
  },
  {
    pattern: /^(?:make|gmake|nmake|msbuild|just|rake|ninja|devenv|installutil|regasm|regsvcs|regsvr32|msiexec|odbcconf|cmstp|pcalua|ieexec|bitsadmin)$/,
    reason: 'build tools and Windows installers run whatever their build file or package says; run it yourself in your terminal',
  },
  {
    pattern: /^(?:ssh|scp|sftp|rsh|rlogin|telnet|ftp|tftp|nc|ncat|netcat|socat|nmap|plink|gdb|lldb|strace|ltrace|vim|vi|view|nvim|ex|ed|nano|emacs|less|more|most|man)$/,
    reason: 'remote shells, debuggers, editors and pagers can run any command; run it yourself in your terminal',
  },
  {
    pattern: /^(?:mkfs(?:\..+)?|fdisk|sfdisk|parted|diskpart|format|wipefs|mkswap|sdelete|diskutil)$/,
    reason: 'disk formatting and partitioning tools destroy whole volumes; run it yourself in your terminal',
  },
];

const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
const ROBOCOPY_DESTRUCTIVE = /^[/-](?:mir|purge|move|mov)(?::.*)?$/i;
const WINDOWS_SWITCH = /^\/[A-Za-z?]{1,3}(?::.*)?$/;
const RUN_YOURSELF = 'run it yourself in your terminal';

const PM_VALUE_FLAGS = ['--prefix', '--cwd', '--dir', '--workspace', '--filter', '--registry', '--cache', '--userconfig', '--loglevel', '--reporter', '--store-dir'];
const PM_VALUE_SHORTS = 'CwF';
/** Package-manager subcommands that read or edit dependencies but do not run a project script by name. */
const PM_SAFE = new Set([
  'ls', 'list', 'll', 'la', 'view', 'v', 'info', 'show', 'outdated', 'audit', 'help', 'version', 'why', 'explain', 'bin',
  'root', 'prefix', 'whoami', 'search', 'ping', 'install', 'i', 'add', 'ci', 'update', 'up', 'upgrade', 'remove', 'rm',
  'uninstall', 'un', 'dedupe', 'prune', 'fund', 'licenses', 'store', 'cache', 'doctor',
]);
const DOCKER_SAFE = new Set(['ps', 'images', 'inspect', 'logs', 'version', 'info', 'stats', 'top', 'port', 'history', 'search', 'diff']);
const DOCKER_NESTED = new Set(['image', 'container', 'volume', 'network', 'context', 'compose']);
const DOCKER_NESTED_SAFE = new Set(['ls', 'list', 'ps', 'inspect', 'config', 'logs']);
const KUBECTL_SAFE = new Set(['get', 'describe', 'logs', 'version', 'api-resources', 'api-versions', 'cluster-info', 'explain', 'top', 'events', 'diff']);
const GO_BLOCKED = new Set(['run', 'generate', 'clean', 'install']);
const CARGO_BLOCKED = new Set(['run', 'r', 'clean', 'install', 'publish', 'yank', 'login', 'script']);

function checked(result: { targets: string[] } | { reason: string }): string | null {
  return 'reason' in result ? result.reason : null;
}

function hasFlag(args: readonly string[], letters: string, ...longs: string[]): boolean {
  return args.some((arg) => longs.includes(arg.toLowerCase())
    || (/^-[A-Za-z0-9]+$/.test(arg) && [...arg.slice(1)].some((letter) => letters.includes(letter))));
}

/** A path a program is about to write: inside the project, outside .git and .cws, and not an existing file unless allowed. */
function writeProblem(raw: string, ctx: SafetyContext, overwrite: boolean): string | null {
  const result = checkTargets([raw], ctx, 'write', { allowRoot: true });
  if ('reason' in result) return result.reason;
  const target = result.targets[0]!;
  return overwrite && existsAsFile(target) ? `refusing to overwrite the existing file ${target}; edit it yourself or write a new file` : null;
}

function firstProblem(raws: readonly string[], ctx: SafetyContext, overwrite: boolean): string | null {
  for (const raw of raws) {
    const problem = writeProblem(raw, ctx, overwrite);
    if (problem !== null) return problem;
  }
  return null;
}

/** First word that is not an option or an option value; flags that take values are skipped. */
function firstWord(args: readonly string[], valueFlags: readonly string[], valueShorts = ''): { word?: string; rest: string[] } {
  const words = operands(args, valueShorts, valueFlags);
  const index = args.indexOf(words[0] ?? '');
  return words[0] === undefined ? { rest: [] } : { word: words[0].toLowerCase(), rest: args.slice(index + 1) };
}

function packageManagerRule(name: string): ArgsRule {
  return (args) => {
    const { word } = firstWord(args, PM_VALUE_FLAGS, PM_VALUE_SHORTS);
    if (word === undefined || PM_SAFE.has(word)) return null;
    return `${name} ${word} can run a project script or downloaded code the guard cannot inspect; ${RUN_YOURSELF}`;
  };
}

function allowlistRule(name: string, safe: ReadonlySet<string>, valueFlags: readonly string[], valueShorts: string, nested?: ReadonlySet<string>): ArgsRule {
  return (args) => {
    const { word, rest } = firstWord(args, valueFlags, valueShorts);
    if (word === undefined || safe.has(word)) return null;
    const second = nested?.has(word) === true ? operands(rest)[0]?.toLowerCase() : undefined;
    if (second !== undefined && DOCKER_NESTED_SAFE.has(second)) return null;
    return `${name} ${word} can change or run things outside the project; only read-only subcommands are allowed`;
  };
}

function copyRule(valueShorts: string): ArgsRule {
  return (args, ctx) => {
    const targetDir = optionValues(args, 't', ['--target-directory'])[0];
    const words = operands(args, valueShorts, ['--target-directory', '--suffix']);
    const destination = targetDir ?? (words.length >= 2 ? words.at(-1) : undefined);
    if (destination === undefined) return null;
    return writeProblem(destination, ctx, !hasFlag(args, 'n', '--no-clobber'));
  };
}

function linkRule(args: readonly string[], ctx: SafetyContext): string | null {
  if (hasFlag(args, 'fF', '--force')) return 'ln -f replaces existing files with links';
  const words = operands(args, 't', ['--target-directory']);
  const destination = optionValues(args, 't', ['--target-directory'])[0] ?? (words.length >= 2 ? words.at(-1) : undefined);
  return destination === undefined ? null : writeProblem(destination, ctx, false);
}

function ddRule(args: readonly string[], ctx: SafetyContext): string | null {
  const outputs = args.filter((arg) => arg.toLowerCase().startsWith('of=')).map((arg) => arg.slice(3));
  return firstProblem(outputs, ctx, true);
}

function teeRule(args: readonly string[], ctx: SafetyContext): string | null {
  return firstProblem(operands(args), ctx, !hasFlag(args, 'a', '--append'));
}

function sedRule(args: readonly string[]): string | null {
  return hasFlag(args, 'i', '--in-place') || args.some((arg) => arg.toLowerCase().startsWith('--in-place') || arg.toLowerCase().startsWith('--in=') || arg === '--in')
    ? 'sed -i rewrites files in place; edit the file yourself or write the output to a new file' : null;
}

function rsyncRule(args: readonly string[], ctx: SafetyContext): string | null {
  const words = operands(args);
  const risky = args.find((arg) => /^--(?:del|remove|rsh|daemon|config)/i.test(arg)) ?? (hasFlag(args, 'e') ? '-e' : undefined);
  if (risky !== undefined) return `rsync ${risky} deletes files or starts another program`;
  const destination = words.at(-1);
  return words.length < 2 || destination === undefined ? null : writeProblem(destination, ctx, false);
}

function tarRule(args: readonly string[], ctx: SafetyContext): string | null {
  const [first = ''] = args;
  const bundle = /^[A-Za-z]/.test(first) ? first : '';
  if (args.some((arg) => /^--(?:remove|to-command|checkpoint-action|use-compress|rsh-command|rmt-command|absolute|overwrite)/i.test(arg)) || hasFlag(args, 'IP')) {
    return 'tar --remove-files, --to-command, -I and similar options delete files or run programs';
  }
  const files = optionValues(args, 'f', ['--file']);
  const oldStyleFile = /f/.test(bundle) ? args[1] : undefined;
  const directories = optionValues(args, 'C', ['--directory']);
  return firstProblem([...files, ...(oldStyleFile === undefined ? [] : [oldStyleFile])].filter((value) => value !== '-'), ctx, false)
    ?? checked(directories.length === 0 ? { targets: [] } : checkTargets(directories, ctx, 'extract into', { allowRoot: true }));
}

function curlRule(args: readonly string[], ctx: SafetyContext): string | null {
  const dirs = optionValues(args, '', ['--output-dir']);
  return firstProblem(optionValues(args, 'o', ['--output']), ctx, true)
    ?? checked(dirs.length === 0 ? { targets: [] } : checkTargets(dirs, ctx, 'write', { allowRoot: true }));
}

function wgetRule(args: readonly string[], ctx: SafetyContext): string | null {
  const dirs = optionValues(args, 'P', ['--directory-prefix']);
  return firstProblem(optionValues(args, 'Ooa', ['--output-document', '--output-file', '--append-output']), ctx, true)
    ?? checked(dirs.length === 0 ? { targets: [] } : checkTargets(dirs, ctx, 'write', { allowRoot: true }));
}

function windowsCopyRule(args: readonly string[], ctx: SafetyContext): string | null {
  const paths = args.filter((arg) => !WINDOWS_SWITCH.test(arg) || /^\/[^/]+\//.test(arg));
  const destination = paths[1];
  return destination === undefined ? null : writeProblem(destination, ctx, false);
}

function robocopyRule(args: readonly string[], ctx: SafetyContext): string | null {
  if (args.some((arg) => ROBOCOPY_DESTRUCTIVE.test(arg))) return 'robocopy /MIR, /PURGE and /MOVE delete files at the destination';
  return windowsCopyRule(args, ctx);
}

function findRule(args: readonly string[]): string | null {
  return args.some((arg) => FIND_ACTIONS.has(arg.toLowerCase())) ? 'find with -delete, -exec or -ok actions is blocked; delete explicit paths instead' : null;
}

function fdRule(args: readonly string[]): string | null {
  return hasFlag(args, 'xX', '--exec', '--exec-batch') || args.some((arg) => arg.toLowerCase().startsWith('--exec'))
    ? 'fd -x/--exec runs a command for every match; pass explicit paths instead' : null;
}

function rgRule(args: readonly string[]): string | null {
  return args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/i.test(arg)) ? 'rg --pre runs a program on every file' : null;
}

function blockWords(name: string, blocked: ReadonlySet<string>): ArgsRule {
  return (args) => {
    const { word } = firstWord(args, [], '');
    return word !== undefined && blocked.has(word) ? `${name} ${word} deletes files or runs code the guard cannot inspect; ${RUN_YOURSELF}` : null;
  };
}

function cleanRule(name: string): ArgsRule {
  return (args) => (args.some((arg) => arg.toLowerCase() === 'clean') ? `${name} clean deletes build output broadly; delete explicit paths with cws safe-run` : null);
}

function recursiveRule(name: string): ArgsRule {
  return (args) => (hasFlag(args, 'R', '--recursive') ? `${name} -R rewrites a whole tree; list explicit paths` : null);
}

/** Per-command rules for programs that are fine in general but destructive with some arguments. */
export const COMMAND_RULES: Readonly<Record<string, ArgsRule>> = {
  git: gitRule,
  find: findRule,
  fd: fdRule,
  fdfind: fdRule,
  rg: rgRule,
  robocopy: robocopyRule,
  xcopy: windowsCopyRule,
  cp: copyRule(''),
  install: copyRule('mogSt'),
  ln: linkRule,
  dd: ddRule,
  tee: teeRule,
  truncate: () => 'truncate destroys file contents; edit the file yourself',
  sed: sedRule,
  rsync: rsyncRule,
  tar: tarRule,
  curl: curlRule,
  wget: wgetRule,
  chmod: recursiveRule('chmod'),
  chown: recursiveRule('chown'),
  npm: packageManagerRule('npm'),
  pnpm: packageManagerRule('pnpm'),
  yarn: packageManagerRule('yarn'),
  cargo: blockWords('cargo', CARGO_BLOCKED),
  go: blockWords('go', GO_BLOCKED),
  gradle: cleanRule('gradle'),
  gradlew: cleanRule('gradle'),
  mvn: cleanRule('mvn'),
  mvnw: cleanRule('mvn'),
  cmake: (args) => (args.some((arg) => /^-P/.test(arg)) ? 'cmake -P runs a script' : null),
  docker: allowlistRule('docker', DOCKER_SAFE, ['-h', '--host', '--context', '--config', '--log-level'], 'Hc', DOCKER_NESTED),
  podman: allowlistRule('podman', DOCKER_SAFE, ['--connection', '--url', '--log-level'], 'ch', DOCKER_NESTED),
  kubectl: allowlistRule('kubectl', KUBECTL_SAFE, ['--namespace', '--context', '--kubeconfig', '--cluster', '--user', '--selector', '--output'], 'nlo'),
  reg: (args) => (args[0]?.toLowerCase() === 'query' || args[0] === '/?' ? null : 'reg changes the Windows registry; only `reg query` is allowed'),
  cipher: (args) => (args.some((arg) => /^\/w/i.test(arg)) ? 'cipher /w overwrites free disk space' : null),
  certutil: (args) => (args[0]?.toLowerCase() === '-hashfile' ? null : 'certutil can download and decode files; only -hashfile is allowed'),
};
