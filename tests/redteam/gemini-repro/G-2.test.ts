import { after, before, test } from 'node:test';
import { assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { DefaultFirestoreSyncClient } from '../../../src/cloud/sync.ts';
import { ev, H, meta, mkEnv, pad } from './_env.ts';
let env: RulesTestEnvironment;
before(async () => { env = await mkEnv(); });
after(async () => { await env?.cleanup(); });
test('retry of a push whose batch 1 committed but batch 2 failed must succeed', async () => {
  const db = env.authenticatedContext('u1').firestore();
  const N = 460; // BATCH_SIZE 450 -> two batches, meta only in the last
  const docs = Array.from({ length: N }, (_, i) => ev(i));
  // state after crash between batch 1 and 2: first 450 events committed, remote meta absent
  await env.withSecurityRulesDisabled(async (c) => {
    for (let i = 0; i < 450; i++) await setDoc(doc(c.firestore(), `users/u1/projects/p1/events/${pad(i)}`), ev(i));
  });
  const client = new DefaultFirestoreSyncClient() as unknown as { getFirestore: () => Promise<unknown>; pushEvents: Function };
  client.getFirestore = async () => db; // same code path, emulator db with u1 auth
  // syncPush would resend from seq 0 because remote meta is absent (src/cloud/sync.ts first-push branch)
  await assertSucceeds(client.pushEvents('u1', 'p1', docs, { ...meta(N - 1), headHash: H }));
});

test('[extra] a fresh first push of 25 events (single batch) must succeed (exists() call limit is 20 per multi-doc write)', async () => {
  const db = env.authenticatedContext('u2').firestore();
  const client = new DefaultFirestoreSyncClient() as unknown as { getFirestore: () => Promise<unknown>; pushEvents: Function };
  client.getFirestore = async () => db;
  await assertSucceeds(client.pushEvents('u2', 'p1', Array.from({ length: 25 }, (_, i) => ev(i)), meta(24)));
});
test('[extra] first push of 15 events succeeds (control)', async () => {
  const db = env.authenticatedContext('u3').firestore();
  const client = new DefaultFirestoreSyncClient() as unknown as { getFirestore: () => Promise<unknown>; pushEvents: Function };
  client.getFirestore = async () => db;
  await assertSucceeds(client.pushEvents('u3', 'p1', Array.from({ length: 15 }, (_, i) => ev(i)), meta(14)));
});
test('[extra] fresh first push of 460 events (no prior partial state) must succeed', async () => {
  const db = env.authenticatedContext('u4').firestore();
  const client = new DefaultFirestoreSyncClient() as unknown as { getFirestore: () => Promise<unknown>; pushEvents: Function };
  client.getFirestore = async () => db;
  await assertSucceeds(client.pushEvents('u4', 'p1', Array.from({ length: 460 }, (_, i) => ev(i)), meta(459)));
});
test('[extra] fresh first push of 120 events must succeed', async () => {
  const db = env.authenticatedContext('u5').firestore();
  const client = new DefaultFirestoreSyncClient() as unknown as { getFirestore: () => Promise<unknown>; pushEvents: Function };
  client.getFirestore = async () => db;
  await assertSucceeds(client.pushEvents('u5', 'p1', Array.from({ length: 120 }, (_, i) => ev(i)), meta(119)));
});
