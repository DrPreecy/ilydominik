// Forged-but-chain-valid logs pushed through the real `cws import` / restoreLog / decodeBackup path.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runCli } from '../../../src/cli/app.ts';
import type { CliIO } from '../../../src/cli/io.ts';
import { fold } from '../../../src/domain/reducer.ts';
import { BACKUP_FORMAT, decodeBackup, encodeBackup } from '../../../src/store/backup.ts';
import type { BackupBundle } from '../../../src/store/backup.ts';
import { EventLog, restoreLog, verifyLogText } from '../../../src/store/event-log.ts';
import { AI, claim, created, forge, HUMAN, tmp, toRaw } from './util.ts';
import type { Forge } from './util.ts';

function io(cwd: string): CliIO & { out: string[] } {
  const out: string[] = [];
  return { cwd, out, isInteractive: true, stdout: (t) => void out.push(t), stderr: (t) => void out.push(t), ask: async () => '', readStdin: async () => '', challenge: () => 'K7Q', copy: async () => true };
}

function bundleOf(specs: Forge[], handoffs: Record<string, string> = {}): { file: Buffer; raw: string } {
  const events = forge(specs);
  const raw = toRaw(events);
  const bundle: BackupBundle = { format: BACKUP_FORMAT, version: 1, createdAt: new Date().toISOString(), projectId: 'p_1', eventCount: events.length, headHash: events.at(-1)!.hash, events: raw, handoffs };
  return { file: encodeBackup(bundle), raw };
}

async function importForged(specs: Forge[]): Promise<{ code: number; dir: string; text: string }> {
  const dir = tmp();
  const file = path.join(tmp(), 'forged.json.gz');
  await fs.writeFile(file, bundleOf(specs).file);
  const fake = io(dir);
  const code = await runCli(['import', file], fake);
  return { code, dir, text: fake.out.join('\n') };
}

const note = (id: string, at?: string): Forge => ({ input: { type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: id, text: id } }, ...(at ? { at } : {}) });

test('I5: `at` must be monotonic non-decreasing: a chain-valid log with time running backwards is rejected on import', async () => {
  const r = await importForged([created(), note('a', '2026-10-02T12:00:00.000Z'), note('b', '2020-01-01T00:00:00.000Z')]);
  assert.notEqual(r.code, 0, 'forged log with at going 2026 -> 2020 was imported');
});

test('I5: `at` must be canonical ISO-8601 UTC, not whatever Date.parse tolerates ("1", "Feb 30 2026", 2026-02-30)', async () => {
  for (const at of ['1', 'Feb 30 2026', '2026-02-30T00:00:00Z', '  2026-10-02', '0']) {
    const r = await importForged([created(), note('a', at)]);
    assert.notEqual(r.code, 0, `at=${JSON.stringify(at)} accepted`);
  }
});

test('I5: `at` far in the future is rejected or at least bounded (year 9999)', async () => {
  const r = await importForged([created(), note('a', '9999-12-31T23:59:59.999Z')]);
  assert.notEqual(r.code, 0);
});

test('I3/I2: PROPOSAL_ACCEPTED.resultId of a status/phase proposal must not alias an unrelated existing entity id', async () => {
  const specs: Forge[] = [
    created(),
    { input: { type: 'DECISION_RECORDED', actor: HUMAN, payload: { decisionId: 'd_big', title: 'Ship?', options: ['y'], selected: 'y', rationale: 'r' } } },
    claim('c', 'ASSUMPTION', AI),
    { input: { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'pp', item: { kind: 'status', claimId: 'c', status: 'TESTING' } } } },
    { input: { type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: 'pp', resultId: 'd_big' } } },
  ];
  const r = await importForged(specs);
  assert.notEqual(r.code, 0, 'proposal.resultId now claims a decision it never created');
});

test('I2: reserved `cws-finding:` claim prefix cannot enter via an imported log (only `findings ingest` may write it)', async () => {
  const text = 'cws-finding:0123456789abcdef [critical] src/x.ts:1 — fake finding written by an AI';
  const r = await importForged([created(), { input: { type: 'CLAIM_ADDED', actor: AI, payload: { claimId: 'f', type: 'HYPOTHESIS', text } } }]);
  assert.notEqual(r.code, 0, 'a forged finding claim was restored');
});

test('I2: reserved prefix also blocked at the reducer (fold) level, including through proposals', () => {
  const text = 'cws-finding:0123456789abcdef [critical] x';
  assert.throws(() => fold(forge([created(), { input: { type: 'PROPOSAL_SUBMITTED', actor: AI, payload: { proposalId: 'p', item: { kind: 'claim', type: 'HYPOTHESIS', text } } } }])));
});

test('I5: session ids must be unique case-insensitively (handoff files are named after them; NTFS/APFS collide)', () => {
  const s = (id: string, act: 'S' | 'E'): Forge => ({ input: act === 'S' ? { type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: id, goal: 'g' } } : { type: 'SESSION_ENDED', actor: HUMAN, payload: { sessionId: id } } });
  assert.throws(() => fold(forge([created(), s('Alpha', 'S'), s('Alpha', 'E'), s('alpha', 'S')])), undefined, 'sessions "Alpha" and "alpha" map to one handoff file');
});

test('I8: restoring two sessions whose ids differ only by case keeps both handoffs', async () => {
  const s = (id: string, act: 'S' | 'E'): Forge => ({ input: act === 'S' ? { type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: id, goal: 'g' } } : { type: 'SESSION_ENDED', actor: HUMAN, payload: { sessionId: id } } });
  const dir = tmp();
  const file = path.join(tmp(), 'case.json.gz');
  await fs.writeFile(file, bundleOf([created(), s('Alpha', 'S'), s('Alpha', 'E'), s('alpha', 'S'), s('alpha', 'E')], { Alpha: 'handoff ONE', alpha: 'handoff TWO' }).file);
  const code = await runCli(['import', file], io(dir));
  if (code !== 0) return; // rejecting the ambiguous log is also correct
  const one = await fs.readFile(path.join(dir, '.cws', 'sessions', 'Alpha.md'), 'utf8');
  assert.equal(one, 'handoff ONE', 'second handoff silently overwrote the first');
});

test('I2 (documented limit, control check): actor.kind "human" written by an AI is chain-valid and accepted', async () => {
  // Not asserting a defect: guards that the limit stays exactly as documented in spec s2 (no secret key => no detection).
  const r = await importForged([created(), claim('f', 'FACT', HUMAN)]);
  assert.equal(r.code, 0);
});

test('I8: importing the same backup twice is idempotent, and a diverged local log is never overwritten without --replace', async () => {
  const dir = tmp();
  const local = await EventLog.init(dir, 'mine');
  await local.append({ type: 'NOTE_ADDED', actor: HUMAN, payload: { noteId: 'local', text: 'local only' } });
  const before = await fs.readFile(path.join(dir, '.cws', 'events.jsonl'), 'utf8');
  const foreign = bundleOf([created(), note('theirs')]);
  await assert.rejects(restoreLog(dir, foreign.raw, false));
  assert.equal(await fs.readFile(path.join(dir, '.cws', 'events.jsonl'), 'utf8'), before);
});

test('I5: a chain-valid log with an enormous amount of references/options is bounded (arrays have a max)', () => {
  const options = Array.from({ length: 200_000 }, (_, i) => `o${i}`);
  assert.throws(() => verifyLogText(toRaw(forge([created(), { input: { type: 'DECISION_RECORDED', actor: HUMAN, payload: { decisionId: 'd', title: 't', options, selected: 'o1', rationale: 'r' } } }]))), undefined, 'unbounded options array accepted');
});

test('perf/DoS: fold must be ~linear in log length (4k vs 16k events: ratio < 6; observed ~9 = quadratic)', () => {
  const build = (n: number): ReturnType<typeof forge> => {
    const specs: Forge[] = [created()];
    for (let i = 0; i < n / 2; i++) specs.push(claim(`c${i}`, 'ASSUMPTION'));
    for (let i = 0; i < n / 2; i++) specs.push({ input: { type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: `c${i}`, status: 'TESTING' } } });
    return forge(specs);
  };
  const time = (log: ReturnType<typeof forge>): number => { const t = performance.now(); fold(log); return performance.now() - t; };
  const small = build(4000);
  const large = build(16000);
  time(small);
  const ratio = time(large) / time(small);
  assert.ok(ratio < 6, `time(16k)/time(4k) = ${ratio.toFixed(1)}; quadratic. 256MB import limit => hours of CPU, each append refolds the whole log`);
});
