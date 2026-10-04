/**
 * Ingest: findings without a location, limits, fingerprints that keep distinct findings apart,
 * regressions of fixed findings, and what counts as an already-recorded finding.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findingClaimInputs, findingClaimText, findingsNoteText, isValidLimit, planIngest } from '../src/findings/ingest.ts';
import { parseSarif } from '../src/findings/sarif.ts';
import { findingFingerprint, findingMarkerOf, type Finding } from '../src/findings/types.ts';
import { AI, HUMAN, project, run, step } from './helpers.ts';
import type { EventInput, ProjectState } from '../src/domain/types.ts';

const finding = (over: Partial<Finding> = {}): Finding => ({ tool: 'review', message: 'first issue', severity: 'high', path: 'src/api.ts', ...over });
const sarif = (results: unknown[]): unknown => ({ version: '2.1.0', runs: [{ tool: { driver: { name: 'semgrep' } }, results }] });
const TOOL = { kind: 'ai' as const, agent: 'review', role: 'tool' };

function recorded(findings: Finding[], actor: EventInput['actor'] = TOOL): ProjectState {
  return run(
    [
      { type: 'NOTE_ADDED', actor, payload: { noteId: 'n_run', text: findingsNoteText('review', findings.length, 'stdin') } },
      ...findingClaimInputs(findings, 'n_run', actor),
    ],
    project(),
  );
}

describe('SARIF results without a location (F-19)', () => {
  it('are recorded with an empty path instead of being dropped', () => {
    const found = parseSarif(sarif([{ ruleId: 'r1', level: 'error', message: { text: 'no place given' } }]));
    assert.equal(found.length, 1);
    assert.equal(found[0]?.path, '');
    assert.equal(found[0]?.severity, 'high');
    const plan = planIngest({ claims: [], notes: [] }, found);
    assert.equal(plan.fresh.length, 1);
  });

  it('two location-less results with different messages stay two findings', () => {
    const found = parseSarif(
      sarif([
        { ruleId: 'r1', level: 'error', message: { text: 'first problem' } },
        { ruleId: 'r1', level: 'error', message: { text: 'second problem' } },
      ]),
    );
    assert.equal(planIngest({ claims: [], notes: [] }, found).fresh.length, 2);
  });

  it('keeps the column and drops nonsense line numbers', () => {
    const region = (r: Record<string, unknown>) => [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: r } }];
    const [ok, bad] = parseSarif(
      sarif([
        { ruleId: 'r', message: { text: 'm' }, locations: region({ startLine: 4, startColumn: 9, endLine: 6 }) },
        { ruleId: 'r', message: { text: 'm' }, locations: region({ startLine: -3, startColumn: 9, endLine: 2 }) },
      ]),
    ) as [Finding, Finding];
    assert.deepEqual([ok.startLine, ok.startColumn, ok.endLine], [4, 9, 6]);
    assert.deepEqual([bad.startLine, bad.startColumn, bad.endLine], [undefined, undefined, undefined]);
  });
});

describe('limits', () => {
  it('accepts only whole numbers of at least 1', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) assert.equal(isValidLimit(bad), false, String(bad));
    assert.equal(isValidLimit(1), true);
    assert.equal(isValidLimit(50), true);
  });

  it('planIngest with an invalid limit records nothing and reports everything as over the limit', () => {
    const many = ['a', 'b', 'c'].map((ruleId) => finding({ ruleId }));
    for (const limit of [0, -1, Number.NaN, 2.5]) {
      const plan = planIngest({ claims: [], notes: [] }, many, { limit });
      assert.equal(plan.fresh.length, 0, String(limit));
      assert.equal(plan.overLimit, 3, String(limit));
    }
  });

  it('parseSarif with limit 0 returns nothing', () => {
    assert.equal(parseSarif(sarif([{ message: { text: 'x' } }]), { limit: 0 }).length, 0);
  });
});

describe('fingerprints', () => {
  it('differ by message, column and end line, and are 128 bits', () => {
    const base = finding({ ruleId: 'r', startLine: 3 });
    const prints = new Set([
      findingFingerprint(base),
      findingFingerprint({ ...base, message: 'something else entirely' }),
      findingFingerprint({ ...base, startColumn: 5 }),
      findingFingerprint({ ...base, endLine: 9 }),
    ]);
    assert.equal(prints.size, 4);
    assert.equal(findingFingerprint(base).length, 32);
  });

  it('survive rewording noise: case, spacing and numbers', () => {
    const a = finding({ message: 'Line 12:  Password compared with ==' });
    const b = finding({ message: 'line 99: password   compared with ==' });
    assert.equal(findingFingerprint(a), findingFingerprint(b));
  });

  it('are found again in the claim text', () => {
    const f = finding({ ruleId: 'r' });
    assert.equal(findingMarkerOf(findingClaimText(f)), findingFingerprint(f));
  });
});

describe('what counts as already recorded', () => {
  const f = finding({ ruleId: 'r1', startLine: 3 });
  const claimId = (s: ProjectState): string => s.claims[0]?.id ?? '';

  it('a fixed (RETIRED) finding that regresses is recorded again', () => {
    const state = recorded([f]);
    const retired = step(state, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: claimId(state), status: 'RETIRED' } });
    assert.equal(planIngest(retired, [f]).fresh.length, 1);
  });

  it('a FALSIFIED (false positive) finding stays known', () => {
    const state = recorded([f]);
    const falsified = step(state, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: claimId(state), status: 'FALSIFIED', evidence: 'checked by hand' } });
    assert.equal(planIngest(falsified, [f]).duplicates.length, 1);
  });

  it('a still-open finding is a duplicate', () => {
    assert.equal(planIngest(recorded([f]), [f]).duplicates.length, 1);
  });

  it('a human-written claim carrying the marker does not hide the finding', () => {
    const state = recorded([f], HUMAN);
    assert.equal(planIngest(state, [f]).fresh.length, 1);
  });

  it('an AI claim hung on a human note does not hide the finding', () => {
    const state = run(
      [
        { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n_h', text: findingsNoteText('review', 1, 'stdin') } },
        { type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'c_x', type: 'HYPOTHESIS', text: findingClaimText(f), derivedFrom: ['n_h'] } },
      ],
      project(),
    );
    assert.equal(planIngest(state, [f]).fresh.length, 1);
  });
});

describe('claim text', () => {
  it('keeps the message after a rule id that looks like a credential key (R-10)', () => {
    const text = findingClaimText(finding({ ruleId: 'hardcoded-password', message: 'Hardcoded credentials found' }));
    assert.match(text, /hardcoded-password: Hardcoded credentials found/);
  });

  it('redacts a secret inside the message', () => {
    const token = ['gh', 'p_', 'a1B2c3D4e5'.repeat(4).slice(0, 36)].join('');
    assert.equal(findingClaimText(finding({ message: `leaked ${token} here` })).includes(token), false);
  });
});
