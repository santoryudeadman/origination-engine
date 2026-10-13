#!/usr/bin/env node
// Verification suite. Runs the real pipeline and the real evaluator, then asserts the
// numbers they are supposed to produce. Exits non-zero on any mismatch.
//
//   node scripts/verify.mjs
//
// These are golden assertions, not unit tests: they defend the two contracts that matter —
// the recorded receipt reproduces, and the promotion gate reaches the same verdict. If a
// refactor changes what the pipeline decides, this fails.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, actual, expected }); console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); }
}

const run = (script, args) => execFileSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' });
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'oe-verify-'));

try {
  // ── project 1: the pipeline reproduces its recorded receipts ───────────────
  console.log('\npipeline — replay');
  run('pipeline/run.mjs', ['--replay', '--icp', 'mid-market']);
  run('pipeline/run.mjs', ['--replay', '--icp', 'small-teams']);

  const mid = readJson('site/data/run-mid-market.json');
  check('mid-market scanned', mid.receipt.scanned, 50);
  check('mid-market passed', mid.receipt.passed, 27);
  check('mid-market dropped before paying', mid.receipt.dropped_before_paying, 23);
  check('mid-market deliverable', mid.receipt.deliverable, 20);
  check('mid-market spend', mid.receipt.spend_usd, 2.33);
  check('mid-market cost per deliverable', mid.receipt.cost_per_deliverable_usd, 0.1165);
  check('mid-market tiers', mid.receipt.tiers, { A: 6, B: 13, C: 8 });
  check('mid-market enrichment', mid.receipt.enrichment, 'recorded');

  const small = readJson('site/data/run-small-teams.json');
  check('small-teams scanned', small.receipt.scanned, 30);
  check('small-teams passed', small.receipt.passed, 30);
  check('small-teams tiers', small.receipt.tiers, { A: 14, B: 15, C: 1 });
  check('small-teams headcounts all under 50', small.leads.every((l) => l.headcount == null || l.headcount < 50), true);
  check('small-teams signals are dated', small.leads.filter((l) => l.signal_label).length, 24);

  // Determinism: the same inputs must produce the same DECISIONS. The run timestamp is
  // metadata, not a decision, so it is excluded rather than frozen.
  const decisions = (o) => {
    const c = structuredClone(o);
    delete c.meta.generated_at;
    return JSON.stringify(c);
  };
  const before = readJson('site/data/run-mid-market.json');
  run('pipeline/run.mjs', ['--replay', '--icp', 'mid-market']);
  check('replay is deterministic', decisions(before) === decisions(readJson('site/data/run-mid-market.json')), true);

  // ── project 2: the promotion gate reaches the same verdicts ────────────────
  console.log('\nshadow — promotion gate');
  const evalArgs = (candidate, extra = []) => [
    '--universe', 'site/data/run-mid-market.json',
    '--baseline', 'pipeline/rules/mid-market.json',
    '--candidate', `shadow/configs/${candidate}.json`, ...extra,
  ];
  const verdictOf = (candidate) => readJson(`shadow/out/mid-market__${candidate}.json`).verdict;

  run('shadow/evaluate.mjs', evalArgs('mid-market-tighten'));
  const tighten = readJson('shadow/out/mid-market__mid-market-tighten.json');
  check('tighten → HOLD', tighten.verdict, 'HOLD');
  check('tighten loses deliverables', tighten.counts.lost_deliverable, 3);
  check('tighten drops rows', tighten.counts.left, 5);

  run('shadow/evaluate.mjs', evalArgs('mid-market-loosen'));
  check('loosen without labels → shadow only', verdictOf('mid-market-loosen'), 'PROMOTE TO SHADOW');

  // A synthetic fixture, generated here and deleted. Never committed — the repo must not
  // ship fabricated outcome data.
  const labels = join(tmp, 'labels.csv');
  writeFileSync(labels, 'company,outcome\nOrum,won\nAligned,won\nGamma,lost\nChurnZero,lost\nAha!,lost\n');
  run('shadow/evaluate.mjs', evalArgs('mid-market-loosen', ['--labels', labels]));
  check('loosen with labels → HOLD', verdictOf('mid-market-loosen'), 'HOLD');
  rmSync(labels, { force: true });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
