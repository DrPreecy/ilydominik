#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import readline from 'node:readline/promises';
import { runCli } from './app.ts';
import { systemToolPath } from '../integrations/exec.ts';
import type { CliIO } from './io.ts';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 3;
/** Far above any real input (findings files are capped at 10 MB of text); stops `yes | cws dump -` from eating memory. */
const MAX_STDIN_BYTES = 40 * 1024 * 1024;

function clipboardCommand(): [string, string[]] {
  if (process.platform === 'win32') return [systemToolPath('clip'), []];
  if (process.platform === 'darwin') return ['pbcopy', []];
  return ['xclip', ['-selection', 'clipboard']];
}

function copy(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const [cmd, args] = clipboardCommand();
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin.on('error', () => resolve(false));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/** Ctrl+D (end of input) answers with an empty line, which quits the menu or cancels the question. */
async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<string>((resolve) => rl.once('close', () => resolve('')));
  try {
    return await Promise.race([rl.question(question).catch(() => ''), closed]);
  } finally {
    rl.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Uint8Array).length;
    if (size > MAX_STDIN_BYTES) throw new Error(`input is larger than ${MAX_STDIN_BYTES / (1024 * 1024)} MB; give a smaller file`);
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function challenge(): string {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

const io: CliIO = {
  cwd: process.cwd(),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask,
  readStdin,
  challenge,
  copy,
};

process.exitCode = await runCli(process.argv.slice(2), io);
