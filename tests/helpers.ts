import { reduce } from '../src/domain/reducer.ts';
import type { Actor, CwsEvent, EventInput, ProjectState } from '../src/domain/types.ts';

export const HUMAN: Actor = { kind: 'human' };
export const AI: Actor = { kind: 'ai', agent: 'copilot', role: 'analyst' };

let clock = Date.parse('2026-10-02T10:00:00.000Z');

/** Builds a CwsEvent the way the store would (hashes are irrelevant to the reducer). */
export function stamp(state: ProjectState | null, input: EventInput): CwsEvent {
  clock += 1000;
  return {
    ...input,
    v: 1,
    seq: state ? state.lastSeq + 1 : 0,
    id: `ev_${clock}`,
    at: new Date(clock).toISOString(),
    sessionId: state?.activeSessionId,
    prevHash: 'x',
    hash: 'y',
  } as CwsEvent;
}

export function run(inputs: EventInput[], start: ProjectState | null = null): ProjectState {
  let s = start;
  for (const input of inputs) s = reduce(s, stamp(s, input));
  if (!s) throw new Error('no state');
  return s;
}

export function step(state: ProjectState, input: EventInput): ProjectState {
  return reduce(state, stamp(state, input));
}

export function project(): ProjectState {
  return run([{ type: 'PROJECT_CREATED', actor: HUMAN, payload: { projectId: 'p_1', title: 'Test' } }]);
}

/**
 * A made-up credential for masking tests. The `~` breaks the token up in the source so secret
 * scanners (GitGuardian, push protection) do not report test data; it is removed at runtime.
 */
export const fakeSecret = (text: string): string => text.replaceAll('~', '');

export function errCode(code: string) {
  return (e: unknown) => e instanceof Error && e.message.includes(`[${code}]`);
}
