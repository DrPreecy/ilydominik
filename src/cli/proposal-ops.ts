import { newId } from '../domain/ids.ts';
import { DomainError, type Proposal, type Warning } from '../domain/types.ts';
import type { EventLog } from '../store/event-log.ts';
import { warningLine } from './format.ts';
import { describeError, say, warn, type Env } from './human.ts';
import { overrideInput, riskyPhaseWarnings } from './override.ts';

const HUMAN = { kind: 'human' } as const;

/** Id of the thing a proposal turns into once accepted. */
function resultIdFor(p: Proposal): string {
  switch (p.item.kind) {
    case 'claim': return newId('c');
    case 'decision': return newId('d');
    case 'status': return p.item.claimId;
    case 'phase': return p.id;
  }
}

export async function acceptOne(log: EventLog, p: Proposal): Promise<string> {
  const resultId = resultIdFor(p);
  await log.append({ type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: p.id, resultId } });
  return resultId;
}

export async function rejectOne(log: EventLog, p: Proposal, note?: string): Promise<void> {
  const payload = note ? { proposalId: p.id, note } : { proposalId: p.id };
  await log.append({ type: 'PROPOSAL_REJECTED', actor: HUMAN, payload });
}

/** Warnings that need an explicit risk acknowledgement before this proposal can be accepted. */
export function proposalRisk(log: EventLog, p: Proposal): Warning[] {
  return p.item.kind === 'phase' ? riskyPhaseWarnings(log.state, p.item.to) : [];
}

/** Record the override (when risky) and accept. */
export async function acceptWithRisk(log: EventLog, p: Proposal, warnings: Warning[], why?: string): Promise<string> {
  const resultId = resultIdFor(p);
  const overrides = warnings.length > 0 && why && p.item.kind === 'phase'
    ? [overrideInput(log.state, p.item.to, warnings, why)] : [];
  await log.appendBatch([
    ...overrides,
    { type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: p.id, resultId } },
  ]);
  return resultId;
}

/** Run one step; a domain error is reported so the caller's loop continues. False means the step was skipped. */
export async function guarded(env: Env, id: string, step: () => Promise<void>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch (error: unknown) {
    if (!(error instanceof DomainError)) throw error;
    warn(env, `skipped ${id}: ${describeError(error)}`);
    return false;
  }
}

export function printRisk(env: Env, warnings: Warning[]): void {
  say(env, ...warnings.map((w) => `  ${warningLine(w)}`));
}
