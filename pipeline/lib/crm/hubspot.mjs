// HubSpot — objects API v3, associations, lists.
//
// Two differences from Attio worth knowing:
//   * HubSpot has no upsert-by-key on the single-object endpoint; the batch endpoint takes an
//     `idProperty`, which is how you get idempotency here.
//   * Associations are a separate call. A contact must exist before it can be associated, so the
//     order is company → person → associate.
//
// ⚠️ `domain` is HubSpot's *suggested* dedup key but it is NOT enforced unique. Duplicate domains
// in the portal make a domain-keyed upsert fail outright. In a portal you control, add a custom
// unique property and point `idProperty` at it instead. We send `domain` because it is the only
// identifier we hold, and we surface the error rather than swallowing it.

import { createClient } from './client.mjs';

const COMPANY_OBJECT_TYPE = '0-2'; // HubSpot's object-type id for companies

export function hubspot({ token = process.env.HUBSPOT_TOKEN, dryRun = true, log = () => {} } = {}) {
  const c = createClient({
    vendor: 'hubspot',
    baseUrl: process.env.HUBSPOT_BASE || 'https://api.hubapi.com',
    token, dryRun, log,
  });

  const companyIds = new Map(); // domain → id, so the association needs no extra lookup

  return {
    name: 'hubspot',
    supportsLists: true,

    async upsertCompany({ domain, name, description }) {
      if (!domain) throw new Error('hubspot: upsertCompany requires a domain — it is the upsert key');
      const properties = { domain, name };
      if (description) properties.description = description;
      const { dryrun, json } = await c.send('POST', '/crm/v3/objects/companies/batch/upsert', {
        inputs: [{ idProperty: 'domain', id: domain, properties }],
      });
      c.written.companies += 1;
      if (dryrun) return c.syntheticId();
      const id = json?.results?.[0]?.id ?? null;
      if (id) companyIds.set(domain, id);
      return id;
    },

    async upsertPerson({ email, firstName, lastName, fullName, title, companyDomain }) {
      if (!email) throw new Error('hubspot: upsertPerson requires an email — it is the unique key');
      // HubSpot does NOT support partial upserts when idProperty is `email`, so this payload
      // must always carry the full set of properties we care about.
      const properties = { email };
      if (firstName) properties.firstname = firstName;
      if (lastName) properties.lastname = lastName;
      if (title) properties.jobtitle = title;

      const { dryrun, json } = await c.send('POST', '/crm/v3/objects/contacts/batch/upsert', {
        inputs: [{ idProperty: 'email', id: email, properties }],
      });
      c.written.people += 1;
      const contactId = dryrun ? c.syntheticId() : json?.results?.[0]?.id ?? null;

      const companyId = companyIds.get(companyDomain);
      if (!dryrun && contactId && companyId) {
        // Label-free default association. The typed v3 route needs a DIRECTION-SPECIFIC id
        // (279 = contact→company, 1 = contact→primary company) and is easy to invert; this
        // path cannot be.
        await c.send('PUT', `/crm/objects/2026-09/contacts/${contactId}/associations/default/companies/${companyId}`);
      }
      return contactId;
    },

    /** Static (MANUAL) list of companies. Available on HubSpot Free. */
    async ensureList({ name }) {
      const { dryrun, json } = await c.send('POST', '/crm/v3/lists', {
        name,
        objectTypeId: COMPANY_OBJECT_TYPE,
        processingType: 'MANUAL', // membership endpoints only work on MANUAL/SNAPSHOT lists
      });
      return dryrun ? c.syntheticId() : json?.list?.listId ?? json?.listId ?? null;
    },

    async addToList({ listId, recordId }) {
      await c.send('PUT', `/crm/v3/lists/${listId}/memberships/add`, [recordId]);
      c.written.list_entries += 1;
    },

    receipt: c.receipt,
    requests: c.requests,
  };
}
