import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/app.ts';
import { EXIT, type CliIO } from '../src/cli/io.ts';
import { accessDecisionPayload, reportLines, ruleDecisionPayload, runEvidencePayload } from '../src/cli/commands/sandbox.ts';
import { EventLog } from '../src/store/event-log.ts';
import type { RunResult } from '../src/integrations/exec.ts';
import {
  assertSandboxName,
  connectArgs,
  createArgs,
  deleteArgs,
  listArgs,
  logsArgs,
  projectUpload,
  ruleApproveArgs,
  ruleGetArgs,
  ruleRejectArgs,
  SANDBOX_NAME_MAX,
} from '../src/integrations/openshell/args.ts';
import { buildPolicy, parseRuleSpec, policyFor, ruleName, validateRule, validateRules, type SandboxNetworkRule } from '../src/integrations/openshell/policy.ts';

interface FakeIO extends CliIO {
  out: string[];
  err: string[];
  answers: string[];
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-sandbox-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function human(answers: string[] = []): FakeIO {
  const io: FakeIO = {
    cwd: dir,
    out: [],
    err: [],
    answers: [...answers],
    isInteractive: true,
    stdout: (t) => void io.out.push(t),
    stderr: (t) => void io.err.push(t),
    ask: async () => io.answers.shift() ?? '',
    readStdin: async () => '',
    challenge: () => 'K7Q',
    copy: async () => true,
  };
  return io;
}

function agent(): FakeIO {
  const io = human();
  io.isInteractive = false;
  return io;
}

const text = (io: FakeIO) => io.out.join('\n');
const errText = (io: FakeIO) => io.err.join('\n');
const cli = (io: FakeIO, ...args: string[]) => runCli(args, io);

async function initProject(): Promise<void> {
  assert.equal(await cli(human(), 'init', 'Garden'), EXIT.OK);
}

const policyFile = () => path.join(dir, '.cws', 'sandbox', 'policy.yaml');
const rulesFile = () => path.join(dir, '.cws', 'sandbox', 'rules.json');

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

describe('sandbox: policy generation', () => {
  it('names rules in a greppable way', () => {
    assert.equal(ruleName({ host: 'api.github.com', port: 443 }), 'allow_api_github_com_443');
    assert.equal(ruleName({ host: 'api.github.com', port: 443, method: 'PUT' }), 'allow_api_github_com_443_put');
  });

  it('denies everything when no rule was approved', () => {
    const policy = buildPolicy();
    assert.match(policy, /^version: 1$/m);
    assert.match(policy, /# No network access was approved/);
    assert.doesNotMatch(policy, /network_policies/);
  });

  it('writes one endpoint per rule, sorted by rule name', () => {
    const policy = policyFor([
      { host: 'zebra.example.com', port: 443 },
      { host: 'api.github.com', port: 443, protocol: 'rest', method: 'PUT', path: '/repos/me/**', binary: '/usr/bin/gh' },
    ]).text;
    assert.match(policy, /network_policies:/);
    assert.ok(policy.indexOf('allow_api_github_com_443_put') < policy.indexOf('allow_zebra_example_com_443'));
    assert.match(policy, /method: PUT/);
    assert.match(policy, /path: \/repos\/me\/\*\*/);
    assert.match(policy, /binaries:\n {6}- path: \/usr\/bin\/gh/);
    assert.match(policy, /access: read-only/);
  });

  it('runs as a non-root user and marks system paths read-only', () => {
    const policy = buildPolicy();
    assert.match(policy, /run_as_user: sandbox/);
    assert.match(policy, /compatibility: best_effort/);
    assert.match(policy, /read_only:/);
    assert.match(policy, /read_write:/);
  });

  it('is deterministic', () => {
    const rules: SandboxNetworkRule[] = [{ host: 'b.example.com', port: 443 }, { host: 'a.example.com', port: 80 }];
    assert.equal(buildPolicy({ rules }), buildPolicy({ rules: [...rules].reverse() }));
  });

  it('refuses rules that widen access unsafely', () => {
    assert.match(String(validateRule({ host: '*.example.com', port: 443 })), /wildcard/);
    assert.match(String(validateRule({ host: 'example.com', port: 0 })), /not a port/);
    assert.match(String(validateRule({ host: 'example.com', port: 443, method: 'PUT' })), /method needs a path/);
    assert.match(String(validateRule({ host: 'example.com', port: 443, path: '/x' })), /path needs a method/);
    assert.match(String(validateRule({ host: 'example.com', port: 443, method: 'put', path: '/x' })), /upper case/);
    assert.match(String(validateRule({ host: 'example.com', port: 443, method: 'GET', path: '/x?y=1' })), /query strings/);
    assert.match(String(validateRule({ host: 'example.com', port: 443, binary: 'gh' })), /absolute path/);
    assert.equal(validateRule({ host: 'api.github.com', port: 443 }), null);
    assert.equal(validateRules([{ host: 'api.github.com', port: 443 }]).length, 0);
  });

  it('rejects an invalid rule when building the file', () => {
    assert.throws(() => policyFor([{ host: 'bad host', port: 443 }]), /not a host name/);
  });
});

describe('sandbox: rule specs', () => {
  it('parses host:port', () => {
    assert.deepEqual(parseRuleSpec('api.github.com:443'), { host: 'api.github.com', port: 443 });
  });

  it('parses binary@host:port/METHOD:path', () => {
    assert.deepEqual(parseRuleSpec('/usr/bin/gh@api.github.com:443/PUT:/repos/me/**'), {
      host: 'api.github.com',
      port: 443,
      protocol: 'rest',
      method: 'PUT',
      path: '/repos/me/**',
      binary: '/usr/bin/gh',
    });
  });

  it('reports what it could not read', () => {
    assert.throws(() => parseRuleSpec('   '), /empty rule/);
    assert.throws(() => parseRuleSpec('api.github.com'), /not a port/);
    assert.throws(() => parseRuleSpec('api.github.com:443/nonsense'), /expected METHOD:path/);
  });
});

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

describe('sandbox: openshell arguments', () => {
  it('checks the sandbox name', () => {
    assert.doesNotThrow(() => assertSandboxName('cws-demo'));
    assert.throws(() => assertSandboxName('CWS'), /lowercase/);
    assert.throws(() => assertSandboxName('-lead'), /lowercase/);
    assert.throws(() => assertSandboxName('x'.repeat(SANDBOX_NAME_MAX + 1)), /lowercase/);
  });

  it('builds create arguments, including the one-off command', () => {
    assert.deepEqual(createArgs({ name: 'sb', policyFile: '/p/policy.yaml' }), [
      'sandbox', 'create', '--name', 'sb', '--policy', '/p/policy.yaml', '--approval-mode', 'manual', '--no-keep',
    ]);
    assert.deepEqual(
      createArgs({ name: 'sb', policyFile: '/p/policy.yaml', keep: true, providers: ['github'], uploads: ['/w:/sandbox'], command: ['ls', '-la'] }),
      ['sandbox', 'create', '--name', 'sb', '--policy', '/p/policy.yaml', '--provider', 'github', '--upload', '/w:/sandbox', '--approval-mode', 'manual', '--', 'ls', '-la'],
    );
    assert.deepEqual(createArgs({ name: 'sb', policyFile: '/p', image: 'ubuntu:24.04' }).slice(0, 6), [
      'sandbox', 'create', '--name', 'sb', '--policy', '/p',
    ]);
    const withImage = createArgs({ name: 'sb', policyFile: '/p', image: 'ubuntu:24.04' });
    assert.equal(withImage[withImage.indexOf('--from') + 1], 'ubuntu:24.04');
  });

  it('builds the other subcommands', () => {
    assert.deepEqual(connectArgs('sb'), ['sandbox', 'connect', 'sb']);
    assert.deepEqual(deleteArgs('sb'), ['sandbox', 'delete', 'sb']);
    assert.deepEqual(listArgs(), ['sandbox', 'list']);
    assert.deepEqual(logsArgs('sb'), ['logs', 'sb', '--tail', '--source', 'sandbox']);
    assert.deepEqual(logsArgs('sb', false), ['logs', 'sb', '--source', 'sandbox']);
    assert.deepEqual(ruleGetArgs('sb'), ['rule', 'get', 'sb', '--status', 'pending']);
    assert.deepEqual(ruleApproveArgs('sb', 'c1'), ['rule', 'approve', 'sb', '--chunk-id', 'c1']);
    assert.deepEqual(ruleRejectArgs('sb', 'c1'), ['rule', 'reject', 'sb', '--chunk-id', 'c1']);
    assert.deepEqual(ruleRejectArgs('sb', 'c1', 'too wide'), ['rule', 'reject', 'sb', '--chunk-id', 'c1', '--reason', 'too wide']);
  });

  it('refuses an empty chunk id', () => {
    assert.throws(() => ruleApproveArgs('sb', '  '), /no chunk id/);
  });

  it('mounts the project at /sandbox', () => {
    assert.equal(projectUpload('E:\\dev\\proj'), 'E:\\dev\\proj:/sandbox');
  });
});

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

describe('cws sandbox: status', () => {
  it('needs a project', async () => {
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'status'), EXIT.ERROR);
    assert.match(errText(io), /cws init/);
  });

  it('reports the mode, the policy and whether openshell is there', async () => {
    await initProject();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'status'), EXIT.OK);
    assert.match(text(io), /^Sandbox: cws-/m);
    assert.match(text(io), /^Mode: /m);
    assert.match(text(io), /0 approved network rules/);
  });

  it('rejects a name the gateway would refuse', async () => {
    await initProject();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'status', '--name', 'Not Valid'), EXIT.ERROR);
    assert.match(errText(io), /lowercase/);
  });
});

describe('cws sandbox: policy', () => {
  it('explains what a rule looks like when none was given', async () => {
    await initProject();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'policy'), EXIT.OK);
    assert.match(text(io), /Nothing to do/);
    assert.equal(await fs.readFile(policyFile(), 'utf8').catch(() => null), null);
  });

  it('is a human action: an agent cannot approve network access', async () => {
    await initProject();
    const io = agent();
    assert.equal(await cli(io, 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.NEEDS_HUMAN);
    assert.match(errText(io), /human action/);
    assert.equal(await fs.readFile(rulesFile(), 'utf8').catch(() => null), null);
  });

  it('writes the policy and records the decision', async () => {
    await initProject();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.OK);
    const written = await fs.readFile(policyFile(), 'utf8');
    assert.match(written, /allow_api_github_com_443/);
    assert.deepEqual(JSON.parse(await fs.readFile(rulesFile(), 'utf8')), [{ host: 'api.github.com', port: 443 }]);
    const state = (await EventLog.open(dir)).state;
    assert.equal(state.decisions.length, 1);
    assert.equal(state.decisions[0]?.title, 'Sandbox network access');
    assert.match(state.decisions[0]?.rationale ?? '', /outside these rules stays denied/);
    assert.match(text(io), /Policy written/);
  });

  it('adds to the rules instead of replacing them', async () => {
    await initProject();
    assert.equal(await cli(human(), 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.OK);
    assert.equal(await cli(human(), 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.OK);
    assert.equal(await cli(human(), 'sandbox', 'policy', '--rule', 'registry.npmjs.org:443'), EXIT.OK);
    const rules = JSON.parse(await fs.readFile(rulesFile(), 'utf8')) as SandboxNetworkRule[];
    assert.equal(rules.length, 2);
    assert.match(await fs.readFile(policyFile(), 'utf8'), /allow_registry_npmjs_org_443/);
  });

  it('refuses a rule it cannot trust, before asking the human', async () => {
    await initProject();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'policy', '--rule', '*.evil.com:443'), EXIT.ERROR);
    assert.match(errText(io), /wildcard/);
    assert.equal(await fs.readFile(rulesFile(), 'utf8').catch(() => null), null);
  });

  it('shows the current policy', async () => {
    await initProject();
    assert.equal(await cli(human(), 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.OK);
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'policy', '--show'), EXIT.OK);
    assert.match(text(io), /allow_api_github_com_443/);
  });

  it('says so when there is no policy yet', async () => {
    await initProject();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'policy', '--show'), EXIT.OK);
    assert.match(text(io), /No policy yet/);
  });
});

describe('cws sandbox: openshell missing', () => {
  /** Run `fn` with no PATH, so `openshell` cannot be found on this machine either. */
  async function withoutPath<T>(fn: () => Promise<T>): Promise<T> {
    const original = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      return await fn();
    } finally {
      process.env['PATH'] = original;
    }
  }

  it('explains what to do instead of failing with a spawn error', async () => {
    await initProject();
    const io = human();
    assert.equal(await withoutPath(() => cli(io, 'sandbox', 'up')), EXIT.ERROR);
    assert.match(errText(io), /openshell` was not found/);
    assert.match(errText(io), /safe-run/);
  });

  it('fails clearly for run, down, rules and logs too', async () => {
    await initProject();
    for (const args of [['sandbox', 'run', '--', 'ls'], ['sandbox', 'down'], ['sandbox', 'rules'], ['sandbox', 'logs']] as const) {
      const io = human();
      assert.equal(await withoutPath(() => cli(io, ...args)), EXIT.ERROR, args.join(' '));
      assert.match(errText(io), /openshell` was not found/);
    }
  });

  it('does not create a sandbox when there is nothing to run', async () => {
    await initProject();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'run'), EXIT.ERROR);
    assert.match(errText(io), /nothing to run/);
  });

  it('reports a configured openshell path that no longer exists', async () => {
    await initProject();
    await fs.writeFile(
      path.join(dir, '.cws', 'integrations.json'),
      JSON.stringify({ version: 1, tools: { openshell: path.join(dir, 'missing', 'openshell') } }),
    );
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'up'), EXIT.ERROR);
    assert.match(errText(io), /does not exist/);
  });

  it('still shows status without openshell', async () => {
    await initProject();
    const io = human();
    assert.equal(await withoutPath(() => cli(io, 'sandbox', 'status')), EXIT.OK);
    assert.match(text(io), /openshell: not found/);
    assert.match(text(io), /safe-run/);
  });
});

// ---------------------------------------------------------------------------
// what cws reports and records (pure, so it is checked on every platform)
// ---------------------------------------------------------------------------

function runResult(over: Partial<RunResult> = {}): RunResult {
  return {
    command: 'openshell',
    args: [],
    ok: true,
    code: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 2500,
    stdout: '',
    stderr: '',
    ...over,
  };
}

describe('cws sandbox: reporting and recording', () => {
  it('reports a successful run with its output', () => {
    const lines = reportLines('sandbox run: ls', runResult({ stdout: 'a.txt\n' }));
    assert.deepEqual(lines.out, ['sandbox run: ls ok (2.5s)', 'a.txt']);
    assert.deepEqual(lines.err, []);
  });

  it('reports a failure on stderr, with the exit code and what went wrong', () => {
    const lines = reportLines('rule approve', runResult({ ok: false, code: 4, stderr: 'no gateway\n' }));
    assert.deepEqual(lines.out, []);
    assert.equal(lines.err[0], 'rule approve failed (exit 4, 2.5s)');
    assert.equal(lines.err[1], 'no gateway');
  });

  it('names a timeout instead of pretending it was an exit code', () => {
    const lines = reportLines('sandbox up', runResult({ ok: false, code: null, timedOut: true }));
    assert.match(lines.err[0] ?? '', /failed \(timed out, 2.5s\)/);
  });

  it('records the access decision with the rules that were approved', () => {
    const payload = accessDecisionPayload([{ host: 'api.github.com', port: 443 }, { host: 'x.example.com', port: 443, method: 'PUT', path: '/a/**' }], 2);
    assert.equal(payload.title, 'Sandbox network access');
    assert.deepEqual(payload.options, ['api.github.com:443', 'x.example.com:443 PUT /a/**']);
    assert.equal(payload.selected, 'api.github.com, x.example.com');
    assert.match(payload.rationale, /2 from before/);
    assert.match(payload.rationale, /stays denied/);
  });

  it('records a rule approval and a rejection differently', () => {
    const approved = ruleDecisionPayload('c1', true);
    assert.equal(approved.selected, 'approve c1');
    assert.match(approved.rationale, /Only this rule was added/);
    const rejected = ruleDecisionPayload('c2', false, 'wider than the task');
    assert.equal(rejected.selected, 'reject c2');
    assert.match(rejected.rationale, /wider than the task/);
    assert.doesNotMatch(ruleDecisionPayload('c3', false).rationale, /:/);
  });

  it('records a run as evidence with the command and the policy it used', () => {
    const payload = runEvidencePayload('cl_1', ['node', '--version'], runResult({ code: 0 }), '.cws/sandbox/policy.yaml');
    assert.equal(payload.claimId, 'cl_1');
    assert.match(payload.text, /`node --version` exited 0 after 2\.5s/);
    assert.match(payload.text, /\.cws\/sandbox\/policy\.yaml/);
    const timedOut = runEvidencePayload('cl_1', ['sleep', '9'], runResult({ ok: false, code: null, timedOut: true }), 'p.yaml');
    assert.match(timedOut.text, /timed out after/);
  });
});

// ---------------------------------------------------------------------------
// a stand-in for openshell
// ---------------------------------------------------------------------------

/** These need a real executable; on Windows every candidate would be a batch shim. */
const posixOnly = { skip: process.platform === 'win32' ? 'needs a real executable, not a batch shim' : false };

/** Node itself works as a stand-in for openshell on every platform: it is a real executable. */
async function useNodeAsOpenshell(): Promise<void> {
  await fs.writeFile(
    path.join(dir, '.cws', 'integrations.json'),
    JSON.stringify({ version: 1, tools: { openshell: process.execPath } }),
  );
}

async function claim(): Promise<string> {
  assert.equal(
    await cli(human(), 'claim', 'add', '--type', 'HYPOTHESIS', '--text', 'Node 24 is present', '--agent', 'copilot'),
    EXIT.OK,
  );
  return (await EventLog.open(dir)).state.claims[0]?.id ?? '';
}

describe('cws sandbox: openshell present but failing', () => {
  it('passes the command through after -- and records the run as evidence', async () => {
    await initProject();
    const claimId = await claim();
    await useNodeAsOpenshell();

    const io = human();
    // node is handed `sandbox create ...`: it cannot find that file, so the run fails.
    const code = await cli(io, 'sandbox', 'run', '--agent', 'copilot', '--claim', claimId, '--', 'node', '--version');
    assert.notEqual(code, EXIT.OK);
    assert.match(errText(io), /sandbox run: node --version failed \(exit /);

    const attached = (await EventLog.open(dir)).state.claims.find((c) => c.id === claimId)?.evidence ?? [];
    assert.equal(attached.length, 1);
    assert.match(attached[0]?.text ?? '', /`node --version`/);
    assert.match(attached[0]?.text ?? '', /\.cws[\\/]sandbox[\\/]policy\.yaml/);
    assert.equal(attached[0]?.actor.kind, 'ai');
    assert.match(await fs.readFile(policyFile(), 'utf8'), /# No network access was approved/);
  });

  it('writes the policy before the first run', async () => {
    await initProject();
    await useNodeAsOpenshell();
    assert.equal(await fs.readFile(policyFile(), 'utf8').catch(() => null), null);
    await cli(human(), 'sandbox', 'run', '--', 'ls');
    assert.match(await fs.readFile(policyFile(), 'utf8'), /read_write:/);
  });

  it('fails clearly for up, down, logs and the rule list', async () => {
    await initProject();
    await useNodeAsOpenshell();
    for (const [pattern, args] of [
      [/sandbox cws-\S+ up failed \(exit /, ['sandbox', 'up']],
      [/sandbox cws-\S+ down failed \(exit /, ['sandbox', 'down']],
      [/sandbox logs cws-\S+ failed \(exit /, ['sandbox', 'logs']],
      [/^rule get failed \(exit /, ['sandbox', 'rules']],
    ] as const) {
      const io = human();
      assert.notEqual(await cli(io, ...args), EXIT.OK, args.join(' '));
      assert.match(errText(io), pattern, args.join(' '));
    }
  });

  it('shows how to answer a rule even when listing them fails', async () => {
    await initProject();
    await useNodeAsOpenshell();
    const io = human();
    assert.notEqual(await cli(io, 'sandbox', 'rules'), EXIT.OK);
    assert.match(text(io), /cws sandbox approve/);
    assert.match(text(io), /cws sandbox reject/);
  });

  it('does not record a rule decision when the tool refuses', async () => {
    await initProject();
    await useNodeAsOpenshell();
    const io = human(['K7Q']);
    assert.notEqual(await cli(io, 'sandbox', 'rules', '--approve', 'chunk-9'), EXIT.OK);
    assert.match(errText(io), /rule approve failed \(exit /);
    assert.equal((await EventLog.open(dir)).state.decisions.length, 0);
  });
});

describe('cws sandbox: with openshell', () => {
  /** A stand-in that prints the arguments it was called with, on one line. */
  async function stubOpenshell(): Promise<void> {
    const bin = path.join(dir, 'bin');
    await fs.mkdir(bin, { recursive: true });
    const file = path.join(bin, 'openshell');
    await fs.writeFile(file, '#!/bin/sh\nprintf "%s\\n" "$*"\nprintf "error: no gateway\\n" >&2\nexit ${CWS_FAKE_EXIT:-0}\n');
    await fs.chmod(file, 0o755);
    await fs.writeFile(
      path.join(dir, '.cws', 'integrations.json'),
      JSON.stringify({ version: 1, tools: { openshell: file } }),
    );
  }

  it('runs a command in a fresh sandbox and reports it', posixOnly, async () => {
    await initProject();
    await stubOpenshell();

    const io = human();
    assert.equal(await cli(io, 'sandbox', 'run', '--', 'node', '--version'), EXIT.OK);
    const printed = text(io);
    assert.match(printed, /--approval-mode manual/);
    assert.match(printed, /--no-keep/);
    assert.match(printed, /-- node --version/);
  });

  it('keeps the sandbox when asked', posixOnly, async () => {
    await initProject();
    await stubOpenshell();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'run', '--keep', '--', 'ls'), EXIT.OK);
    assert.doesNotMatch(text(io), /--no-keep/);
  });

  it('writes the policy before the first run and passes the exit code through', posixOnly, async () => {
    await initProject();
    await stubOpenshell();
    process.env['CWS_FAKE_EXIT'] = '3';
    try {
      const io = human();
      assert.equal(await cli(io, 'sandbox', 'run', '--', 'false'), 3);
      assert.match(errText(io), /failed \(exit 3/);
    } finally {
      delete process.env['CWS_FAKE_EXIT'];
    }
    assert.match(await fs.readFile(policyFile(), 'utf8'), /# No network access was approved/);
  });

  it('lists pending rules and explains how to answer one', posixOnly, async () => {
    await initProject();
    await stubOpenshell();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'rules'), EXIT.OK);
    assert.match(text(io), /rule get cws-.* --status pending/);
    assert.match(text(io), /cws sandbox approve/);
  });

  it('approve is a human decision with a confirmation code, and it is recorded', posixOnly, async () => {
    await initProject();
    await stubOpenshell();

    const declined = agent();
    assert.equal(await cli(declined, 'sandbox', 'rules', '--approve', 'chunk-1'), EXIT.NEEDS_HUMAN);

    const wrong = human(['nope']);
    assert.equal(await cli(wrong, 'sandbox', 'rules', '--approve', 'chunk-1'), EXIT.NEEDS_HUMAN);
    assert.match(errText(wrong), /Not confirmed/);
    assert.equal((await EventLog.open(dir)).state.decisions.length, 0);

    const io = human(['K7Q']);
    assert.equal(await cli(io, 'sandbox', 'rules', '--approve', 'chunk-1'), EXIT.OK);
    assert.match(text(io), /rule approve cws-.* --chunk-id chunk-1/);
    const decision = (await EventLog.open(dir)).state.decisions[0];
    assert.equal(decision?.selected, 'approve chunk-1');
  });

  it('records a rejection with the reason', posixOnly, async () => {
    await initProject();
    await stubOpenshell();
    const io = human(['K7Q']);
    assert.equal(await cli(io, 'sandbox', 'rules', '--reject', 'chunk-2', '--reason', 'too wide'), EXIT.OK);
    assert.match(text(io), /--chunk-id chunk-2 --reason too wide/);
    assert.match((await EventLog.open(dir)).state.decisions[0]?.rationale ?? '', /too wide/);
  });

  it('brings a sandbox up with the approved policy and uploads the project', posixOnly, async () => {
    await initProject();
    await stubOpenshell();
    assert.equal(await cli(human(), 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.OK);
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'up'), EXIT.OK);
    const printed = text(io);
    assert.match(printed, /--policy .*policy\.yaml/);
    assert.match(printed, /--upload .*:\/sandbox/);
    assert.match(printed, /Sandbox ready with 1 approved network rule/);
    assert.match(printed, /openshell sandbox connect cws-/);
  });

  it('deletes the sandbox and shows its logs', posixOnly, async () => {
    await initProject();
    await stubOpenshell();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'down'), EXIT.OK);
    assert.match(text(io), /sandbox delete cws-/);
    assert.equal(await cli(io, 'sandbox', 'logs'), EXIT.OK);
    assert.match(text(io), /logs cws-.* --source sandbox/);
  });
});
