/**
 * Alibaba Open Code Review, delegation mode.
 *
 * In delegation mode OCR never calls a model. It answers two deterministic
 * questions and the host agent does the reviewing:
 *   `ocr delegate preview --format json`         → which files would be reviewed, and why not
 *   `ocr delegate rule <paths...> --format json` → which rule applies to which file
 *
 * Wire contracts verified in the OCR sources (`cmd/opencodereview/delegate_cmd.go`):
 *   preview: { schema_version, mode, repository, from, to, commit, merge_base, background,
 *              total_files, reviewable_count, excluded_count, total_insertions,
 *              total_deletions, reviewable_files[], excluded_files[] }
 *            file: { path, status, insertions, deletions, exclude_reason? }
 *   rules:   { schema_version, groups[] }
 *            group: { group_id, source, pattern, files[], rule }
 *
 * `ocr review --format json` (full mode, needs its own model) is also read here, so
 * its comments can enter CWS as findings.
 */

import { z } from 'zod';
import { normalizePath, redactSecrets, type Finding, type Severity } from '../findings/types.ts';
import { runTool, type RunOptions } from './exec.ts';

const schemaVersion = z.union([z.string(), z.number()]).transform((value) => String(value));
const count = z.number().int().nonnegative().catch(0);

const fileSchema = z
  .object({
    path: z.string(),
    status: z.string().catch(''),
    insertions: z.number().int().catch(0),
    deletions: z.number().int().catch(0),
    exclude_reason: z.string().optional(),
  })
  .passthrough();

const previewSchema = z
  .object({
    schema_version: schemaVersion,
    mode: z.string().catch(''),
    repository: z.string().catch(''),
    from: z.string().optional(),
    to: z.string().optional(),
    commit: z.string().optional(),
    merge_base: z.string().optional(),
    background: z.string().optional(),
    total_files: count,
    reviewable_count: count,
    excluded_count: count,
    total_insertions: z.number().int().catch(0),
    total_deletions: z.number().int().catch(0),
    reviewable_files: z.array(fileSchema).catch([]),
    excluded_files: z.array(fileSchema).catch([]),
  })
  .passthrough();

const groupSchema = z
  .object({
    group_id: z.number().int().catch(0),
    source: z.string().catch(''),
    pattern: z.string().catch(''),
    files: z.array(z.string()).catch([]),
    rule: z.string().catch(''),
  })
  .passthrough();

const rulesSchema = z.object({ schema_version: schemaVersion, groups: z.array(groupSchema) }).passthrough();

const commentSchema = z
  .object({
    path: z.string(),
    content: z.string().catch(''),
    start_line: z.number().int().optional(),
    end_line: z.number().int().optional(),
    severity: z.string().optional(),
    category: z.string().optional(),
    rule: z.string().optional(),
  })
  .passthrough();

const reviewSchema = z
  .object({
    status: z.string().optional(),
    comments: z.array(commentSchema),
    summary: z.object({ files_reviewed: z.number().int().optional() }).passthrough().optional(),
  })
  .passthrough();

export interface OcrFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  excludeReason?: string;
}

export interface OcrPreview {
  schemaVersion: string;
  mode: string;
  repository: string;
  from?: string;
  to?: string;
  commit?: string;
  mergeBase?: string;
  totalFiles: number;
  reviewableCount: number;
  excludedCount: number;
  totalInsertions: number;
  totalDeletions: number;
  reviewable: OcrFile[];
  excluded: OcrFile[];
}

export interface OcrRuleGroup {
  groupId: number;
  source: string;
  pattern: string;
  files: string[];
  rule: string;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? 'unknown problem' : `${issue.path.join('.') || '(root)'}: ${issue.message}`;
}

function toFile(raw: z.infer<typeof fileSchema>): OcrFile {
  return {
    path: normalizePath(raw.path),
    status: raw.status,
    insertions: raw.insertions,
    deletions: raw.deletions,
    ...(raw.exclude_reason === undefined || raw.exclude_reason === '' ? {} : { excludeReason: raw.exclude_reason }),
  };
}

export function parseOcrPreview(raw: unknown): OcrPreview {
  const parsed = previewSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`not an OCR delegate preview: ${firstIssue(parsed.error)}`);
  const data = parsed.data;
  return {
    schemaVersion: data.schema_version,
    mode: data.mode,
    repository: data.repository,
    ...(data.from === undefined ? {} : { from: data.from }),
    ...(data.to === undefined ? {} : { to: data.to }),
    ...(data.commit === undefined ? {} : { commit: data.commit }),
    ...(data.merge_base === undefined ? {} : { mergeBase: data.merge_base }),
    totalFiles: data.total_files,
    reviewableCount: data.reviewable_count,
    excludedCount: data.excluded_count,
    totalInsertions: data.total_insertions,
    totalDeletions: data.total_deletions,
    reviewable: data.reviewable_files.map(toFile),
    excluded: data.excluded_files.map(toFile),
  };
}

export function parseOcrRules(raw: unknown): OcrRuleGroup[] {
  const parsed = rulesSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`not OCR delegate rules: ${firstIssue(parsed.error)}`);
  return parsed.data.groups.map((group) => ({
    groupId: group.group_id,
    source: group.source,
    pattern: group.pattern,
    files: group.files.map(normalizePath),
    rule: group.rule,
  }));
}

const OCR_SEVERITIES: Readonly<Record<string, Severity>> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'note',
  note: 'note',
};

/** Full-mode `ocr review --format json` comments as findings. Missing severity counts as medium. */
export function parseOcrComments(raw: unknown): Finding[] {
  const parsed = reviewSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`not an OCR review result: ${firstIssue(parsed.error)}`);
  return parsed.data.comments.map((comment) => ({
    tool: 'ocr',
    ...(comment.rule === undefined ? {} : { ruleId: comment.rule }),
    message: redactSecrets(comment.content, 1000),
    severity: OCR_SEVERITIES[(comment.severity ?? '').toLowerCase()] ?? 'medium',
    ...(comment.category === undefined ? {} : { category: comment.category }),
    path: normalizePath(comment.path),
    ...(comment.start_line === undefined ? {} : { startLine: comment.start_line }),
    ...(comment.end_line === undefined ? {} : { endLine: comment.end_line }),
  }));
}

export interface OcrRangeOptions {
  from?: string;
  to?: string;
  commit?: string;
  repo?: string;
  background?: string;
  exclude?: string;
  rule?: string;
}

/** `ocr delegate preview --format json`, with the ref mode passed through unchanged. */
export function previewArgs(opts: OcrRangeOptions = {}): string[] {
  return withRange(['delegate', 'preview', '--format', 'json'], opts);
}

export function rulesArgs(paths: readonly string[], opts: OcrRangeOptions = {}): string[] {
  return withRange(['delegate', 'rule', ...paths, '--format', 'json'], opts);
}

function withRange(base: string[], opts: OcrRangeOptions): string[] {
  if (opts.repo !== undefined) base.push('--repo', opts.repo);
  if (opts.from !== undefined) base.push('--from', opts.from);
  if (opts.to !== undefined) base.push('--to', opts.to);
  if (opts.commit !== undefined) base.push('--commit', opts.commit);
  if (opts.background !== undefined) base.push('--background', opts.background);
  if (opts.exclude !== undefined) base.push('--exclude', opts.exclude);
  if (opts.rule !== undefined) base.push('--rule', opts.rule);
  return base;
}

function firstLineOf(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim().slice(0, 200) ?? '';
}

async function runJson(command: string, args: readonly string[], opts: RunOptions): Promise<unknown> {
  const result = await runTool(command, args, opts);
  if (!result.ok) {
    const why = result.timedOut ? 'timed out' : `exit ${result.code ?? 'unknown'}`;
    const detail = firstLineOf(result.stderr);
    throw new Error(`${command} ${args.join(' ')} failed (${why})${detail === '' ? '' : `: ${detail}`}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${command} ${args.join(' ')} did not print JSON`);
  }
}

export async function ocrPreview(
  command: string,
  opts: RunOptions = {},
  range: OcrRangeOptions = {},
): Promise<OcrPreview> {
  return parseOcrPreview(await runJson(command, previewArgs(range), opts));
}

export async function ocrRules(
  command: string,
  paths: readonly string[],
  opts: RunOptions = {},
  range: OcrRangeOptions = {},
): Promise<OcrRuleGroup[]> {
  return parseOcrRules(await runJson(command, rulesArgs(paths, range), opts));
}

export interface CoverageRow {
  path: string;
  status: string;
  change: string;
  note: string;
}

export function coverageRows(preview: OcrPreview): CoverageRow[] {
  const row = (file: OcrFile, note: string): CoverageRow => ({
    path: file.path,
    status: file.status,
    change: `+${file.insertions}/-${file.deletions}`,
    note,
  });
  return [
    ...preview.reviewable.map((file) => row(file, 'review or skip with a reason')),
    ...preview.excluded.map((file) => row(file, file.excludeReason ?? 'excluded by OCR')),
  ];
}

/** The checklist an agent works through: every file ends as reviewed or as an explained skip. */
export function coverageLines(preview: OcrPreview): string[] {
  const rows = coverageRows(preview);
  const width = Math.min(60, Math.max('path'.length, ...rows.map((row) => row.path.length)));
  return [
    `${preview.mode} review: ${preview.reviewableCount} to review, ${preview.excludedCount} excluded ` +
      `(+${preview.totalInsertions}/-${preview.totalDeletions})`,
    `${'path'.padEnd(width)}  ${'status'.padEnd(10)} change      note`,
    ...rows.map((row) => `${row.path.padEnd(width)}  ${row.status.padEnd(10)} ${row.change.padEnd(11)} ${row.note}`),
  ];
}

/** Rule groups as one block per rule, which is what the reviewing agent reads. */
export function ruleLines(groups: readonly OcrRuleGroup[], maxRuleChars = 4000): string[] {
  const lines: string[] = [];
  for (const group of groups) {
    const files = group.files.length === 0 ? '' : ` — ${group.files.join(', ')}`;
    lines.push(`### ${group.source} / ${group.pattern}${files}`, '', redactSecrets(group.rule, maxRuleChars), '');
  }
  return lines;
}

/** Files OCR asked about but no rule group covers; those carry no checklist. */
export function missingRuleFiles(groups: readonly OcrRuleGroup[], files: readonly string[]): string[] {
  const covered = new Set(groups.flatMap((group) => group.files));
  return files.filter((file) => !covered.has(file));
}
