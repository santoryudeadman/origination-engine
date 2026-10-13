// treg.to — one base URL, one token, 111 providers behind routed tools.
//
// Every call is metered, so this client is built around three invariants:
//   1. Never spend past the rail.      — reserve before, settle after
//   2. Never pay twice for one answer. — one Idempotency-Key per logical call, reused on retry
//   3. Never retry a mistake.          — 4xx is your bug; 429/5xx is weather
//
// `fetchImpl` and `sleep` are injectable so the retry state machine is testable offline.

const BASE = process.env.TREG_BASE || 'https://treg.to';

export class SpendCapExceeded extends Error {}
export class TregError extends Error {}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newKey() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return (uuid ? uuid.replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).slice(0, 24);
}

/**
 * Which failures are worth another attempt.
 * A 4xx means our parameters are wrong — retrying burns money across providers for one mistake.
 */
function classify(status, json) {
  if (status === 402) return 'fail'; // route_max_cost — budget refusal, nothing was charged
  if (status === 410) return 'fail'; // original completed and was charged; the same key cannot help
  if (json?.detail?.error === 'response_buffer_limit') return 'fail'; // oversized now, oversized later
  if (status === 429 || status === 409) return 'retry'; // share_busy, or an idempotent call still running
  if (status >= 500) return 'retry'; // includes 503 treg_saturated
  if (status >= 400) return 'fail';
  return 'fail';
}

function retryAfterSeconds(res, json) {
  const header = Number(res.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return header;
  const body = Number(json?.detail?.retry_after_s ?? json?.retry_after_s);
  return Number.isFinite(body) && body > 0 ? body : null;
}

export class Treg {
  constructor({
    token = process.env.TREG_TOKEN,
    capPerRunUsd = 5,
    maxCostPerCallUsd = 1,
    budget = null,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    maxRetries = 3,
    backoffBaseMs = 500,
    maxBackoffMs = 15_000,
  } = {}) {
    this.token = token;
    this.capUsd = capPerRunUsd;
    this.maxCostPerCallUsd = maxCostPerCallUsd;
    this.budget = budget; // optional daily ledger; see lib/budget.mjs
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.backoffBaseMs = backoffBaseMs;
    this.maxBackoffMs = maxBackoffMs;
    this.spentMicro = 0;
    this.log = []; // the receipt
  }

  get spentUsd() { return this.spentMicro / 1e6; }
  get remainingUsd() { return Math.max(0, this.capUsd - this.spentUsd); }

  #backoff(attempt, retryAfterS) {
    if (retryAfterS != null) return retryAfterS * 1000; // the provider told us when to come back
    const base = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.maxBackoffMs);
    return base + Math.random() * this.backoffBaseMs; // jitter, so parallel workers do not sync up
  }

  /**
   * POST /call/<endpoint>. Routed endpoints (treg.*) waterfall across providers,
   * cheapest-per-hit first, and answer { output, raw, _treg }.
   *
   * @param {string} endpoint
   * @param {object} body
   * @param {{verify?: boolean, headers?: Record<string,string>, idempotencyKey?: string}} [opts]
   */
  async call(endpoint, body, { verify = false, headers = {}, idempotencyKey } = {}) {
    if (!this.token) throw new Error('TREG_TOKEN is not set — see .env.example');
    if (this.remainingUsd <= 0) {
      throw new SpendCapExceeded(`run cap $${this.capUsd} reached at $${this.spentUsd.toFixed(4)}`);
    }

    const callCeilingUsd = Math.min(this.maxCostPerCallUsd, this.remainingUsd);
    const reservedMicro = Math.round(callCeilingUsd * 1e6);

    if (this.budget && !this.budget.reserve(reservedMicro)) {
      const s = this.budget.snapshot();
      throw new SpendCapExceeded(
        `daily budget reached: $${(s.spent_micro / 1e6).toFixed(4)} of $${(s.cap_micro / 1e6).toFixed(2)} on ${s.day}. `
        + 'Raise rules.spend.cap_per_day_usd (or ORIGINATION_CAP_PER_DAY_USD) deliberately.',
      );
    }

    const baseHeaders = {
      'X-Treg-Token': this.token,
      'Content-Type': 'application/json',
      // Hard ceiling for this call. Refusal is a 402 and nothing is charged.
      'X-Treg-Route-Max-Cost': String(callCeilingUsd),
      ...headers,
    };
    if (verify) baseHeaders['X-Treg-Route-Verify'] = 'true';

    // ONE key per logical call. Every retry sends the same key, so a call that reached the
    // provider is replayed from storage instead of being charged again.
    const key = idempotencyKey ?? newKey();

    let attempt = 0;
    let costMicro = 0;

    try {
      for (;;) {
        attempt += 1;

        let res;
        try {
          res = await this.fetchImpl(`${BASE}/call/${endpoint}`, {
            method: 'POST',
            headers: { ...baseHeaders, 'Idempotency-Key': key },
            body: JSON.stringify(body),
          });
        } catch (err) {
          // A network error is never billed, and the same key makes the retry safe.
          if (attempt > this.maxRetries) { err.attempts = attempt; throw err; }
          await this.sleep(this.#backoff(attempt, null));
          continue;
        }

        const callId = res.headers?.get?.('x-treg-call-id') || null;
        const servedBy = res.headers?.get?.('x-treg-served-by') || null;
        const attemptCost = Number(res.headers?.get?.('x-treg-cost-micro') || 0);

        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = { output: null, raw: text }; }

        if (res.ok) {
          // A replay reports 0, so summing attempt costs never counts a call twice.
          costMicro = attemptCost;
          this.spentMicro += costMicro;
          this.log.push({ endpoint, call_id: callId, served_by: servedBy, cost_micro: costMicro, attempts: attempt, status: res.status });
          return json;
        }

        const verdict = classify(res.status, json);
        if (verdict !== 'retry' || attempt > this.maxRetries) {
          const err = new TregError(
            `treg ${endpoint} → HTTP ${res.status}${json?.detail?.error ? ` (${json.detail.error})` : ''}`
            + (attempt > 1 ? ` after ${attempt} attempts` : ''),
          );
          err.status = res.status;
          err.detail = json?.detail ?? json;
          err.call_id = callId;
          err.attempts = attempt;
          err.idempotency_key = key;
          this.log.push({ endpoint, call_id: callId, served_by: servedBy, cost_micro: 0, attempts: attempt, status: res.status, failed: true });
          throw err;
        }

        await this.sleep(this.#backoff(attempt, retryAfterSeconds(res, json)));
      }
    } finally {
      // Always settle, even on failure: a failed call is charged nothing, so the reservation
      // returns in full.
      this.budget?.settle(reservedMicro, costMicro);
    }
  }

  // --- the four steps of the motion -----------------------------------------

  /** Step 1 — companies from the ICP. */
  companiesSearch({ q, industry, country, limit = 25 }) {
    return this.call('treg.companies.search', { q, industry, country, limit });
  }

  /** Lookalikes of an account that already works. */
  companiesSimilar(domain) {
    return this.call('treg.companies.similar', { domain });
  }

  /** The one cheap enrich that runs when a row lacks the fields to judge. */
  companiesEnrich(domain) {
    return this.call('treg.companies.enrich', { domain });
  }

  /** Step 2 — people by function, not "decision makers". */
  peopleSearch({ companyDomain, title, country, limit = 10 }) {
    return this.call('treg.people.search', { company_domain: companyDomain, title, country, limit });
  }

  /** Step 3 — work email, with the verify folded into the same call. */
  emailFind({ fullName, firstName, lastName, domain, linkedinUrl }) {
    const body = linkedinUrl
      ? { linkedin_url: linkedinUrl }
      : { full_name: fullName, first_name: firstName, last_name: lastName, domain };
    return this.call('treg.people.email.find', body, {
      verify: true,
      headers: { 'X-Treg-Route-Strict-Filters': '1' },
    });
  }

  /** Step 4 — verify on its own, when the finder would not. */
  emailVerify(email) {
    return this.call('treg.people.email.verify', { email });
  }

  receipt() {
    const byEndpoint = {};
    let retries = 0;
    let failures = 0;
    for (const c of this.log) {
      const k = byEndpoint[c.endpoint] || (byEndpoint[c.endpoint] = { calls: 0, cost_micro: 0 });
      k.calls += 1;
      k.cost_micro += c.cost_micro;
      retries += Math.max(0, (c.attempts ?? 1) - 1);
      if (c.failed) failures += 1;
    }
    return {
      calls: this.log.length,
      retries,
      failures,
      spend_micro: this.spentMicro,
      spend_usd: Number(this.spentUsd.toFixed(4)),
      cap_usd: this.capUsd,
      by_endpoint: byEndpoint,
      calls_log: this.log,
    };
  }
}
