import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/app.ts';
import { EXIT, type CliIO } from '../src/cli/io.ts';
import { accessDecisionPayload, hostPathFor, reportLines, ruleDecisionPayload, runEvidencePayload, uploadSpec } from '../src/cli/commands/sandbox.ts';
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
import { buildPolicy, parseRules, parseRuleSpec, policyFor, ruleName, validateRule, validateRules, type SandboxNetworkRule } from '../src/integrations/openshell/policy.ts';

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
  delete process.env['CWS_TOOL_OPENSHELL'];
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
    assert.match(ruleName({ host: 'api.github.com', port: 443 }), /^allow_api_github_com_443_[0-9a-f]{8}$/);
    assert.match(ruleName({ host: 'api.github.com', port: 443, method: 'PUT' }), /^allow_api_github_com_443_put_[0-9a-f]{8}$/);
  });

  it('gives different rules different names, so no rule overwrites another', () => {
    const get = (path: string): SandboxNetworkRule => ({ host: 'api.github.com', port: 443, protocol: 'rest', method: 'GET', path });
    assert.notEqual(ruleName(get('/repos/a')), ruleName(get('/repos/c')));
    assert.notEqual(ruleName({ host: 'a-b.com', port: 443 }), ruleName({ host: 'a.b.com', port: 443 }));
    const policy = policyFor([get('/repos/a'), get('/repos/c'), get('/repos/a')]).text;
    assert.equal(policy.match(/^ {2}allow_/gm)?.length, 2);
  });

  it('reads rules.json strictly and explains a bad entry instead of crashing', () => {
    assert.deepEqual(parseRules([{ host: 'api.github.com', port: 443 }]), [{ host: 'api.github.com', port: 443 }]);
    for (const [raw, pattern] of [
      [[{ host: 5 }], /host/],
      [[{ host: 'a.com', port: 443, access: 'full\n    tls: skip' }], /access/],
      [[{ host: 'a.com', port: 443, protocol: 'tcp' }], /protocol/],
      [[{ host: 'a.com', port: 443, tls: 'skip' }], /tls|unrecognized/i],
      [[{ host: 'a.com', port: 443, protocol: 'rest', method: 'GET', path: '/x\n  - allow: {}' }], /path/],
      [{ host: 'a.com' }, /array/i],
    ] as const) {
      assert.throws(() => parseRules(raw), (error: unknown) => error instanceof Error && !(error instanceof TypeError) && pattern.test(error.message), JSON.stringify(raw));
    }
  });

  it('validates again when the YAML is built, whoever calls it', () => {
    const injected = { host: 'a.com', port: 443, access: 'full\n    tls: skip' } as unknown as SandboxNetworkRule;
    assert.throws(() => buildPolicy({ rules: [injected] }), /access/);
    assert.match(String(validateRule({ host: 5 } as unknown as SandboxNetworkRule)), /host/);
    assert.match(String(validateRule({ host: 'a.com', port: 443, method: 'GET', path: '/x' })), /protocol/);
  });

  it('refuses loopback, link-local and metadata hosts', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '169.254.169.254', '169.254.1.1',
      'metadata.google.internal', '2130706433', '0x7f.0.0.1', '127.000.0.1']) {
      assert.notEqual(validateRule({ host, port: 80 }), null, host);
    }
    assert.equal(validateRule({ host: '8.8.8.8', port: 443 }), null);
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
    assert.ok(policy.indexOf('allow_api_github_com_443_put') > 0);
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

  it('mounts the project at /sandbox and refuses a host path with a colon', () => {
    assert.equal(projectUpload('/w/proj'), '/w/proj:/sandbox');
    assert.throws(() => projectUpload('E:\\dev\\proj'), /colon/);
  });

  it('translates host paths for the sandbox mode', () => {
    assert.equal(uploadSpec('wsl', 'E:\\dev\\proj', 'win32'), '/mnt/e/dev/proj:/sandbox');
    assert.equal(uploadSpec('local', 'E:\\dev\\proj', 'win32'), '.:/sandbox');
    assert.equal(uploadSpec('local', '/w/proj', 'linux'), '/w/proj:/sandbox');
    assert.equal(hostPathFor('wsl', 'E:\\p\\.cws\\sandbox\\policy.yaml'), '/mnt/e/p/.cws/sandbox/policy.yaml');
    assert.equal(hostPathFor('local', 'E:\\p\\policy.yaml'), 'E:\\p\\policy.yaml');
    assert.throws(() => hostPathFor('wsl', 'relative\\policy.yaml'), /WSL/);
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

  it('asks for the confirmation code before granting network access', async () => {
    await initProject();
    const io = human(['nope']);
    assert.equal(await cli(io, 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.NEEDS_HUMAN);
    assert.match(errText(io), /Not confirmed/);
    assert.equal(await fs.readFile(rulesFile(), 'utf8').catch(() => null), null);
    assert.equal((await EventLog.open(dir)).state.decisions.length, 0);
  });

  it('writes the policy and records the decision', async () => {
    await initProject();
    const io = human(['K7Q']);
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
    assert.equal(await cli(human(['K7Q']), 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.OK);
    assert.equal(await cli(human(['K7Q']), 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.OK);
    assert.equal(await cli(human(['K7Q']), 'sandbox', 'policy', '--rule', 'registry.npmjs.org:443'), EXIT.OK);
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
    assert.equal(await cli(human(['K7Q']), 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.OK);
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

  it('shows the policy cws will use, not a file someone edited', async () => {
    await initProject();
    await fs.mkdir(path.dirname(policyFile()), { recursive: true });
    await fs.writeFile(policyFile(), 'network_policies:\n  everything: {}\n');
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'policy', '--show'), EXIT.OK);
    assert.match(text(io), /# No network access was approved/);
    assert.doesNotMatch(text(io), /everything/);
    assert.match(text(io), /differs/);
  });

  it('explains a tampered rules file instead of crashing', async () => {
    await initProject();
    await fs.mkdir(path.dirname(rulesFile()), { recursive: true });
    await fs.writeFile(rulesFile(), JSON.stringify([{ host: 5 }]));
    for (const args of [['sandbox', 'status'], ['sandbox', 'policy', '--show']]) {
      const io = human();
      await cli(io, ...args);
      assert.match(text(io) + errText(io), /rules\.json.*host/, args.join(' '));
      assert.doesNotMatch(text(io) + errText(io), /TypeError|Cannot read/, args.join(' '));
    }
  });
});

/** Run fn with no PATH, so openshell cannot be found on this machine either. */
async function withoutPath<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env['PATH'];
  process.env['PATH'] = '';
  try {
    return await fn();
  } finally {
    process.env['PATH'] = original;
  }
}

/** A stand-in for openshell that prints its arguments; it runs through node on every platform. */
async function useStub(mode = 'local'): Promise<void> {
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  const file = path.join(bin, 'openshell.mjs');
  await fs.writeFile(
    file,
    "process.stdout.write(process.argv.slice(2).join(' ') + '\\n');\n" +
      "process.stderr.write('error: no gateway\\n');\n" +
      "process.exit(Number(process.env.CWS_FAKE_EXIT ?? 0));\n",
  );
  process.env['CWS_TOOL_OPENSHELL'] = file;
  await fs.writeFile(path.join(dir, '.cws', 'integrations.json'), JSON.stringify({ version: 1, sandbox: { mode } }));
}

describe('cws sandbox: openshell missing', () => {

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

  it('reports an openshell path from CWS_TOOL_OPENSHELL that no longer exists', async () => {
    await initProject();
    process.env['CWS_TOOL_OPENSHELL'] = path.join(dir, 'missing', 'openshell');
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'up'), EXIT.ERROR);
    assert.match(errText(io), /CWS_TOOL_OPENSHELL does not exist/);
  });

  it('ignores an openshell path planted in the repository config', async () => {
    await initProject();
    await useStub();
    delete process.env['CWS_TOOL_OPENSHELL'];
    await fs.writeFile(
      path.join(dir, '.cws', 'integrations.json'),
      JSON.stringify({ version: 1, sandbox: { mode: 'local' }, tools: { openshell: path.join(dir, 'bin', 'openshell.mjs') } }),
    );
    const io = human();
    assert.equal(await withoutPath(() => cli(io, 'sandbox', 'run', '--', 'ls')), EXIT.ERROR);
    assert.match(errText(io), /openshell. was not found/);
    assert.doesNotMatch(text(io), /sandbox create/);
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

/** Node itself works as a stand-in for openshell on every platform: it is a real executable. */
async function useNodeAsOpenshell(): Promise<void> {
  process.env['CWS_TOOL_OPENSHELL'] = process.execPath;
  await fs.writeFile(path.join(dir, '.cws', 'integrations.json'), JSON.stringify({ version: 1, sandbox: { mode: 'local' } }));
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
    assert.match(text(io), /cws sandbox rules --approve <chunk-id>/);
    assert.match(text(io), /cws sandbox rules --reject <chunk-id>/);
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
  const stubOpenshell = (): Promise<void> => useStub();

  it('regenerates a planted policy file from the approved rules before every run', async () => {
    await initProject();
    await stubOpenshell();
    await fs.mkdir(path.dirname(policyFile()), { recursive: true });
    await fs.writeFile(policyFile(), 'network_policies:\n  everything:\n    endpoints:\n      - host: "*"\n');
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'run', '--', 'ls'), EXIT.OK);
    const written = await fs.readFile(policyFile(), 'utf8');
    assert.match(written, /# No network access was approved/);
    assert.doesNotMatch(written, /everything/);
  });

  it('refuses to start from a tampered rules file', async () => {
    await initProject();
    await stubOpenshell();
    await fs.mkdir(path.dirname(rulesFile()), { recursive: true });
    await fs.writeFile(rulesFile(), JSON.stringify([{ host: 'a.com', port: 443, access: 'full\n    tls: skip' }]));
    for (const args of [['sandbox', 'run', '--', 'ls'], ['sandbox', 'up']]) {
      const io = human();
      assert.equal(await cli(io, ...args), EXIT.ERROR, args.join(' '));
      assert.match(errText(io), /rules\.json.*access/, args.join(' '));
      assert.doesNotMatch(text(io), /sandbox create/, args.join(' '));
    }
    assert.doesNotMatch(await fs.readFile(policyFile(), 'utf8').catch(() => ''), /tls: skip/);
  });

  it('does not start a sandbox when the sandbox mode is off', async () => {
    await initProject();
    await useStub('off');
    for (const args of [['sandbox', 'run', '--', 'ls'], ['sandbox', 'up']]) {
      const io = human();
      assert.equal(await cli(io, ...args), EXIT.ERROR, args.join(' '));
      assert.match(errText(io), /mode is off/, args.join(' '));
      assert.doesNotMatch(text(io), /sandbox create/, args.join(' '));
    }
  });

  it('attaching provider credentials is a human decision with a confirmation code', async () => {
    await initProject();
    await stubOpenshell();
    const declined = agent();
    assert.equal(await cli(declined, 'sandbox', 'up', '--provider', 'github'), EXIT.NEEDS_HUMAN);
    const wrong = human(['nope']);
    assert.equal(await cli(wrong, 'sandbox', 'up', '--provider', 'github'), EXIT.NEEDS_HUMAN);
    assert.doesNotMatch(text(wrong), /sandbox create/);
    const bad = human(['K7Q']);
    assert.equal(await cli(bad, 'sandbox', 'up', '--provider', 'not a name'), EXIT.ERROR);
    const io = human(['K7Q']);
    assert.equal(await cli(io, 'sandbox', 'up', '--provider', 'github'), EXIT.OK);
    assert.match(text(io), /--provider github/);
  });

  it('runs a command in a fresh sandbox and reports it', async () => {
    await initProject();
    await stubOpenshell();

    const io = human();
    assert.equal(await cli(io, 'sandbox', 'run', '--', 'node', '--version'), EXIT.OK);
    const printed = text(io);
    assert.match(printed, /--approval-mode manual/);
    assert.match(printed, /--no-keep/);
    assert.match(printed, /-- node --version/);
  });

  it('keeps the sandbox when asked', async () => {
    await initProject();
    await stubOpenshell();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'run', '--keep', '--', 'ls'), EXIT.OK);
    assert.doesNotMatch(text(io), /--no-keep/);
  });

  it('writes the policy before the first run and passes the exit code through', async () => {
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

  it('lists pending rules and explains how to answer one', async () => {
    await initProject();
    await stubOpenshell();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'rules'), EXIT.OK);
    assert.match(text(io), /rule get cws-.* --status pending/);
    assert.match(text(io), /cws sandbox rules --approve/);
  });

  it('approve is a human decision with a confirmation code, and it is recorded', async () => {
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

  it('records a rejection with the reason', async () => {
    await initProject();
    await stubOpenshell();
    const io = human(['K7Q']);
    assert.equal(await cli(io, 'sandbox', 'rules', '--reject', 'chunk-2', '--reason', 'too wide'), EXIT.OK);
    assert.match(text(io), /--chunk-id chunk-2 --reason too wide/);
    assert.match((await EventLog.open(dir)).state.decisions[0]?.rationale ?? '', /too wide/);
  });

  it('brings a sandbox up with the approved policy and uploads the project', async () => {
    await initProject();
    await stubOpenshell();
    assert.equal(await cli(human(['K7Q']), 'sandbox', 'policy', '--rule', 'api.github.com:443'), EXIT.OK);
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'up'), EXIT.OK);
    const printed = text(io);
    assert.match(printed, /--policy .*policy\.yaml/);
    assert.match(printed, /--upload .*:\/sandbox/);
    assert.match(printed, /Sandbox ready with 1 approved network rule/);
    assert.match(printed, /openshell sandbox connect cws-/);
  });

  it('deletes the sandbox and shows its logs', async () => {
    await initProject();
    await stubOpenshell();
    const io = human();
    assert.equal(await cli(io, 'sandbox', 'down'), EXIT.OK);
    assert.match(text(io), /sandbox delete cws-/);
    assert.equal(await cli(io, 'sandbox', 'logs'), EXIT.OK);
    assert.match(text(io), /logs cws-.* --source sandbox/);
  });
});
