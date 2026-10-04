// Red-team witnesses for firestore.rules (I13). Run:
//   JAVA_HOME=... npx firebase emulators:exec --only firestore "node --test --import tsx tests/redteam/cloud/rules.test.ts"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';

let env: RulesTestEnvironment;
const H = 'a'.repeat(64);
const meta = (headSeq: number) => ({ name: 'p', headSeq, headHash: H, updatedAt: 'x', schemaVersion: 1 });
const ev = (seq: number) => ({ seq, hash: H, prevHash: H, event: { type: 'NOTE_ADDED' } });
const P = 'users/alice/projects/p1';

before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'run under firebase emulators:exec');
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-cws-redteam',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host, port: Number(port) },
  });
});
after(async () => { await env?.cleanup(); });

describe('rules baseline (expected GREEN)', () => {
  it('other uid cannot read or list', async () => {
    await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), P), meta(0)); await setDoc(doc(c.firestore(), `${P}/events/000000`), ev(0)); });
    const bob = env.authenticatedContext('bob').firestore();
    await assertFails(getDoc(doc(bob, P)));
    await assertFails(getDoc(doc(bob, `${P}/events/000000`)));
    await assertFails(getDocs(collection(bob, `${P}/events`)));
  });
  it('unauthenticated cannot read', async () => {
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), P)));
  });
});

describe('rules defects (RED = defect)', () => {
  it('ADR0003: dashboard (plain owner web client, no CLI claim) must not write events', async () => {
    const dash = env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(dash, `${P}/events/000100`), ev(100)));
  });
  it('ADR0003: dashboard must not write project meta', async () => {
    const dash = env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(dash, P), meta(5)));
  });
  it('event doc id must equal padded seq (id 000005 with seq 99 is a forgery)', async () => {
    const a = env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(a, `${P}/events/000005`), ev(99)));
  });
  it('event hash must look like sha256 hex', async () => {
    const a = env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(a, `${P}/events/000007`), { ...ev(7), hash: 'not-a-hash' }));
  });
  it('event doc must not accept extra fields', async () => {
    const a = env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(a, `${P}/events/000008`), { ...ev(8), junk: 'x'.repeat(10) }));
  });
  it('meta delete must be refused (append-only ledger)', async () => {
    const a = env.authenticatedContext('alice').firestore();
    await assertFails(deleteDoc(doc(a, P)));
  });
  it('meta headSeq must not roll back', async () => {
    await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), P), meta(50)); });
    const a = env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(a, P), meta(1)));
  });
  it('push retry must be idempotent: re-writing an identical event doc after a partial push must succeed', async () => {
    await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), `${P}/events/000010`), ev(10)); });
    const a = env.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(a, `${P}/events/000010`), ev(10)));
  });
  it('oversized event payload (>256KiB) must be refused by the rules', async () => {
    const a = env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(a, `${P}/events/000011`), { ...ev(11), event: { text: 'x'.repeat(300_000) } }));
  });
});
