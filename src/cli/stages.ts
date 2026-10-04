import { PHASES, PURPOSES, type Phase, type Purpose } from '../domain/types.ts';

/** The workflow names for the nine phases (docs/workflow.md); the menu shows these. */
export const STAGE_NAMES: Readonly<Record<Phase, string>> = {
  EXPLORATION: 'Explore',
  UNDERSTANDING: 'Understand',
  SYNTHESIS: 'Synthesize',
  PROOF: 'Prove',
  CONCEPT: 'Concept',
  PLANNING: 'Plan',
  IMPLEMENTATION: 'Build',
  LAUNCH: 'Launch',
  POST_LAUNCH: 'Learn',
};

const normalize = (value: string): string => value.trim().toLowerCase().replace(/[\s-]+/g, '_');

/**
 * A phase from what a person may type: the code (`IMPLEMENTATION`), the menu name (`Build`),
 * the stage number shown in the menu (`7`), in any letter case.
 */
export function parsePhase(value: string): Phase | undefined {
  const key = normalize(value);
  if (/^\d+$/.test(key)) return PHASES[Number(key) - 1];
  return PHASES.find((phase) => phase.toLowerCase() === key || normalize(STAGE_NAMES[phase]) === key);
}

/** A purpose from what a person may type: the purpose, a stage code or a menu name, in any letter case. */
export function parsePurpose(value: string): Purpose | undefined {
  const key = normalize(value);
  const direct = PURPOSES.find((purpose) => purpose === key);
  if (direct !== undefined) return direct;
  const phase = parsePhase(value);
  if (phase === undefined || /^\d+$/.test(key)) return undefined;
  const byPhase: Readonly<Record<Phase, Purpose>> = {
    EXPLORATION: 'explore',
    UNDERSTANDING: 'understand',
    SYNTHESIS: 'synthesize',
    PROOF: 'proof',
    CONCEPT: 'concept',
    PLANNING: 'plan',
    IMPLEMENTATION: 'implement',
    LAUNCH: 'launch',
    POST_LAUNCH: 'learn',
  };
  return byPhase[phase];
}
