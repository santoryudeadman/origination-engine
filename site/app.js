// Origination Engine — console.
// Two ICP profiles, one pipeline. Everything below is a pure function of the recorded
// run data; the threshold slider re-applies the *free* gates client-side. Nothing is faked.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const FRESH_DAYS = { 'mid-market': 90, 'small-teams': 120 };
const TIER_A_FIT = 0.6;

const PROFILES = {
  'mid-market': {
    label: 'Mid-market',
    filters: [
      ['country', 'US'], ['headcount', '51–200'], ['category', 'B2B software'],
      ['buyer function', 'marketing / growth'], ['exclusions', 'services, pre-product, in-CRM'],
    ],
    note: 'At this size the buyer is a <em>function</em>. Signal freshness window: 90 days.',
  },
  'small-teams': {
    label: 'Small teams',
    filters: [
      ['country', 'US'], ['headcount', '1–49'], ['category', 'software / vertical SaaS'],
      ['buyer role', 'founder / CEO'], ['exclusions', 'services, dormant 12mo, in-CRM'],
    ],
    note: 'Under 50 staff there is no marketing function — the buyer is the founder, and the <em>signal</em> does more work than the fit. Window: 120 days. This universe was assembled by targeted research rather than downloaded, so the free gates act as a safety net — the <em>tiering</em> is what narrows the list.',
  },
};

const state = { icp: 'mid-market', run: null, threshold: 0.5, tier: 'all' };

/** Re-apply the free gates at the current threshold. Pure function of a recorded row. */
function judge(lead) {
  const pass = Boolean(lead.domain) && lead.fit != null && lead.fit >= state.threshold;
  const fresh = lead.signal_age_days != null && lead.signal_age_days >= 0
    && lead.signal_age_days <= (FRESH_DAYS[state.icp] ?? 90);
  let tier = null;
  if (pass) tier = lead.fit >= TIER_A_FIT && fresh ? 'A' : (lead.fit >= TIER_A_FIT || fresh ? 'B' : 'C');
  return { pass, tier };
}

function tally(leads) {
  const rows = leads.map((l) => ({ ...l, ...judge(l) }));
  const passed = rows.filter((r) => r.pass);
  return {
    rows,
    passed: passed.length,
    dropped: rows.length - passed.length,
    named: passed.filter((r) => r.person_found).length,
    emails: passed.filter((r) => r.email_provider).length,
    deliverable: passed.filter((r) => r.verify === 'valid').length,
    tiers: ['A', 'B', 'C'].reduce((a, t) => ({ ...a, [t]: passed.filter((r) => r.tier === t).length }), {}),
  };
}

// ── render ───────────────────────────────────────────────────────────────────

const money = (n) => `$${n.toFixed(4)}`;
const cell = (k, v, cls = '') => `<div class="cell"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
const pill = (text, cls = '') => `<span class="pill ${cls}">${text}</span>`;

function renderFilters() {
  $('#filters').innerHTML = PROFILES[state.icp].filters
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#profile-note').innerHTML = PROFILES[state.icp].note;
}

function renderHero(r) {
  const enrichRun = r.enrichment !== 'not_run';
  const cells = [`<li><b>${r.passed}/${r.with_domain}</b><span>passed the free gates</span></li>`];
  if (enrichRun) {
    cells.push(
      `<li><b>${r.deliverable}</b><span>verified emails</span></li>`,
      `<li><b>$${r.cost_per_deliverable_usd.toFixed(2)}</b><span>per deliverable lead</span></li>`,
      `<li><b>${r.dropped_before_paying}</b><span>never bought</span></li>`,
    );
  } else {
    cells.push(
      `<li><b>${r.tiers.A}</b><span>tier A — contact now</span></li>`,
      `<li><b>${r.scanned}</b><span>companies sourced</span></li>`,
      `<li><b>pending</b><span>paid steps · needs a data token</span></li>`,
    );
  }
  $('#hero-stats').innerHTML = cells.join('');
}

function renderReceipt(t, r) {
  const enrichRun = r.enrichment !== 'not_run';
  const per = enrichRun && t.deliverable ? r.spend_usd / t.deliverable : null;
  const cells = [
    cell('passed the gates', `${t.passed}<span class="sub2"> / ${t.rows.length}</span>`, 'good'),
    cell('never bought', String(t.dropped), 'bad'),
  ];
  if (enrichRun) {
    cells.push(
      cell('verified emails', String(t.deliverable), 'good'),
      cell('emails found', String(t.emails), 'mut'),
      cell('$/deliverable', per ? money(per) : '—', 'mut'),
      cell('spend', `$${r.spend_usd.toFixed(2)}<span class="sub2"> ${r.spend_source.split(' ')[0]}</span>`, 'mut'),
    );
  } else {
    cells.push(
      cell('enrichment', 'not run', 'mut'),
      cell('tier A', String(t.tiers.A), 'good'),
      cell('with a signal', String(t.rows.filter((r) => r.pass && r.signal_label).length), 'mut'),
      cell('source', 'public research', 'mut'),
    );
  }
  cells.push(cell('tiers', `A ${t.tiers.A} · B ${t.tiers.B} · C ${t.tiers.C}`, 'mut'));
  $('#receipt').innerHTML = cells.join('');
}

const COLS = {
  'mid-market': [
    { h: 'Company', v: (r) => r.company },
    { h: 'Domain', v: (r) => r.domain || '—' },
    { h: 'Fit', num: true, v: (r) => (r.fit ?? 0).toFixed(2) },
    { h: 'Gate', v: (r) => pill(r.pass ? 'pass' : 'drop', r.pass ? 'pass' : 'drop') },
    { h: 'Tier', v: (r) => (r.pass && r.tier ? pill(r.tier, r.tier) : pill('—', 'none')) },
    { h: 'Signal', v: (r) => r.signal_label || '—' },
    { h: 'Email', v: (r) => (r.email_provider ? pill(r.email_provider) : pill('—', 'none')) },
    { h: 'Verify', v: (r) => (r.verify ? pill(r.verify, r.verify === 'valid' ? 'verified' : r.verify === 'unknown' ? 'unknown' : '') : pill('—', 'none')) },
  ],
  'small-teams': [
    { h: 'Company', v: (r) => r.company },
    { h: 'Domain', v: (r) => r.domain || '—' },
    { h: 'Fit', num: true, v: (r) => (r.fit ?? 0).toFixed(2) },
    { h: 'Gate', v: (r) => pill(r.pass ? 'pass' : 'drop', r.pass ? 'pass' : 'drop') },
    { h: 'Tier', v: (r) => (r.pass && r.tier ? pill(r.tier, r.tier) : pill('—', 'none')) },
    { h: 'Employees', num: true, v: (r) => (r.employees ?? '—') },
    { h: 'Category', v: (r) => r.category || '—' },
    { h: 'Buyer', v: (r) => r.buyer_role || '—' },
    { h: 'Signal', v: (r) => (r.signal_label ? `${r.signal_label}` : '—') },
  ],
};

function renderTable(t) {
  const cols = COLS[state.icp];
  $('#leads thead tr').innerHTML = cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.h}</th>`).join('');

  const shown = t.rows
    .filter((r) => (state.tier === 'all' ? true : state.tier === 'drop' ? !r.pass : r.pass && r.tier === state.tier))
    .sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0));

  $('#leads tbody').innerHTML = shown.map((r) =>
    `<tr class="${r.pass ? '' : 'drop'}">${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.v(r)}</td>`).join('')}</tr>`,
  ).join('');

  const ex = shown.find((r) => !r.pass);
  $('#table-note').textContent = `showing ${shown.length} of ${t.rows.length} rows`
    + (state.tier === 'drop' ? ' · dropped on a free gate — never enriched, never billed' : '')
    + (ex ? ` · e.g. ${ex.company}: ${ex.drop_reason || 'no domain'}` : '');
}

function renderWriteback(lead) {
  if (!lead?.domain) { $('#wm-company').textContent = '—'; $('#wm-person').textContent = '—'; return; }
  const company = { data: { values: {
    domains: [{ domain: lead.domain }], name: [{ value: lead.company }],
    description: [{ value: `${lead.category || 'software'} · fit ${lead.fit}` }],
  } } };
  const person = { data: { values: {
    // person fields come from treg.people.search, the address from treg.people.email.find
    email_addresses: [{ email_address: '<from treg.people.email.find>' }],
    name: [{ first_name: '<from', last_name: 'treg.people.search>' }],
    job_title: [{ value: '<from treg.people.search>' }],
    company: [{ domains: [{ domain: lead.domain }], target_object: 'companies' }],
  } } };
  $('#wm-company').innerHTML = hl(JSON.stringify(company, null, 2));
  $('#wm-person').innerHTML = hl(JSON.stringify(person, null, 2));
}

const hl = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
  .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>');

function refresh() {
  const t = tally(state.run.leads);
  const r = { ...state.run.receipt, tiers: t.tiers };
  renderReceipt(t, r);
  renderTable(t);
  $('#thr-hint').textContent =
    `at ${state.threshold.toFixed(2)} → ${t.passed} of ${t.rows.length} pass, ${t.dropped} dropped before any paid lookup`;
}

// ── run animation ────────────────────────────────────────────────────────────

async function run() {
  const btn = $('#run');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Running…';

  const t = tally(state.run.leads);
  const wb = state.run.writeback;
  const enrichRun = state.run.receipt.enrichment !== 'not_run';
  const steps = [
    ['source', `${t.rows.length} rows`],
    ['qualify', `${t.passed} pass / ${t.dropped} drop`],
    ['people', enrichRun ? `${t.named} named` : 'not run'],
    ['email', enrichRun ? `${t.emails} found` : 'not run'],
    ['write', wb ? `${wb.written} written / ${wb.eligible} eligible` : 'pending'],
  ];

  for (const li of $$('.stages li')) { li.classList.remove('done', 'run'); li.querySelector('em').textContent = '—'; }
  for (const [id, result] of steps) {
    const li = $(`.stages [data-stage="${id}"]`);
    li.classList.add('run');
    await new Promise((r) => setTimeout(r, 220));
    li.classList.remove('run');
    li.classList.add('done');
    li.querySelector('em').textContent = result;
    await new Promise((r) => setTimeout(r, 90));
  }
  btn.disabled = false;
  btn.textContent = 'Run the pipeline';
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function loadIcp(icp) {
  state.icp = icp;
  $('#table-note').textContent = 'loading…';
  try {
    const res = await fetch(`data/run-${icp}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.run = await res.json();
  } catch (err) {
    state.run = null;
    $('#table-note').textContent = `Could not load data/run-${icp}.json (${err.message}). Serve over HTTP: npx serve site`;
    $('#receipt').innerHTML = '';
    $('#leads tbody').innerHTML = '';
    return;
  }
  state.threshold = state.run.meta.thresholds?.icp_fit_pass ?? 0.5;
  $('#thr').value = String(state.threshold);
  $('#thr-out').textContent = state.threshold.toFixed(2);
  state.tier = 'all';
  $$('#tier-filter button').forEach((b) => b.classList.toggle('on', b.dataset.tier === 'all'));

  renderFilters();
  renderHero(state.run.receipt);
  refresh();
  renderWriteback(state.run.leads[0]);
  run();
}

async function boot() {
  await loadIcp('mid-market');

  $('#thr').addEventListener('input', (e) => {
    state.threshold = Number(e.target.value);
    $('#thr-out').textContent = state.threshold.toFixed(2);
    if (state.run) refresh();
  });
  $$('#tier-filter button').forEach((b) => b.addEventListener('click', () => {
    $$('#tier-filter button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    state.tier = b.dataset.tier;
    if (state.run) renderTable(tally(state.run.leads));
  }));
  $$('#icp-switch button').forEach((b) => b.addEventListener('click', () => {
    $$('#icp-switch button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    loadIcp(b.dataset.icp);
  }));
  $('#run').addEventListener('click', () => state.run && run());
  $$('[data-scroll]').forEach((b) => b.addEventListener('click', () =>
    $(b.dataset.scroll).scrollIntoView({ behavior: 'smooth' })));
}

boot();
