import { randomBytes } from 'node:crypto';
import { DomainError } from './types.ts';

const ID_HEX_LENGTH = 12;

/** `${prefix}_` followed by 12 lowercase hex characters. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(ID_HEX_LENGTH / 2).toString('hex')}`;
}

/** Session ids name handoff files, so they must be filename-safe on every platform. */
export function assertSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(sessionId)) {
    throw new DomainError('INVALID_EVENT', 'session identifier must be filename-safe (letters, digits, underscores or hyphens, at most 128 characters)');
  }
}
