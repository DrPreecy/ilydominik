// Backup / import hostile-filesystem and hostile-input witnesses (I8, I12).
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { runCli } from '../../../src/cli/app.ts';
import type { CliIO } from '../../../src/cli/io.ts';
import { AUTO_BACKUP_KEEP, collectBackup, decodeBackup, encodeBackup, restoreHandoffs, writeAutoBackup } from '../../../src/store/backup.ts';
import { EventLog, restoreLog } from '../../../src/store/event-log.ts';
import { AI, created, forge, HUMAN, tmp, toRaw } from './util.ts';

const BACKUP_RE = /^cws-backup-[0-9TZ.]+-[0-9a-f]{6}\.json\.gz$/;

function io(cwd: string): CliIO & { out: string[] } {
  const out: string[] = [];
  return { cwd, out, isInteractive: true, stdout: (t) => void out.push(t), stderr: (t) => void out.push(t), ask: async () => 'K7Q', readStdin: async () => '', challenge: () => 'K7Q', copy: async () => true };
}

async function project(): Promise<{ dir: string; log: EventLog }> {
  const dir = tmp();
  const log = await EventLog.init(dir, 'p');
  await log.append({ type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId: 's1', goal: 'g' } });
  await log.append({ type: 'SESSION_ENDED', actor: HUMAN, payload: { sessionId: 's1' } });
  return { dir, log };
}

async function junction(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, 'junction');
}

const validBackups = async (dir: string): Promise<number> => {
  let n = 0;
  for (const f of (await fs.readdir(dir)).filter((x) => BACKUP_RE.test(x))) {
    try { decodeBackup(await fs.readFile(path.join(dir, f))); n++; } catch { /* truncated */ }
  }
  return n;
};

// -------------------------------------------------------------- containment (I12)

test('I12: handoff restore with .cws -> junction to an outside dir creates NOTHING outside the project (mkdir-before-check)', async () => {
  const { dir } = await project();
  const outside = tmp();
  await fs.rm(path.join(dir, '.cws'), { recursive: true });
  await junction(outside, path.join(dir, '.cws'));
  await assert.rejects(restoreHandoffs(dir, { s1: 'handoff' }));
  assert.deepEqual(await fs.readdir(outside), [], 'realDirectory() mkdir -p ran through the junction before the containment check');
});

test('I12: auto-backup with .cws -> junction outside creates NOTHING outside the project', async () => {
  const { dir } = await project();
  const outside = tmp();
  const real = path.join(dir, '.cws');
  await fs.cp(real, path.join(outside, '.cws-copy'), { recursive: true });
  await fs.rm(real, { recursive: true });
  await junction(path.join(outside, '.cws-copy'), real);
  await writeAutoBackup(dir).catch(() => undefined);
  assert.deepEqual((await fs.readdir(path.join(outside, '.cws-copy'))).filter((f) => f === 'backups'), [], 'backups/ was created outside the project through the junction');
});

test('I12: `cws import` into a project whose .cws is a junction refuses and writes nothing outside', async () => {
  const src = await project();
  const file = path.join(tmp(), 'b.json.gz');
  await fs.writeFile(file, encodeBackup((await collectBackup(src.dir)).bundle));
  const dest = tmp();
  const outside = tmp();
  await junction(outside, path.join(dest, '.cws'));
  const code = await runCli(['import', file], io(dest));
  assert.notEqual(code, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('I12: `.cws/sessions` as a junction to an outside dir is refused for handoff restore', async () => {
  const { dir } = await project();
  const outside = tmp();
  await junction(outside, path.join(dir, '.cws', 'sessions'));
  await assert.rejects(restoreHandoffs(dir, { s1: 'handoff' }));
  assert.deepEqual(await fs.readdir(outside), []);
});

test('I12: handoff keys with traversal / reserved names are rejected at decode', () => {
  for (const key of ['../evil', '..\\evil', 'a/b', 'C:\\x', 'CON', 'aux', '', ' s1', 's1.', 's1\u0000']) {
    const events = forge([created()]);
    const bundle = { format: 'cws-backup', version: 1, createdAt: 'x', projectId: 'p_1', eventCount: 1, headHash: events[0]!.hash, events: toRaw(events), handoffs: { [key]: 'x' } };
    assert.throws(() => decodeBackup(gzipSync(Buffer.from(JSON.stringify(bundle)))), undefined, `key ${JSON.stringify(key)} accepted`);
  }
});

// -------------------------------------------------------------- hostile input size

test('DoS: a 300 MB gzip bomb is rejected quickly and without holding hundreds of MB', () => {
  const bomb = gzipSync(Buffer.alloc(300 * 1024 * 1024, 0x20), { level: 9 });
  assert.ok(bomb.length < 1024 * 1024);
  const before = process.memoryUsage().rss;
  const t = Date.now();
  assert.throws(() => decodeBackup(bomb));
  const elapsed = Date.now() - t;
  const grown = (process.memoryUsage().rss - before) / 1024 / 1024;
  assert.ok(elapsed < 3000, `took ${elapsed} ms`);
  assert.ok(grown < 100, `RSS grew ${grown.toFixed(0)} MB decoding a 1 MB file`);
});

test('DoS: an expanded size just under the limit (250 MB whitespace-padded JSON) is rejected before JSON.parse of the whole buffer', () => {
  const events = forge([created()]);
  const head = JSON.stringify({ format: 'cws-backup', version: 1, createdAt: 'x', projectId: 'p_1', eventCount: 1, headHash: events[0]!.hash, events: toRaw(events), handoffs: {} });
  const padded = Buffer.concat([Buffer.from(head), Buffer.alloc(250 * 1024 * 1024, 0x20)]);
  const bomb = gzipSync(padded, { level: 9 });
  const before = process.memoryUsage().rss;
  try { decodeBackup(bomb); } catch { /* ok */ }
  const grown = (process.memoryUsage().rss - before) / 1024 / 1024;
  assert.ok(grown < 128, `a ${(bomb.length / 1024).toFixed(0)} KB backup made RSS grow ${grown.toFixed(0)} MB; expanded limit 256 MB is too high for a note-taking tool`);
});

// -------------------------------------------------------------- auto backup durability

test('I8/durability: a crash while writing an auto-backup must not leave a plausible-named truncated file or evict a good backup', async () => {
  const { dir } = await project();
  const backups = path.join(dir, '.cws', 'backups');
  for (let i = 0; i < AUTO_BACKUP_KEEP; i++) await writeAutoBackup(dir, new Date(Date.UTC(2026, 9, 1 + i)));
  assert.equal(await validBackups(backups), AUTO_BACKUP_KEEP);
  const original = fs.writeFile;
  (fs as { writeFile: unknown }).writeFile = async (file: unknown, data: Buffer, opts: unknown) => {
    if (String(file).includes('cws-backup-')) {
      await original.call(fs, file as string, data.subarray(0, Math.floor(data.length / 2)), opts as object);
      throw new Error('simulated crash mid-write');
    }
    return original.call(fs, file as string, data, opts as object);
  };
  try {
    await writeAutoBackup(dir, new Date(Date.UTC(2026, 9, 20))).catch(() => undefined);
  } finally {
    (fs as { writeFile: unknown }).writeFile = original;
  }
  const names = (await fs.readdir(backups)).filter((n) => BACKUP_RE.test(n));
  assert.equal(await validBackups(backups), names.length, `${names.length - (await validBackups(backups))} truncated file(s) with a valid backup name remain (non-atomic wx write; counted by retention, will evict a good backup next run)`);
});

test('I8/durability: backups are retained by recency of CONTENT, not by file-name clock: a backward clock jump must not delete the fresh backup', async () => {
  const { dir } = await project();
  for (let i = 0; i < AUTO_BACKUP_KEEP; i++) await writeAutoBackup(dir, new Date(Date.UTC(2026, 9, 1 + i)));
  const fresh = await writeAutoBackup(dir, new Date(Date.UTC(2020, 0, 1))); // clock reset / skew
  await assert.doesNotReject(fs.stat(fresh), 'the backup just written was immediately pruned because its name sorts oldest');
});

test('I8: restoreLog survives an open read handle on events.jsonl (Windows rename-over-open-file)', async () => {
  const a = await project();
  const raw = await fs.readFile(path.join(a.dir, '.cws', 'events.jsonl'), 'utf8');
  const b = tmp();
  await restoreLog(b, raw.split('\n').slice(0, 2).join('\n') + '\n', false);
  const stream = createReadStream(path.join(b, '.cws', 'events.jsonl'), { highWaterMark: 1 });
  await new Promise((r) => stream.once('readable', r));
  try {
    assert.equal(await restoreLog(b, raw, false), 'fast-forward');
  } finally {
    stream.destroy();
  }
});

test('I8: import never silently drops a local event: backup that is a strict prefix of local is reported local-ahead and file untouched', async () => {
  const a = await project();
  const prefix = (await fs.readFile(path.join(a.dir, '.cws', 'events.jsonl'), 'utf8')).split('\n').slice(0, 2).join('\n') + '\n';
  const before = await fs.readFile(path.join(a.dir, '.cws', 'events.jsonl'), 'utf8');
  assert.equal(await restoreLog(a.dir, prefix, false), 'local-ahead');
  assert.equal(await fs.readFile(path.join(a.dir, '.cws', 'events.jsonl'), 'utf8'), before);
});

test('I8: a forged AI event cannot ride in a fast-forward: incoming events beyond the common prefix are re-verified for authority', async () => {
  const a = await project();
  const local = (await EventLog.open(a.dir)).events;
  const forged = forge([
    ...local.map((e) => ({ input: { type: e.type, actor: e.actor, payload: e.payload } as never, id: e.id, at: e.at })),
  ]);
  void forged;
  const bad = toRaw(local) + JSON.stringify({ ...local.at(-1)!, seq: local.length, id: 'x', type: 'PHASE_CHANGED', actor: AI, payload: { to: 'LAUNCH', reason: 'r' } }) + '\n';
  await assert.rejects(restoreLog(a.dir, bad, false));
});
