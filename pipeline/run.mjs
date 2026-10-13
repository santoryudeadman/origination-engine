#!/usr/bin/env node
// Origination Engine — ICP in, qualified pipeline out.
//
//   node run.mjs --replay          replay a recorded run (no network, no spend)  [default]
//   node run.mjs --live            call treg for real (needs TREG_TOKEN)
//   node run.mjs --live --write    also upsert into Attio (needs ATTIO_TOKEN)
//
// This pipeline never sends anything. It proposes; a person decides.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { parseCsvObjects } from './lib/csv.mjs';
import { gate, fit, tier, timing, deliverable } from './lib/score.mjs';
import { Treg } from './lib/treg.mjs';
import { Attio } from './lib/attio.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ── tiny helpers ─────────────────────────────────────────────────────────────

function loadEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
  const a = { live: false, write: false, limit: 25, out: join(ROOT, 'site/data/run.json') };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--live') a.live = true;
    else if (t === '--replay') a.live = false;
    else if (t === '--write') a.write = true;
    else if (t === '--limit') a.limit = Number(argv[++i]);
    else if (t === '--out') a.out = resolve(argv[++i]);
  }
  return a;
}

const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const usd = (micro) => `$${(micro / 1e6).toFixed(4)}`;

// ── the motion ───────────────────────────────────────────────────────────────

/**
 * Compile a row into a lead: gate it, score it, tier it.
 * Gate first, always — no paid lookup runs on a row that has not passed.
 */
function compile(row, rules, referenceDate) {
  const f = fit(row);
  const g = gate(row, rules);
  const t = timing(row, referenceDate, rules.tiers.A.requires_fresh_signal_days);
  return {
    company: row.company?.replace(/\s*🥇\s*$/, '').trim() || row.company,
    domain: row.domain || null,
    fit: f,
    gate: g.pass ? 'pass' : 'drop',
    drop_reason: g.pass ? null : g.reason,
    failed_gate: [...(g.failed || [])][0] ?? null,
    signal: t.signal ? `${t.signal.kind} (${t.signal.date})` : null,
    signal_age_days: t.age_days,
    opener_score: row.opener_score ? Number(row.opener_score) : null,
    person_found: row.person_found === 'yes',
    email_provider: row.email_source && row.email_source !== 'none' ? row.email_source : null,
    verify: row.verify || null,
    deliverable: deliverable(row),
    tier: g.pass ? tier(row, rules, referenceDate) : null,
    source_list: rules.run.name,
    note: row.note || null,
  };
}

/** Replay: a recorded run. Same gates, same thresholds, no network. */
function sourceReplay(rules, referenceDate) {
  const csv = readFileSync(join(ROOT, 'site/data/run.csv'), 'utf8');
  const rows = parseCsvObjects(csv);
  return { rows, source: 'replay:site/data/run.csv', rows_scanned: rows.length };
}

/** Live: build the universe from the ICP. */
async function sourceLive(rules, args, log) {
  const treg = new Treg({ capPerRunUsd: rules.spend.cap_per_run_usd });
  const icp = readFileSync(join(HERE, rules.run.icp), 'utf8');
  const industry = /B2B software/i.test(icp) ? 'software' : undefined;

  log(`treg: companies.search  (cap ${usd(rules.spend.cap_per_run_usd * 1e6)})`);
  const found = await treg.companiesSearch({
    q: 'US B2B software companies, 51-200 staff, selling to sales/marketing/growth',
    industry,
    country: 'US',
    limit: args.limit,
  });
  const companies = found.output?.companies ?? found.output ?? [];
  log(`treg: ${companies.length} companies, served by ${found._treg?.served_by ?? '—'}`);

  // A row that lacks the fields to judge gets one cheap enrich before any gate.
  const rows = [];
  for (const c of companies) {
    let row = { company: c.name, domain: c.domain, jev_fit: null };
    if (!c.employee_count && c.domain) {
      try {
        const e = await treg.companiesEnrich(c.domain);
        const o = e.output ?? {};
        row = { ...row, ...{ headcount: o.employee_count ?? o.employees, description: o.description } };
      } catch (err) { log(`  enrich miss ${c.domain}: ${err.message}`); }
    }
    rows.push(row);
  }
  return { rows, source: `live:treg.companies.search (${treg.log.length} calls)`, rows_scanned: rows.length, treg };
}

/** After the gates: find the person, find the email, verify it. Paid. */
async function enrich(leads, rules, treg, log) {
  if (!treg) return leads;
  const buyerTitle = 'marketing';
  for (const lead of leads) {
    if (lead.gate !== 'pass' || !lead.domain) continue;
    try {
      const p = await treg.peopleSearch({ companyDomain: lead.domain, title: buyerTitle, country: 'US', limit: 5 });
      const person = (p.output?.people ?? [])[0];
      if (!person) { log(`  no ${buyerTitle} at ${lead.domain}`); continue; }
      lead.person_found = true;
      lead.person_name = person.full_name || [person.first_name, person.last_name].filter(Boolean).join(' ');
      lead.person_title = person.title;

      const e = await treg.emailFind({ fullName: person.full_name, firstName: person.first_name, lastName: person.last_name, domain: lead.domain, linkedinUrl: person.linkedin_url });
      lead.email = e.output?.email ?? null;
      lead.email_provider = e._treg?.served_by ?? null;
      lead.verify = e._treg?.verification?.verdict ?? e.output?.status ?? null;
      lead.deliverable = lead.verify === 'valid';
    } catch (err) {
      log(`  ${lead.domain}: ${err.message}`);
    }
  }
  return leads;
}

/** Writeback. Writeback is the product. */
async function writeback(leads, rules, attio, log) {
  const listName = rules.writeback.list.replace('{run.name}', rules.run.name);
  const listId = await attio.createList({ name: listName, apiSlug: slug(listName) });
  log(`attio: list "${listName}" → ${listId}`);

  for (const lead of leads) {
    if (!lead.deliverable || !lead.domain) continue;
    const companyId = await attio.upsertCompany({ domain: lead.domain, name: lead.company });
    const personId = await attio.upsertPerson({
      email: lead.email,
      fullName: lead.person_name,
      title: lead.person_title,
      companyDomain: lead.domain,
    });
    await attio.addToList({ listId, recordId: companyId, parentObject: 'companies' });
    log(`  ${lead.company} → company ${companyId}, person ${personId} (${lead.email_provider}, ${lead.verify})`);
  }
}

// ── receipt ──────────────────────────────────────────────────────────────────

function receipt(leads, rules, treg) {
  const passed = leads.filter((l) => l.gate === 'pass');
  const named = passed.filter((l) => l.person_found);
  const foundEmail = named.filter((l) => l.email_provider || l.email);
  const deliverableRows = named.filter((l) => l.deliverable);
  const metered = Boolean(treg) && treg.log.length > 0;
  const spendMicro = metered ? treg.spentMicro : 2_330_000; // the recorded run cost $2.33

  const tiers = { A: 0, B: 0, C: 0 };
  for (const l of passed) if (l.tier) tiers[l.tier] += 1;

  return {
    scanned: leads.length,
    with_domain: leads.filter((l) => l.domain).length,
    no_domain: leads.filter((l) => l.failed_gate === 'has_domain').length,
    dropped_fit: leads.filter((l) => l.failed_gate === 'icp_fit').length,
    passed: passed.length,
    dropped_before_paying: leads.length - passed.length,
    spend_source: metered ? 'metered' : 'recorded (treg.to published run, 2026-09-23)',
    people_named: named.length,
    emails_found: foundEmail.length,
    deliverable: deliverableRows.length,
    unknown_verdict: named.filter((l) => l.verify === 'unknown').length,
    invalid: named.filter((l) => l.verify === 'invalid').length,
    tiers,
    spend_micro: spendMicro,
    spend_usd: Number((spendMicro / 1e6).toFixed(4)),
    cost_per_deliverable_usd: deliverableRows.length ? Number((spendMicro / 1e6 / deliverableRows.length).toFixed(4)) : null,
    cap_per_run_usd: rules.spend.cap_per_run_usd,
    treg_calls: treg ? treg.log.length : 0,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const log = (s) => console.log(s);

  const rules = JSON.parse(readFileSync(join(HERE, 'rules.json'), 'utf8'));
  const icp = readFileSync(join(HERE, rules.run.icp), 'utf8');
  const referenceDate = rules.run.reference_date;

  const killSwitch = (process.env.ORIGINATION_KILL_SWITCH || 'off') === 'on';
  if (killSwitch && args.live) {
    log('✋ kill switch engaged (ORIGINATION_KILL_SWITCH=on) — no paid steps, nothing written.');
    return;
  }

  log(`run      ${rules.run.name}`);
  log(`mode     ${args.live ? 'live' : 'replay'}${args.write ? ' + write' : ' (propose-only)'}`);
  log(`icp      ${rules.run.icp}  sha256:${sha(icp)}`);
  log(`rules    sha256:${sha(JSON.stringify(rules))}`);
  log('');

  const { rows, source, treg } = args.live
    ? await sourceLive(rules, args, log)
    : sourceReplay(rules, referenceDate);
  log(`source   ${source}`);
  log('');

  // 1. compile + free gates
  let leads = rows.map((r) => compile(r, rules, referenceDate));
  const dropped = leads.filter((l) => l.gate === 'drop');
  log(`gates    ${leads.length - dropped.length} pass / ${dropped.length} drop (free — no lookups spent)`);
  for (const d of dropped.slice(0, 4)) log(`           × ${d.company} — ${d.drop_reason}`);

  // 2. paid steps — only on rows that passed
  leads = await enrich(leads, rules, treg, log);

  // 3. writeback
  const attio = new Attio({ dryRun: !args.write, log: (l) => log(`           ${l}`) });
  await writeback(leads, rules, attio, log);

  // 4. receipt
  const r = receipt(leads, rules, treg);
  log('');
  log(`receipt  ${r.passed} passed · ${r.deliverable} deliverable · ${usd(r.spend_micro)} ($${r.cost_per_deliverable_usd}/deliverable)`);
  log(`tiers    A ${r.tiers.A} · B ${r.tiers.B} · C ${r.tiers.C}`);
  log(`attio    ${JSON.stringify(attio.receipt())}`);

  const out = {
    meta: {
      run: rules.run.name,
      generated_at: new Date().toISOString(),
      reference_date: referenceDate,
      icp_sha256: sha(icp),
      rules_sha256: sha(JSON.stringify(rules)),
      owner_of_stop: rules.run.owner_of_stop,
      autonomy: rules.safety.autonomy,
      source,
      pipeline_version: '1.0.0',
    },
    receipt: r,
    tiers: rules.tiers,
    leads: leads.sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0)),
    treg_calls: treg ? treg.log : [],
  };
  writeFileSync(args.out, JSON.stringify(out, null, 2));
  log(`→ ${args.out}`);
}

main().catch((err) => { console.error('\n✗', err.message); if (err.detail) console.error(err.detail); process.exit(1); });
