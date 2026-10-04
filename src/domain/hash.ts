import type { CwsEvent } from './types.ts';

export const GENESIS_HASH = '0'.repeat(64);

export type Sha256 = (text: string) => Promise<string>;

export interface ChainIntegrity {
  ok: boolean;
  brokenAtSeq?: number;
}

export type EventBody = Omit<CwsEvent, 'hash'>;

/** Standard WebCrypto SHA-256 implementation, browser and Node 19+ compatible. */
export async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fixed key order, independent of parse order, matching the CWS canonical event specification. */
export function canonicalEventString(e: EventBody): string {
  const canonical = {
    v: e.v,
    seq: e.seq,
    id: e.id,
    at: e.at,
    ...(e.sessionId === undefined ? {} : { sessionId: e.sessionId }),
    type: e.type,
    actor: e.actor,
    payload: e.payload,
    prevHash: e.prevHash,
  };
  return e.prevHash + JSON.stringify(canonical);
}

/** Compute hash for an event body using an async SHA-256 hasher (defaults to WebCrypto sha256). */
export async function computeEventHash(e: EventBody, hasher: Sha256 = sha256): Promise<string> {
  return hasher(canonicalEventString(e));
}

/** Compute hash for an event body synchronously when a sync hasher is provided (e.g. in Node CLI). */
export function computeEventHashSync(e: EventBody, syncHasher: (text: string) => string): string {
  return syncHasher(canonicalEventString(e));
}

/**
 * Verify hash-chain integrity of a sequence of events.
 * Returns { ok: true } if valid, or { ok: false, brokenAtSeq } at the first anomaly.
 */
export async function verifyChain(
  events: readonly CwsEvent[],
  hasher: Sha256 = sha256,
): Promise<ChainIntegrity> {
  let prev = GENESIS_HASH;
  for (const e of events) {
    const expectedHash = await computeEventHash(e, hasher);
    if (e.prevHash !== prev || expectedHash !== e.hash) {
      return { ok: false, brokenAtSeq: e.seq };
    }
    prev = e.hash;
  }
  return { ok: true };
}

/**
 * Verify hash-chain integrity synchronously with an injected sync hasher.
 */
export function verifyChainSync(
  events: readonly CwsEvent[],
  syncHasher: (text: string) => string,
): ChainIntegrity {
  let prev = GENESIS_HASH;
  for (const e of events) {
    const expectedHash = computeEventHashSync(e, syncHasher);
    if (e.prevHash !== prev || expectedHash !== e.hash) {
      return { ok: false, brokenAtSeq: e.seq };
    }
    prev = e.hash;
  }
  return { ok: true };
}
