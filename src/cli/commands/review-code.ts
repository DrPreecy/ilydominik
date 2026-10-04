import type { Command } from 'commander';
import { TOOL_ENV, toolOverride } from '../../integrations/config.ts';
import { resolveToolCommand, type ToolCommand } from '../../integrations/exec.ts';
import { coverageLines, missingRuleFiles, ocrPreview, ocrRules, ruleLines, type OcrPreview, type OcrRangeOptions } from '../../integrations/ocr.ts';
import { fail, openLog, say, type ActorOpts, type Env } from '../human.ts';

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MAX_LISTED_RULE_CHARS = 4000;

/** Where the review result goes: agents record findings, they never accept them. */
const HOW_TO_RECORD = [
  '## How to record what you find',
  '',
  'Findings belong in CWS, not in a chat message. Two ways:',
  '',
  '1. Tools that speak SARIF or OCR JSON: save the output and run',
  '   `cws findings ingest --agent <your-name> --format sarif results.sarif`',
  '2. Your own review: write the findings as JSON and pipe them in',
  '   `cws findings ingest --agent <your-name> --format cws -`',
  '   ```json',
  '   [{"tool":"review","ruleId":"unvalidated-input","severity":"high","path":"src/api.ts","startLine":42,"message":"..."}]',
  '   ```',
  '',
  'Severity is one of critical, high, medium, low, note. Every finding becomes an AI',
  'hypothesis the human confirms, fixes or marks false. Never edit code you were not asked',
  'to change, and never install or run tools that are not already present.',
].join('\n');

/** `ocr` from CWS_TOOL_OCR or PATH; a repo file never chooses it, and a stale path never reaches spawn. */
function resolveOcr(env: Env): ToolCommand {
  const configured = toolOverride('ocr');
  const found = resolveToolCommand(configured ?? 'ocr');
  if (found !== null) return found;
  const hint =
    configured === undefined
      ? `It does not exist on PATH. Install it with \`npm i -g @alibaba-group/open-code-review\`, or set ${TOOL_ENV.ocr} to its path.`
      : `The path in ${TOOL_ENV.ocr} does not exist: ${configured}`;
  fail(env, `error: \`ocr\` was not found. ${hint}`);
}

function rangeOf(opts: { from?: string; to?: string; commit?: string; background?: string; exclude?: string }): OcrRangeOptions {
  return {
    ...(opts.from === undefined ? {} : { from: opts.from }),
    ...(opts.to === undefined ? {} : { to: opts.to }),
    ...(opts.commit === undefined ? {} : { commit: opts.commit }),
    ...(opts.background === undefined ? {} : { background: opts.background }),
    ...(opts.exclude === undefined ? {} : { exclude: opts.exclude }),
  };
}

async function reviewCode(env: Env, opts: ActorOpts & { from?: string; to?: string; commit?: string; background?: string; exclude?: string; rules?: boolean }): Promise<void> {
  if (opts.agent !== undefined && !AGENT_NAME.test(opts.agent)) {
    fail(env, 'error: --agent must be a short name (letters, digits, . _ -)');
  }
  await openLog(env);
  const command = resolveOcr(env);
  const range = rangeOf(opts);

  let preview: OcrPreview;
  try {
    preview = await ocrPreview(command, { cwd: env.io.cwd }, range);
  } catch (error: unknown) {
    fail(env, `error: ${error instanceof Error ? error.message : String(error)}`);
  }

  say(env, ...coverageLines(preview));
  if (preview.reviewableCount === 0) {
    say(env, '', 'Nothing to review in this range.');
    return;
  }

  if (opts.rules !== false) {
    const files = preview.reviewable.map((file) => file.path);
    try {
      const groups = await ocrRules(command, files, { cwd: env.io.cwd }, range);
      const uncovered = missingRuleFiles(groups, files);
      say(env, '', '## Review rules', '', ...ruleLines(groups, MAX_LISTED_RULE_CHARS));
      if (uncovered.length > 0) {
        say(env, `No specific rule covers: ${uncovered.join(', ')} — review those against the general rules only.`);
      }
    } catch (error: unknown) {
      say(env, '', `Rules could not be read (${error instanceof Error ? error.message : String(error)}); review with the general rules only.`);
    }
  }

  say(env, '', '## Review every file in the list above', '', HOW_TO_RECORD.replaceAll('<your-name>', opts.agent ?? '<your-name>'));
}

export function registerReviewCode(program: Command, env: Env): void {
  program
    .command('review-code')
    .description('show what a code review must cover, and how to record findings')
    .option('--from <ref>', 'base ref for a range review')
    .option('--to <ref>', 'target ref for a range review')
    .option('--commit <hash>', 'review a single commit')
    .option('--background <text>', 'business context for the review')
    .option('--exclude <patterns>', 'comma-separated exclude patterns')
    .option('--agent <name>', 'the agent doing the review')
    .option('--no-rules', 'skip the resolved review rules')
    .action((o: ActorOpts & { from?: string; to?: string; commit?: string; background?: string; exclude?: string; rules?: boolean }) =>
      reviewCode(env, o),
    );
}
