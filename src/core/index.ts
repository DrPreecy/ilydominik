// Domain reducer and folding
export { fold, reduce } from '../domain/reducer.ts';

// Domain schemas
export {
  parseEventInput,
  parseStoredEvent,
} from '../domain/schema.ts';

// Hashing and chain verification (browser-safe WebCrypto)
export {
  GENESIS_HASH,
  canonicalEventString,
  computeEventHash,
  computeEventHashSync,
  sha256,
  verifyChain,
  verifyChainSync,
} from '../domain/hash.ts';
export type { ChainIntegrity, EventBody, Sha256 } from '../domain/hash.ts';

// Domain IDs
export { assertSessionId, newId } from '../domain/ids.ts';

// Guidance rules and warnings assessment
export { assess, STATUS_WARNING_CODES } from '../guidance/warnings.ts';
export { nextSteps } from '../guidance/next-steps.ts';
export { RULES } from '../guidance/rules.ts';

// Domain types and constants
export {
  AI_ALLOWED_CLAIM_TYPES,
  CLAIM_STATUSES,
  CLAIM_TYPES,
  CLAIM_TYPE_STATUSES,
  DomainError,
  HUMAN_ONLY_EVENTS,
  PHASES,
  PURPOSES,
  RISKS,
} from '../domain/types.ts';
export type {
  Actor,
  Claim,
  ClaimStatus,
  ClaimType,
  CwsEvent,
  Decision,
  DecisionKind,
  EventInput,
  EventPayloads,
  Evidence,
  NextStep,
  Phase,
  ProjectState,
  Proposal,
  ProposedItem,
  Purpose,
  Risk,
  Session,
  Warning,
  WarningSeverity,
} from '../domain/types.ts';
