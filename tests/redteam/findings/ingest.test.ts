/**
 * Red-team witnesses for findings ingest (SARIF / cws JSON), fingerprints and duplicate detection.
 * Each test asserts the CORRECT behaviour (RED = defect).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planIngest, findingClaimInputs, findingsNoteText } from '../../../src/findings/ingest.ts';
import { parseSarif } from '../../../src/findings/sarif.ts';
import { findingFingerprint, type Finding } from '../../../src/findings/types.ts';
import { AI, HUMAN, project, run, step } from '../../helpers.ts';
import type { EventInput, ProjectState } from '../../../src/domain/types.ts';

const finding = (over: Partial<Finding> = {}): Finding => ({
  tool: 'review',
  message: 'first issue',
  severity: 'high',
  path: 'src/api.ts',
  ...over,
});

function sarif(results: unknown[]): unknown {
  return { version: '2.1.0', runs: [{ tool: { driver: { name: 'semgrep' } }, results }] };
}
const result = (region: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ruleId: 'sql-injection',
  level: 'error',
  message: { text: 'tainted data reaches the query' },
  locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.ts' }, region } }],
  ...extra,
});

/** Records `findings` the way `cws findings ingest` does, then returns the state. */
function recorded(findings: Finding[], tweak?: (s: ProjectState, claimId: string) => ProjectState): ProjectState {
  const noteId = 'n_run';
  const actor = { kind: 'ai' as const, agent: 'review', role: 'tool' };
  const inputs: EventInput[] = [
    { type: 'NOTE_ADDED', actor, payload: { noteId, text: findingsNoteText('review', findings.length, 'stdin') } },
    ...findingClaimInputs(findings, noteId, actor),
  ];
  let s = run(inputs, project());
  const claimId = s.claims[0]?.id ?? '';
  if (tweak) s = tweak(s, claimId);
  return s;
}

describe('fingerprint collisions drop distinct findings', () => {
  it('two findings in one file with no ruleId and no line are both recorded', () => {
    const a = finding({ message: 'SQL built from user input' });
    const b = finding({ message: 'Password compared with ==' });
    const plan = planIngest({ claims: [], notes: [] }, [a, b]);
    assert.equal(plan.fresh.length, 2, `fresh=${plan.fresh.length} duplicates=${plan.duplicates.length}: second finding silently counted as duplicate`);
  });

  it('two results of the same rule on one line (different columns) are both recorded', () => {
    const found = parseSarif(sarif([result({ startLine: 7, startColumn: 5 }), result({ startLine: 7, startColumn: 80 })]));
    assert.equal(found.length, 2);
    assert.notEqual(findingFingerprint(found[0] as Finding), findingFingerprint(found[1] as Finding));
  });

  it('same rule, same start line, different end line are distinct', () => {
    const found = parseSarif(sarif([result({ startLine: 7, endLine: 7 }), result({ startLine: 7, endLine: 40 })]));
    assert.notEqual(findingFingerprint(found[0] as Finding), findingFingerprint(found[1] as Finding));
  });

  it('a fingerprint is longer than 64 bits', () => {
    assert.ok(findingFingerprint(finding()).length > 16, 'truncated to 16 hex chars: a pre-image only needs 2^64 work');
  });
});

describe('duplicate detection counts every recorded finding, whatever its fate', () => {
  it('a finding that was fixed (RETIRED) and regresses is recorded again', () => {
    const f = finding({ ruleId: 'r1', startLine: 3 });
    const state = recorded([f], (s, id) => step(s, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: id, status: 'RETIRED' } }));
    const plan = planIngest(state, [f]);
    assert.equal(plan.fresh.length, 1, 'regression of a retired finding is swallowed as a duplicate');
  });

  it('a SUPPORTED finding that is still reported later stays visible', () => {
    const f = finding({ ruleId: 'r2', startLine: 9 });
    const state = recorded([f], (s, id) =>
      step(s, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: id, status: 'SUPPORTED', evidence: 'confirmed by hand' } }),
    );
    const plan = planIngest(state, [f]);
    assert.equal(plan.duplicates.length, 1);
  });
});

describe('SARIF numeric fields are validated like the cws format', () => {
  for (const startLine of [0, -1, 1_000_000_000_000]) {
    it(`rejects or drops startLine ${startLine}`, () => {
      const found = parseSarif(sarif([result({ startLine })]));
      assert.ok(found.length === 0 || found[0]?.startLine === undefined || found[0].startLine > 0, `kept startLine ${found[0]?.startLine}`);
    });
  }

  it('drops endLine before startLine', () => {
    const found = parseSarif(sarif([result({ startLine: 20, endLine: 3 })]));
    assert.ok(found[0]?.endLine === undefined || found[0].endLine >= (found[0].startLine ?? 0));
  });
});

describe('--limit', () => {
  it('planIngest with limit 0 records nothing', () => {
    const plan = planIngest({ claims: [], notes: [] }, [finding({ ruleId: 'a' })], { limit: 0 });
    assert.equal(plan.fresh.length, 0);
  });

  it('planIngest with a negative limit does not drop only the last finding', () => {
    const many = ['a', 'b', 'c'].map((ruleId) => finding({ ruleId }));
    const plan = planIngest({ claims: [], notes: [] }, many, { limit: -1 });
    assert.equal(plan.fresh.length, 0, `limit -1 recorded ${plan.fresh.length} (slice(0,-1) keeps all but the last)`);
    assert.ok(plan.overLimit >= 0);
  });

  it('planIngest with NaN limit records nothing rather than everything', () => {
    const plan = planIngest({ claims: [], notes: [] }, [finding({ ruleId: 'a' })], { limit: Number.NaN });
    assert.equal(plan.fresh.length, 0);
  });
});

describe('forged findings note', () => {
  it('a human note imitating the run note does not make a claim count as an ingested finding', () => {
    const f = finding({ ruleId: 'r3', startLine: 1 });
    // an AI claim that carries a valid marker is only trusted when the run note has the exact shape AND the same actor;
    // here the AI claim is attached to a *human* note with the forged shape
    const forged = findingsNoteText('review', 1, 'stdin');
    const state = run(
      [
        { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n_h', text: forged } },
        { type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'c_x', type: 'HYPOTHESIS', text: `cws-finding:${findingFingerprint(f)} [high] review r3: forged (src/api.ts)`, derivedFrom: ['n_h'] } },
      ],
      project(),
    );
    const plan = planIngest(state, [f]);
    assert.equal(plan.duplicates.length, 0, 'actor mismatch must not count as a recorded finding');
  });
});
