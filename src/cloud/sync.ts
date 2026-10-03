import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyChain } from '../domain/hash.ts';
import { parseStoredEvent } from '../domain/schema.ts';
import { type CwsEvent } from '../domain/types.ts';
import { EventLog, restoreLog } from '../store/event-log.ts';

export interface RemoteProjectMeta {
  name: string;
  headSeq: number;
  headHash: string;
  updatedAt: string;
  schemaVersion: number;
}

export interface RemoteEventDoc {
  seq: number;
  hash: string;
  prevHash: string;
  event: Record<string, unknown>;
}

export interface FirestoreSyncClient {
  getProjectMeta(uid: string, projectId: string): Promise<RemoteProjectMeta | null>;
  setProjectMeta(uid: string, projectId: string, meta: RemoteProjectMeta): Promise<void>;
  getEvents(uid: string, projectId: string, fromSeq: number, toSeq?: number): Promise<RemoteEventDoc[]>;
  pushEvents(
    uid: string,
    projectId: string,
    events: RemoteEventDoc[],
    newMeta: RemoteProjectMeta,
  ): Promise<void>;
}

export function padSeq(seq: number): string {
  return String(seq).padStart(6, '0');
}

export type SyncState = 'UP_TO_DATE' | 'AHEAD' | 'BEHIND' | 'DIVERGED' | 'EMPTY_REMOTE';

export interface SyncStatusResult {
  state: SyncState;
  localHeadSeq: number;
  localHeadHash: string;
  remoteHeadSeq?: number;
  remoteHeadHash?: string;
  divergedAtSeq?: number;
}

export async function checkSyncStatus(
  rootDir: string,
  uid: string,
  projectId: string,
  client: FirestoreSyncClient,
): Promise<SyncStatusResult> {
  const log = await EventLog.open(rootDir);
  const localHeadSeq = log.state.lastSeq;
  const localHeadHash = localHeadSeq >= 0 && log.events[localHeadSeq] ? log.events[localHeadSeq].hash : '';

  const remoteMeta = await client.getProjectMeta(uid, projectId);
  if (!remoteMeta) {
    return {
      state: 'AHEAD',
      localHeadSeq,
      localHeadHash,
    };
  }

  const { headSeq: remoteHeadSeq, headHash: remoteHeadHash } = remoteMeta;

  if (localHeadSeq === remoteHeadSeq) {
    if (localHeadHash === remoteHeadHash) {
      return { state: 'UP_TO_DATE', localHeadSeq, localHeadHash, remoteHeadSeq, remoteHeadHash };
    }
    return { state: 'DIVERGED', localHeadSeq, localHeadHash, remoteHeadSeq, remoteHeadHash, divergedAtSeq: remoteHeadSeq };
  }

  if (localHeadSeq > remoteHeadSeq) {
    const localAtRemote = log.events[remoteHeadSeq];
    if (localAtRemote && localAtRemote.hash === remoteHeadHash) {
      return { state: 'AHEAD', localHeadSeq, localHeadHash, remoteHeadSeq, remoteHeadHash };
    }
    return { state: 'DIVERGED', localHeadSeq, localHeadHash, remoteHeadSeq, remoteHeadHash, divergedAtSeq: remoteHeadSeq };
  }

  // localHeadSeq < remoteHeadSeq
  const localLast = log.events[localHeadSeq];
  const remoteEvents = await client.getEvents(uid, projectId, localHeadSeq, localHeadSeq);
  const remoteAtLocal = remoteEvents[0];
  if (remoteAtLocal && localLast && remoteAtLocal.hash === localLast.hash) {
    return { state: 'BEHIND', localHeadSeq, localHeadHash, remoteHeadSeq, remoteHeadHash };
  }
  return { state: 'DIVERGED', localHeadSeq, localHeadHash, remoteHeadSeq, remoteHeadHash, divergedAtSeq: localHeadSeq };
}

export async function syncPush(
  rootDir: string,
  uid: string,
  projectId: string,
  client: FirestoreSyncClient,
): Promise<{ pushedCount: number; fromSeq: number; toSeq: number; alreadyUpToDate: boolean }> {
  const log = await EventLog.open(rootDir);
  const localEvents = log.events;
  if (localEvents.length === 0) {
    return { pushedCount: 0, fromSeq: 0, toSeq: 0, alreadyUpToDate: true };
  }

  const remoteMeta = await client.getProjectMeta(uid, projectId);

  if (!remoteMeta) {
    // First push
    const eventDocs: RemoteEventDoc[] = localEvents.map((e) => ({
      seq: e.seq,
      hash: e.hash,
      prevHash: e.prevHash,
      event: e as unknown as Record<string, unknown>,
    }));
    const lastEvent = localEvents[localEvents.length - 1];
    if (!lastEvent) {
      return { pushedCount: 0, fromSeq: 0, toSeq: 0, alreadyUpToDate: true };
    }
    const newMeta: RemoteProjectMeta = {
      name: log.state.title,
      headSeq: lastEvent.seq,
      headHash: lastEvent.hash,
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    await client.pushEvents(uid, projectId, eventDocs, newMeta);
    return {
      pushedCount: eventDocs.length,
      fromSeq: 0,
      toSeq: lastEvent.seq,
      alreadyUpToDate: false,
    };
  }

  // Check if already up to date
  const lastLocal = localEvents[localEvents.length - 1];
  if (!lastLocal) {
    return { pushedCount: 0, fromSeq: 0, toSeq: 0, alreadyUpToDate: true };
  }
  if (remoteMeta.headSeq === lastLocal.seq && remoteMeta.headHash === lastLocal.hash) {
    return { pushedCount: 0, fromSeq: lastLocal.seq, toSeq: lastLocal.seq, alreadyUpToDate: true };
  }

  // Check ancestry
  if (remoteMeta.headSeq > lastLocal.seq) {
    throw new Error('local event log is behind remote; run `cws sync pull` first');
  }

  const localAtRemote = localEvents[remoteMeta.headSeq];
  if (!localAtRemote || localAtRemote.hash !== remoteMeta.headHash) {
    throw new Error(
      `local and remote histories have DIVERGED at seq ${remoteMeta.headSeq}. Local hash: ${localAtRemote?.hash ?? '(missing)'}, remote hash: ${remoteMeta.headHash}. Nothing was pushed.`,
    );
  }

  const toPush = localEvents.slice(remoteMeta.headSeq + 1);
  if (toPush.length === 0) {
    return { pushedCount: 0, fromSeq: lastLocal.seq, toSeq: lastLocal.seq, alreadyUpToDate: true };
  }

  const eventDocs: RemoteEventDoc[] = toPush.map((e) => ({
    seq: e.seq,
    hash: e.hash,
    prevHash: e.prevHash,
    event: e as unknown as Record<string, unknown>,
  }));

  const newMeta: RemoteProjectMeta = {
    name: log.state.title,
    headSeq: lastLocal.seq,
    headHash: lastLocal.hash,
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
  };

  await client.pushEvents(uid, projectId, eventDocs, newMeta);
  return {
    pushedCount: toPush.length,
    fromSeq: toPush[0]?.seq ?? lastLocal.seq,
    toSeq: lastLocal.seq,
    alreadyUpToDate: false,
  };
}

export async function syncPull(
  rootDir: string,
  uid: string,
  projectId: string,
  client: FirestoreSyncClient,
): Promise<{ pulledCount: number; fromSeq: number; toSeq: number; alreadyUpToDate: boolean }> {
  const log = await EventLog.open(rootDir);
  const localEvents = log.events;

  const remoteMeta = await client.getProjectMeta(uid, projectId);
  if (!remoteMeta) {
    return { pulledCount: 0, fromSeq: 0, toSeq: 0, alreadyUpToDate: true };
  }

  const lastLocalSeq = log.state.lastSeq;
  const lastLocalHash = lastLocalSeq >= 0 && localEvents[lastLocalSeq] ? localEvents[lastLocalSeq].hash : '';

  if (remoteMeta.headSeq <= lastLocalSeq) {
    const localAtRemote = localEvents[remoteMeta.headSeq];
    if (localAtRemote && localAtRemote.hash === remoteMeta.headHash) {
      return { pulledCount: 0, fromSeq: lastLocalSeq, toSeq: lastLocalSeq, alreadyUpToDate: true };
    }
    throw new Error(
      `local and remote histories have DIVERGED. Local seq ${lastLocalSeq}, remote seq ${remoteMeta.headSeq} with mismatched history.`,
    );
  }

  // Remote is ahead: fetch missing events from lastLocalSeq + 1 to remoteMeta.headSeq
  const fromSeq = lastLocalSeq + 1;
  const fetched = await client.getEvents(uid, projectId, fromSeq, remoteMeta.headSeq);

  if (fetched.length === 0) {
    return { pulledCount: 0, fromSeq, toSeq: fromSeq, alreadyUpToDate: true };
  }

  // Verify and parse each remote event
  const newEvents: CwsEvent[] = [];
  let expectedSeq = fromSeq;
  let expectedPrevHash = lastLocalHash;

  for (const doc of fetched) {
    if (doc.seq !== expectedSeq) {
      throw new Error(`event sequence broken: expected seq ${expectedSeq}, got ${doc.seq}`);
    }
    if (expectedPrevHash !== '' && doc.prevHash !== expectedPrevHash) {
      throw new Error(
        `hash chain broken at seq ${doc.seq}: expected prevHash ${expectedPrevHash}, got ${doc.prevHash}`,
      );
    }

    let parsed: CwsEvent;
    try {
      parsed = parseStoredEvent(doc.event);
    } catch (e: unknown) {
      throw new Error(
        `remote event at seq ${doc.seq} does not match schema: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (parsed.seq !== doc.seq || parsed.hash !== doc.hash || parsed.prevHash !== doc.prevHash) {
      throw new Error(
        `remote event envelope at seq ${doc.seq} does not match stored document`,
      );
    }

    newEvents.push(parsed);
    expectedPrevHash = parsed.hash;
    expectedSeq++;
  }

  // Combine with existing local events and verify chain integrity
  const combined = [...localEvents, ...newEvents];
  const integrity = await verifyChain(combined);
  if (!integrity.ok) {
    throw new Error(
      `combined event integrity check failed at seq ${integrity.brokenAtSeq}`,
    );
  }

  // Install to local event log under the lock
  const rawCombined = combined.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await restoreLog(rootDir, rawCombined, false);

  const lastNew = newEvents[newEvents.length - 1];
  return {
    pulledCount: newEvents.length,
    fromSeq,
    toSeq: lastNew ? lastNew.seq : fromSeq,
    alreadyUpToDate: false,
  };
}

export class DefaultFirestoreSyncClient implements FirestoreSyncClient {
  constructor(private app?: unknown) {}

  private async getFirestore() {
    const { getFirestore } = await import('firebase/firestore');
    const { initializeApp, getApps, getApp } = await import('firebase/app');
    const app = getApps().length > 0 ? getApp() : initializeApp({ projectId: 'cws-base' });
    return getFirestore(app);
  }

  async getProjectMeta(uid: string, projectId: string): Promise<RemoteProjectMeta | null> {
    const db = await this.getFirestore();
    const { doc, getDoc } = await import('firebase/firestore');
    const snap = await getDoc(doc(db, `users/${uid}/projects/${projectId}`));
    if (!snap.exists()) return null;
    return snap.data() as RemoteProjectMeta;
  }

  async setProjectMeta(uid: string, projectId: string, meta: RemoteProjectMeta): Promise<void> {
    const db = await this.getFirestore();
    const { doc, setDoc } = await import('firebase/firestore');
    await setDoc(doc(db, `users/${uid}/projects/${projectId}`), meta);
  }

  async getEvents(uid: string, projectId: string, fromSeq: number, toSeq?: number): Promise<RemoteEventDoc[]> {
    const db = await this.getFirestore();
    const { collection, getDocs, orderBy, query, where } = await import('firebase/firestore');
    const eventsRef = collection(db, `users/${uid}/projects/${projectId}/events`);
    const constraints = [where('seq', '>=', fromSeq), orderBy('seq', 'asc')];
    if (toSeq !== undefined) {
      constraints.push(where('seq', '<=', toSeq));
    }
    const q = query(eventsRef, ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as RemoteEventDoc);
  }

  async pushEvents(
    uid: string,
    projectId: string,
    events: RemoteEventDoc[],
    newMeta: RemoteProjectMeta,
  ): Promise<void> {
    const db = await this.getFirestore();
    const { doc, writeBatch } = await import('firebase/firestore');

    const BATCH_SIZE = 450;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const chunk = events.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(db);
      for (const e of chunk) {
        const ref = doc(db, `users/${uid}/projects/${projectId}/events/${padSeq(e.seq)}`);
        batch.set(ref, e);
      }
      if (i + BATCH_SIZE >= events.length) {
        const metaRef = doc(db, `users/${uid}/projects/${projectId}`);
        batch.set(metaRef, newMeta);
      }
      await batch.commit();
    }
  }
}
