import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { DefaultFirestoreSyncClient } from '../../../src/cloud/sync.ts';
import { ev, mkEnv, pad } from './_env.ts';
let env: RulesTestEnvironment;
before(async () => { env = await mkEnv(); });
after(async () => { await env?.cleanup(); });
test('getEvents must page its reads (limit/startAfter), not fetch the whole gap in one query', async () => {
  const db = env.authenticatedContext('u1').firestore();
  await env.withSecurityRulesDisabled(async (c) => {
    for (let i = 0; i < 1200; i++) await setDoc(doc(c.firestore(), `users/u1/projects/p1/events/${pad(i)}`), ev(i));
  });
  const client = new DefaultFirestoreSyncClient() as unknown as { getFirestore: () => Promise<unknown>; getEvents: Function };
  client.getFirestore = async () => db;
  const got = await client.getEvents('u1', 'p1', 0, 1199);
  assert.equal(got.length, 1200); // functional: everything comes back (in one unbounded query)
  const src = fs.readFileSync('src/cloud/sync.ts', 'utf8');
  const body = src.slice(src.indexOf('async getEvents'), src.indexOf('async pushEvents'));
  assert.match(body, /limit\(|startAfter\(/, 'getEvents has no limit()/startAfter() paging');
});
