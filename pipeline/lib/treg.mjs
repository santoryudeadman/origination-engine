// treg.to — one base URL, one token, 111 providers behind routed tools.
// Every call is metered: we account for it per call and stop at the run cap.

const BASE = process.env.TREG_BASE || 'https://treg.to';

export class SpendCapExceeded extends Error {}

export class Treg {
  constructor({ token = process.env.TREG_TOKEN, capPerRunUsd = 5, maxCostPerCallUsd = 1 } = {}) {
    this.token = token;
    this.capUsd = capPerRunUsd;
    this.maxCostPerCallUsd = maxCostPerCallUsd;
    this.spentMicro = 0;
    this.log = []; // the receipt
  }

  get spentUsd() { return this.spentMicro / 1e6; }
  get remainingUsd() { return Math.max(0, this.capUsd - this.spentUsd); }

  /**
   * POST /call/<endpoint>. Routed endpoints (treg.*) waterfall across providers,
   * cheapest-per-hit first, and answer { output, raw, _treg }.
   */
  async call(endpoint, body, { verify = false, headers = {} } = {}) {
    if (!this.token) throw new Error('TREG_TOKEN is not set — see .env.example');
    if (this.remainingUsd <= 0) {
      throw new SpendCapExceeded(`run cap $${this.capUsd} reached at $${this.spentUsd.toFixed(4)}`);
    }

    const h = {
      'X-Treg-Token': this.token,
      'Content-Type': 'application/json',
      // Hard ceiling for this call. Refusal is a 402 and nothing is charged.
      'X-Treg-Route-Max-Cost': String(Math.min(this.maxCostPerCallUsd, this.remainingUsd)),
      ...headers,
    };
    if (verify) h['X-Treg-Route-Verify'] = 'true';

    const res = await fetch(`${BASE}/call/${endpoint}`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(body),
    });

    // Settled cost is the header, never the body. A failure is charged nothing.
    const costMicro = Number(res.headers.get('x-treg-cost-micro') || 0);
    const callId = res.headers.get('x-treg-call-id') || null;
    const servedBy = res.headers.get('x-treg-served-by') || null;
    this.spentMicro += costMicro;
    this.log.push({ endpoint, call_id: callId, served_by: servedBy, cost_micro: costMicro, status: res.status });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { output: null, raw: text }; }

    if (!res.ok) {
      const err = new Error(`treg ${endpoint} → HTTP ${res.status}`);
      err.detail = json?.detail ?? json;
      err.call_id = callId;
      throw err;
    }
    return json;
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
    for (const c of this.log) {
      const k = byEndpoint[c.endpoint] || (byEndpoint[c.endpoint] = { calls: 0, cost_micro: 0 });
      k.calls += 1;
      k.cost_micro += c.cost_micro;
    }
    return {
      calls: this.log.length,
      spend_micro: this.spentMicro,
      spend_usd: Number(this.spentUsd.toFixed(4)),
      cap_usd: this.capUsd,
      by_endpoint: byEndpoint,
      calls_log: this.log,
    };
  }
}
