import { newId } from '../domain/ids.ts';
import type { EventInput, Phase, ProjectState, Warning } from '../domain/types.ts';
import { phaseWarnings } from '../guidance/warnings.ts';

const HUMAN = { kind: 'human' } as const;

export const isRisky = (w: Warning): boolean => w.severity === 'caution' || w.severity === 'serious';

/** Warnings that must be acknowledged before moving to `to`, or none. */
export function riskyPhaseWarnings(state: ProjectState, to: Phase): Warning[] {
  const warnings = phaseWarnings(state, to);
  return warnings.some(isRisky) ? warnings : [];
}

/** Build the monitored decision for the same batch as the operation it authorizes. */
export function overrideInput(state: ProjectState, to: Phase, warnings: Warning[], why: string): EventInput {
  const known = new Set(state.claims.map((c) => c.id));
  const links = [...new Set(warnings.flatMap((w) => w.refs).filter((r) => known.has(r)))];
  return {
    type: 'DECISION_RECORDED',
    actor: HUMAN,
    payload: {
      decisionId: newId('d'),
      title: `Proceed to ${to} under uncertainty`,
      options: ['proceed', 'wait'],
      selected: 'proceed',
      rationale: why,
      links,
      kind: 'PROCEED_UNDER_UNCERTAINTY',
    },
  };
}
