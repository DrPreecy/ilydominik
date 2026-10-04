/**
 * Regression gate for the guard (the sibling corpus.test.ts only measures).
 *  - recall on the classes the README / spec claim the guard covers must be 100%
 *  - precision on everyday developer commands must stay >= 99%
 *  - the GTFOBins / LOLBAS numbers stay a printed metric (corpus.test.ts); they are not asserted here,
 *    because the guard is a denylist and does not claim to cover those corpora.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessCommandSafety } from '../../../src/safety/command-guard.ts';
import { BENIGN, DESTRUCTIVE, type Mode, type Sample } from './corpus-data.ts';

const MODES: readonly Mode[] = ['noshell', 'shell'];
/** Open product decision: `npm install <pkg>` runs lifecycle scripts, but it is also the everyday flow (and `pnpm add`/`npm ci` are benign). */
const OPEN_DECISIONS = new Set(['npm install x']);
const METACHARS = /[;|&<>`^\n\r]|\$\(/;
let tmp = '';
let root = '';

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cws-guard-gate-')));
  root = path.join(tmp, 'project');
  for (const d of ['.git', '.cws', 'src', 'dist', 'build', 'node_modules']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const allowed = (sample: Sample, mode: Mode): boolean =>
  assessCommandSafety(sample.argv, { cwd: root, projectRoot: root, runsWithoutShell: mode === 'noshell' }).ok;

const forMode = (mode: Mode): Sample[] =>
  DESTRUCTIVE.filter((s) => s.cls !== 'disclaimed' && (s.mode === undefined || s.mode === mode));

describe('guard corpus gate', () => {
  for (const mode of MODES) {
    it(`recall is 100% on the README-claimed classes [${mode}]`, () => {
      const missed = forMode(mode).filter((s) => allowed(s, mode)).map((s) => `${s.cls}: ${s.argv.join(' ')}`);
      assert.deepEqual(missed, []);
    });

    it(`the disclaimed classes (npm scripts, make, ...) are blocked too [${mode}]`, () => {
      const rows = DESTRUCTIVE.filter((s) => s.cls === 'disclaimed');
      const missed = rows.filter((s) => allowed(s, mode)).map((s) => s.argv.join(' ')).filter((line) => !OPEN_DECISIONS.has(line));
      console.log(`disclaimed [${mode}]: ${rows.length - missed.length}/${rows.length} blocked`);
      assert.deepEqual(missed, []);
    });
  }

  it('precision on benign commands is at least 99% when cws runs the argv itself (shell: false)', () => {
    const falsePositives = BENIGN.filter((s) => !allowed(s, 'noshell')).map((s) => s.argv.join(' '));
    const tp = forMode('noshell').filter((s) => !allowed(s, 'noshell')).length;
    const precision = tp / (tp + falsePositives.length);
    console.log(`benign noshell: ${BENIGN.length} commands, ${falsePositives.length} false positives, precision ${(precision * 100).toFixed(1)}%`);
    assert.ok(falsePositives.length / BENIGN.length <= 0.01, `false positives: ${falsePositives.join(' | ')}`);
    assert.ok(precision >= 0.99);
  });

  it('in --check mode the only benign refusals are arguments a shell would interpret', () => {
    const falsePositives = BENIGN.filter((s) => !allowed(s, 'shell'));
    const unexplained = falsePositives.filter((s) => !s.argv.some((a) => METACHARS.test(a))).map((s) => s.argv.join(' '));
    console.log(`benign shell: ${falsePositives.length}/${BENIGN.length} refused (shell metacharacters inside an argument)`);
    assert.deepEqual(unexplained, []);
  });
});
