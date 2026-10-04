import type { Phase, ProjectState, Purpose, Warning } from '../domain/types.ts';
import { unprocessedNotes as getUnprocessedNotes } from './unprocessed-notes.ts';

export interface RuleHit {
  title: string;
  reason: string;
  refs: string[];
  /** Overrides the rule's purpose when it depends on the state (used by 'phase-default'). */
  purpose?: Purpose;
  /** Overrides the rule's priority when it depends on the state (§12: don't push structuring during exploration). */
  priority?: number;
}

export interface Rule {
  id: string;
  purpose: Purpose;
  priority: number;
  evaluate(state: ProjectState, warnings: Warning[]): RuleHit | null;
}

/** A rule that fires when warnings with the given code exist; refs are the union of their refs. */
function fromWarning(id: string, purpose: Purpose, priority: number, code: string, title: string, reason: string): Rule {
  return {
    id,
    purpose,
    priority,
    evaluate: (_state, warnings) => {
      const hits = warnings.filter((w) => w.code === code);
      if (hits.length === 0) return null;
      return { title, reason, refs: [...new Set(hits.flatMap((w) => w.refs))] };
    },
  };
}

const PHASE_DEFAULTS: Record<Phase, { purpose: Purpose; title: string; reason: string }> = {
  EXPLORATION: { purpose: 'explore', title: 'Keep getting thoughts out', reason: 'First get everything out, then understand, then structure.' },
  UNDERSTANDING: { purpose: 'understand', title: 'Work out what you actually mean', reason: 'Turn raw thoughts into clear statements, and separate what you know from what you guess.' },
  SYNTHESIS: { purpose: 'synthesize', title: 'Pull the pieces into a picture', reason: 'Combine what you understood into a few clear options or themes.' },
  PROOF: { purpose: 'proof', title: 'Check the ideas that matter most', reason: 'Find out whether the risky ideas hold up before building on them.' },
  CONCEPT: { purpose: 'concept', title: 'Shape the concept', reason: 'Describe what you want to make, for whom, and why it is worth it.' },
  PLANNING: { purpose: 'plan', title: 'Plan the work', reason: 'Break the concept into concrete steps you can actually do.' },
  IMPLEMENTATION: { purpose: 'implement', title: 'Build it step by step', reason: 'Do the planned work and note whatever surprises you.' },
  LAUNCH: { purpose: 'launch', title: 'Get it in front of people', reason: 'Release it and watch how people really react.' },
  POST_LAUNCH: { purpose: 'learn', title: 'Learn from what happened', reason: 'Look at the results and decide what to keep, change or drop.' },
};

const isEmpty = (state: ProjectState) =>
  state.notes.length === 0 && state.claims.length === 0 && state.decisions.length === 0 && state.proposals.length === 0;

const emptyProject: Rule = {
  id: 'empty-project',
  purpose: 'explore',
  priority: 95,
  evaluate: (state) =>
    isEmpty(state)
      ? { title: 'Start by writing down whatever is on your mind', reason: 'Nothing is recorded yet. Unsorted thoughts are fine, you can sort them later.', refs: [] }
      : null,
};

const phaseDefault: Rule = {
  id: 'phase-default',
  purpose: 'explore',
  priority: 40,
  evaluate: (state) => {
    if (isEmpty(state) && state.phase === 'EXPLORATION') return null; // 'empty-project' already says explore
    const d = PHASE_DEFAULTS[state.phase];
    return { title: d.title, reason: d.reason, refs: [], purpose: d.purpose };
  },
};

/** Below phase-default (40) so exploration keeps priority over structuring. */
const EXPLORATION_NOTES_PRIORITY = 35;

const unprocessedNotes: Rule = {
  id: 'unprocessed-notes',
  purpose: 'understand',
  priority: 60,
  evaluate: (state) => {
    const refs = getUnprocessedNotes(state).map((note) => note.id);
    if (refs.length === 0) return null;
    if (state.phase === 'EXPLORATION') {
      return { title: 'When you feel done dumping: make sense of your notes', reason: `${refs.length} ${refs.length === 1 ? 'note is' : 'notes are'} waiting. No rush, getting everything out comes first.`, refs, priority: EXPLORATION_NOTES_PRIORITY };
    }
    return { title: 'Make sense of your raw notes', reason: `${refs.length} of your notes have not been turned into clear statements yet.`, refs };
  },
};

export const RULES: readonly Rule[] = [
  fromWarning('falsified-premise', 'review', 100, 'FALSIFIED_PREMISE', 'A core assumption turned out false — revisit what depends on it', 'Something you relied on was shown to be wrong, and other things may rest on it.'),
  fromWarning('pending-proposals', 'review', 90, 'PENDING_PROPOSALS', 'Look at the suggestions waiting for you', 'The AI suggested things that only count once you accept them.'),
  fromWarning('untested-risk', 'proof', 80, 'UNTESTED_RISK', 'Test your riskiest ideas', 'These ideas could sink the project if they are wrong, and nobody has checked them yet.'),
  fromWarning('override-followup', 'proof', 75, 'OVERRIDE_UNRESOLVED', 'Follow up on a decision you made despite open doubts', 'You chose to go ahead while some questions were open. They are still open.'),
  fromWarning('critical-unknown', 'understand', 70, 'OPEN_CRITICAL_UNKNOWN', 'Answer the important open questions', 'Questions that matter a lot are still unanswered.'),
  fromWarning('supported-without-evidence', 'proof', 65, 'SUPPORTED_WITHOUT_EVIDENCE', 'Back up what you marked as supported', 'Some ideas are marked as holding up, but nothing recorded shows why. Add the evidence, or reopen them.'),
  unprocessedNotes,
  fromWarning('unconfirmed-ai', 'review', 50, 'UNCONFIRMED_AI_CLAIMS', 'Check the AI guesses', 'Some statements come from the AI, not from you. Confirm, change or retire them.'),
  emptyProject,
  phaseDefault,
];
