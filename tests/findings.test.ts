import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/app.ts';
import { detectFormat, findingsFrom } from '../src/cli/commands/findings.ts';
import { EventLog } from '../src/store/event-log.ts';
import { findingClaimInputs, findingClaimText, findingsNoteText, openFindings, planIngest, recordedFindings } from '../src/findings/ingest.ts';
import { parseSarif, severityFor, toolFromDriverName, uriToPath } from '../src/findings/sarif.ts';
import {
  findingFingerprint,
  findingMarkerOf,
  findingTag,
  findingTitle,
  isAtLeast,
  normalizePath,
  redactSecrets,
  severityRank,
  severityToRisk,
  type Finding,
} from '../src/findings/types.ts';
import {
  coverageLines,
  missingRuleFiles,
  parseOcrComments,
  parseOcrPreview,
  parseOcrRules,
  previewArgs,
  ruleLines,
  rulesArgs,
} from '../src/integrations/ocr.ts';
import { fakeSecret } from './helpers.ts';
import { EXIT, type CliIO } from '../src/cli/io.ts';

interface FakeIO extends CliIO {
  out: string[];
  err: string[];
  stdin: string;
}

let base: string;

function io(cwd: string, stdin = '', isInteractive = false): FakeIO {
  const fake: FakeIO = {
    cwd,
    out: [],
    err: [],
    stdin,
    isInteractive,
    stdout: (t) => void fake.out.push(t),
    stderr: (t) => void fake.err.push(t),
    ask: async () => '',
    readStdin: async () => fake.stdin,
    challenge: () => 'K7Q',
    copy: async () => true,
  };
  return fake;
}

const text = (fake: FakeIO): string => [...fake.out, ...fake.err].join('\n');

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-findings-'));
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

describe('finding shape', () => {
  it('maps severity to risk and orders severities', () => {
    assert.equal(severityToRisk('critical'), 'FATAL');
    assert.equal(severityToRisk('high'), 'HIGH');
    assert.equal(severityToRisk('medium'), 'MEDIUM');
    assert.equal(severityToRisk('low'), 'LOW');
    assert.equal(severityToRisk('note'), 'LOW');
    assert.equal(severityRank('critical') < severityRank('note'), true);
    assert.equal(isAtLeast('high', 'medium'), true);
    assert.equal(isAtLeast('low', 'medium'), false);
  });

  it('normalizes paths and fingerprints by tool, rule and place', () => {
    assert.equal(normalizePath('.\\src\\a.ts'), 'src/a.ts');
    assert.equal(normalizePath('/src/a.ts'), 'src/a.ts');
    const one = findingFingerprint(finding());
    assert.equal(one, findingFingerprint(finding({ message: 'reworded message' })));
    assert.notEqual(one, findingFingerprint(finding({ startLine: 43 })));
    assert.notEqual(one, findingFingerprint(finding({ path: 'src/other.ts' })));
    assert.notEqual(one, findingFingerprint(finding({ tool: 'codeql' })));
    assert.equal(one.length, 16);
  });

  it('round-trips the marker in claim text', () => {
    const fingerprint = findingFingerprint(finding());
    assert.equal(findingMarkerOf(`${findingTag(fingerprint)} [high] something`), fingerprint);
    assert.equal(findingMarkerOf(`see ${findingTag(fingerprint)} [high] something`), null);
    assert.equal(findingMarkerOf('an ordinary claim'), null);
  });

  it('redacts secrets and flattens whitespace', () => {
    assert.equal(redactSecrets('key AKIAIOSFODNN7EXAMPLE here'), 'key [redacted] here');
    assert.equal(redactSecrets(fakeSecret('token: "gh~p_abcdefghijklmnopqrstuvwx"')), 'token: [redacted]');
    assert.equal(redactSecrets(fakeSecret('pass~word = hunter2secret')), 'password = [redacted]');
    assert.equal(redactSecrets(fakeSecret('headers: { Authorization: Bea~rer abcdefghijklmnop }')), 'headers: { Authorization: [redacted] }');
    assert.match(redactSecrets(fakeSecret('-----BEGIN RSA PRIV~ATE KEY-----\nMIIE\n-----END RSA PRIV~ATE KEY-----')), /^\[redacted\]$/);
    assert.equal(redactSecrets('line one\n\n  line two'), 'line one line two');
    assert.equal(redactSecrets('x'.repeat(50), 10).length, 10);
  });

  it('describes a finding in one line', () => {
    const title = findingTitle(finding());
    assert.match(title, /semgrep rule-1: unvalidated input/);
    assert.match(title, /\(src\/api\.ts:42\)/);
  });
});

describe('sarif', () => {
  const codeql = {
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'CodeQL',
            rules: [
              {
                id: 'js/sql-injection',
                defaultConfiguration: { level: 'warning' },
                properties: { tags: ['security'], 'security-severity': '9.8' },
                helpUri: 'https://example.test/rule',
              },
            ],
          },
        },
        results: [
          {
            ruleId: 'js/sql-injection',
            level: 'warning',
            message: { text: 'This query depends on user input.' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'file:///repo/src/db.ts' },
                  region: { startLine: 12, endLine: 14, snippet: { text: "db.query('... ' + input)" } },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  it('reads a rule’s security-severity and keeps the location', () => {
    const [parsed] = parseSarif(codeql, { root: '/repo' });
    assert.equal(parsed?.tool, 'codeql');
    assert.equal(parsed?.ruleId, 'js/sql-injection');
    assert.equal(parsed?.severity, 'critical');
    assert.equal(parsed?.path, 'src/db.ts');
    assert.equal(parsed?.startLine, 12);
    assert.equal(parsed?.endLine, 14);
    assert.equal(parsed?.category, 'security');
    assert.equal(parsed?.helpUri, 'https://example.test/rule');
  });

  it('falls back to the result level and skips results without a location', () => {
    const doc = {
      runs: [
        {
          tool: { driver: { name: 'Semgrep' } },
          results: [
            { ruleId: 'x', level: 'error', message: { text: 'bad' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.ts' } } }] },
            { ruleId: 'y', level: 'note', message: { text: 'hint' } },
          ],
        },
      ],
    };
    const findings = parseSarif(doc);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.tool, 'semgrep');
    assert.equal(findings[0]?.severity, 'high');
    assert.equal(findings[0]?.startLine, undefined);
  });

  it('maps severities and tool names', () => {
    assert.equal(severityFor('error', undefined), 'high');
    assert.equal(severityFor('warning', undefined), 'medium');
    assert.equal(severityFor(undefined, undefined), 'medium');
    assert.equal(severityFor('note', undefined), 'low');
    assert.equal(severityFor('none', undefined), 'note');
    assert.equal(severityFor('warning', '7.5'), 'high');
    assert.equal(severityFor('error', '3'), 'low');
    assert.equal(toolFromDriverName('OpenCodeReview'), 'ocr');
    assert.equal(toolFromDriverName('CodeQL'), 'codeql');
    assert.equal(toolFromDriverName(undefined), 'sarif');
  });

  it('decodes URIs and honors a limit', () => {
    assert.equal(uriToPath('file:///src%20dir/a.ts'), '/src dir/a.ts');
    assert.equal(uriToPath('file:///C:/repo/a.ts'), 'C:/repo/a.ts');
    assert.equal(uriToPath('src\\b.ts'), 'src/b.ts');
    const many = {
      runs: [
        {
          tool: { driver: { name: 'semgrep' } },
          results: [1, 2, 3].map((n) => ({
            ruleId: `r${n}`,
            message: { text: 'm' },
            locations: [{ physicalLocation: { artifactLocation: { uri: `src/${n}.ts` } } }],
          })),
        },
      ],
    };
    assert.equal(parseSarif(many, { limit: 2 }).length, 2);
    assert.equal(parseSarif(many, { tool: 'custom' })[0]?.tool, 'custom');
  });

  it('rejects JSON that is not SARIF', () => {
    assert.throws(() => parseSarif({ comments: [] }), /not a SARIF/);
  });
});

describe('ocr delegate contracts', () => {
  const preview = {
    schema_version: '1',
    mode: 'range',
    repository: '/repo',
    from: 'main',
    to: 'feature',
    merge_base: 'abc',
    total_files: 3,
    reviewable_count: 2,
    excluded_count: 1,
    total_insertions: 10,
    total_deletions: 4,
    reviewable_files: [
      { path: 'src/a.go', status: 'MODIFIED', insertions: 6, deletions: 2 },
      { path: 'src/b.go', status: 'ADDED', insertions: 4, deletions: 2 },
    ],
    excluded_files: [{ path: 'docs/x.md', status: 'MODIFIED', insertions: 0, deletions: 0, exclude_reason: 'unsupported_ext' }],
  };

  it('parses a preview and renders the coverage checklist', () => {
    const parsed = parseOcrPreview(preview);
    assert.equal(parsed.mode, 'range');
    assert.equal(parsed.reviewableCount, 2);
    assert.equal(parsed.excluded[0]?.excludeReason, 'unsupported_ext');
    const lines = coverageLines(parsed);
    assert.match(lines[0] ?? '', /range review: 2 to review, 1 excluded \(\+10\/-4\)/);
    assert.match(lines.join('\n'), /src\/a\.go/);
    assert.match(lines.join('\n'), /unsupported_ext/);
  });

  it('parses rule groups and finds files with no rule', () => {
    const groups = parseOcrRules({
      schema_version: '1',
      groups: [{ group_id: 1, source: 'system', pattern: '**/*.go', files: ['src/a.go'], rule: 'GO CHECKLIST' }],
    });
    assert.equal(groups[0]?.rule, 'GO CHECKLIST');
    assert.deepEqual(missingRuleFiles(groups, ['src/a.go', 'src/b.go']), ['src/b.go']);
    assert.match(ruleLines(groups).join('\n'), /system \/ \*\*\/\*\.go — src\/a\.go/);
  });

  it('reads full-mode review comments as findings', () => {
    const findings = parseOcrComments({
      status: 'success',
      summary: { files_reviewed: 3 },
      comments: [
        { path: 'src/a.go', content: 'lock the map', start_line: 4, end_line: 6, severity: 'critical', category: 'bug' },
        { path: 'src/b.go', content: 'style note' },
      ],
    });
    assert.equal(findings[0]?.severity, 'critical');
    assert.equal(findings[0]?.category, 'bug');
    assert.equal(findings[0]?.tool, 'ocr');
    assert.equal(findings[1]?.severity, 'medium');
  });

  it('builds argument lists and rejects wrong shapes', () => {
    assert.deepEqual(previewArgs({ from: 'main', to: 'feature' }), ['delegate', 'preview', '--format', 'json', '--from', 'main', '--to', 'feature']);
    assert.deepEqual(rulesArgs(['a.go']), ['delegate', 'rule', '--format', 'json', '--', 'a.go']);
    assert.throws(() => parseOcrPreview({ mode: 'range' }), /not an OCR delegate preview/);
    assert.throws(() => parseOcrRules({ groups: 'nope' }), /not OCR delegate rules/);
    assert.throws(() => parseOcrComments({}), /not an OCR review result/);
  });
});

const AGENT = { kind: 'ai', agent: 'copilot' } as const;
const RUN_NOTE = { id: 'n1', text: findingsNoteText('semgrep', 1, 'stdin'), actor: AGENT };
const ingested = (id: string, text: string, status = 'OPEN') =>
  ({ id, type: 'HYPOTHESIS', text, status, derivedFrom: ['n1'], createdBy: AGENT, confirmed: false });
const recordedState = (claims: unknown[]) => ({ claims, notes: [RUN_NOTE] }) as never;

describe('finding ingest planning', () => {
  it('skips duplicates, honors the severity floor and the limit', () => {
    const existing = recordedState([ingested('c1', findingClaimText(finding()))]);
    const plan = planIngest(
      existing,
      [finding(), finding({ path: 'src/low.ts', severity: 'low' }), finding({ path: 'src/new.ts', severity: 'critical' })],
      { minSeverity: 'medium' },
    );
    assert.equal(plan.duplicates.length, 1);
    assert.equal(plan.belowSeverity, 1);
    assert.deepEqual(plan.fresh.map((f) => f.path), ['src/new.ts']);

    const limited = planIngest(recordedState([]), [finding(), finding({ path: 'src/second.ts' })], { limit: 1 });
    assert.equal(limited.fresh.length, 1);
    assert.equal(limited.overLimit, 1);
  });

  it('drops a finding repeated inside one batch', () => {
    const plan = planIngest(recordedState([]), [finding(), finding()]);
    assert.equal(plan.fresh.length, 1);
    assert.equal(plan.duplicates.length, 1);
  });

  it('builds AI hypothesis claims carrying severity, risk and the run note', () => {
    const inputs = findingClaimInputs([finding({ severity: 'critical' })], 'n1', { kind: 'ai', agent: 'copilot' });
    assert.equal(inputs.length, 1);
    const input = inputs[0];
    assert.equal(input?.type, 'CLAIM_ADDED');
    assert.equal(input?.actor.kind, 'ai');
    const payload = input?.type === 'CLAIM_ADDED' ? input.payload : undefined;
    assert.equal(payload?.type, 'HYPOTHESIS');
    assert.equal(payload?.risk, 'FATAL');
    assert.deepEqual(payload?.derivedFrom, ['n1']);
    assert.match(payload?.text ?? '', /^cws-finding:[0-9a-f]{16} \[critical\]/);
  });

  it('lists recorded and open findings', () => {
    const claims = recordedState([
      ingested('c1', findingClaimText(finding())),
      ingested('c2', findingClaimText(finding({ path: 'src/b.ts' })), 'FALSIFIED'),
      ingested('c3', 'not a finding'),
    ]);
    assert.equal(recordedFindings(claims).length, 2);
    assert.deepEqual(openFindings(claims).map((c) => c.id), ['c1']);
  });

  it('writes a note that explains where the findings came from', () => {
    assert.match(findingsNoteText('semgrep', 2, 'results.sarif'), /results\.sarif \(semgrep\): 2 new findings/);
    assert.match(findingsNoteText('semgrep', 1, 'stdin'), /1 new finding/);
  });
});

describe('findings command', () => {
  it('detects the input format', () => {
    assert.equal(detectFormat([], 'auto'), 'cws');
    assert.equal(detectFormat({ version: '2.1.0', runs: [] }, 'auto'), 'sarif');
    assert.equal(detectFormat({ comments: [] }, 'auto'), 'ocr-review');
    assert.equal(detectFormat({ anything: true }, 'sarif'), 'sarif');
    assert.throws(() => detectFormat({ anything: true }, 'auto'), /cannot tell what this JSON is/);
  });

  it('validates cws-format findings', () => {
    assert.equal(findingsFrom([finding()], 'cws').length, 1);
    assert.throws(() => findingsFrom([{ tool: 't', severity: 'low', message: 'no path' }], 'cws'), /finding #1: path is required/);
  });

  it('records findings from stdin and then reports them as duplicates', async () => {
    const payload = JSON.stringify([
      finding({ severity: 'critical', path: 'src/a.ts' }),
      finding({ path: 'src/b.ts', severity: 'low' }),
    ]);
    const first = io(base, payload);
    assert.equal(await runCli(['findings', 'ingest', '-', '--format', 'cws', '--agent', 'copilot'], first), EXIT.OK);
    assert.match(text(first), /2 finding\(s\) read: 1 new, 0 already recorded, 1 below medium/);

    const state = (await EventLog.open(base)).state;
    assert.equal(state.claims.length, 1);
    assert.equal(state.claims[0]?.createdBy.kind, 'ai');
    assert.equal(state.claims[0]?.risk, 'FATAL');
    assert.equal(state.notes.length, 1);

    const second = io(base, payload);
    assert.equal(await runCli(['findings', 'ingest', '-', '--format', 'cws', '--agent', 'copilot'], second), EXIT.OK);
    assert.match(text(second), /0 new, 1 already recorded/);
    assert.equal((await EventLog.open(base)).state.claims.length, 1);
  });

  it('records SARIF findings and lists them', async () => {
    const sarif = {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'semgrep', rules: [{ id: 'go/sql', defaultConfiguration: { level: 'error' } }] } },
          results: [
            {
              ruleId: 'go/sql',
              level: 'error',
              message: { text: 'SQL built by concatenation' },
              locations: [{ physicalLocation: { artifactLocation: { uri: 'internal/db.go' }, region: { startLine: 7 } } }],
            },
          ],
        },
      ],
    };
    const ingest = io(base, JSON.stringify(sarif));
    assert.equal(await runCli(['findings', 'ingest', '-', '--agent', 'claude'], ingest), EXIT.OK);
    assert.match(text(ingest), /1 new/);

    const list = io(base);
    assert.equal(await runCli(['findings', 'list'], list), EXIT.OK);
    assert.match(text(list), /1 finding\(s\): 1 high/);
    assert.match(text(list), /internal\/db\.go/);
  });

  it('fails clearly on unusable input', async () => {
    const empty = io(base, '   ');
    assert.equal(await runCli(['findings', 'ingest', '-', '--agent', 'copilot'], empty), EXIT.ERROR);
    assert.match(text(empty), /no findings given/);

    const broken = io(base, '{ not json');
    assert.equal(await runCli(['findings', 'ingest', '-', '--agent', 'copilot'], broken), EXIT.ERROR);
    assert.match(text(broken), /input is not JSON/);

    const unknown = io(base, '{"anything":true}');
    assert.equal(await runCli(['findings', 'ingest', '-', '--agent', 'copilot'], unknown), EXIT.ERROR);
    assert.match(text(unknown), /cannot tell what this JSON is/);

    const badFormat = io(base, '[]');
    assert.equal(await runCli(['findings', 'ingest', '-', '--agent', 'copilot', '--format', 'nope'], badFormat), EXIT.ERROR);
    assert.match(text(badFormat), /--format must be one of/);

    const noFindings = io(base, '{"version":"2.1.0","runs":[]}');
    assert.equal(await runCli(['findings', 'ingest', '-', '--agent', 'copilot', '--format', 'sarif'], noFindings), EXIT.OK);
    assert.match(text(noFindings), /No findings in that input/);
  });

  it('says so when nothing has been recorded yet', async () => {
    const list = io(base);
    assert.equal(await runCli(['findings', 'list'], list), EXIT.OK);
    assert.match(text(list), /No findings recorded yet/);
  });

  it('explains how to point cws at ocr when it is not installed', async () => {
    process.env['CWS_TOOL_OCR'] = path.join(base, 'no-such-ocr');
    try {
      const fake = io(base, '', true);
      assert.equal(await runCli(['review-code'], fake), EXIT.ERROR);
      assert.match(text(fake), /does not exist/);
      assert.match(text(fake), /CWS_TOOL_OCR/);
    } finally {
      delete process.env['CWS_TOOL_OCR'];
    }
  });
});
