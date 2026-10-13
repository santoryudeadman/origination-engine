#!/usr/bin/env node
// Origination Engine — ICP in, qualified pipeline out.
//
//   node run.mjs --replay                    replay the recorded run for an ICP (no network)
//   node run.mjs --icp small-teams           pick a profile from pipeline/rules/
//   node run.mjs --live                      call treg for real (needs TREG_TOKEN)
//   node run.mjs --live --write              also upsert into Attio (needs ATTIO_TOKEN)
//
// This pipeline never sends anything. It proposes; a person decides.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';

import { parseCsvObjects } from './lib/csv.mjs';
import { gate, fit, tier, timing, deliverable } from './lib/score.mjs';
import { Treg } from './lib/treg.mjs';
import { createCrm, knownCrms } from './lib/crm/index.mjs';
import { fileBudget } from './lib/budget.mjs';
import { mapPool } from './lib/pool.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RULES_DIR = join(HERE, 'rules');

// ── tiny helpers ─────────────────────────────────────────────────────────────

function loadEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
  const a = { icp: 'mid-market', live: false, write: false, limit: 25, out: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--live') a.live = true;
    else if (t === '--replay') a.live = false;
    else if (t === '--write') a.write = true;
    else if (t === '--list') a.list = true;
    else if (t === '--icp') a.icp = argv[++i];
    else if (t === '--crm') a.crm = argv[++i];
    else if (t === '--limit') a.limit = Number(argv[++i]);
    else if (t === '--out') a.out = resolve(argv[++i]);
  }
  return a;
}

const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const usd = (micro) => `$${(micro / 1e6).toFixed(4)}`;

const profiles = () => readdirSync(RULES_DIR).filter((f) => extname(f) === '.json').map((f) => basename(f, '.json'));

// ── normalisation: a source row becomes a lead ───────────────────────────────
// The scoring rules never see where a row came from.

/** A recorded provider run (treg.to shape). */
function fromCsv(r) {
  const m = /\((\d{4}-\d{2}-\d{2})\)/.exec(r.latest_news || '');
  return {
    company: (r.company || '').replace(/\s*🥇\s*$/, '').trim(),
    domain: r.domain || null,
    fit: r.jev_fit,
    headcount: null, // a bought list carries no verified headcount — the size gate stays silent
    signal: m ? { kind: (r.latest_news || '').split(' (')[0].trim(), date: m[1] } : null,
    person_found: r.person_found === 'yes',
    email_provider: r.email_source && r.email_source !== 'none' ? r.email_source : null,
    verify: r.verify || null,
    opener_score: r.opener_score ? Number(r.opener_score) : null,
    source_url: null,
    note: r.note || null,
  };
}

/** A researched universe (omp-sourced from public sources; no provider enrichment yet). */
function fromJson(r) {
  return {
    company: r.company,
    domain: r.domain || null,
    fit: r.fit,
    headcount: r.employees ?? null,
    signal: r.signal_date ? { kind: r.signal_kind, date: r.signal_date } : null,
    employees: r.employees ?? null,
    category: r.category ?? null,
    buyer_role: r.buyer_role ?? null,
    employees_source: r.employees_source ?? null,
    source_url: r.source_url ?? null,
    person_found: Boolean(r.buyer_role),
    email_provider: null,
    verify: null,
    note: r.fit_reason || null,
  };
}

/** Gate, score and tier a normalized lead. */
function compile(lead, rules, referenceDate) {
  const g = gate(lead, rules);
  const t = timing(lead, referenceDate, rules.tiers.A.requires_fresh_signal_days);
  return {
    ...lead,
    fit: fit(lead),
    gate: g.pass ? 'pass' : 'drop',
    drop_reason: g.pass ? null : g.reason,
    failed_gate: [...g.failed][0] ?? null,
    signal_label: t.signal ? `${t.signal.kind} (${t.signal.date})` : null,
    signal_age_days: t.age_days,
    tier: g.pass ? tier(lead, rules, referenceDate) : null,
    deliverable: deliverable(lead),
    source_list: rules.run.name,
  };
}

// ── sources ──────────────────────────────────────────────────────────────────

function readSource(rules) {
  const path = join(ROOT, rules.run.source);
  if (!existsSync(path)) return { rows: [], source: `${rules.run.source} (missing)` };
  const raw = readFileSync(path, 'utf8');
  const rows = rules.run.source_format === 'json' ? JSON.parse(raw) : parseCsvObjects(raw);
  const list = Array.isArray(rows) ? rows : (rows.companies ?? []);
  return { rows: list, source: `${rules.run.source_format}:${rules.run.source}` };
}

async function sourceLive(rules, args, log) {
  // Two rails, both enforced in code: a per-run cap and a daily ledger on disk so a
  // scheduled job cannot re-spend the day's budget on every tick.
  const budget = fileBudget({
    path: join(ROOT, '.origination/spend.json'),
    capPerDayUsd: Number(
      process.env.ORIGINATION_CAP_PER_DAY_USD
      ?? rules.spend.cap_per_day_usd
      ?? rules.spend.cap_per_run_usd,
    ),
  });
  log(`budget   ${usd(budget.spentMicro())} of $${(budget.capMicro / 1e6).toFixed(2)} spent today`);

  const treg = new Treg({ capPerRunUsd: rules.spend.cap_per_run_usd, budget });
  const icp = readFileSync(join(HERE, rules.run.icp), 'utf8');
  const industry = /software|SaaS/i.test(icp) ? 'software' : undefined;
  const size = rules.thresholds.headcount;

  log(`treg: companies.search  (cap ${usd(rules.spend.cap_per_run_usd * 1e6)})`);
  const found = await treg.companiesSearch({
    q: `${size[0]}-${size[1]} employee US companies, knowledge work, selling software to businesses`,
    industry,
    country: 'US',
    limit: args.limit,
  });
  const companies = found.output?.companies ?? found.output ?? [];
  log(`treg: ${companies.length} companies, served by ${found._treg?.served_by ?? '—'}`);

  const rows = [];
  for (const c of companies) {
    let row = { company: c.name, domain: c.domain, fit: null };
    if (!c.employee_count && c.domain) {
      try {
        const e = await treg.companiesEnrich(c.domain);
        row = { ...row, employees: e.output?.employee_count ?? e.output?.employees };
      } catch (err) { log(`  enrich miss ${c.domain}: ${err.message}`); }
    }
    rows.push(row);
  }
  return { rows, source: `live:treg.companies.search (${treg.log.length} calls)`, treg };
}

/** The paid steps. Only ever runs on rows that passed every before_paid gate. */
async function enrich(leads, rules, treg, log) {
  if (!treg) return leads;
  const title = /under 50|small teams/i.test(readFileSync(join(HERE, rules.run.icp), 'utf8')) ? 'founder' : 'marketing';

  const targets = leads.filter((l) => l.gate === 'pass' && l.domain);
  const concurrency = rules.spend.concurrency ?? 5;
  log(`enrich   ${targets.length} rows, ${concurrency} in flight`);

  let done = 0;
  await mapPool(targets, concurrency, async (lead) => {
    try {
      const p = await treg.peopleSearch({ companyDomain: lead.domain, title, country: 'US', limit: 5 });
      const person = (p.output?.people ?? [])[0];
      if (!person) { log(`  no ${title} at ${lead.domain}`); done += 1; return; }

      lead.person_found = true;
      lead.person_name = person.full_name || [person.first_name, person.last_name].filter(Boolean).join(' ');
      lead.person_title = person.title;

      const e = await treg.emailFind({
        fullName: person.full_name, firstName: person.first_name,
        lastName: person.last_name, domain: lead.domain, linkedinUrl: person.linkedin_url,
      });
      lead.email = e.output?.email ?? null;
      lead.email_provider = e._treg?.served_by ?? null;
      lead.verify = e._treg?.verification?.verdict ?? e.output?.status ?? null;
      lead.deliverable = lead.verify === 'valid';
    } catch (err) {
      // One bad row must not take the run down — it is recorded and the pool moves on.
      log(`  ${lead.domain}: ${err.message}`);
    } finally {
      done += 1;
      if (done % 10 === 0) log(`         ${done}/${targets.length}`);
    }
  });

  log(`enrich   ${done}/${targets.length} rows attempted`);
  return leads;
}

/**
 * Writeback. Writeback is the product.
 * The pipeline does not know which CRM it is talking to — that is the whole point of the port.
 */
async function writeback(leads, rules, crm, log) {
  const listName = rules.writeback.list.replace('{run.name}', rules.run.name);

  let listId = null;
  if (crm.supportsLists) {
    listId = await crm.ensureList({ name: listName, slug: slug(listName), parentObject: 'companies' });
    log(`${crm.name}: list "${listName}" → ${listId}`);
  } else {
    log(`${crm.name}: no list concept — records are upserted without a working set`);
  }

  let eligible = 0;
  let written = 0;
  let withoutAddress = 0;

  for (const lead of leads) {
    if (!lead.deliverable || !lead.domain) continue;
    eligible += 1;
    // An address is the person's unique key in every CRM here. Without one there is nothing
    // to upsert — and building a record with an undefined email is worse than skipping it.
    if (!lead.email) { withoutAddress += 1; continue; }

    const companyId = await crm.upsertCompany({
      domain: lead.domain, name: lead.company, description: lead.category ?? null,
    });
    const personId = await crm.upsertPerson({
      email: lead.email, fullName: lead.person_name, title: lead.person_title, companyDomain: lead.domain,
    });
    if (listId) await crm.addToList({ listId, recordId: companyId, parentObject: 'companies' });
    written += 1;
    log(`  ${lead.company} → company ${companyId}, person ${personId} (${lead.email_provider}, ${lead.verify})`);
  }

  log(`${crm.name}: ${written} written of ${eligible} eligible`);
  if (withoutAddress) {
    log(`${crm.name}: ${withoutAddress} eligible row(s) have no address in this dataset — skipped, not faked`);
  }
  return { crm: crm.name, eligible, written, skipped_no_address: withoutAddress, supports_lists: crm.supportsLists !== false };
}

// ── receipt ──────────────────────────────────────────────────────────────────

function receipt(leads, rules, treg) {
  const passed = leads.filter((l) => l.gate === 'pass');
  const named = passed.filter((l) => l.person_found);
  const foundEmail = named.filter((l) => l.email_provider || l.email);
  const deliverableRows = named.filter((l) => l.deliverable);
  const metered = Boolean(treg) && treg.log.length > 0;
  const recorded = leads.some((l) => l.email_provider || l.verify);
  const spendMicro = metered ? treg.spentMicro : (recorded ? 2_330_000 : 0);

  const tiers = { A: 0, B: 0, C: 0 };
  for (const l of passed) if (l.tier) tiers[l.tier] += 1;

  return {
    scanned: leads.length,
    with_domain: leads.filter((l) => l.domain).length,
    no_domain: leads.filter((l) => l.failed_gate === 'has_domain').length,
    dropped_fit: leads.filter((l) => l.failed_gate === 'icp_fit').length,
    passed: passed.length,
    dropped_before_paying: leads.length - passed.length,
    people_named: named.length,
    emails_found: foundEmail.length,
    deliverable: deliverableRows.length,
    unknown_verdict: named.filter((l) => l.verify === 'unknown').length,
    invalid: named.filter((l) => l.verify === 'invalid').length,
    enrichment: metered ? 'metered' : (recorded ? 'recorded' : 'not_run'),
    spend_source: metered
      ? 'metered'
      : (recorded ? 'recorded (treg.to published run, 2026-09-23)' : 'none — no paid steps run'),
    tiers,
    spend_micro: spendMicro,
    spend_usd: Number((spendMicro / 1e6).toFixed(4)),
    cost_per_deliverable_usd: deliverableRows.length ? Number((spendMicro / 1e6 / deliverableRows.length).toFixed(4)) : null,
    cap_per_run_usd: rules.spend.cap_per_run_usd,
    cap_per_day_usd: rules.spend.cap_per_day_usd ?? null,
    concurrency: rules.spend.concurrency ?? 5,
    treg_calls: treg ? treg.log.length : 0,
    treg_retries: treg ? treg.receipt().retries : 0,
    treg_failures: treg ? treg.receipt().failures : 0,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const log = (s) => console.log(s);

  if (args.list) {
    log(`icps     ${profiles().join(', ')}`);
    log(`crms     ${knownCrms().join(', ')}`);
    return;
  }
  if (!existsSync(join(RULES_DIR, `${args.icp}.json`))) {
    throw new Error(`unknown ICP "${args.icp}". Try: ${profiles().join(', ')}`);
  }

  const rules = JSON.parse(readFileSync(join(RULES_DIR, `${args.icp}.json`), 'utf8'));
  const icp = readFileSync(join(HERE, rules.run.icp), 'utf8');
  const referenceDate = rules.run.reference_date;
  const out = args.out ?? join(ROOT, `site/data/run-${args.icp}.json`);

  const killSwitch = (process.env.ORIGINATION_KILL_SWITCH || 'off') === 'on';
  if (killSwitch && args.live) {
    log('✋ kill switch engaged (ORIGINATION_KILL_SWITCH=on) — no paid steps, nothing written.');
    return;
  }

  log(`icp      ${args.icp}  (${rules.run.name})`);
  log(`mode     ${args.live ? 'live' : 'replay'}${args.write ? ' + write' : ' (propose-only)'}`);
  log(`profile  ${rules.run.icp}  sha256:${sha(icp)}`);
  log(`rules    sha256:${sha(JSON.stringify(rules))}`);
  log('');

  const src = args.live ? await sourceLive(rules, args, log) : readSource(rules);
  const { rows, treg } = src;
  log(`source   ${src.source}`);
  log('');

  const normalize = rules.run.source_format === 'json' ? fromJson : fromCsv;
  let leads = rows.map((r) => compile(normalize(r), rules, referenceDate));

  const dropped = leads.filter((l) => l.gate === 'drop');
  log(`gates    ${leads.length - dropped.length} pass / ${dropped.length} drop (free — no lookups spent)`);
  for (const d of dropped.slice(0, 4)) log(`           × ${d.company} — ${d.drop_reason}`);

  leads = await enrich(leads, rules, treg, log);

  // 3. writeback
  const crmName = args.crm ?? rules.writeback.crm ?? 'attio';
  const crm = createCrm(crmName, { dryRun: !args.write, log: (l) => log(`           ${l}`) });
  const writebackResult = await writeback(leads, rules, crm, log);

  const r = receipt(leads, rules, treg);
  log('');
  log(`receipt  ${r.passed} passed · ${r.deliverable} deliverable · ${usd(r.spend_micro)} (enrichment: ${r.enrichment})`);
  log(`tiers    A ${r.tiers.A} · B ${r.tiers.B} · C ${r.tiers.C}`);
  log(`crm      ${JSON.stringify(crm.receipt())}`);

  writeFileSync(out, JSON.stringify({
    meta: {
      icp: args.icp,
      run: rules.run.name,
      generated_at: new Date().toISOString(),
      reference_date: referenceDate,
      icp_sha256: sha(icp),
      rules_sha256: sha(JSON.stringify(rules)),
      owner_of_stop: rules.run.owner_of_stop,
      autonomy: rules.safety.autonomy,
      thresholds: rules.thresholds,
      tiers_rule: rules.tiers,
      source: src.source,
      pipeline_version: '1.1.0',
    },
    receipt: r,
    writeback: writebackResult,
    leads: leads.sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0)),
    treg_calls: treg ? treg.log : [],
  }, null, 2));
  log(`→ ${out}`);
}

main().catch((err) => { console.error('\n✗', err.message); if (err.detail) console.error(err.detail); process.exit(1); });
