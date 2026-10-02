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
const CLAIM_PREFIX = new RegExp(`^${MARKER}([0-9a-f]{16}) \\[(?:${SEVERITIES.join('|')})\\] `);

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

/**
 * Stable across runs for the same issue: tool, rule and place. The message is left
 * out so a reworded tool version does not produce a duplicate claim.
 */
export function findingFingerprint(finding: Finding): string {
  const key = [finding.tool.toLowerCase(), finding.ruleId ?? '', location(finding)].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
];

/** Keeps the field name (helpful when reviewing) and drops the value, quoted or not. */
const CREDENTIAL =
  /\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(?:[_-][A-Za-z0-9]+)*["']?\s*[:=]\s*)(["']?)([^\s"',;]{4,})\2/gi;
/** `scheme://user:password@host` keeps the user and host. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi;
/** `Authorization: <scheme> <value>` loses everything after the colon. */
const AUTH_HEADER = /\b(authorization["']?\s*[:=]\s*)["']?(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+["']?/gi;
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/** Replaces credentials with `[redacted]` and keeps everything else, layout included. */
export function maskSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[redacted]');
  return result
    .replace(AUTH_HEADER, (_match, prefix: string) => `${prefix}[redacted]`)
    .replace(BEARER, (_match, prefix: string) => `${prefix}[redacted]`)
    .replace(URL_PASSWORD, (_match, prefix: string) => `${prefix}[redacted]@`)
    .replace(CREDENTIAL, (_match, prefix: string) => `${prefix}[redacted]`);
}

export function redactSecrets(text: string, limit = 400): string {
  const result = maskSecrets(text.replace(ANSI_SGR, '')).replace(/\s+/g, ' ').trim();
  return result.length > limit ? `${result.slice(0, limit - 1)}…` : result;
}

export function shorten(text: string, limit: number): string {
  const flat = redactSecrets(text, limit);
  return flat;
}

/** The one line a human reads in `cws inbox`, `cws status` and the log. */
export function findingTitle(finding: Finding): string {
  const rule = finding.ruleId === undefined || finding.ruleId === '' ? '' : ` ${finding.ruleId}`;
  const where = finding.external === true ? `outside the project: ${location(finding)}` : location(finding);
  const place = location(finding) === '' ? '' : ` (${where})`;
  return `${finding.tool}${rule}: ${redactSecrets(finding.message, 160)}${place}`;
}

export function findingLine(finding: Finding): string {
  return `${findingTag(findingFingerprint(finding))} ${finding.severity} ${findingTitle(finding)}`;
}
