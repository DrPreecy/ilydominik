import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCommandSafety } from '../../../src/safety/command-guard.ts';
const root = process.cwd();
const BS = '\u005c';
for (const runsWithoutShell of [false, true]) {
  test(`comma-array target outside project must not be allowed (runsWithoutShell=${runsWithoutShell})`, () => {
    const r = assessCommandSafety(['remove-item', '-Path', `file1,C:${BS}Windows`], { cwd: root, projectRoot: root, runsWithoutShell });
    assert.equal(r.ok, false, JSON.stringify(r));
  });
  test(`comma-array escaping project with relative paths (runsWithoutShell=${runsWithoutShell})`, () => {
    const r = assessCommandSafety(['remove-item', '-Path', `a.txt,..${BS}..${BS}x`], { cwd: root, projectRoot: root, runsWithoutShell });
    assert.equal(r.ok, false, JSON.stringify(r));
  });
  test(`comma-array with .git (runsWithoutShell=${runsWithoutShell})`, () => {
    const r = assessCommandSafety(['remove-item', '-Path', 'a.txt,.git'], { cwd: root, projectRoot: root, runsWithoutShell });
    assert.equal(r.ok, false, JSON.stringify(r));
  });
}
