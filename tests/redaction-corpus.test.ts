import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { maskSecrets } from '../src/findings/redact.ts';

const root = path.resolve(import.meta.dirname, '..');
const config = fs.readFileSync(path.join(root, 'tests/fixtures/gitleaks-v8.25.0.toml'), 'utf8');
const blocks = config.split(/^\[\[rules\]\]\s*$/m).slice(1);
const contexts = [
  (secret: string) => secret,
  (secret: string) => `api_token=${secret}`,
  (secret: string) => `{"token":"${secret}"}`,
  (secret: string) => `token: ${secret}`,
  (secret: string) => `token: '${secret}'`,
  (secret: string) => `https://example.invalid/?token=${secret}`,
  (secret: string) => 'Authorization: Bearer ' + secret,
  (secret: string) => `The system returned ${secret}.`,
  (secret: string) => `log output:\n${secret}\noperation complete`,
];

function generationRegex(source: string): RegExp {
  const compatible = source
    .replace(/\(\?i\)/g, '')
    .replace(/\(\?i:/g, '(?:')
    .replace(/\(\?-i:/g, '(?:')
    .replace(/\\[bB]/g, '')
    .replace(/\\z/g, '$')
    .replace(/\\Z/g, '$')
    .replace(/\(\?P<([A-Za-z0-9_]+)>/g, '(?<$1>');
  return new RegExp(compatible);
}

function ruleSecrets(): string[] {
  return blocks.flatMap((block, index) => {
    const id = block.match(/^id\s*=\s*"([^"]+)"/m)?.[1];
    const source = block.match(/^regex\s*=\s*'''([\s\S]*?)'''/m)?.[1];
    if (!source) return [];
    assert.ok(id, `missing id in gitleaks rule ${index + 1}`);
    const matcher = generationRegex(source);
    const generated = fc.sample(fc.stringMatching(matcher), { numRuns: 1, seed: index + 1 })[0];
    assert.ok(generated, `no sample generated for ${id}`);
    const match = matcher.exec(generated);
    assert.ok(match, `generated value does not match ${id}`);
    return [match.slice(1).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? match[0]!];
  });
}

describe('gitleaks v8.25.0 sample-context redaction recall', () => {
  it('redacts at least 95% of generated secrets across nine text contexts', () => {
    const secrets = ruleSecrets();
    assert.equal(secrets.length, 209);
    let redacted = 0;

    for (const secret of secrets) {
      for (const context of contexts) {
        if (!maskSecrets(context(secret)).includes(secret)) redacted += 1;
      }
    }

    const total = secrets.length * contexts.length;
    const recall = redacted / total;
    console.log(`gitleaks v8.25.0: ${redacted}/${total} samples redacted (${(recall * 100).toFixed(1)}%)`);
    assert.ok(recall >= 0.95, `sample-context recall was ${(recall * 100).toFixed(1)}%`);
  });
});
