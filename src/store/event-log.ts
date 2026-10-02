import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSessionId, newId } from '../domain/ids.ts';
import { fold, reduce } from '../domain/reducer.ts';
import { parseEventInput, parseStoredEvent } from '../domain/schema.ts';
import { DomainError } from '../domain/types.ts';
import type { CwsEvent, EventInput, ProjectState } from '../domain/types.ts';

export const CWS_DIR = '.cws';
export const EVENTS_FILE = 'events.jsonl';
const LOCK_FILE = 'lock';
const GENESIS_HASH = '0'.repeat(64);
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 8000;

export interface Integrity {
  ok: boolean;
  brokenAtSeq?: number;
}

type EventBody = Omit<CwsEvent, 'hash'>;

export { assertSessionId };

export function findProjectRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, CWS_DIR, EVENTS_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** sha256(prevHash + canonical JSON) with a fixed key order, independent of parse order. */
function computeHash(e: EventBody): string {
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
  return createHash('sha256').update(e.prevHash + JSON.stringify(canonical)).digest('hex');
}

function checkIntegrity(events: readonly CwsEvent[]): Integrity {
  let prev = GENESIS_HASH;
  for (const e of events) {
    if (e.prevHash !== prev || computeHash(e) !== e.hash) return { ok: false, brokenAtSeq: e.seq };
    prev = e.hash;
  }
  return { ok: true };
}

function parseLines(raw: string): CwsEvent[] {
  const events: CwsEvent[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      events.push(parseStoredEvent(JSON.parse(line)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new DomainError('LOG_CORRUPT', `line ${i + 1}: ${reason}`);
    }
  });
  return events;
}

function parsesAsEvent(line: string): boolean {
  try {
    parseStoredEvent(JSON.parse(line));
    return true;
  } catch {
    return false;
  }
}

/**
 * The committed part of a log: every append ends with a newline, so an unterminated last
 * line that does not parse is an append still in progress (or cut off by a crash), not data.
 */
export function committedText(raw: string): string {
  const end = raw.lastIndexOf('\n') + 1;
  if (end === raw.length) return raw;
  const tail = raw.slice(end);
  return tail.trim() === '' || parsesAsEvent(tail) ? raw : raw.slice(0, end);
}

async function readEvents(file: string): Promise<CwsEvent[]> {
  return parseLines(committedText(await fs.readFile(file, 'utf8')));
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gone, or about to be: Windows answers EPERM (sometimes EBUSY) when a file another process
 * is deleting is opened, so for lock and marker files those mean "retry", like ENOENT.
 */
function isVanishing(err: unknown): boolean {
  return isErrno(err, 'ENOENT') || (process.platform === 'win32' && (isErrno(err, 'EPERM') || isErrno(err, 'EBUSY')));
}

function ownerStatus(raw: string): 'dead' | 'live' | 'unverifiable' {
  let owner: unknown;
  try {
    owner = JSON.parse(raw);
  } catch {
    return 'unverifiable';
  }
  if (typeof owner !== 'object' || owner === null || !('pid' in owner) ||
      typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return 'unverifiable';
  try {
    process.kill(owner.pid, 0);
    return 'live';
  } catch (err) {
    if (isErrno(err, 'ESRCH')) return 'dead';
    if (isErrno(err, 'EPERM')) return 'unverifiable';
    throw err;
  }
}

function recoveryBlocked(recoveryPath: string): Error {
  return new Error(`recovery blocked at ${recoveryPath}: recovery ownership is dead or unverifiable. ` +
    'Stop all CWS writers and prevent new writers from starting; verify no writer or recovery process is running. ' +
    'Then remove only the recovery marker at the path above (an empty legacy directory or owner file) and retry. ' +
    'Do not delete the lock or event log. Never remove this marker while writers may be running.');
}

async function acquireRecovery(recoveryPath: string, owner: string): Promise<boolean> {
  const preparedPath = `${recoveryPath}.${randomBytes(12).toString('hex')}.tmp`;
  await fs.writeFile(preparedPath, owner, { flag: 'wx' });
  try {
    try {
      await fs.link(preparedPath, recoveryPath);
      return true;
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err;
    }
    let current: string;
    try {
      current = await fs.readFile(recoveryPath, 'utf8');
    } catch (err) {
      if (isErrno(err, 'EISDIR')) throw recoveryBlocked(recoveryPath);
      if (isVanishing(err) && !(await isDirectory(recoveryPath))) return false;
      if (isErrno(err, 'EPERM') || isErrno(err, 'EACCES')) throw recoveryBlocked(recoveryPath);
      throw err;
    }
    if (ownerStatus(current) === 'live') return false;
    throw recoveryBlocked(recoveryPath);
  } finally {
    await fs.unlink(preparedPath);
  }
}

async function takeOver(lockPath: string, owner: string): Promise<boolean> {
  const recoveryPath = `${lockPath}.recovery`;
  if (!await acquireRecovery(recoveryPath, owner)) return false;
  try {
    const current = await fs.readFile(lockPath, 'utf8');
    if (ownerStatus(current) !== 'dead') return false;
    await fs.unlink(lockPath);
    try {
      await fs.writeFile(lockPath, owner, { flag: 'wx' });
      return true;
    } catch (err) {
      if (isErrno(err, 'EEXIST')) return false;
      throw err;
    }
  } catch (err) {
    if (isVanishing(err)) return false;
    throw err;
  } finally {
    await fs.unlink(recoveryPath);
  }
}

/** A recovery marker left as a directory (a legacy form) is abandoned, never "being deleted". */
async function isDirectory(file: string): Promise<boolean> {
  return (await fs.stat(file).catch(() => null))?.isDirectory() === true;
}

/** Acquire the lock; returns the nonce that proves ownership. */
async function acquireLock(lockPath: string): Promise<string> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const nonce = JSON.stringify({ pid: process.pid, nonce: randomBytes(12).toString('hex') });
  for (;;) {
    try {
      await fs.writeFile(lockPath, nonce, { flag: 'wx' });
      return nonce;
    } catch (err) {
      if (!isErrno(err, 'EEXIST') && !isErrno(err, 'EPERM') && !isErrno(err, 'EBUSY')) throw err;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for lock ${lockPath}. If no other cws command is running, ` +
        'the lock was left behind by a crash: check that no cws process is running, then delete only that lock file and retry.');
    }
    if (await takeOver(lockPath, nonce)) return nonce;
    await sleep(LOCK_RETRY_MS);
  }
}

/** Remove the lock only if it is still ours. */
async function releaseLock(lockPath: string, nonce: string): Promise<void> {
  const current = await fs.readFile(lockPath, 'utf8').catch(() => null);
  if (current === nonce) await fs.rm(lockPath, { force: true });
}

export class EventLog {
  private constructor(
    readonly rootDir: string,
    private _events: readonly CwsEvent[],
    private _state: ProjectState | null,
  ) {}

  private static filePath(rootDir: string): string {
    return path.join(rootDir, CWS_DIR, EVENTS_FILE);
  }

  static async init(rootDir: string, title: string): Promise<EventLog> {
    const file = EventLog.filePath(rootDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(file, '', { flag: 'wx' });
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err;
      // An empty log is an init that crashed before its first event; take it over.
      if ((await fs.stat(file)).size > 0) throw new DomainError('PROJECT_EXISTS', `project already exists in ${rootDir}`);
    }
    const log = new EventLog(rootDir, [], null);
    try {
      await log.append({ type: 'PROJECT_CREATED', actor: { kind: 'human' }, payload: { projectId: newId('p'), title } });
    } catch (err) {
      // Remove only a log that is still empty; a concurrent init may have created the project.
      if ((await fs.stat(file).catch(() => null))?.size === 0) await fs.rm(file, { force: true });
      throw err;
    }
    return log;
  }

  static async open(rootDir: string): Promise<EventLog> {
    let events: CwsEvent[];
    try {
      events = await readEvents(EventLog.filePath(rootDir));
    } catch (err) {
      if (isErrno(err, 'ENOENT')) throw new DomainError('NO_PROJECT', `no project found in ${rootDir}`);
      throw err;
    }
    const state = fold(events);
    if (!state) throw new DomainError('NO_PROJECT', `event log in ${rootDir} is empty`);
    return new EventLog(rootDir, events, state);
  }

  get state(): ProjectState {
    if (!this._state) throw new DomainError('NO_PROJECT', 'project not created yet');
    return this._state;
  }

  get events(): readonly CwsEvent[] {
    return this._events;
  }

  get integrity(): Integrity {
    return checkIntegrity(this._events);
  }

  async append(input: EventInput): Promise<CwsEvent> {
    return (await this.appendBatch([input]))[0] as CwsEvent;
  }

  /** All-or-nothing: every input is folded against the state in memory first, then written in one append. */
  async appendBatch(inputs: readonly EventInput[]): Promise<CwsEvent[]> {
    const parsed = inputs.map((i) => parseEventInput(i));
    for (const input of parsed) {
      if (input.type === 'SESSION_STARTED' || input.type === 'SESSION_ENDED') assertSessionId(input.payload.sessionId);
    }
    const lockPath = path.join(this.rootDir, CWS_DIR, LOCK_FILE);
    const nonce = await acquireLock(lockPath);
    try {
      return await this.appendLocked(parsed);
    } finally {
      await releaseLock(lockPath, nonce);
    }
  }

  private async appendLocked(inputs: readonly EventInput[]): Promise<CwsEvent[]> {
    const file = EventLog.filePath(this.rootDir);
    const full = await fs.readFile(file, 'utf8');
    const raw = committedText(full);
    // Drop a torn tail before appending; it was never committed.
    if (raw.length < full.length) await fs.truncate(file, Buffer.byteLength(raw, 'utf8'));
    const events = parseLines(raw);
    let state = fold(events);
    let prevHash = events.at(-1)?.hash ?? GENESIS_HASH;
    const added: CwsEvent[] = [];
    for (const input of inputs) {
      const body = {
        v: 1,
        seq: state ? state.lastSeq + 1 : 0,
        id: newId('ev'),
        at: new Date().toISOString(),
        ...(state?.activeSessionId === undefined ? {} : { sessionId: state.activeSessionId }),
        prevHash,
        ...input,
      } as EventBody;
      const event = { ...body, hash: computeHash(body) } as CwsEvent;
      state = reduce(state, event);
      prevHash = event.hash;
      added.push(event);
    }
    const lead = raw.length > 0 && !raw.endsWith('\n') ? '\n' : '';
    await fs.appendFile(file, lead + added.map((e) => JSON.stringify(e) + '\n').join(''));
    this._events = [...events, ...added];
    this._state = state;
    return added;
  }
}

// ---------------------------------------------------------------------------
// Whole-log verification and restore (used by backups)
// ---------------------------------------------------------------------------

export interface VerifiedLog {
  events: CwsEvent[];
  state: ProjectState;
}

/** Parse, hash-check and fold raw log text; throws on any defect, including forged authority. */
export function verifyLogText(raw: string): VerifiedLog {
  const events = parseLines(raw);
  const integrity = checkIntegrity(events);
  if (!integrity.ok) throw new DomainError('LOG_CORRUPT', `hash chain broken at seq ${integrity.brokenAtSeq}`);
  const state = fold(events);
  if (!state) throw new DomainError('NO_PROJECT', 'event log is empty');
  return { events, state };
}

export type LogRelation = 'empty' | 'same' | 'incoming-ahead' | 'local-ahead' | 'diverged';

export interface LogComparison {
  relation: LogRelation;
  /** number of identical leading events */
  common: number;
}

/**
 * How a local log relates to an incoming one. Hash fields alone prove nothing about a local
 * line that was edited in place, so a local log that fails its own chain check counts as diverged.
 */
export function compareLogs(local: readonly CwsEvent[], incoming: readonly CwsEvent[]): LogComparison {
  const shared = Math.min(local.length, incoming.length);
  let common = 0;
  while (common < shared && local[common]!.hash === incoming[common]!.hash) common++;
  if (local.length === 0) return { relation: 'empty', common };
  const integrity = checkIntegrity(local);
  if (!integrity.ok) return { relation: 'diverged', common: Math.min(common, integrity.brokenAtSeq!) };
  if (common < shared) return { relation: 'diverged', common };
  if (local.length === incoming.length) return { relation: 'same', common };
  return { relation: incoming.length > local.length ? 'incoming-ahead' : 'local-ahead', common };
}

export type RestoreOutcome = 'created' | 'fast-forward' | 'replaced' | 'same' | 'local-ahead';

/** Local events, or null when the local log exists but cannot be parsed. */
async function readLocalEvents(file: string): Promise<CwsEvent[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return [];
    throw err;
  }
  try {
    return parseLines(committedText(raw));
  } catch {
    return null;
  }
}

async function writeLogFile(file: string, raw: string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, raw, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Install verified log text under the lock. It only extends the local log, unless `replace`
 * allows overwriting a local log that diverged from it or ran ahead of it (rolling back).
 */
export async function restoreLog(rootDir: string, raw: string, replace: boolean): Promise<RestoreOutcome> {
  const incoming = verifyLogText(raw).events;
  const dir = path.join(rootDir, CWS_DIR);
  await fs.mkdir(dir, { recursive: true });
  if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error(`${CWS_DIR} must not be a symbolic link`);
  const lockPath = path.join(dir, LOCK_FILE);
  const nonce = await acquireLock(lockPath);
  try {
    const file = path.join(dir, EVENTS_FILE);
    const local = await readLocalEvents(file);
    const relation: LogRelation = local === null ? 'diverged' : compareLogs(local, incoming).relation;
    if (relation === 'same' || (relation === 'local-ahead' && !replace)) return relation;
    if (relation === 'diverged' && !replace) {
      throw new Error('the local event log is unreadable or has diverged from the backup; nothing was changed');
    }
    await writeLogFile(file, raw.endsWith('\n') ? raw : `${raw}\n`);
    if (relation === 'empty') return 'created';
    return relation === 'incoming-ahead' ? 'fast-forward' : 'replaced';
  } finally {
    await releaseLock(lockPath, nonce);
  }
}
