import path from 'node:path';
import { COMMAND_RULES, LAUNCHERS } from './tool-rules.ts';
import { checkTargets, type SafetyContext } from './path-checks.ts';

export type { SafetyContext };

export interface SafetyDecision {
  ok: boolean;
  destructive: boolean;
  command: string;
  targets: string[];
  reason?: string;
  notes: string[];
}

/** Operators a shell would act on; as a whole argument they are blocked in every mode. */
const SHELL_OPERATORS = ['&&', '||', ';', '|', '<', '>', '&'];
/** Characters that start a second command or a substitution; blocked inside an argument when a shell may see it. */
const SHELL_SYNTAX = [...SHELL_OPERATORS, '\n', '\r', '`', '$(', '^'];
/** `~`, `$VAR`, `${VAR}`, `%VAR%`: a shell replaces them, so the path the guard checks is not the path that is used. */
const SHELL_EXPANSION = /(?:^|[=:])~|(?<!::)\$[A-Za-z_{(@*#?!$0-9-]|%[A-Za-z_][A-Za-z0-9_]*%/;
const DELETE_COMMANDS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'shred', 'unlink', 'trash', 'trash-put', 'rmtrash']);
const SHELL_ONLY_DELETES = new Set(['del', 'erase', 'rd', 'remove-item', 'ri']);
const MOVE_COMMANDS = new Set(['mv', 'move', 'move-item', 'mi']);
const SHELL_ONLY_MOVES = new Set(['move', 'move-item', 'mi']);
const MV_LONG_SWITCHES = new Set(['--force', '--no-clobber', '--verbose', '--interactive', '--update', '--no-target-directory']);
const REMOVE_ITEM_TARGET_FLAGS = new Set(['-path', '-literalpath']);
const REMOVE_ITEM_TARGET_PREFIXES = ['-path:', '-literalpath:'];
const REMOVE_ITEM_SWITCHES = new Set(['-recurse', '-force', '-whatif', '-verbose']);
const RM_LONG_SWITCHES = new Set(['--recursive', '--force', '--verbose', '--dir']);
/** Windows drops trailing dots and spaces and the `::$DATA` stream, so `rm.exe.` still runs rm.exe. */
const COMMAND_SUFFIX = /(?:[. ]+|::\$data|\.(?:exe|com|cmd|bat|ps1))$/i;
/** `rm2`, `rm-real`, `mv_old`: a renamed copy of a delete or move command, which may do anything. */
const RENAMED_DELETE = /^(?:rm|mv|rmdir|shred|unlink)[0-9_-][A-Za-z0-9._-]*$/;
/** `grm`, `gmv`: GNU coreutils names on macOS. */
const GNU_PREFIX = /^g(rm|mv|rmdir|shred|unlink)$/;
const COMMA_REASON = 'a comma in a delete target is blocked (PowerShell treats it as a list of paths)';

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
  return GNU_PREFIX.exec(name)?.[1] ?? name;
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
  const takesList = isPowerShellRemove || isCmdDelete;
  let operandsOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const lower = token.toLowerCase();
    if (token.length === 0 || token.includes('\0')) return { targets: [], reason: 'delete target must be a nonempty path without NUL characters' };
    // PowerShell reads `a,b` as two paths; checking it as one would hide the second.
    if (takesList && token.includes(',')) return { targets: [], reason: `${COMMA_REASON}: ${token}` };
    if (operandsOnly) {
      targets.push(token);
      continue;
    }
    if (token === '--' && !takesList) {
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
      if (next.includes(',')) return { targets: [], reason: `${COMMA_REASON}: ${next}` };
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

/** A reason when the argv holds something a shell would interpret; `cws` itself runs plain arguments. */
function shellProblem(argv: readonly string[], runsWithoutShell: boolean): string | null {
  const standalone = argv.find((token) => SHELL_OPERATORS.includes(token));
  if (standalone !== undefined) return `shell operator is not allowed in guarded commands: ${standalone}`;
  if (runsWithoutShell) return null;
  const embedded = argv.find((token) => SHELL_SYNTAX.some((syntax) => token.includes(syntax)));
  if (embedded !== undefined) {
    return `shell operator is not allowed in guarded commands: ${JSON.stringify(embedded)}. ` +
      'If it is plain text (a message or format), run the command through `cws safe-run -- ...`, which passes arguments without a shell.';
  }
  const expanding = argv.find((token) => SHELL_EXPANSION.test(token));
  if (expanding !== undefined) {
    return `a shell would expand ${JSON.stringify(expanding)} (~, $VAR, %VAR%) to a path the guard cannot check; write the path out`;
  }
  return null;
}

export function assessCommandSafety(argv: readonly string[], ctx: SafetyContext): SafetyDecision {
  const commandArg = argv[0];
  if (commandArg === undefined) return block('', false, 'no command provided');
  const command = normalizeCommand(commandArg);
  const args = argv.slice(1);

  const syntax = shellProblem(argv, ctx.runsWithoutShell === true);
  if (syntax !== null) return block(command, false, syntax);

  if (RENAMED_DELETE.test(command)) return block(command, true, `${command} looks like a renamed copy of a delete or move command, which may do anything; call the real command by its own name`);

  const launcher = LAUNCHERS.find((entry) => entry.pattern.test(command));
  if (launcher !== undefined) return block(command, true, launcher.reason);

  const rule = Object.hasOwn(COMMAND_RULES, command) ? COMMAND_RULES[command] : undefined;
  const problem = rule?.(args, ctx) ?? null;
  if (problem !== null) return block(command, true, problem);

  if (DELETE_COMMANDS.has(command) || MOVE_COMMANDS.has(command)) return assessDelete(command, args, ctx);

  return allow(command, false, [], ['no destructive filesystem pattern detected']);
}
