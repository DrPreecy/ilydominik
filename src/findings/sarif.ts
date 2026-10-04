/**
 * SARIF 2.1.0 reader: Semgrep, CodeQL and `ocr review --format sarif` all write it.
 *
 * The severity of a result is often carried by the rule rather than the result
 * (CodeQL puts a 0–10 `security-severity` on the rule), so both levels are read
 * and the stronger one wins.
 */

import { z } from 'zod';
import { locatePath, redactSecrets, type Finding, type Severity } from './types.ts';

const regionSchema = z
  .object({
    startLine: z.number().int().optional(),
    startColumn: z.number().int().optional(),
    endLine: z.number().int().optional(),
    snippet: z.object({ text: z.string().optional() }).optional(),
  })
  .passthrough();

const locationSchema = z
  .object({
    physicalLocation: z
      .object({
        artifactLocation: z.object({ uri: z.string().optional() }).passthrough().optional(),
        region: regionSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ruleSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    shortDescription: z.object({ text: z.string().optional() }).passthrough().optional(),
    defaultConfiguration: z.object({ level: z.string().optional() }).passthrough().optional(),
    helpUri: z.string().optional(),
    properties: z
      .object({
        tags: z.array(z.string()).optional(),
        'security-severity': z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const resultSchema = z
  .object({
    ruleId: z.string().optional(),
    ruleIndex: z.number().int().optional(),
    rule: z.object({ id: z.string().optional(), index: z.number().int().optional() }).passthrough().optional(),
    level: z.string().optional(),
    message: z.object({ text: z.string().optional(), markdown: z.string().optional() }).passthrough().optional(),
    locations: z.array(locationSchema).optional(),
  })
  .passthrough();

const sarifSchema = z
  .object({
    version: z.string().optional(),
    runs: z.array(
      z
        .object({
          tool: z
            .object({
              driver: z
                .object({
                  name: z.string().optional(),
                  rules: z.array(ruleSchema).optional(),
                })
                .passthrough()
                .optional(),
            })
            .passthrough()
            .optional(),
          results: z.array(resultSchema).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type SarifDocument = z.infer<typeof sarifSchema>;

export function parseSarifDocument(raw: unknown): SarifDocument {
  const parsed = sarifSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`not a SARIF 2.1.0 document: ${issues}`);
  }
  return parsed.data;
}

function numeric(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `security-severity` wins over the plain SARIF level, because it is the finer signal. */
export function severityFor(level: string | undefined, securitySeverity: string | number | undefined): Severity {
  const score = numeric(securitySeverity);
  if (score !== null && score > 0) {
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    return 'low';
  }
  switch ((level ?? 'warning').toLowerCase()) {
    case 'error':
      return 'high';
    case 'warning':
      return 'medium';
    case 'note':
      return 'low';
    case 'none':
      return 'note';
    default:
      return 'medium';
  }
}

/** SARIF URIs are often `file:///abs/path` or percent-encoded; absolute paths stay absolute. */
export function uriToPath(uri: string): string {
  let value = uri;
  if (value.startsWith('file://')) value = value.slice('file://'.length);
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep the raw value when it is not valid percent-encoding
  }
  return locatePath(value).path;
}

export interface ParseSarifOptions {
  /** overrides the tool name taken from the SARIF driver */
  tool?: string;
  /** how many results to keep; the rest are dropped */
  limit?: number;
  /** project root: absolute paths inside it become repo-relative, the rest are marked external */
  root?: string;
}

type SarifRun = SarifDocument['runs'][number];
type SarifRule = NonNullable<NonNullable<NonNullable<SarifRun['tool']>['driver']>['rules']>[number];
type SarifResult = NonNullable<SarifRun['results']>[number];

/** `ruleId`, then the `rule` reference, then the rule the index points at: the fingerprint needs the rule. */
function ruleOf(result: SarifResult, rules: readonly SarifRule[]): { rule: SarifRule | undefined; ruleId: string | undefined } {
  const index = result.ruleIndex ?? result.rule?.index;
  const named = result.ruleId ?? result.rule?.id;
  const rule = index === undefined ? rules.find((r) => named !== undefined && r.id === named) : rules[index];
  const ruleId = [named, rule?.id].find((id) => id !== undefined && id !== '');
  return { rule, ruleId };
}

const MAX_LINE = 10_000_000;

const validNumber = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isInteger(value) && value >= 1 && value <= MAX_LINE ? value : undefined;

/** Same rules as the cws format: positive, sane, and the end not before the start. */
function validLines(region: z.infer<typeof regionSchema> | undefined): { startLine?: number; startColumn?: number; endLine?: number } {
  const startLine = validNumber(region?.startLine);
  const endLine = validNumber(region?.endLine);
  const startColumn = startLine === undefined ? undefined : validNumber(region?.startColumn);
  return {
    ...(startLine === undefined ? {} : { startLine }),
    ...(startColumn === undefined ? {} : { startColumn }),
    ...(endLine === undefined || startLine === undefined || endLine < startLine ? {} : { endLine }),
  };
}

export function parseSarif(raw: unknown, opts: ParseSarifOptions = {}): Finding[] {
  const doc = parseSarifDocument(raw);
  const findings: Finding[] = [];
  if (opts.limit !== undefined && !(opts.limit >= 1)) return findings;

  for (const run of doc.runs) {
    const driver = run.tool?.driver;
    const tool = opts.tool ?? toolFromDriverName(driver?.name);
    const rules = driver?.rules ?? [];

    for (const result of run.results ?? []) {
      const { rule, ruleId } = ruleOf(result, rules);
      const physical = result.locations?.[0]?.physicalLocation;
      const uri = physical?.artifactLocation?.uri;
      const tags = rule?.properties?.tags ?? [];
      const security = rule?.properties?.['security-severity'];
      const message = result.message?.text ?? result.message?.markdown ?? rule?.shortDescription?.text ?? 'finding';
      const snippet = physical?.region?.snippet?.text;
      // a result without a location is still a finding: it is recorded with no path rather than dropped
      const place = uri === undefined || uri === '' ? { path: '', external: false } : locatePath(uriToPath(uri), opts.root);
      const lines = validLines(physical?.region);
      findings.push({
        tool,
        ...(ruleId === undefined ? {} : { ruleId }),
        message: redactSecrets(message, 1000),
        severity: severityFor(result.level ?? rule?.defaultConfiguration?.level, security),
        ...(tags.length === 0 ? {} : { category: tags[0] ?? '' }),
        path: place.path,
        ...(place.external ? { external: true } : {}),
        ...(lines.startLine === undefined ? {} : { startLine: lines.startLine }),
        ...(lines.startColumn === undefined ? {} : { startColumn: lines.startColumn }),
        ...(lines.endLine === undefined ? {} : { endLine: lines.endLine }),
        ...(snippet === undefined || snippet === '' ? {} : { snippet: redactSecrets(snippet, 400) }),
        ...(rule?.helpUri === undefined ? {} : { helpUri: rule.helpUri }),
      });
      if (opts.limit !== undefined && findings.length >= Math.max(0, opts.limit)) return findings;
    }
  }

  return findings;
}

/** Semgrep, CodeQL and OCR name themselves in the SARIF driver; keep that mapping small and explicit. */
export function toolFromDriverName(name: string | undefined): string {
  const value = (name ?? '').toLowerCase();
  if (value.includes('semgrep')) return 'semgrep';
  if (value.includes('codeql')) return 'codeql';
  if (value.includes('open-code-review') || value.includes('opencodereview') || value.includes('ocr')) return 'ocr';
  return value === '' ? 'sarif' : value;
}
