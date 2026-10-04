import type { Command } from 'commander';
import { newId } from '../../domain/ids.ts';
import { PURPOSES, type Purpose } from '../../domain/types.ts';
import { renderPrompt } from '../../guidance/render.ts';
import { loadIntegrations } from '../../integrations/config.ts';
import {
  checkAiUsage,
  CONSENT_DECISION_TITLE,
  DefaultGeminiCaller,
  estimateTokens,
  GEMINI_SYSTEM_INSTRUCTION,
  geminiResponseSchema,
  getGeminiKey,
  hasGeminiConsent,
  incrementAiUsage,
} from '../../integrations/gemini.ts';
import { fail, openLog, say, type Env } from '../human.ts';

interface AiCommandOpts {
  dryRun?: boolean;
}

export async function ai(env: Env, purposeArg: string, opts: AiCommandOpts): Promise<void> {
  const purpose = purposeArg.toLowerCase();
  if (!(PURPOSES as readonly string[]).includes(purpose)) {
    fail(env, `error: unknown purpose "${purposeArg}" (choose from ${PURPOSES.join(', ')})`);
  }

  const log = await openLog(env);
  const { config } = await loadIntegrations(log.rootDir);
  const promptText = await renderPrompt(log.state, purpose as Purpose);

  if (opts.dryRun) {
    const tokens = estimateTokens(promptText);
    say(
      env,
      `[DRY RUN] Gemini prompt preview for "${purpose}":`,
      `Model:            ${config.gemini.model}`,
      `Estimated tokens: ~${tokens}`,
      `Input length:     ${promptText.length} chars (cap: ${config.gemini.maxInputChars})`,
      '',
      '--- Prompt Content ---',
      promptText,
    );
    return;
  }

  const apiKey = getGeminiKey();
  if (!apiKey) {
    fail(env, 'error: GEMINI_API_KEY environment variable is not set. Run `cws doctor` or see docs/google-setup.md.');
  }

  if (promptText.length > config.gemini.maxInputChars) {
    fail(
      env,
      `error: input text exceeds limit of ${config.gemini.maxInputChars} characters (${promptText.length} chars).`,
    );
  }

  const usage = await checkAiUsage(log.rootDir, config.gemini.dailyCallLimit);
  if (!usage.ok) {
    fail(
      env,
      `error: daily Gemini call limit reached (${usage.todayCount}/${config.gemini.dailyCallLimit}). Resets ${usage.resetsAt}.`,
    );
  }

  if (!hasGeminiConsent(log.state)) {
    if (!env.io.isInteractive) {
      fail(
        env,
        'error: Gemini free tier requires one-time privacy consent. Run `cws ai <purpose>` in an interactive terminal first to review and accept.',
      );
    }

    say(
      env,
      '⚠️  Google\'s free-tier Gemini API may use prompts to improve products.',
      'CWS context packs contain project thoughts and claims (secrets are masked).',
      'Do you consent to sending prompts to Gemini? (yes/no)',
    );
    const answer = await env.io.ask('Consent (yes/no): ');
    if (answer.trim().toLowerCase() !== 'yes') {
      fail(env, 'error: consent not granted; cannot call Gemini API.');
    }

    const decisionId = newId('d');
    await log.append({
      type: 'DECISION_RECORDED',
      actor: { kind: 'human' },
      payload: {
        decisionId,
        title: CONSENT_DECISION_TITLE,
        options: ['yes', 'no'],
        selected: 'yes',
        rationale: 'User accepted Gemini free-tier data terms',
      },
    });
    say(env, 'Privacy consent recorded.');
  }

  const caller = env.geminiCaller ?? new DefaultGeminiCaller(apiKey);
  let rawResponse: string;
  try {
    rawResponse = await caller.generate(promptText, {
      model: config.gemini.model,
      maxOutputTokens: config.gemini.maxOutputTokens,
      systemInstruction: GEMINI_SYSTEM_INSTRUCTION,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('429') || /rate.?limit/i.test(msg)) {
      fail(env, 'error: Gemini API rate limit reached (429). Please wait a moment before trying again.');
    }
    if (/timeout/i.test(msg)) {
      fail(env, 'error: Gemini API request timed out.');
    }
    fail(env, `error: Gemini API call failed: ${msg}`);
  }

  let parsedJson: unknown;
  try {
    const cleaned = rawResponse.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    parsedJson = JSON.parse(cleaned);
  } catch (e: unknown) {
    fail(env, `error: Gemini returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const validation = geminiResponseSchema.safeParse(parsedJson);
  if (!validation.success) {
    const issues = validation.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    fail(env, `error: Gemini returned response not matching schema: ${issues}`);
  }

  const data = validation.data;
  const actor = { kind: 'ai' as const, agent: 'gemini' };

  for (const note of data.notes) {
    const noteId = newId('n');
    await log.append({ type: 'NOTE_ADDED', actor, payload: { noteId, text: note } });
  }

  for (const claim of data.claims) {
    const claimId = newId('c');
    await log.append({
      type: 'CLAIM_ADDED',
      actor,
      payload: {
        claimId,
        type: claim.type,
        text: claim.text,
        ...(claim.risk ? { risk: claim.risk } : {}),
        ...(claim.derivedFrom && claim.derivedFrom.length > 0 ? { derivedFrom: claim.derivedFrom } : {}),
      },
    });
  }

  for (const proposal of data.proposals) {
    const proposalId = newId('p');
    await log.append({
      type: 'PROPOSAL_SUBMITTED',
      actor,
      payload: { proposalId, item: proposal },
    });
  }

  const todayCount = await incrementAiUsage(log.rootDir);

  say(
    env,
    `Gemini [ai:gemini] responded (${data.notes.length} notes, ${data.claims.length} claims, ${data.proposals.length} proposals recorded, today's calls: ${todayCount}/${config.gemini.dailyCallLimit}).`,
  );
  if (data.summary) {
    say(env, `Summary: ${data.summary}`);
  }
}

export function registerAi(program: Command, env: Env): void {
  program
    .command('ai <purpose>')
    .description('consult Gemini on a purpose, recording results as unconfirmed AI suggestions')
    .option('--dry-run', 'preview the prompt and token estimate without making any API calls')
    .action((purpose: string, opts: AiCommandOpts) => ai(env, purpose, opts));
}
