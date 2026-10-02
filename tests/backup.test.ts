import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { runCli } from '../src/cli/app.ts';
import { EXIT, type CliIO } from '../src/cli/io.ts';
import { AUTO_BACKUP_KEEP, decodeBackup } from '../src/store/backup.ts';
import { EventLog, restoreLog } from '../src/store/event-log.ts';

interface FakeIO extends CliIO {
  out: string[];
  err: string[];
  answers: string[];
}

let base: string;
let a: string;
let b: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-backup-'));
  a = path.join(base, 'a');
  b = path.join(base, 'b');
  await fs.mkdir(a);
  await fs.mkdir(b);
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function io(cwd: string, answers: string[] = [], isInteractive = true): FakeIO {
  const fake: FakeIO = {
    cwd,
    out: [],
    err: [],
    answers: [...answers],
    isInteractive,
    stdout: (t) => void fake.out.push(t),
    stderr: (t) => void fake.err.push(t),
    ask: async () => fake.answers.shift() ?? '',
    readStdin: async () => '',
    challenge: () => 'K7Q',
    copy: async () => true,
  };
  return fake;
}

const cli = (fake: FakeIO, ...args: string[]) => runCli(args, fake);
const text = (fake: FakeIO) => [...fake.out, ...fake.err].join('\n');
const backupFile = (name = 'memory.json.gz') => path.join(base, name);

async function project(dir: string): Promise<void> {
  assert.equal(await cli(io(dir), 'init', 'Garden'), EXIT.OK);
  await cli(io(dir), 'session', 'start', 'Soil');
  await cli(io(dir), 'dump', 'clay soil');
  await cli(io(dir), 'session', 'end', '--summary', 'soil is clay');
}

async function exportTo(dir: string, file = backupFile()): Promise<string> {
  assert.equal(await cli(io(dir), 'export', '--to', file), EXIT.OK);
  return file;
}

const head = async (dir: string) => (await EventLog.open(dir)).events.at(-1)!.hash;

async function rewriteBundle(file: string, change: (bundle: Record<string, unknown>) => void): Promise<void> {
  const bundle = JSON.parse(gunzipSync(await fs.readFile(file)).toString('utf8')) as Record<string, unknown>;
  change(bundle);
  await fs.writeFile(file, gzipSync(Buffer.from(JSON.stringify(bundle))));
}

describe('backup: export and import', () => {
  it('round-trips the event log and session handoffs into an empty folder', async () => {
    await project(a);
    const file = await exportTo(a);
    const fake = io(b);
    assert.equal(await cli(fake, 'import', file), EXIT.OK);
    assert.match(text(fake), /restored/);
    assert.equal(await head(b), await head(a));
    assert.equal((await EventLog.open(b)).integrity.ok, true);
    const session = (await EventLog.open(b)).state.sessions[0]!;
    const handoff = await fs.readFile(path.join(b, '.cws', 'sessions', `${session.id}.md`), 'utf8');
    assert.match(handoff, /Soil/);
  });

  it('export refuses to overwrite an existing file', async () => {
    await project(a);
    const file = await exportTo(a);
    const fake = io(a);
    assert.equal(await cli(fake, 'export', '--to', file), EXIT.ERROR);
    assert.match(text(fake), /already exists/);
  });

  it('fast-forwards a local log that is an older copy of the backup', async () => {
    await project(a);
    await cli(io(b), 'import', await exportTo(a, backupFile('old.json.gz')));
    await cli(io(a), 'dump', 'more thoughts');
    const fake = io(b);
    assert.equal(await cli(fake, 'import', await exportTo(a, backupFile('new.json.gz'))), EXIT.OK);
    assert.match(text(fake), /updated/);
    assert.equal(await head(b), await head(a));
  });

  it('reports up to date, and leaves a newer local log alone', async () => {
    await project(a);
    const file = await exportTo(a);
    await cli(io(b), 'import', file);
    const same = io(b);
    await cli(same, 'import', file);
    assert.match(text(same), /up to date/);
    await cli(io(b), 'dump', 'local only');
    const newer = io(b);
    await cli(newer, 'import', file);
    assert.match(text(newer), /newer/);
    assert.equal((await EventLog.open(b)).state.notes.at(-1)!.text, 'local only');
  });

  it('refuses a diverged log unless --replace is confirmed with the challenge code', async () => {
    await project(a);
    await project(b);
    const file = await exportTo(a);
    const refused = io(b);
    assert.equal(await cli(refused, 'import', file), EXIT.ERROR);
    assert.match(text(refused), /Nothing was changed/);
    assert.notEqual(await head(b), await head(a));
    assert.equal(await cli(io(b, ['nope']), 'import', file, '--replace'), EXIT.NEEDS_HUMAN);
    assert.notEqual(await head(b), await head(a));
    assert.equal(await cli(io(b, ['K7Q']), 'import', file, '--replace'), EXIT.OK);
    assert.equal(await head(b), await head(a));
  });

  it('rejects a tampered event without creating a project', async () => {
    await project(a);
    const file = await exportTo(a);
    await rewriteBundle(file, (bundle) => {
      bundle.events = String(bundle.events).replace('clay soil', 'sand soil');
    });
    assert.equal(await cli(io(b), 'import', file), EXIT.ERROR);
    await assert.rejects(fs.access(path.join(b, '.cws')));
  });

  it('rejects handoff names that could escape the sessions folder', async () => {
    await project(a);
    const file = await exportTo(a);
    await rewriteBundle(file, (bundle) => {
      bundle.handoffs = { '../../evil': 'x' };
    });
    assert.equal(await cli(io(b), 'import', file), EXIT.ERROR);
    await assert.rejects(fs.access(path.join(base, 'evil.md')));
  });

  it('rejects files that are not cws backups', async () => {
    const file = backupFile('junk.json.gz');
    await fs.writeFile(file, 'not gzip');
    const fake = io(b);
    assert.equal(await cli(fake, 'import', file), EXIT.ERROR);
    assert.match(text(fake), /not a readable cws backup/);
    assert.throws(() => decodeBackup(gzipSync(Buffer.from('{"format":"other"}'))), /not a valid cws backup/);
  });

  it('export and import are human actions', async () => {
    await project(a);
    const file = await exportTo(a);
    assert.equal(await cli(io(a, [], false), 'export', '--to', backupFile('agent.json.gz')), EXIT.NEEDS_HUMAN);
    assert.equal(await cli(io(b, [], false), 'import', file), EXIT.NEEDS_HUMAN);
  });

  it('restoreLog re-checks under the lock and refuses a diverged log without replace', async () => {
    await project(a);
    await project(b);
    const raw = await fs.readFile(path.join(a, '.cws', 'events.jsonl'), 'utf8');
    await assert.rejects(restoreLog(b, raw, false), /diverged/);
    assert.equal(await restoreLog(b, raw, true), 'replaced');
  });
});

describe('backup: automatic backups on session end', () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.CWS_AUTO_BACKUP;
    process.env.CWS_AUTO_BACKUP = '1';
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CWS_AUTO_BACKUP;
    else process.env.CWS_AUTO_BACKUP = previous;
  });

  it('writes a restorable backup and keeps only the newest ones', async () => {
    await cli(io(a), 'init', 'Garden');
    for (let i = 0; i <= AUTO_BACKUP_KEEP; i++) {
      await cli(io(a), 'session', 'start', `round ${i}`);
      const ended = io(a);
      await cli(ended, 'session', 'end');
      assert.match(text(ended), /Backup saved/);
    }
    const dir = path.join(a, '.cws', 'backups');
    const files = await fs.readdir(dir);
    assert.equal(files.length, AUTO_BACKUP_KEEP);
    const latest = await head(a);
    const decoded = await Promise.all(files.map(async (f) => decodeBackup(await fs.readFile(path.join(dir, f)))));
    const newest = files[decoded.findIndex((d) => d.bundle.headHash === latest)];
    assert.ok(newest, 'the newest backup is kept');
    assert.equal(await cli(io(b), 'import', path.join(dir, newest)), EXIT.OK);
    assert.equal(await head(b), latest);
  });
});
