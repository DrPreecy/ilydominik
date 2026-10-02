import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, fold } from '../src/domain/reducer.ts';
import { AI, HUMAN, errCode, project, run, stamp, step } from './helpers.ts';

describe('reducer: lifecycle', () => {
  it('creates a project in EXPLORATION with empty collections', () => {
    const s = project();
    assert.equal(s.id, 'p_1');
    assert.equal(s.title, 'Test');
    assert.equal(s.phase, 'EXPLORATION');
    assert.deepEqual([s.notes, s.claims, s.decisions, s.proposals, s.sessions, s.phaseHistory], [[], [], [], [], [], []]);
    assert.equal(s.lastSeq, 0);
  });

  it('rejects any event before PROJECT_CREATED', () => {
    assert.throws(
      () => reduce(null, stamp(null, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'x' } })),
      errCode('NO_PROJECT'),
    );
  });

  it('rejects a second PROJECT_CREATED', () => {
    assert.throws(
      () => step(project(), { type: 'PROJECT_CREATED', actor: HUMAN, payload: { projectId: 'p2', title: 'y' } }),
      errCode('PROJECT_EXISTS'),
    );
  });

  it('rejects out-of-order seq', () => {
    const s = project();
    const ev = { ...stamp(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'x' } }), seq: 5 };
    assert.throws(() => reduce(s, ev), errCode('BAD_SEQUENCE'));
  });

  it('is pure: does not mutate the input state', () => {
    const s = project();
    const snapshot = JSON.stringify(s);
    step(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'raw thought' } });
    assert.equal(JSON.stringify(s), snapshot);
  });

  it('fold() replays a list of events; empty list gives null', () => {
    assert.equal(fold([]), null);
    const s0 = null;
    const e0 = stamp(s0, { type: 'PROJECT_CREATED', actor: HUMAN, payload: { projectId: 'p', title: 't' } });
    const s1 = reduce(s0, e0);
    const e1 = stamp(s1, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n', text: 'x' } });
    assert.equal(fold([e0, e1])?.notes.length, 1);
  });
});

describe('reducer: notes and sessions', () => {
  it('stores raw notes verbatim with actor, phase and session', () => {
    let s = project();
    s = step(s, { type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: 's1', goal: 'dump ideas' } });
    s = step(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: '  messy, contradictory\nthoughts ' } });
    const n = s.notes[0]!;
    assert.equal(n.text, '  messy, contradictory\nthoughts ');
    assert.equal(n.sessionId, 's1');
    assert.equal(n.phase, 'EXPLORATION');
    assert.deepEqual(n.actor, HUMAN);
  });

  it('tracks one active session at a time', () => {
    let s = project();
    s = step(s, { type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: 's1', goal: 'g' } });
    assert.equal(s.activeSessionId, 's1');
    assert.equal(s.sessions[0]!.startSeq, 1);
    assert.throws(
      () => step(s, { type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: 's2', goal: 'g' } }),
      errCode('SESSION_ACTIVE'),
    );
    s = step(s, { type: 'SESSION_ENDED', actor: HUMAN, payload: { sessionId: 's1', summary: 'done' } });
    assert.equal(s.activeSessionId, undefined);
    assert.ok(s.sessions[0]!.endedAt);
    assert.equal(s.sessions[0]!.summary, 'done');
  });

  it('rejects ending a session that is not active', () => {
    assert.throws(
      () => step(project(), { type: 'SESSION_ENDED', actor: HUMAN, payload: { sessionId: 's9' } }),
      errCode('NO_ACTIVE_SESSION'),
    );
  });
});

describe('reducer: claims', () => {
  it('human claims are confirmed; AI claims are not', () => {
    const s = run(
      [
        { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'c1', type: 'USER_STATEMENT', text: 'I want X' } },
        { type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'c2', type: 'INTERPRETATION', text: 'User means Y' } },
      ],
      project(),
    );
    assert.equal(s.claims[0]!.confirmed, true);
    assert.equal(s.claims[0]!.status, 'OPEN');
    assert.equal(s.claims[1]!.confirmed, false);
    assert.deepEqual(s.claims[1]!.createdBy, AI);
  });

  it('validates derivedFrom references', () => {
    let s = project();
    s = step(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'x' } });
    s = step(s, {
      type: 'CLAIM_ADDED',
      actor: AI,
      payload: { claimId: 'c1', type: 'ASSUMPTION', text: 'a', risk: 'HIGH', derivedFrom: ['n1'] },
    });
    assert.deepEqual(s.claims[0]!.derivedFrom, ['n1']);
    assert.throws(
      () =>
        step(s, {
          type: 'CLAIM_ADDED',
          actor: AI,
          payload: { claimId: 'c2', type: 'ASSUMPTION', text: 'a', derivedFrom: ['ghost'] },
        }),
      errCode('NOT_FOUND'),
    );
  });

  it('rejects duplicate ids across entity kinds', () => {
    let s = project();
    s = step(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'x1', text: 'x' } });
    assert.throws(
      () => step(s, { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'x1', type: 'FACT', text: 'f' } }),
      errCode('DUPLICATE_ID'),
    );
  });

  it('human confirms an AI claim, optionally re-typing it', () => {
    let s = run([{ type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'c1', type: 'INTERPRETATION', text: 't' } }], project());
    s = step(s, { type: 'CLAIM_CONFIRMED', actor: HUMAN, payload: { claimId: 'c1', asType: 'USER_STATEMENT' } });
    assert.equal(s.claims[0]!.confirmed, true);
    assert.equal(s.claims[0]!.type, 'USER_STATEMENT');
  });

  it('answering an UNKNOWN stores the answer but does not create a FACT', () => {
    let s = run([{ type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'u1', type: 'UNKNOWN', text: 'Will people pay?' } }], project());
    s = step(s, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: 'u1', status: 'ANSWERED', answer: 'probably' } });
    assert.equal(s.claims.length, 1);
    assert.equal(s.claims[0]!.status, 'ANSWERED');
    assert.equal(s.claims[0]!.answer, 'probably');
    assert.equal(s.claims.filter((c) => c.type === 'FACT').length, 0);
  });

  it('status change with evidence appends evidence attributed to the human', () => {
    let s = run([{ type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'a1', type: 'ASSUMPTION', text: 'a', risk: 'FATAL' } }], project());
    s = step(s, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: 'a1', status: 'SUPPORTED', evidence: 'ran test T' } });
    const c = s.claims[0]!;
    assert.equal(c.status, 'SUPPORTED');
    assert.equal(c.evidence.length, 1);
    assert.equal(c.evidence[0]!.text, 'ran test T');
    assert.deepEqual(c.evidence[0]!.actor, HUMAN);
    assert.equal(c.confirmed, true, 'a human touching the claim confirms it');
  });

  it('AI may attach evidence without changing status', () => {
    let s = run([{ type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'a1', type: 'ASSUMPTION', text: 'a' } }], project());
    s = step(s, { type: 'EVIDENCE_ADDED', actor: AI, payload: { evidenceId: 'e1', claimId: 'a1', text: 'paper X says…', source: 'https://x' } });
    assert.equal(s.claims[0]!.status, 'OPEN');
    assert.equal(s.claims[0]!.evidence[0]!.source, 'https://x');
  });
});

describe('reducer: proposals (AI proposes, human decides)', () => {
  it('accepting a claim proposal materialises a confirmed claim with AI provenance', () => {
    let s = project();
    s = step(s, {
      type: 'PROPOSAL_SUBMITTED',
      actor: AI,
      payload: { proposalId: 'pr1', item: { kind: 'claim', type: 'FACT', text: 'Market has 3 competitors' }, rationale: 'from research' },
    });
    assert.equal(s.proposals[0]!.status, 'PENDING');
    assert.equal(s.claims.length, 0);
    s = step(s, { type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: 'pr1', resultId: 'c9' } });
    assert.equal(s.proposals[0]!.status, 'ACCEPTED');
    assert.equal(s.proposals[0]!.resultId, 'c9');
    const c = s.claims[0]!;
    assert.equal(c.id, 'c9');
    assert.equal(c.type, 'FACT');
    assert.equal(c.confirmed, true);
    assert.deepEqual(c.createdBy, AI);
  });

  it('accepting a decision proposal records a decision with rejected alternatives', () => {
    let s = project();
    s = step(s, {
      type: 'PROPOSAL_SUBMITTED',
      actor: AI,
      payload: { proposalId: 'pr1', item: { kind: 'decision', title: 'Storage', options: ['files', 'db'], selected: 'files', rationale: 'simplest' } },
    });
    s = step(s, { type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: 'pr1', resultId: 'd1' } });
    const d = s.decisions[0]!;
    assert.equal(d.id, 'd1');
    assert.deepEqual(d.rejected, ['db']);
    assert.equal(d.kind, 'NORMAL');
  });

  it('accepting a status proposal changes the target claim', () => {
    let s = run([{ type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'a1', type: 'ASSUMPTION', text: 'a' } }], project());
    s = step(s, {
      type: 'PROPOSAL_SUBMITTED',
      actor: AI,
      payload: { proposalId: 'pr1', item: { kind: 'status', claimId: 'a1', status: 'FALSIFIED', evidence: 'benchmark failed' } },
    });
    s = step(s, { type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: 'pr1', resultId: 'a1' } });
    assert.equal(s.claims[0]!.status, 'FALSIFIED');
    assert.equal(s.claims[0]!.evidence[0]!.text, 'benchmark failed');
  });

  it('accepting a phase proposal changes the phase', () => {
    let s = project();
    s = step(s, { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'pr1', item: { kind: 'phase', to: 'UNDERSTANDING', reason: 'dump done' } } });
    s = step(s, { type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: 'pr1', resultId: 'pr1' } });
    assert.equal(s.phase, 'UNDERSTANDING');
  });

  it('a rejected proposal changes nothing but is kept with its note', () => {
    let s = project();
    s = step(s, { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'pr1', item: { kind: 'claim', type: 'FACT', text: 'x' } } });
    s = step(s, { type: 'PROPOSAL_REJECTED', actor: HUMAN, payload: { proposalId: 'pr1', note: 'not true' } });
    assert.equal(s.claims.length, 0);
    assert.equal(s.proposals[0]!.status, 'REJECTED');
    assert.equal(s.proposals[0]!.resolutionNote, 'not true');
  });

  it('a proposal can only be resolved once', () => {
    let s = project();
    s = step(s, { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'pr1', item: { kind: 'claim', type: 'FACT', text: 'x' } } });
    s = step(s, { type: 'PROPOSAL_REJECTED', actor: HUMAN, payload: { proposalId: 'pr1' } });
    assert.throws(
      () => step(s, { type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: 'pr1', resultId: 'c1' } }),
      errCode('ALREADY_RESOLVED'),
    );
  });
});

describe('reducer: decisions and phases', () => {
  it('records human decisions; selected is added to options if missing; rejected = others', () => {
    const s = run(
      [{ type: 'DECISION_RECORDED', actor: HUMAN, payload: { decisionId: 'd1', title: 'Lang', options: ['ts', 'py'], selected: 'go', rationale: 'team' } }],
      project(),
    );
    const d = s.decisions[0]!;
    assert.deepEqual(d.options, ['ts', 'py', 'go']);
    assert.deepEqual(d.rejected, ['ts', 'py']);
  });

  it('decision links must exist', () => {
    assert.throws(
      () =>
        step(project(), {
          type: 'DECISION_RECORDED',
          actor: HUMAN,
          payload: { decisionId: 'd1', title: 't', options: [], selected: 's', rationale: 'r', links: ['nope'] },
        }),
      errCode('NOT_FOUND'),
    );
  });

  it('phases can move forward and backward freely; history records from/to/reason', () => {
    let s = project();
    s = step(s, { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: 'PLANNING', reason: 'jump' } });
    assert.equal(s.phase, 'PLANNING');
    s = step(s, { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: 'UNDERSTANDING', reason: 'new discovery' } });
    assert.equal(s.phase, 'UNDERSTANDING');
    assert.deepEqual(
      s.phaseHistory.map((h) => [h.from, h.to]),
      [
        ['EXPLORATION', 'PLANNING'],
        ['PLANNING', 'UNDERSTANDING'],
      ],
    );
  });

  it('a backward move lists items created in later phases as possibly affected (never rewrites them)', () => {
    let s = project();
    s = step(s, { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'early', type: 'USER_STATEMENT', text: 'x' } });
    s = step(s, { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: 'PLANNING', reason: 'go' } });
    s = step(s, { type: 'DECISION_RECORDED', actor: HUMAN, payload: { decisionId: 'd1', title: 't', options: [], selected: 's', rationale: 'r' } });
    s = step(s, { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: 'UNDERSTANDING', reason: 'back' } });
    assert.deepEqual(s.phaseHistory.at(-1)!.possiblyAffected, ['d1']);
    assert.equal(s.decisions.length, 1);
  });

  it('changing to the current phase is invalid', () => {
    assert.throws(() => step(project(), { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: 'EXPLORATION', reason: 'x' } }), errCode('INVALID_EVENT'));
  });
});
