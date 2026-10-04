/**
 * One shape for every review finding CWS collects, whatever tool produced it.
 *
 * Findings are claims about code, not facts: they enter the log as AI hypotheses
 * that the human marks supported or false. The fingerprint makes that repeatable
 * across runs, and the text is redacted before it is stored.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Risk } from '../domain/types.ts';
import { redactSecrets } from './redact.ts';

/** Redaction lives in `redact.ts`; it is re-exported here because findings code has always imported it from this module. */
export { maskSecrets, redactSecrets, shorten, REDACTED } from './redact.ts';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'note'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  /** which tool produced it: `ocr`, `semgrep`, `codeql`, `security-review`, ... */
  tool: string;
  ruleId?: string;
  message: string;
  severity: Severity;
  category?: string;
  /** repository-relative path, forward slashes; as given when `external` */
  path: string;
  /** true when the path points outside the project (absolute elsewhere, or `../`) */
  external?: boolean;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  /** redacted excerpt of the code the finding is about */
  snippet?: string;
  helpUri?: string;
}

const SEVERITY_INDEX: Readonly<Record<Severity, number>> = { critical: 0, high: 1, medium: 2, low: 3, note: 4 };

export function severityRank(severity: Severity): number {
  return SEVERITY_INDEX[severity];
}

export function isAtLeast(severity: Severity, minimum: Severity): boolean {
  return SEVERITY_INDEX[severity] <= SEVERITY_INDEX[minimum];
}

/** How far up CWS's risk scale a finding sits: a review note is not a fact, but severity still matters. */
export function severityToRisk(severity: Severity): Risk {
  if (severity === 'critical') return 'FATAL';
  if (severity === 'high') return 'HIGH';
  if (severity === 'medium') return 'MEDIUM';
  return 'LOW';
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

const DRIVE = /^[A-Za-z]:\//;

function insideRoot(value: string, root: string): string | null {
  const flavor = DRIVE.test(value) ? path.win32 : path.posix;
  if (DRIVE.test(value) !== /^[A-Za-z]:[\\/]/.test(root)) return null;
  const relative = flavor.relative(root, value).replace(/\\/g, '/');
  if (relative === '' || relative === '..' || relative.startsWith('../') || flavor.isAbsolute(relative)) return null;
  return relative;
}

/**
 * Where a tool says a finding is: repo-relative when it lies inside `root`, otherwise
 * marked external so nobody mistakes `/etc/passwd` or `../x` for a project file.
 */
export function locatePath(raw: string, root?: string): { path: string; external: boolean } {
  const value = raw.replace(/\\/g, '/').trim().replace(/^\/(?=[A-Za-z]:\/)/, '');
  if (DRIVE.test(value) || value.startsWith('/')) {
    const relative = root === undefined ? null : insideRoot(value, root);
    return relative === null ? { path: value, external: true } : { path: relative, external: false };
  }
  const clean = path.posix.normalize(value);
  if (clean === '..' || clean.startsWith('../')) return { path: clean, external: true };
  return { path: clean === '.' ? '' : clean, external: false };
}

const MARKER = 'cws-finding:';
/** Only `findings ingest` may start a claim with the marker; anything else could pose as a recorded finding. */
export const FINDING_MARKER = MARKER;
export const FINDING_MARKER_RESERVED = `error: claim text may not start with "${MARKER}"; that prefix is reserved for \`cws findings ingest\``;
/** Exactly what `findingClaimText` writes at the start of a claim. */
const CLAIM_PREFIX = new RegExp(`^${MARKER}([0-9a-f]{16}(?:[0-9a-f]{16})?) \\[(?:${SEVERITIES.join('|')})\\] `);

export function findingTag(fingerprint: string): string {
  return `${MARKER}${fingerprint}`;
}

/** The fingerprint a claim text starts with, in the exact form ingest writes, or null. */
export function findingMarkerOf(text: string): string | null {
  return CLAIM_PREFIX.exec(text)?.[1] ?? null;
}

function location(finding: Finding): string {
  const line = finding.startLine === undefined ? '' : `:${finding.startLine}`;
  return `${finding.external === true ? finding.path : normalizePath(finding.path)}${line}`;
}

/** The message with case, spacing and digits flattened, so rewording noise does not split one issue in two. */
function messageKey(message: string): string {
  return message.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * Stable across runs for the same issue: tool, rule, exact place (line, column, end line)
 * and what was said about it. Two different findings at one spot, or two without a rule or
 * line, stay two findings. 128 bits, so a chosen ruleId cannot grind a colliding marker.
 */
export function findingFingerprint(finding: Finding): string {
  const key = [
    finding.tool.toLowerCase(),
    finding.ruleId ?? '',
    location(finding),
    finding.startColumn ?? '',
    finding.endLine ?? '',
    createHash('sha256').update(messageKey(finding.message)).digest('hex').slice(0, 16),
  ].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** The one line a human reads in `cws inbox`, `cws status` and the log. */
export function findingTitle(finding: Finding): string {
  const rule = finding.ruleId === undefined || finding.ruleId === '' ? '' : ` ${finding.ruleId}`;
  const where = finding.external === true ? `outside the project: ${location(finding)}` : location(finding);
  const place = location(finding) === '' ? '' : ` (${where})`;
  return `${redactSecrets(`${finding.tool}${rule}`, 120)}: ${redactSecrets(finding.message, 160)}${place}`;
}

export function findingLine(finding: Finding): string {
  return `${findingTag(findingFingerprint(finding))} ${finding.severity} ${findingTitle(finding)}`;
}
