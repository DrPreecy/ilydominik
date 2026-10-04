/**
 * Turning tool output into CWS claims.
 *
 * A finding is not a fact: it enters the log as an AI hypothesis with a severity-derived
 * risk, linked to a note that describes the run. The human marks each one supported or
 * false, and that verdict is what later tells CWS whether a tool is worth trusting.
 *
 * Deduplication works off the finding marker that ingest writes at the start of the claim
 * text, so the log stays the single source of truth: a re-run of the same tool adds only
 * findings not recorded yet (for example the ones a previous run left over its --limit).
 * Only claims shaped exactly as ingest writes them count, so text that merely mentions a
 * marker cannot hide a real finding.
 */

import { newId } from '../domain/ids.ts';
import type { Actor, Claim, EventInput, Note, ProjectState } from '../domain/types.ts';
import {
  findingFingerprint,
  findingMarkerOf,
  findingTag,
  findingTitle,
  isAtLeast,
  severityToRisk,
  type Finding,
  type Severity,
} from './types.ts';

export const DEFAULT_MIN_SEVERITY: Severity = 'medium';
export const DEFAULT_LIMIT = 50;

/** A usable `--limit`: a whole number of at least 1. Anything else records nothing rather than slicing from the end. */
export function isValidLimit(limit: number): boolean {
  return Number.isSafeInteger(limit) && limit >= 1;
}

export interface IngestOptions {
  minSeverity?: Severity;
  limit?: number;
}

export interface IngestPlan {
  /** findings worth recording now, strongest first */
  fresh: Finding[];
  /** already recorded earlier, or repeated inside this batch */
  duplicates: Finding[];
  /** dropped because they are below the severity floor */
  belowSeverity: number;
  /** dropped because the batch was larger than the limit */
  overLimit: number;
}

const RISK_ORDER = ['FATAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

function rank(finding: Finding): number {
  const risk = severityToRisk(finding.severity);
  const index = RISK_ORDER.indexOf(risk);
  return index === -1 ? RISK_ORDER.length : index;
}

/** The parts of the project state that tell which findings are already recorded. */
export type RecordedSource = Pick<ProjectState, 'claims' | 'notes'>;

export function planIngest(existing: RecordedSource, findings: readonly Finding[], opts: IngestOptions = {}): IngestPlan {
  const minimum = opts.minSeverity ?? DEFAULT_MIN_SEVERITY;
  const requested = opts.limit ?? DEFAULT_LIMIT;
  const limit = isValidLimit(requested) ? requested : 0;
  // a finding that was fixed (RETIRED) and shows up again is a regression: it is recorded anew.
  // FALSIFIED and SUPPORTED ones stay known, so a false positive does not keep coming back.
  const known = new Set(
    recordedFindings(existing)
      .filter((entry) => entry.claim.status !== 'RETIRED')
      .map((entry) => entry.fingerprint),
  );

  const duplicates: Finding[] = [];
  const eligible: Finding[] = [];
  let belowSeverity = 0;

  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding);
    if (known.has(fingerprint)) {
      duplicates.push(finding);
      continue;
    }
    if (!isAtLeast(finding.severity, minimum)) {
      belowSeverity += 1;
      continue;
    }
    known.add(fingerprint);
    eligible.push(finding);
  }

  const ordered = [...eligible].sort((a, b) => rank(a) - rank(b));
  return {
    fresh: ordered.slice(0, limit),
    duplicates,
    belowSeverity,
    overLimit: Math.max(0, ordered.length - limit),
  };
}

const NOTE_SHAPE = /^Review findings[\s\S]*: \d+ new findings? recorded as AI hypotheses\. Confirm, fix or mark each one false with `cws review`\.$/;

/** The note a batch of findings hangs off, so the log shows where they came from. */
export function findingsNoteText(tool: string, total: number, source: string): string {
  const where = source.trim() === '' ? '' : ` from ${source.trim()}`;
  return `Review findings${where} (${tool}): ${total} new finding${total === 1 ? '' : 's'} recorded as AI hypotheses. ` +
    'Confirm, fix or mark each one false with `cws review`.';
}

export function findingClaimText(finding: Finding): string {
  // findingTitle already redacts each part; redacting the joined title again would eat words after a rule id like `hardcoded-password:`
  return `${findingTag(findingFingerprint(finding))} [${finding.severity}] ${findingTitle(finding).slice(0, 500)}`;
}

export function findingClaimInputs(findings: readonly Finding[], noteId: string, actor: Actor): EventInput[] {
  return findings.map((finding) => ({
    type: 'CLAIM_ADDED',
    actor,
    payload: {
      claimId: newId('c'),
      type: 'HYPOTHESIS' as const,
      text: findingClaimText(finding),
      risk: severityToRisk(finding.severity),
      derivedFrom: [noteId],
    },
  }));
}

export interface RecordedFinding {
  claim: Claim;
  fingerprint: string;
}

const sameActor = (a: Actor, b: Actor): boolean =>
  a.kind === b.kind && (a.kind === 'human' || (b.kind === 'ai' && a.agent === b.agent));

/** A claim ingest wrote: marker first, a hypothesis (unless a human retyped it), from the run note of the same actor. */
function ingestedBy(claim: Claim, notes: ReadonlyMap<string, Note>): boolean {
  // ingest only ever writes AI hypotheses; a human-authored claim never counts, whatever its text says
  if (claim.createdBy.kind !== 'ai') return false;
  if (claim.type !== 'HYPOTHESIS' && !claim.confirmed) return false;
  if (claim.derivedFrom.length !== 1) return false;
  const note = notes.get(claim.derivedFrom[0] ?? '');
  return note !== undefined && NOTE_SHAPE.test(note.text) && sameActor(note.actor, claim.createdBy);
}

export function recordedFindings(state: RecordedSource): RecordedFinding[] {
  const notes = new Map(state.notes.map((note) => [note.id, note]));
  return state.claims.flatMap((claim) => {
    const fingerprint = findingMarkerOf(claim.text);
    return fingerprint === null || !ingestedBy(claim, notes) ? [] : [{ claim, fingerprint }];
  });
}

export function openFindings(state: RecordedSource): Claim[] {
  return recordedFindings(state)
    .filter(({ claim }) => claim.status === 'OPEN' || claim.status === 'TESTING')
    .map(({ claim }) => claim);
}
