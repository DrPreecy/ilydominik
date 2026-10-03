import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventLog, findProjectRoot, CWS_DIR, EVENTS_FILE } from '../src/store/event-log.ts';
import { AI, HUMAN, errCode } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-test-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const logFile = () => path.join(dir, CWS_DIR, EVENTS_FILE);

describe('EventLog', () => {
  it('init creates .cws/events.jsonl with a PROJECT_CREATED event', async () => {
    const log = await EventLog.init(dir, 'My Project');
    assert.equal(log.state.title, 'My Project');
    assert.match(log.state.id, /^p_/);
    const lines = (await fs.readFile(logFile(), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).type, 'PROJECT_CREATED');
  });

  it('init refuses to overwrite an existing project', async () => {
    await EventLog.init(dir, 'a');
    await assert.rejects(EventLog.init(dir, 'b'), errCode('PROJECT_EXISTS'));
  });

  it('open on a folder without a project fails with NO_PROJECT', async () => {
    await assert.rejects(EventLog.open(dir), errCode('NO_PROJECT'));
  });

  it('append assigns seq/id/at/sessionId/hash chain and persists; reopen folds the same state', async () => {
    const log = await EventLog.init(dir, 'p');
    await log.append({ type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: 's1', goal: 'g' } });
    const ev = await log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'hello' } });
    assert.equal(ev.seq, 2);
    assert.equal(ev.sessionId, 's1');
    assert.match(ev.hash, /^[0-9a-f]{64}$/);
    assert.equal(ev.prevHash, log.events[1]!.hash);

    const reopened = await EventLog.open(dir);
    assert.deepEqual(reopened.state, log.state);
    assert.equal(reopened.integrity.ok, true);
  });

  it('an invalid event is never written to disk', async () => {
    const log = await EventLog.init(dir, 'p');
    const before = await fs.readFile(logFile(), 'utf8');
    await assert.rejects(
      log.append({ type: 'DECISION_RECORDED', actor: AI, payload: { decisionId: 'd', title: 't', options: [], selected: 's', rationale: 'r' } }),
      errCode('AI_NOT_AUTHORIZED'),
    );
    await assert.rejects(log.append({ type: 'NOPE', actor: HUMAN, payload: {} } as never), errCode('INVALID_EVENT'));
    assert.equal(await fs.readFile(logFile(), 'utf8'), before);
  });

  it('rejects unsafe session identifiers at the append boundary without changing the log', async () => {
    const log = await EventLog.init(dir, 'p');
    const before = await fs.readFile(logFile(), 'utf8');
    for (const sessionId of ['../../../audit-escape', '..', 'a/b', 'a\\b', 'NUL', 'a:b', 'a'.repeat(129)]) {
      await assert.rejects(log.append({ type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId, goal: 'unsafe' } }), errCode('INVALID_EVENT'));
      await assert.rejects(log.append({ type: 'SESSION_ENDED', actor: HUMAN, payload: { sessionId } }), errCode('INVALID_EVENT'));
    }
    assert.equal(await fs.readFile(logFile(), 'utf8'), before);
  });

  it('detects tampering with an existing line (hash chain) but still opens', async () => {
    const log = await EventLog.init(dir, 'p');
    await log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'original' } });
    await log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n2', text: 'later' } });
    const raw = await fs.readFile(logFile(), 'utf8');
    await fs.writeFile(logFile(), raw.replace('original', 'forged'));
    const reopened = await EventLog.open(dir);
    assert.equal(reopened.integrity.ok, false);
    assert.equal(reopened.integrity.brokenAtSeq, 1);
  });

  it('a corrupt (non-JSON) line fails loudly with its line number', async () => {
    await EventLog.init(dir, 'p');
    await fs.appendFile(logFile(), '{not json\n');
    await assert.rejects(EventLog.open(dir), (e: unknown) => e instanceof Error && e.message.includes('[LOG_CORRUPT]') && e.message.includes('line 2'));
  });

  it('two handles appending concurrently never fork the log', async () => {
    const a = await EventLog.init(dir, 'p');
    const b = await EventLog.open(dir);
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => a.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: `a${i}`, text: 'a' } })),
      ...Array.from({ length: 10 }, (_, i) => b.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: `b${i}`, text: 'b' } })),
    ]);
    const final = await EventLog.open(dir);
    assert.equal(final.state.notes.length, 20);
    assert.equal(final.integrity.ok, true);
    assert.deepEqual(
      final.events.map((e) => e.seq),
      Array.from({ length: 21 }, (_, i) => i),
    );
  });

  it('a paused live writer keeps its aged lock until append completes', async (t) => {
    const first = await EventLog.init(dir, 'p');
    const second = await EventLog.open(dir);
    const originalAppend = fs.appendFile.bind(fs);
    let resume!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let writes = 0;
    t.mock.method(fs, 'appendFile', async (...args: Parameters<typeof fs.appendFile>) => {
      writes += 1;
      if (writes === 1) {
        reached();
        await gate;
      }
      return originalAppend(...args);
    });
    const pendingFirst = first.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'first', text: 'first' } });
    await paused;
    const lockPath = path.join(dir, CWS_DIR, 'lock');
    const owner = await fs.readFile(lockPath, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);
    const pendingSecond = second.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'second', text: 'second' } });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(writes, 1, 'the second writer must not enter append while the first is paused');
      assert.equal(await fs.readFile(lockPath, 'utf8'), owner);
    } finally {
      resume();
      await Promise.all([pendingFirst, pendingSecond]);
    }
    const reopened = await EventLog.open(dir);
    assert.deepEqual(reopened.events.map((event) => event.seq), [0, 1, 2]);
    assert.equal(reopened.integrity.ok, true);
  });

  it('competing writers safely recover a dead owner without deleting a successor lock', async (t) => {
    await EventLog.init(dir, 'p');
    const deadPid = 999999;
    const originalKill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid: number, signal?: Parameters<typeof process.kill>[1]) => {
      if (pid === deadPid) throw Object.assign(new Error('dead owner'), { code: 'ESRCH' });
      return originalKill(pid, signal);
    });
    await fs.writeFile(path.join(dir, CWS_DIR, 'lock'), JSON.stringify({ pid: deadPid, nonce: 'dead' }));
    const handles = await Promise.all(Array.from({ length: 12 }, () => EventLog.open(dir)));
    await Promise.all(handles.map((log, index) => log.append({
      type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: `recovered-${index}`, text: 'recovered' },
    })));
    const reopened = await EventLog.open(dir);
    assert.equal(reopened.state.notes.length, handles.length);
    assert.deepEqual(reopened.events.map((event) => event.seq), Array.from({ length: 13 }, (_, index) => index));
    assert.equal(reopened.integrity.ok, true);
  });

  it('abandoned recovery markers fail promptly with safe manual recovery guidance for two contenders', async (t) => {
    const first = await EventLog.init(dir, 'p');
    const second = await EventLog.open(dir);
    const lockPath = path.join(dir, CWS_DIR, 'lock');
    const recoveryPath = `${lockPath}.recovery`;
    const deadOwner = JSON.stringify({ pid: 999999, nonce: 'dead' });
    const before = await fs.readFile(logFile(), 'utf8');
    const originalKill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid: number, signal?: Parameters<typeof process.kill>[1]) => {
      if (pid === 999999) throw Object.assign(new Error('dead owner'), { code: 'ESRCH' });
      return originalKill(pid, signal);
    });
    const originalNow = Date.now();
    let ticks = 0;
    t.mock.method(Date, 'now', () => originalNow + ticks++ * 1000);
    for (const marker of [null, deadOwner, 'incomplete owner']) {
      await fs.writeFile(lockPath, deadOwner);
      if (marker === null) await fs.mkdir(recoveryPath);
      else await fs.writeFile(recoveryPath, marker);
      ticks = 0;
      await Promise.all([first, second].map((log, index) => assert.rejects(log.append({
        type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: `blocked-${index}`, text: 'blocked' },
      }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`recovery blocked at ${recoveryPath}`));
        assert.ok(error.message.includes('Stop all CWS writers'));
        assert.ok(error.message.includes('verify no writer or recovery process is running'));
        assert.ok(error.message.includes('remove only the recovery marker'));
        assert.ok(error.message.includes('Do not delete the lock or event log'));
        return true;
      })));
      assert.ok(ticks <= 4, 'both contenders must fail before retrying to the lock deadline');
      assert.equal(await fs.readFile(lockPath, 'utf8'), deadOwner);
      assert.equal(await fs.readFile(logFile(), 'utf8'), before);
      if (marker === null) assert.deepEqual(await fs.readdir(recoveryPath), []);
      else assert.equal(await fs.readFile(recoveryPath, 'utf8'), marker);
      await fs.rm(recoveryPath, { recursive: true });
    }
    await first.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'after-manual-recovery', text: 'recovered' } });
    const reopened = await EventLog.open(dir);
    assert.deepEqual(reopened.events.map((event) => event.seq), [0, 1]);
    assert.equal(reopened.integrity.ok, true);
  });

  it('a contender waits for a live recovery owner without replacing its marker or lock', async (t) => {
    const first = await EventLog.init(dir, 'p');
    const second = await EventLog.open(dir);
    const lockPath = path.join(dir, CWS_DIR, 'lock');
    const recoveryPath = `${lockPath}.recovery`;
    const deadOwner = JSON.stringify({ pid: 999999, nonce: 'dead' });
    const originalKill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid: number, signal?: Parameters<typeof process.kill>[1]) => {
      if (pid === 999999) throw Object.assign(new Error('dead owner'), { code: 'ESRCH' });
      return originalKill(pid, signal);
    });
    await fs.writeFile(lockPath, deadOwner);
    const originalUnlink = fs.unlink.bind(fs);
    let resume!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    t.mock.method(fs, 'unlink', async (file: Parameters<typeof fs.unlink>[0]) => {
      if (file === lockPath) {
        reached();
        await gate;
      }
      return originalUnlink(file);
    });
    const pendingFirst = first.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'recovery-first', text: 'first' } });
    try {
      await paused;
      const marker = await fs.readFile(recoveryPath, 'utf8');
      assert.equal(JSON.parse(marker).pid, process.pid);
      const pendingSecond = second.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'recovery-second', text: 'second' } });
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(await fs.readFile(recoveryPath, 'utf8'), marker);
        assert.equal(await fs.readFile(lockPath, 'utf8'), deadOwner);
        assert.equal((await EventLog.open(dir)).events.length, 1);
      } finally {
        resume();
        await pendingSecond;
      }
    } finally {
      resume();
      await pendingFirst;
    }
    const reopened = await EventLog.open(dir);
    assert.deepEqual(reopened.events.map((event) => event.seq), [0, 1, 2]);
    assert.equal(reopened.integrity.ok, true);
    await assert.rejects(fs.stat(recoveryPath), { code: 'ENOENT' });
  });

  it('fails closed for legacy or unverifiable lock owners rather than evicting them', async (t) => {
    const log = await EventLog.init(dir, 'p');
    const lockPath = path.join(dir, CWS_DIR, 'lock');
    const before = await fs.readFile(logFile(), 'utf8');
    const originalNow = Date.now();
    let tick = 0;
    t.mock.method(Date, 'now', () => originalNow + tick++ * 1000);
    const originalKill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid: number, signal?: Parameters<typeof process.kill>[1]) => {
      if (pid === 999999) throw Object.assign(new Error('owner inaccessible'), { code: 'EPERM' });
      return originalKill(pid, signal);
    });
    for (const owner of ['legacy nonce', JSON.stringify({ pid: 999999, nonce: 'unverifiable' })]) {
      await fs.writeFile(lockPath, owner);
      await assert.rejects(log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'blocked', text: 'blocked' } }), /timed out waiting for lock/);
      assert.equal(await fs.readFile(lockPath, 'utf8'), owner);
      assert.equal(await fs.readFile(logFile(), 'utf8'), before);
    }
  });

  it('findProjectRoot walks up from a nested folder', async () => {
    await EventLog.init(dir, 'p');
    const nested = path.join(dir, 'a', 'b');
    await fs.mkdir(nested, { recursive: true });
    assert.equal(findProjectRoot(nested), dir);
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-none-'));
    assert.equal(findProjectRoot(other), null);
    await fs.rm(other, { recursive: true, force: true });
  });
});
