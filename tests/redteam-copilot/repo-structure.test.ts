import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('Copilot R1: repository structure verifier', () => {
  it('accepts Node built-in test imports without treating them as dependencies', () => {
    const result = spawnSync(process.execPath, ['scripts/check-repo-structure.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});
