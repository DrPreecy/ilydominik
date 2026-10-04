import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../../src/cli/app.ts';
import type { CliIO } from '../../../src/cli/io.ts';
import type { Env } from '../../../src/cli/human.ts';
import { EventLog } from '../../../src/store/event-log.ts';

const TSX = import.meta.resolve('tsx');
export const MAIN = path.resolve(import.meta.dirname, '../../../src/cli/main.ts');

export async function tmpProject(title = 'Witness'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-silent-'));
  await EventLog.init(dir, title);
  return dir;
}

export async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cws-silent-'));
}

export interface Run { code: number | null; out: string; err: string }

/** The real CLI as a child process: non-interactive, like an agent. */
export function cws(cwd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  const r = spawnSync(process.execPath, ['--import', TSX, MAIN, ...args], {
    cwd,
    encoding: 'utf8',
    input: opts.input ?? '',
    env: opts.env ?? process.env,
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

export interface FakeIO extends CliIO { out: string[]; err: string[] }

/** A human at a terminal (in-process); every confirmation code is K7Q. */
export function human(cwd: string, answers: string[] = [], stdin = ''): FakeIO {
  const io: FakeIO = {
    cwd, out: [], err: [], isInteractive: true,
    stdout: (t) => void io.out.push(t),
    stderr: (t) => void io.err.push(t),
    ask: async () => answers.shift() ?? '',
    readStdin: async () => stdin,
    challenge: () => 'K7Q',
    copy: async () => true,
  };
  return io;
}

export const runHuman = async (io: FakeIO, args: string[], env?: Partial<Env>): Promise<number> => runCli(args, io, env);
export const all = (io: FakeIO): string => [...io.out, ...io.err].join('\n');

/** A stub openshell (a node script): appends its argv to `calls.log`, exits 0. */
export async function stubOpenshell(dir: string): Promise<{ script: string; calls: () => Promise<string[]> }> {
  const script = path.join(dir, 'stub-openshell.mjs');
  const log = path.join(dir, 'calls.log');
  await fs.writeFile(script, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + String.fromCharCode(10));
`);
  return { script, calls: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

export async function localSandboxConfig(root: string): Promise<void> {
  await fs.writeFile(path.join(root, '.cws', 'integrations.json'), JSON.stringify({ version: 1, sandbox: { mode: 'local' } }));
}
