// Attio — the CRM as the database.
// Upserts matched on the unique attribute, so a re-run updates instead of duplicating.
//
// Ordering that matters: company FIRST, then person. A record-reference cannot create its
// target, so referencing a company that does not exist fails the write.

import { createClient } from './client.mjs';

export function attio({ token = process.env.ATTIO_TOKEN, dryRun = true, log = () => {} } = {}) {
  const c = createClient({
    vendor: 'attio',
    baseUrl: process.env.ATTIO_BASE || 'https://api.attio.com',
    token, dryRun, log,
  });

  return {
    name: 'attio',

    /** Upsert on the domain key. Multi-select `domains` is additive: existing values stay. */
    async upsertCompany({ domain, name, description }) {
      if (!domain) throw new Error('attio: upsertCompany requires a domain — it is the unique key');
      const values = { domains: [{ domain }], name: [{ value: name }] };
      if (description) values.description = [{ value: description }];
      const { dryrun, json } = await c.send(
        'PUT', '/v2/objects/companies/records?matching_attribute=domains', { data: { values } },
      );
      c.written.companies += 1;
      return dryrun ? c.syntheticId() : json.data.id.record_id;
    },

    /** Upsert on the email key, linking upward to the company written just before. */
    async upsertPerson({ email, firstName, lastName, fullName, title, companyDomain }) {
      if (!email) throw new Error('attio: upsertPerson requires an email — it is the unique key');
      const values = {
        email_addresses: [{ email_address: email }],
        name: [{ first_name: firstName || null, last_name: lastName || null, full_name: fullName || null }],
      };
      if (title) values.job_title = [{ value: title }];
      if (companyDomain) values.company = [{ domains: [{ domain: companyDomain }], target_object: 'companies' }];
      const { dryrun, json } = await c.send(
        'PUT', '/v2/objects/people/records?matching_attribute=email_addresses', { data: { values } },
      );
      c.written.people += 1;
      return dryrun ? c.syntheticId() : json.data.id.record_id;
    },

    /** The working set. May 403 billing_error on plans without list access. */
    async ensureList({ name, slug, parentObject = 'companies' }) {
      const { dryrun, json } = await c.send('POST', '/v2/lists', {
        data: {
          name,
          api_slug: slug,
          parent_object: parentObject,
          workspace_access: 'full-access',
          workspace_member_access: [],
        },
      });
      return dryrun ? c.syntheticId() : json.data.id.list_id;
    },

    /** Attribution rides on the entry: a row without its source does not enter a sequence. */
    async addToList({ listId, recordId, parentObject = 'companies', entryValues = {} }) {
      await c.send('POST', `/v2/lists/${listId}/entries`, {
        data: { parent_record_id: recordId, parent_object: parentObject, entry_values: entryValues },
      });
      c.written.list_entries += 1;
    },

    receipt: c.receipt,
    requests: c.requests,
  };
}
