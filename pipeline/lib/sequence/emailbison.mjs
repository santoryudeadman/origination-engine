// EmailBison — REST, Bearer auth, and a **per-instance** base URL (you self-host or use a
// dedicated node), so the host has to be configured rather than assumed.
//
// Two-step enrol, unlike Lemlist: create the lead, then attach lead ids to the campaign.
// Attaching to an ACTIVE campaign takes up to ~5 minutes to sync, so this is not a place to
// poll for a result.

import { createHttpClient } from '../http.mjs';

export function emailbison({
  token = process.env.EMAILBISON_API_KEY,
  instance = process.env.EMAILBISON_INSTANCE,
  dryRun = true,
  log = () => {},
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!dryRun && !instance) {
    throw new Error('emailbison: EMAILBISON_INSTANCE is required (e.g. https://your-node.emailbison.com) — see .env.example');
  }

  const c = createHttpClient({
    vendor: 'emailbison',
    baseUrl: `${(instance || 'https://unset.emailbison.example').replace(/\/$/, '')}/api`,
    token,
    auth: 'bearer',
    dryRun,
    log,
    fetchImpl,
  });

  const seen = new Set();

  return {
    name: 'emailbison',
    supportsBulkEnroll: true,

    async createLead({ lead }) {
      if (!lead?.email) throw new Error('emailbison: createLead requires an email');
      const name = splitName(lead);
      const body = {
        first_name: name.first,
        last_name: name.last, // required by the API, so it is never null
        email: lead.email,
        ...(lead.title ? { title: lead.title } : {}),
        ...(lead.company ? { company: lead.company } : {}),
      };
      const { dryrun, json } = await c.send('POST', '/leads', body);
      return { id: dryrun ? c.syntheticId() : json?.data?.id ?? json?.id ?? null };
    },

    /** Create, then attach. Idempotent within a batch; the API has no upsert-by-email. */
    async enroll({ campaignId, lead }) {
      if (!campaignId) throw new Error('emailbison: a campaignId is required to enroll');
      if (!lead?.email) throw new Error('emailbison: enroll requires an email — it is the lead key');

      const key = `${campaignId}:${lead.email}`;
      if (seen.has(key)) return { enrolled: false, skipped: 'duplicate-in-this-batch' };
      seen.add(key);

      const { id } = await this.createLead({ lead });
      const { dryrun } = await c.send('POST', `/campaigns/${campaignId}/leads/attach-leads`, { lead_ids: [id] });
      return { enrolled: true, leadId: id, note: dryrun ? null : 'allows ~5 min to sync on an active campaign' };
    },

    /** Bulk path: one call for many already-created leads. */
    async attachMany({ campaignId, leadIds }) {
      if (!campaignId) throw new Error('emailbison: a campaignId is required');
      if (!leadIds?.length) return { attached: 0 };
      await c.send('POST', `/campaigns/${campaignId}/leads/attach-leads`, { lead_ids: leadIds });
      return { attached: leadIds.length };
    },

    requests: c.requests,
    receipt: () => ({ vendor: 'emailbison', dry_run: c.dryRun, requests: c.requests.length }),
  };
}

/** EmailBison requires a last name. Derive one rather than sending null. */
function splitName(lead) {
  if (lead.lastName) return { first: lead.firstName || null, last: lead.lastName };
  const full = (lead.fullName || '').trim();
  if (full.includes(' ')) {
    const parts = full.split(/\s+/);
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }
  return { first: lead.firstName || null, last: full || lead.email.split('@')[0] };
}
