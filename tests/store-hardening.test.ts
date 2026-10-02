import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/app.ts';
import type { CliIO } from '../src/cli/io.ts';
import { fold } from '../src/domain/reducer.ts';
import type { CwsEvent } from '../src/domain/types.ts';
import { collectBackup } from '../src/store/backup.ts';
import { CWS_DIR, EVENTS_FILE, EventLog, verifyLogText } from '../src/store/event-log.ts';
import { HUMAN, errCode, project, run, stamp, step } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-store-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const logFile = (root = dir) => path.join(root, CWS_DIR, EVENTS_FILE);

function io(cwd: string, answers: string[] = []): CliIO & { out: string[] } {
  const queue = [...answers];
  const fake = {
    cwd,
    out: [] as string[],
    isInteractive: true,
    stdout: (t: string) => void fake.out.push(t),
    stderr: (t: string) => void fake.out.push(t),
    ask: async () => queue.shift() ?? '',
    readStdin: async () => '',
    challenge: () => 'K7Q',
    copy: async () => true,
  };
  return fake;
}

describe('restoring a backup over a damaged or newer local log', () => {
  it('import --replace repairs a local line that was edited in place', async () => {
    await EventLog.init(dir, 'p');
    const log = await EventLog.open(dir);
    await log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'original thought' } });
    const backup = path.join(dir, 'bk.json.gz');
    assert.equal(await runCli(['export', '--to', backup], io(dir)), 0);

    const raw = await fs.readFile(logFile(), 'utf8');
    await fs.writeFile(logFile(), raw.replace('original thought', 'FORGED thought'));

    const plain = io(dir);
    assert.notEqual(await runCli(['import', backup], plain), 0);
    assert.match(plain.out.join('\n'), /integrity check/);

    assert.equal(await runCli(['import', backup, '--replace'], io(dir, ['K7Q'])), 0);
    const restored = await fs.readFile(logFile(), 'utf8');
    assert.match(restored, /original thought/);
    assert.equal((await EventLog.open(dir)).integrity.ok, true);
  });

  it('import --replace can roll back a local log that ran ahead of the backup', async () => {
    const log = await EventLog.init(dir, 'p');
    const backup = path.join(dir, 'bk.json.gz');
    assert.equal(await runCli(['export', '--to', backup], io(dir)), 0);
    await log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'later' } });

    const plain = io(dir);
    assert.equal(await runCli(['import', backup], plain), 0);
    assert.match(plain.out.join('\n'), /--replace/);
    assert.equal((await EventLog.open(dir)).events.length, 2);

    assert.equal(await runCli(['import', backup, '--replace'], io(dir, ['K7Q'])), 0);
    assert.equal((await EventLog.open(dir)).events.length, 1);
  });
});

describe('crash recovery', () => {
  it('a torn last line is ignored by readers and dropped by the next append', async () => {
    const log = await EventLog.init(dir, 'p');
    await fs.appendFile(logFile(), '{"v":1,"seq":1,"id":"ev_x","at":"2');

    const reopened = await EventLog.open(dir);
    assert.equal(reopened.events.length, 1);
    await reopened.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'after crash' } });

    const lines = (await fs.readFile(logFile(), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal((await EventLog.open(dir)).integrity.ok, true);
    assert.equal(log.rootDir, dir);
  });

  it('a backup taken while an append is torn contains only committed events', async () => {
    await EventLog.init(dir, 'p');
    await fs.appendFile(logFile(), '{"v":1,"seq":1');
    const { bundle } = await collectBackup(dir);
    assert.equal(bundle.eventCount, 1);
    assert.doesNotThrow(() => verifyLogText(bundle.events));
  });

  it('a complete last line without a trailing newline is still data', async () => {
    const log = await EventLog.init(dir, 'p');
    await log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'kept' } });
    const raw = await fs.readFile(logFile(), 'utf8');
    await fs.writeFile(logFile(), raw.trimEnd());
    assert.equal((await EventLog.open(dir)).events.length, 2);
  });

  it('init takes over an empty log left by a crashed init, but never a real project', async () => {
    await fs.mkdir(path.dirname(logFile()), { recursive: true });
    await fs.writeFile(logFile(), '');
    const log = await EventLog.init(dir, 'recovered');
    assert.equal(log.state.title, 'recovered');
    await assert.rejects(EventLog.init(dir, 'again'), errCode('PROJECT_EXISTS'));
    assert.equal((await EventLog.open(dir)).state.title, 'recovered');
  });

  it('a lock left behind by a crash times out with recovery guidance', async () => {
    const log = await EventLog.init(dir, 'p');
    await fs.writeFile(path.join(dir, CWS_DIR, 'lock'), '');
    await assert.rejects(
      log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'x' } }),
      /delete only that lock file/,
    );
  });
});

describe('reducer checks that hold for imported logs too', () => {
  it('rejects a session id that is not filename-safe, whoever wrote the log', () => {
    const s = project();
    assert.throws(
      () => step(s, { type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: '../../evil', goal: 'g' } }),
      errCode('INVALID_EVENT'),
    );
  });

  it('rejects an event tagged with a session that is not active', () => {
    const s = project();
    const forged = { ...stamp(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 't' } }), sessionId: 'never_existed' };
    assert.throws(() => fold([...eventsOf(s), forged]), errCode('INVALID_EVENT'));
  });

  it('rejects an event time that is not a date', () => {
    const s = project();
    const forged = { ...stamp(s, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 't' } }), at: 'banana' };
    assert.throws(() => fold([...eventsOf(s), forged]), errCode('INVALID_EVENT'));
  });

  it('rejects a duplicate event id', () => {
    const created = stamp(null, { type: 'PROJECT_CREATED', actor: HUMAN, payload: { projectId: 'p', title: 't' } });
    const s0 = fold([created])!;
    const note = stamp(s0, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 't' } });
    const s1 = fold([created, note])!;
    const again = { ...stamp(s1, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n2', text: 't' } }), id: note.id };
    assert.throws(() => fold([created, note, again]), errCode('DUPLICATE_ID'));
  });

  it('drops the answer when a claim leaves ANSWERED', () => {
    const s = run([
      { type: 'CLAIM_ADDED', actor: HUMAN, payload: { claimId: 'c1', type: 'UNKNOWN', text: 'q?' } },
      { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: 'c1', status: 'ANSWERED', answer: 'yes' } },
      { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: 'c1', status: 'OPEN' } },
    ], project());
    const claim = s.claims.find((c) => c.id === 'c1')!;
    assert.equal(claim.status, 'OPEN');
    assert.equal('answer' in claim, false);
  });

  it('a reused earlier state still validates against its own ids', () => {
    const s0 = project();
    const s1 = step(s0, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 't' } });
    // s0 never knew n1, so adding it again from s0 is fine; from s1 it is a duplicate.
    assert.doesNotThrow(() => step(s0, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 't' } }));
    assert.throws(() => step(s1, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 't' } }), errCode('DUPLICATE_ID'));
  });

  it('folds a long log in roughly linear time', () => {
    const events: CwsEvent[] = [stamp(null, { type: 'PROJECT_CREATED', actor: HUMAN, payload: { projectId: 'p', title: 't' } })];
    for (let i = 1; i < 10_000; i++) {
      // stamp only reads lastSeq and activeSessionId from the state
      const previous = { lastSeq: i - 1 } as Parameters<typeof stamp>[0];
      events.push(stamp(previous, { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: `n${i}`, text: 'x' } }));
    }
    const started = performance.now();
    const folded = fold(events)!;
    const elapsed = performance.now() - started;
    assert.equal(folded.notes.length, 9_999);
    assert.ok(elapsed < 3000, `fold of 10k events took ${Math.round(elapsed)} ms`);
  });
});

/** Event hashes must not change when schema fields are reordered: this log was written by an earlier build. */
const PINNED_LOG = [
  '{"v":1,"seq":0,"id":"ev_2bb4a6558cce","at":"2026-10-02T19:42:43.825Z","prevHash":"0000000000000000000000000000000000000000000000000000000000000000","type":"PROJECT_CREATED","actor":{"kind":"human"},"payload":{"projectId":"p_0ad98b2a9807","title":"Pinned"},"hash":"5b8adcae527a455044419a611b2151d3cce6992c4285d70432d3a4af4c799bb4"}',
  '{"v":1,"seq":1,"id":"ev_9e0743551995","at":"2026-10-02T19:42:43.836Z","prevHash":"5b8adcae527a455044419a611b2151d3cce6992c4285d70432d3a4af4c799bb4","type":"SESSION_STARTED","actor":{"kind":"human"},"payload":{"sessionId":"s1","goal":"g","doneWhen":"d"},"hash":"7a9e56a5fb5eb8064bf057989b78f595e6e2ba116493c09796fbef871c377e05"}',
  '{"v":1,"seq":2,"id":"ev_008682b0b620","at":"2026-10-02T19:42:43.844Z","sessionId":"s1","prevHash":"7a9e56a5fb5eb8064bf057989b78f595e6e2ba116493c09796fbef871c377e05","type":"CLAIM_ADDED","actor":{"kind":"ai","agent":"copilot","role":"analyst"},"payload":{"claimId":"c1","type":"UNKNOWN","text":"q?","risk":"HIGH","derivedFrom":[]},"hash":"026dbf9a1f721de8af6a0eca8d152dbb59fd6842da9ad1c1e9c995884cf68289"}',
  '{"v":1,"seq":3,"id":"ev_d44b662e6481","at":"2026-10-02T19:42:43.848Z","sessionId":"s1","prevHash":"026dbf9a1f721de8af6a0eca8d152dbb59fd6842da9ad1c1e9c995884cf68289","type":"CLAIM_STATUS_CHANGED","actor":{"kind":"human"},"payload":{"claimId":"c1","status":"ANSWERED","evidence":"e","answer":"a"},"hash":"8a92ca166902cb7b423ba082abc7c36faa1c1e4215a41d85e8ca79dd5c60c0b2"}',
  '{"v":1,"seq":4,"id":"ev_9b76db8198c2","at":"2026-10-02T19:42:43.853Z","sessionId":"s1","prevHash":"8a92ca166902cb7b423ba082abc7c36faa1c1e4215a41d85e8ca79dd5c60c0b2","type":"DECISION_RECORDED","actor":{"kind":"human"},"payload":{"decisionId":"d1","title":"t","options":["x","y"],"selected":"x","rationale":"r","links":["c1"],"kind":"NORMAL"},"hash":"64f5881b791f95b59099e6946d548ba422e5a0145c8f1161c01c3675dce5d096"}',
].join('\n');

describe('hash stability', () => {
  it('a log written by an earlier build still verifies', () => {
    const { events, state } = verifyLogText(PINNED_LOG);
    assert.equal(events.length, 5);
    assert.equal(state.claims[0]!.answer, 'a');
  });
});

function eventsOf(s: ReturnType<typeof project>): CwsEvent[] {
  // project() is a single PROJECT_CREATED event; rebuild it so a forged follow-up can be folded.
  return [{ ...stamp(null, { type: 'PROJECT_CREATED', actor: HUMAN, payload: { projectId: s.id, title: s.title } }), seq: 0 }];
}
