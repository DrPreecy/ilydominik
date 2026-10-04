import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeEventHashSync, GENESIS_HASH } from '../../../src/domain/hash.ts';
import type { EventBody } from '../../../src/domain/hash.ts';
import type { Actor, CwsEvent, EventInput } from '../../../src/domain/types.ts';

export const HUMAN: Actor = { kind: 'human' };
export const AI: Actor = { kind: 'ai', agent: 'redteam', role: 'attacker' };
export const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
export const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'cws-rt-'));

export interface Forge {
  input: EventInput;
  at?: string;
  id?: string;
  seq?: number;
  sessionId?: string | null; // null = omit even if session active
}

/** Chain-valid log with caller-controlled (possibly lying) content. Hashes are correct. */
export function forge(specs: Forge[]): CwsEvent[] {
  const out: CwsEvent[] = [];
  let prev = GENESIS_HASH;
  let activeSession: string | undefined;
  let t = Date.parse('2026-10-02T10:00:00.000Z');
  specs.forEach((s, i) => {
    t += 1000;
    const sessionId = s.sessionId === null ? undefined : (s.sessionId ?? activeSession);
    const body = {
      v: 1,
      seq: s.seq ?? i,
      id: s.id ?? `ev_forged_${i}`,
      at: s.at ?? new Date(t).toISOString(),
      ...(sessionId === undefined ? {} : { sessionId }),
      prevHash: prev,
      ...s.input,
    } as EventBody;
    const e = { ...body, hash: computeEventHashSync(body, sha) } as CwsEvent;
    out.push(e);
    prev = e.hash;
    if (s.input.type === 'SESSION_STARTED') activeSession = s.input.payload.sessionId;
    if (s.input.type === 'SESSION_ENDED') activeSession = undefined;
  });
  return out;
}

export const toRaw = (events: readonly CwsEvent[]): string => events.map((e) => JSON.stringify(e) + '\n').join('');

type CT = 'FACT' | 'USER_STATEMENT' | 'INTERPRETATION' | 'ASSUMPTION' | 'HYPOTHESIS' | 'UNKNOWN';
type CS = 'OPEN' | 'TESTING' | 'SUPPORTED' | 'FALSIFIED' | 'ANSWERED' | 'RETIRED';

export const created = (): Forge => ({ input: { type: 'PROJECT_CREATED', actor: HUMAN, payload: { projectId: 'p_1', title: 'T' } } });
export const claim = (id: string, type: CT, actor: Actor = HUMAN): Forge => ({
  input: { type: 'CLAIM_ADDED', actor, payload: { claimId: id, type, text: `claim ${id}` } },
});
export const status = (claimId: string, st: CS, actor: Actor = HUMAN): Forge => ({
  input: { type: 'CLAIM_STATUS_CHANGED', actor, payload: { claimId, status: st, ...(st === 'ANSWERED' ? { answer: 'a' } : {}) } },
});
