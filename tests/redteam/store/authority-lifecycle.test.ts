// I2 + I3 exhaustive (Tier A) against docs/spec.md section 1 and 2.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fold, reduce } from '../../../src/domain/reducer.ts';
import { CLAIM_STATUSES, CLAIM_TYPES, CLAIM_TYPE_STATUSES, HUMAN_ONLY_EVENTS } from '../../../src/domain/types.ts';
import type { ClaimStatus, ClaimType, CwsEvent, EventInput, ProjectState } from '../../../src/domain/types.ts';
import { AI, claim, created, forge, HUMAN, status } from './util.ts';
import type { Forge } from './util.ts';

type Edge = [ClaimType, ClaimStatus, ClaimStatus];

/** Spec section 1: OPEN -> TESTING -> SUPPORTED | FALSIFIED; UNKNOWN -> ANSWERED; anything -> RETIRED. */
function specAllows(type: ClaimType, from: ClaimStatus, to: ClaimStatus): boolean {
  if (!CLAIM_TYPE_STATUSES[type].includes(to) || from === 'RETIRED' || from === to) return false;
  if (to === 'RETIRED') return true;
  if (from === 'OPEN' && to === 'TESTING') return true;
  if (from === 'TESTING' && (to === 'SUPPORTED' || to === 'FALSIFIED')) return true;
  if (type === 'UNKNOWN' && to === 'ANSWERED' && (from === 'OPEN' || from === 'TESTING')) return true;
  return false;
}

function accepted(prefix: Forge[], next: Forge): boolean {
  try { fold(forge([...prefix, next])); return true; } catch { return false; }
}

/** All states the reducer lets a claim reach (BFS using the reducer itself) -> status -> event prefix. */
function reachable(type: ClaimType): Map<ClaimStatus, Forge[]> {
  const seen = new Map<ClaimStatus, Forge[]>([['OPEN', [created(), claim('c', type)]]]);
  const queue: ClaimStatus[] = ['OPEN'];
  while (queue.length) {
    const from = queue.shift()!;
    for (const to of CLAIM_STATUSES) {
      if (seen.has(to)) continue;
      const prefix = [...seen.get(from)!, status('c', to)];
      if (accepted(prefix.slice(0, -1), prefix.at(-1)!)) { seen.set(to, prefix); queue.push(to); }
    }
  }
  return seen;
}

function violations(): { extra: Edge[]; missing: Edge[]; checked: number } {
  const extra: Edge[] = [];
  const missing: Edge[] = [];
  let checked = 0;
  for (const type of CLAIM_TYPES) {
    for (const [from, prefix] of reachable(type)) {
      for (const to of CLAIM_STATUSES) {
        if (!CLAIM_TYPE_STATUSES[type].includes(to)) continue;
        checked++;
        const got = accepted(prefix, status('c', to));
        const want = specAllows(type, from, to);
        if (got && !want) extra.push([type, from, to]);
        if (!got && want) missing.push([type, from, to]);
      }
    }
  }
  return { extra, missing, checked };
}

test('I3: reducer accepts no status edge that leaves a terminal state (RETIRED/SUPPORTED/FALSIFIED/ANSWERED)', () => {
  const { extra } = violations();
  const terminal = extra.filter(([, from]) => from === 'RETIRED' || from === 'SUPPORTED' || from === 'FALSIFIED' || from === 'ANSWERED');
  assert.deepEqual(terminal, [], `${terminal.length} edges leave a terminal state: ${JSON.stringify(terminal.slice(0, 8))}`);
});

test('I3: reducer accepts no status edge that skips TESTING (OPEN -> SUPPORTED/FALSIFIED) per strict spec chain', () => {
  const { extra } = violations();
  const skip = extra.filter(([, from, to]) => from === 'OPEN' && (to === 'SUPPORTED' || to === 'FALSIFIED' || to === 'ANSWERED'));
  assert.deepEqual(skip, [], JSON.stringify(skip));
});

test('I3: no-op self transitions (X -> X) are not accepted as status changes', () => {
  const { extra } = violations();
  assert.deepEqual(extra.filter(([, f, t]) => f === t), []);
});

test('I3: every spec-legal edge is accepted (completeness of the relation)', () => {
  const { missing } = violations();
  assert.deepEqual(missing, []);
});

test('I3: the proposal path (PROPOSAL_ACCEPTED status item) rejects terminal-state exits like the direct path should', () => {
  const bad: string[] = [];
  for (const type of CLAIM_TYPES) {
    for (const [from, prefix] of reachable(type)) {
      for (const to of CLAIM_STATUSES) {
        if (!CLAIM_TYPE_STATUSES[type].includes(to)) continue;
        const ans = to === 'ANSWERED' ? { answer: 'x' } : {};
        const via: Forge[] = [
          { input: { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'pp', item: { kind: 'status', claimId: 'c', status: to, ...ans } } } },
          { input: { type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: 'pp', resultId: 'r' } } },
        ];
        const got = via.every((_, i) => accepted([...prefix, ...via.slice(0, i)], via[i]!));
        if (got && !specAllows(type, from, to)) bad.push(`${type}:${from}->${to}`);
      }
    }
  }
  const terminal = bad.filter((b) => /:(RETIRED|SUPPORTED|FALSIFIED|ANSWERED)->/.test(b));
  assert.deepEqual(terminal, []);
});

// ---------------------------------------------------------------- I2 authority

const baseState = (): ProjectState => fold(forge([
  created(),
  { input: { type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: 's1', goal: 'g' } } },
  claim('c', 'ASSUMPTION'),
  { input: { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n', text: 't' } } },
  { input: { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'pp', item: { kind: 'phase', to: 'PROOF', reason: 'r' } } } },
]))!;

const AI_INPUTS: EventInput[] = [
  { type: 'PROJECT_CREATED', actor: AI, payload: { projectId: 'p', title: 't' } },
  { type: 'NOTE_ADDED', actor: AI, payload: { noteId: 'n2', text: 't' } },
  { type: 'SESSION_STARTED', actor: AI, payload: { sessionId: 's2', goal: 'g' } },
  { type: 'SESSION_ENDED', actor: AI, payload: { sessionId: 's1' } },
  { type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'x', type: 'INTERPRETATION', text: 't' } },
  { type: 'CLAIM_CONFIRMED', actor: AI, payload: { claimId: 'c' } },
  { type: 'CLAIM_STATUS_CHANGED', actor: AI, payload: { claimId: 'c', status: 'TESTING' } },
  { type: 'EVIDENCE_ADDED', actor: AI, payload: { evidenceId: 'e', claimId: 'c', text: 't' } },
  { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'p2', item: { kind: 'phase', to: 'PROOF', reason: 'r' } } },
  { type: 'PROPOSAL_ACCEPTED', actor: AI, payload: { proposalId: 'pp', resultId: 'r' } },
  { type: 'PROPOSAL_REJECTED', actor: AI, payload: { proposalId: 'pp' } },
  { type: 'DECISION_RECORDED', actor: AI, payload: { decisionId: 'd', title: 't', options: ['a'], selected: 'a', rationale: 'r' } },
  { type: 'PHASE_CHANGED', actor: AI, payload: { to: 'PROOF', reason: 'r' } },
];
const AI_ALLOWED = new Set(['NOTE_ADDED', 'CLAIM_ADDED', 'EVIDENCE_ADDED', 'PROPOSAL_SUBMITTED']);

function step(state: ProjectState, input: EventInput): boolean {
  const e = { ...input, v: 1, seq: state.lastSeq + 1, id: 'ev_t', at: '2026-10-02T11:00:00.000Z', sessionId: state.activeSessionId, prevHash: 'x', hash: 'y' } as CwsEvent;
  try { reduce(state, e); return true; } catch { return false; }
}

test('I2: for every event type, AI acceptance == spec table (13 types x ai, rich state)', () => {
  const got = AI_INPUTS.filter((i) => step(baseState(), i)).map((i) => i.type).sort();
  assert.deepEqual(got, [...AI_ALLOWED].sort());
  assert.equal(HUMAN_ONLY_EVENTS.length, 13 - AI_ALLOWED.size);
});

test('I2: AI claims of FACT/USER_STATEMENT are rejected', () => {
  for (const type of ['FACT', 'USER_STATEMENT'] as const) {
    assert.equal(step(baseState(), { type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'q', type, text: 't' } }), false);
  }
});

test('I2: reducer is fail-closed for unknown actor kinds (tool / AI-uppercase / empty) on human-only events', () => {
  const leaks: string[] = [];
  for (const kind of ['tool', 'AI', 'ai ', 'system', '', 'Human']) {
    for (const input of AI_INPUTS.filter((i) => HUMAN_ONLY_EVENTS.includes(i.type) && i.type !== 'PROJECT_CREATED')) {
      const forgedActor = { kind } as unknown as EventInput['actor'];
      if (step(baseState(), { ...input, actor: forgedActor } as EventInput)) leaks.push(`${kind}:${input.type}`);
    }
  }
  assert.deepEqual(leaks, [], `${leaks.length} human-only events accepted from a non-human, non-'ai' actor`);
});

test('I2: an unknown actor kind cannot add a FACT claim', () => {
  const actor = { kind: 'tool' } as unknown as EventInput['actor'];
  assert.equal(step(baseState(), { type: 'CLAIM_ADDED', actor, payload: { claimId: 'q', type: 'FACT', text: 't' } }), false);
});

test('I2: a status change accepted from an AI proposal must not mark an unconfirmed AI claim confirmed (confirm is a separate human act)', () => {
  const log = forge([
    created(), claim('c', 'ASSUMPTION', AI),
    { input: { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'pp', item: { kind: 'status', claimId: 'c', status: 'TESTING' } } } },
    { input: { type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: 'pp', resultId: 'r' } } },
  ]);
  const c = fold(log)!.claims[0]!;
  assert.equal(c.confirmed, false, 'status change silently confirmed an AI-authored claim (no CLAIM_CONFIRMED event)');
});

test('tier-A census (informational)', (t) => {
  const v = violations();
  t.diagnostic(`CENSUS checked=${v.checked} extra=${v.extra.length} missing=${v.missing.length}`);
  t.diagnostic(`EXTRA ${JSON.stringify(v.extra.map((e) => e.join(':')))}`);
});
