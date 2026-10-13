// Origination Engine — console. Replays the recorded run in the browser.
// The threshold slider re-runs the *free* gates client-side; nothing here fabricates data.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const FRESH_DAYS = 90;
const TIER_A_FIT = 0.6;

const state = { run: null, threshold: 0.5, tier: 'all' };

/** Re-apply the free gates at the current threshold. Pure function of the recorded row. */
function judge(lead) {
  const pass = Boolean(lead.domain) && lead.fit != null && lead.fit >= state.threshold;
  const fresh = lead.signal_age_days != null && lead.signal_age_days >= 0 && lead.signal_age_days <= FRESH_DAYS;
  let tier = null;
  if (pass) tier = lead.fit >= TIER_A_FIT && fresh ? 'A' : (lead.fit >= TIER_A_FIT || fresh ? 'B' : 'C');
  return { pass, tier, fresh };
}

function tally(leads) {
  const rows = leads.map((l) => ({ ...l, ...judge(l) }));
  const passed = rows.filter((r) => r.pass);
  const deliverable = passed.filter((r) => r.verify === 'valid');
  return {
    rows,
    passed: passed.length,
    dropped: rows.length - passed.length,
    named: passed.filter((r) => r.person_found).length,
    emails: passed.filter((r) => r.email_provider).length,
    deliverable: deliverable.length,
    tiers: ['A', 'B', 'C'].reduce((a, t) => ({ ...a, [t]: passed.filter((r) => r.tier === t).length }), {}),
  };
}

// ── render ───────────────────────────────────────────────────────────────────

const money = (n) => `$${n.toFixed(4)}`;

function cell(k, v, cls = '') {
  return `<div class="cell"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
}

function renderReceipt(t, recordedSpend) {
  const per = t.deliverable ? recordedSpend / t.deliverable : null;
  $('#receipt').innerHTML = [
    cell('passed the gates', `${t.passed}<span class="sub2"> / ${t.rows.length}</span>`, 'good'),
    cell('never bought', String(t.dropped), 'bad'),
    cell('verified emails', String(t.deliverable), 'good'),
    cell('emails found', String(t.emails), 'mut'),
    cell('$/deliverable', per ? money(per) : '—', 'mut'),
    cell('recorded spend', `$${recordedSpend.toFixed(2)}`, 'mut'),
    cell('tiers', `A ${t.tiers.A} · B ${t.tiers.B} · C ${t.tiers.C}`, 'mut'),
  ].join('');
}

function renderTable(t) {
  const shown = t.rows
    .filter((r) => (state.tier === 'all' ? true : state.tier === 'drop' ? !r.pass : r.pass && r.tier === state.tier))
    .sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0));

  $('table.leads tbody').innerHTML = shown.map((r) => {
    const verify = r.verify
      ? `<span class="pill ${r.verify === 'valid' ? 'verified' : r.verify === 'unknown' ? 'unknown' : ''}">${r.verify}</span>`
      : `<span class="pill none">—</span>`;
    const email = r.email_provider ? `<span class="pill">${r.email_provider}</span>` : `<span class="pill none">—</span>`;
    const tier = r.pass && r.tier ? `<span class="pill ${r.tier}">${r.tier}</span>` : `<span class="pill none">—</span>`;
    return `<tr class="${r.pass ? '' : 'drop'}">
      <td>${r.company}</td>
      <td>${r.domain || '—'}</td>
      <td class="num">${(r.fit ?? 0).toFixed(2)}</td>
      <td><span class="pill ${r.pass ? 'pass' : 'drop'}">${r.pass ? 'pass' : 'drop'}</span></td>
      <td>${tier}</td>
      <td>${r.signal || '—'}</td>
      <td>${email}</td>
      <td>${verify}</td>
    </tr>`;
  }).join('');

  $('#table-note').textContent =
    `showing ${shown.length} of ${t.rows.length} rows` +
    (state.tier === 'drop' ? ' · dropped on a free gate — never enriched, never billed' : '') +
    (r0(t) );
}

function r0(t) {
  const d = t.rows.find((r) => !r.pass);
  return d ? ` · e.g. ${d.company}: ${d.drop_reason || 'no domain'}` : '';
}

function refresh() {
  const t = tally(state.run.leads);
  const recordedSpend = state.run.receipt.spend_usd;
  renderReceipt(t, recordedSpend);
  renderTable(t);
  $('#thr-hint').textContent =
    `at ${state.threshold.toFixed(2)} → ${t.passed} of ${t.rows.length} pass, ${t.dropped} dropped before any paid lookup`;
}

function fillHero(r) {
  $('#hero-stats').innerHTML = [
    `<li><b>${r.passed}/${r.with_domain}</b><span>passed the free gates</span></li>`,
    `<li><b>${r.deliverable}</b><span>verified emails</span></li>`,
    `<li><b>$${r.cost_per_deliverable_usd.toFixed(2)}</b><span>per deliverable lead</span></li>`,
    `<li><b>${r.dropped_before_paying}</b><span>contacts never bought</span></li>`,
  ].join('');
}

function renderWriteback(lead) {
  const company = {
    data: { values: {
      domains: [{ domain: lead.domain }],
      name: [{ value: lead.company }],
      description: [{ value: `B2B software · fit ${lead.fit}` }],
    } },
  };
  const person = {
    data: { values: {
      // person fields come from treg.people.search, the address from treg.people.email.find
      email_addresses: [{ email_address: '<from treg.people.email.find>' }],
      name: [{ first_name: '<from', last_name: 'treg.people.search>' }],
      job_title: [{ value: '<from treg.people.search>' }],
      company: [{ domains: [{ domain: lead.domain }], target_object: 'companies' }],
    } },
  };
  $('#wm-company').innerHTML = hl(JSON.stringify(company, null, 2));
  $('#wm-person').innerHTML = hl(JSON.stringify(person, null, 2));
}

const hl = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
  .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>');

// ── the run animation ────────────────────────────────────────────────────────

async function run() {
  const btn = $('#run');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Running…';

  const t = tally(state.run.leads);
  const steps = [
    ['source', `${t.rows.length} rows`],
    ['qualify', `${t.passed} pass / ${t.dropped} drop`],
    ['people', `${t.named} named`],
    ['email', `${t.emails} found`],
    ['write', `${t.deliverable} upserted`],
  ];

  for (const li of $$('.stages li')) { li.classList.remove('done', 'run'); li.querySelector('em').textContent = '—'; }

  for (const [id, result] of steps) {
    const li = $(`.stages [data-stage="${id}"]`);
    li.classList.add('run');
    await new Promise((r) => setTimeout(r, 240));
    li.classList.remove('run');
    li.classList.add('done');
    li.querySelector('em').textContent = result;
    await new Promise((r) => setTimeout(r, 110));
  }

  btn.disabled = false;
  btn.textContent = 'Run the pipeline';
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const res = await fetch('data/run.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.run = await res.json();
  } catch (err) {
    $('#table-note').textContent = `Could not load data/run.json (${err.message}). Serve the folder over HTTP: npx serve site`;
    return;
  }

  fillHero(state.run.receipt);
  refresh();
  renderWriteback(state.run.leads[0]);

  $('#thr').addEventListener('input', (e) => {
    state.threshold = Number(e.target.value);
    $('#thr-out').textContent = state.threshold.toFixed(2);
    refresh();
  });
  $$('#tier-filter button').forEach((b) => b.addEventListener('click', () => {
    $$('#tier-filter button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    state.tier = b.dataset.tier;
    renderTable(tally(state.run.leads));
  }));
  $('#run').addEventListener('click', run);
  $$('[data-scroll]').forEach((b) => b.addEventListener('click', () =>
    $(b.dataset.scroll).scrollIntoView({ behavior: 'smooth' })));

  run();
}

boot();
