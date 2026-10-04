// I6: mutual exclusion, N processes x M appends through the real EventLog.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EventLog } from '../../../src/store/event-log.ts';
import { tmp } from './util.ts';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'append-worker.ts');
const HUMAN = { kind: 'human' } as const;

interface WorkerResult { worker: string; failures: number; messages: string[] }

function runWorker(dir: string, id: string, count: number): Promise<WorkerResult & { code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, dir, id, String(count)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let parsed: WorkerResult = { worker: id, failures: -1, messages: [] };
      try { parsed = JSON.parse(out) as WorkerResult; } catch { /* crashed */ }
      resolve({ ...parsed, code, stderr: err.slice(0, 300) });
    });
  });
}

test('I6: 8 processes x 250 appends => |L| = 2000, chain verifies, no lost/failed append', { timeout: 540_000 }, async () => {
  const dir = tmp();
  await EventLog.init(dir, 'concurrency');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runWorker(dir, String(i), 250)));
  const log = await EventLog.open(dir);
  const notes = log.state.notes.length;
  const failures = results.reduce((a, r) => a + r.failures, 0);
  assert.equal(log.integrity.ok, true, 'chain must verify');
  assert.equal(failures, 0, `append failures: ${JSON.stringify(results.map((r) => [r.worker, r.failures, r.messages, r.stderr]))}`);
  assert.equal(notes, 2000, `notes=${notes} events=${log.events.length}`);
  assert.equal(log.events.length, 2001);
  const left = (await fs.readdir(path.join(dir, '.cws'))).filter((f) => f !== 'events.jsonl');
  assert.deepEqual(left, [], `stray files in .cws: ${left}`);
});

test('I6: a stale lock whose owner pid is dead is taken over by exactly one of 6 racing writers (lock takeover race)', { timeout: 120_000 }, async () => {
  const dir = tmp();
  await EventLog.init(dir, 'takeover');
  // pid 2147483646 is not a live process; the lock is stale.
  await fs.writeFile(path.join(dir, '.cws', 'lock'), JSON.stringify({ pid: 2147483646, nonce: 'dead' }));
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => runWorker(dir, String(i), 20)));
  const log = await EventLog.open(dir);
  assert.equal(results.reduce((a, r) => a + r.failures, 0), 0, JSON.stringify(results));
  assert.equal(log.state.notes.length, 120);
  assert.equal(log.integrity.ok, true);
});

test('I6: a lock owned by a LIVE foreign pid is never stolen (pid-reuse safe): writer must fail loudly, not append', { timeout: 60_000 }, async () => {
  const dir = tmp();
  const log = await EventLog.init(dir, 'live');
  // our own pid is alive: represents any live holder
  await fs.writeFile(path.join(dir, '.cws', 'lock'), JSON.stringify({ pid: process.pid, nonce: 'held' }));
  const before = (await fs.readFile(path.join(dir, '.cws', 'events.jsonl'), 'utf8')).length;
  await assert.rejects(log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'x', text: 'x' } }), /lock/);
  assert.equal((await fs.readFile(path.join(dir, '.cws', 'events.jsonl'), 'utf8')).length, before);
});

test('I6: a lock file left by a crashed writer with unparsable owner info is recoverable without manual deletion within the lock timeout', { timeout: 60_000 }, async () => {
  const dir = tmp();
  const log = await EventLog.init(dir, 'garbage-lock');
  await fs.writeFile(path.join(dir, '.cws', 'lock'), ''); // crash between create and write of the owner nonce
  await assert.doesNotReject(log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'x', text: 'x' } }),
    'an empty lock file (crash after O_CREAT|O_EXCL, before write) wedges every writer until manual deletion');
});

test('I6: a stale recovery marker left by a crashed recoverer does not wedge writers forever', { timeout: 60_000 }, async () => {
  const dir = tmp();
  const log = await EventLog.init(dir, 'stale-recovery');
  await fs.writeFile(path.join(dir, '.cws', 'lock'), JSON.stringify({ pid: 2147483646, nonce: 'dead' }));
  await fs.writeFile(path.join(dir, '.cws', 'lock.recovery'), JSON.stringify({ pid: 2147483646, nonce: 'dead-recoverer' }));
  await assert.doesNotReject(log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'x', text: 'x' } }),
    'dead lock + dead recovery marker => permanent wedge requiring manual file deletion');
});
