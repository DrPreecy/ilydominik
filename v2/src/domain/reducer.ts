import { AI_ALLOWED_CLAIM_TYPES, DomainError, HUMAN_ONLY_EVENTS, PHASES } from './types.ts';
import { CLAIM_TYPE_STATUSES } from './types.ts';
import type {
  Actor,
  Claim,
  CwsEvent,
  Decision,
  EventPayloads,
  Evidence,
  Phase,
  ProjectState,
  ProposedItem,
} from './types.ts';

type StatusChange = EventPayloads['CLAIM_STATUS_CHANGED'];
type DecisionFields = Omit<EventPayloads['DECISION_RECORDED'], 'decisionId'>;
type Of<T extends CwsEvent['type']> = CwsEvent & { type: T };

const EVENT_TYPES: readonly string[] = [
  'PROJECT_CREATED', 'NOTE_ADDED', 'SESSION_STARTED', 'SESSION_ENDED', 'CLAIM_ADDED', 'CLAIM_CONFIRMED',
  'CLAIM_STATUS_CHANGED', 'EVIDENCE_ADDED', 'PROPOSAL_SUBMITTED', 'PROPOSAL_ACCEPTED', 'PROPOSAL_REJECTED',
  'DECISION_RECORDED', 'PHASE_CHANGED',
];

/** `{ key: value }`, or `{}` when value is undefined — keeps optional keys absent. */
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function existingIds(s: ProjectState): Set<string> {
  const ids = new Set<string>();
  for (const n of s.notes) ids.add(n.id);
  for (const d of s.decisions) ids.add(d.id);
  for (const p of s.proposals) ids.add(p.id);
  for (const x of s.sessions) ids.add(x.id);
  for (const c of s.claims) {
    ids.add(c.id);
    for (const e of c.evidence) ids.add(e.id);
  }
  return ids;
}

function linkable(s: ProjectState): Set<string> {
  return new Set([...s.notes, ...s.claims, ...s.decisions].map((x) => x.id));
}

interface Refs {
  claims: string[];
  links: string[];
  proposals: string[];
  decisions: string[];
}

const NO_REFS: Refs = { claims: [], links: [], proposals: [], decisions: [] };

function itemRefs(item: ProposedItem): Partial<Refs> {
  if (item.kind === 'claim') return { links: item.derivedFrom ?? [] };
  if (item.kind === 'status') return { claims: [item.claimId] };
  if (item.kind === 'decision') return { links: item.links ?? [] };
  return {};
}

/** Ids this event introduces; they must not collide with anything existing. */
function newIdsOf(s: ProjectState, e: CwsEvent): string[] {
  switch (e.type) {
    case 'NOTE_ADDED': return [e.payload.noteId];
    case 'CLAIM_ADDED': return [e.payload.claimId];
    case 'EVIDENCE_ADDED': return [e.payload.evidenceId];
    case 'PROPOSAL_SUBMITTED': return [e.payload.proposalId];
    case 'DECISION_RECORDED': return [e.payload.decisionId];
    case 'SESSION_STARTED': return [e.payload.sessionId];
    case 'PROPOSAL_ACCEPTED': {
      const kind = s.proposals.find((p) => p.id === e.payload.proposalId)?.item.kind;
      return kind === 'claim' || kind === 'decision' ? [e.payload.resultId] : [];
    }
    default: return [];
  }
}

/** Existing entities the event points at. */
function refsOf(e: CwsEvent): Refs {
  switch (e.type) {
    case 'CLAIM_ADDED': return { ...NO_REFS, links: e.payload.derivedFrom ?? [] };
    case 'CLAIM_CONFIRMED':
    case 'CLAIM_STATUS_CHANGED':
    case 'EVIDENCE_ADDED': return { ...NO_REFS, claims: [e.payload.claimId] };
    case 'PROPOSAL_SUBMITTED': return { ...NO_REFS, ...itemRefs(e.payload.item) };
    case 'PROPOSAL_ACCEPTED':
    case 'PROPOSAL_REJECTED': return { ...NO_REFS, proposals: [e.payload.proposalId] };
    case 'DECISION_RECORDED': {
      const { links, supersedes } = e.payload;
      return { ...NO_REFS, links: links ?? [], decisions: supersedes ? [supersedes] : [] };
    }
    default: return NO_REFS;
  }
}

function assertReferences(s: ProjectState, e: CwsEvent): void {
  const taken = existingIds(s);
  const dup = newIdsOf(s, e).find((id) => taken.has(id));
  if (dup !== undefined) throw new DomainError('DUPLICATE_ID', `id "${dup}" already exists`);

  const refs = refsOf(e);
  const check = (kind: string, ids: string[], known: Set<string>): void => {
    const missing = ids.find((id) => !known.has(id));
    if (missing !== undefined) throw new DomainError('NOT_FOUND', `${kind} "${missing}" not found`);
  };
  check('claim', refs.claims, new Set(s.claims.map((c) => c.id)));
  check('note/claim/decision', refs.links, linkable(s));
  check('proposal', refs.proposals, new Set(s.proposals.map((p) => p.id)));
  check('decision', refs.decisions, new Set(s.decisions.map((d) => d.id)));
}

function assertAuthorized(e: CwsEvent): void {
  if (e.actor.kind !== 'ai') return;
  if (HUMAN_ONLY_EVENTS.includes(e.type)) {
    throw new DomainError('AI_NOT_AUTHORIZED', `AI actors may not emit ${e.type}`);
  }
  if (e.type === 'CLAIM_ADDED' && !AI_ALLOWED_CLAIM_TYPES.includes(e.payload.type)) {
    throw new DomainError('AI_CLAIM_TYPE_FORBIDDEN', `AI actors may not add ${e.payload.type} claims`);
  }
}

function assertPreconditions(state: ProjectState | null, e: CwsEvent): void {
  if (!EVENT_TYPES.includes(e.type)) throw new DomainError('INVALID_EVENT', `unknown event type "${String(e.type)}"`);
  assertAuthorized(e);
  if (!state && e.type !== 'PROJECT_CREATED') throw new DomainError('NO_PROJECT', 'project not created yet');
  if (state && e.type === 'PROJECT_CREATED') throw new DomainError('PROJECT_EXISTS', 'project already exists');
  const expected = state ? state.lastSeq + 1 : 0;
  if (e.seq !== expected) throw new DomainError('BAD_SEQUENCE', `expected seq ${expected}, got ${e.seq}`);
}

// ---------------------------------------------------------------------------
// Entity builders and state transforms
// ---------------------------------------------------------------------------

function assertClaimStatus(type: Claim['type'], status: Claim['status'], answer?: string): void {
  if (!CLAIM_TYPE_STATUSES[type].includes(status)) {
    throw new DomainError('INVALID_EVENT', `${status} is not a status for ${type}`);
  }
  if (status === 'ANSWERED' && !answer?.trim()) {
    throw new DomainError('INVALID_EVENT', 'ANSWERED requires a nonblank answer');
  }
}

function assertStatusEvent(state: ProjectState, event: CwsEvent): void {
  const check = (item: StatusChange): void => {
    const claim = state.claims.find((entry) => entry.id === item.claimId);
    if (!claim) throw new DomainError('NOT_FOUND', `claim "${item.claimId}" not found`);
    assertClaimStatus(claim.type, item.status, item.answer);
  };
  if (event.type === 'CLAIM_STATUS_CHANGED') check(event.payload);
  if (event.type === 'CLAIM_CONFIRMED') {
    const claim = state.claims.find((entry) => entry.id === event.payload.claimId)!;
    assertClaimStatus(event.payload.asType ?? claim.type, claim.status, claim.answer);
  }
  if (event.type === 'PROPOSAL_SUBMITTED' && event.payload.item.kind === 'status') check(event.payload.item);
  if (event.type === 'PROPOSAL_ACCEPTED') {
    const item = pendingProposal(state, event.payload.proposalId).item;
    if (item.kind === 'status') check(item);
  }
}

function mapClaim(s: ProjectState, claimId: string, fn: (c: Claim) => Claim): ProjectState {
  return { ...s, claims: s.claims.map((c) => (c.id === claimId ? fn(c) : c)) };
}

function applyStatus(s: ProjectState, p: StatusChange, evidenceId: string, actor: Actor, at: string): ProjectState {
  return mapClaim(s, p.claimId, (c) => {
    const evidence: Evidence[] =
      p.evidence === undefined ? c.evidence : [...c.evidence, { id: evidenceId, text: p.evidence, at, actor }];
    return { ...c, status: p.status, ...opt('answer', p.answer), evidence, confirmed: true, updatedAt: at };
  });
}

type ClaimFields = Omit<EventPayloads['CLAIM_ADDED'], 'claimId'>;

function buildClaim(s: ProjectState, e: CwsEvent, id: string, f: ClaimFields, by: Actor, confirmed: boolean): Claim {
  return {
    id,
    type: f.type,
    text: f.text,
    status: 'OPEN',
    ...opt('risk', f.risk),
    evidence: [],
    derivedFrom: [...(f.derivedFrom ?? [])],
    createdBy: by,
    confirmed,
    phase: s.phase,
    ...opt('sessionId', e.sessionId),
    at: e.at,
    updatedAt: e.at,
  };
}

function recordDecision(s: ProjectState, e: CwsEvent, id: string, p: DecisionFields): ProjectState {
  const options = p.options.includes(p.selected) ? [...p.options] : [...p.options, p.selected];
  const decision: Decision = {
    id,
    title: p.title,
    options,
    selected: p.selected,
    rationale: p.rationale,
    rejected: options.filter((o) => o !== p.selected),
    links: [...(p.links ?? [])],
    kind: p.kind ?? 'NORMAL',
    ...opt('supersedes', p.supersedes),
    phase: s.phase,
    ...opt('sessionId', e.sessionId),
    at: e.at,
  };
  return { ...s, decisions: [...s.decisions, decision] };
}

function possiblyAffectedBy(s: ProjectState, to: Phase): string[] {
  const later = (p: Phase): boolean => PHASES.indexOf(p) > PHASES.indexOf(to);
  return [
    ...s.claims.filter((c) => c.status !== 'RETIRED' && later(c.phase)).map((c) => c.id),
    ...s.decisions.filter((d) => later(d.phase)).map((d) => d.id),
  ];
}

function changePhase(s: ProjectState, to: Phase, reason: string, at: string): ProjectState {
  if (to === s.phase) throw new DomainError('INVALID_EVENT', `already in phase ${to}`);
  const backward = PHASES.indexOf(to) < PHASES.indexOf(s.phase);
  const change = { from: s.phase, to, reason, at, possiblyAffected: backward ? possiblyAffectedBy(s, to) : [] };
  return { ...s, phase: to, phaseHistory: [...s.phaseHistory, change] };
}

function resolveProposal(s: ProjectState, id: string, patch: object): ProjectState {
  return { ...s, proposals: s.proposals.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

function pendingProposal(s: ProjectState, id: string) {
  const proposal = s.proposals.find((p) => p.id === id)!;
  if (proposal.status !== 'PENDING') throw new DomainError('ALREADY_RESOLVED', `proposal "${id}" is ${proposal.status}`);
  return proposal;
}

function acceptProposal(s: ProjectState, e: Of<'PROPOSAL_ACCEPTED'>): ProjectState {
  const { proposalId, resultId, note } = e.payload;
  const proposal = pendingProposal(s, proposalId);
  const resolved = resolveProposal(s, proposalId, { status: 'ACCEPTED', resultId, ...opt('resolutionNote', note) });
  const item = proposal.item;
  switch (item.kind) {
    case 'claim':
      return { ...resolved, claims: [...resolved.claims, buildClaim(s, e, resultId, item, proposal.actor, true)] };
    case 'status':
      return applyStatus(resolved, item, `${e.id}_ev`, proposal.actor, e.at);
    case 'decision':
      return recordDecision(resolved, e, resultId, { ...item, kind: undefined });
    case 'phase':
      return changePhase(resolved, item.to, item.reason, e.at);
  }
}

function rejectProposal(s: ProjectState, e: Of<'PROPOSAL_REJECTED'>): ProjectState {
  const { proposalId, note } = e.payload;
  pendingProposal(s, proposalId);
  return resolveProposal(s, proposalId, { status: 'REJECTED', ...opt('resolutionNote', note) });
}

function startSession(s: ProjectState, e: Of<'SESSION_STARTED'>): ProjectState {
  if (s.activeSessionId !== undefined) {
    throw new DomainError('SESSION_ACTIVE', `session "${s.activeSessionId}" is still active`);
  }
  const { sessionId, goal } = e.payload;
  const session = { id: sessionId, goal, startedAt: e.at, startSeq: e.seq };
  return { ...s, sessions: [...s.sessions, session], activeSessionId: sessionId };
}

function endSession(s: ProjectState, e: Of<'SESSION_ENDED'>): ProjectState {
  const { sessionId, summary } = e.payload;
  if (s.activeSessionId !== sessionId) throw new DomainError('NO_ACTIVE_SESSION', `session "${sessionId}" is not active`);
  const sessions = s.sessions.map((x) => (x.id === sessionId ? { ...x, endedAt: e.at, ...opt('summary', summary) } : x));
  const next: ProjectState = { ...s, sessions };
  delete next.activeSessionId;
  return next;
}

function createProject(e: Of<'PROJECT_CREATED'>): ProjectState {
  return {
    id: e.payload.projectId,
    title: e.payload.title,
    createdAt: e.at,
    phase: 'EXPLORATION',
    notes: [],
    claims: [],
    decisions: [],
    proposals: [],
    sessions: [],
    phaseHistory: [],
    lastSeq: e.seq,
  };
}

function addNote(s: ProjectState, e: Of<'NOTE_ADDED'>): ProjectState {
  const note = {
    id: e.payload.noteId,
    text: e.payload.text,
    at: e.at,
    actor: e.actor,
    ...opt('sessionId', e.sessionId),
    phase: s.phase,
  };
  return { ...s, notes: [...s.notes, note] };
}

function addEvidence(s: ProjectState, e: Of<'EVIDENCE_ADDED'>): ProjectState {
  const { evidenceId, claimId, text, source } = e.payload;
  const ev: Evidence = { id: evidenceId, text, ...opt('source', source), at: e.at, actor: e.actor };
  return mapClaim(s, claimId, (c) => ({ ...c, evidence: [...c.evidence, ev], updatedAt: e.at }));
}

function submitProposal(s: ProjectState, e: Of<'PROPOSAL_SUBMITTED'>): ProjectState {
  const { proposalId, item, rationale } = e.payload;
  const proposal = {
    id: proposalId,
    item,
    ...opt('rationale', rationale),
    actor: e.actor,
    status: 'PENDING' as const,
    ...opt('sessionId', e.sessionId),
    at: e.at,
  };
  return { ...s, proposals: [...s.proposals, proposal] };
}

function applyEvent(s: ProjectState, e: CwsEvent): ProjectState {
  switch (e.type) {
    case 'PROJECT_CREATED': return s;
    case 'NOTE_ADDED': return addNote(s, e);
    case 'SESSION_STARTED': return startSession(s, e);
    case 'SESSION_ENDED': return endSession(s, e);
    case 'CLAIM_ADDED': {
      const claim = buildClaim(s, e, e.payload.claimId, e.payload, e.actor, e.actor.kind === 'human');
      return { ...s, claims: [...s.claims, claim] };
    }
    case 'CLAIM_CONFIRMED':
      return mapClaim(s, e.payload.claimId, (c) => ({
        ...c,
        confirmed: true,
        type: e.payload.asType ?? c.type,
        updatedAt: e.at,
      }));
    case 'CLAIM_STATUS_CHANGED': return applyStatus(s, e.payload, `${e.id}_ev`, e.actor, e.at);
    case 'EVIDENCE_ADDED': return addEvidence(s, e);
    case 'PROPOSAL_SUBMITTED': return submitProposal(s, e);
    case 'PROPOSAL_ACCEPTED': return acceptProposal(s, e);
    case 'PROPOSAL_REJECTED': return rejectProposal(s, e);
    case 'DECISION_RECORDED': return recordDecision(s, e, e.payload.decisionId, e.payload);
    case 'PHASE_CHANGED': return changePhase(s, e.payload.to, e.payload.reason, e.at);
  }
}

export function reduce(state: ProjectState | null, event: CwsEvent): ProjectState {
  assertPreconditions(state, event);
  if (!state) return createProject(event as Of<'PROJECT_CREATED'>);
  assertReferences(state, event);
  assertStatusEvent(state, event);
  return { ...applyEvent(state, event), lastSeq: event.seq };
}

export function fold(events: readonly CwsEvent[]): ProjectState | null {
  return events.reduce<ProjectState | null>((state, event) => reduce(state, event), null);
}
