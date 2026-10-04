// Red-team witnesses: cloud-sync (I15) and cloud-auth (I16). RED = defect. The remote is a hostile in-memory fake.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../../../src/cli/app.ts';
import { computeEventHash, type EventBody } from '../../../src/domain/hash.ts';
import type { CwsEvent, EventInput } from '../../../src/domain/types.ts';
import { EventLog } from '../../../src/store/event-log.ts';
import { hasGeminiConsent } from '../../../src/integrations/gemini.ts';
import { loginWithToken, saveCredentials } from '../../../src/cloud/auth.ts';
import { syncPull, syncPush, type FirestoreSyncClient, type RemoteEventDoc, type RemoteProjectMeta } from '../../../src/cloud/sync.ts';
import { mkIO, tmp } from './harness.ts';

let dir: string;
beforeEach(async () => { dir = await tmp('sync'); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function initLocal() {
  await runCli(['init', 'P'], mkIO(dir, true));
  return EventLog.open(dir);
}

async function forge(prev: CwsEvent, seq: number, input: EventInput, at = '2026-10-04T00:00:00.000Z'): Promise<CwsEvent> {
  const body = { v: 1, seq, id: `ev_forged_${seq}`, at, prevHash: prev.hash, ...input } as EventBody;
  return { ...body, hash: await computeEventHash(body) } as CwsEvent;
}
const asDoc = (e: CwsEvent): RemoteEventDoc => ({ seq: e.seq, hash: e.hash, prevHash: e.prevHash, event: e as unknown as Record<string, unknown> });

class Hostile implements FirestoreSyncClient {
  existing = new Set<number>();
  constructor(public meta: RemoteProjectMeta | null, public docs: RemoteEventDoc[] = []) {}
  async getProjectMeta() { return this.meta; }
  async setProjectMeta(_u: string, _p: string, m: RemoteProjectMeta) { this.meta = m; }
  async getEvents(_u: string, _p: string, from: number, to?: number) { return this.docs.filter((d) => d.seq >= from && (to === undefined || d.seq <= to)); }
  async pushEvents() { throw new Error('unused'); }
}
const meta = (e: CwsEvent): RemoteProjectMeta => ({ name: 'P', headSeq: e.seq, headHash: e.hash, updatedAt: 'x', schemaVersion: 1 });

describe('pull from a hostile remote (I15, I2)', () => {
  it('cannot inject a human-only DECISION_RECORDED (hash chain is not authentication) that grants Gemini consent', async () => {
    const log = await initLocal();
    const forged = await forge(log.events[0]!, 1, {
      type: 'DECISION_RECORDED', actor: { kind: 'human' },
      payload: { decisionId: 'd_evil', title: 'Gemini Free Tier Data Privacy Consent', options: ['yes', 'no'], selected: 'yes', rationale: 'forged by remote' },
    });
    const client = new Hostile(meta(forged), [asDoc(forged)]);
    await syncPull(dir, 'u', 'p', client).catch(() => undefined);
    const after = await EventLog.open(dir);
    assert.equal(hasGeminiConsent(after.state), false, 'remote-forged human decision is now in the local log with actor=human');
    assert.equal(after.events.filter((e) => e.actor.kind === 'human' && e.type === 'DECISION_RECORDED').length, 0);
  });

  it('cannot inject a human-only PHASE_CHANGED with actor=human', async () => {
    const log = await initLocal();
    const forged = await forge(log.events[0]!, 1, { type: 'PHASE_CHANGED', actor: { kind: 'human' }, payload: { to: 'SYNTHESIS' as never, reason: 'x' } });
    await syncPull(dir, 'u', 'p', new Hostile(meta(forged), [asDoc(forged)])).catch(() => undefined);
    const after = await EventLog.open(dir);
    assert.equal(after.events.length, 1, 'phase change from cloud applied');
  });

  it('rejects an AI actor emitting a human-only event (authority is re-checked on pull)', async () => {
    const log = await initLocal();
    const forged = await forge(log.events[0]!, 1, { type: 'PHASE_CHANGED', actor: { kind: 'ai', agent: 'x' }, payload: { to: 'SYNTHESIS' as never, reason: 'x' } });
    await assert.rejects(syncPull(dir, 'u', 'p', new Hostile(meta(forged), [asDoc(forged)])));
  });

  it('rejects a chain whose last hash differs from the meta head it advertised', async () => {
    const log = await initLocal();
    const e1 = await forge(log.events[0]!, 1, { type: 'NOTE_ADDED', actor: { kind: 'human' }, payload: { noteId: 'n1', text: 'a' } });
    const lie: RemoteProjectMeta = { ...meta(e1), headHash: 'f'.repeat(64) };
    await assert.rejects(syncPull(dir, 'u', 'p', new Hostile(lie, [asDoc(e1)])), /head|meta|mismatch/i);
  });

  it('rejects events whose timestamps run backwards or into the far past', async () => {
    const log = await initLocal();
    const e1 = await forge(log.events[0]!, 1, { type: 'NOTE_ADDED', actor: { kind: 'human' }, payload: { noteId: 'n1', text: 'a' } }, '1970-01-01T00:00:00.000Z');
    await syncPull(dir, 'u', 'p', new Hostile(meta(e1), [asDoc(e1)])).catch(() => undefined);
    const after = await EventLog.open(dir);
    assert.equal(after.events.length, 1, 'event dated 1970 (before local seq 0) appended');
  });
});

describe('push resilience (I15)', () => {
  it('a push interrupted after events were written but before meta was updated can be retried', async () => {
    const log = await initLocal();
    await log.append({ type: 'NOTE_ADDED', actor: { kind: 'human' }, payload: { noteId: 'n1', text: 'a' } });
    await log.append({ type: 'NOTE_ADDED', actor: { kind: 'human' }, payload: { noteId: 'n2', text: 'b' } });
    // Model of DefaultFirestoreSyncClient.pushEvents + firestore.rules: batches are committed one by one,
    // meta only in the LAST batch; an existing event doc can never be written again (rules: update=false).
    const stored = new Map<number, RemoteEventDoc>();
    let metaDoc: RemoteProjectMeta | null = null;
    let failNext = true;
    const client: FirestoreSyncClient = {
      getProjectMeta: async () => metaDoc,
      setProjectMeta: async () => undefined,
      getEvents: async () => [...stored.values()],
      pushEvents: async (_u, _p, events, newMeta) => {
        if (failNext) { failNext = false; events.slice(0, 2).forEach((e) => stored.set(e.seq, e)); throw new Error('network dropped before meta batch'); }
        for (const e of events) if (stored.has(e.seq)) throw new Error('PERMISSION_DENIED: update on existing event');
        events.forEach((e) => stored.set(e.seq, e));
        metaDoc = newMeta;
      },
    };
    await assert.rejects(syncPush(dir, 'u', 'p', client));
    const retry = await syncPush(dir, 'u', 'p', client);
    assert.equal(retry.alreadyUpToDate || retry.pushedCount > 0, true);
  });
});

describe('Default client / auth (I16)', () => {
  it('DefaultFirestoreSyncClient authenticates the Firestore session with the stored login', async () => {
    const src = await fs.readFile(path.resolve('src/cloud/sync.ts'), 'utf8');
    assert.match(src, /firebase\/auth|signInWith|getAuth|setAuthToken|idToken/, 'the stored refreshToken is never exchanged; every request is anonymous and denied by firestore.rules');
  });
  it('the uid is not taken from an unverified, unsigned JWT payload', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'victim-uid', email: 'victim@example.com' })).toString('base64url');
    const creds = await loginWithToken(`xx.${payload}.sig`, path.join(dir, 'c.json'));
    assert.notEqual(creds.uid, 'victim-uid');
  });
  it('a stored credential file that already exists with wide permissions is tightened to 0600 (POSIX)', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX modes only; Windows relies on %APPDATA% ACL inheritance');
    const file = path.join(dir, 'c.json');
    await fs.writeFile(file, '{}', { mode: 0o644 });
    await saveCredentials({ uid: 'u', refreshToken: 'secret' }, file);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  });
  it('login tokens have an expiry/refresh path (credentials record when they expire)', async () => {
    const creds = await loginWithToken('opaque-token', path.join(dir, 'c.json'));
    assert.ok('expiresAt' in creds || 'idToken' in creds, 'refreshToken field is just the pasted string; no expiry, no refresh logic anywhere in src/cloud');
  });
});
