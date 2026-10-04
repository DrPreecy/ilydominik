import type { Note, ProjectState } from '../domain/types.ts';

export function unprocessedNotes(state: ProjectState): Note[] {
  const used = new Set([
    ...state.claims.flatMap((claim) => claim.derivedFrom),
    ...state.decisions.flatMap((decision) => decision.links),
  ]);
  return state.notes.filter((note) => !used.has(note.id));
}
