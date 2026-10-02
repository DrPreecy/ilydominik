/**
 * Runs outside programs (ocr, openshell, semgrep, docker, ...) for CWS.
 *
 * Rules, in the spirit of `src/safety/command-guard.ts`:
 *  - an argument list, never a joined command line, and never a shell
 *  - a hard timeout and an output cap
 *  - the environment is inherited; real isolation comes from the sandbox, not from here
 *
 * Windows batch shims (`.cmd`/`.bat`) are refused instead of being run through cmd.exe,
 * because quoting there cannot be made safe. On Windows use WSL (see `./wsl.ts`).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const WINDOWS_BATCH = /\.(cmd|bat)$/i;

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: string;
}

export interface RunResult {
  command: string;
  args: string[];
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly result?: RunResult,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export const ANSI = /\u001b\[[0-9;]*m/g;

export function isBatchShim(file: string): boolean {
  return WINDOWS_BATCH.test(file);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * PATH lookup without a subprocess. On Windows a real executable wins over a batch
 * shim with the same name, because only the executable can be run without a shell.
 */
export function findExecutable(
  command: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (command.trim() === '') return null;
  if (command.includes('/') || command.includes('\\')) return isFile(command) ? command : null;

  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((dir) => dir !== '');
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((x) => x !== '') : [''];
  let shim: string | null = null;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (!isFile(candidate)) continue;
      if (platform === 'win32' && isBatchShim(candidate)) {
        shim ??= candidate;
        continue;
      }
      return candidate;
    }
  }
  return shim;
}

function unusableReason(command: string, args: readonly string[], platform: NodeJS.Platform): string | null {
  if (command.trim() === '') return 'no command given';
  if (args.some((arg) => arg.includes('\0') || arg.includes('\n') || arg.includes('\r'))) {
    return 'an argument contains a NUL or line break';
  }
  if (platform === 'win32' && isBatchShim(command)) {
    return `${path.basename(command)} is a Windows batch shim, and cws never starts a shell. ` +
      'Run cws inside WSL for tools installed there, or use the Linux binary.';
  }
  return null;
}

export function runTool(command: string, args: readonly string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const fail = (stderr: string): RunResult => ({
    command,
    args: [...args],
    ok: false,
    code: null,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: Date.now() - started,
    stdout: '',
    stderr,
  });

  const reason = unusableReason(command, args, process.platform);
  if (reason !== null) return Promise.resolve(fail(reason));

  return new Promise<RunResult>((resolve) => {
    const child = spawn(command, [...args], {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;

    const capture = (chunks: Buffer[], size: number, chunk: Buffer): number => {
      if (size >= maxBytes) {
        truncated = true;
        return size;
      }
      const slice = chunk.length > maxBytes - size ? chunk.subarray(0, maxBytes - size) : chunk;
      if (slice.length < chunk.length) truncated = true;
      chunks.push(slice);
      return size + slice.length;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes = capture(out, outBytes, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes = capture(err, errBytes, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve(fail(error.message));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        args: [...args],
        ok: !timedOut && code === 0,
        code,
        signal,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });

    child.stdin.end(opts.stdin ?? '');
  });
}

export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim() !== '') ?? '';
  return line.replace(ANSI, '').trim().slice(0, 160);
}

/** First version-looking line a tool prints; null when it cannot run or prints nothing. */
export async function toolVersion(file: string, args: readonly string[] = ['--version']): Promise<string | null> {
  const result = await runTool(file, args, { timeoutMs: VERSION_TIMEOUT_MS, maxOutputBytes: 8 * 1024 });
  if (!result.ok) return null;
  const line = firstLine(result.stdout) || firstLine(result.stderr);
  return line === '' ? null : line;
}

function summarize(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/** Runs a tool that must print JSON and checks it against `schema`. Throws `ToolError` otherwise. */
export async function runToolJson<T>(
  command: string,
  args: readonly string[],
  schema: z.ZodType<T>,
  opts: RunOptions = {},
): Promise<T> {
  const result = await runTool(command, args, opts);
  if (!result.ok) {
    const why = result.timedOut ? 'timed out' : `exit ${result.code ?? 'unknown'}`;
    throw new ToolError(`${command} failed (${why}): ${firstLine(result.stderr) || 'no error output'}`, result);
  }
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new ToolError(`${command} did not print JSON: ${firstLine(result.stdout) || 'empty output'}`, result);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ToolError(`${command} printed unexpected JSON: ${summarize(parsed.error)}`, result);
  return parsed.data;
}
