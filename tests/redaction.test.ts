/**
 * Redaction (I9): vendor token families, key names in every casing, private-key blocks cut short,
 * linear running time, and no damage to ordinary prose. Fake secrets are assembled at runtime.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { maskSecrets, redactSecrets, shorten } from '../src/findings/types.ts';
import { shorten as warningsShorten } from '../src/guidance/warnings.ts';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rnd = (length: number, seed = 3): string => {
  let state = seed * 7919 + length;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out += ALNUM[state % ALNUM.length];
  }
  return out;
};
const join = (...parts: string[]): string => parts.join('');

describe('vendor-keyed credentials (gitleaks keyword rules)', () => {
  const value = rnd(32);
  const cases: Array<[string, string]> = [
    ['ALGOLIA_API_KEY', value],
    ['datadog_token', value],
    ['heroku', join('0f1e2d3c', '-4b5a-6978-8a9b-0c1d2e3f4a5b')],
    ['twitterBearer', value],
    ['NETLIFY_AUTH_TOKEN', value],
    ['stripeSigning', value],
  ];
  for (const [key, secret] of cases) {
    it(`masks ${key}`, () => {
      assert.equal(maskSecrets(`${key}=${secret}`).includes(secret), false);
      assert.equal(maskSecrets(`"${key}": "${secret}"`).includes(secret), false);
    });
  }
});

describe('truncated and armoured private keys', () => {
  it('masks a block with BEGIN and no END to the end of the key lines', () => {
    const body = rnd(64);
    const out = maskSecrets(join('-----BEGIN RSA PRIVATE', ' KEY-----\n', body, '\n', rnd(64, 9), '\nnext paragraph'));
    assert.equal(out.includes(body), false);
    assert.match(out, /next paragraph/);
  });

  it('masks every block of several truncated ones', () => {
    const a = rnd(40, 1);
    const b = rnd(40, 2);
    const begin = join('-----BEGIN PRIVATE', ' KEY-----');
    const out = maskSecrets(`${begin}\n${a}\n\nand then\n${begin}\n${b}`);
    assert.equal(out.includes(a) || out.includes(b), false);
  });

  it('keeps public keys', () => {
    assert.match(maskSecrets('-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQ\n-----END PUBLIC KEY-----'), /MFkwEwYH/);
  });
});

describe('credential key names', () => {
  const secret = rnd(24);
  for (const key of ['clientSecret', 'authToken', 'AccountKey', 'dbPassword', 'accessToken', 'API_KEY', 'x-api-key', 'private_key', 'csrfToken']) {
    it(`masks ${key} in env, yaml and JSON form`, () => {
      for (const text of [`${key}=${secret}`, `${key}: ${secret}`, `{"${key}":"${secret}"}`, `${key} = '${secret}'`]) {
        assert.equal(maskSecrets(text).includes(secret), false, text);
      }
    });
  }

  it('masks a quoted value that contains spaces, whole', () => {
    assert.equal(maskSecrets('password = "correct horse battery staple"'), 'password = [redacted]');
  });

  it('does not eat the word after a kebab-case rule id (R-10)', () => {
    assert.equal(maskSecrets('semgrep hardcoded-password: Hardcoded credentials in config'), 'semgrep hardcoded-password: Hardcoded credentials in config');
  });
});

describe('ordinary text is left alone', () => {
  const prose = [
    'token: string',
    'maxTokens: 4096',
    'the password is required',
    'password: <your password>',
    'secret: process.env.SECRET',
    'apiKey: options.apiKey,',
    'key: value pairs are fine',
    'task-based-planning-for-small-teams',
    'bypass=true and passthrough=1',
    'See `password=` in the spec.',
  ];
  for (const line of prose) {
    it(`keeps: ${line}`, () => {
      assert.equal(maskSecrets(line), line);
    });
  }

  it('changes at most 0.5% of the lines of the repo prose', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const docs = path.join(root, 'docs');
    const files = ['README.md', ...fs.readdirSync(docs, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md')).map((f) => path.join('docs', f))];
    const lines = files.flatMap((f) => fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/));
    const changed = lines.filter((line) => maskSecrets(line) !== line);
    assert.ok(lines.length > 500, `only ${lines.length} lines read`);
    assert.ok(changed.length / lines.length <= 0.005, `false positives: ${changed.slice(0, 5).join(' | ')}`);
  });
});

describe('linear time', () => {
  const MB = 1_000_000;
  const shapes: Array<[string, string]> = [
    ['hyphenated words', 'ab-'.repeat(MB / 3)],
    ['hyphenated with a key word', 'password-token-secret-'.repeat(MB / 22)],
    ['jwt prefix chain', 'eyJ-'.repeat(MB / 4)],
    ['sk- chain', 'sk-'.repeat(MB / 3)],
    ['private key headers without END', '-----BEGIN PRIVATE KEY-----'.repeat(MB / 27)],
    ['credential keys without values', 'token='.repeat(MB / 6)],
    ['unclosed quotes', 'password="x '.repeat(MB / 12)],
    ['url openers', '://a:'.repeat(MB / 5)],
    ['authorization headers', 'authorization: '.repeat(MB / 15)],
    ['plain prose', 'the quick brown fox jumps over the lazy dog. '.repeat(MB / 45)],
  ];
  for (const [name, text] of shapes) {
    it(`masks 1 MB of ${name} in under 500 ms`, () => {
      const start = performance.now();
      maskSecrets(text);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 500, `${elapsed.toFixed(0)} ms`);
    });
  }

  it('time grows linearly: 8x the input costs well under 30x the time', () => {
    const small = 'a-'.repeat(20_000);
    const big = 'a-'.repeat(160_000);
    maskSecrets(small);
    const t1 = performance.now();
    maskSecrets(small);
    const base = Math.max(performance.now() - t1, 0.5);
    const t2 = performance.now();
    maskSecrets(big);
    assert.ok(performance.now() - t2 < base * 30);
  });
});

describe('one shared shorten', () => {
  const token = join('gh', 'p_', rnd(36));

  it('is the same function in guidance/warnings and findings/types', () => {
    assert.equal(warningsShorten, shorten);
  });

  it('redacts before truncating, so a cut cannot expose half a token', () => {
    const out = shorten(`${'x'.repeat(60)} ${token}`, 80);
    assert.equal(out.includes(token.slice(0, 12)), false);
  });

  it('redactSecrets output is stable when applied twice', () => {
    const once = redactSecrets(`Authorization: Bearer ${rnd(30)} password=${rnd(10)}`);
    assert.equal(redactSecrets(once), once);
  });
});
