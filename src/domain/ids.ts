import { randomBytes } from 'node:crypto';

const ID_HEX_LENGTH = 12;

/** `${prefix}_` followed by 12 lowercase hex characters. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(ID_HEX_LENGTH / 2).toString('hex')}`;
}
