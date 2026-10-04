import fs from 'node:fs/promises';
import path from 'node:path';
import { policyFor, parseRuleSpec, ruleName, type SandboxNetworkRule } from '../../../integrations/openshell/policy.ts';
import { actorOf, confirmDecision, fail, openLog, requireHuman, say, type Env } from '../../human.ts';
import { accessDecisionPayload } from './payloads.ts';
import { approvedRules, messageOf, ruleLabel, sandboxContext, writeFileAtomic, type SandboxContext } from './shared.ts';

/** Prints the policy cws will use, generated from the approved rules, and flags a drifted file. */
async function showPolicy(env: Env, ctx: SandboxContext): Promise<void> {
  const rules = await approvedRules(env, ctx);
  const onDisk = await fs.readFile(ctx.policyFile, 'utf8').catch(() => null);
  const file = path.relative(ctx.root, ctx.policyFile);
  if (onDisk === null && rules.length === 0) return say(env, `No policy yet at ${file}.`);
  const text = policyFor(rules).text;
  say(
    env,
    text.trimEnd(),
    ...(onDisk === text ? [] : ['', `note: ${file} is missing or differs from the approved rules; cws rewrites it before every up and run.`]),
  );
}

export async function policy(env: Env, opts: { rule?: string[]; name?: string; show?: boolean }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  if (opts.show === true) return showPolicy(env, ctx);

  let added: SandboxNetworkRule[] = [];
  try {
    added = (opts.rule ?? []).map(parseRuleSpec);
  } catch (error: unknown) {
    fail(env, `error: ${messageOf(error)}`);
  }
  if (added.length === 0) {
    return say(
      env,
      'Nothing to do. Add the access a task needs, for example:',
      '  cws sandbox policy --rule api.github.com:443',
      '  cws sandbox policy --rule /usr/bin/gh@api.github.com:443/PUT:/repos/me/repo/contents/docs/**',
      'Every rule is a decision: the sandbox gets nothing beyond these.',
    );
  }

  requireHuman(env, 'sandbox policy');
  const existing = await approvedRules(env, ctx);
  const merged = [...existing, ...added.filter((rule) => !existing.some((kept) => ruleName(kept) === ruleName(rule)))];
  let text: string;
  try {
    text = policyFor(merged).text;
  } catch (error: unknown) {
    fail(env, `error: ${messageOf(error)}`);
  }

  say(env, 'This lets code in the sandbox reach:', ...added.map((rule) => `  ${ruleLabel(rule)}`));
  await confirmDecision(env);
  const log = await openLog(env);
  await log.append({ type: 'DECISION_RECORDED', actor: actorOf({}), payload: accessDecisionPayload(added, existing.length) });
  await writeFileAtomic(ctx.rulesFile, `${JSON.stringify(merged, null, 2)}\n`);
  await writeFileAtomic(ctx.policyFile, text);
  say(
    env,
    `Policy written: ${path.relative(ctx.root, ctx.policyFile)}`,
    `${merged.length} network rule(s). All other outbound traffic stays denied.`,
    'The decision is recorded in the log.',
  );
}
