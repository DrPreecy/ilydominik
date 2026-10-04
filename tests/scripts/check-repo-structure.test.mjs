import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(repository, 'scripts/check-repo-structure.mjs');

test('repository structure checker accepts every node:-prefixed builtin', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cws-structure-'));
  try {
    for (const file of [
      'AGENTS.md',
      'README.md',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'tsconfig.build.json',
      'src/cli/main.ts',
      'tests/entrypoint.test.mjs',
      'prompts/explore.md',
      'docs/spec.md',
      '.agents/skills/repo-structure-guardian/SKILL.md',
      '.vscode/tasks.json',
      'scripts/check-repo-structure.mjs',
      'tests/builtin-import.mjs',
    ]) {
      const fullPath = path.join(root, file);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file === 'tests/builtin-import.mjs' ? "import { test } from 'node:test';\n" : '');
    }

    writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'cws',
      bin: { cws: 'dist/cli/main.js' },
      dependencies: {},
    }));
    cpSync(checker, path.join(root, 'scripts/check-repo-structure.mjs'));

    const result = spawnSync(process.execPath, ['scripts/check-repo-structure.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Repo structure check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
