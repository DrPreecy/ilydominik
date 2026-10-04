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

/** Directories whose loss or tampering cannot be undone from inside the project. */
const PROTECTED_DIRS = ['.git', CWS_DIR];
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

export interface TargetOptions {
  /** The project root itself is a legitimate target (a copy destination, a `git -C .`). */
  allowRoot?: boolean;
  /** `.git` and `.cws` are legitimate targets (`git --git-dir=.git`); containment is still enforced. */
  allowProtected?: boolean;
}

export function hasWildcard(token: string): boolean {
  return /[*?[\]{}]/.test(token);
}

export function resolvedPath(value: string, cwd: string): string {
  return path.resolve(path.isAbsolute(value) ? value : path.join(cwd, value));
}

export function comparePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isSameOrInside(child: string, parent: string): boolean {
  const c = comparePath(child);
  const p = comparePath(parent);
  const parentWithSep = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
  return c === p || c.startsWith(parentWithSep);
}

function isFilesystemRoot(target: string): boolean {
  const parsed = path.parse(path.resolve(target));
  return comparePath(target) === comparePath(parsed.root);
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
  if (hasWildcard(raw)) return `wildcard targets are blocked: ${raw}`;
  if (DRIVE_RELATIVE.test(raw)) return `drive-relative paths are blocked because they resolve against that drive's current folder: ${raw}`;
  if (raw.replace(DRIVE_ABSOLUTE, '').includes(':')) return `a colon in a target is blocked (alternate data stream, device path or remote host): ${raw}`;
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

/** True when `target` already exists as a file or link, so writing to it replaces something. */
export function existsAsFile(target: string): boolean {
  try {
    return !fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Each raw path, resolved and checked; a reason string when any of them may not be touched. */
export function checkTargets(
  rawTargets: readonly string[],
  ctx: SafetyContext,
  verb: string,
  opts: TargetOptions = {},
): { targets: string[] } | { reason: string } {
  const root = path.resolve(ctx.projectRoot);
  const targets: string[] = [];
  try {
    const physicalRoot = physicalPath(root);
    for (const rawTarget of rawTargets) {
      const problem = rawTarget.length === 0 || rawTarget.includes('\0') ? `${verb} target must be a nonempty path without NUL characters` : targetProblem(rawTarget);
      if (problem !== null) return { reason: problem };
      const target = resolvedPath(rawTarget, ctx.cwd);
      if (isFilesystemRoot(target)) return { reason: `refusing to ${verb} filesystem root: ${target}` };
      if (comparePath(target) === comparePath(root) && opts.allowRoot !== true) return { reason: `refusing to ${verb} the project root: ${root}` };
      if (!isSameOrInside(target, root)) return { reason: `refusing to ${verb} outside the project root: ${target}` };
      const physicalTarget = physicalDeleteTarget(rawTarget, ctx.cwd);
      if (comparePath(physicalTarget) === comparePath(physicalRoot) && opts.allowRoot !== true) return { reason: `refusing to ${verb} the physical project root` };
      if (!isSameOrInside(physicalTarget, physicalRoot)) return { reason: `refusing to ${verb} outside the physical project root (symlink or junction parent): ${target}` };
      if (opts.allowProtected !== true) {
        // The real path also catches 8.3 short names such as GIT~1.
        const real = realPathOrNull(target);
        const guarded = protectedDir(target, root) ?? protectedDir(physicalTarget, physicalRoot)
          ?? (real === null ? undefined : protectedDir(real, physicalRoot));
        if (guarded !== undefined) return { reason: `refusing to ${verb} inside the protected ${guarded} directory: ${target}` };
      }
      targets.push(target);
    }
  } catch (error: unknown) {
    return { reason: `cannot verify physical ${verb} paths: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { targets };
}

/** Words that are not options and not the value of an option that takes one (`-t DIR`, `--suffix=x`). */
export function operands(args: readonly string[], valueShorts = '', valueLongs: readonly string[] = []): string[] {
  const words: string[] = [];
  let operandsOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (operandsOnly || !arg.startsWith('-') || arg === '-') {
      words.push(arg);
      continue;
    }
    if (arg === '--') {
      operandsOnly = true;
    } else if (arg.startsWith('--')) {
      if (!arg.includes('=') && valueLongs.includes(arg.toLowerCase())) index += 1;
    } else {
      const at = [...arg.slice(1)].findIndex((letter) => valueShorts.includes(letter));
      if (at !== -1 && at === arg.length - 2) index += 1;
    }
  }
  return words;
}

/** Values of options such as `-o FILE`, `-oFILE`, `-sSLo FILE`, `--output FILE`, `--output=FILE`. */
export function optionValues(args: readonly string[], shortOptions: string, longOptions: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const [name = '', ...rest] = arg.split('=');
      if (!longOptions.some((long) => long === name.toLowerCase() || (name.length >= 5 && long.startsWith(name.toLowerCase())))) continue;
      if (rest.length > 0) values.push(rest.join('='));
      else if (index + 1 < args.length) values.push(args[(index += 1)]!);
      continue;
    }
    if (!/^-[A-Za-z0-9]/.test(arg)) continue;
    for (let at = 1; at < arg.length; at += 1) {
      if (!shortOptions.includes(arg[at]!)) continue;
      const attached = arg.slice(at + 1);
      if (attached !== '') values.push(attached);
      else if (index + 1 < args.length) values.push(args[(index += 1)]!);
      break;
    }
  }
  return values;
}
