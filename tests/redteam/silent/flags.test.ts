import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventLog } from '../../../src/store/event-log.ts';
import { all, cws, human, localSandboxConfig, runHuman, stubOpenshell, tmpProject } from './harness.ts';

describe('silent: accepted-but-ignored flags', () => {
  it('propose --role is recorded on the proposal actor', async () => {
    const dir = await tmpProject();
    const body = JSON.stringify([{ item: { kind: 'claim', type: 'HYPOTHESIS', text: 'x' } }]);
    const r = cws(dir, ['propose', '--agent', 'bot', '--role', 'reviewer', '--json', '-'], { input: body });
    assert.equal(r.code, 0, r.err);
    const p = (await EventLog.open(dir)).state.proposals[0]!;
    assert.deepEqual(p.actor, { kind: 'ai', agent: 'bot', role: 'reviewer' });
  });

  it('claim add --role without --agent is rejected, not silently recorded as a role-less human', async () => {
    const dir = await tmpProject();
    const io = human(dir);
    const code = await runHuman(io, ['claim', 'add', '--type', 'ASSUMPTION', '--text', 'a', '--role', 'reviewer']);
    const claim = (await EventLog.open(dir)).state.claims[0];
    const roleKept = claim !== undefined && JSON.stringify(claim.createdBy).includes('reviewer');
    assert.ok(code !== 0 || roleKept || /role/i.test(all(io)), `exit ${code}, actor ${JSON.stringify(claim?.createdBy)}, no warning`);
  });

  it('review-code --agent changes what the agent is told to run', async () => {
    const dir = await tmpProject();
    const ocr = path.join(dir, 'ocr.mjs');
    const preview = { schema_version: '1', mode: 'range', repository: 'r', total_files: 1, reviewable_count: 1, excluded_count: 0, total_insertions: 1, total_deletions: 0, reviewable_files: [{ path: 'a.ts', status: 'M', insertions: 1, deletions: 0 }], excluded_files: [] };
    await fs.writeFile(ocr, `console.log(JSON.stringify(process.argv[3]==='rule' ? {schema_version:'1',groups:[]} : ${JSON.stringify(preview)}));`);
    const env = { ...process.env, CWS_TOOL_OCR: ocr };
    const withAgent = cws(dir, ['review-code', '--agent', 'zorblax-agent'], { env });
    assert.equal(withAgent.code, 0, withAgent.err);
    assert.match(withAgent.out, /zorblax-agent/, 'the --agent value appears nowhere in the output or recorded state');
  });

  it('session end --summary on an already ended session is refused or stored, never dropped', async () => {
    const dir = await tmpProject();
    assert.equal(await runHuman(human(dir), ['session', 'start', 'goal']), 0);
    assert.equal(await runHuman(human(dir), ['session', 'end']), 0);
    const io = human(dir);
    const code = await runHuman(io, ['session', 'end', '--summary', 'LATE-SUMMARY-TEXT']);
    const log = await EventLog.open(dir);
    const stored = JSON.stringify(log.events).includes('LATE-SUMMARY-TEXT');
    const handoffs = await fs.readdir(path.join(dir, '.cws', 'sessions'));
    const inHandoff = (await Promise.all(handoffs.map((f) => fs.readFile(path.join(dir, '.cws', 'sessions', f), 'utf8')))).some((t) => t.includes('LATE-SUMMARY-TEXT'));
    assert.ok(code !== 0 || stored || inHandoff || /summary/i.test(io.err.join('')), `exit ${code}; summary vanished without a word: ${all(io)}`);
  });
});

describe('silent: sandbox flag handling', () => {
  it('sandbox rules --approve X --reject Y refuses the contradiction and calls openshell zero times', async () => {
    const dir = await tmpProject();
    await localSandboxConfig(dir);
    const stub = await stubOpenshell(dir);
    process.env.CWS_TOOL_OPENSHELL = stub.script;
    try {
      const io = human(dir, ['K7Q']);
      const code = await runHuman(io, ['sandbox', 'rules', '--approve', 'chunk-a', '--reject', 'chunk-b']);
      const calls = await stub.calls();
      assert.ok(code !== 0 && calls.length === 0, `exit ${code}; openshell calls: ${JSON.stringify(calls)} (approve silently won)`);
    } finally {
      delete process.env.CWS_TOOL_OPENSHELL;
    }
  });

  it('sandbox run --claim <unknown> fails before any sandbox is created or command executed', async () => {
    const dir = await tmpProject();
    await localSandboxConfig(dir);
    const stub = await stubOpenshell(dir);
    const r = cws(dir, ['sandbox', 'run', '--claim', 'c_doesnotexist', '--', 'echo', 'hi'], { env: { ...process.env, CWS_TOOL_OPENSHELL: stub.script } });
    const calls = await stub.calls();
    assert.ok(r.code !== 0 && calls.length === 0, `exit ${r.code}; openshell calls before the claim check: ${JSON.stringify(calls)}`);
  });
});
