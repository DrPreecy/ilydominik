/** `--json` on the read commands: stable schema, JSON only on stdout, errors stay on stderr (tribunal U-12 / O-14). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT } from '../src/cli/io.ts';
import { human, runHuman, tmpDir, tmpProject, type FakeIO } from './redteam/silent/harness.ts';

function agent(cwd: string, stdin = ''): FakeIO {
  const io = human(cwd, [], stdin);
  io.isInteractive = false;
  return io;
}

async function seeded(): Promise<string> {
  const dir = await tmpProject('Json Project');
  assert.equal(await runHuman(human(dir), ['session', 'start', 'goal']), 0);
  assert.equal(await runHuman(agent(dir), ['claim', 'add', '--agent', 'bot', '--type', 'HYPOTHESIS', '--text', 'ai claim']), 0);
  const body = JSON.stringify([{ item: { kind: 'phase', to: 'UNDERSTANDING', reason: 'go' }, rationale: 'because' }]);
  assert.equal(await runHuman(agent(dir, body), ['propose', '--agent', 'bot', '--json', '-']), 0);
  return dir;
}

async function json(dir: string, args: string[]): Promise<{ code: number; value: any; io: FakeIO }> {
  const io = agent(dir);
  const code = await runHuman(io, args);
  assert.equal(io.err.join(''), '', 'stderr must stay empty on success');
  assert.equal(io.out.length, 1, 'one JSON document on stdout, nothing else');
  return { code, value: JSON.parse(io.out[0]!), io };
}

describe('--json read commands', () => {
  it('status', async () => {
    const dir = await seeded();
    const { code, value } = await json(dir, ['status', '--json']);
    assert.equal(code, EXIT.OK);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.title, 'Json Project');
    assert.equal(value.phase, 'EXPLORATION');
    assert.equal(value.session.goal, 'goal');
    assert.deepEqual(value.counts, { notes: 0, claims: 1, decisions: 0, pendingProposals: 1 });
    assert.deepEqual(value.integrity, { ok: true });
    assert.ok(Array.isArray(value.warnings));
    assert.ok(value.next === null || typeof value.next.title === 'string');
  });

  it('status without a session says null, not a made-up object', async () => {
    const { value } = await json(await tmpProject(), ['status', '--json']);
    assert.equal(value.session, null);
  });

  it('next', async () => {
    const { value } = await json(await seeded(), ['next', '--json']);
    assert.equal(value.schemaVersion, 1);
    assert.ok(value.steps.length > 0);
    assert.deepEqual(Object.keys(value.steps[0]).sort(), ['n', 'purpose', 'reason', 'refs', 'title']);
    assert.equal(value.steps[0].n, 1);
  });

  it('inbox lists proposals and unconfirmed AI claims', async () => {
    const { value } = await json(await seeded(), ['inbox', '--json']);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.proposals.length, 1);
    assert.equal(value.proposals[0].kind, 'phase');
    assert.equal(value.proposals[0].by, 'ai:bot');
    assert.equal(value.proposals[0].rationale, 'because');
    assert.equal(value.unconfirmedClaims.length, 1);
    assert.equal(value.unconfirmedClaims[0].type, 'HYPOTHESIS');
  });

  it('an empty inbox is an empty document, not a sentence', async () => {
    const { value } = await json(await tmpProject(), ['inbox', '--json']);
    assert.deepEqual(value, { schemaVersion: 1, proposals: [], unconfirmedClaims: [] });
  });

  it('log', async () => {
    const { value } = await json(await seeded(), ['log', '--json', '--limit', '2']);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.events.length, 2);
    assert.deepEqual(Object.keys(value.events[0]).sort(), ['actor', 'at', 'id', 'seq', 'summary', 'type']);
  });

  it('findings list', async () => {
    const dir = await seeded();
    const sarif = JSON.stringify([{ tool: 't', ruleId: 'r', severity: 'high', path: 'a.ts', startLine: 3, message: 'bad' }]);
    assert.equal(await runHuman(agent(dir, sarif), ['findings', 'ingest', '--agent', 'bot', '--format', 'cws', '-']), 0);
    const { value } = await json(dir, ['findings', 'list', '--json']);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.findings.length, 1);
    assert.equal(value.findings[0].severity, 'high');
    assert.equal(value.findings[0].path, 'a.ts');
  });

  it('errors stay on stderr with a non-zero exit, stdout stays empty', async () => {
    const dir = await tmpDir();
    const io = agent(dir);
    const code = await runHuman(io, ['status', '--json']);
    assert.notEqual(code, 0);
    assert.deepEqual(io.out, []);
    assert.match(io.err.join(''), /No CWS project/);
  });

  it('text output is unchanged without --json', async () => {
    const io = agent(await seeded());
    await runHuman(io, ['status']);
    assert.match(io.out.join(''), /Json Project {2}\[phase: EXPLORATION\]/);
  });
});
