/**
 * Red-team witnesses for I9 (redaction): no real-world secret format survives
 * `maskSecrets` / `redactSecrets`. Every `it` asserts the CORRECT behaviour, so RED = defect.
 *
 * Fake secrets are assembled at runtime (`s(...)`) so secret scanners do not trip on this file.
 * The shapes follow the gitleaks default rule set (222 rules).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { maskSecrets, redactSecrets } from '../../../src/findings/types.ts';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DIGITS = '0123456789';
const URLSAFE = `${ALNUM}_-`;
const B64 = `${ALNUM}+/`;

/** Deterministic pseudo-random string from an alphabet. */
function r(alphabet: string, length: number, seed = 1): string {
  let state = seed * 7919 + length;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[state % alphabet.length];
  }
  return out;
}
const s = (...parts: string[]): string => parts.join('');

interface Case {
  name: string;
  /** the part that must not survive */
  secret: string;
  /** how it appears in text */
  wrap: (secret: string) => string;
}

const bare = (secret: string): string => `please use ${secret} for the build`;
const kv = (key: string) => (secret: string): string => `${key}=${secret}`;

const CASES: Case[] = [
  // ---- vendor tokens with a distinctive prefix (gitleaks "prefixed" rules) ----
  { name: 'aws temporary access key id (ASIA)', secret: s('AS', 'IA', r(UPPER, 16)), wrap: bare },
  { name: 'aws group id (AGPA)', secret: s('AG', 'PA', r(UPPER, 16)), wrap: bare },
  { name: 'aws bedrock long-lived key', secret: s('ABSK', r(ALNUM, 140)), wrap: bare },
  { name: 'stripe live secret key', secret: s('sk_', 'live_', r(ALNUM, 24)), wrap: bare },
  { name: 'stripe restricted key', secret: s('rk_', 'live_', r(ALNUM, 24)), wrap: bare },
  { name: 'stripe webhook secret', secret: s('whsec_', r(ALNUM, 32)), wrap: bare },
  { name: 'gcp oauth client secret', secret: s('GOCSPX-', r(URLSAFE, 28)), wrap: bare },
  { name: 'sendgrid api key', secret: s('S', 'G.', r(URLSAFE, 22), '.', r(URLSAFE, 43)), wrap: bare },
  { name: 'digitalocean pat', secret: s('dop_v1_', r(HEX, 64)), wrap: bare },
  { name: 'huggingface token', secret: s('hf_', r('abcdefghijklmnopqrstuvwxyz', 34)), wrap: bare },
  { name: 'notion token', secret: s('ntn_', r(ALNUM, 46)), wrap: bare },
  { name: 'slack incoming webhook', secret: s('hooks.slack.com/services/T', r(UPPER, 8), '/B', r(UPPER, 8), '/', r(ALNUM, 24)), wrap: (v) => `https://${v}` },
  { name: 'discord webhook', secret: s('discord.com/api/webhooks/', r(DIGITS, 18), '/', r(URLSAFE, 68)), wrap: (v) => `https://${v}` },
  { name: 'twilio account sid', secret: s('AC', r(HEX, 32)), wrap: bare },
  { name: 'twilio api key', secret: s('SK', r(HEX, 32)), wrap: bare },
  { name: 'mailgun key', secret: s('key-', r(HEX, 32)), wrap: bare },
  { name: 'shopify access token', secret: s('shp', 'at_', r(HEX, 32)), wrap: bare },
  { name: 'gitlab deploy token', secret: s('gldt-', r(URLSAFE, 20)), wrap: bare },
  { name: 'gitlab runner token', secret: s('glrt-', r(URLSAFE, 20)), wrap: bare },
  { name: 'pypi upload token', secret: s('pypi-AgEIcHlwaS5vcmc', r(URLSAFE, 70)), wrap: bare },
  { name: 'rubygems token', secret: s('rubygems_', r(HEX, 48)), wrap: bare },
  { name: 'dockerhub pat', secret: s('dckr_pat_', r(URLSAFE, 27)), wrap: bare },
  { name: 'sentry token', secret: s('sntrys_eyJ', r(ALNUM, 60)), wrap: bare },
  { name: 'vault service token', secret: s('hv', 's.', r(URLSAFE, 95)), wrap: bare },
  { name: 'linear api key', secret: s('lin_api_', r(ALNUM, 40)), wrap: bare },
  { name: 'postman api key', secret: s('PMAK-', r(HEX, 24), '-', r(HEX, 34)), wrap: bare },
  { name: 'grafana service account', secret: s('glsa_', r(ALNUM, 32), '_', r(HEX, 8)), wrap: bare },
  { name: 'databricks token', secret: s('dapi', r(HEX, 32)), wrap: bare },
  { name: 'telegram bot token', secret: s('123456789:AA', r(URLSAFE, 33)), wrap: bare },
  { name: 'age secret key', secret: s('AGE-SECRET-KEY-1', r('QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L', 58)), wrap: bare },
  { name: 'groq key', secret: s('gsk_', r(ALNUM, 52)), wrap: bare },
  { name: 'xai key', secret: s('xai-', r(ALNUM, 80)), wrap: bare },
  { name: 'google oauth refresh token', secret: s('1//0', r(URLSAFE, 60)), wrap: bare },
  { name: 'google oauth access token', secret: s('ya29.', r(URLSAFE, 100)), wrap: bare },
  { name: 'slack app-level token', secret: s('xa', 'pp-1-A', r(UPPER, 10), '-', r(DIGITS, 13), '-', r(HEX, 64)), wrap: bare },
  // ---- connection strings and URLs ----
  { name: 'postgres url with empty user', secret: r(ALNUM, 16), wrap: (v) => `postgres://:${v}@db.example.com/x` },
  { name: 'postgres url whose password contains @', secret: s(r(ALNUM, 8), '@', r(ALNUM, 6)), wrap: (v) => `postgres://admin:${v}@db.example.com/x` },
  { name: 'azure storage connection string', secret: r(B64, 86), wrap: (v) => `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${v}==;EndpointSuffix=core.windows.net` },
  { name: 'azure SAS signature in url', secret: r(ALNUM, 43), wrap: (v) => `https://a.blob.core.windows.net/c?sv=2020-08-04&sig=${v}%3D&se=2030` },
  { name: 'aws presigned url signature', secret: r(HEX, 64), wrap: (v) => `https://x.example.com/f?X-Amz-Signature=${v}` },
  { name: 'url ?key= param', secret: r(ALNUM, 32), wrap: (v) => `https://maps.example.com/api?key=${v}` },
  // ---- headers, flags ----
  { name: 'curl -u user:pass', secret: r(ALNUM, 12), wrap: (v) => `curl -u admin:${v} https://x.example.com` },
  { name: 'cli --token <value>', secret: r(ALNUM, 40), wrap: (v) => `cli --token ${v}` },
  { name: 'cli --api-key <value>', secret: r(ALNUM, 40), wrap: (v) => `cli --api-key ${v}` },
  { name: 'Cookie sessionid', secret: r(ALNUM, 32), wrap: (v) => `Cookie: sessionid=${v}; csrftoken=abcd` },
  { name: 'Set-Cookie session', secret: r(ALNUM, 40), wrap: (v) => `Set-Cookie: session=${v}; HttpOnly` },
  // ---- camelCase and compound key names ----
  { name: 'clientSecret (camelCase)', secret: r(ALNUM, 32), wrap: (v) => `clientSecret: "${v}"` },
  { name: 'authToken (camelCase)', secret: r(ALNUM, 32), wrap: kv('authToken') },
  { name: 'AccountKey', secret: r(B64, 60), wrap: kv('AccountKey') },
  { name: 'privateKey = value', secret: r(ALNUM, 40), wrap: (v) => `privateKey = ${v}` },
  { name: 'secretKey (camelCase)', secret: r(ALNUM, 30), wrap: kv('secretKey') },
  { name: 'dbPassword (camelCase)', secret: r(ALNUM, 14), wrap: kv('dbPassword') },
  { name: 'DB_PASS env var', secret: r(ALNUM, 16), wrap: kv('DB_PASS') },
  { name: 'bearerToken in JSON', secret: r(ALNUM, 40), wrap: (v) => JSON.stringify({ bearerToken: v }) },
  { name: 'accessToken in JSON', secret: r(ALNUM, 40), wrap: (v) => JSON.stringify({ accessToken: v }) },
  { name: 'credentials: value', secret: r(ALNUM, 30), wrap: (v) => `credentials: ${v}` },
  // ---- passwords: quoting, spaces, short, prose ----
  { name: 'password in prose', secret: 'hunter2hunter2', wrap: (v) => `the password is ${v} ok` },
  { name: 'quoted password with spaces', secret: 'correct horse battery staple', wrap: (v) => `password = "${v}"` },
  { name: 'yaml password with spaces', secret: 'my secret pass', wrap: (v) => `db_password: ${v}` },
  { name: 'short password (3 chars)', secret: 'abc', wrap: (v) => `password=${v}` },
  { name: 'mysql --password=value', secret: 'Tr0ub4dor', wrap: (v) => `mysql --password=${v} -h x` },
  // ---- truncated / non-standard PEM ----
  { name: 'PEM truncated before END marker', secret: r(ALNUM, 64), wrap: (v) => `-----BEGIN RSA PRIVATE${''} KEY-----\n${v}\n${r(ALNUM, 64, 2)}` },
  { name: 'PEM truncated with ellipsis', secret: r(ALNUM, 64), wrap: (v) => `-----BEGIN PRIVATE${''} KEY-----\n${v}\n${r(ALNUM, 64, 2)}\n...[truncated]` },
  { name: 'PGP private key block', secret: r(ALNUM, 64), wrap: (v) => `-----BEGIN PGP PRIVATE${''} KEY BLOCK-----\n${v}\n-----END PGP PRIVATE KEY BLOCK-----` },
  { name: 'service-account json private_key with no END', secret: r(ALNUM, 60), wrap: (v) => `{"private_key":"-----BEGIN PRIVATE${''} KEY-----\\n${v}"}` },
  // ---- controls: formats the masker already handles (keep the recall figure honest) ----
  { name: '[control] github pat', secret: s('ghp_', r(ALNUM, 36)), wrap: bare },
  { name: '[control] github fine-grained pat', secret: s('github_pat_', r(`${ALNUM}_`, 82)), wrap: bare },
  { name: '[control] aws AKIA', secret: s('AK', 'IA', r(UPPER, 16)), wrap: bare },
  { name: '[control] anthropic key', secret: s('sk-', 'ant-', 'api03-', r(URLSAFE, 93), 'AA'), wrap: bare },
  { name: '[control] openai key', secret: s('sk-', 'proj-', r(URLSAFE, 60)), wrap: bare },
  { name: '[control] jwt', secret: s('eyJ', r(URLSAFE, 20), '.eyJ', r(URLSAFE, 40), '.', r(URLSAFE, 43)), wrap: bare },
  { name: '[control] gitlab pat', secret: s('glpat-', r(URLSAFE, 20)), wrap: bare },
  { name: '[control] npm token', secret: s('npm_', r(ALNUM, 36)), wrap: bare },
  { name: '[control] gcp api key', secret: s('AIza', r(URLSAFE, 35)), wrap: bare },
  { name: '[control] slack bot token', secret: s('xo', 'xb-', r(DIGITS, 12), '-', r(DIGITS, 13), '-', r(ALNUM, 24)), wrap: bare },
  { name: '[control] full PEM block', secret: r(ALNUM, 64), wrap: (v) => `-----BEGIN OPENSSH PRIVATE KEY-----\n${v}\n-----END OPENSSH PRIVATE KEY-----` },
  { name: '[control] password=value', secret: r(ALNUM, 16), wrap: kv('password') },
  { name: '[control] api_key=value', secret: r(ALNUM, 32), wrap: kv('api_key') },
  { name: '[control] Authorization Bearer', secret: r(ALNUM, 40), wrap: (v) => `Authorization: Bearer ${v}` },
  { name: '[control] url user:password@', secret: r(ALNUM, 16), wrap: (v) => `mongodb+srv://u:${v}@c.mongodb.net/x` },
];

describe('I9 redaction recall: maskSecrets', () => {
  for (const c of CASES) {
    it(`masks ${c.name}`, () => {
      assert.equal(maskSecrets(c.wrap(c.secret)).includes(c.secret), false, maskSecrets(c.wrap(c.secret)).slice(0, 120));
    });
  }
});

describe('I9 redaction recall: redactSecrets', () => {
  for (const c of CASES) {
    it(`redacts ${c.name}`, () => {
      assert.equal(redactSecrets(c.wrap(c.secret), 100_000).includes(c.secret), false);
    });
  }
});

describe('I9 redaction recall: aggregate', () => {
  it('recall over the corpus is at least 99%', () => {
    const missed = CASES.filter((c) => maskSecrets(c.wrap(c.secret)).includes(c.secret));
    const recall = 1 - missed.length / CASES.length;
    assert.ok(recall >= 0.99, `recall ${(recall * 100).toFixed(1)}% (${missed.length}/${CASES.length} leaked): ${missed.map((m) => m.name).join(', ')}`);
  });
});

describe('I9 property: generated vendor tokens never survive', () => {
  const families: Array<[string, (body: string) => string, RegExp]> = [
    ['stripe sk_live', (b) => s('sk_', 'live_', b), /^[A-Za-z0-9]{24}$/],
    ['sendgrid', (b) => s('S', 'G.', b.slice(0, 22), '.', b.slice(22)), /^[A-Za-z0-9_-]{22}[A-Za-z0-9_-]{43}$/],
    ['twilio sid', (b) => s('AC', b), /^[0-9a-f]{32}$/],
    ['aws ASIA', (b) => s('AS', 'IA', b), /^[0-9A-Z]{16}$/],
    ['digitalocean', (b) => s('dop_v1_', b), /^[0-9a-f]{64}$/],
    ['gitlab deploy', (b) => s('gldt-', b), /^[A-Za-z0-9_-]{20}$/],
  ];
  for (const [name, build, shape] of families) {
    it(`never leaks ${name}`, () => {
      fc.assert(
        fc.property(fc.stringMatching(shape), fc.constantFrom(bare, kv('note'), (v: string) => JSON.stringify({ msg: v })), (body, wrap) => {
          const secret = build(body);
          return !maskSecrets(wrap(secret)).includes(secret);
        }),
        { numRuns: 300 },
      );
    });
  }
});
