import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCommandSafety } from '../../../src/safety/command-guard.ts';
const ctx = { cwd: process.cwd(), projectRoot: process.cwd() };
for (const argv of [
  ['git', 'rebase', '-x', 'rm -rf /', 'main'],
  ['git', 'rebase', '--exec', 'rm -rf /', 'main'],
  ['git', 'submodule', 'foreach', 'rm -rf /'],
  ['git', 'bisect', 'run', 'rm', '-rf', '/'],
  ['git', 'fetch', '--upload-pack=evil', 'origin'],
  ['git', 'clone', '--upload-pack=evil', 'x', 'y'],
  ['git', 'gc', '--prune=now'],
  ['git', 'commit', '--no-verify', '-m', 'x'],
]) {
  test(`guard blocks ${argv.join(' ')}`, () => {
    assert.equal(assessCommandSafety(argv, ctx).ok, false);
  });
}
