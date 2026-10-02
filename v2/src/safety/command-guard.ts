import path from 'node:path';
import fs from 'node:fs';

export interface SafetyContext {
  cwd: string;
  projectRoot: string;
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
const SHELL_COMMANDS = new Set(['cmd', 'powershell', 'pwsh', 'sh', 'bash', 'zsh']);
const DELETE_COMMANDS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri']);
const SHELL_ONLY_DELETES = new Set(['del', 'erase', 'rd', 'remove-item', 'ri']);
const REMOVE_ITEM_TARGET_FLAGS = new Set(['-path', '-literalpath']);
const REMOVE_ITEM_TARGET_PREFIXES = ['-path:', '-literalpath:'];
const REMOVE_ITEM_SWITCHES = new Set(['-recurse', '-force', '-whatif', '-verbose']);
const RM_LONG_SWITCHES = new Set(['--recursive', '--force', '--verbose', '--dir']);

interface ParsedTargets {
  targets: string[];
  reason?: string;
}

function normalizeCommand(command: string): string {
  const base = path.basename(command).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
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
  if (command === 'rm') return /^-[rfivd]+$/.test(token) || RM_LONG_SWITCHES.has(token);
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

function assessDelete(command: string, args: readonly string[], ctx: SafetyContext): SafetyDecision {
  const parsed = deleteTargets(command, args);
  if (parsed.reason) return block(command, true, parsed.reason);
  const rawTargets = parsed.targets;
  if (rawTargets.length === 0) return block(command, true, 'delete command has no explicit target path');

  const root = path.resolve(ctx.projectRoot);
  const targets: string[] = [];
  try {
    const physicalRoot = physicalPath(root);
    for (const rawTarget of rawTargets) {
      if (hasWildcard(rawTarget)) return block(command, true, `wildcard deletes are blocked: ${rawTarget}`);
      const target = resolvedPath(rawTarget, ctx.cwd);
      if (isFilesystemRoot(target)) return block(command, true, `refusing to delete filesystem root: ${target}`);
      if (comparePath(target) === comparePath(root)) return block(command, true, `refusing to delete the project root: ${root}`);
      if (!isSameOrInside(target, root)) return block(command, true, `refusing to delete outside the project root: ${target}`);
      const physicalTarget = physicalDeleteTarget(rawTarget, ctx.cwd);
      if (comparePath(physicalTarget) === comparePath(physicalRoot)) return block(command, true, 'refusing to delete the physical project root');
      if (!isSameOrInside(physicalTarget, physicalRoot)) return block(command, true, `refusing to delete outside the physical project root (symlink or junction parent): ${target}`);
      targets.push(target);
    }
  } catch (error: unknown) {
    return block(command, true, `cannot verify physical delete paths: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (SHELL_ONLY_DELETES.has(command) || (command === 'rmdir' && process.platform === 'win32')) {
    return block(command, true, `${command} is shell-only and cannot run with shell: false; use a standalone executable such as rm, or review and run the builtin yourself in your terminal`);
  }
  return allow(command, true, targets, ['destructive command is limited to explicit paths inside the project root']);
}

export function assessCommandSafety(argv: readonly string[], ctx: SafetyContext): SafetyDecision {
  const commandArg = argv[0];
  if (commandArg === undefined) return block('', false, 'no command provided');
  const command = normalizeCommand(commandArg);
  const args = argv.slice(1);

  const operator = argv.find(hasShellOperator);
  if (operator !== undefined) return block(command, false, `shell operator is not allowed in guarded commands: ${operator}`);

  if (SHELL_COMMANDS.has(command)) {
    return block(command, false, 'inline shell commands are blocked; pass the command and arguments directly to cws safe-run');
  }

  if (command === 'git' && args.some((arg) => arg.toLowerCase() === 'clean')) {
    return block(command, true, 'git clean can erase untracked work broadly; delete explicit paths with cws safe-run instead');
  }

  if (command === 'git' && args.some((arg) => arg.toLowerCase() === '--hard')) {
    return block(command, true, 'git reset --hard is blocked because it discards worktree changes');
  }

  if (DELETE_COMMANDS.has(command)) return assessDelete(command, args, ctx);

  return allow(command, false, [], ['no destructive filesystem pattern detected']);
}
