import type { Claim, Proposal, ProjectState } from '../domain/types.ts';
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

/** Keys each item kind prints itself; anything else on the item is still shown, so nothing is approved unseen. */
const SHOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  claim: ['kind', 'type', 'risk', 'text', 'derivedFrom'],
  status: ['kind', 'claimId', 'status', 'evidence', 'answer'],
  decision: ['kind', 'title', 'options', 'selected', 'rationale', 'links'],
  phase: ['kind', 'to', 'reason'],
};

function extraFields(item: Proposal['item'], state: ProjectState): string[] {
  const shown = SHOWN_KEYS[item.kind] ?? [];
  return Object.entries(item)
    .filter(([key, value]) => !shown.includes(key) && value !== undefined)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const target = key === 'supersedes' && typeof value === 'string' ? ` (${linkedText(state, value)})` : '';
      return field(key, `${text}${target}`);
    });
}

function itemFields(p: Proposal, state: ProjectState): string[] {
  return [...kindFields(p, state), ...extraFields(p.item, state)];
}

function kindFields(p: Proposal, state: ProjectState): string[] {
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

export function describeClaim(claim: Claim, state: ProjectState): string {
  return [
    `${sanitize(claim.id)} [${claim.type}] by ${actorLabel(claim.createdBy)}`,
    field('role', claim.createdBy.kind === 'ai' ? claim.createdBy.role ?? '(none)' : 'human'),
    field('status', claim.status),
    field('risk', claim.risk ?? '(none)'),
    field('confirmed', String(claim.confirmed)),
    field('phase', claim.phase),
    field('session', claim.sessionId ?? '(none)'),
    field('created at', claim.at),
    field('updated at', claim.updatedAt),
    '    text:',
    sanitize(claim.text, true),
    ...(claim.answer ? [field('answer', claim.answer)] : []),
    ...claim.derivedFrom.map((id) => field(`derived from ${id}`, linkedText(state, id))),
    ...claim.evidence.flatMap((evidence) => [
      field(`evidence ${evidence.id}`, evidence.text),
      field('source', evidence.source ?? '(none)'),
      field('evidence actor', actorLabel(evidence.actor)),
      field('evidence role', evidence.actor.kind === 'ai' ? evidence.actor.role ?? '(none)' : 'human'),
      field('evidence at', evidence.at),
    ]),
  ].join('\n');
}
