# Their stack, mapped to this repo

A one-page answer to "have you actually used these", with a file to click for each.

| Requirement | Status | Where it lives |
|---|---|---|
| **Cursor** | ✅ | `.cursor/rules/project.mdc` + `AGENTS.md` — repo instructions any agent reads. Project was built through agents end to end. |
| **Clay** | ✅ *as code* | `pipeline/lib/treg.mjs`. Same model Clay sells: a **waterfall** across providers, cheapest-per-hit first, **misses free** on per-success providers, with a **credit ledger**. The difference is that it is a file you can `git diff`, not a table you click. |
| **SWE fundamentals** | ✅ | Bounded concurrency (`lib/pool.mjs`), classified retries, `Idempotency-Key` reuse, atomic budget reservation, clean-cutover ports, **82 assertions in CI**. |
| **HubSpot / Salesforce** | ✅ | `pipeline/lib/crm/` — one port, three vendors. See the sharp edges below. |
| **Vercel** | ✅ | `vercel.json`. Same static site also ships on Cloudflare Workers. |
| **EmailBison / Lemlist** | ✅ | `pipeline/lib/sequence/` — one port, two sequencers, plus `pipeline/enroll.mjs` as the explicit hand-off step. |
| **Dialers — Nooks** | ✅ *(queue)* | `pipeline/lib/dialer/queue.mjs` — disposition state machine, per-contact calling windows, attempt caps, DNC, concurrency. The transport is injected, so swapping dialers doesn't touch the queue. |
| **Dialers — TitanX** | ✅ *(correction)* | TitanX is **not a dialer** — see below. |
| **What makes a sales team's life easier** | ✅ | Human gates everywhere: keep/skip, the promotion gate, propose-only writes, and a documented *non-build*. |

## The sharp edges, because this is the actual interview

Each of these is a thing that silently breaks in production, and knowing it is worth more than
knowing the endpoint.

**HubSpot `domain` is not a unique key.** It is the *suggested* dedup identifier, but HubSpot does
not enforce uniqueness. A portal with two companies on the same domain makes a domain-keyed
`batch/upsert` fail outright — `Unable to perform update/upsert by non-unique property domain`.
Mitigation: add a custom unique property and point `idProperty` at it. Separately, `email` as an
`idProperty` **does not support partial upserts**, so the payload must always carry every property
you care about — "update just the title" is not a thing.

**Association type ids are direction-specific.** HubSpot's typed v3 route needs the right id —
`279` is contact→company, `1` is contact→*primary* company, `2`/`280` is company→contact. Use the
label-free `/associations/default/` path unless you specifically need a label, and you cannot get
it wrong.

**Salesforce cannot upsert on a standard field.** `PATCH /sobjects/{Object}/{ExternalIdField}/{value}`
requires a **custom** field flagged **External ID** — `Website` and `Email` cannot be flagged. Add
**Unique** too, or the integration user needs org-wide **View All Data**. If the external id matches
more than one record you get `300` and *nothing is written*. API calls must go to the
`instance_url` from the token response, never `login.salesforce.com`.

**TitanX is not a dialer.** The listing groups it with Nooks, but its public API is a **phone-intent
scoring and enrichment** surface: `POST /contacts/score`, `POST /contacts/enrich`, async jobs with
`job.contact.scored` / `job.completed` webhooks. It predicts who will answer and finds numbers. It
has **no** disposition, concurrency, retry, calling-window or DNC API — the customer's dialer owns
all of that. Keys also require a Team subscription, Team Admin only.

**Lemlist's add-lead creates only.** It never updates. Re-running an enrolment returns
`400 LEAD_ALREADY_IN_CAMPAIGN`, so a naive integration reports an error every second run. Treat
"already there" as a no-op with a reason. Separately, EmailBison takes a **per-instance** base URL
(you host it), requires a last name, and needs *two* calls to enrol — create the lead, then attach
lead ids to the campaign. Attaching to an active campaign takes ~5 minutes to sync, so it is not a
place to poll for a result.

**A dialer adapter's real primitives are none of those four vendors' APIs.** Whatever dialer you
run, the adapter has to model: simultaneous dials in flight, a disposition state machine
(`queued → dialing → ringing → connected → dispositioned`) with terminal vs retryable outcomes,
per-disposition retry caps, IANA timezone + local calling windows, attempt caps, org-wide DNC
checked *before* every dial, and an at-least-once writeback keyed on a stable call id. Nooks
gives you the disposition half; the queue is yours. `pipeline/lib/dialer/queue.mjs` is that queue,
with the telephony transport injected.

## How the repo is put together

```
pipeline/
  icps/*.md        the ICP, in prose — the artifact
  rules/*.json     thresholds, gates, spend rails, owner of the stop
  lib/score.mjs    gates + tiers. Pure, deterministic, no model.
  lib/treg.mjs     the data layer: waterfall, retries, cost ledger
  lib/crm/         writeback port — attio | hubspot | salesforce
  lib/budget.mjs   the daily spend rail
  lib/pool.mjs     bounded concurrency
shadow/            the promotion gate (project 2)
site/              static, replays recorded runs, holds no credential
```

A new market is an ICP file plus a rules file. A new CRM is one adapter. Neither touches the
pipeline — which is the point.
