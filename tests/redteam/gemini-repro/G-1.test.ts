import { after, before, test } from 'node:test';
import { assertFails } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { ev, meta, mkEnv, pad } from './_env.ts';
let env: RulesTestEnvironment;
before(async () => { env = await mkEnv(); });
after(async () => { await env?.cleanup(); });
// ADR0003: dashboard is read-only. A dashboard session is the owner's plain web client (no CLI-only claim).
test('dashboard (owner, plain web client) must not write project meta', async () => {
  const dash = env.authenticatedContext('u1').firestore();
  await assertFails(setDoc(doc(dash, 'users/u1/projects/p1'), meta(3)));
});
test('dashboard (owner, plain web client) must not append events', async () => {
  const dash = env.authenticatedContext('u1').firestore();
  await assertFails(setDoc(doc(dash, `users/u1/projects/p1/events/${pad(0)}`), ev(0)));
});
