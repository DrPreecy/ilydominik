/**
 * Windows ↔ WSL bridge. On Windows the sandbox and the POSIX tools (ocr, openshell,
 * semgrep) live inside a WSL distribution, so every argument and directory that crosses
 * the boundary has to be translated.
 */

export interface WslOptions {
  distro?: string;
  cwd?: string;
}

const DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/;
const UNC_WSL_PATH = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)$/;

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/** `E:\Dev\x` → `/mnt/e/Dev/x`, `\\wsl$\Ubuntu\home\x` → `/home/x`. Relative paths return null. */
export function windowsToWslPath(value: string): string | null {
  if (value.trim() === '') return null;

  const unc = UNC_WSL_PATH.exec(value);
  if (unc) {
    const rest = toPosix(unc[1] ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
    return rest === '' ? '/' : `/${rest}`;
  }

  const drive = DRIVE_PATH.exec(value);
  if (drive) {
    const driveLetter = (drive[1] ?? '').toLowerCase();
    const rest = toPosix(drive[2] ?? '');
    return driveLetter === '' ? null : rest === '' ? `/mnt/${driveLetter}` : `/mnt/${driveLetter}/${rest}`;
  }

  return null;
}

/** True for `\\wsl$\...` and `\\wsl.localhost\...` paths, which VS Code uses inside a container. */
export function isWslUncPath(value: string): boolean {
  return UNC_WSL_PATH.test(value);
}

/** `wsl.exe` argument list for running `command` inside the distribution. */
export function wslArgs(opts: WslOptions, command: string, args: readonly string[] = []): string[] {
  const result: string[] = [];
  if (opts.distro) result.push('-d', opts.distro);
  if (opts.cwd) result.push('--cd', opts.cwd);
  result.push('-e', command, ...args);
  return result;
}
