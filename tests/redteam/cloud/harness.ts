import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type CliIO } from '../../../src/cli/io.ts';

export interface FakeIO extends CliIO {
  out: string[];
  err: string[];
  answers: string[];
  asked: string[];
}

export async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `rt-${prefix}-`));
}

export function mkIO(dir: string, interactive: boolean, answers: string[] = []): FakeIO {
  const io: FakeIO = {
    cwd: dir,
    out: [],
    err: [],
    answers: [...answers],
    asked: [],
    isInteractive: interactive,
    stdout: (t) => void io.out.push(t),
    stderr: (t) => void io.err.push(t),
    ask: async (q: string) => {
      io.asked.push(q);
      return io.answers.shift() ?? '';
    },
    readStdin: async () => '',
    challenge: () => 'K7Q',
    copy: async () => true,
  };
  return io;
}
