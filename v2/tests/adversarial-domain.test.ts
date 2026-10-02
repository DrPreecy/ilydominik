/**
 * The v1 attack probes, re-run against v2's domain layer.
 * Every probe that slipped through v1 must now be rejected for AI actors.
 * (Human-side probes become warnings — see adversarial-guidance.test.ts.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reduce } from '../src/domain/reducer.ts';
import { newId } from '../src/domain/ids.ts';
import { parseEventInput } from '../src/domain/schema.ts';
import type { EventInput } from '../src/domain/types.ts';
import { AI, HUMAN, errCode, project, run, stamp, step } from './helpers.ts';

describe('adversarial: AI cannot take ownership (v1 probe #1)', () => {
  const aiAttempts: EventInput[] = [
    { type: 'DECISION_RECORDED', actor: AI, payload: { decisionId: 'd', title: 'GraphQL', options: [], selected: 'GraphQL', rationale: 'trust me' } },
    { type: 'PHASE_CHANGED', actor: AI, payload: { to: 'IMPLEMENTATION', reason: 'let us code' } },
    { type: 'SESSION_STARTED', actor: AI, payload: { sessionId: 's', goal: 'g' } },
    { type: 'PROJECT_CREATED', actor: AI, payload: { projectId: 'p', title: 't' } },
  ];
  for (const attempt of aiAttempts) {
    it(`AI ${attempt.type} → AI_NOT_AUTHORIZED`, () => {
      const base = attempt.type === 'PROJECT_CREATED' ? null : project();
      assert.throws(() => reduce(base, stamp(base, attempt)), errCode('AI_NOT_AUTHORIZED'));
    });
  }

  it('AI cannot accept its own proposal', () => {
    let s = project();
    s = step(s, { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'pr', item: { kind: 'claim', type: 'FACT', text: 'x' } } });
    assert.throws(() => step(s, { type: 'PROPOSAL_ACCEPTED', actor: AI, payload: { proposalId: 'pr', resultId: 'c' } }), errCode('AI_NOT_AUTHORIZED'));
  });

  it('a self-declared "human" role string does not help: actor kind decides', () => {
    const fake = { kind: 'ai', agent: 'human', role: 'HUMAN' } as const;
    assert.throws(
      () => step(project(), { type: 'DECISION_RECORDED', actor: fake, payload: { decisionId: 'd', title: 't', options: [], selected: 's', rationale: 'r' } }),
      errCode('AI_NOT_AUTHORIZED'),
    );
  });
});

describe('adversarial: AI interpretations never silently become facts (v1 probes #2, #7, #8)', () => {
  it('AI cannot add FACT or USER_STATEMENT directly', () => {
    for (const type of ['FACT', 'USER_STATEMENT'] as const) {
      assert.throws(
        () => step(project(), { type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'c', type, text: 'market is 10B' } }),
        errCode('AI_CLAIM_TYPE_FORBIDDEN'),
      );
    }
  });

  it('AI cannot change claim status (validate/falsify/answer)', () => {
    const s = run([{ type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'a', type: 'ASSUMPTION', text: 'x', risk: 'FATAL' } }], project());
    assert.throws(
      () => step(s, { type: 'CLAIM_STATUS_CHANGED', actor: AI, payload: { claimId: 'a', status: 'SUPPORTED', evidence: 'aaaaaaaaaa' } }),
      errCode('AI_NOT_AUTHORIZED'),
    );
  });

  it('AI cannot confirm its own claim', () => {
    const s = run([{ type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'c', type: 'INTERPRETATION', text: 'x' } }], project());
    assert.throws(() => step(s, { type: 'CLAIM_CONFIRMED', actor: AI, payload: { claimId: 'c' } }), errCode('AI_NOT_AUTHORIZED'));
  });

  it('no code path assigns a numeric confidence out of thin air', () => {
    let s = run([{ type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'a', type: 'ASSUMPTION', text: 'x' } }], project());
    s = step(s, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: 'a', status: 'SUPPORTED', evidence: 'e' } });
    assert.equal(JSON.stringify(s).includes('confidence'), false);
  });
});

describe('adversarial: data integrity (v1 probes #9–#12)', () => {
  it('newId never collides in a tight loop', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId('c')));
    assert.equal(ids.size, 5000);
    assert.match(newId('c'), /^c_[0-9a-f]{12}$/);
  });

  it('unknown event types are rejected by the schema', () => {
    assert.throws(() => parseEventInput({ type: 'DROP_TABLE', actor: HUMAN, payload: {} }), errCode('INVALID_EVENT'));
  });

  it('unknown event types are rejected by the reducer too (defence in depth)', () => {
    const s = project();
    const bad = { ...stamp(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n', text: 'x' } }), type: 'DROP_TABLE' };
    assert.throws(() => reduce(s, bad as never), errCode('INVALID_EVENT'));
  });

  it('schema rejects empty text, empty ids, bad enums and extra junk types', () => {
    const bad: unknown[] = [
      { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n', text: '   ' } },
      { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: '', text: 'x' } },
      { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'c', type: 'GOSPEL', text: 'x' } },
      { type: 'CLAIM_ADDED', actor: { kind: 'robot' }, payload: { claimId: 'c', type: 'FACT', text: 'x' } },
      { type: 'CLAIM_ADDED', actor: { kind: 'ai' }, payload: { claimId: 'c', type: 'HYPOTHESIS', text: 'x' } },
      { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: 'NIRVANA', reason: 'x' } },
      { type: 'DECISION_RECORDED', actor: HUMAN, payload: { decisionId: 'd', title: 't', options: [], selected: '', rationale: 'r' } },
      null,
      'NOTE_ADDED',
    ];
    for (const b of bad) assert.throws(() => parseEventInput(b), errCode('INVALID_EVENT'), JSON.stringify(b));
  });

  it('schema accepts a valid input and returns it typed', () => {
    const ok = parseEventInput({ type: 'NOTE_ADDED', actor: { kind: 'ai', agent: 'gemini' }, payload: { noteId: 'n', text: 'x' } });
    assert.equal(ok.type, 'NOTE_ADDED');
  });

  it('there is no way to bulk-overwrite history (no UPDATE_PROGRESS-like event)', () => {
    assert.throws(() => parseEventInput({ type: 'UPDATE_PROGRESS', actor: HUMAN, payload: { completedMilestones: [] } }), errCode('INVALID_EVENT'));
  });
});
