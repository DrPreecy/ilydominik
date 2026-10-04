// I7: a kill at any byte offset leaves a log that opens to a verified prefix (or fails loudly).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { EventLog } from '../../../src/store/event-log.ts';
import { verifyLogText } from '../../../src/store/event-log.ts';
import { AI, claim, created, forge, HUMAN, tmp, toRaw } from './util.ts';
import type { Forge } from './util.ts';

async function place(raw: string | Buffer): Promise<string> {
  const dir = tmp();
  await fs.mkdir(path.join(dir, '.cws'));
  await fs.writeFile(path.join(dir, '.cws', 'events.jsonl'), raw);
  return dir;
}

/** The only acceptable outcomes: open() throws, or it yields exactly the committed-line prefix and that prefix verifies. */
async function checkCut(full: Buffer, cut: number, lineEnds: number[]): Promise<string | null> {
  const dir = await place(full.subarray(0, cut));
  const complete = lineEnds.filter((e) => e <= cut).length; // lines fully terminated by \n
  const lastEnd = lineEnds.filter((e) => e <= cut).at(-1) ?? 0;
  const tail = full.subarray(lastEnd, cut).toString('utf8');
  let tailIsCompleteJson = false;
  try { JSON.parse(tail); tailIsCompleteJson = tail.trim() !== ''; } catch { /* partial */ }
  const expected = complete + (tailIsCompleteJson ? 1 : 0);
  let log: EventLog;
  try {
    log = await EventLog.open(dir);
  } catch (error) {
    return expected === 0 || (error as Error).message.length > 0 ? null : 'silent';
  }
  if (log.events.length !== expected) return `cut=${cut}: opened ${log.events.length} events, expected ${expected}`;
  if (!log.integrity.ok) return `cut=${cut}: opened an unverified log`;
  // next append must repair the torn tail and keep the chain valid
  await log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: `after_${cut}`, text: 'after crash' } });
  const reopened = await EventLog.open(dir);
  try { verifyLogText(await fs.readFile(path.join(dir, '.cws', 'events.jsonl'), 'utf8')); } catch (e) { return `cut=${cut}: post-append log fails verify: ${(e as Error).message}`; }
  if (reopened.events.length !== expected + 1) return `cut=${cut}: append after crash lost/duplicated events (${reopened.events.length} vs ${expected + 1})`;
  return null;
}

function smallLog(): Buffer {
  const specs: Forge[] = [
    created(),
    claim('c1', 'ASSUMPTION', AI),
    { input: { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n1', text: 'zażółć gęślą jaźń \u{1F600} "q"\\' } } },
    { input: { type: 'PHASE_CHANGED', actor: HUMAN, payload: { to: 'PROOF', reason: 'r' } } },
  ];
  return Buffer.from(toRaw(forge(specs)), 'utf8');
}

function lineEndsOf(buf: Buffer): number[] {
  const ends: number[] = [];
  buf.forEach((b, i) => { if (b === 0x0a) ends.push(i + 1); });
  return ends;
}

test('I7: truncation at EVERY byte offset of a small log opens to a verified prefix and append heals it', { timeout: 300_000 }, async () => {
  const full = smallLog();
  const ends = lineEndsOf(full);
  const bad: string[] = [];
  for (let cut = 0; cut <= full.length; cut++) {
    const problem = await checkCut(full, cut, ends);
    if (problem) bad.push(problem);
  }
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length}/${full.length + 1} offsets misbehave`);
});

test('I7: truncation at 400 random offsets of a 300-event log', { timeout: 300_000 }, async () => {
  const specs: Forge[] = [created()];
  for (let i = 0; i < 299; i++) specs.push({ input: { type: 'NOTE_ADDED', actor: i % 2 ? AI : HUMAN, payload: { noteId: `n${i}`, text: `note ${i} ${'x'.repeat(i % 50)}` } } });
  const full = Buffer.from(toRaw(forge(specs)), 'utf8');
  const ends = lineEndsOf(full);
  let seed = 12345;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const bad: string[] = [];
  for (let i = 0; i < 400; i++) {
    const problem = await checkCut(full, rnd() % (full.length + 1), ends);
    if (problem) bad.push(problem);
  }
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length}/400 offsets misbehave`);
});

test('I7: NUL-filled tail after a crash (NTFS/ext4 delayed allocation) is dropped, not accepted and not fatal', async () => {
  const full = smallLog();
  const lines = lineEndsOf(full);
  const prefix = full.subarray(0, lines[2]!);
  for (const garbage of [Buffer.alloc(64), Buffer.concat([full.subarray(lines[2]!, lines[2]! + 20), Buffer.alloc(40)])]) {
    const dir = await place(Buffer.concat([prefix, garbage]));
    const log = await EventLog.open(dir);
    assert.equal(log.events.length, 3);
    await log.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'z', text: 'z' } });
    assert.equal((await EventLog.open(dir)).integrity.ok, true);
  }
});

test('I7: garbage in the MIDDLE of the log (not the tail) fails loudly instead of silently dropping later events', async () => {
  const full = smallLog().toString('utf8').split('\n');
  full[1] = full[1]!.slice(0, 40); // torn line followed by valid lines
  const dir = await place(full.join('\n'));
  await assert.rejects(EventLog.open(dir), /LOG_CORRUPT/);
});

test('I7: open() of a log whose hash chain is broken must not hand out a writable log that happily appends', async () => {
  const log = forge([created(), { input: { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n', text: 'original' } } }]);
  const tampered = toRaw(log).replace('original', 'tampered');
  const dir = await place(tampered);
  let opened: EventLog | undefined;
  try { opened = await EventLog.open(dir); } catch { return; } // loud failure is acceptable
  // if it opens, writing must be refused while the chain is broken
  await assert.rejects(opened.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'n2', text: 'builds on tampered history' } }),
    'append() extended a log whose chain is already broken');
});

test('I7: truncation exactly at a line boundary is indistinguishable from a shorter log: documented limit, but open() must at least not report a later seq than the file holds', async () => {
  const full = smallLog();
  const ends = lineEndsOf(full);
  const dir = await place(full.subarray(0, ends[1]!));
  const log = await EventLog.open(dir);
  assert.equal(log.state.lastSeq, 1);
});
