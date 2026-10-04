/**
 * Measurement, not a gate: runs assessCommandSafety over labelled corpora and prints
 * precision/recall per class. "Positive" = the guard blocks (ok === false).
 *   recall    = blocked destructive / all destructive
 *   precision = destructive among everything blocked (benign set supplies the false positives)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessCommandSafety } from '../../../src/safety/command-guard.ts';
import { BENIGN, DESTRUCTIVE, type Mode, type Sample } from './corpus-data.ts';

const GTFO = 'C:\\Users\\takey\\.local\\tribunal\\corpora\\gtfobins\\_gtfobins';
const LOLBAS = 'C:\\Users\\takey\\.local\\tribunal\\corpora\\lolbas\\yml';

let tmp = '';
let root = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-guard-corpus-'));
  root = path.join(tmp, 'project');
  for (const d of ['.git', '.cws', 'src', 'dist', 'build', 'node_modules']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const verdict = (argv: string[], mode: Mode): boolean =>
  assessCommandSafety(argv, { cwd: root, projectRoot: root, runsWithoutShell: mode === 'noshell' }).ok;

function shellSplit(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]!;
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (ch === '\\' && i + 1 < line.length) { cur += line[++i]!; has = true; }
    else if (/\s/.test(ch)) { if (has || cur !== '') out.push(cur); cur = ''; has = false; }
    else cur += ch;
  }
  if (has || cur !== '') out.push(cur);
  return out;
}

function gtfoSamples(): Sample[] {
  const wanted = new Set(['command', 'shell', 'file-write', 'file-delete']);
  const samples: Sample[] = [];
  for (const name of fs.readdirSync(GTFO)) {
    const lines = fs.readFileSync(path.join(GTFO, name), 'utf8').split(/\r?\n/);
    let fn = '';
    for (let i = 0; i < lines.length; i += 1) {
      const head = /^ {2}([a-z-]+):\s*$/.exec(lines[i]!);
      if (head) { fn = head[1]!; continue; }
      if (!wanted.has(fn) || !/^\s+(?:- )?code: \|-?\s*$/.test(lines[i]!)) continue;
      const block: string[] = [];
      for (let j = i + 1; j < lines.length && (lines[j]!.trim() === '' || /^ {6,}/.test(lines[j]!)); j += 1) block.push(lines[j]!.trim());
      const line = block.map((l) => l.replace(/^sudo\s+(?:-\S+\s+)*/, '')).find((l) => {
        const first = shellSplit(l)[0] ?? '';
        return path.posix.basename(first).replace(/^\.\//, '') === name;
      });
      if (line === undefined) continue;
      const argv = shellSplit(line);
      if (argv.some((t) => /^(?:\||&&|;|\|\||<|>)$/.test(t))) continue; // pipelines are blocked by operators anyway; not informative
      samples.push({ cls: `gtfobins:${fn}`, argv });
    }
  }
  return samples;
}

function lolbasSamples(): Sample[] {
  const wanted = new Set(['Execute', 'Delete', 'Download']);
  const samples: Sample[] = [];
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(LOLBAS).filter((f) => f.endsWith('.yml'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/- Command: (.+)\n(?:.*\n)*?\s+Category: (\w+)/g)) {
      const cat = m[2]!;
      if (!wanted.has(cat)) continue;
      const cmd = m[1]!.trim().replace(/\{[A-Z_:.a-z]+\}/g, 'x');
      const argv = shellSplit(cmd);
      if (argv.length === 0) continue;
      if (argv.some((t) => /^(?:\||&&|;|\|\||<|>)$/.test(t))) continue;
      samples.push({ cls: `lolbas:${cat}`, argv });
    }
  }
  return samples;
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

function report(title: string, samples: Sample[], mode: Mode): { blocked: number; total: number } {
  const byClass = new Map<string, { blocked: number; total: number; missed: string[] }>();
  for (const sample of samples) {
    if (sample.mode !== undefined && sample.mode !== mode) continue;
    const row = byClass.get(sample.cls) ?? { blocked: 0, total: 0, missed: [] };
    row.total += 1;
    if (!verdict(sample.argv, mode)) row.blocked += 1;
    else row.missed.push(sample.argv.join(' ').slice(0, 70));
    byClass.set(sample.cls, row);
  }
  let blocked = 0;
  let total = 0;
  const lines = [`\n== ${title} [${mode}] recall per class ==`];
  for (const [cls, row] of [...byClass].sort()) {
    blocked += row.blocked;
    total += row.total;
    lines.push(`${cls.padEnd(22)} recall ${pct(row.blocked, row.total).padStart(6)}  (${row.blocked}/${row.total})`);
  }
  lines.push(`${'ALL'.padEnd(22)} recall ${pct(blocked, total).padStart(6)}  (${blocked}/${total})`);
  console.log(lines.join('\n'));
  return { blocked, total };
}

describe('guard corpus measurement', () => {
  it('own destructive corpus: recall per class, both modes', () => {
    for (const mode of ['noshell', 'shell'] as const) {
      const claimed = DESTRUCTIVE.filter((s) => s.cls !== 'disclaimed');
      report('own corpus (README-claimed classes)', claimed, mode);
      report('own corpus (README-disclaimed: npm scripts, make, ...)', DESTRUCTIVE.filter((s) => s.cls === 'disclaimed'), mode);
    }
  });

  it('benign corpus: false positives and precision', () => {
    for (const mode of ['noshell', 'shell'] as const) {
      const falsePositives = BENIGN.filter((s) => !verdict(s.argv, mode));
      const claimed = DESTRUCTIVE.filter((s) => s.cls !== 'disclaimed' && (s.mode === undefined || s.mode === mode));
      const tp = claimed.filter((s) => !verdict(s.argv, mode)).length;
      const fp = falsePositives.length;
      console.log(`\n== benign [${mode}] ==\nbenign=${BENIGN.length} falsePositives=${fp} FPR=${pct(fp, BENIGN.length)}`);
      console.log(`precision=${pct(tp, tp + fp)} (tp=${tp}, fp=${fp}) recall=${pct(tp, claimed.length)}`);
      for (const s of falsePositives) console.log(`  FP: ${s.argv.join(' ')} -> ${assessCommandSafety(s.argv, { cwd: root, projectRoot: root, runsWithoutShell: mode === 'noshell' }).reason?.slice(0, 80)}`);
    }
    assert.ok(BENIGN.length >= 100);
  });

  it('GTFOBins (command/shell/file-write/file-delete) recall', () => {
    const samples = gtfoSamples();
    console.log(`\nGTFOBins samples extracted: ${samples.length}`);
    const r = report('GTFOBins', samples, 'noshell');
    assert.ok(r.total > 100);
  });

  it('LOLBAS (Execute/Delete/Download) recall', () => {
    const samples = lolbasSamples();
    console.log(`\nLOLBAS samples extracted: ${samples.length}`);
    const r = report('LOLBAS', samples, 'noshell');
    assert.ok(r.total > 50);
  });
});
