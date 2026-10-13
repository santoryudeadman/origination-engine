// Deterministic scoring and gating. No model in this file on purpose: the same row
// always produces the same verdict, so a run is reproducible and a drop has a reason.

const DAY = 86_400_000;

/** Pull the ISO date out of a signal string like "acquires (2026-07-15)". */
export function signalDate(row) {
  const m = /\((\d{4}-\d{2}-\d{2})\)/.exec(row.latest_news || '');
  return m ? m[1] : null;
}

export function signalOf(row) {
  const date = signalDate(row);
  const kind = (row.latest_news || '').split(' (')[0].trim();
  return date ? { kind, date } : null;
}

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / DAY);
}

/**
 * Fit against the ICP. In a real run this value comes from the ICP check
 * (`jev` on the team's own key). Replay carries the real observed value.
 */
export function fit(row) {
  const v = Number(row.jev_fit);
  return Number.isFinite(v) ? v : null;
}

/**
 * Timing. One signal, openable and dated, or nothing.
 * "No source link, no signal. No 'why now', no outreach."
 */
export function timing(row, referenceDate, freshDays) {
  const s = signalOf(row);
  if (!s) return { has_signal: false, fresh: false, age_days: null, signal: null };
  const age = daysBetween(s.date, referenceDate);
  return { has_signal: true, fresh: age >= 0 && age <= freshDays, age_days: age, signal: s };
}

/** Run the *free* gates in order. Returns the first failure so the drop has one reason. */
export function gate(row, rules) {
  const failures = [];
  const f = fit(row);

  if (!row.domain) failures.push('has_domain');
  if (f === null) failures.push('icp_fit');
  else if (f < rules.thresholds.icp_fit_pass) failures.push('icp_fit');

  const failed = new Set(failures);
  const reason = rules.gates.find((g) => failed.has(g.id) && g.on_fail === 'drop');
  return {
    pass: failures.length === 0,
    failed,
    reason: reason ? reason.reason : (failures.length ? 'failed a before_paid gate' : null),
  };
}

export function tier(row, rules, referenceDate) {
  const f = fit(row);
  if (f === null) return 'C';
  const t = rules.tiers;
  const fresh = timing(row, referenceDate, t.A.requires_fresh_signal_days).fresh;
  // A: both the fit and the reason to write now. B: one of the two. C: keep warm.
  if (f >= t.A.min_fit && fresh) return 'A';
  if (f >= t.B.min_fit || fresh) return 'B';
  return 'C';
}

/** Verified-deliverable is the only thing that may enter a sequence. */
export function deliverable(row) {
  return row.verify === 'valid';
}
