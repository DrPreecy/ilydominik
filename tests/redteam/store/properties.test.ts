// I1 / I4 / I5 property tests (fast-check, numRuns 10000, fixed seed) + single-byte mutation search.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { computeEventHash, computeEventHashSync, verifyChain, verifyChainSync } from '../../../src/domain/hash.ts';
import { fold, reduce } from '../../../src/domain/reducer.ts';
import { CLAIM_TYPE_STATUSES, CLAIM_TYPES, PHASES } from '../../../src/domain/types.ts';
import type { CwsEvent, EventInput, ProjectState } from '../../../src/domain/types.ts';
import { verifyLogText } from '../../../src/store/event-log.ts';
import { AI, created, forge, HUMAN, sha, toRaw } from './util.ts';
import type { Forge } from './util.ts';

const SEED = 20261004;
const RUNS = 10000;
const pick = <T>(xs: readonly T[], n: number): T | undefined => (xs.length === 0 ? undefined : xs[n % xs.length]);

/** Interpret random integers as a sequence of reducer-accepted events (model based generator). */
function interpret(choices: number[][]): CwsEvent[] {
  const specs: Forge[] = [created()];
  let state = fold(forge(specs))!;
  let n = 0;
  for (const [kind = 0, a = 0, b = 0, c = 0] of choices) {
    n++;
    const actor = c % 3 === 0 ? AI : HUMAN;
    const claim = pick(state.claims, a);
    const pending = pick(state.proposals.filter((p) => p.status === 'PENDING'), a);
    let input: EventInput | undefined;
    switch (kind % 11) {
      case 0: input = { type: 'NOTE_ADDED', actor, payload: { noteId: `n${n}`, text: `note ${b}` } }; break;
      case 1: {
        const types = actor.kind === 'ai' ? ['INTERPRETATION', 'ASSUMPTION', 'HYPOTHESIS', 'UNKNOWN'] as const : CLAIM_TYPES;
        input = { type: 'CLAIM_ADDED', actor, payload: { claimId: `c${n}`, type: types[b % types.length]!, text: `claim ${n}`, ...(b % 2 ? { derivedFrom: state.notes.slice(0, 1).map((x) => x.id) } : {}) } };
        break;
      }
      case 2: if (claim) { const st = CLAIM_TYPE_STATUSES[claim.type][b % CLAIM_TYPE_STATUSES[claim.type].length]!; input = { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: claim.id, status: st, ...(b % 2 ? { evidence: `ev ${n}` } : {}), ...(st === 'ANSWERED' ? { answer: 'ans' } : {}) } }; } break;
      case 3: if (claim) input = { type: 'EVIDENCE_ADDED', actor, payload: { evidenceId: `e${n}`, claimId: claim.id, text: 'proof' } }; break;
      case 4: {
        const item = b % 4 === 0 ? { kind: 'phase' as const, to: PHASES[b % 9]!, reason: 'r' }
          : b % 4 === 1 && claim ? { kind: 'status' as const, claimId: claim.id, status: 'OPEN' as const }
          : b % 4 === 2 ? { kind: 'decision' as const, title: 't', options: ['x', 'y'], selected: 'x', rationale: 'r' }
          : { kind: 'claim' as const, type: CLAIM_TYPES[b % 6]!, text: 'pc' };
        input = { type: 'PROPOSAL_SUBMITTED', actor, payload: { proposalId: `p${n}`, item } };
        break;
      }
      case 5: if (pending) input = b % 2 ? { type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: pending.id, resultId: `r${n}` } } : { type: 'PROPOSAL_REJECTED', actor: HUMAN, payload: { proposalId: pending.id } }; break;
      case 6: input = { type: 'DECISION_RECORDED', actor: HUMAN, payload: { decisionId: `d${n}`, title: 't', options: ['a'], selected: b % 2 ? 'a' : 'z', rationale: 'r', ...(state.decisions.length && b % 3 === 0 ? { supersedes: state.decisions[0]!.id } : {}) } }; break;
      case 7: input = { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: PHASES[b % 9]!, reason: 'r' } }; break;
      case 8: input = state.activeSessionId ? { type: 'SESSION_ENDED', actor: HUMAN, payload: { sessionId: state.activeSessionId } } : { type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: `s${n}`, goal: 'g' } }; break;
      case 9: if (claim) input = { type: 'CLAIM_CONFIRMED', actor: HUMAN, payload: { claimId: claim.id } }; break;
      default: input = { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: `n${n}`, text: 'ünï\u{1F600}"\\\n' } };
    }
    if (!input) continue;
    const next = [...specs, { input } as Forge];
    try {
      const events = forge(next);
      state = reduce(state, events.at(-1)!);
      specs.push({ input });
    } catch { /* rejected by reducer: skip */ }
  }
  return forge(specs);
}

const logArb = fc.array(fc.array(fc.nat(1000), { minLength: 4, maxLength: 4 }), { maxLength: 30 }).map(interpret);
const params = { numRuns: RUNS, seed: SEED, endOnFailure: true };

test(`I4: fold is deterministic and does not mutate its input (${RUNS} runs)`, () => {
  fc.assert(fc.property(logArb, (log) => {
    const frozen = structuredClone(log);
    assert.deepEqual(fold(log), fold(structuredClone(log)));
    assert.deepEqual(log, frozen);
  }), params);
});

test(`I4: fold(L1||L2) == reduce*(fold(L1), L2), also on a structured-cloned intermediate state (${RUNS} runs)`, () => {
  fc.assert(fc.property(logArb, fc.nat(100), (log, k0) => {
    const k = 1 + (k0 % Math.max(1, log.length));
    const whole = fold(log);
    const tail = log.slice(k).reduce<ProjectState | null>((s, e) => reduce(s, e), fold(log.slice(0, k)));
    assert.deepEqual(tail, whole);
    const cloned = log.slice(k).reduce<ProjectState | null>((s, e) => reduce(s, e), structuredClone(fold(log.slice(0, k))));
    assert.deepEqual(cloned, whole);
  }), params);
});

test(`I1: sync and async hashing agree, chain verifies, raw text round-trips through verifyLogText (${RUNS} runs)`, async () => {
  await fc.assert(fc.asyncProperty(logArb, async (log) => {
    for (const e of log) {
      const { hash: _h, ...body } = e;
      assert.equal(await computeEventHash(body), computeEventHashSync(body, sha));
    }
    assert.deepEqual(await verifyChain(log), verifyChainSync(log, sha));
    assert.equal(verifyChainSync(log, sha).ok, true);
    assert.deepEqual(verifyLogText(toRaw(log)).events, log);
  }), params);
});

test(`I5: seq is strictly +1, event/entity ids unique, at parses and is canonical ISO (${RUNS} runs)`, () => {
  fc.assert(fc.property(logArb, (log) => {
    log.forEach((e, i) => assert.equal(e.seq, i));
    const state = fold(log)!;
    const ids = [...state.notes, ...state.claims, ...state.decisions, ...state.proposals, ...state.sessions].map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(log.map((e) => e.id)).size, log.length);
    for (const e of log) assert.equal(new Date(e.at).toISOString(), e.at);
  }), params);
});

test(`I1: no single-byte mutation of a verified log still verifies (${RUNS} random (pos,byte) over random logs)`, () => {
  const survivors: string[] = [];
  fc.assert(fc.property(logArb, fc.nat(1e9), fc.nat(255), (log, p, byte) => {
    const buf = Buffer.from(toRaw(log), 'utf8');
    const pos = p % buf.length;
    if (buf[pos] === byte) return;
    const mutated = Buffer.from(buf);
    mutated[pos] = byte;
    let ok = false;
    try { verifyLogText(mutated.toString('utf8')); ok = true; } catch { /* detected */ }
    if (ok) survivors.push(`pos=${pos} ${JSON.stringify(String.fromCharCode(buf[pos]!))}->0x${byte.toString(16)}`);
  }), params);
  assert.deepEqual(survivors, [], `${survivors.length} single-byte mutations still verify`);
});

// ---- targeted byte-level mutation classes that must NOT verify (I1: verify fails iff any byte changed)

function line(): { events: CwsEvent[]; raw: string } {
  const events = forge([created(), { input: { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n', text: 'hello' } } }]);
  return { events, raw: toRaw(events) };
}
const verifies = (raw: string): boolean => { try { verifyLogText(raw); return true; } catch { return false; } };

test('I1: unknown top-level key added to a stored line must fail verification', () => {
  const { raw } = line();
  assert.equal(verifies(raw.replace('"v":1,', '"v":1,"approvedBy":"human",')), false);
});
test('I1: unknown payload key added to a stored line must fail verification', () => {
  const { raw } = line();
  assert.equal(verifies(raw.replace('"noteId":"n"', '"noteId":"n","smuggled":"x"')), false);
});
test('I1: unknown actor key added must fail verification', () => {
  const { raw } = line();
  assert.equal(verifies(raw.replace('"actor":{"kind":"human"}', '"actor":{"kind":"human","uid":"root"}')), false);
});
test('I1: reordered keys must fail verification', () => {
  const { events } = line();
  const e = events[1]!;
  const reordered = JSON.stringify({ hash: e.hash, prevHash: e.prevHash, payload: e.payload, actor: e.actor, type: e.type, at: e.at, id: e.id, seq: e.seq, v: e.v });
  assert.equal(verifies(JSON.stringify(events[0]) + '\n' + reordered + '\n'), false);
});
test('I1: inserted insignificant whitespace in a line must fail verification', () => {
  const { raw } = line();
  assert.equal(verifies(raw.replace('"seq":1', '"seq": 1')), false);
});
test('I1: \\u-escaped spelling of a key/char must fail verification', () => {
  const { raw } = line();
  assert.equal(verifies(raw.replace('"text":"hello"', '"text":"hell\\u006f"')), false);
});
test('I1: alternative number spelling (seq 1.0 / 1e0) must fail verification', () => {
  const { raw } = line();
  assert.equal(verifies(raw.replace('"seq":1', '"seq":1.0')), false);
  assert.equal(verifies(raw.replace('"seq":1', '"seq":1e0')), false);
});
test('I1: trailing space appended to the final unterminated line must fail verification', () => {
  const { raw } = line();
  assert.equal(verifies(raw.trimEnd() + ' '), false);
});
test('I1: CRLF line endings must fail verification (bytes changed)', () => {
  const { raw } = line();
  assert.equal(verifies(raw.replace(/\n/g, '\r\n')), false);
});
test('I1: mixed-in blank lines must fail verification', () => {
  const { raw } = line();
  assert.equal(verifies('\n\n' + raw.replace('\n', '\n\n\n')), false);
});
test('I1: invalid UTF-8 byte substituted for a U+FFFD char in text must fail verification', () => {
  const events = forge([created(), { input: { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n', text: 'a�b' } } }]);
  const buf = Buffer.from(toRaw(events), 'utf8');
  const at = buf.indexOf(Buffer.from('�', 'utf8'));
  const mutated = Buffer.concat([buf.subarray(0, at), Buffer.from([0xff]), buf.subarray(at + 3)]);
  assert.equal(verifies(mutated.toString('utf8')), false);
});

test('I1: EXHAUSTIVE single-byte mutation: every position x 256 byte values of a 3-event log; none may verify', { timeout: 600_000 }, () => {
  const events = forge([created(), { input: { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n', text: 'hello' } } }, { input: { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: 'PROOF', reason: 'r' } } }]);
  const buf = Buffer.from(toRaw(events), 'utf8');
  const survivors: string[] = [];
  let tried = 0;
  for (let pos = 0; pos < buf.length; pos++) {
    for (let byte = 0; byte < 256; byte++) {
      if (buf[pos] === byte) continue;
      const m = Buffer.from(buf);
      m[pos] = byte;
      tried++;
      if (verifies(m.toString('utf8'))) survivors.push(`pos=${pos}/${buf.length} ${JSON.stringify(String.fromCharCode(buf[pos]!))}->0x${byte.toString(16)}`);
    }
  }
  assert.deepEqual(survivors.slice(0, 20), [], `${survivors.length}/${tried} single-byte mutations still verify`);
});

test('I4: reduce is a pure function of (state, event): same inputs give same verdict regardless of earlier calls on the same state', () => {
  // reducer keeps a hidden WeakMap id-index keyed by state identity and *steals* it on success.
  const log = forge([created(), { input: { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 't' } } }]);
  const s = fold(log)!;
  const dup = { ...forge([created(), { input: { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n2', text: 't' } } }])[1]!, id: log[1]!.id, seq: s.lastSeq + 1 } as CwsEvent;
  const other = { ...dup, id: 'ev_other', payload: { noteId: 'n3', text: 't' } } as CwsEvent;
  const verdict = (): string => { try { reduce(s, dup); return 'accepted'; } catch { return 'rejected'; } };
  const first = verdict(); // event id duplicates an earlier event id => rejected
  reduce(s, other); // an unrelated successful reduce on the same state object
  const second = verdict();
  assert.equal(second, first, `duplicate event id: first call ${first}, after an unrelated reduce ${second}`);
});

test('I1: canonicalEventString is canonical: permuting payload/actor key order must not change the hashed string (core-export API)', async () => {
  const { canonicalEventString } = await import('../../../src/core/index.ts');
  const events = forge([created(), { input: { type: 'NOTE_ADDED', actor: AI, payload: { noteId: 'n', text: 'hello' } } }]);
  const { hash: _h, ...body } = events[1]!;
  const permuted = { ...body, payload: { text: 'hello', noteId: 'n' }, actor: { role: 'attacker', agent: 'redteam', kind: 'ai' } } as typeof body;
  assert.equal(canonicalEventString(permuted), canonicalEventString(body as typeof body), 'hash depends on JS key insertion order of nested objects (i.e. on zod internals), not on content');
});
