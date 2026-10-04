/** Round-3 CLI fixes: names people actually type, one-line errors, nothing approved unseen. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describeProposal } from '../src/cli/describe.ts';
import { parsePhase, parsePurpose } from '../src/cli/stages.ts';
import { EventLog } from '../src/store/event-log.ts';
import { all, human, runHuman, tmpDir, tmpProject, type FakeIO } from './redteam/silent/harness.ts';

function agent(cwd: string, stdin = ''): FakeIO {
  const io = human(cwd, [], stdin);
  io.isInteractive = false;
  return io;
}

describe('phase and purpose names', () => {
  it('parsePhase accepts codes, menu names and stage numbers in any case', () => {
    assert.equal(parsePhase('IMPLEMENTATION'), 'IMPLEMENTATION');
    assert.equal(parsePhase('implementation'), 'IMPLEMENTATION');
    assert.equal(parsePhase('Build'), 'IMPLEMENTATION');
    assert.equal(parsePhase('prove'), 'PROOF');
    assert.equal(parsePhase('Learn'), 'POST_LAUNCH');
    assert.equal(parsePhase('post-launch'), 'POST_LAUNCH');
    assert.equal(parsePhase('3'), 'SYNTHESIS');
    assert.equal(parsePhase('0'), undefined);
    assert.equal(parsePhase('10'), undefined);
    assert.equal(parsePhase('nonsense'), undefined);
  });

  it('parsePurpose accepts purposes and stage names in any case', () => {
    assert.equal(parsePurpose('Explore'), 'explore');
    assert.equal(parsePurpose('BUILD'), 'implement');
    assert.equal(parsePurpose('proof'), 'proof');
    assert.equal(parsePurpose('review'), 'review');
    assert.equal(parsePurpose('3'), undefined);
    assert.equal(parsePurpose('bogus'), undefined);
  });

  it('cws phase accepts the names the menu shows', async () => {
    const dir = await tmpProject();
    const io = human(dir, ['K7Q']);
    assert.equal(await runHuman(io, ['phase', 'understand', '--reason', 'r']), 0, all(io));
    assert.equal((await EventLog.open(dir)).state.phase, 'UNDERSTANDING');
  });

  it('cws context takes any letter case and stage names', async () => {
    const dir = await tmpProject();
    for (const name of ['Explore', 'BUILD', 'Proof']) {
      const io = agent(dir);
      assert.equal(await runHuman(io, ['context', name]), 0, all(io));
    }
  });

  it('findings ingest --min-severity is case-insensitive', async () => {
    const dir = await tmpProject();
    const body = JSON.stringify([{ tool: 't', ruleId: 'r', severity: 'high', path: 'a.ts', startLine: 1, message: 'm' }]);
    const io = agent(dir, body);
    assert.equal(await runHuman(io, ['findings', 'ingest', '--agent', 'bot', '--format', 'cws', '--min-severity', 'HIGH', '-']), 0, all(io));
  });
});

describe('what a human approves is what they see', () => {
  it('describeProposal shows every field of a decision proposal, supersedes included', async () => {
    const dir = await tmpProject();
    const state = (await EventLog.open(dir)).state;
    const text = describeProposal({
      id: 'pr_1', actor: { kind: 'ai', agent: 'bot' }, status: 'PENDING', at: '',
      item: { kind: 'decision', title: 'T', options: ['A'], selected: 'A', rationale: 'R', supersedes: 'd_old', decisionKind: 'PROCEED_UNDER_UNCERTAINTY' } as never,
    }, state);
    assert.match(text, /supersedes: d_old/);
    assert.match(text, /decisionKind: PROCEED_UNDER_UNCERTAINTY/);
  });
});

describe('review keys', () => {
  async function withProposal(): Promise<string> {
    const dir = await tmpProject();
    const body = JSON.stringify([{ item: { kind: 'claim', type: 'HYPOTHESIS', text: 'x' } }]);
    assert.equal(await runHuman(agent(dir, body), ['propose', '--agent', 'bot', '--json', '-']), 0);
    return dir;
  }

  it('s is not a way to skip a proposal: it is asked again, and nothing changes', async () => {
    const dir = await withProposal();
    const io = human(dir, ['K7Q', 's', 'q']);
    assert.equal(await runHuman(io, ['review']), 0);
    assert.match(all(io), /"s" is not one of the choices/);
    assert.equal((await EventLog.open(dir)).state.proposals[0]!.status, 'PENDING');
  });

  it('k skips a proposal', async () => {
    const dir = await withProposal();
    const io = human(dir, ['K7Q', 'k']);
    assert.equal(await runHuman(io, ['review']), 0);
    assert.match(all(io), /1 skipped/);
  });

  it('s still means supported on a testable claim', async () => {
    const dir = await tmpProject();
    assert.equal(await runHuman(agent(dir), ['claim', 'add', '--agent', 'bot', '--type', 'HYPOTHESIS', '--text', 'h']), 0);
    const io = human(dir, ['K7Q', 's', 'evidence', 'K7Q']);
    assert.equal(await runHuman(io, ['review']), 0, all(io));
    assert.equal((await EventLog.open(dir)).state.claims[0]!.status, 'SUPPORTED');
  });
});

describe('errors are one plain line', () => {
  it('importing a file that is not there does not leak ENOENT', async () => {
    const dir = await tmpProject();
    const io = human(dir);
    assert.notEqual(await runHuman(io, ['import', 'nope.cws']), 0);
    const text = io.err.join('');
    assert.equal(text.trim().split('\n').length, 1, text);
    assert.doesNotMatch(text, /ENOENT|\[[A-Z_]+\]/);
  });

  it('domain errors drop their internal code', async () => {
    const dir = await tmpProject();
    const io = agent(dir);
    assert.notEqual(await runHuman(io, ['claim', 'add', '--agent', 'bot', '--type', 'FACT', '--text', 'x']), 0);
    assert.doesNotMatch(io.err.join(''), /AI_CLAIM_TYPE_FORBIDDEN/);
  });

  it('propose --json <file> resolves the file against the working directory of the CLI, not the process', async () => {
    const dir = await tmpProject();
    await fs.writeFile(path.join(dir, 'p.json'), JSON.stringify([{ item: { kind: 'claim', type: 'HYPOTHESIS', text: 'from file' } }]));
    const io = agent(dir);
    assert.equal(await runHuman(io, ['propose', '--agent', 'bot', '--json', 'p.json']), 0, all(io));
    assert.equal((await EventLog.open(dir)).state.proposals.length, 1);
  });

  it('propose --json with a missing file is one line without ENOENT', async () => {
    const io = agent(await tmpProject());
    assert.notEqual(await runHuman(io, ['propose', '--agent', 'bot', '--json', 'missing.json']), 0);
    assert.doesNotMatch(io.err.join(''), /ENOENT|stat '/);
  });
});

describe('checks that used to be missing', () => {
  it('evidence add checks the claim exists', async () => {
    const dir = await tmpProject();
    const io = agent(dir);
    assert.notEqual(await runHuman(io, ['evidence', 'add', '--agent', 'bot', '--claim', 'c_nope', '--text', 'e']), 0);
    assert.match(io.err.join(''), /no claim with id c_nope/);
    assert.equal((await EventLog.open(dir)).events.length, 1);
  });

  it('decide refuses a selected option that is not among --options', async () => {
    const dir = await tmpProject();
    const io = human(dir, ['K7Q']);
    assert.notEqual(await runHuman(io, ['decide', '--title', 't', '--options', 'a,b', '--selected', 'c', '--rationale', 'r']), 0);
    assert.equal((await EventLog.open(dir)).state.decisions.length, 0);
  });

  it('dump --role without --agent is refused', async () => {
    const dir = await tmpDir();
    await EventLog.init(dir, 'x');
    const io = human(dir);
    assert.notEqual(await runHuman(io, ['dump', '--role', 'reviewer', 'hi']), 0);
  });
});
