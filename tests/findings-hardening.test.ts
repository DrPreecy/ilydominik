import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/app.ts';
import { findingsFrom } from '../src/cli/commands/findings.ts';
import { EventLog } from '../src/store/event-log.ts';
import { findingClaimText, planIngest } from '../src/findings/ingest.ts';
import { parseSarif } from '../src/findings/sarif.ts';
import { findingFingerprint, findingTag, findingTitle, locatePath, redactSecrets, type Finding } from '../src/findings/types.ts';
import { EXIT, type CliIO } from '../src/cli/io.ts';

interface FakeIO extends CliIO {
  out: string[];
  err: string[];
}

let base: string;

function io(cwd: string, stdin = '', isInteractive = false): FakeIO {
  const fake: FakeIO = {
    cwd,
    out: [],
    err: [],
    isInteractive,
    stdout: (t) => void fake.out.push(t),
    stderr: (t) => void fake.err.push(t),
    ask: async () => '',
    readStdin: async () => stdin,
    challenge: () => 'K7Q',
    copy: async () => true,
  };
  return fake;
}

const text = (fake: FakeIO): string => [...fake.out, ...fake.err].join('\n');
const state = async () => (await EventLog.open(base)).state;
const ingest = (stdin: string, ...args: string[]) => {
  const fake = io(base, stdin);
  return runCli(['findings', 'ingest', '-', '--agent', 'copilot', ...args], fake).then((code) => ({ code, fake }));
};

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cws-findings-h-')));
  assert.equal(await runCli(['init', 'Garden'], io(base, '', true)), EXIT.OK);
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  tool: 'semgrep',
  ruleId: 'rule-1',
  message: 'unvalidated input reaches the query',
  severity: 'high',
  path: 'src/api.ts',
  startLine: 42,
  ...over,
});

const sarifOf = (results: unknown[], rules: unknown[] = []) => ({
  version: '2.1.0',
  runs: [{ tool: { driver: { name: 'semgrep', rules } }, results }],
});

const located = (uri: string, extra: Record<string, unknown> = {}) => ({
  message: { text: 'm' },
  level: 'error',
  locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 3 } } }],
  ...extra,
});

describe('findings ingest: who may record', () => {
  it('refuses a non-interactive ingest without --agent instead of recording it as the human', async () => {
    const fake = io(base, JSON.stringify([finding()]));
    assert.equal(await runCli(['findings', 'ingest', '-', '--format', 'cws'], fake), EXIT.NEEDS_HUMAN);
    assert.equal((await state()).claims.length, 0);
  });
});

describe('findings ingest: duplicates only count claims ingest wrote', () => {
  it('a hand-written claim carrying a finding marker does not pre-empt the real finding', async () => {
    const forged = `${findingTag(findingFingerprint(finding()))} [high] nothing to see here`;
    const refused = io(base);
    assert.notEqual(await runCli(['claim', 'add', '--agent', 'x', '--type', 'HYPOTHESIS', '--text', forged], refused), EXIT.OK);
    assert.match(text(refused), /reserved/);
    const proposal = JSON.stringify([{ item: { kind: 'claim', type: 'HYPOTHESIS', text: forged } }]);
    const proposed = io(base, proposal);
    assert.notEqual(await runCli(['propose', '--agent', 'x', '--json', '-'], proposed), EXIT.OK);
    assert.match(text(proposed), /reserved/);
    const { code, fake } = await ingest(JSON.stringify([finding()]), '--format', 'cws');
    assert.equal(code, EXIT.OK);
    assert.match(text(fake), /1 new, 0 already recorded/);
  });

  it('ignores a marker that is not at the start, or a claim that is not a hypothesis from an ingest note', () => {
    const fp = findingFingerprint(finding());
    const notes = [{ id: 'n1', text: 'just a note', actor: { kind: 'ai', agent: 'x' } }];
    const claims = [
      { id: 'c1', type: 'HYPOTHESIS', text: `see ${findingTag(fp)} [high] x`, derivedFrom: ['n1'], createdBy: { kind: 'ai', agent: 'x' } },
      { id: 'c2', type: 'HYPOTHESIS', text: findingClaimText(finding()), derivedFrom: ['n1'], createdBy: { kind: 'ai', agent: 'x' } },
    ];
    const plan = planIngest({ claims, notes } as never, [finding()]);
    assert.equal(plan.fresh.length, 1);
  });

  it('a human ingest without --agent records the findings as the tool, not as the human', async () => {
    const fake = io(base, JSON.stringify([finding()]), true);
    assert.equal(await runCli(['findings', 'ingest', '-', '--format', 'cws'], fake), EXIT.OK);
    const claim = (await state()).claims[0]!;
    assert.equal(claim.createdBy.kind, 'ai');
    assert.equal(claim.confirmed, false);
  });

  it('still treats a re-run of the same input as duplicates', async () => {
    const payload = JSON.stringify([finding()]);
    await ingest(payload, '--format', 'cws');
    const { fake } = await ingest(payload, '--format', 'cws');
    assert.match(text(fake), /0 new, 1 already recorded/);
    assert.equal((await state()).claims.length, 1);
  });
});

describe('sarif rule ids', () => {
  it('falls back to result.rule.id and to the rule at ruleIndex', () => {
    const rules = [{ id: 'by-index' }];
    const findings = parseSarif(
      sarifOf([located('src/a.ts', { rule: { id: 'by-ref' } }), located('src/a.ts', { ruleIndex: 0 })], rules),
    );
    assert.deepEqual(findings.map((f) => f.ruleId), ['by-ref', 'by-index']);
    assert.notEqual(findingFingerprint(findings[0]!), findingFingerprint(findings[1]!));
  });
});

describe('cws input format validation', () => {
  it('lowercases severity and takes the tool from --tool when the entry has none', () => {
    const [parsed] = findingsFrom([{ path: 'a.ts', message: 'm', severity: 'HIGH' }], 'cws', { tool: 'mytool' });
    assert.equal(parsed?.severity, 'high');
    assert.equal(parsed?.tool, 'mytool');
  });

  it('rejects missing severity, missing tool, non-objects and bad line numbers clearly', () => {
    assert.throws(() => findingsFrom([{ tool: 't', path: 'a.ts', message: 'm' }], 'cws'), /finding #1.*severity/);
    assert.throws(() => findingsFrom([{ path: 'a.ts', message: 'm', severity: 'low' }], 'cws'), /finding #1.*tool.*--tool/);
    assert.throws(() => findingsFrom([null], 'cws'), /finding #1/);
    assert.throws(() => findingsFrom(['x'], 'cws'), /finding #1/);
    assert.throws(() => findingsFrom({ not: 'an array' }, 'cws'), /array/);
    const base = { tool: 't', path: 'a.ts', message: 'm', severity: 'low' };
    assert.throws(() => findingsFrom([{ ...base, startLine: '12' }], 'cws'), /startLine/);
    assert.throws(() => findingsFrom([{ ...base, startLine: 0 }], 'cws'), /startLine/);
    assert.throws(() => findingsFrom([{ ...base, severity: 'urgent' }], 'cws'), /severity/);
  });

  it('applies --tool to ocr-review input too', () => {
    const ocr = { comments: [{ path: 'a.ts', start_line: 3, content: 'bad thing', severity: 'high' }] };
    const [parsed] = findingsFrom(ocr, 'ocr-review', { tool: 'ocr-custom' });
    assert.equal(parsed?.tool, 'ocr-custom');
  });

  it('refuses input larger than the cap before parsing it', async () => {
    const { code, fake } = await ingest(`[${' '.repeat(10_000_001)}]`, '--format', 'cws');
    assert.equal(code, EXIT.ERROR);
    assert.match(text(fake), /too large/);
  });
});

describe('redaction', () => {
  it('redacts bearer tokens, authorization headers and short quoted credentials', () => {
    assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnop'), 'Authorization: [redacted]');
    assert.equal(redactSecrets('curl -H "x: Bearer abcdefghijkl" url'), 'curl -H "x: Bearer [redacted]" url');
    assert.equal(redactSecrets('password: "hunter2"'), 'password: [redacted]');
    assert.equal(redactSecrets("db_password='abcd'"), 'db_password=[redacted]');
    assert.equal(redactSecrets('api_key=abc'), 'api_key=abc');
  });
});

describe('findings list and limits', () => {
  it('shows paths that contain parentheses', async () => {
    await ingest(JSON.stringify([finding({ path: 'src/app (copy).ts' })]), '--format', 'cws');
    const list = io(base);
    assert.equal(await runCli(['findings', 'list'], list), EXIT.OK);
    assert.match(text(list), /high {5}src\/app \(copy\)\.ts —/);
  });

  it('says how many remain over the limit, and a re-run records the next batch', async () => {
    const payload = JSON.stringify([1, 2, 3].map((n) => finding({ path: `src/${n}.ts` })));
    const first = await ingest(payload, '--format', 'cws', '--limit', '2');
    assert.match(text(first.fake), /1 more not recorded yet/);
    assert.equal((await state()).claims.length, 2);
    const second = await ingest(payload, '--format', 'cws', '--limit', '2');
    assert.match(text(second.fake), /1 new, 2 already recorded/);
    assert.doesNotMatch(text(second.fake), /more not recorded/);
    assert.equal((await state()).claims.length, 3);
  });
});

describe('sarif paths', () => {
  it('makes absolute paths inside the project repo-relative', async () => {
    const uri = `file:///${base.replace(/\\/g, '/').replace(/^\//, '')}/src/in.ts`;
    const { code } = await ingest(JSON.stringify(sarifOf([located(uri, { ruleId: 'r' })])));
    assert.equal(code, EXIT.OK);
    assert.match((await state()).claims[0]!.text, /\(src\/in\.ts:3\)$/);
  });

  it('marks absolute and traversal paths outside the project as external', () => {
    assert.deepEqual(locatePath('../../etc/passwd', '/repo'), { path: '../../etc/passwd', external: true });
    assert.deepEqual(locatePath('/etc/passwd', '/repo'), { path: '/etc/passwd', external: true });
    assert.deepEqual(locatePath('/repo/src/a.ts', '/repo'), { path: 'src/a.ts', external: false });
    assert.deepEqual(locatePath('C:/Repo/src/a.ts', 'c:\\repo'), { path: 'src/a.ts', external: false });
    assert.deepEqual(locatePath('./src/../lib/a.ts', '/repo'), { path: 'lib/a.ts', external: false });
    const [outside] = parseSarif(sarifOf([located('file:///etc/passwd', { ruleId: 'r' })]), { root: '/repo' });
    assert.equal(outside?.external, true);
    assert.match(findingTitle(outside!), /\(outside the project: \/etc\/passwd:3\)/);
  });
});
