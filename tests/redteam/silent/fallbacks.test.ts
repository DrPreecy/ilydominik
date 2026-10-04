import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCli } from '../../../src/cli/app.ts';
import { checkAiUsage, incrementAiUsage, todayIsoDate, usageFilePath } from '../../../src/integrations/gemini.ts';
import { updateSyncConfig, loadIntegrations } from '../../../src/integrations/config.ts';
import { EventLog } from '../../../src/store/event-log.ts';
import { all, cws, human, tmpProject } from './harness.ts';

const cfg = (root: string): string => path.join(root, '.cws', 'integrations.json');

describe('silent: corrupt file -> default value', () => {
  it('sync link on a hand-edited (invalid JSON) integrations.json does not overwrite the user settings', async () => {
    const root = await tmpProject();
    const original = '{ "version": 1, "sandbox": { "mode": "off" }, "gemini": { "dailyCallLimit": 3 }, }\n'; // trailing comma
    await fs.writeFile(cfg(root), original);
    await updateSyncConfig(root, { projectId: 'remote-1' }).catch(() => undefined);
    const after = await fs.readFile(cfg(root), 'utf8');
    assert.ok(after.includes('"dailyCallLimit": 3') && after.includes('"off"'), `settings destroyed; file is now: ${after}`);
  });

  it('a schema-invalid integrations.json (sandbox off + typo) must not make `ai` silently use the default limits', async () => {
    const root = await tmpProject();
    await fs.writeFile(cfg(root), JSON.stringify({ version: 1, sandbox: { mode: 'off' }, gemini: { dailyCallLimit: 3, maxInputChars: '500' } }));
    const r = cws(root, ['ai', 'explore', '--dry-run']);
    assert.ok(r.code !== 0 || /integrations|settings|invalid|ignored|defaults/i.test(r.out + r.err), `exit ${r.code}; no mention anywhere that the settings were rejected. out: ${r.out.split('\n').find((l) => l.includes('cap')) ?? ''}`);
    const loaded = await loadIntegrations(root);
    assert.ok(loaded.problem !== undefined); // the problem is known to the loader ...
  });
});

describe('silent: Gemini quota bookkeeping fails open', () => {
  it('a negative count in ai-usage.json cannot grant unlimited calls', async () => {
    const root = await tmpProject();
    await fs.writeFile(usageFilePath(root), JSON.stringify({ date: todayIsoDate(), count: -1000000 }));
    const res = await checkAiUsage(root, 1);
    assert.ok(res.todayCount >= 0, `todayCount=${res.todayCount}`);
  });

  it('a corrupt ai-usage.json fails closed (or loudly), not as a fresh quota', async () => {
    const root = await tmpProject();
    await fs.writeFile(usageFilePath(root), JSON.stringify({ date: todayIsoDate(), count: 20 }));
    await fs.writeFile(usageFilePath(root), '{"date": "' + todayIsoDate() + '", "count": 20'); // truncated write
    const res = await checkAiUsage(root, 20).catch(() => ({ ok: false }));
    assert.equal(res.ok, false, 'a damaged counter at the limit was read as 0 calls today');
  });

  it('a failed usage write is reported, not swallowed', async () => {
    const root = await tmpProject();
    await fs.mkdir(usageFilePath(root)); // write will fail with EISDIR
    await assert.rejects(incrementAiUsage(root), 'incrementAiUsage returned normally although the count was never stored');
  });

  it('a billed Gemini response that fails parsing still counts against the daily limit', async () => {
    const root = await tmpProject();
    await fs.writeFile(cfg(root), JSON.stringify({ version: 1, gemini: { dailyCallLimit: 1 } }));
    process.env.GEMINI_API_KEY = 'test-key';
    let calls = 0;
    const geminiCaller = { generate: async () => { calls += 1; return 'this is not json'; } };
    try {
      await runCli(['ai', 'explore'], human(root, ['yes']), { geminiCaller });
      const second = human(root, ['yes']);
      await runCli(['ai', 'explore'], second, { geminiCaller });
      assert.equal(calls, 1, `limit is 1/day but the model was called ${calls} times; ${all(second).split(String.fromCharCode(10))[0]}`);
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});

describe('silent: writes continue on a log that fails verification', () => {
  it('dump onto a tampered log warns or refuses (the chain is already broken)', async () => {
    const root = await tmpProject();
    cws(root, ['dump', '--agent', 'bot', 'first']);
    cws(root, ['dump', '--agent', 'bot', 'second']);
    const file = path.join(root, '.cws', 'events.jsonl');
    const lines = (await fs.readFile(file, 'utf8')).split('\n');
    lines[1] = lines[1]!.replace('first', 'FORGED');
    await fs.writeFile(file, lines.join('\n'));
    assert.equal((await EventLog.open(root)).integrity.ok, false);
    const r = cws(root, ['dump', '--agent', 'bot', 'third']);
    assert.ok(r.code !== 0 || /integrity|tamper|verify|corrupt/i.test(r.out + r.err), `exit ${r.code}, stdout "${r.out.trim()}", stderr "${r.err.trim()}" - appended silently`);
  });
});
