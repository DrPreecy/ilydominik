import { newId } from '../../../domain/ids.ts';
import type { EventInput } from '../../../domain/types.ts';
import type { RunResult } from '../../../integrations/exec.ts';
import type { SandboxNetworkRule } from '../../../integrations/openshell/policy.ts';
import { ruleLabel } from './shared.ts';

/** The decision a human makes when a task needs network access. */
export function accessDecisionPayload(
  added: readonly SandboxNetworkRule[],
  already: number,
): Extract<EventInput, { type: 'DECISION_RECORDED' }>['payload'] {
  return {
    decisionId: newId('d'),
    title: 'Sandbox network access',
    options: added.map(ruleLabel),
    selected: added.map((rule) => rule.host).join(', '),
    rationale:
      `Approved ${added.length} sandbox network rule(s), ${already} from before. ` +
      'Every destination outside these rules stays denied.',
    kind: 'NORMAL',
  };
}

/** The decision a human makes on a rule OpenShell held back. */
export function ruleDecisionPayload(
  chunkId: string,
  approving: boolean,
  reason?: string,
): Extract<EventInput, { type: 'DECISION_RECORDED' }>['payload'] {
  return {
    decisionId: newId('d'),
    title: `Sandbox network rule ${approving ? 'approved' : 'rejected'}`,
    options: [chunkId],
    selected: approving ? `approve ${chunkId}` : `reject ${chunkId}`,
    rationale: approving
      ? 'The human approved this sandbox network rule in OpenShell. Only this rule was added.'
      : `The human rejected this rule${reason === undefined || reason.trim() === '' ? '' : `: ${reason}`}`,
    kind: 'NORMAL',
  };
}

/** A sandbox run is evidence: it has a command, an exit code and a policy behind it. */
export function runEvidencePayload(
  claimId: string,
  command: readonly string[],
  result: RunResult,
  policyPath: string,
): Extract<EventInput, { type: 'EVIDENCE_ADDED' }>['payload'] {
  const outcome = result.timedOut
    ? `timed out after ${(result.durationMs / 1000).toFixed(1)}s`
    : `exited ${result.code ?? 'unknown'} after ${(result.durationMs / 1000).toFixed(1)}s`;
  return {
    evidenceId: newId('e'),
    claimId,
    text: `Sandbox run: \`${command.join(' ')}\` ${outcome}. It reused the policy at ${policyPath}.`,
    source: 'openshell sandbox exec',
  };
}
