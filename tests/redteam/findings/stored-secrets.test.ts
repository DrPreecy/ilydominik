/**
 * Red-team witnesses for I9 on the paths where text reaches storage, the terminal or a prompt.
 * Each test asserts the CORRECT behaviour (RED = defect).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../../src/cli/app.ts';
import { EXIT, type CliIO } from '../../../src/cli/io.ts';
import { findingClaimText } from '../../../src/findings/ingest.ts';
import { maskSecrets } from '../../../src/findings/types.ts';
import { shorten } from '../../../src/guidance/warnings.ts';

interface FakeIO extends CliIO {
  out: string[];
  err: string[];
  stdin: string;
}

function io(cwd: string, stdin = '', isInteractive = true): FakeIO {
  const fake: FakeIO = {
    cwd,
    out: [],
    err: [],
    stdin,
    isInteractive,
    stdout: (t) => void fake.out.push(t),
    stderr: (t) => void fake.err.push(t),
    ask: async () => '',
    readStdin: async () => fake.stdin,
    challenge: () => 'K7Q',
    copy: async () => true,
  };
  return fake;
}
const text = (f: FakeIO): string => [...f.out, ...f.err].join('\n');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// assembled at runtime so scanners do not flag this file
const GH = ['ghp', '_', ALNUM.slice(0, 36)].join('');
const AWS = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');

let base: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-secrets-'));
  assert.equal(await runCli(['init', 'Garden'], io(base)), EXIT.OK);
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const log = (): Promise<string> => fs.readFile(path.join(base, '.cws', 'events.jsonl'), 'utf8');

describe('I9: text reaching storage', () => {
  it('cws dump does not write a pasted token to .cws/events.jsonl', async () => {
    await runCli(['dump', `deploy with ${GH} and ${AWS}`], io(base));
    const stored = await log();
    assert.equal(stored.includes(GH), false, 'GitHub token stored in plaintext in the event log');
    assert.equal(stored.includes(AWS), false, 'AWS key id stored in plaintext in the event log');
  });

  it('cws claim add --agent does not store a token verbatim', async () => {
    await runCli(['claim', 'add', '--agent', 'claude', '--type', 'HYPOTHESIS', '--text', `the key is ${GH}`], io(base));
    assert.equal((await log()).includes(GH), false);
  });

  it('cws evidence add does not store a token verbatim', async () => {
    const add = io(base);
    await runCli(['claim', 'add', '--agent', 'claude', '--type', 'HYPOTHESIS', '--text', 'x is true'], add);
    const id = /\[(c_[0-9a-f]+)\]/.exec(text(add))?.[1] ?? '';
    await runCli(['evidence', 'add', '--agent', 'claude', '--claim', id, '--text', `seen in ${GH}`], io(base));
    assert.equal((await log()).includes(GH), false);
  });
});

describe('I9: text reaching the terminal / next-step output', () => {
  it('cws status does not echo a stored token inside a warning', async () => {
    await runCli(['claim', 'add', '--agent', 'claude', '--type', 'HYPOTHESIS', '--text', `uses ${GH}`], io(base));
    const out = io(base);
    await runCli(['status'], out);
    assert.equal(text(out).includes(GH), false, text(out));
  });

  it('shorten() in guidance/warnings.ts masks secrets', () => {
    assert.equal(shorten(`token ${GH} leaked`).includes(GH), false);
  });
});

describe('I9: findings claim text', () => {
  it('does not eat the first word of the message because the rule id looks like a key name', () => {
    const claim = findingClaimText({
      tool: 'semgrep',
      ruleId: 'hardcoded-password',
      message: 'Hardcoded credentials found in config',
      severity: 'high',
      path: 'a.ts',
    });
    assert.match(claim, /Hardcoded credentials found in config/);
  });
});

describe('I9/DoS: masking cost is linear', () => {
  it('maskSecrets on 60 KB of hyphenated words finishes quickly', () => {
    const input = 'a-'.repeat(30_000);
    const started = Date.now();
    maskSecrets(input);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms for 60 KB (quadratic \\b + (?:x[_-])* scan)`);
  });

  it('maskSecrets on repeated BEGIN PRIVATE KEY headers without END finishes quickly', () => {
    const input = '-----BEGIN PRIVATE KEY-----'.repeat(8_000);
    const started = Date.now();
    maskSecrets(input);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms for ${input.length} bytes`);
  });

  it('ten stored 20 KB notes (the per-note maximum) do not stall cws context', async () => {
    for (let i = 0; i < 10; i += 1) await runCli(['dump', '--agent', 'claude', 'a-'.repeat(10_000)], io(base));
    const started = Date.now();
    await runCli(['context', 'explore'], io(base));
    assert.ok(Date.now() - started < 3000, 'cws context took ' + (Date.now() - started) + ' ms');
  });

  it('a 60 KB SARIF message does not stall findings ingest', async () => {
    const sarif = { version: '2.1.0', runs: [{ tool: { driver: { name: 'semgrep' } }, results: [{ ruleId: 'r', level: 'error', message: { text: 'a-'.repeat(30_000) }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.ts' }, region: { startLine: 1 } } }] }] }] };
    const started = Date.now();
    await runCli(['findings', 'ingest', '--format', 'sarif', '-'], io(base, JSON.stringify(sarif)));
    assert.ok(Date.now() - started < 3000, 'ingest took ' + (Date.now() - started) + ' ms');
  });
});
