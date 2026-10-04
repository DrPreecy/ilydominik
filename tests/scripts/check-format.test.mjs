import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(repository, 'scripts/check-format.mjs');

function runInFixture({ tracked, untracked = [] }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cws-format-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const [file, contents] of Object.entries({ ...tracked, ...Object.fromEntries(untracked) })) {
      const fullPath = path.join(root, file);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, contents);
    }
    execFileSync('git', ['add', ...Object.keys(tracked)], { cwd: root });
    return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('format checker ignores untracked files and tribunal review JSON', () => {
  const result = runInFixture({
    tracked: {
      'clean.md': 'clean\n',
      'docs/review/round.json': '{"bad": "format" }  \n',
    },
    untracked: [['untracked.md', 'unformatted  ']],
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('format checker still checks tracked source files', () => {
  const result = runInFixture({ tracked: { 'tracked.md': 'unformatted  ' } });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tracked\.md/);
});
