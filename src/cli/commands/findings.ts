import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import type { Actor, Claim } from '../../domain/types.ts';
import { DEFAULT_LIMIT, DEFAULT_MIN_SEVERITY, findingsNoteText, findingClaimInputs, openFindings, planIngest, recordedFindings } from '../../findings/ingest.ts';
import { parseSarif } from '../../findings/sarif.ts';
import { severityRank, SEVERITIES, type Finding, type Severity } from '../../findings/types.ts';
import { parseOcrComments } from '../../integrations/ocr.ts';
import { newId } from '../../domain/ids.ts';
import { actorOf, fail, openLog, parseCount, projectRoot, requireHumanUnlessAgent, say, type ActorOpts, type Env } from '../human.ts';

const FORMATS = ['auto', 'sarif', 'ocr-review', 'cws'] as const;
type Format = (typeof FORMATS)[number];

export function detectFormat(json: unknown, requested: Format): Exclude<Format, 'auto'> {
  if (requested !== 'auto') return requested;
  if (Array.isArray(json)) return 'cws';
  if (typeof json === 'object' && json !== null) {
    const record = json as Record<string, unknown>;
    if (typeof record.version === 'string' && Array.isArray(record.runs)) return 'sarif';
    if (Array.isArray(record.comments)) return 'ocr-review';
  }
  throw new Error('cannot tell what this JSON is: pass --format sarif|ocr-review|cws');
}

/** SARIF from a large CodeQL run is verbose, so the cap is above `propose`'s 1 MB. */
const MAX_INPUT_CHARS = 10_000_000;

const positiveLine = z.number({ error: 'must be a positive whole number' }).int().positive();
const cwsFindingSchema = z.object(
  {
    tool: z.string().trim().min(1).optional(),
    ruleId: z.string().optional(),
    message: z.string({ error: 'is required' }).min(1),
    severity: z
      .string({ error: `is required (${SEVERITIES.join('|')})` })
      .transform((value) => value.trim().toLowerCase())
      .pipe(z.enum(SEVERITIES, { error: `must be one of ${SEVERITIES.join(', ')}` })),
    category: z.string().optional(),
    path: z.string({ error: 'is required' }).min(1),
    startLine: positiveLine.optional(),
    endLine: positiveLine.optional(),
    snippet: z.string().optional(),
    helpUri: z.string().optional(),
  },
  { error: 'must be an object with at least tool, path, message and severity' },
);

function cwsFinding(entry: unknown, index: number, tool: string | undefined): Finding {
  const parsed = cwsFindingSchema.safeParse(entry);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') ?? '';
    throw new Error(`finding #${index + 1}: ${field === '' ? '' : `${field} `}${issue?.message ?? 'is invalid'}`);
  }
  const named = parsed.data.tool ?? tool;
  if (named === undefined) throw new Error(`finding #${index + 1} has no tool: add "tool" to it or pass --tool <name>`);
  return { ...parsed.data, tool: named };
}

export interface FindingsFromOptions {
  /** SARIF and OCR: replaces the tool name; cws: used when an entry has none */
  tool?: string;
  /** project root, so absolute SARIF paths inside it become repo-relative */
  root?: string;
}

export function findingsFrom(json: unknown, format: Exclude<Format, 'auto'>, opts: FindingsFromOptions = {}): Finding[] {
  const { tool } = opts;
  if (format === 'sarif') return parseSarif(json, { ...(tool === undefined ? {} : { tool }), ...(opts.root === undefined ? {} : { root: opts.root }) });
  if (format === 'ocr-review') return parseOcrComments(json).map((finding) => (tool === undefined ? finding : { ...finding, tool }));
  if (!Array.isArray(json)) throw new Error('cws findings must be a JSON array of findings');
  return json.map((entry: unknown, index) => cwsFinding(entry, index, tool));
}

async function readInput(env: Env, source: string | undefined): Promise<string> {
  const tooLarge = `error: the findings input is too large (limit ${MAX_INPUT_CHARS / 1_000_000} MB)`;
  const fromStdin = source === undefined || source === '-';
  const file = fromStdin ? '' : path.resolve(env.io.cwd, source);
  if (!fromStdin && (await fs.stat(file)).size > MAX_INPUT_CHARS * 4) fail(env, tooLarge);
  const raw = fromStdin ? await env.io.readStdin() : await fs.readFile(file, 'utf8');
  if (raw.length > MAX_INPUT_CHARS) fail(env, tooLarge);
  return raw;
}

async function ingest(
  env: Env,
  source: string | undefined,
  opts: ActorOpts & { format?: string; tool?: string; minSeverity?: string; limit?: string },
): Promise<void> {
  requireHumanUnlessAgent(env, 'findings ingest', opts);
  const format = opts.format ?? 'auto';
  if (!(FORMATS as readonly string[]).includes(format)) {
    fail(env, `error: --format must be one of ${FORMATS.join(', ')}`);
  }
  const requested = format as Format;
  const minimum = (opts.minSeverity ?? DEFAULT_MIN_SEVERITY) as Severity;
  if (!(SEVERITIES as readonly string[]).includes(minimum)) {
    fail(env, `error: --min-severity must be one of ${SEVERITIES.join(', ')}`);
  }

  const raw = await readInput(env, source);
  if (raw.trim() === '') fail(env, 'error: no findings given (pass a file path, or pipe JSON with `-`)');

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error: unknown) {
    fail(env, `error: input is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  let findings: Finding[];
  try {
    const root = projectRoot(env) ?? env.io.cwd;
    findings = findingsFrom(json, detectFormat(json, requested), { ...(opts.tool === undefined ? {} : { tool: opts.tool }), root });
  } catch (error: unknown) {
    fail(env, `error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (findings.length === 0) return say(env, 'No findings in that input.');

  const log = await openLog(env);
  const limit = opts.limit === undefined ? DEFAULT_LIMIT : parseCount(env, opts.limit, '--limit');
  const plan = planIngest(log.state, findings, { minSeverity: minimum, limit });

  const notes = [
    `${findings.length} finding(s) read: ${plan.fresh.length} new, ${plan.duplicates.length} already recorded, ` +
      `${plan.belowSeverity} below ${minimum}, ${plan.overLimit} over the limit.`,
  ];
  if (plan.fresh.length > 0) {
    const noteId = newId('n');
    const tool = plan.fresh[0]?.tool ?? 'tool';
    const actor = findingActor(opts, tool);
    await log.appendBatch([
      { type: 'NOTE_ADDED', actor, payload: { noteId, text: findingsNoteText(tool, plan.fresh.length, source ?? 'stdin') } },
      ...findingClaimInputs(plan.fresh, noteId, actor),
    ]);
    notes.push(`Recorded ${plan.fresh.length} hypothesis claim(s). Review them with \`cws review\`.`);
    notes.push(...plan.fresh.map((finding) => `  [${finding.severity}] ${finding.path} — ${finding.tool}`));
  }
  if (plan.overLimit > 0) {
    notes.push(
      `${plan.overLimit} more not recorded yet (over --limit ${limit}). Run the same command again to record the next ` +
        `${Math.min(limit, plan.overLimit)}, or raise --limit.`,
    );
  }
  say(env, ...notes);
}

/**
 * Findings are a tool's hypotheses, never the human's statements: without --agent they are
 * recorded as an AI actor named after the tool, so they land in `cws review` like any AI claim.
 */
function findingActor(opts: ActorOpts, tool: string): Actor {
  if (opts.agent) return actorOf(opts);
  const agent = tool.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tool';
  return { kind: 'ai', agent, role: 'tool' };
}

function severityOf(claim: Claim): Severity {
  const match = /\[(critical|high|medium|low|note)\]/.exec(claim.text);
  return (match?.[1] ?? 'medium') as Severity;
}

/** The `(path:line)` the claim text ends with; the path itself may contain parentheses. */
function pathOf(claim: Claim): string {
  const text = claim.text.trimEnd();
  if (!text.endsWith(')')) return 'unknown file';
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    if (text[i] === '(') depth -= 1;
    if (depth === 0) return text.slice(i + 1, -1).replace(/:\d+$/, '') || 'unknown file';
  }
  return 'unknown file';
}

async function list(env: Env, opts: { all?: boolean }): Promise<void> {
  const log = await openLog(env);
  const recorded = recordedFindings(log.state);
  const claims = (opts.all === true ? recorded.map((entry) => entry.claim) : openFindings(log.state)).sort(
    (a, b) => severityRank(severityOf(a)) - severityRank(severityOf(b)),
  );
  if (claims.length === 0) {
    return say(env, 'No findings recorded yet. `cws review-code` shows what to review; `cws findings ingest` records results.');
  }
  const counts = new Map<Severity, number>();
  for (const claim of claims) counts.set(severityOf(claim), (counts.get(severityOf(claim)) ?? 0) + 1);
  const summary = [...counts.entries()]
    .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
    .map(([severity, total]) => `${total} ${severity}`)
    .join(', ');
  say(
    env,
    `${claims.length} finding(s): ${summary}`,
    ...claims.map((claim) => `  ${severityOf(claim).padEnd(8)} ${pathOf(claim)} — ${claim.text.replace(/^cws-finding:[0-9a-f]+ /, '')}`),
  );
}

export function registerFindings(program: Command, env: Env): void {
  const findings = program.command('findings').description('review findings recorded as claims');
  findings
    .command('ingest [file]')
    .description('record tool findings (SARIF, OCR review JSON) as AI hypotheses; reads stdin with `-`')
    .option('--agent <name>', 'record as this agent instead of the human')
    .option('--role <role>', 'optional agent role')
    .option('--format <format>', `input format: ${FORMATS.join('|')}`)
    .option('--tool <name>', 'tool name: replaces the SARIF/OCR tool, fills in cws findings without one')
    .option('--min-severity <level>', `ignore findings below this severity (default ${DEFAULT_MIN_SEVERITY})`)
    .option('--limit <n>', `record at most this many new findings per run (default ${DEFAULT_LIMIT})`)
    .action((file: string | undefined, o: ActorOpts & { format?: string; tool?: string; minSeverity?: string; limit?: string }) =>
      ingest(env, file, o),
    );
  findings
    .command('list')
    .description('show findings that are still open')
    .option('--all', 'include findings that were already resolved')
    .action((o: { all?: boolean }) => list(env, o));
  findings.action(() => list(env, {}));
}
