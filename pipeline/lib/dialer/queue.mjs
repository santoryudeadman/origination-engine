// The dialer queue.
//
// Read this first: **none of Lemlist, EmailBison, or TitanX provides these primitives**, and
// Nooks only covers the disposition half. Whatever dialer you run — Nooks, Orum, a Five9
// bridge — the simultaneous-dial budget, the retry policy, the calling windows and the DNC
// check are yours to own. TitanX in particular is a phone-intent *scoring* API: it predicts
// who will answer and finds numbers. It is not a dialer and has no call surface at all.
//
// The telephony transport is injected (`dial`), so the queue and every guardrail around it can
// be tested without a phone system.

import { mapPool } from '../pool.mjs';

/**
 * Terminal dispositions end the contact. Retryable ones come back after a delay.
 * `delayHours` is per-disposition on purpose: a busy signal and a voicemail are not the
 * same event and should not share a backoff.
 */
export const DISPOSITIONS = {
  connected:  { terminal: true,  retry: false },
  bad_number: { terminal: true,  retry: false },
  dnc:        { terminal: true,  retry: false },
  voicemail:  { terminal: false, retry: true, delayHours: 24 },
  no_answer:  { terminal: false, retry: true, delayHours: 4 },
  busy:       { terminal: false, retry: true, delayHours: 1 },
  failed:     { terminal: false, retry: true, delayHours: 2 }, // transport error, nothing said
};

export const isTerminal = (d) => DISPOSITIONS[d]?.terminal ?? false;
export const isRetryable = (d) => DISPOSITIONS[d]?.retry ?? false;

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local wall-clock hour and weekday for an IANA zone. No dependency; Intl carries the tz data. */
export function localTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(date);
  const o = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { hour: Number(o.hour) % 24, day: DAY_INDEX[o.weekday] };
}

/**
 * Calling windows are local-time and per-contact. No vendor API enforces this, which is
 * exactly why it has to live in the scheduler.
 */
export function isWithinWindow(date, timeZone, win) {
  const { hour, day } = localTime(date, timeZone);
  return win.days.includes(day) && hour >= win.start && hour < win.end;
}

export const DEFAULT_WINDOW = { start: 8, end: 18, days: [1, 2, 3, 4, 5] };

/**
 * Split a list into what may be dialled now and what may not, with a reason for each deferral.
 * A dialer that cannot say WHY it skipped someone is a dialer nobody trusts.
 */
export function plan(contacts, {
  now = new Date(),
  timeZone = 'America/New_York',
  window = DEFAULT_WINDOW,
  maxAttemptsPerDay = 3,
  attemptsToday = () => 0,
  dnc = new Set(),
  maxAttempts = 6,
  attemptsTotal = () => 0,
} = {}) {
  const dialable = [];
  const deferred = [];

  for (const c of contacts) {
    const zone = c.time_zone || timeZone;
    if (dnc.has(c.email) || c.do_not_contact) { deferred.push({ contact: c, reason: 'dnc' }); continue; }
    if (attemptsTotal(c) >= maxAttempts) { deferred.push({ contact: c, reason: 'attempt-cap-total' }); continue; }
    if (attemptsToday(c) >= maxAttemptsPerDay) { deferred.push({ contact: c, reason: 'attempt-cap-today' }); continue; }
    if (!isWithinWindow(now, zone, window)) { deferred.push({ contact: c, reason: 'outside-window' }); continue; }
    dialable.push(c);
  }
  return { dialable, deferred };
}

/** When a retryable disposition may be attempted again. */
export function nextRetry(disposition, now = new Date()) {
  const d = DISPOSITIONS[disposition];
  if (!d?.retry) return null;
  return new Date(now.getTime() + d.delayHours * 3_600_000);
}

/**
 * Dial the dialable, `concurrency` lines at a time.
 *
 * `dial(contact)` is the transport and returns a disposition string. It is injected because
 * telephony is the one part of this we cannot test here — and because swapping dialers should
 * not mean rewriting the queue.
 */
export async function runQueue(contacts, {
  dial,
  concurrency = 5,
  now = new Date(),
  log = () => {},
  ...planOpts
} = {}) {
  if (typeof dial !== 'function') throw new Error('runQueue: a dial(contact) transport is required');

  const { dialable, deferred } = plan(contacts, { now, ...planOpts });
  log(`dialer   ${dialable.length} dialable, ${deferred.length} deferred, ${concurrency} lines`);

  const results = await mapPool(dialable, concurrency, async (contact) => {
    let disposition;
    try {
      disposition = await dial(contact);
    } catch (err) {
      disposition = 'failed'; // a transport error is never an answer
    }
    if (!DISPOSITIONS[disposition]) disposition = 'failed';
    return { contact, disposition, retryAt: nextRetry(disposition, now) };
  });

  const byDisposition = {};
  for (const r of results) byDisposition[r.disposition] = (byDisposition[r.disposition] ?? 0) + 1;

  const byReason = {};
  for (const d of deferred) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;

  return { results, deferred, byDisposition, byReason };
}
