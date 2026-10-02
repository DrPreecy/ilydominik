import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assess, phaseWarnings } from '../src/guidance/warnings.ts';
import { nextSteps } from '../src/guidance/next-steps.ts';
import { buildContext } from '../src/guidance/context-pack.ts';
import { renderPrompt, loadPromptTemplate } from '../src/guidance/render.ts';
import { PHASES, PURPOSES, type Phase, type ProjectState } from '../src/domain/types.ts';
import { AI, HUMAN, project, run, step } from './helpers.ts';

const codes = (s: ProjectState, to?: Phase) => (to ? phaseWarnings(s, to) : assess(s)).map((w) => w.code);

function withRiskyAssumption(status: 'OPEN' | 'TESTING' | 'FALSIFIED' | 'SUPPORTED' = 'OPEN', risk: 'HIGH' | 'FATAL' | 'LOW' = 'FATAL') {
  let s = run([{ type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'a1', type: 'ASSUMPTION', text: 'API has no rate limits', risk } }], project());
  if (status !== 'OPEN') s = step(s, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: 'a1', status, evidence: 'e' } });
  return s;
}

describe('warnings (§24: warn, never block)', () => {
  it('a fresh project has no warnings', () => {
    assert.deepEqual(assess(project()), []);
  });

  it('untested HIGH/FATAL assumptions warn, also while TESTING (v1 bypass #3)', () => {
    assert.ok(codes(withRiskyAssumption('OPEN')).includes('UNTESTED_RISK'));
    assert.ok(codes(withRiskyAssumption('TESTING')).includes('UNTESTED_RISK'));
    assert.ok(!codes(withRiskyAssumption('OPEN', 'LOW')).includes('UNTESTED_RISK'));
    assert.ok(!codes(withRiskyAssumption('SUPPORTED')).includes('UNTESTED_RISK'));
  });

  it('a FALSIFIED risky premise is a serious warning that lists what depends on it (v1 bypass #4)', () => {
    let s = withRiskyAssumption('FALSIFIED');
    s = step(s, { type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'h1', type: 'HYPOTHESIS', text: 'h', derivedFrom: ['a1'] } });
    s = step(s, { type: 'DECISION_RECORDED', actor: HUMAN, payload: { decisionId: 'd1', title: 't', options: [], selected: 'x', rationale: 'r', links: ['a1'] } });
    const w = assess(s).find((x) => x.code === 'FALSIFIED_PREMISE');
    assert.ok(w);
    assert.equal(w.severity, 'serious');
    assert.deepEqual(new Set(w.refs), new Set(['a1', 'h1', 'd1']));
  });

  it('warnings are sorted serious → caution → info', () => {
    let s = withRiskyAssumption('FALSIFIED');
    s = step(s, { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'a2', type: 'ASSUMPTION', text: 'b', risk: 'HIGH' } });
    s = step(s, { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'p1', item: { kind: 'claim', type: 'FACT', text: 'f' } } });
    const order = { serious: 0, caution: 1, info: 2 };
    const sev = assess(s).map((w) => order[w.severity]);
    assert.deepEqual(sev, [...sev].sort((a, b) => a - b));
  });

  it('flags open critical unknowns, evidence-free support, pending proposals, unconfirmed AI claims', () => {
    let s = project();
    s = step(s, { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'u1', type: 'UNKNOWN', text: 'who pays?', risk: 'HIGH' } });
    s = step(s, { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'a1', type: 'ASSUMPTION', text: 'x' } });
    s = step(s, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: 'a1', status: 'SUPPORTED' } });
    s = step(s, { type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'i1', type: 'INTERPRETATION', text: 'y' } });
    s = step(s, { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'p1', item: { kind: 'claim', type: 'FACT', text: 'f' } } });
    const c = codes(s);
    for (const code of ['OPEN_CRITICAL_UNKNOWN', 'SUPPORTED_WITHOUT_EVIDENCE', 'PENDING_PROPOSALS', 'UNCONFIRMED_AI_CLAIMS']) {
      assert.ok(c.includes(code), code);
    }
  });

  it('a proceed-under-uncertainty decision is monitored until its linked claims are resolved', () => {
    let s = withRiskyAssumption('OPEN');
    s = step(s, {
      type: 'DECISION_RECORDED',
      actor: HUMAN,
      payload: { decisionId: 'o1', title: 'Proceed', options: [], selected: 'continue', rationale: 'deadline', links: ['a1'], kind: 'PROCEED_UNDER_UNCERTAINTY' },
    });
    const w = assess(s).find((x) => x.code === 'OVERRIDE_UNRESOLVED');
    assert.ok(w);
    assert.deepEqual(w.refs, ['o1', 'a1']);
    s = step(s, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: 'a1', status: 'SUPPORTED', evidence: 'tested' } });
    assert.ok(!codes(s).includes('OVERRIDE_UNRESOLVED'));
  });

  it('phaseWarnings: moving into IMPLEMENTATION with untested risk is serious; skipping phases is flagged; moving back is never warned', () => {
    const s = withRiskyAssumption('OPEN');
    const w = phaseWarnings(s, 'IMPLEMENTATION');
    assert.equal(w.find((x) => x.code === 'UNTESTED_RISK')?.severity, 'serious');
    const skip = w.find((x) => x.code === 'PHASE_SKIP');
    assert.ok(skip);
    assert.match(skip.message, /UNDERSTANDING/);
    assert.deepEqual(phaseWarnings(s, 'UNDERSTANDING').map((x) => x.code).includes('PHASE_SKIP'), false);
    const later = step(s, { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: 'PLANNING', reason: 'r' } });
    assert.deepEqual(phaseWarnings(later, 'UNDERSTANDING'), []);
  });

  it('warnings never throw and never change state', () => {
    const s = withRiskyAssumption('FALSIFIED');
    const before = JSON.stringify(s);
    for (const p of PHASES) phaseWarnings(s, p);
    assess(s);
    assert.equal(JSON.stringify(s), before);
  });
});

describe('next steps (§23: guidance, not instruction)', () => {
  const phaseDefault: Record<Phase, string> = {
    EXPLORATION: 'explore',
    UNDERSTANDING: 'understand',
    SYNTHESIS: 'synthesize',
    PROOF: 'proof',
    CONCEPT: 'concept',
    PLANNING: 'plan',
    IMPLEMENTATION: 'implement',
    LAUNCH: 'launch',
    POST_LAUNCH: 'learn',
  };

  it('every phase yields at least one step, including its phase default (v1 gave 0 for 3 phases)', () => {
    for (const p of PHASES) {
      const s = p === 'EXPLORATION' ? project() : step(project(), { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: p, reason: 'r' } });
      const steps = nextSteps(s);
      assert.ok(steps.length >= 1 && steps.length <= 3, p);
      assert.ok(steps.some((x) => x.purpose === phaseDefault[p]), `${p} → ${phaseDefault[p]}`);
    }
  });

  it('empty project → explore first', () => {
    assert.equal(nextSteps(project())[0]!.purpose, 'explore');
  });

  it('a falsified premise outranks everything', () => {
    let s = withRiskyAssumption('FALSIFIED');
    s = step(s, { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'p1', item: { kind: 'claim', type: 'FACT', text: 'f' } } });
    const first = nextSteps(s)[0]!;
    assert.equal(first.ruleId, 'falsified-premise');
    assert.ok(first.refs.includes('a1'));
  });

  it('pending proposals → review comes before phase work', () => {
    const s = step(project(), { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'p1', item: { kind: 'claim', type: 'FACT', text: 'f' } } });
    assert.equal(nextSteps(s)[0]!.purpose, 'review');
  });

  it('surfaces ALL risky untested assumptions, not just the first (v1 #10)', () => {
    let s = withRiskyAssumption('OPEN');
    s = step(s, { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'a2', type: 'HYPOTHESIS', text: 'b', risk: 'HIGH' } });
    const proof = nextSteps(s).find((x) => x.purpose === 'proof');
    assert.ok(proof);
    assert.deepEqual(new Set(proof.refs), new Set(['a1', 'a2']));
  });

  it('unprocessed notes suggest understanding them', () => {
    const s = step(project(), { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'idea' } });
    const u = nextSteps(s).find((x) => x.purpose === 'understand');
    assert.ok(u);
    assert.deepEqual(u.refs, ['n1']);
  });

  it('during EXPLORATION, dumping more stays the top suggestion; structuring notes ranks below it (§12)', () => {
    let s = step(project(), { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'idea' } });
    assert.equal(nextSteps(s)[0]!.purpose, 'explore');
    s = step(s, { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: 'UNDERSTANDING', reason: 'done dumping' } });
    assert.equal(nextSteps(s)[0]!.ruleId, 'unprocessed-notes');
  });

  it('the single top step equals option 1 of the full list (status and `cws prompt 1` must agree)', () => {
    const s = step(project(), { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'p1', item: { kind: 'claim', type: 'FACT', text: 'f' } } });
    assert.deepEqual(nextSteps(s, 1)[0], nextSteps(s, 3)[0]);
    assert.equal(nextSteps(s, 1)[0]!.purpose, 'review');
  });

  it('steps are sorted by priority and unique by ruleId; limit respected', () => {
    let s = withRiskyAssumption('OPEN');
    s = step(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'idea' } });
    s = step(s, { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'p1', item: { kind: 'claim', type: 'FACT', text: 'f' } } });
    const all = nextSteps(s, 10);
    assert.deepEqual(all.map((x) => x.priority), [...all.map((x) => x.priority)].sort((a, b) => b - a));
    assert.equal(new Set(all.map((x) => x.ruleId)).size, all.length);
    assert.equal(nextSteps(s, 2).length, 2);
  });
});

describe('context pack (no manual context assembly)', () => {
  function rich(): ProjectState {
    let s = project();
    s = step(s, { type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: 's1', goal: 'clarify pricing' } });
    s = step(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'RAW NOTE TEXT' } });
    s = step(s, { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'us1', type: 'USER_STATEMENT', text: 'I want it simple' } });
    s = step(s, { type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'in1', type: 'INTERPRETATION', text: 'AI GUESS', derivedFrom: ['n1'] } });
    s = step(s, { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'a1', type: 'ASSUMPTION', text: 'people pay 10 EUR', risk: 'FATAL' } });
    s = step(s, { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'u1', type: 'UNKNOWN', text: 'which segment?' } });
    s = step(s, { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'old', type: 'ASSUMPTION', text: 'RETIRED ONE' } });
    s = step(s, { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: 'old', status: 'RETIRED' } });
    s = step(s, { type: 'DECISION_RECORDED', actor: HUMAN, payload: { decisionId: 'd1', title: 'Platform', options: ['web', 'app'], selected: 'web', rationale: 'reach' } });
    s = step(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n2', text: 'SECOND NOTE' } });
    return s;
  }

  const section = (md: string, heading: string) => {
    const start = md.indexOf(heading);
    if (start < 0) return '';
    const next = md.indexOf('\n## ', start + heading.length);
    return md.slice(start, next < 0 ? undefined : next);
  };

  it('includes title, phase, session goal and ids', () => {
    const md = buildContext(rich(), 'understand');
    assert.match(md, /Test/);
    assert.match(md, /EXPLORATION/);
    assert.match(md, /clarify pricing/);
    for (const id of ['us1', 'in1', 'a1', 'u1', 'd1']) assert.ok(md.includes(id), id);
  });

  it('keeps epistemic types in separate sections; AI guesses are never listed as user statements or facts', () => {
    const md = buildContext(rich(), 'synthesize');
    assert.ok(section(md, '## What the user said').includes('I want it simple'));
    assert.ok(section(md, '## AI interpretations (unconfirmed)').includes('AI GUESS'));
    assert.ok(!section(md, '## What the user said').includes('AI GUESS'));
    assert.ok(!section(md, '## Facts').includes('AI GUESS'));
    assert.ok(section(md, '## Assumptions & hypotheses').includes('FATAL'));
    assert.ok(section(md, '## Open questions').includes('which segment?'));
    assert.ok(section(md, '## Decisions').includes('web'));
  });

  it('omits retired claims', () => {
    assert.ok(!buildContext(rich(), 'understand').includes('RETIRED ONE'));
  });

  it('lists only unprocessed notes verbatim (notes already used by a claim are skipped)', () => {
    const notes = section(buildContext(rich(), 'understand'), '## Unprocessed notes');
    assert.ok(notes.includes('SECOND NOTE'));
    assert.ok(!notes.includes('RAW NOTE TEXT'));
  });

  it('ends with write-back instructions that force the AI to identify itself', () => {
    const md = buildContext(rich(), 'understand');
    const how = section(md, '## How to record your results');
    assert.ok(how.includes('cws claim add --agent'));
    assert.ok(how.includes('cws propose --agent'));
    assert.match(how, /never/i);
  });

  it('focus refs are rendered first', () => {
    const md = buildContext(rich(), 'proof', { focusRefs: ['a1'] });
    assert.ok(section(md, '## Focus').includes('people pay 10 EUR'));
  });
});

describe('prompt templates', () => {
  it('a template exists for every purpose, with a description and domain-neutral body', async () => {
    for (const p of PURPOSES) {
      const t = await loadPromptTemplate(p);
      assert.ok(t.description.length > 10, p);
      assert.ok(t.body.length > 200, p);
      assert.doesNotMatch(t.body, /^---/);
    }
  });

  it('renderPrompt = template + context pack', async () => {
    const s = withRiskyAssumption('OPEN');
    const out = await renderPrompt(s, 'proof', ['a1']);
    assert.ok(out.includes('API has no rate limits'));
    assert.ok(out.includes('## How to record your results'));
    assert.ok(out.includes((await loadPromptTemplate('proof')).body.slice(0, 40)));
  });
});
