import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskSecrets } from '../../../src/findings/types.ts';
// Built at runtime so secret scanners do not flag the fixture.
const FAKE = ['abcd', '1234', 'efgh'].join('');
const cases: Array<[string, string]> = [
  ['myApiToken: "secret value"', 'secret value'],
  [`myApiToken=${FAKE}`, FAKE],
  [`apiKey: "${FAKE}"`, FAKE],
  ['clientSecret = "hunter22hunter"', 'hunter22hunter'],
  ['password: "my pass phrase"', 'pass phrase'],
  [`accessToken: ${FAKE}`, FAKE],
];
for (const [input, secret] of cases) {
  test(`masks ${input}`, () => { assert.ok(!maskSecrets(input).includes(secret), maskSecrets(input)); });
}
