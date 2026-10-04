import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
export const H = 'a'.repeat(64);
export const meta = (headSeq: number) => ({ name: 'p', headSeq, headHash: H, updatedAt: 'x', schemaVersion: 1 });
export const ev = (seq: number) => ({ seq, hash: H, prevHash: H, event: { type: 'NOTE_ADDED' } });
export const pad = (n: number) => String(n).padStart(6, '0');
export async function mkEnv(): Promise<RulesTestEnvironment> {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'run under firebase emulators:exec');
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  return initializeTestEnvironment({
    projectId: 'demo-cws-gemrepro',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host, port: Number(port) },
  });
}
