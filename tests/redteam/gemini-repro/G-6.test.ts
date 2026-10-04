import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyLogText } from '../../../src/store/event-log.ts';
import { forge, created, claim, toRaw, HUMAN } from '../store/util.ts';
const events = forge([created(), claim('c1', 'FACT')]);
const raw = toRaw(events);
test('baseline verifies', () => { verifyLogText(raw); });
test('whitespace-only byte change must fail verify (I1 literal)', () => {
  const changed = raw.split('\n').filter(Boolean).map((l) => JSON.stringify(JSON.parse(l), null, 1).replace(/\n\s*/g, ' ')).join('\n') + '\n';
  assert.notEqual(changed, raw);
  assert.throws(() => verifyLogText(changed));
});
test('key-order change must fail verify (I1 literal)', () => {
  const changed = raw.split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); return JSON.stringify(Object.fromEntries(Object.entries(o).reverse())); }).join('\n') + '\n';
  assert.notEqual(changed, raw);
  assert.throws(() => verifyLogText(changed));
});
test('unknown extra key outside hash must not survive into parsed events', () => {
  const lines = raw.split('\n').filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), evil: 'x' }));
  let ev: unknown[] | undefined;
  try { ev = verifyLogText(lines.join('\n') + '\n').events; } catch { return; }
  assert.ok(!ev!.some((e) => 'evil' in (e as object)), 'unhashed key retained in memory');
});
test('semantic content (payload/actor) change still fails', () => {
  const lines = raw.split('\n').filter(Boolean);
  const o = JSON.parse(lines[1]!); o.payload.text = 'tampered';
  lines[1] = JSON.stringify(o);
  assert.throws(() => verifyLogText(lines.join('\n') + '\n'));
});
