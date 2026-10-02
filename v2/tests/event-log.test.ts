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
