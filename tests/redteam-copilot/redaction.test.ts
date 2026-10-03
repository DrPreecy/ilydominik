import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskSecrets } from '../../src/findings/types.ts';

describe('Copilot R1: credential redaction', () => {
  it('masks quoted credential values that contain spaces', () => {
    const value = 'password=' + '"' + 'private test phrase' + '"';
    assert.doesNotMatch(maskSecrets(value), /private test phrase/);
  });
});
