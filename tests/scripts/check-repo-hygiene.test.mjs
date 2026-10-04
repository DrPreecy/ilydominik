import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(repository, 'scripts/check-repo-hygiene.mjs');

function checkFixture(extraFiles = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cws-hygiene-'));
  try {
    const files = {
      '.gitignore': '',
      'README.md': '',
      'package.json': '{}\n',
      'src/main.ts': '',
      'tests/example.test.ts': '',
      ...extraFiles,
    };
    for (const [file, contents] of Object.entries(files)) {
      const fullPath = path.join(root, file);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, contents);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '--all', '--force'], { cwd: root });
    return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('repo hygiene detects tracked files ignored by git', () => {
  const result = checkFixture({
    '.gitignore': 'tests/fixtures/ignored.txt\n',
    'tests/fixtures/ignored.txt': 'tracked despite ignore rule',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tracked file matches \.gitignore: tests\/fixtures\/ignored\.txt/);
});

test('repo hygiene rejects root files outside the canonical layout', () => {
  const result = checkFixture({ 'stray-notes.md': 'not maintained here' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the canonical layout: stray-notes\.md/);
});

test('repo hygiene rejects tracked generated or secret material', () => {
  const result = checkFixture({ 'src/debug.log': 'generated log' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /generated or secret material is tracked: src\/debug\.log/);
});

test('repo hygiene rejects test files without test or helper/fixture purpose', () => {
  const result = checkFixture({ 'tests/orphan.ts': 'not a test or helper' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no test or helper\/fixture purpose: tests\/orphan\.ts/);
});

test('repo hygiene accepts tests, helpers, and fixtures in their canonical homes', () => {
  const result = checkFixture({
    'tests/helpers.ts': 'export {};\n',
    'tests/fixtures/data.json': '{}\n',
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Repo hygiene check passed/);
});
