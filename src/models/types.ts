/**
 * Cognitive Work System (CWS) - Core Epistemic & State Models
 * Defined in accordance with Project Constitution (starttoughts.md)
 * and Comparative Reference Model (Dekonstruktion...md).
 */

export type EpistemicType =
  | 'FACT'
  | 'USER_STATEMENT'
  | 'INTERPRETATION'
  | 'ASSUMPTION'
  | 'HYPOTHESIS'
  | 'UNKNOWN'
  | 'DECISION'
  | 'CONSTRAINT';

export type Phase =
  | 'EXPLORATION'
  | 'UNDERSTANDING'
  | 'SYNTHESIS'
  | 'PROOF'
  | 'CONCEPT'
  | 'PLANNING'
  | 'IMPLEMENTATION'
  | 'LAUNCH'
  | 'POST_LAUNCH';

export interface KnowledgeItem {
  id: string;
  claim: string;
  epistemicType: 'FACT' | 'SYNTHESIS' | 'OBSERVATION';
  source: string;
  confidence?: number;
  recordedAt: string;
}

export interface UnknownItem {
  id: string;
  question: string;
  context?: string;
  status: 'OPEN' | 'INVESTIGATING' | 'ANSWERED' | 'DEFERRED';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  recordedAt: string;
}

export interface AssumptionItem {
  id: string;
  statement: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'FATAL';
  status: 'UNTESTED' | 'VALIDATING' | 'VALIDATED' | 'FALSIFIED';
  validationMethod?: string;
  recordedAt: string;
}

export interface DecisionItem {
  id: string;
  title: string;
  context?: string;
  optionsConsidered: string[];
  selectedOption: string;
  rationale: string;
  consequences?: string[];
  decidedBy: 'HUMAN' | 'SYSTEM_DEFAULT';
  recordedAt: string;
}

export interface ConstraintItem {
  id: string;
  type: 'TECHNICAL' | 'BUDGET' | 'TIME' | 'REGULATORY' | 'SCOPE';
  description: string;
}

export interface ProgressState {
  currentObjective: string;
  activeWorkstream: string;
  completedMilestones: string[];
  healthSignal: 'GREEN' | 'YELLOW' | 'BLOCKED';
}

/**
 * Formal State Vector S_t = (K, U, A, D, C, P)
 */
export interface ProjectState {
  id: string;
  title: string;
  phase: Phase;
  knowledge: KnowledgeItem[];
  unknowns: UnknownItem[];
  assumptions: AssumptionItem[];
  decisions: DecisionItem[];
  constraints: ConstraintItem[];
  progress: ProgressState;
  updatedAt: string;
}

/**
 * Work Event W_t triggering state transition S_{t+1} = T(S_t, W_t)
 */
export type WorkEvent =
  | { type: 'ADD_KNOWLEDGE'; payload: Omit<KnowledgeItem, 'recordedAt'> }
  | { type: 'ADD_UNKNOWN'; payload: Omit<UnknownItem, 'recordedAt'> }
  | { type: 'RESOLVE_UNKNOWN'; payload: { id: string; resolutionAnswer: string } }
  | { type: 'ADD_ASSUMPTION'; payload: Omit<AssumptionItem, 'recordedAt'> }
  | { type: 'VALIDATE_ASSUMPTION'; payload: { id: string; status: 'VALIDATED' | 'FALSIFIED'; evidence: string } }
  | { type: 'RECORD_DECISION'; payload: Omit<DecisionItem, 'recordedAt'> }
  | { type: 'ADD_CONSTRAINT'; payload: ConstraintItem }
  | { type: 'TRANSITION_PHASE'; payload: { targetPhase: Phase; rationale: string } }
  | { type: 'UPDATE_PROGRESS'; payload: Partial<ProgressState> };

/**
 * Anti-Rationalization Violation record
 */
export interface AntiRationalizationViolation {
  code: string;
  message: string;
  violatingEvent: WorkEvent;
  requiredRemedy: string;
}

/**
 * Actionable Next Step recommendation
 */
export interface NextStepRecommendation {
  id: string;
  title: string;
  reason: string;
  suggestedPrompt: string;
  targetEpistemicTarget: 'KNOWLEDGE' | 'UNKNOWN' | 'ASSUMPTION' | 'DECISION' | 'PHASE_GATE';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}
