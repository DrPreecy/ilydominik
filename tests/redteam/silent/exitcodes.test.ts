import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventLog } from '../../../src/store/event-log.ts';
import { all, cws, human, runHuman, tmpDir, tmpProject } from './harness.ts';

describe('silent: exit codes that hide failure', () => {
  it('doctor exits non-zero when required tools (node, git) are missing', async () => {
    const dir = await tmpDir();
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
    env.PATH = dir; // an empty directory: nothing resolvable
    const r = cws(dir, ['doctor'], { env });
    assert.match(r.out, /Missing required tools/, r.err + r.out);
    assert.notEqual(r.code, 0, 'doctor printed "Missing required tools" and still exited 0');
  });

  async function pendingTwo(dir: string): Promise<void> {
    const body = JSON.stringify([
      { item: { kind: 'phase', to: 'EXPLORATION', reason: 'already here' } },
      { item: { kind: 'claim', type: 'HYPOTHESIS', text: 'after the bad one' } },
    ]);
    assert.equal(cws(dir, ['propose', '--agent', 'bot', '--json', '-'], { input: body }).code, 0);
  }

  it('accept --all exits non-zero when a proposal was skipped because it failed', async () => {
    const dir = await tmpProject();
    await pendingTwo(dir);
    const io = human(dir, ['K7Q']);
    const code = await runHuman(io, ['accept', '--all']);
    assert.match(all(io), /skipped .*already in phase/i);
    assert.notEqual(code, 0, 'a proposal failed and was skipped, yet exit code is 0');
  });

  it('accept <risky phase> without --accept-risk exits like `cws phase` does (2), not 0', async () => {
    const dir = await tmpProject();
    const asHuman = human(dir);
    await runHuman(asHuman, ['claim', 'add', '--type', 'ASSUMPTION', '--text', 'RISKY', '--risk', 'FATAL']);
    const body = JSON.stringify([{ item: { kind: 'phase', to: 'UNDERSTANDING', reason: 'n' } }, { item: { kind: 'phase', to: 'IMPLEMENTATION', reason: 'build' } }]);
    cws(dir, ['propose', '--agent', 'bot', '--json', '-'], { input: body });
    const [, risky] = (await EventLog.open(dir)).state.proposals;
    const io = human(dir, ['K7Q']);
    const code = await runHuman(io, ['accept', risky!.id]);
    assert.match(all(io), /NOT accepted/);
    assert.notEqual(code, 0, 'the proposal was NOT accepted but the command reports success');
  });
});

describe('silent: logout lies', () => {
  it('logout does not claim "Already logged out" when the credentials could not be removed', async () => {
    const dir = await tmpProject();
    const creds = path.join(dir, 'credentials.json');
    await fs.mkdir(creds);
    await fs.writeFile(path.join(creds, 'keep'), 'x'); // unlink() on a non-empty directory fails with EPERM/EISDIR
    const io = human(dir);
    const code = await runHuman(io, ['logout'], { credentialsPath: creds });
    assert.ok(!/Already logged out/.test(all(io)) || code !== 0, `says "${all(io).trim()}" with exit ${code} although the credential path still exists`);
  });
});
