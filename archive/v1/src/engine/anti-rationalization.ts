import { ProjectState, WorkEvent, AntiRationalizationViolation } from '../models/types.js';

export class AntiRationalizationGuard {
  /**
   * Evaluates a work event against the current state and validates that
   * no cognitive shortcuts, epistemic drift, or unverified leaps are attempted.
   */
  public static validate(state: ProjectState, event: WorkEvent): AntiRationalizationViolation | null {
    switch (event.type) {
      case 'RECORD_DECISION': {
        if (event.payload.decidedBy !== 'HUMAN') {
          return {
            code: 'AR_NON_HUMAN_DECISION',
            message: 'Autonomous AI decisions are strictly forbidden. The human must remain the sole decision-maker.',
            violatingEvent: event,
            requiredRemedy: 'Ask the human operator to select the option and provide explicit approval.',
          };
        }
        if (!event.payload.rationale || event.payload.rationale.trim().length < 5) {
          return {
            code: 'AR_EMPTY_RATIONALE',
            message: 'Decisions must have an explicit rationale explaining why the option was chosen.',
            violatingEvent: event,
            requiredRemedy: 'Provide clear justification and reasoning for this decision.',
          };
        }
        break;
      }

      case 'VALIDATE_ASSUMPTION': {
        if (!event.payload.evidence || event.payload.evidence.trim().length < 10) {
          return {
            code: 'AR_INSUFFICIENT_EVIDENCE',
            message: 'Assumptions cannot be marked as validated without empirical or logical evidence.',
            violatingEvent: event,
            requiredRemedy: 'Provide concrete verification proof, benchmark, or user statement as evidence.',
          };
        }
        break;
      }

      case 'TRANSITION_PHASE': {
        const target = event.payload.targetPhase;

        // Circuit breaker: Cannot jump directly to IMPLEMENTATION if high-risk assumptions are untested
        if (target === 'IMPLEMENTATION') {
          const untestedFatal = state.assumptions.filter(
            (a) => (a.riskLevel === 'FATAL' || a.riskLevel === 'HIGH') && a.status === 'UNTESTED'
          );

          if (untestedFatal.length > 0) {
            return {
              code: 'AR_PREMATURE_IMPLEMENTATION',
              message: `Cannot transition to IMPLEMENTATION while ${untestedFatal.length} high/fatal-risk assumptions remain UNTESTED.`,
              violatingEvent: event,
              requiredRemedy: `Execute Phase 4 (Proof) on: ${untestedFatal.map((a) => a.statement).join('; ')}`,
            };
          }
        }
        break;
      }

      default:
        break;
    }

    return null;
  }
}
