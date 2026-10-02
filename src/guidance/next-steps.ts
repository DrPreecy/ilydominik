import type { NextStep, ProjectState } from '../domain/types.ts';
import { RULES } from './rules.ts';
import { assess } from './warnings.ts';

export function nextSteps(state: ProjectState, limit = 3): NextStep[] {
  const warnings = assess(state);
  const hits: NextStep[] = [];
  for (const rule of RULES) {
    const hit = rule.evaluate(state, warnings);
    if (!hit) continue;
    hits.push({ ruleId: rule.id, purpose: hit.purpose ?? rule.purpose, title: hit.title, reason: hit.reason, refs: hit.refs, priority: hit.priority ?? rule.priority });
  }
  const sorted = [...hits].sort((a, b) => b.priority - a.priority);
  return sorted.slice(0, limit);
}
