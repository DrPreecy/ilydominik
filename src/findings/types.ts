/**
 * One shape for every review finding CWS collects, whatever tool produced it.
 *
 * Findings are claims about code, not facts: they enter the log as AI hypotheses
 * that the human marks supported or false. The fingerprint makes that repeatable
 * across runs, and the text is redacted before it is stored.
 */

import { createHash } from 'node:crypto';
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
  /** repository-relative path, forward slashes */
  path: string;
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

const MARKER = 'cws-finding:';

export function findingTag(fingerprint: string): string {
  return `${MARKER}${fingerprint}`;
}

/** The fingerprint an existing claim carries, or null when it is not a finding. */
export function findingMarkerOf(text: string): string | null {
  const match = new RegExp(`${MARKER}([0-9a-f]{8,64})`).exec(text);
  return match?.[1] ?? null;
}

function location(finding: Finding): string {
  const line = finding.startLine === undefined ? '' : `:${finding.startLine}`;
  return `${normalizePath(finding.path)}${line}`;
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
];

/** Keeps the field name (helpful when reviewing) and drops the value, quoted or not. */
const CREDENTIAL = /\b((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*)(["']?)([^\s"',;]{8,})\2/gi;
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

export function redactSecrets(text: string, limit = 400): string {
  let result = text.replace(ANSI_SGR, '');
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[redacted]');
  result = result.replace(CREDENTIAL, (_match, prefix: string) => `${prefix}[redacted]`);
  result = result.replace(/\s+/g, ' ').trim();
  return result.length > limit ? `${result.slice(0, limit - 1)}…` : result;
}

export function shorten(text: string, limit: number): string {
  const flat = redactSecrets(text, limit);
  return flat;
}

/** The one line a human reads in `cws inbox`, `cws status` and the log. */
export function findingTitle(finding: Finding): string {
  const rule = finding.ruleId === undefined || finding.ruleId === '' ? '' : ` ${finding.ruleId}`;
  const place = location(finding) === '' ? '' : ` (${location(finding)})`;
  return `${finding.tool}${rule}: ${redactSecrets(finding.message, 160)}${place}`;
}

export function findingLine(finding: Finding): string {
  return `${findingTag(findingFingerprint(finding))} ${finding.severity} ${findingTitle(finding)}`;
}
