import { PHASES } from '../domain/types.ts';
import type { Claim, IntendedAction, Phase, ProjectState, Warning, WarningSeverity } from '../domain/types.ts';

const MAX_TEXT = 80;
const LATE_PHASES: readonly Phase[] = ['IMPLEMENTATION', 'LAUNCH', 'POST_LAUNCH'];
const SEVERITY_ORDER: Record<WarningSeverity, number> = { serious: 0, caution: 1, info: 2 };
const PHASE_WARNING_CODES = ['UNTESTED_RISK', 'FALSIFIED_PREMISE', 'OPEN_CRITICAL_UNKNOWN', 'PHASE_SKIP', 'OVERRIDE_UNRESOLVED'];

/** Every code `assess(state)` can raise without an intended action; each needs a next-step rule. */
export const STATUS_WARNING_CODES = [
  'UNTESTED_RISK',
  'FALSIFIED_PREMISE',
  'OPEN_CRITICAL_UNKNOWN',
  'SUPPORTED_WITHOUT_EVIDENCE',
  'OVERRIDE_UNRESOLVED',
  'PENDING_PROPOSALS',
  'UNCONFIRMED_AI_CLAIMS',
] as const;

/** Statuses only a human can set (directly or by accepting a proposal): the claim has had its verdict. */
const VERDICTS: readonly Claim['status'][] = ['SUPPORTED', 'FALSIFIED', 'ANSWERED', 'RETIRED'];

/** An AI claim nobody has looked at yet: not confirmed, and no human verdict on it. */
export function awaitsReview(c: Claim): boolean {
  return c.createdBy.kind === 'ai' && !c.confirmed && !VERDICTS.includes(c.status);
}

export function shorten(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function quoteList(claims: readonly Claim[]): string {
  return claims.map((c) => `"${shorten(c.text)}"`).join(', ');
}

const isHighRisk = (c: Claim) => c.risk === 'HIGH' || c.risk === 'FATAL';
const isPremise = (c: Claim) => (c.type === 'ASSUMPTION' || c.type === 'HYPOTHESIS') && isHighRisk(c);
const isUnresolved = (c: Claim) => c.status === 'OPEN' || c.status === 'TESTING';
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function warning(code: string, severity: WarningSeverity, message: string, refs: string[]): Warning {
  return { code, severity, message, refs };
}

function untestedRisk(state: ProjectState, action: IntendedAction): Warning[] {
  const claims = state.claims.filter((c) => isPremise(c) && isUnresolved(c));
  if (claims.length === 0) return [];
  const target = action.kind === 'phase' && LATE_PHASES.includes(action.to) ? action.to : null;
  const where = target ? ` before moving to ${target}` : '';
  const message = `${claims.length} risky ${plural(claims.length, 'idea is', 'ideas are')} still untested${where}: ${quoteList(claims)}. If they turn out wrong, a lot may have to be redone.`;
  return [warning('UNTESTED_RISK', target ? 'serious' : 'caution', message, claims.map((c) => c.id))];
}

function falsifiedPremises(state: ProjectState): Warning[] {
  return state.claims
    .filter((c) => isPremise(c) && c.status === 'FALSIFIED')
    .map((c) => {
      const claims = state.claims.filter((x) => x.derivedFrom.includes(c.id));
      const decisions = state.decisions.filter((d) => d.links.includes(c.id));
      const refs = [...new Set([c.id, ...claims.map((x) => x.id), ...decisions.map((d) => d.id)])];
      const rest = refs.length - 1;
      const impact = rest > 0 ? ` ${rest} other ${plural(rest, 'item depends', 'items depend')} on it.` : '';
      return warning('FALSIFIED_PREMISE', 'serious', `"${shorten(c.text)}" was shown to be false.${impact} Consider revisiting what was built on it.`, refs);
    });
}

function openUnknowns(state: ProjectState): Warning[] {
  const claims = state.claims.filter((c) => c.type === 'UNKNOWN' && isHighRisk(c) && isUnresolved(c));
  if (claims.length === 0) return [];
  const message = `Important ${plural(claims.length, 'question is', 'questions are')} still open: ${quoteList(claims)}.`;
  return [warning('OPEN_CRITICAL_UNKNOWN', 'caution', message, claims.map((c) => c.id))];
}

function supportedWithoutEvidence(state: ProjectState): Warning[] {
  const claims = state.claims.filter((c) => c.status === 'SUPPORTED' && c.evidence.length === 0);
  if (claims.length === 0) return [];
  const message = `Marked as supported, but no evidence is recorded: ${quoteList(claims)}.`;
  return [warning('SUPPORTED_WITHOUT_EVIDENCE', 'caution', message, claims.map((c) => c.id))];
}

function unresolvedOverrides(state: ProjectState): Warning[] {
  const out: Warning[] = [];
  for (const d of state.decisions) {
    if (d.kind !== 'PROCEED_UNDER_UNCERTAINTY') continue;
    const open = state.claims.filter((c) => d.links.includes(c.id) && isUnresolved(c));
    if (open.length === 0) continue;
    const message = `On ${d.at.slice(0, 10)} you decided to go ahead anyway ("${shorten(d.title)}"), and these are still unresolved: ${quoteList(open)}.`;
    out.push(warning('OVERRIDE_UNRESOLVED', 'caution', message, [d.id, ...open.map((c) => c.id)]));
  }
  return out;
}

function pendingProposals(state: ProjectState): Warning[] {
  const pending = state.proposals.filter((p) => p.status === 'PENDING');
  if (pending.length === 0) return [];
  const message = `${pending.length} ${plural(pending.length, 'suggestion is', 'suggestions are')} waiting for your decision (accept or reject).`;
  return [warning('PENDING_PROPOSALS', 'info', message, pending.map((p) => p.id))];
}

function unconfirmedAi(state: ProjectState): Warning[] {
  const claims = state.claims.filter(awaitsReview);
  if (claims.length === 0) return [];
  const message = `${claims.length} ${plural(claims.length, 'AI guess has', 'AI guesses have')} not been confirmed by you yet: ${quoteList(claims)}.`;
  return [warning('UNCONFIRMED_AI_CLAIMS', 'info', message, claims.map((c) => c.id))];
}

function phaseSkip(state: ProjectState, action: IntendedAction): Warning[] {
  if (action.kind !== 'phase') return [];
  const from = PHASES.indexOf(state.phase);
  const to = PHASES.indexOf(action.to);
  if (to - from <= 1) return [];
  const skipped = PHASES.slice(from + 1, to);
  return [warning('PHASE_SKIP', 'caution', `Skipping ${skipped.join(', ')} on the way to ${action.to}. That is allowed, just make sure it is on purpose.`, [])];
}

export function assess(state: ProjectState, action: IntendedAction = { kind: 'none' }): Warning[] {
  const all = [
    ...untestedRisk(state, action),
    ...falsifiedPremises(state),
    ...openUnknowns(state),
    ...supportedWithoutEvidence(state),
    ...unresolvedOverrides(state),
    ...pendingProposals(state),
    ...unconfirmedAi(state),
    ...phaseSkip(state, action),
  ];
  return all.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function phaseWarnings(state: ProjectState, to: Phase): Warning[] {
  if (PHASES.indexOf(to) <= PHASES.indexOf(state.phase)) return [];
  return assess(state, { kind: 'phase', to }).filter((w) => PHASE_WARNING_CODES.includes(w.code));
}
