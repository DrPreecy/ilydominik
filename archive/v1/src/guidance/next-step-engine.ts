import { ProjectState, NextStepRecommendation } from '../models/types.js';

export class NextStepEngine {
  /**
   * Deterministic evaluation function:
   * NextSteps = f(State, Objective, Principles, Constraints)
   */
  public static generateGuidance(state: ProjectState): NextStepRecommendation[] {
    const recommendations: NextStepRecommendation[] = [];

    // 1. Check for Untested Fatal/High-Risk Assumptions
    const fatalAssumptions = state.assumptions.filter(
      (a) => (a.riskLevel === 'FATAL' || a.riskLevel === 'HIGH') && a.status === 'UNTESTED'
    );

    if (fatalAssumptions.length > 0) {
      const target = fatalAssumptions[0];
      recommendations.push({
        id: `rec-proof-${target.id}`,
        title: `Execute Proof Spike on Critical Assumption: "${target.statement}"`,
        reason: `Fatal/High-risk assumption remains untested. Proceeding to implementation without proof violates Sandbox-First principle.`,
        suggestedPrompt: `/proof-spike We need to test the assumption: "${target.statement}". What is the smallest code snippet or sandbox test to validate or falsify this within 30 minutes?`,
        targetEpistemicTarget: 'ASSUMPTION',
        priority: 'HIGH',
      });
    }

    // 2. Check for Critical Open Unknowns
    const criticalUnknowns = state.unknowns.filter(
      (u) => u.status === 'OPEN' && (u.priority === 'CRITICAL' || u.priority === 'HIGH')
    );

    if (criticalUnknowns.length > 0) {
      const unknown = criticalUnknowns[0];
      recommendations.push({
        id: `rec-unknown-${unknown.id}`,
        title: `Clarify Key Unknown: "${unknown.question}"`,
        reason: `Critical knowledge gap identified. Clarifying this early prevents architectural rewrites.`,
        suggestedPrompt: `/understand Let's clarify the question: "${unknown.question}". Here is what we know so far: ${
          state.knowledge.map((k) => k.claim).slice(0, 3).join(', ') || 'No facts recorded yet.'
        }`,
        targetEpistemicTarget: 'UNKNOWN',
        priority: 'HIGH',
      });
    }

    // 3. Phase-Specific Progression Guidance
    switch (state.phase) {
      case 'EXPLORATION':
        if (state.knowledge.length === 0 && state.unknowns.length === 0) {
          recommendations.push({
            id: 'rec-phase-explore',
            title: 'Externalize Raw Vision & Problem Space',
            reason: 'Project state is blank. Initial brain-dump needed without judgment.',
            suggestedPrompt: `/explore Here is my raw idea: [describe your idea, target audience, and initial motivation in your own words]`,
            targetEpistemicTarget: 'KNOWLEDGE',
            priority: 'HIGH',
          });
        } else {
          recommendations.push({
            id: 'rec-phase-understand-transition',
            title: 'Synthesize Raw Notes into Epistemic Categories',
            reason: 'Exploration has captured initial thoughts. Ready to structure into Knowledge, Unknowns, and Assumptions.',
            suggestedPrompt: `/synthesize Please analyze our exploration notes and create the initial epistemic state breakdown.`,
            targetEpistemicTarget: 'PHASE_GATE',
            priority: 'MEDIUM',
          });
        }
        break;

      case 'UNDERSTANDING':
      case 'SYNTHESIS':
        if (state.assumptions.length > 0 && fatalAssumptions.length === 0) {
          recommendations.push({
            id: 'rec-transition-concept',
            title: 'Consolidate Concept & Pre-Conditions',
            reason: 'Assumptions are mapped and no fatal risks are unaddressed. Ready to finalize Concept.',
            suggestedPrompt: `/synthesize Review our decisions and knowledge to formulate the unified Idea Concept.`,
            targetEpistemicTarget: 'PHASE_GATE',
            priority: 'MEDIUM',
          });
        }
        break;

      case 'CONCEPT':
      case 'PLANNING':
        recommendations.push({
          id: 'rec-plan-decomposition',
          title: 'Decompose Concept into Testable Implementation Tasks',
          reason: 'Concept is established. We need fine-grained test-first tasks before code generation.',
          suggestedPrompt: `/sdd-implement Decompose our current concept into bounded implementation tasks with automated test contracts.`,
          targetEpistemicTarget: 'PHASE_GATE',
          priority: 'MEDIUM',
        });
        break;

      case 'IMPLEMENTATION':
        recommendations.push({
          id: 'rec-sdd-exec',
          title: 'Execute Next Bounded Test & Implementation Loop',
          reason: 'Active implementation under SDD guardrails. Implement one module with full test coverage.',
          suggestedPrompt: `/sdd-implement Write the behavioral test suite for the next milestone, then implement the minimal passing code.`,
          targetEpistemicTarget: 'KNOWLEDGE',
          priority: 'MEDIUM',
        });
        break;

      default:
        break;
    }

    return recommendations;
  }
}
