/**
 * OpenShell sandbox policies, generated from the project.
 *
 * A policy is YAML that says what a sandbox may touch. CWS generates the smallest
 * policy that lets the project work and nothing more:
 *   - the working directory and `/tmp` are writable, system folders are read-only
 *   - the sandbox runs as a non-root user
 *   - outbound network is denied unless the human approved a specific rule
 *
 * Two rules from OpenShell's own guidance are enforced here, because they need an
 * administrator to be safe: no wildcard hosts, and no `protocol: tcp` / `tls: skip`
 * that would bypass application-level inspection.
 *
 * Rules are validated wherever they enter (a spec, rules.json) and again when the YAML
 * is built, because rules.json lives in the project and anything there can be edited.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SYSTEM_READ_ONLY = ['/usr', '/lib', '/proc', '/dev/urandom', '/app', '/etc', '/var/log'] as const;
export const SANDBOX_READ_WRITE = ['/sandbox', '/tmp', '/dev/null'] as const;

export interface SandboxNetworkRule {
  host: string;
  port: number;
  /** `rest` gets HTTP method and path rules; omit for a plain TLS connection */
  protocol?: 'rest';
  /** when no method is given: `read-only` (GET/HEAD) or `full` */
  access?: 'read-only' | 'full';
  method?: string;
  path?: string;
  /** the only program allowed to use this rule */
  binary?: string;
}

export interface PolicyOptions {
  rules?: readonly SandboxNetworkRule[];
  readOnly?: readonly string[];
  readWrite?: readonly string[];
  runAsUser?: string;
  runAsGroup?: string;
  /** `hard_requirement` refuses to start the sandbox when the rules cannot be applied */
  landlock?: 'best_effort' | 'hard_requirement';
}

/**
 * Values that survive YAML unchanged. A leading `/` or letter is safe; a leading `*`
 * would look like an alias and is rejected earlier by `validateRule`, so it is quoted.
 */
const PLAIN = /^[A-Za-z/][A-Za-z0-9._/:*+\-]*$/;
const SAFE_METHOD = /^[A-Z]+$/;
const SAFE_HOST = /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const ACCESS_LEVELS = ['read-only', 'full'] as const;
/** whitespace and control characters would let a value spill into the surrounding YAML */
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f]/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const ruleSchema = z
  .object({
    host: z.string(),
    port: z.number(),
    protocol: z.literal('rest').optional(),
    access: z.enum(ACCESS_LEVELS).optional(),
    method: z.string().optional(),
    path: z.string().optional(),
    binary: z.string().optional(),
  })
  .strict();

function yamlString(value: string): string {
  return PLAIN.test(value) ? value : JSON.stringify(value);
}

/**
 * `api.github.com:443` → `allow_api_github_com_443_<hash>`: greppable, and the short hash of
 * the whole rule keeps `/repos/a` and `/repos/c`, or `a-b.com` and `a.b.com`, apart.
 */
export function ruleName(rule: SandboxNetworkRule): string {
  const base = `allow_${rule.host.replace(/[^A-Za-z0-9]+/g, '_')}_${rule.port}`;
  const method = rule.method === undefined ? '' : `_${rule.method.toLowerCase()}`;
  const readable = `${base}${method}`.replace(/_+/g, '_').toLowerCase().slice(0, 60).replace(/_+$/, '');
  const identity = [rule.host.toLowerCase(), rule.port, rule.protocol, rule.access, rule.method, rule.path, rule.binary];
  return `${readable}_${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 8)}`;
}

/** Why an IP literal or name points back into the machine or its cloud metadata, or null. */
function internalHostProblem(host: string): string | null {
  const name = host.toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) return `loopback hosts are not allowed: ${host}`;
  if (name === 'metadata.google.internal' || name === 'metadata') return `cloud metadata hosts are not allowed: ${host}`;
  const last = name.split('.').at(-1) ?? '';
  if (!/^(?:\d+|0x[0-9a-f]*)$/.test(last)) return null;
  const octets = IPV4.exec(name)?.slice(1).map(Number);
  if (octets === undefined || name.split('.').some((part) => /^0\d/.test(part)) || octets.some((octet) => octet > 255)) {
    return `write an IP address as four plain numbers: ${host}`;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 127 || a === 0) return `loopback and unspecified addresses are not allowed: ${host}`;
  if (a === 169 && b === 254) return `link-local and cloud metadata addresses are not allowed: ${host}`;
  return null;
}

/** Types first: rules.json can hold anything, and a non-string must not crash the checks below. */
function shapeProblem(rule: SandboxNetworkRule): string | null {
  const value = rule as unknown as Record<string, unknown>;
  if (typeof value !== 'object' || value === null) return 'a rule must be an object';
  if (typeof value['host'] !== 'string') return 'the host must be text';
  if (typeof value['port'] !== 'number') return 'the port must be a number';
  if (value['protocol'] !== undefined && value['protocol'] !== 'rest') return `the protocol can only be rest: ${String(value['protocol'])}`;
  if (value['access'] !== undefined && !(ACCESS_LEVELS as readonly unknown[]).includes(value['access'])) {
    return `access must be read-only or full: ${JSON.stringify(value['access'])}`;
  }
  for (const key of ['method', 'path', 'binary']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return `the ${key} must be text`;
  }
  return null;
}

/** Why a rule would be unsafe or malformed, or null when it is fine. */
export function validateRule(rule: SandboxNetworkRule): string | null {
  const shape = shapeProblem(rule);
  if (shape !== null) return shape;
  if (rule.host.trim() === '') return 'the host is empty';
  if (rule.host.includes('*') && !rule.host.startsWith('*.')) return `wildcard hosts are not allowed: ${rule.host}`;
  if (rule.host.includes('*')) return `wildcard hosts are not allowed, name the exact host: ${rule.host}`;
  if (!SAFE_HOST.test(rule.host)) return `not a host name: ${rule.host}`;
  if (!Number.isInteger(rule.port) || rule.port < 1 || rule.port > 65535) return `not a port: ${rule.port}`;
  if (rule.method !== undefined && !SAFE_METHOD.test(rule.method)) return `the method must be upper case letters: ${rule.method}`;
  if (rule.path !== undefined) {
    if (!rule.path.startsWith('/')) return `the path must start with "/": ${rule.path}`;
    if (rule.path.includes('?')) return `paths may not carry query strings: ${rule.path}`;
    if (UNSAFE_CHARS.test(rule.path)) return `the path may not contain spaces or control characters: ${JSON.stringify(rule.path)}`;
  }
  if (rule.method !== undefined && rule.path === undefined) return 'a method needs a path';
  if (rule.path !== undefined && rule.method === undefined) return 'a path needs a method';
  if (rule.method !== undefined && rule.protocol !== 'rest') return 'a method and path need protocol rest';
  if (rule.binary !== undefined && !rule.binary.startsWith('/')) return `the binary must be an absolute path: ${rule.binary}`;
  if (rule.binary !== undefined && UNSAFE_CHARS.test(rule.binary)) return `the binary may not contain spaces or control characters: ${JSON.stringify(rule.binary)}`;
  return internalHostProblem(rule.host);
}

/** rules.json, strictly: unknown keys, wrong types and unsafe values are errors, never defaults. */
export function parseRules(json: unknown): SandboxNetworkRule[] {
  const parsed = z.array(ruleSchema).safeParse(json);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
  }
  const rules = parsed.data.map((raw): SandboxNetworkRule => {
    const entries = Object.entries(raw).filter(([, value]) => value !== undefined);
    return Object.fromEntries(entries) as unknown as SandboxNetworkRule;
  });
  const problems = rules.flatMap((rule, index) => {
    const problem = validateRule(rule);
    return problem === null ? [] : [`${index}: ${problem}`];
  });
  if (problems.length > 0) throw new Error(problems.join('; '));
  return rules;
}

export function validateRules(rules: readonly SandboxNetworkRule[]): string[] {
  return rules.flatMap((rule) => {
    const problem = validateRule(rule);
    return problem === null ? [] : [problem];
  });
}

function endpointLines(rule: SandboxNetworkRule, indent: string): string[] {
  const lines = [`${indent}- host: ${yamlString(rule.host)}`, `${indent}  port: ${rule.port}`];
  if (rule.protocol === 'rest') lines.push(`${indent}  protocol: rest`);
  lines.push(`${indent}  enforcement: enforce`);
  if (rule.method !== undefined && rule.path !== undefined) {
    lines.push(`${indent}  rules:`, `${indent}    - allow:`, `${indent}        method: ${rule.method}`, `${indent}        path: ${yamlString(rule.path)}`);
  } else {
    const access = rule.access ?? 'read-only';
    if (!ACCESS_LEVELS.includes(access)) throw new Error(`access must be read-only or full: ${JSON.stringify(access)}`);
    lines.push(`${indent}  access: ${access}`);
  }
  return lines;
}

/** Validates every rule (again) and drops exact duplicates, which would repeat a YAML key. */
export function buildPolicy(opts: PolicyOptions = {}): string {
  const problems = validateRules(opts.rules ?? []);
  if (problems.length > 0) throw new Error(problems.join('; '));
  const byName = new Map((opts.rules ?? []).map((rule) => [ruleName(rule), rule] as const));
  const rules = [...byName.values()].sort((a, b) => ruleName(a).localeCompare(ruleName(b)));
  const lines = [
    '# Generated by cws from .cws/sandbox/rules.json and rewritten before every `cws sandbox up` and `run`.',
    '# Add access with `cws sandbox policy --rule`; edits to this file are discarded.',
    'version: 1',
    '',
    'filesystem_policy:',
    '  include_workdir: true',
    '  read_only:',
    ...(opts.readOnly ?? SYSTEM_READ_ONLY).map((path) => `    - ${yamlString(path)}`),
    '  read_write:',
    ...(opts.readWrite ?? SANDBOX_READ_WRITE).map((path) => `    - ${yamlString(path)}`),
    '',
    'landlock:',
    `  compatibility: ${opts.landlock ?? 'best_effort'}`,
    '',
    'process:',
    `  run_as_user: ${yamlString(opts.runAsUser ?? 'sandbox')}`,
    `  run_as_group: ${yamlString(opts.runAsGroup ?? 'sandbox')}`,
  ];

  if (rules.length === 0) {
    lines.push('', '# No network access was approved. All outbound traffic is denied.');
  } else {
    lines.push('', 'network_policies:');
    for (const rule of rules) {
      lines.push(`  ${ruleName(rule)}:`, `    name: ${ruleName(rule)}`, '    endpoints:', ...endpointLines(rule, '      '));
      if (rule.binary !== undefined) lines.push('    binaries:', `      - path: ${yamlString(rule.binary)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * `[binary@]host:port[/METHOD:path]`, e.g.
 *   `api.github.com:443`
 *   `/usr/bin/gh@api.github.com:443/PUT:/repos/o/r/contents/docs/**`
 */
export function parseRuleSpec(spec: string): SandboxNetworkRule {
  const trimmed = spec.trim();
  if (trimmed === '') throw new Error('empty rule');

  const at = trimmed.lastIndexOf('@');
  const binary = at === -1 ? undefined : trimmed.slice(0, at);
  const rest = at === -1 ? trimmed : trimmed.slice(at + 1);

  const slash = rest.indexOf('/');
  const hostPort = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? '' : rest.slice(slash + 1);

  const colon = hostPort.lastIndexOf(':');
  if (colon === -1) return complete({ host: hostPort, port: Number.NaN }, binary);
  const host = hostPort.slice(0, colon);
  const port = Number(hostPort.slice(colon + 1));

  if (tail === '') return complete({ host, port }, binary);
  const methodSplit = tail.indexOf(':');
  if (methodSplit === -1) {
    return complete({ host, port, access: 'read-only' }, binary, `expected METHOD:path after "/", got "${tail}"`);
  }
  return complete({ host, port, protocol: 'rest', method: tail.slice(0, methodSplit), path: tail.slice(methodSplit + 1) }, binary);
}

function complete(rule: SandboxNetworkRule, binary: string | undefined, problem?: string): SandboxNetworkRule {
  if (problem !== undefined) throw new Error(problem);
  const withBinary = binary === undefined || binary === '' ? rule : { ...rule, binary };
  const invalid = validateRule(withBinary);
  if (invalid !== null) throw new Error(invalid);
  return withBinary;
}

export interface PolicyFile {
  /** the policy text itself */
  text: string;
  /** the rules that went into it */
  rules: SandboxNetworkRule[];
}

export function policyFor(rules: readonly SandboxNetworkRule[], opts: Omit<PolicyOptions, 'rules'> = {}): PolicyFile {
  const problems = validateRules(rules);
  if (problems.length > 0) throw new Error(problems.join('; '));
  return { text: buildPolicy({ ...opts, rules }), rules: [...rules] };
}
