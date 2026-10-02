/**
 * The OpenShell command lines CWS builds. Kept apart from running them so every
 * argument list can be checked in a test without a live gateway.
 *
 * Checked against the OpenShell CLI source (crates/openshell-cli/src/main.rs):
 *   openshell sandbox create --detach --name N --policy FILE [--from IMAGE] [--provider P]
 *                              [--upload LOCAL[:DEST]] [--approval-mode auto|manual]
 *   openshell sandbox exec -n N [--workdir DIR] --no-tty -- command...
 *   openshell sandbox connect N
 *   openshell sandbox delete N
 *   openshell sandbox list
 *   openshell logs N --tail --source sandbox
 *   openshell rule get N --status pending
 *   openshell rule approve N --chunk-id ID
 *   openshell rule reject N --chunk-id ID --reason "why"
 *
 * `create` refuses `--upload` together with a command (`conflicts_with = "command"`) and,
 * without a command, would attach an interactive shell. So a run is three calls, as in
 * OpenShell's own end-to-end harness: `create --detach` with the upload, `exec` the command
 * (its exit code is the command's), then `delete` unless the sandbox is kept.
 */

export const SANDBOX_NAME_MAX = 19;

export interface SandboxCreateOptions {
  name: string;
  policyFile: string;
  providers?: readonly string[];
  /** `local:/sandbox/dest` pairs; `--upload` takes one value per flag */
  uploads?: readonly string[];
  /** manual keeps every network rule for the human; auto lets OpenShell approve the safe ones */
  approvalMode?: 'auto' | 'manual';
  image?: string;
}

/** Where the project lands inside the sandbox, and where commands run. */
export const SANDBOX_WORKDIR = '/sandbox';

/** Sandbox names are short and name-safe; the gateway rejects anything else. */
export function assertSandboxName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,18}$/.test(name)) {
    throw new Error(
      `sandbox name must be 1-${SANDBOX_NAME_MAX} lowercase letters, digits or hyphens and start with a letter or digit: ${name}`,
    );
  }
}

export function createArgs(opts: SandboxCreateOptions): string[] {
  assertSandboxName(opts.name);
  const args = ['sandbox', 'create', '--detach', '--name', opts.name, '--policy', opts.policyFile];
  if (opts.image !== undefined) args.push('--from', opts.image);
  for (const provider of opts.providers ?? []) args.push('--provider', provider);
  for (const upload of opts.uploads ?? []) args.push('--upload', upload);
  args.push('--approval-mode', opts.approvalMode ?? 'manual');
  return args;
}

/** Run one command in an existing sandbox; `--` keeps its arguments away from openshell's own flags. */
export function execArgs(name: string, command: readonly string[], workdir: string = SANDBOX_WORKDIR): string[] {
  assertSandboxName(name);
  if (command.length === 0) throw new Error('no command to run');
  return ['sandbox', 'exec', '-n', name, '--workdir', workdir, '--no-tty', '--', ...command];
}

export function connectArgs(name: string): string[] {
  assertSandboxName(name);
  return ['sandbox', 'connect', name];
}


export function deleteArgs(name: string): string[] {
  assertSandboxName(name);
  return ['sandbox', 'delete', name];
}

export function logsArgs(name: string, tail = true, source = 'sandbox'): string[] {
  assertSandboxName(name);
  const args = ['logs', name];
  if (tail) args.push('--tail');
  args.push('--source', source);
  return args;
}

export function listArgs(): string[] {
  return ['sandbox', 'list'];
}

export function ruleGetArgs(name: string, status = 'pending'): string[] {
  assertSandboxName(name);
  return ['rule', 'get', name, '--status', status];
}

export function ruleApproveArgs(name: string, chunkId: string): string[] {
  assertSandboxName(name);
  if (chunkId.trim() === '') throw new Error('no chunk id given');
  return ['rule', 'approve', name, '--chunk-id', chunkId];
}

export function ruleRejectArgs(name: string, chunkId: string, reason?: string): string[] {
  assertSandboxName(name);
  if (chunkId.trim() === '') throw new Error('no chunk id given');
  const args = ['rule', 'reject', name, '--chunk-id', chunkId];
  if (reason !== undefined && reason.trim() !== '') args.push('--reason', reason);
  return args;
}

/**
 * The upload spec for the project. OpenShell splits `LOCAL:DEST` at the first colon, so a
 * Windows path (`E:\p`) cannot be the local side; callers pass `.` and run openshell with the
 * project as its working directory (wsl.exe carries that directory over as `/mnt/...`).
 */
export function projectUpload(hostPath = '.'): string {
  if (hostPath.includes(':')) throw new Error(`the upload path may not contain a colon, which separates it from the sandbox path: ${hostPath}`);
  return `${hostPath}:${SANDBOX_WORKDIR}`;
}
