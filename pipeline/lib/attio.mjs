// Attio — the CRM as the database. Writeback is the product.
// Records are upserted on their unique attribute, so a re-run updates instead of duplicating.
//
// Ordering that matters: company FIRST, then person (a record-reference cannot
// create its target). Reference writes are reverse-order by construction.

const BASE = process.env.ATTIO_BASE || 'https://api.attio.com';

export class Attio {
  /**
   * @param {{token?: string, dryRun?: boolean, log?: (line: string) => void}} opts
   *   dryRun (default true) prints the exact request it would send and returns a
   *   synthetic id. Nothing is written until you pass dryRun:false.
   */
  constructor({ token = process.env.ATTIO_TOKEN, dryRun = true, log = () => {} } = {}) {
    this.token = token;
    this.dryRun = dryRun;
    this.log = log;
    this.written = { companies: 0, people: 0, list_entries: 0 };
    this.requests = [];
  }

  async #send(method, path, body) {
    const url = `${BASE}${path}`;
    this.requests.push({ method, path, body });

    if (this.dryRun) {
      this.log(`${method} ${path}`);
      return { data: { id: { record_id: `dryrun_${this.requests.length}`, list_id: `dryrun_list` } } };
    }
    if (!this.token) throw new Error('ATTIO_TOKEN is not set — see .env.example');

    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`attio ${method} ${path} → HTTP ${res.status} ${json?.code ?? ''}`.trim());
      err.detail = json;
      throw err;
    }
    return json;
  }

  /** Upsert on the domain key. Multi-select `domains` is additive: existing values stay. */
  async upsertCompany({ domain, name, description }) {
    const values = { domains: [{ domain }], name: [{ value: name }] };
    if (description) values.description = [{ value: description }];
    const res = await this.#send('PUT', '/v2/objects/companies/records?matching_attribute=domains', { data: { values } });
    this.written.companies += 1;
    return res.data.id.record_id;
  }

  /** Upsert on the email key, linking upward to the company we just wrote. */
  async upsertPerson({ email, firstName, lastName, fullName, title, companyDomain }) {
    const values = {
      email_addresses: [{ email_address: email }],
      name: [{ first_name: firstName || null, last_name: lastName || null, full_name: fullName || null }],
    };
    if (title) values.job_title = [{ value: title }];
    if (companyDomain) {
      values.company = [{ domains: [{ domain: companyDomain }], target_object: 'companies' }];
    }
    const res = await this.#send('PUT', '/v2/objects/people/records?matching_attribute=email_addresses', { data: { values } });
    this.written.people += 1;
    return res.data.id.record_id;
  }

  /** The working set. May 403 billing_error on plans without list access. */
  async createList({ name, apiSlug, parentObject = 'companies', workspaceAccess = 'full-access' }) {
    const res = await this.#send('POST', '/v2/lists', {
      data: { name, api_slug: apiSlug, parent_object: parentObject, workspace_access: workspaceAccess, workspace_member_access: [] },
    });
    return res.data.id.list_id;
  }

  /** Attribution rides on the entry: a row without its source does not enter a sequence. */
  async addToList({ listId, recordId, parentObject = 'companies' }) {
    await this.#send('POST', `/v2/lists/${listId}/entries`, {
      data: { parent_record_id: recordId, parent_object: parentObject, entry_values: {} },
    });
    this.written.list_entries += 1;
  }

  receipt() {
    return { dry_run: this.dryRun, written: this.written, requests: this.requests.length };
  }
}
