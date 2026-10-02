import type { Proposal, ProjectState } from '../domain/types.ts';
import { actorLabel, sanitize } from './format.ts';

const PAD = '      ';

/** Full, untruncated, sanitized text, indented under its label. */
function field(label: string, value: string): string {
  return `    ${label}: ${sanitize(value, true).replace(/\r?\n/g, `\n${PAD}`)}`;
}

function linkedText(state: ProjectState, id: string): string {
  const claim = state.claims.find((c) => c.id === id);
  if (claim) return claim.text;
  const decision = state.decisions.find((d) => d.id === id);
  if (decision) return decision.title;
  return state.notes.find((n) => n.id === id)?.text ?? '(not found)';
}

function itemFields(p: Proposal, state: ProjectState): string[] {
  const item = p.item;
  switch (item.kind) {
    case 'claim':
      return [
        field('type', item.type),
        field('risk', item.risk ?? '(none)'),
        field('text', item.text),
        ...(item.derivedFrom?.length ? [field('derived from', item.derivedFrom.join(', '))] : []),
      ];
    case 'status': {
      const claim = state.claims.find((c) => c.id === item.claimId);
      return [
        field('claim', `${item.claimId}${claim ? ` (${claim.status})` : ''}`),
        field('claim text', claim?.text ?? '(not found)'),
        field('new status', item.status),
        ...(item.evidence ? [field('evidence', item.evidence)] : []),
        ...(item.answer ? [field('answer', item.answer)] : []),
      ];
    }
    case 'decision':
      return [
        field('title', item.title),
        ...item.options.map((o, i) => field(`option ${i + 1}`, o)),
        field('selected', item.selected),
        field('rationale', item.rationale),
        ...(item.links ?? []).map((id) => field(`link ${id}`, linkedText(state, id))),
      ];
    case 'phase':
      return [field('phase', `${state.phase} -> ${item.to}`), field('reason', item.reason)];
  }
}

/** Everything authoritative about a proposal, so the human sees what they approve. */
export function describeProposal(p: Proposal, state: ProjectState): string {
  const head = `${sanitize(p.id)} [${p.item.kind}] by ${actorLabel(p.actor)}`;
  const why = p.rationale ? [field('proposal rationale', p.rationale)] : [];
  return [head, ...itemFields(p, state), ...why].join('\n');
}
