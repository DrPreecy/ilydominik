import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCli } from '../../../src/cli/app.ts';
import type { FirestoreSyncClient, RemoteEventDoc, RemoteProjectMeta } from '../../../src/cloud/sync.ts';
import { EventLog } from '../../../src/store/event-log.ts';
import { all, cws, human, tmpDir, tmpProject } from './harness.ts';

describe('silent: input that is dropped or defaulted without a word', () => {
  it('findings ingest reports SARIF results it had to drop (no location)', async () => {
    const root = await tmpProject();
    const sarif = { version: '2.1.0', runs: [{ tool: { driver: { name: 'semgrep' } }, results: [{ ruleId: 'r1', level: 'error', message: { text: 'CRITICAL-NO-LOCATION' } }] }] };
    await fs.writeFile(path.join(root, 'r.sarif'), JSON.stringify(sarif));
    const r = cws(root, ['findings', 'ingest', '--agent', 'bot', 'r.sarif']);
    assert.ok(/skipp|dropp|no location|without a location|ignored|1 result/i.test(r.out + r.err) || r.code !== 0, `exit ${r.code}; said only: ${r.out.trim()}`);
  });

  it('review-code does not turn one malformed file entry into "no files, nothing to review"', async () => {
    const root = await tmpProject();
    const ocr = path.join(root, 'ocr.mjs');
    const preview = {
      schema_version: '1', mode: 'range', repository: 'r', total_files: 2, reviewable_count: 2, excluded_count: 0,
      total_insertions: 2, total_deletions: 0,
      reviewable_files: [{ path: 'src/auth.ts', status: 'M', insertions: 1, deletions: 0 }, { status: 'M' }], // second entry has no path
      excluded_files: [],
    };
    await fs.writeFile(ocr, `console.log(JSON.stringify(process.argv[3]==='rule' ? {schema_version:'1',groups:[]} : ${JSON.stringify(preview)}));`);
    const r = cws(root, ['review-code'], { env: { ...process.env, CWS_TOOL_OCR: ocr } });
    assert.ok(r.code !== 0 || r.out.includes('src/auth.ts'), `OCR said 2 files; cws printed:\n${r.out}`);
  });
});

function client(meta: RemoteProjectMeta | null, docs: RemoteEventDoc[]): FirestoreSyncClient {
  return {
    getProjectMeta: async () => meta,
    setProjectMeta: async () => undefined,
    getEvents: async (_u, _p, from, to) => docs.filter((d) => d.seq >= from && (to === undefined || d.seq <= to)),
    pushEvents: async () => undefined,
  };
}

async function twoClones(): Promise<{ local: string; docs: RemoteEventDoc[]; head: RemoteProjectMeta; creds: string }> {
  const remote = await tmpProject();
  for (const t of ['one', 'two', 'three']) assert.equal(cws(remote, ['dump', '--agent', 'bot', t]).code, 0);
  const rlog = await EventLog.open(remote);
  const local = await tmpDir();
  await fs.mkdir(path.join(local, '.cws'));
  const first = (await fs.readFile(path.join(remote, '.cws', 'events.jsonl'), 'utf8')).split('\n')[0]!;
  await fs.writeFile(path.join(local, '.cws', 'events.jsonl'), first + '\n');
  const docs = rlog.events.map((e) => ({ seq: e.seq, hash: e.hash, prevHash: e.prevHash, event: e as unknown as Record<string, unknown> }));
  const last = rlog.events.at(-1)!;
  const creds = path.join(local, 'creds.json');
  await fs.writeFile(creds, JSON.stringify({ uid: 'u1', refreshToken: 't' }));
  return { local, docs, head: { name: 'n', headSeq: last.seq, headHash: last.hash, updatedAt: 'x', schemaVersion: 1 }, creds };
}

describe('silent: sync pull', () => {
  it('pull exits non-zero when the remote head is ahead but its event documents are missing', async () => {
    const { local, head, creds } = await twoClones();
    const io = human(local);
    const code = await runCli(['sync', 'pull'], io, { firestoreSyncClient: client(head, []), credentialsPath: creds });
    assert.ok(code !== 0 && !/Up to date/.test(all(io)), `exit ${code}: ${all(io).trim()}`);
  });

  it('pull does not report success when it fetched only part of the range up to the remote head', async () => {
    const { local, docs, head, creds } = await twoClones();
    const io = human(local);
    const partial = docs.slice(0, 2); // seq 0,1 ; remote head is seq 3
    const code = await runCli(['sync', 'pull'], io, { firestoreSyncClient: client(head, partial), credentialsPath: creds });
    const localHead = (await EventLog.open(local)).state.lastSeq;
    assert.ok(code !== 0 || localHead === head.headSeq, `exit ${code}, local head seq ${localHead} != remote head seq ${head.headSeq}: ${all(io).trim()}`);
  });
});
