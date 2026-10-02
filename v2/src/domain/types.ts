/**
 * CWS v2 domain contract.
 *
 * Constitution anchors (starttoughts.md):
 *  §6  AI may recommend/analyze/structure — the human decides.
 *  §14 USER_STATEMENT / FACT / INTERPRETATION / ASSUMPTION / HYPOTHESIS / UNKNOWN / DECISION stay distinct.
 *  §20 Work is a state transformation  →  state = fold(events).
 *  §24 Warnings without artificial gates  →  humans are never blocked, only warned; overrides are recorded.
 *  §28 Provenance  →  every item knows who created it, when, in which session, derived from what.
 */

export const PHASES = [
  'EXPLORATION',
  'UNDERSTANDING',
  'SYNTHESIS',
  'PROOF',
  'CONCEPT',
  'PLANNING',
  'IMPLEMENTATION',
  'LAUNCH',
  'POST_LAUNCH',
] as const;
export type Phase = (typeof PHASES)[number];

export const CLAIM_TYPES = [
  'USER_STATEMENT',
  'FACT',
  'INTERPRETATION',
  'ASSUMPTION',
  'HYPOTHESIS',
  'UNKNOWN',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** Claim types an AI actor may add directly. They are non-authoritative by definition. */
export const AI_ALLOWED_CLAIM_TYPES: readonly ClaimType[] = ['INTERPRETATION', 'ASSUMPTION', 'HYPOTHESIS', 'UNKNOWN'];

/**
 * OPEN      – stated, not examined
 * TESTING   – an investigation is underway
 * SUPPORTED – evidence supports it (assumption/hypothesis)
 * FALSIFIED – evidence contradicts it
 * ANSWERED  – an UNKNOWN that has been answered
 * RETIRED   – no longer relevant (kept for history, §26)
 */
export const CLAIM_STATUSES = ['OPEN', 'TESTING', 'SUPPORTED', 'FALSIFIED', 'ANSWERED', 'RETIRED'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_TYPE_STATUSES: Readonly<Record<ClaimType, readonly ClaimStatus[]>> = {
  USER_STATEMENT: ['OPEN', 'RETIRED'],
  FACT: ['OPEN', 'RETIRED'],
  INTERPRETATION: ['OPEN', 'RETIRED'],
  ASSUMPTION: ['OPEN', 'TESTING', 'SUPPORTED', 'FALSIFIED', 'RETIRED'],
  HYPOTHESIS: ['OPEN', 'TESTING', 'SUPPORTED', 'FALSIFIED', 'RETIRED'],
  UNKNOWN: ['OPEN', 'TESTING', 'ANSWERED', 'RETIRED'],
};

export const RISKS = ['LOW', 'MEDIUM', 'HIGH', 'FATAL'] as const;
export type Risk = (typeof RISKS)[number];

export type Actor = { kind: 'human' } | { kind: 'ai'; agent: string; role?: string };

export interface Note {
  id: string;
  text: string;
  at: string;
  actor: Actor;
  sessionId?: string;
  phase: Phase;
}

export interface Evidence {
  id: string;
  text: string;
  source?: string;
  at: string;
  actor: Actor;
}

export interface Claim {
  id: string;
  type: ClaimType;
  text: string;
  status: ClaimStatus;
  risk?: Risk;
  evidence: Evidence[];
  /** ids of notes / claims / decisions this claim was derived from */
  derivedFrom: string[];
  createdBy: Actor;
  /** true once a human confirmed an AI-created claim, or the human created it */
  confirmed: boolean;
  /** answer text for an UNKNOWN that became ANSWERED — the answer does NOT become a FACT automatically */
  answer?: string;
  phase: Phase;
  sessionId?: string;
  at: string;
  updatedAt: string;
}

export type DecisionKind = 'NORMAL' | 'PROCEED_UNDER_UNCERTAINTY';

export interface Decision {
  id: string;
  title: string;
  options: string[];
  selected: string;
  rationale: string;
  /** options considered and not chosen — preserved for history (§26) */
  rejected: string[];
  /** claim / decision ids this decision rests on or knowingly overrides */
  links: string[];
  kind: DecisionKind;
  supersedes?: string;
  phase: Phase;
  sessionId?: string;
  at: string;
}

export type ProposedItem =
  | { kind: 'claim'; type: ClaimType; text: string; risk?: Risk; derivedFrom?: string[] }
  | { kind: 'status'; claimId: string; status: ClaimStatus; evidence?: string; answer?: string }
  | { kind: 'decision'; title: string; options: string[]; selected: string; rationale: string; links?: string[] }
  | { kind: 'phase'; to: Phase; reason: string };

export type ProposalStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface Proposal {
  id: string;
  item: ProposedItem;
  /** why the AI proposes this */
  rationale?: string;
  actor: Actor;
  status: ProposalStatus;
  resolutionNote?: string;
  /** id of the claim/decision materialised on accept */
  resultId?: string;
  sessionId?: string;
  at: string;
}

export interface Session {
  id: string;
  goal: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  /** seq of SESSION_STARTED event */
  startSeq: number;
}

export interface PhaseChange {
  from: Phase;
  to: Phase;
  reason: string;
  at: string;
  /** for backward moves: ids of claims/decisions created in phases later than `to` — possibly affected, never rewritten */
  possiblyAffected: string[];
}

export interface ProjectState {
  id: string;
  title: string;
  createdAt: string;
  phase: Phase;
  notes: Note[];
  claims: Claim[];
  decisions: Decision[];
  proposals: Proposal[];
  sessions: Session[];
  activeSessionId?: string;
  phaseHistory: PhaseChange[];
  /** seq of the last applied event (-1 before any event) */
  lastSeq: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventPayloads {
  PROJECT_CREATED: { projectId: string; title: string };
  NOTE_ADDED: { noteId: string; text: string };
  SESSION_STARTED: { sessionId: string; goal: string };
  SESSION_ENDED: { sessionId: string; summary?: string };
  CLAIM_ADDED: { claimId: string; type: ClaimType; text: string; risk?: Risk; derivedFrom?: string[] };
  CLAIM_CONFIRMED: { claimId: string; asType?: ClaimType };
  CLAIM_STATUS_CHANGED: { claimId: string; status: ClaimStatus; evidence?: string; answer?: string };
  EVIDENCE_ADDED: { evidenceId: string; claimId: string; text: string; source?: string };
  PROPOSAL_SUBMITTED: { proposalId: string; item: ProposedItem; rationale?: string };
  PROPOSAL_ACCEPTED: { proposalId: string; resultId: string; note?: string };
  PROPOSAL_REJECTED: { proposalId: string; note?: string };
  DECISION_RECORDED: {
    decisionId: string;
    title: string;
    options: string[];
    selected: string;
    rationale: string;
    links?: string[];
    kind?: DecisionKind;
    supersedes?: string;
  };
  PHASE_CHANGED: { to: Phase; reason: string };
}

export type EventType = keyof EventPayloads;

/** Event types only a human actor may emit (§6). */
export const HUMAN_ONLY_EVENTS: readonly EventType[] = [
  'PROJECT_CREATED',
  'SESSION_STARTED',
  'SESSION_ENDED',
  'CLAIM_CONFIRMED',
  'CLAIM_STATUS_CHANGED',
  'PROPOSAL_ACCEPTED',
  'PROPOSAL_REJECTED',
  'DECISION_RECORDED',
  'PHASE_CHANGED',
];

/** What a caller hands to the store; seq/id/at/hash are assigned on append. */
export type EventInput = {
  [K in EventType]: { type: K; actor: Actor; payload: EventPayloads[K] };
}[EventType];

export type CwsEvent = EventInput & {
  v: 1;
  seq: number;
  id: string;
  at: string;
  sessionId?: string;
  prevHash: string;
  hash: string;
};

export type DomainErrorCode =
  | 'AI_NOT_AUTHORIZED'
  | 'AI_CLAIM_TYPE_FORBIDDEN'
  | 'INVALID_EVENT'
  | 'NO_PROJECT'
  | 'PROJECT_EXISTS'
  | 'DUPLICATE_ID'
  | 'NOT_FOUND'
  | 'ALREADY_RESOLVED'
  | 'SESSION_ACTIVE'
  | 'NO_ACTIVE_SESSION'
  | 'BAD_SEQUENCE'
  | 'LOG_CORRUPT';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'DomainError';
  }
}

// ---------------------------------------------------------------------------
// Guidance
// ---------------------------------------------------------------------------

export type WarningSeverity = 'info' | 'caution' | 'serious';

export interface Warning {
  code: string;
  severity: WarningSeverity;
  message: string;
  /** ids of the claims/decisions the warning is about */
  refs: string[];
}

export type IntendedAction = { kind: 'phase'; to: Phase } | { kind: 'none' };

export const PURPOSES = [
  'explore',
  'understand',
  'synthesize',
  'proof',
  'concept',
  'plan',
  'implement',
  'launch',
  'learn',
  'review',
] as const;
export type Purpose = (typeof PURPOSES)[number];

export interface NextStep {
  ruleId: string;
  purpose: Purpose;
  title: string;
  reason: string;
  refs: string[];
  priority: number;
}
