// Lemlist — REST, HTTP Basic with an EMPTY username and the API key as the password.
//
// The behaviour that matters: **add-lead creates only, never updates.** Re-running an
// enrolment returns `400 LEAD_ALREADY_IN_CAMPAIGN`. So this adapter treats "already there"
// as a no-op rather than an error — otherwise every second run looks like a failure.

import { createHttpClient } from '../http.mjs';

const ENROLL_OK = new Set([200, 201]);

export function lemlist({
  token = process.env.LEMLIST_API_KEY,
  dryRun = true,
  log = () => {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const c = createHttpClient({
    vendor: 'lemlist',
    baseUrl: process.env.LEMLIST_BASE || 'https://api.lemlist.com/api',
    token,
    auth: 'lemlist',
    dryRun,
    log,
    fetchImpl,
  });

  const seen = new Set(); // in-batch dedupe, so one run cannot enrol the same person twice

  return {
    name: 'lemlist',
    supportsBulkEnroll: false,

    /** `updateStrategy`: overwrite | overwriteIgnoreEmpty | fillEmptyOnly. */
    async enroll({ campaignId, lead, updateStrategy = 'fillEmptyOnly' }) {
      if (!campaignId) throw new Error('lemlist: a campaignId is required to enroll');
      if (!lead?.email) throw new Error('lemlist: enroll requires an email — it is the lead key');

      const key = `${campaignId}:${lead.email}`;
      if (seen.has(key)) return { enrolled: false, skipped: 'duplicate-in-this-batch' };
      seen.add(key);

      const body = {
        email: lead.email,
        ...(lead.firstName ? { firstName: lead.firstName } : {}),
        ...(lead.lastName ? { lastName: lead.lastName } : {}),
        ...(lead.company ? { companyName: lead.company } : {}),
        ...(lead.title ? { jobTitle: lead.title } : {}),
        ...(lead.custom || {}), // extra keys become custom variables usable as {{name}}
      };

      try {
        const { dryrun, json, status } = await c.send(
          'POST', `/campaigns/${campaignId}/leads/?updateStrategy=${updateStrategy}`, body,
        );
        if (!dryrun && !ENROLL_OK.has(status)) return { enrolled: false, skipped: `http-${status}` };
        return {
          enrolled: true,
          leadId: dryrun ? c.syntheticId() : json?._id ?? null,
          contactId: dryrun ? null : json?.contactId ?? null, // needed for do-not-contact
          warnings: dryrun ? [] : json?.warnings ?? [],
        };
      } catch (err) {
        const code = err.detail?.code;
        if (err.status === 400 && code === 'LEAD_ALREADY_IN_CAMPAIGN') return { enrolled: false, skipped: 'already-enrolled' };
        if (err.status === 400 && code === 'LEAD_ALREADY_IN_OTHER_CAMPAIGN') return { enrolled: false, skipped: 'already-in-another-campaign' };
        if (err.status === 409) return { enrolled: false, skipped: 'already-in-another-campaign' };
        throw err;
      }
    },

    /** Do-not-contact. Belongs in the suppression check before any send or dial. */
    async markDoNotContact({ contactId }) {
      if (!contactId) throw new Error('lemlist: markDoNotContact requires a contactId');
      const { dryrun } = await c.send('POST', `/v2/unsubscribes/contacts/${contactId}`);
      return { ok: true, dryrun };
    },

    requests: c.requests,
    receipt: () => ({ vendor: 'lemlist', dry_run: c.dryRun, requests: c.requests.length }),
  };
}
