# Integration notes

Field notes from wiring outbound systems together. Mostly the parts that bite — because the
endpoint is the easy half.

Adapters for each of these live in `pipeline/lib/crm/` and `pipeline/lib/sequence/`. Every one is
dry-run by default and testable without a live account, which is how these notes were checked.

---

## HubSpot

**`domain` is not a unique key.** It is the *suggested* dedup identifier, and HubSpot does not
enforce it. A portal with two companies on one domain makes a domain-keyed `batch/upsert` fail
outright — `Unable to perform update/upsert by non-unique property domain`. Fix: add a custom
unique property and point `idProperty` at it.

**`email` as an `idProperty` does not support partial upserts.** You always send the full set of
properties you care about. "Just update the job title" is not a thing.

**Upsert lives on the batch endpoint, not the single-object one** — `idProperty` is per input.

**Association type ids are direction-specific.** `279` is contact→company, `1` is contact→*primary*
company, `2`/`280` is company→contact. Use the label-free `/associations/default/` path unless you
specifically need a label, and you cannot get it wrong.

Lists (Segments) are available on Free tier. Membership endpoints only work on `MANUAL`/`SNAPSHOT`
lists; a `DYNAMIC` list is filled by filters, not by you.

## Salesforce

**You cannot upsert on a standard field.** `PATCH /sobjects/{Object}/{ExternalIdField}/{value}`
requires a **custom** field flagged **External ID**. `Website` and `Email` cannot be flagged.

**Add Unique as well.** With External ID but not Unique, the integration user needs org-wide
**View All Data**.

**Multiple matches → `300`, and nothing is written.**

**Response codes carry meaning:** `201` created, `200` + `created:false` updated (API v46+; v45 and
earlier returned `204`).

**Link by relationship-by-external-id** — `{ "Account": { "External_Id__c": "acme.com" } }` on the
Contact. No lookup, no stored id, no race. Prefer it over resolving `AccountId` first.

**Calls go to the `instance_url` from the token response**, never `login.salesforce.com`.

**No client-supplied idempotency key exists anywhere in the API.** A retry is only safe because the
external id is in the URL.

## Lemlist

**Add-lead creates only. It never updates.** Re-running an enrolment returns
`400 LEAD_ALREADY_IN_CAMPAIGN`, so a naive integration reports a failure on every second run.
Treat "already there" as a no-op with a reason.

Auth is HTTP Basic with an **empty username** and the API key as the password — `Basic ` + base64 of
`":KEY"`. The leading colon is required.

Custom variables are just extra keys in the create-lead body. Do-not-contact is a separate contact
endpoint (`/v2/unsubscribes/contacts/{contactId}`), which is why enrolment returns the `contactId`
and not just the lead id.

## EmailBison

**The base URL is per-instance.** You host it (or use a dedicated node), so the host is
configuration, not a constant.

**Enrolment is two calls** — create the lead, then attach lead ids to the campaign. And attaching to
an **active** campaign takes ~5 minutes to sync, so it is not a place to poll for a result.

A last name is required. Derive one rather than sending null.

## Dialers

**TitanX is not a dialer.** Its public API is phone-intent *scoring and enrichment* —
`POST /contacts/score`, `POST /contacts/enrich`, async jobs with `job.contact.scored` /
`job.completed` webhooks. It predicts who will answer and finds numbers. There is **no** disposition,
concurrency, retry, calling-window or DNC surface. Keys require a Team subscription, Team Admin only.

**Nooks has a real dialer surface** — the Sequencing API at `partner-api.nooks.in/v1`, with a signed
`call.logged` webhook carrying `disposition` and `callOutcome`. Verify
`x-webhook-signature: t=<unix-ms>,s=<base64-hmac-sha256>` over `timestamp + "." + raw_body`; reject
anything older than 5 minutes; dedupe on `callData.callId`, **not** `eventId`.

**Whatever dialer you run, the queue is yours.** None of these vendors models simultaneous dials in
flight, a disposition state machine with terminal vs retryable outcomes, per-disposition backoff,
IANA-timezone calling windows, attempt caps, or org-wide DNC. That logic is in
`pipeline/lib/dialer/queue.mjs`, with the telephony transport injected so swapping dialers does not
touch the queue.

## CRMs generally

Upsert on the vendor's natural key, and let a re-run be boring: the second run should change nothing
and say so. Require the key field — an address is the person's identity in every one of these, and a
record written without one is a malformed record, not a partial success.
