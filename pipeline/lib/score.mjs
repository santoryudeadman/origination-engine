// Deterministic scoring and gating. No model in this file on purpose: the same lead
// always produces the same verdict, so a run is reproducible and a drop has a reason.
//
// Operates on a NORMALIZED lead:
//   { company, domain, fit, signal: { kind, date } | null, verify, ... }
// Normalization lives in run.mjs so the source (provider run, research, live API)
// never leaks into the scoring rules.

const DAY = 86_400_000;

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / DAY);
}

/** Fit against the ICP, 0..1. Null means "we cannot judge this row" — which is a drop. */
export function fit(lead) {
  const v = Number(lead.fit);
  return Number.isFinite(v) ? v : null;
}

/**
 * Timing. One signal, openable and dated, or nothing.
 * "No source link, no signal. No 'why now', no outreach."
 */
export function timing(lead, referenceDate, freshDays) {
  const s = lead.signal;
  if (!s || !s.date) return { has_signal: false, fresh: false, age_days: null, signal: null };
  const age = daysBetween(s.date, referenceDate);
  return { has_signal: true, fresh: age >= 0 && age <= freshDays, age_days: age, signal: s };
}

/** Run the free gates in order. Returns the failed gate so the drop has one reason. */
export function gate(lead, rules) {
  const failed = [];
  const f = fit(lead);

  if (!lead.domain) failed.push('has_domain');
  if (f === null || f < rules.thresholds.icp_fit_pass) failed.push('icp_fit');

  const set = new Set(failed);
  const reason = rules.gates.find((g) => set.has(g.id) && g.on_fail === 'drop');
  return {
    pass: failed.length === 0,
    failed: set,
    reason: reason ? reason.reason : (failed.length ? 'failed a before_paid gate' : null),
  };
}

export function tier(lead, rules, referenceDate) {
  const f = fit(lead);
  if (f === null) return 'C';
  const t = rules.tiers;
  const fresh = timing(lead, referenceDate, t.A.requires_fresh_signal_days).fresh;
  // A: both the fit and the reason to write now. B: one of the two. C: keep warm.
  if (f >= t.A.min_fit && fresh) return 'A';
  if (f >= t.B.min_fit || fresh) return 'B';
  return 'C';
}

/** Only a verified-deliverable address may enter a sequence. */
export function deliverable(lead) {
  return lead.verify === 'valid';
}
