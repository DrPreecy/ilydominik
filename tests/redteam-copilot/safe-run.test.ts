import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessCommandSafety } from '../../src/safety/command-guard.ts';

describe('Copilot R1: safe-run Git execution guard', () => {
  it('blocks git bisect run because it executes a caller-supplied command', () => {
    const verdict = assessCommandSafety(
      ['git', 'bisect', 'run', 'rm', '-rf', '../../outside'],
      { cwd: process.cwd(), projectRoot: process.cwd() },
    );

    assert.equal(verdict.ok, false);
  });
});
