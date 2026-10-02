/**
 * Turning tool output into CWS claims.
 *
 * A finding is not a fact: it enters the log as an AI hypothesis with a severity-derived
 * risk, linked to a note that describes the run. The human marks each one supported or
 * false, and that verdict is what later tells CWS whether a tool is worth trusting.
 *
 * Deduplication works off the finding marker in the claim text, so the log stays the
 * single source of truth and a re-run of the same tool adds nothing.
 */

import { newId } from '../domain/ids.ts';
import type { Actor, Claim, EventInput } from '../domain/types.ts';
import {
  findingFingerprint,
  findingMarkerOf,
  findingTag,
  findingTitle,
  isAtLeast,
  redactSecrets,
  severityToRisk,
  type Finding,
  type Severity,
} from './types.ts';

export const DEFAULT_MIN_SEVERITY: Severity = 'medium';
export const DEFAULT_LIMIT = 50;

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

export function planIngest(
  existing: readonly Claim[],
  findings: readonly Finding[],
  opts: IngestOptions = {},
): IngestPlan {
  const minimum = opts.minSeverity ?? DEFAULT_MIN_SEVERITY;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const known = new Set(existing.map((claim) => findingMarkerOf(claim.text)).filter((tag): tag is string => tag !== null));

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

/** The note a batch of findings hangs off, so the log shows where they came from. */
export function findingsNoteText(tool: string, total: number, source: string): string {
  const where = source.trim() === '' ? '' : ` from ${source.trim()}`;
  return `Review findings${where} (${tool}): ${total} new finding${total === 1 ? '' : 's'} recorded as AI hypotheses. ` +
    'Confirm, fix or mark each one false with `cws review`.';
}

export function findingClaimText(finding: Finding): string {
  return `${findingTag(findingFingerprint(finding))} [${finding.severity}] ${redactSecrets(findingTitle(finding), 500)}`;
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

export function recordedFindings(claims: readonly Claim[]): RecordedFinding[] {
  return claims.flatMap((claim) => {
    const fingerprint = findingMarkerOf(claim.text);
    return fingerprint === null ? [] : [{ claim, fingerprint }];
  });
}

export function openFindings(claims: readonly Claim[]): Claim[] {
  return recordedFindings(claims)
    .filter(({ claim }) => claim.status === 'OPEN' || claim.status === 'TESTING')
    .map(({ claim }) => claim);
}
