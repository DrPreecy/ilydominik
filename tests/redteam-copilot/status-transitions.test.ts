import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HUMAN, project, step } from '../helpers.ts';

describe('Copilot R1: claim status transitions', () => {
  it('requires an assumption to enter TESTING before becoming SUPPORTED', () => {
    const state = step(project(), {
      type: 'CLAIM_ADDED',
      actor: HUMAN,
      payload: { claimId: 'c1', type: 'ASSUMPTION', text: 'The deployment is safe.' },
    });

    assert.throws(
      () =>
        step(state, {
          type: 'CLAIM_STATUS_CHANGED',
          actor: HUMAN,
          payload: { claimId: 'c1', status: 'SUPPORTED' },
        }),
      /INVALID_EVENT/,
    );
  });
});
