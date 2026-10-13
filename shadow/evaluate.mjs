#!/usr/bin/env node
// Shadow evaluation — decide whether a config change is safe to promote, BEFORE it ships.
//
//   node shadow/evaluate.mjs --universe site/data/run-mid-market.json \
//                            --baseline pipeline/rules/mid-market.json \
//                            --candidate shadow/configs/mid-market-tighten.json
//
// Replays both configs over the same recorded rows and answers three questions:
//   1. Which rows move, and which leave the working set?
//   2. Of the rows that leave, how many had produced a deliverable?
//   3. What does the change save or cost?
//
// The promotion gate is the point. Without outcome labels we cannot prove a change is
// BETTER — we can only prove it is SAFE (it drops nothing that was working) and what it
// costs. Anything else is a story. Pass --labels to measure lift for real.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';

import { gate, tier, deliverable } from '../pipeline/lib/score.mjs';
import { parseCsvObjects } from '../pipeline/lib/csv.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--universe') a.universe = argv[++i];
    else if (t === '--baseline') a.baseline = argv[++i];
    else if (t === '--candidate') a.candidate = argv[++i];
    else if (t === '--labels') a.labels = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--gate-agreement') a.gateAgreement = Number(argv[++i]);
  }
  return a;
}

/** Deep-merge a candidate overlay onto the baseline rules. Arrays replace wholesale. */
function merge(base, patch) {
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(base?.[k], v);
  return out;
}

const readJson = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ── the comparison ───────────────────────────────────────────────────────────

function judge(lead, rules, referenceDate) {
  const g = gate(lead, rules);
  return {
    pass: g.pass,
    reason: g.pass ? null : g.reason,
    failed: [...g.failed],
    tier: g.pass ? tier(lead, rules, referenceDate) : null,
  };
}

function evaluate({ universe, baseline, candidate, labels, gateAgreement }) {
  const run = readJson(universe);
  const leads = run.leads;
  const refDate = run.meta.reference_date;

  const baseRules = readJson(baseline);
  const candRules = merge(baseRules, readJson(candidate));

  // The baseline verdict is the RECORDED one — what actually ran. Never recomputed.
  const rows = leads.map((l) => {
    const b = { pass: l.gate === 'pass', tier: l.tier, reason: l.drop_reason };
    const c = judge(l, candRules, refDate);
    const out = labels?.get(l.company);
    return {
      company: l.company,
      domain: l.domain,
      fit: l.fit,
      signal_age_days: l.signal_age_days,
      deliverable: deliverable(l),
      outcome: out ?? null,
      base: b,
      cand: c,
      moved: b.pass !== c.pass || b.tier !== c.tier,
      left: b.pass && !c.pass,
      joined: !b.pass && c.pass,
    };
  });

  const baseActive = rows.filter((r) => r.base.pass);
  const candActive = rows.filter((r) => r.cand.pass);
  const left = rows.filter((r) => r.left);
  const joined = rows.filter((r) => r.joined);
  const tierMoves = rows.filter((r) => r.base.pass && r.cand.pass && r.base.tier !== r.cand.tier);

  // The gate. A row that was working may not be silently dropped.
  const lostDeliverable = left.filter((r) => r.deliverable);

  // Cost model: the recorded run spent $X to enrich `people_named` rows. Project that
  // unit cost across the candidate's working set. This is an estimate, and it says so.
  const namedRows = baseActive.filter((r) => r.deliverable || r.base.pass).length;
  const unitCost = run.receipt.enrichment === 'not_run' || !namedRows
    ? null
    : run.receipt.spend_usd / namedRows;
  const projected = unitCost == null ? null : {
    unit_cost_usd: Number(unitCost.toFixed(4)),
    baseline_usd: Number((unitCost * baseActive.length).toFixed(2)),
    candidate_usd: Number((unitCost * candActive.length).toFixed(2)),
    delta_usd: Number((unitCost * (candActive.length - baseActive.length)).toFixed(2)),
  };

  // Optional: with outcome labels, measure lift instead of guessing.
  let lift = null;
  if (labels && labels.size) {
    const rate = (rs) => (rs.length ? rs.filter((r) => r.outcome === 'won').length / rs.length : null);
    lift = {
      baseline_tier_a: rate(baseActive.filter((r) => r.base.tier === 'A')),
      candidate_tier_a: rate(candActive.filter((r) => r.cand.tier === 'A')),
      baseline_all: rate(baseActive),
      candidate_all: rate(candActive),
    };
  }

  // Verdict.
  let verdict, because;
  if (!left.length && !tierMoves.length) {
    verdict = 'NO-OP';
    because = 'nothing changes on this universe';
  } else if (lostDeliverable.length) {
    verdict = 'HOLD';
    because = `drops ${lostDeliverable.length} row(s) that produced a deliverable — you are trading a working lead for a cheaper list`;
  } else if (gateAgreement != null && (candActive.length - baseActive.length) > gateAgreement) {
    verdict = 'HOLD';
    because = `working set grows by ${candActive.length - baseActive.length}, above the --gate-agreement bound of ${gateAgreement}`;
  } else if (lift && lift.baseline_tier_a != null && lift.candidate_tier_a != null
             && lift.candidate_tier_a < lift.baseline_tier_a) {
    // Measured, not guessed: the change is worse on the tier you actually work.
    verdict = 'HOLD';
    because = `tier A win rate falls ${pct(lift.baseline_tier_a)} → ${pct(lift.candidate_tier_a)} on your labels — the added rows dilute the top tier`;
  } else if (joined.length && !lift) {
    // Adding rows is not free and not proven. Run both, compare on labels, then promote.
    verdict = 'PROMOTE TO SHADOW';
    because = `adds ${joined.length} row(s) that no evidence covers yet and costs $${Math.abs(projected?.delta_usd ?? 0)} more per run — pay for them only after the labels justify it`;
  } else if (left.length) {
    verdict = 'PROMOTE';
    because = `drops ${left.length} row(s), none of which produced a deliverable`;
  } else {
    verdict = 'PROMOTE';
    because = `no rows leave the working set; ${tierMoves.length} change tier`;
  }

  return {
    universe: basename(universe), baseline: basename(baseline), candidate: basename(candidate),
    reference_date: refDate,
    counts: {
      rows: rows.length,
      baseline_active: baseActive.length,
      candidate_active: candActive.length,
      left: left.length,
      joined: joined.length,
      tier_moves: tierMoves.length,
      lost_deliverable: lostDeliverable.length,
    },
    projected_cost: projected,
    lift,
    verdict, because,
    left_rows: left.map((r) => ({ company: r.company, was_tier: r.base.tier, deliverable: r.deliverable, why: r.cand.reason })),
    joined_rows: joined.map((r) => ({ company: r.company, tier: r.cand.tier, why: r.cand.reason })),
    tier_moves: tierMoves.map((r) => ({ company: r.company, from: r.base.tier, to: r.cand.tier, signal_age_days: r.signal_age_days })),
    rows,
  };
}

// ── report ───────────────────────────────────────────────────────────────────

function markdown(r) {
  const L = [];
  L.push(`# Shadow evaluation — ${r.candidate} vs ${r.baseline}`, '');
  L.push(`Universe: \`${r.universe}\` · reference date ${r.reference_date}`, '');
  L.push(`## Verdict: **${r.verdict}**`, '', r.because, '');
  L.push('| | baseline | candidate |', '|---|---|---|');
  L.push(`| rows in the working set | ${r.counts.baseline_active} | ${r.counts.candidate_active} |`);
  L.push(`| rows dropped | — | ${r.counts.left} |`);
  L.push(`| rows added | — | ${r.counts.joined} |`);
  L.push(`| tier changes | — | ${r.counts.tier_moves} |`);
  L.push(`| **deliverables lost** | — | **${r.counts.lost_deliverable}** |`);
  if (r.projected_cost) {
    L.push(`| projected spend | $${r.projected_cost.baseline_usd} | $${r.projected_cost.candidate_usd} |`);
  }
  L.push('');
  if (r.lift) {
    L.push('## Measured lift (from your labels)', '');
    L.push('| | baseline | candidate |', '|---|---|---|');
    L.push(`| **tier A win rate** | ${r.lift.baseline_tier_a == null ? '—' : pct(r.lift.baseline_tier_a)} | ${r.lift.candidate_tier_a == null ? '—' : pct(r.lift.candidate_tier_a)} |`);
    L.push(`| all-rows win rate | ${r.lift.baseline_all == null ? '—' : pct(r.lift.baseline_all)} | ${r.lift.candidate_all == null ? '—' : pct(r.lift.candidate_all)} |`);
    L.push('');
  }
  if (r.projected_cost) {
    L.push(`Projected spend is an estimate: $${r.projected_cost.unit_cost_usd}/row (the recorded run's spend ÷ its working set), applied to each config.`, '');
  } else {
    L.push('No cost projection: this universe had no enrichable rows (enrichment not run).', '');
  }
  if (r.left_rows.length) {
    L.push('## Rows that leave the working set', '');
    for (const x of r.left_rows) L.push(`- **${x.company}** (was tier ${x.was_tier}${x.deliverable ? ', **deliverable**' : ''}) — ${x.why}`);
    L.push('');
  }
  if (r.joined_rows.length) {
    L.push('## Rows that join', '');
    for (const x of r.joined_rows) L.push(`- **${x.company}** → tier ${x.tier}`);
    L.push('');
  }
  if (r.tier_moves.length) {
    L.push('## Tier changes', '');
    for (const x of r.tier_moves) L.push(`- ${x.company}: ${x.from} → ${x.to}${x.signal_age_days != null ? ` (signal ${x.signal_age_days}d old)` : ''}`);
    L.push('');
  }
  L.push('## What this can and cannot tell you', '');
  L.push('- It **can** tell you whether the change is safe: nothing that was producing a deliverable is lost.');
  L.push('- It **can** tell you what the change costs.');
  L.push(r.lift
    ? '- It measured lift from the labels you supplied.'
    : '- It **cannot** tell you the change is *better*. That needs outcome labels (`--labels`); fit is not outcome.');
  L.push('');
  return L.join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

function loadLabels(path) {
  if (!path) return null;
  const rows = parseCsvObjects(readFileSync(resolve(ROOT, path), 'utf8'));
  return new Map(rows.map((r) => [r.company, (r.outcome || '').trim().toLowerCase()]));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const k of ['universe', 'baseline', 'candidate']) {
    if (!args[k]) throw new Error(`--${k} is required`);
  }

  const result = evaluate({
    universe: args.universe,
    baseline: args.baseline,
    candidate: args.candidate,
    labels: loadLabels(args.labels),
    gateAgreement: args.gateAgreement,
  });

  const outDir = join(ROOT, 'shadow/out');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stem = `${basename(args.baseline, '.json')}__${basename(args.candidate, '.json')}`;
  const mdPath = join(outDir, `${stem}.md`);
  const jsonPath = join(outDir, `${stem}.json`);
  writeFileSync(mdPath, markdown(result));
  writeFileSync(jsonPath, JSON.stringify({ ...result, rows: undefined }, null, 2));

  if (args.json) { console.log(JSON.stringify({ ...result, rows: undefined }, null, 2)); return; }

  const c = result.counts;
  console.log(`universe   ${result.universe}  (${c.rows} rows, ref ${result.reference_date})`);
  console.log(`candidate  ${result.candidate}`);
  console.log('');
  console.log(`working set  ${c.baseline_active} → ${c.candidate_active}   (−${c.left} / +${c.joined})`);
  console.log(`tier changes ${c.tier_moves}`);
  console.log(`deliverables lost  ${c.lost_deliverable}`);
  if (result.projected_cost) {
    console.log(`projected spend    $${result.projected_cost.baseline_usd} → $${result.projected_cost.candidate_usd}  (Δ ${result.projected_cost.delta_usd >= 0 ? '+' : ''}${result.projected_cost.delta_usd})`);
    console.log(`                   $${result.projected_cost.unit_cost_usd}/row, estimated from the recorded run`);
  }
  console.log('');
  console.log(`VERDICT  ${result.verdict} — ${result.because}`);
  console.log('');
  console.log(`→ ${mdPath}`);
}

try { main(); }
catch (err) { console.error('\n✗', err.message); process.exit(1); }
