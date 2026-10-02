/**
 * The OpenShell command lines CWS builds. Kept apart from running them so every
 * argument list can be checked in a test without a live gateway.
 *
 * Verified against the OpenShell CLI surface:
 *   openshell sandbox create --name N --policy FILE [--from IMAGE] [--provider P]
 *                              [--upload SRC:DST] [--approval-mode auto|manual]
 *                              [--no-keep] [-- command...]
 *   openshell sandbox connect N
 *   openshell sandbox ssh-config N
 *   openshell sandbox delete N
 *   openshell sandbox list
 *   openshell logs N --tail --source sandbox
 *   openshell rule get N --status pending
 *   openshell rule approve N --chunk-id ID
 *   openshell rule reject N --chunk-id ID --reason "why"
 *
 * A one-off command runs through `create ... -- command`, which is the documented way.
 * Running a second command inside a long-lived sandbox goes over SSH
 * (`openshell sandbox ssh-config N` + `ssh -F`), which needs an ssh client, so CWS
 * keeps that path for later and re-creates the sandbox for each `sandbox run`.
 */

export const SANDBOX_NAME_MAX = 19;

export interface SandboxCreateOptions {
  name: string;
  policyFile: string;
  providers?: readonly string[];
  /** `src:/sandbox/dest` pairs; `--upload` takes one value per flag */
  uploads?: readonly string[];
  /** manual keeps every network rule for the human; auto lets OpenShell approve the safe ones */
  approvalMode?: 'auto' | 'manual';
  keep?: boolean;
  /** optional command to run inside the sandbox right after it is created */
  command?: readonly string[];
  image?: string;
}

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
  const args = ['sandbox', 'create', '--name', opts.name, '--policy', opts.policyFile];
  if (opts.image !== undefined) args.push('--from', opts.image);
  for (const provider of opts.providers ?? []) args.push('--provider', provider);
  for (const upload of opts.uploads ?? []) args.push('--upload', upload);
  args.push('--approval-mode', opts.approvalMode ?? 'manual');
  if (opts.keep !== true) args.push('--no-keep');
  if (opts.command !== undefined && opts.command.length > 0) args.push('--', ...opts.command);
  return args;
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
 * The upload spec for mounting the project into the sandbox at `/sandbox`. A colon in the
 * host path (`E:\p`) would make `SRC:DST` ambiguous, so it is refused; callers on native
 * Windows pass `.` with the project as the working directory instead.
 */
export function projectUpload(hostPath: string): string {
  if (hostPath.includes(':')) throw new Error(`the upload path may not contain a colon, which separates it from the sandbox path: ${hostPath}`);
  return `${hostPath}:/sandbox`;
}
