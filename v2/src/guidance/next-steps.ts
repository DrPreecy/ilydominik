import type { NextStep, ProjectState } from '../domain/types.ts';
import { RULES } from './rules.ts';
import { assess } from './warnings.ts';

const GUARANTEED_RULES = ['phase-default', 'empty-project'];

export function nextSteps(state: ProjectState, limit = 3): NextStep[] {
  const warnings = assess(state);
  const hits: NextStep[] = [];
  for (const rule of RULES) {
    const hit = rule.evaluate(state, warnings);
    if (!hit) continue;
    hits.push({ ruleId: rule.id, purpose: hit.purpose ?? rule.purpose, title: hit.title, reason: hit.reason, refs: hit.refs, priority: hit.priority ?? rule.priority });
  }
  const sorted = [...hits].sort((a, b) => b.priority - a.priority);
  const top = sorted.slice(0, limit);
  const guaranteed = sorted.find((s) => GUARANTEED_RULES.includes(s.ruleId));
  if (!guaranteed || top.includes(guaranteed) || top.length === 0) return top;
  return [...top.slice(0, -1), guaranteed];
}
