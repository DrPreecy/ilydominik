import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HUMAN, project, step } from '../helpers.ts';
import { CONSENT_DECISION_TITLE, hasGeminiConsent } from '../../src/integrations/gemini.ts';

describe('Copilot R1: Gemini consent identity', () => {
  it('does not treat an unrelated Gemini/privacy decision as consent', () => {
    const state = step(project(), {
      type: 'DECISION_RECORDED',
      actor: HUMAN,
      payload: {
        decisionId: 'd1',
        title: 'Gemini privacy feature discussion',
        options: ['yes', 'no'],
        selected: 'yes',
        rationale: 'Discussed a product feature, not data sharing.',
      },
    });

    assert.equal(hasGeminiConsent(state), false);
  });

  it('recognizes the recorded Gemini consent decision', () => {
    const state = step(project(), {
      type: 'DECISION_RECORDED',
      actor: HUMAN,
      payload: {
        decisionId: 'd1',
        title: CONSENT_DECISION_TITLE,
        options: ['yes', 'no'],
        selected: 'yes',
        rationale: 'Accepted the Gemini free-tier data terms.',
      },
    });

    assert.equal(hasGeminiConsent(state), true);
  });
});
