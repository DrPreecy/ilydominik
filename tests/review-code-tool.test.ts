import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/app.ts';
import { EXIT, type CliIO } from '../src/cli/io.ts';

/** An `ocr` stand-in: prints a preview, or echoes the files it got after `--` as one rule group. */
const STUB = `
const args = process.argv.slice(2);
if (args[1] === 'preview') {
  process.stdout.write(JSON.stringify({
    schema_version: 1, mode: 'range', repository: '.', total_files: 1, reviewable_count: 1, excluded_count: 0,
    total_insertions: 3, total_deletions: 1,
    reviewable_files: [{ path: '--repo=/tmp/evil', status: 'modified', insertions: 3, deletions: 1 }], excluded_files: [],
  }));
} else {
  const files = args.slice(args.indexOf('--') + 1);
  process.stdout.write(JSON.stringify({ schema_version: 1, groups: [{ group_id: 1, source: 'stub', pattern: '*', files, rule: 'flags:' + args.slice(0, args.indexOf('--')).join(' ') }] }));
}
`;

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-review-code-'));
});
afterEach(async () => {
  delete process.env['CWS_TOOL_OCR'];
  await fs.rm(dir, { recursive: true, force: true });
});

function io(out: string[], err: string[] = []): CliIO {
  return {
    cwd: dir,
    isInteractive: true,
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    ask: async () => '',
    readStdin: async () => '',
    challenge: () => 'K7Q',
    copy: async () => false,
  };
}

describe('review-code with CWS_TOOL_OCR', () => {
  it('runs the ocr named by the environment and keeps file names after --', async () => {
    assert.equal(await runCli(['init', 'Review'], io([])), EXIT.OK);
    const stub = path.join(dir, 'ocr-stub.mjs');
    await fs.writeFile(stub, STUB);
    process.env['CWS_TOOL_OCR'] = stub;
    const out: string[] = [];
    assert.equal(await runCli(['review-code', '--from', 'main'], io(out)), EXIT.OK);
    const text = out.join('');
    assert.match(text, /1 to review/);
    assert.match(text, /### stub \/ \* — --repo=\/tmp\/evil/);
    assert.match(text, /flags:delegate rule --format json --from main/);
  });

  it('names the variable when its path is missing', async () => {
    assert.equal(await runCli(['init', 'Review'], io([])), EXIT.OK);
    process.env['CWS_TOOL_OCR'] = path.join(dir, 'missing-ocr');
    const err: string[] = [];
    assert.equal(await runCli(['review-code'], io([], err)), EXIT.ERROR);
    assert.match(err.join(''), /CWS_TOOL_OCR does not exist/);
  });
});
