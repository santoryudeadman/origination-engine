// Salesforce — REST API, upsert by external id.
//
// Salesforce is the one CRM here that cannot upsert on a standard field: `PATCH
// /sobjects/{SObject}/{ExternalIdField}/{value}` only accepts a **custom** field flagged
// **External ID**. `Website` and `Email` cannot be marked External ID. Add **Unique** as well —
// without it the integration user needs the org-wide **View All Data** permission.
//
// `supportsLists` is false on purpose. Salesforce has no "list" — it has Campaigns, and a
// CampaignMember needs a resolved ContactId plus its own custom External ID field to be upserted
// at all. Creating a non-idempotent junction row on every run is worse than skipping it.
//
// There is also no client-supplied idempotency key anywhere in the Salesforce API: a retry is
// only safe because the external id is in the URL.

import { createClient } from './client.mjs';

const API_VERSION = process.env.SALESFORCE_API_VERSION || 'v62.0';

export function salesforce({
  token = process.env.SALESFORCE_TOKEN,
  instanceUrl = process.env.SALESFORCE_INSTANCE_URL,
  externalIdField = process.env.SALESFORCE_EXTERNAL_ID_FIELD || 'External_Id__c',
  dryRun = true,
  log = () => {},
} = {}) {
  if (!dryRun && !instanceUrl) throw new Error('salesforce: SALESFORCE_INSTANCE_URL is not set — see .env.example');

  const c = createClient({
    vendor: 'salesforce',
    baseUrl: instanceUrl || 'https://example.my.salesforce.com',
    token, dryRun, log,
  });

  const api = `/services/data/${API_VERSION}`;
  const ref = (v) => encodeURIComponent(v);

  return {
    name: 'salesforce',
    supportsLists: false,
    external_id_field: externalIdField,

    async upsertCompany({ domain, name, description }) {
      const body = { Name: name, Website: `https://${domain}` };
      if (description) body.Description = description;
      // 201 = created, 200 + created:false = updated (v46+; v45 and earlier returned 204).
      // 300 means the external id matched more than one record and NOTHING was written.
      await c.send('PATCH', `${api}/sobjects/Account/${externalIdField}/${ref(domain)}`, body);
      c.written.companies += 1;
      return domain; // the external id IS the handle we reference from the contact
    },

    async upsertPerson({ email, firstName, lastName, fullName, title, companyDomain }) {
      const body = {
        Email: email,
        // LastName is the only required field on Contact. Never send a null.
        LastName: lastName || (fullName ? fullName.split(' ').slice(-1)[0] : email.split('@')[0]),
      };
      if (firstName) body.FirstName = firstName;
      if (title) body.Title = title;
      // Link by relationship-by-external-id: no lookup, no stored id, no race.
      if (companyDomain) body.Account = { [externalIdField]: companyDomain };

      await c.send('PATCH', `${api}/sobjects/Contact/${externalIdField}/${ref(email)}`, body);
      c.written.people += 1;
      return email;
    },

    async ensureList() {
      return null; // Campaigns, not lists — see the header comment and README
    },

    async addToList() {
      return null;
    },

    receipt: c.receipt,
    requests: c.requests,
  };
}
