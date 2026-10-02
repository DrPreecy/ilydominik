import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import type { Claim } from '../../domain/types.ts';
import { DEFAULT_LIMIT, DEFAULT_MIN_SEVERITY, findingsNoteText, findingClaimInputs, openFindings, planIngest, recordedFindings } from '../../findings/ingest.ts';
import { parseSarif } from '../../findings/sarif.ts';
import { severityRank, SEVERITIES, type Finding, type Severity } from '../../findings/types.ts';
import { parseOcrComments } from '../../integrations/ocr.ts';
import { newId } from '../../domain/ids.ts';
import { actorOf, fail, openLog, parseCount, say, type ActorOpts, type Env } from '../human.ts';

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

export function findingsFrom(json: unknown, format: Exclude<Format, 'auto'>, tool?: string): Finding[] {
  if (format === 'sarif') return parseSarif(json, tool === undefined ? {} : { tool });
  if (format === 'ocr-review') return parseOcrComments(json);
  const parsed = json as Finding[];
  for (const entry of parsed) {
    if (typeof entry.path !== 'string' || typeof entry.message !== 'string') {
      throw new Error('every cws finding needs at least a path and a message');
    }
  }
  return parsed;
}

async function readInput(env: Env, source: string | undefined): Promise<string> {
  if (source === undefined || source === '-') return env.io.readStdin();
  return fs.readFile(path.resolve(env.io.cwd, source), 'utf8');
}

async function ingest(
  env: Env,
  source: string | undefined,
  opts: ActorOpts & { format?: string; tool?: string; minSeverity?: string; limit?: string },
): Promise<void> {
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
    findings = findingsFrom(json, detectFormat(json, requested), opts.tool);
  } catch (error: unknown) {
    fail(env, `error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (findings.length === 0) return say(env, 'No findings in that input.');

  const log = await openLog(env);
  const plan = planIngest(log.state.claims, findings, {
    minSeverity: minimum,
    limit: opts.limit === undefined ? DEFAULT_LIMIT : parseCount(env, opts.limit, '--limit'),
  });

  const notes = [
    `${findings.length} finding(s) read: ${plan.fresh.length} new, ${plan.duplicates.length} already recorded, ` +
      `${plan.belowSeverity} below ${minimum}, ${plan.overLimit} over the limit.`,
  ];
  if (plan.fresh.length > 0) {
    const noteId = newId('n');
    const tool = plan.fresh[0]?.tool ?? 'tool';
    await log.appendBatch([
      { type: 'NOTE_ADDED', actor: actorOf(opts), payload: { noteId, text: findingsNoteText(tool, plan.fresh.length, source ?? 'stdin') } },
      ...findingClaimInputs(plan.fresh, noteId, actorOf(opts)),
    ]);
    notes.push(`Recorded ${plan.fresh.length} hypothesis claim(s). Review them with \`cws review\`.`);
    notes.push(...plan.fresh.map((finding) => `  [${finding.severity}] ${finding.path} — ${finding.tool}`));
  }
  say(env, ...notes);
}

function severityOf(claim: Claim): Severity {
  const match = /\[(critical|high|medium|low|note)\]/.exec(claim.text);
  return (match?.[1] ?? 'medium') as Severity;
}

function pathOf(claim: Claim): string {
  const match = /\(([^()]*?)(?::\d+)?\)\s*$/.exec(claim.text);
  return match?.[1] ?? 'unknown file';
}

async function list(env: Env, opts: { all?: boolean }): Promise<void> {
  const log = await openLog(env);
  const recorded = recordedFindings(log.state.claims);
  const claims = (opts.all === true ? recorded.map((entry) => entry.claim) : openFindings(log.state.claims)).sort(
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
    .option('--tool <name>', 'tool name to use when the input does not carry one')
    .option('--min-severity <level>', `ignore findings below this severity (default ${DEFAULT_MIN_SEVERITY})`)
    .option('--limit <n>', `keep at most this many findings (default ${DEFAULT_LIMIT})`)
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
