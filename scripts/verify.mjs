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

import { fileBudget } from '../pipeline/lib/budget.mjs';
import { Treg, SpendCapExceeded } from '../pipeline/lib/treg.mjs';
import { mapPool } from '../pipeline/lib/pool.mjs';

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

  // ── rails: the spend guards refuse BEFORE money moves ─────────────────────
  console.log('\nrails — spend guards');

  let perRunRefused = false;
  try { await new Treg({ token: 'x', capPerRunUsd: 0 }).call('treg.companies.enrich', { domain: 'example.com' }); }
  catch (e) { perRunRefused = e instanceof SpendCapExceeded; }
  check('per-run cap refuses before spending', perRunRefused, true);

  let dailyRefused = false;
  try {
    await new Treg({ token: 'x', budget: fileBudget({ path: join(tmp, 'tight.json'), capPerDayUsd: 0.000001 }) })
      .call('treg.companies.enrich', { domain: 'example.com' });
  } catch (e) { dailyRefused = e instanceof SpendCapExceeded; }
  check('daily rail refuses before spending', dailyRefused, true);

  const ledgerPath = join(tmp, 'spend.json');
  const ledger = fileBudget({ path: ledgerPath, capPerDayUsd: 5 });
  ledger.addMicro(2_330_000);
  check('daily rail allows spend within budget', ledger.wouldExceed(1_000_000), false);   // $2.33 + $1 < $5
  check('daily rail blocks spend beyond budget', ledger.wouldExceed(3_000_000), true);    // $2.33 + $3 > $5
  check('daily ledger reloads from disk', fileBudget({ path: ledgerPath, capPerDayUsd: 5 }).spentMicro(), 2_330_000);

  // ── resilience: retries, idempotency, concurrency ─────────────────────────
  // The retry state machine drives real money, so it is tested against stubbed I/O
  // rather than left to a live provider's mood.
  console.log('\nresilience — retries, idempotency, concurrency');

  const res = (status, body = {}, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  });
  const stub = (script) => {
    const calls = [];
    return {
      calls,
      impl: async (url, init) => {
        calls.push({ url, headers: init.headers });
        const step = script[Math.min(calls.length - 1, script.length - 1)];
        return step();
      },
    };
  };
  const key = (c) => c.headers['Idempotency-Key'];
  const quiet = { sleep: async () => {}, backoffBaseMs: 0 };

  {
    const s = stub([
      () => res(429, { detail: { error: 'share_busy', retry_after_s: 2 } }),   // provider capping calls in progress
      () => res(200, { output: { email: 'a@b.co' } }, { 'x-treg-cost-micro': '4834', 'x-treg-call-id': 'c1' }),
    ]);
    const t = new Treg({ token: 'x', fetchImpl: s.impl, ...quiet });
    const out = await t.call('treg.people.email.find', { domain: 'b.co' });
    check('429 is retried', s.calls.length, 2);
    check('a retry reuses the idempotency key', key(s.calls[0]) === key(s.calls[1]), true);
    check('a retry returns the answer', out.output.email, 'a@b.co');
    check('a retried call is billed once', t.spentMicro, 4834);
    check('the receipt counts the retry', t.receipt().retries, 1);
  }

  {
    const s = stub([() => res(500, {}), () => res(200, { output: 1 }, { 'x-treg-cost-micro': '100' })]);
    const t = new Treg({ token: 'x', fetchImpl: s.impl, ...quiet });
    await t.call('treg.companies.enrich', { domain: 'a.com' });
    check('5xx is retried', s.calls.length, 2);
    check('5xx retry reuses the key', key(s.calls[0]) === key(s.calls[1]), true);
  }

  {
    const s = stub([() => res(400, { detail: { error: 'bad_param' } })]);
    const t = new Treg({ token: 'x', fetchImpl: s.impl, ...quiet });
    let err = null;
    try { await t.call('treg.people.search', {}); } catch (e) { err = e; }
    check('4xx is NOT retried (it is our bug)', s.calls.length, 1);
    check('4xx surfaces the provider error', err?.detail?.error, 'bad_param');
    check('4xx is charged nothing', t.spentMicro, 0);
  }

  {
    const s = stub([() => res(410, { detail: { error: 'idempotency_response_lost' } })]);
    const t = new Treg({ token: 'x', fetchImpl: s.impl, ...quiet });
    let err = null;
    try { await t.call('treg.people.search', {}); } catch (e) { err = e; }
    check('410 is not retried with the same key', s.calls.length, 1);
    check('410 exposes the idempotency key for audit', typeof err?.idempotency_key, 'string');
  }

  {
    const s = stub([() => res(503, { treg_saturated: true }, { 'retry-after': '1' })]);
    const t = new Treg({ token: 'x', fetchImpl: s.impl, maxRetries: 2, ...quiet });
    let err = null;
    try { await t.call('treg.people.search', {}); } catch (e) { err = e; }
    check('retries stop at maxRetries', s.calls.length, 3);
    check('exhausted retries report the attempt count', err?.attempts, 3);
  }

  {
    // Concurrency is the backpressure: never more than `limit` in flight, order preserved.
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 4));
      inFlight -= 1;
      return i * 2;
    });
    check('mapPool caps concurrency', peak <= 4, true);
    check('mapPool runs concurrently', peak > 1, true);
    check('mapPool preserves input order', [out[0], out[19]], [0, 38]);
  }

  {
    // Under concurrency the reservation must be atomic, or a burst overshoots the day's budget.
    const b = fileBudget({ path: join(tmp, 'conc.json'), capPerDayUsd: 1 });
    check('reservations are atomic', [b.reserve(600_000), b.reserve(600_000)], [true, false]);
    b.settle(600_000, 4_834);
    check('settlement refunds the unused reservation', b.spentMicro(), 4_834);
  }

  // ── the CRM port: one interface, three vendors ────────────────────────────
  console.log('\ncrm — the writeback port');

  {
    const { createCrm, knownCrms } = await import('../pipeline/lib/crm/index.mjs');

    check('the port knows three vendors', knownCrms(), ['attio', 'hubspot', 'salesforce']);

    let refused = false;
    try { createCrm('pipedrive'); } catch { refused = true; }
    check('an unknown vendor is refused', refused, true);

    const attio = createCrm('attio', { dryRun: true });
    const hub = createCrm('hubspot', { dryRun: true });
    const sf = createCrm('salesforce', { dryRun: true });

    check('supportsLists is per-vendor', [attio.supportsLists, hub.supportsLists, sf.supportsLists], [true, true, false]);

    // An address is the unique key in every CRM here. Writing a person without one would
    // produce a malformed record, so every adapter must refuse rather than emit it.
    const refusedNoEmail = [];
    for (const [name, c] of [['attio', attio], ['hubspot', hub], ['salesforce', sf]]) {
      try { await c.upsertPerson({ companyDomain: 'acme.com' }); } catch { refusedNoEmail.push(name); }
    }
    check('every adapter refuses a person with no email', refusedNoEmail, ['attio', 'hubspot', 'salesforce']);

    // HubSpot: idempotency lives in a per-input idProperty on the batch endpoint.
    await hub.upsertCompany({ domain: 'acme.com', name: 'Acme' });
    await hub.upsertPerson({ email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe', companyDomain: 'acme.com' });
    check('hubspot keys a company on domain', hub.requests[0].body.inputs[0].idProperty, 'domain');
    check('hubspot keys a person on email', hub.requests[1].body.inputs[0].idProperty, 'email');
    check('hubspot batches rather than upserting singly', hub.requests[0].url.endsWith('/crm/v3/objects/companies/batch/upsert'), true);
    check('hubspot creates a MANUAL list', (await hub.ensureList({ name: 'X' }), hub.requests.at(-1).body.processingType), 'MANUAL');

    // Salesforce: idempotency lives in the URL, and linking is a nested external-id reference.
    await sf.upsertCompany({ domain: 'acme.com', name: 'Acme' });
    await sf.upsertPerson({ email: 'jane@acme.com', lastName: 'Doe', companyDomain: 'acme.com' });
    check('salesforce upserts by external id in the URL',
      sf.requests[0].url.endsWith('/sobjects/Account/External_Id__c/acme.com'), true);
    check('salesforce upserts a contact by external id',
      sf.requests[1].url.endsWith('/sobjects/Contact/External_Id__c/jane%40acme.com'), true);
    check('salesforce links by nested external id',
      sf.requests[1].body.Account, { External_Id__c: 'acme.com' });
    check('salesforce never sends a null LastName', typeof sf.requests[1].body.LastName, 'string');
  }

  // ── the sequencer port: the first irreversible step gets its own guards ───
  console.log('\nsequencers — the handoff');

  {
    const { createSequencer, knownSequencers } = await import('../pipeline/lib/sequence/index.mjs');

    check('the port knows two sequencers', knownSequencers(), ['emailbison', 'lemlist']);

    const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

    // Lemlist does not expose the base URL in the request log, so assert on the path we built.
    const ll = createSequencer('lemlist', { dryRun: true });
    const enrolled = await ll.enroll({ campaignId: 'cam_1', lead: { email: 'a@b.co', firstName: 'A', company: 'B' } });
    check('lemlist enrols through the campaign path', ll.requests[0].url.endsWith('/campaigns/cam_1/leads/?updateStrategy=fillEmptyOnly'), true);
    check('lemlist uses the documented camelCase body', ll.requests[0].body.companyName, 'B');
    check('lemlist reports the enrolment', enrolled.enrolled, true);

    let refusedNoEmail = false;
    try { await ll.enroll({ campaignId: 'cam_1', lead: {} }); } catch { refusedNoEmail = true; }
    check('lemlist refuses a lead with no email', refusedNoEmail, true);

    let refusedNoCampaign = false;
    try { await ll.enroll({ lead: { email: 'a@b.co' } }); } catch { refusedNoCampaign = true; }
    check('lemlist refuses to enrol without a destination', refusedNoCampaign, true);

    // The behaviour that matters: add-lead CREATES ONLY. A second run is not a failure.
    const dup = createSequencer('lemlist', {
      dryRun: false, token: 'x',
      fetchImpl: async () => resp(400, { code: 'LEAD_ALREADY_IN_CAMPAIGN', message: 'lead already in campaign' }),
    });
    const second = await dup.enroll({ campaignId: 'cam_1', lead: { email: 'a@b.co' } });
    check('lemlist treats "already enrolled" as a no-op, not an error', second, { enrolled: false, skipped: 'already-enrolled' });

    const eb = createSequencer('emailbison', { dryRun: true });
    await eb.enroll({ campaignId: '9', lead: { email: 'x@y.co', fullName: 'Jane Doe' } });
    check('emailbison derives the required last name', eb.requests[0].body.last_name, 'Doe');
    check('emailbison creates then attaches', eb.requests[1].url.endsWith('/campaigns/9/leads/attach-leads'), true);
    check('emailbison attaches the created lead id', eb.requests[1].body.lead_ids.length, 1);

    let needsInstance = false;
    try { createSequencer('emailbison', { dryRun: false }); } catch { needsInstance = true; }
    check('emailbison refuses to run live without its instance host', needsInstance, true);
  }

  // ── the dialer queue: the primitives no vendor gives you ─────────────────
  console.log('\ndialer — the queue');

  {
    const { plan, runQueue, isWithinWindow, nextRetry, DISPOSITIONS } = await import('../pipeline/lib/dialer/queue.mjs');
    const HOURS = { start: 8, end: 18, days: [1, 2, 3, 4, 5] };

    // 2026-10-13T14:00Z = 10:00 in New York (EDT) on a weekday.
    const weekday = new Date('2026-10-13T14:00:00Z');
    check('a weekday morning is inside the window', isWithinWindow(weekday, 'America/New_York', HOURS), true);
    check('the window is per-contact, not per-server', isWithinWindow(weekday, 'Asia/Tokyo', HOURS), false); // 23:00 there
    check('late local evening is outside the window',
      isWithinWindow(new Date('2026-10-14T02:00:00Z'), 'America/New_York', HOURS), false); // 22:00 Tue
    check('the weekend is outside the window',
      isWithinWindow(new Date('2026-10-17T14:00:00Z'), 'America/New_York', HOURS), false);

    const contacts = [
      { email: 'a@x.co' },
      { email: 'b@x.co' },
      { email: 'c@x.co', time_zone: 'Asia/Tokyo' },
      { email: 'd@x.co', do_not_contact: true },
    ];
    const p = plan(contacts, { now: weekday, window: HOURS, timeZone: 'America/New_York' });
    check('in-window contacts are dialable', p.dialable.map((c) => c.email), ['a@x.co', 'b@x.co']);
    check('DNC and out-of-window are deferred with a reason', p.deferred.map((d) => d.reason).sort(), ['dnc', 'outside-window']);
    check('the daily attempt cap defers',
      plan([{ email: 'a@x.co' }], { now: weekday, attemptsToday: () => 3, maxAttemptsPerDay: 3 }).deferred[0].reason, 'attempt-cap-today');
    check('the total attempt cap defers',
      plan([{ email: 'a@x.co' }], { now: weekday, attemptsTotal: () => 6, maxAttempts: 6 }).deferred[0].reason, 'attempt-cap-total');

    // Dispositions are not interchangeable: a voicemail and a bad number are different events.
    check('a connected call is terminal', DISPOSITIONS.connected.terminal, true);
    check('a bad number never retries', nextRetry('bad_number', weekday), null);
    check('voicemail retries tomorrow', nextRetry('voicemail', weekday).toISOString(), '2026-10-14T14:00:00.000Z');
    check('busy retries sooner than voicemail',
      nextRetry('busy', weekday) < nextRetry('voicemail', weekday), true);

    let inFlight = 0;
    let peak = 0;
    const dialled = Array.from({ length: 6 }, (_, i) => ({ email: `u${i}@x.co` }));
    const out = await runQueue(dialled, {
      now: weekday, window: HOURS, concurrency: 2, timeZone: 'America/New_York',
      dial: async (c) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        inFlight -= 1;
        return c.email === 'u1@x.co' ? 'voicemail' : 'connected';
      },
    });
    check('the dialer caps concurrent lines', peak <= 2, true);
    check('dispositions are tallied', out.byDisposition, { connected: 5, voicemail: 1 });

    const thrown = await runQueue([{ email: 't@x.co' }], {
      now: weekday, window: HOURS, timeZone: 'America/New_York',
      dial: async () => { throw new Error('SIP 503'); },
    });
    check('a transport failure is recorded, never treated as an answer', thrown.byDisposition, { failed: 1 });

    let needsTransport = false;
    try { await runQueue([], { now: weekday }); } catch { needsTransport = true; }
    check('the queue refuses to run without a transport', needsTransport, true);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
