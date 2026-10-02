import type { Actor, Claim, CwsEvent, ProjectState, ProposedItem, Warning } from '../domain/types.ts';
import { awaitsReview } from '../guidance/warnings.ts';

const MAX_TEXT = 100;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Strip terminal control characters from stored text; tabs/newlines become spaces unless kept. */
export function sanitize(text: string, keepNewlines = false): string {
  const clean = text.replace(CONTROL, '');
  return keepNewlines ? clean : clean.replace(/[\t\n]/g, ' ');
}

export function oneLine(text: string, max = MAX_TEXT): string {
  const flat = sanitize(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function actorLabel(actor: Actor): string {
  return actor.kind === 'human' ? 'human' : `ai:${sanitize(actor.agent)}`;
}

export function summarizeItem(item: ProposedItem): string {
  return sanitize(summarizeRaw(item));
}

function summarizeRaw(item: ProposedItem): string {
  switch (item.kind) {
    case 'claim': return `claim ${item.type}: ${oneLine(item.text)}`;
    case 'status': return `status ${item.claimId} → ${item.status}`;
    case 'decision': return `decision "${oneLine(item.title)}" → ${oneLine(item.selected)}`;
    case 'phase': return `phase → ${item.to} (${oneLine(item.reason)})`;
  }
}

export function describeEvent(e: CwsEvent): string {
  switch (e.type) {
    case 'PROJECT_CREATED': return `"${e.payload.title}"`;
    case 'NOTE_ADDED': return `${e.payload.noteId} "${oneLine(e.payload.text)}"`;
    case 'SESSION_STARTED': return `${e.payload.sessionId} goal: ${oneLine(e.payload.goal)}`;
    case 'SESSION_ENDED': return `${e.payload.sessionId}${e.payload.summary ? ` summary: ${oneLine(e.payload.summary)}` : ''}`;
    case 'CLAIM_ADDED': return `${e.payload.claimId} ${e.payload.type}${e.payload.risk ? ` risk ${e.payload.risk}` : ''}: ${oneLine(e.payload.text)}`;
    case 'CLAIM_CONFIRMED': return `${e.payload.claimId}${e.payload.asType ? ` as ${e.payload.asType}` : ''}`;
    case 'CLAIM_STATUS_CHANGED': return `${e.payload.claimId} → ${e.payload.status}${e.payload.evidence ? ` (${oneLine(e.payload.evidence)})` : ''}`;
    case 'EVIDENCE_ADDED': return `${e.payload.evidenceId} for ${e.payload.claimId}: ${oneLine(e.payload.text)}`;
    case 'PROPOSAL_SUBMITTED': return `${e.payload.proposalId} ${summarizeItem(e.payload.item)}`;
    case 'PROPOSAL_ACCEPTED': return `${e.payload.proposalId} → ${e.payload.resultId}`;
    case 'PROPOSAL_REJECTED': return `${e.payload.proposalId}${e.payload.note ? ` (${oneLine(e.payload.note)})` : ''}`;
    case 'DECISION_RECORDED': return `${e.payload.decisionId} "${oneLine(e.payload.title)}" → ${oneLine(e.payload.selected)}`;
    case 'PHASE_CHANGED': return `→ ${e.payload.to} (${oneLine(e.payload.reason)})`;
  }
}

export function eventLine(e: CwsEvent): string {
  return sanitize(`#${e.seq} ${e.at} ${actorLabel(e.actor)} ${e.type} ${describeEvent(e)}`);
}

export function warningLine(w: Warning): string {
  return sanitize(`[${w.severity}] ${w.code}: ${w.message}`);
}

export function claimLine(c: Claim): string {
  return sanitize(`${c.id} ${c.type}${c.risk ? ` risk ${c.risk}` : ''} ${c.status}: ${oneLine(c.text)}`);
}

export function aiClaimLine(c: Claim): string {
  return `${claimLine(c)} — by ${actorLabel(c.createdBy)}`;
}

export function claimCounts(state: ProjectState): string {
  const byType = new Map<string, number>();
  for (const c of state.claims) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  const parts = [...byType].map(([type, n]) => `${n} ${type}`);
  return `${state.claims.length} claims${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

export function pendingProposals(state: ProjectState) {
  return state.proposals.filter((p) => p.status === 'PENDING');
}

export function unconfirmedAiClaims(state: ProjectState): Claim[] {
  return state.claims.filter(awaitsReview);
}
