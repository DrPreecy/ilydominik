/**
 * Secret redaction: replaces credentials with `[redacted]` and keeps everything else.
 *
 * Coverage comes from four layers, applied in this order:
 *   1. private-key blocks (also truncated ones, a BEGIN marker with no END),
 *   2. vendor token formats (`TOKEN_FORMATS`, a data table),
 *   3. `key = value` pairs where the key names a credential (camelCase, snake, kebab, flags),
 *   4. URL passwords, `curl -u`, `Authorization:` and `Bearer` headers.
 *
 * Every step is linear in the input: token formats start with a left boundary so a scan can
 * only begin at the start of a run, key names are found by tokenising once instead of
 * back-tracking over hyphenated text, and PEM END markers are searched with `indexOf` once.
 *
 * The vendor token shapes below are adapted from the gitleaks default rule set
 * (https://github.com/gitleaks/gitleaks, MIT License, Copyright (c) 2019 Zachary Rice).
 * Bodies are deliberately looser than the originals: over-masking a look-alike costs
 * little, a leaked key costs a lot.
 */

export const REDACTED = '[redacted]';

/**
 * [source id, regex source]. Ids follow the gitleaks rule ids (or a short description when a
 * rule is CWS-specific) so a missing family is easy to spot against the upstream list.
 */
const TOKEN_FORMATS: ReadonlyArray<readonly [string, string]> = [
  ['1password-secret-key', String.raw`A3-[A-Z0-9]{6}-[A-Z0-9-]{20,}`],
  ['1password-service-account-token', String.raw`ops_eyJ[A-Za-z0-9+/=]{100,}`],
  ['adobe-client-secret', String.raw`p8e-[A-Za-z0-9]{32}`],
  ['age-secret-key', String.raw`AGE-SECRET-KEY-1[A-Z0-9]{40,}`],
  ['airtable-personal-access-token', String.raw`pat[A-Za-z0-9]{14}\.[a-f0-9]{64}`],
  ['alibaba-access-key-id', String.raw`LTAI[A-Za-z0-9]{20}`],
  ['anthropic-api-key', String.raw`sk-ant-[A-Za-z0-9_-]{20,}`],
  ['artifactory-api-key', String.raw`AKCp[A-Za-z0-9]{40,}`],
  ['artifactory-reference-token', String.raw`cmVmd[A-Za-z0-9]{40,}`],
  ['atlassian-api-token', String.raw`ATATT3[A-Za-z0-9_=-]{100,}`],
  ['authress-service-client-access-key', String.raw`(?:sc|ext|scauth|authress)_[A-Za-z0-9]{5,30}\.[A-Za-z0-9]{4,6}\.acc[_-][A-Za-z0-9-]{10,32}\.[A-Za-z0-9+/_=-]{30,120}`],
  ['aws-access-token', String.raw`(?:A3T[A-Z0-9]|A[KSBCGINR]IA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}(?![A-Za-z0-9])`],
  ['aws-bedrock-long-lived', String.raw`ABSK[A-Za-z0-9+/]{60,}={0,2}`],
  ['aws-bedrock-short-lived', String.raw`bedrock-api-key-[A-Za-z0-9+/=_-]{20,}`],
  ['aws-s3-presigned-signature', String.raw`X-Amz-(?:Signature|Security-Token)=[A-Za-z0-9%+/=_-]{16,}`],
  ['azure-ad-client-secret', String.raw`[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34}`],
  ['clickhouse-cloud-api-secret-key', String.raw`4b1d[A-Za-z0-9]{38}`],
  ['clojars-api-token', String.raw`CLOJARS_[A-Za-z0-9]{40,}`],
  ['cloudflare-origin-ca-key', String.raw`v1\.0-[a-f0-9]{24}-[a-f0-9]{100,}`],
  ['databricks-api-token', String.raw`dapi[a-f0-9]{32}(?:-\d)?`],
  ['defined-networking-api-token', String.raw`dnkey-[A-Za-z0-9=_-]{26}-[A-Za-z0-9=_-]{52}`],
  ['digitalocean-token', String.raw`do[opr]_v1_[A-Za-z0-9]{32,}`],
  ['discord-webhook', String.raw`discord(?:app)?\.com/api/webhooks/\d{10,}/[A-Za-z0-9_-]{30,}`],
  ['doppler-api-token', String.raw`dp\.(?:pt|st|sa|ct|scim|audit)\.[A-Za-z0-9]{40,}`],
  ['duffel-api-token', String.raw`duffel_(?:test|live)_[A-Za-z0-9_=-]{40,}`],
  ['dynatrace-api-token', String.raw`dt0c01\.[A-Za-z0-9]{24}\.[A-Za-z0-9]{64}`],
  ['easypost-api-token', String.raw`EZ[AT]K[A-Za-z0-9]{54}`],
  ['facebook-access-token', String.raw`\d{15,16}\|[A-Za-z0-9_-]{27,40}`],
  ['facebook-page-access-token', String.raw`EAA[MC][A-Za-z0-9]{80,}`],
  ['flutterwave-key', String.raw`FLW(?:SECK|PUBK)(?:_TEST)?-[A-Za-z0-9]{12,}(?:-X)?`],
  ['flyio-access-token', String.raw`(?:fo1_[\w-]{40,}|fm[12][ar]?_[A-Za-z0-9+/=]{80,})`],
  ['frameio-api-token', String.raw`fio-u-[A-Za-z0-9_=-]{60,}`],
  ['gcp-api-key', String.raw`AIza[\w-]{30,}`],
  ['gcp-oauth-client-secret', String.raw`GOCSPX-[A-Za-z0-9_-]{20,}`],
  ['github-token', String.raw`(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}`],
  ['gitlab-token', String.raw`gl(?:pat|dt|rt|cbt|ffct|ft|imt|agent|oas|ptt|soat)-[A-Za-z0-9_.-]{20,}`],
  ['gitlab-rrt', String.raw`GR1348941[\w-]{20}`],
  ['gitlab-session-cookie', String.raw`_gitlab_session=[0-9a-z]{32}`],
  ['google-oauth-refresh-token', String.raw`1//0[A-Za-z0-9_-]{40,}`],
  ['google-oauth-access-token', String.raw`ya29\.[A-Za-z0-9_-]{50,}`],
  ['grafana-api-key', String.raw`eyJrIjoi[A-Za-z0-9]{50,}={0,3}`],
  ['grafana-cloud-api-token', String.raw`glc_[A-Za-z0-9+/=]{32,}`],
  ['grafana-service-account-token', String.raw`glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}`],
  ['groq-api-key', String.raw`gsk_[A-Za-z0-9]{40,}`],
  ['harness-api-key', String.raw`(?:pat|sat)\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9]{24}\.[A-Za-z0-9]{20}`],
  ['hashicorp-tf-api-token', String.raw`[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_=-]{60,}`],
  ['heroku-api-key-v2', String.raw`HRKU-AA[\w-]{50,}`],
  ['huggingface-token', String.raw`(?:hf|api_org)_[A-Za-z0-9]{30,}`],
  ['infracost-api-token', String.raw`ico-[A-Za-z0-9]{32}`],
  ['intra42-client-secret', String.raw`s-s4t2(?:ud|af)-[a-f0-9]{64}`],
  ['jwt', String.raw`eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}`],
  ['jwt-base64', String.raw`ZXlK[A-Za-z0-9+/_=-]{40,}`],
  ['linear-api-key', String.raw`lin_api_[A-Za-z0-9]{30,}`],
  ['mailgun-key', String.raw`(?:pub)?key-[0-9a-f]{32}(?![A-Za-z0-9])`],
  ['maxmind-license-key', String.raw`[A-Za-z0-9]{6}_[A-Za-z0-9]{29}_mmk`],
  ['microsoft-teams-webhook', String.raw`https://[a-z0-9]+\.webhook\.office\.com/webhookb2/[\w@/-]+`],
  ['notion-api-token', String.raw`ntn_[A-Za-z0-9]{40,}`],
  ['npm-access-token', String.raw`npm_[A-Za-z0-9]{36}`],
  ['octopus-deploy-api-key', String.raw`API-[A-Z0-9]{26}(?![A-Za-z0-9])`],
  ['openai-api-key', String.raw`sk-[A-Za-z0-9_-]{16,}`],
  ['openshift-user-token', String.raw`sha256~[\w-]{43}`],
  ['perplexity-api-key', String.raw`pplx-[A-Za-z0-9]{40,}`],
  ['planetscale-token', String.raw`pscale_(?:tkn|oauth|pw)_[\w=.-]{32,}`],
  ['postman-api-token', String.raw`PMAK-[A-Za-z0-9]{20,}-[A-Za-z0-9]{20,}`],
  ['prefect-api-token', String.raw`pnu_[A-Za-z0-9]{36}`],
  ['pulumi-api-token', String.raw`pul-[a-f0-9]{40}`],
  ['pypi-upload-token', String.raw`pypi-Ag[A-Za-z0-9_-]{50,}`],
  ['readme-api-token', String.raw`rdme_[a-z0-9]{60,}`],
  ['rubygems-api-token', String.raw`rubygems_[A-Za-z0-9]{32,}`],
  ['scalingo-api-token', String.raw`tk-us-[\w-]{48}`],
  ['sendgrid-api-token', String.raw`SG\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{16,})?`],
  ['sendinblue-api-token', String.raw`xkeysib-[a-f0-9]{64}-[A-Za-z0-9]{16}`],
  ['sentry-token', String.raw`sntrys_[A-Za-z0-9+/=_-]{40,}|sntryu_[a-f0-9]{64}`],
  ['settlemint-token', String.raw`sm_(?:aat|pat|sat)_[A-Za-z0-9]{16}`],
  ['shippo-api-token', String.raw`shippo_(?:live|test)_[a-fA-F0-9]{40}`],
  ['shopify-token', String.raw`shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}`],
  ['sidekiq-sensitive-url', String.raw`https?://[a-f0-9]{8}:[a-f0-9]{8}@(?:gems|enterprise)\.contribsys\.com`],
  ['slack-app-token', String.raw`xapp-[\w-]{10,}`],
  ['slack-token', String.raw`xox[abposr]-[A-Za-z0-9-]{10,}`],
  ['slack-config-token', String.raw`xoxe(?:\.xox[bp])?-\d-[A-Za-z0-9]{50,}`],
  ['slack-webhook-url', String.raw`hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9+/]{20,}`],
  ['sourcegraph-access-token', String.raw`sgp_(?:(?:[a-fA-F0-9]{16}|local)_)?[a-fA-F0-9]{40}`],
  ['square-access-token', String.raw`(?:EAAA|sq0atp-|sq0csp-)[\w-]{22,60}`],
  ['stripe-key', String.raw`(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,99}`],
  ['stripe-webhook-secret', String.raw`whsec_[A-Za-z0-9]{24,}`],
  ['telegram-bot-token', String.raw`\d{8,10}:AA[A-Za-z0-9_-]{30,}`],
  ['twilio-key', String.raw`(?:AC|SK)[0-9a-fA-F]{32}(?![A-Za-z0-9])`],
  ['typeform-api-token', String.raw`tfp_[A-Za-z0-9_.=-]{50,}`],
  ['vault-token', String.raw`hv[sbr]\.[\w-]{40,}`],
  ['xai-api-key', String.raw`xai-[A-Za-z0-9]{60,}`],
  ['yandex-api-key', String.raw`AQVN[\w-]{35,}`],
  ['dockerhub-pat', String.raw`dckr_pat_[\w-]{20,}`],
];

const TOKEN_AT = new RegExp(`(?:${TOKEN_FORMATS.map(([, source]) => `(?:${source})`).join('|')})`, 'y');
const RUN = /[\w-]+/g;

/**
 * Tries the token formats only where a run of token characters begins. That is the left boundary
 * of every format, and it keeps the scan linear however the text is hyphenated.
 */
function maskTokens(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  RUN.lastIndex = 0;
  for (let run = RUN.exec(text); run !== null; run = RUN.exec(text)) {
    TOKEN_AT.lastIndex = run.index;
    const token = TOKEN_AT.exec(text);
    if (token === null) continue;
    const end = run.index + token[0].length;
    parts.push(text.slice(cursor, run.index), REDACTED);
    cursor = end;
    RUN.lastIndex = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/gi;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/gi;
/**
 * What the body of a block looks like when the END marker is missing: the rest of the marker's
 * line, then base64 lines (8+ characters, so a short word starting the next paragraph is kept)
 * and armour headers such as "Version: GnuPG".
 */
const PEM_BODY = /[A-Za-z0-9+/=\\:._-]*(?:[ \t]*\r?\n[ \t]*(?:[A-Za-z0-9+/=\\:._-]{8,}|[A-Za-z][\w-]*: [^\n]*)?)*/y;

/** Replaces private-key blocks, including those that were cut before their END marker. */
function maskPrivateKeys(text: string): string {
  if (!text.includes('-----')) return text;
  const parts: string[] = [];
  let cursor = 0;
  let noEndAfter = Infinity;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin !== null; begin = PEM_BEGIN.exec(text)) {
    const bodyStart = begin.index + begin[0].length;
    let end = -1;
    if (bodyStart < noEndAfter) {
      PEM_END.lastIndex = bodyStart;
      const found = PEM_END.exec(text);
      if (found === null) noEndAfter = bodyStart;
      else end = found.index + found[0].length;
    }
    if (end === -1) {
      PEM_BODY.lastIndex = bodyStart;
      PEM_BODY.exec(text);
      end = PEM_BODY.lastIndex;
    }
    parts.push(text.slice(cursor, begin.index), REDACTED);
    cursor = end;
    PEM_BEGIN.lastIndex = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

// ---------------------------------------------------------------------------------------------
// key = value
// ---------------------------------------------------------------------------------------------

const IDENT = /[A-Za-z0-9_.-]+/g;
const SEPARATOR = /(?:\\?["'])?[ \t]{0,20}(?::=|=>|[:=])[ \t]{0,20}/y;
const FLAG_SEPARATOR = /[ \t]+(?=[^\s-])/y;
const PROSE_SEPARATOR = /[ \t]+(?:is|was|are)[ \t]+/y;
const QUOTED = /\\?(["'])((?:(?!\1)[^\n]){0,2000})\1/y;
const BARE = /[^\s"',;`]+/y;
const BARE_QUERY = /[^\s"',;&`]+/y;
const LINE_REST = /[^\n"#]+/y;
const MAX_KEY_LENGTH = 120;

/** Words that make a key name a credential on their own. */
const PASSWORD_WORDS = /^(?:password|passwd|pwd|pass|passphrase|passcode)$/;
const STRONG_WORDS =
  /^(?:secret|token|credential|credentials|creds|bearer|apikey|accesskey|secretkey|privatekey|accountkey|signingkey|encryptionkey|masterkey|authkey|licensekey|clientkey|appkey|sharedkey)$/;
/** Last word of a joined name: `csrftoken`, `accesstoken`, `dbpassword`. */
const STRONG_SUFFIX = /(?:token|secret|password|passwd|apikey|privatekey|secretkey|accesskey)$/;
const KEY_PREFIXES = new Set(['api', 'access', 'private', 'secret', 'auth', 'account', 'signing', 'master', 'license', 'client', 'app', 'shared', 'encryption', 'ssh', 'deploy']);
/** Names that only matter with a long, random-looking value: `?key=`, `sig=`, `sessionid=`. */
const WEAK_WORDS = new Set(['key', 'sig', 'signature', 'session', 'sessionid', 'sid', 'auth', 'cookie']);
/** Services whose keys are recognised by the name next to them (gitleaks "keyword" rules). */
const VENDORS = new Set(
  `adafruit adobe airtable algolia alibaba asana atlassian confluence jira bitbucket bittrex meraki cloudflare codecov cohere
   coinbase confluent contentful datadog discord droneci dropbox etsy facebook fastly finicity finnhub flickr freshbooks gitter
   gocardless heroku hubspot intercom jfrog artifactory bintray xray kraken kucoin launchdarkly linear linkedin lob looker
   mailchimp mailgun mapbox mattermost messagebird netlify newrelic nytimes okta plaid rapidapi sendbird sentry snyk sonar
   squarespace sumo sumologic telegram telegr travis twitch twitter typeform yandex zendesk stripe twilio sendgrid slack github
   gitlab openai anthropic gemini firebase supabase vercel npm pypi docker aws azure gcp google digitalocean shopify paypal
   braintree mongodb redis postgres mysql sqlserver`.split(/\s+/),
);

type KeyClass = 'password' | 'strong' | 'weak' | 'vendor' | null;

function classify(segments: readonly string[]): KeyClass {
  if (segments.some((word) => PASSWORD_WORDS.test(word))) return 'password';
  for (let i = 0; i < segments.length; i += 1) {
    const word = segments[i] ?? '';
    if (STRONG_WORDS.test(word) || STRONG_SUFFIX.test(word)) return 'strong';
    if (word === 'key' && i > 0 && KEY_PREFIXES.has(segments[i - 1] ?? '')) return 'strong';
  }
  if (segments.some((word) => WEAK_WORDS.has(word))) return 'weak';
  if (segments.some((word) => VENDORS.has(word))) return 'vendor';
  return null;
}

/** Cheap test that rules out almost every identifier before the word split. */
const KEY_HINT = new RegExp(
  `pass|pwd|secret|token|cred|bearer|key|sig|sess|sid|auth|cookie|${[...VENDORS].join('|')}`,
  'i',
);
const CLASS_CACHE = new Map<string, KeyClass>();
const CLASS_CACHE_LIMIT = 4096;

function computeKeyClass(ident: string): KeyClass {
  const tail = ident.length > MAX_KEY_LENGTH ? ident.slice(-MAX_KEY_LENGTH) : ident;
  if (!KEY_HINT.test(tail)) return null;
  const segments = tail
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  return classify(segments);
}

function keyClass(ident: string): KeyClass {
  const cached = CLASS_CACHE.get(ident);
  if (cached !== undefined) return cached;
  const kind = computeKeyClass(ident);
  if (CLASS_CACHE.size >= CLASS_CACHE_LIMIT) CLASS_CACHE.clear();
  CLASS_CACHE.set(ident, kind);
  return kind;
}

const PLACEHOLDER =
  /^(?:string|number|boolean|object|array|any|null|nil|none|undefined|true|false|yes|no|required|optional|empty|redacted|\[redacted\]|\*+|x{3,}|\.{3}|<[^>]*>|\{[^}]*\}|\$.*|%.*|your[_-].*|process\.env.*|env\.\w+|os\.environ.*|secrets\..*|example|placeholder)$/i;
const DOTTED_PATH = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;
const CALL = /^[A-Za-z_][\w.]*\(/;
const REDACTED_MARK = /\[redacted\]/;

function looksRandom(value: string): boolean {
  return /\d/.test(value) || value.length >= 16;
}

/** Decides whether `value` after a key of this class is worth hiding. */
function shouldMask(kind: Exclude<KeyClass, null>, value: string, quoted: boolean): boolean {
  if (value === '' || REDACTED_MARK.test(value)) return false;
  if (!quoted && (PLACEHOLDER.test(value) || DOTTED_PATH.test(value) || CALL.test(value))) return false;
  if (quoted && PLACEHOLDER.test(value)) return false;
  if (kind === 'password') return true;
  if (kind === 'strong') return quoted ? value.length >= 4 : value.length >= 8 && looksRandom(value);
  // weak and vendor names: a long token-looking value with letters and digits
  return value.length >= 16 && /^[A-Za-z0-9+/=_.%~-]+$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
}

interface ValueSpan {
  start: number;
  end: number;
  quoted: boolean;
}

function sticky(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

function valueAt(text: string, at: number, kind: Exclude<KeyClass, null>, query: boolean, colon: boolean, kebab: boolean): ValueSpan | null {
  const quoted = sticky(QUOTED, text, at);
  if (quoted !== null) return { start: at, end: at + quoted[0].length, quoted: true };
  if (kind === 'password' && colon && !kebab) {
    const line = sticky(LINE_REST, text, at);
    if (line !== null) {
      const trimmed = line[0].replace(/[ \t,;]+$/, '');
      return trimmed === '' ? null : { start: at, end: at + trimmed.length, quoted: false };
    }
  }
  const bare = sticky(query ? BARE_QUERY : BARE, text, at);
  return bare === null ? null : { start: at, end: at + bare[0].length, quoted: false };
}

function innerValue(text: string, span: ValueSpan): string {
  if (!span.quoted) return text.slice(span.start, span.end);
  const raw = text.slice(span.start, span.end);
  return raw.replace(/^\\?["']/, '').replace(/["']$/, '');
}

function maskKeyValues(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  IDENT.lastIndex = 0;
  for (let match = IDENT.exec(text); match !== null; match = IDENT.exec(text)) {
    const ident = match[0];
    const identEnd = match.index + ident.length;
    const kind = keyClass(ident);
    if (kind === null) continue;
    let valueStart = -1;
    let colon = false;
    let proseForm = false;
    const separator = sticky(SEPARATOR, text, identEnd);
    if (separator !== null) {
      valueStart = identEnd + separator[0].length;
      colon = separator[0].includes(':') && !separator[0].includes(':=');
    } else if (ident.startsWith('--')) {
      const flag = sticky(FLAG_SEPARATOR, text, identEnd);
      if (flag !== null) valueStart = identEnd + flag[0].length;
    } else {
      const prose = sticky(PROSE_SEPARATOR, text, identEnd);
      if (prose !== null) {
        valueStart = identEnd + prose[0].length;
        proseForm = true;
      }
    }
    if (valueStart < 0) continue;
    if (proseForm && kind !== 'password') continue;

    const query = /[?&]/.test(text[match.index - 1] ?? '');
    const kebab = ident.includes('-') && !ident.includes('_') && !ident.startsWith('--');
    const span = valueAt(text, valueStart, kind, query, colon, kebab);
    if (span === null) continue;
    const value = innerValue(text, span);
    if (span.quoted && value === REDACTED) {
      // a token pattern already hid the value; drop the quotes too so the output is stable
      parts.push(text.slice(cursor, span.start), REDACTED);
      cursor = span.end;
      IDENT.lastIndex = span.end;
      continue;
    }
    if (kebab && colon && !span.quoted && /^[A-Za-z][a-z]*$/.test(value)) continue; // "hardcoded-password: Hardcoded ..."
    if (proseForm && !/[\d\W_]/.test(value)) continue; // "the password is required"
    if (!shouldMask(kind, value, span.quoted)) continue;

    parts.push(text.slice(cursor, span.start), REDACTED);
    cursor = span.end;
    IDENT.lastIndex = span.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

// ---------------------------------------------------------------------------------------------
// URLs, headers, command lines
// ---------------------------------------------------------------------------------------------

/** `scheme://user:password@host` keeps the user and host; the password may be empty-user or contain `@`. */
const URL_PASSWORD = /(:\/\/[^\s/:@]*:)[^\s/]*@(?=[^\s@/]*(?:[/?#\s]|$))/g;
/** `Authorization: <scheme> <value>` loses everything after the colon. */
const AUTH_HEADER = /\b(authorization["']?[ \t]*[:=][ \t]*)["']?(?:(?:bearer|basic|token|digest)[ \t]+)?[^\s"',;]+["']?/gi;
const BEARER = /\b(bearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** `curl -u user:password` and `--user user:password`. */
const CURL_USER = /((?:^|[ \t])(?:-u|--user)(?:[ \t]+|=)[^\s:]*:)[^\s]+/g;

export function maskSecrets(text: string): string {
  const flat = maskTokens(maskPrivateKeys(text))
    .replace(AUTH_HEADER, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(BEARER, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(URL_PASSWORD, (_match, prefix: string) => `${prefix}${REDACTED}@`)
    .replace(CURL_USER, (_match, prefix: string) => `${prefix}${REDACTED}`);
  return maskKeyValues(flat);
}

const ANSI_SGR = /\u001b\[[0-9;]*m/g;
const DEFAULT_LIMIT = 400;
const DEFAULT_SHORT = 80;

/** Masks, flattens whitespace and truncates. Truncation comes after masking so a cut cannot expose half a secret. */
export function redactSecrets(text: string, limit = DEFAULT_LIMIT): string {
  const result = maskSecrets(text.replace(ANSI_SGR, '')).replace(/\s+/g, ' ').trim();
  return result.length > limit ? `${result.slice(0, limit - 1)}…` : result;
}

/** The one helper every one-line rendering of stored text goes through. */
export function shorten(text: string, limit = DEFAULT_SHORT): string {
  return redactSecrets(text, limit);
}
