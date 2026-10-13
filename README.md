# Origination Engine

[![ci](https://github.com/santoryudeadman/origination-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/santoryudeadman/origination-engine/actions/workflows/ci.yml)

**ICP in. Qualified pipeline out.**

**Live:** https://origination-engine.santoryudeadman.workers.dev

A GTM engineering system built the way software should be: **deterministic** where the work has
to repeat, **agentic** where the work is open-ended, and **verifiable** end to end. It turns an
ideal-customer-profile into a deduplicated, scored, verified account universe in **Attio** — with
a receipt for every row, a spend rail on every call, and a gate that refuses to ship a config
change that loses a working lead.

Data layer **treg.to** · agentic authoring **omp** · **zero dependencies**.

> **Come from a job spec?** [`docs/stack-map.md`](./docs/stack-map.md) maps Cursor, Clay, HubSpot,
> Salesforce, Vercel and dialers to the exact file that implements each — including the three ways
> this integration is normally written wrong.

### What it demonstrates

| | |
|---|---|
| **Reproducibility** | Every run replays from a config file. Same inputs → same decisions. |
| **Cost as an invariant** | Per-run *and* per-day spend caps enforced in code, not watched on a dashboard. |
| **Measurement** | A shadow-evaluation rig that decides whether a change is safe to promote. |
| **Verifiability** | 55 assertions over the real pipeline and the real evaluator, plus stubbed-I/O tests for retries and CRM payloads. |
| **Resilience** | Bounded concurrency, classified retries, idempotent replays, no charge for a failure. |
| **Agentic, deliberately** | Agents do the open-ended research; plain code does the repeatable pipeline. |
| **CI** | Runs on every push with no install step and no secrets. |

```
repo/
  pipeline/         the motion — one file per stage, no dependencies
    icps/           the ICP profiles (the artifact)
    rules/          thresholds, gates, spend caps, owner — one per profile
    lib/            treg · attio · scoring · csv
  site/             the deployable page (static)
  scripts/          check-secrets.mjs
  skills/           the omp skill: type an ICP, get a pipeline
  shadow/           project #2 — the evaluation rig
  HOSTING.md        stack, free tiers, Vercel vs Cloudflare, credential model
  .env.example      TREG_TOKEN · ATTIO_TOKEN · kill switch
```

---

## The portfolio

| # | Project | Status | The question it answers |
|---|---|---|---|
| 1 | **Origination Engine** — `pipeline/` | built | Can an ICP become a qualified, verified pipeline in a CRM, cheaply and repeatably? |
| 2 | **Shadow evaluation** — `shadow/` | built | Is a proposed config change safe to promote, *before* it ships? |
| 3 | **Signal attribution ledger** | next | Which signal actually paid back its spend? |

Projects 1 and 3 are the easy half: sourcing and spending. Project 2 is the half everyone
skips — **measuring whether a change helped**. Every GTM system accumulates unmeasured
changes; this repo ships the rig that catches them.

The obvious third project — an AI responder for inbound replies — is deliberately *not* here.
It is a well-documented pattern elsewhere, and re-implementing someone's writeup proves you
read it. Measuring what everyone asserts and nobody checks is the differentiator.

---

## The receipt

A real run, replayed by `node pipeline/run.mjs --replay`. Nothing below is invented —
the source data is treg.to's [published run](https://github.com/superdesigndev/treg)
of 23 Sep 2026, and the gates recompute it from `rules.json`.

| | |
|---|---|
| companies scanned | 50 |
| had a domain | 48 |
| **passed the free gates** | **27** |
| dropped before any paid lookup | 23 `(21 on fit · 2 no domain)` |
| people named | 27 |
| work emails found | 21 |
| **verified deliverable** | **20** |
| spend | $2.33 |
| **cost per deliverable lead** | **$0.1165** |
| writeback | 20 rows eligible — the published dataset omits addresses, so a replay skips them rather than writing malformed records |

Enriching all 48 rows would have cost roughly $4.12. Qualifying first spent $2.33.

Two independent checks that the gates are honest:

- at a **0.50** fit threshold, **27 of 48** rows pass;
- at **0.60**, only **14** would.

Both are what the treg playbook recorded on the same ICP.

---

## The second profile: under 50 employees

Same pipeline, different ICP — and the motion changes.

| | mid-market | small teams |
|---|---|---|
| profile | 51–200 staff | **under 50 staff** (2–48) |
| buyer | a *function* — marketing / growth | **the founder** |
| universe built by | a provider run (treg.to) | targeted research (omp) |
| rows sourced | 50 | 30 |
| passed the free gates | 27 | 30 |
| **tier A — contact now** | 6 | **14** |
| enrichment | recorded · $2.33 | not run (needs a data token) |

**The contrast is the point.** When you *buy* a list, the gates do the work — 23 of 50 rows
never cost a cent. When you *construct* the market, the ICP is already applied, so the gates
become a safety net and **timing** is the real constraint: 16 of the 30 had no fresh reason to
write. Fit was high across the board (median 0.80); the signal is what separated them.

That is the segment most lists fail at. Directory size filters either exclude it or swallow
it into `1–200`, and the buying committee is one person who is also the CEO.

---

## Why this shape

The order is the point. Most outbound stacks are built backwards — buy the list, enrich
everything, then wonder why the reply rate is flat.

```
   icp.md ─┐
           ▼
     ┌───────────┐    free     ┌──────────────┐    paid    ┌────────────────────┐
     │  compile  │────────────▶│    gates     │───────────▶│      treg.to       │
     │  + score  │             │ pass / drop  │            │  people.search     │
     └───────────┘             └──────────────┘            │  email.find        │
                                                           │  email.verify      │
                                                           └──────────┬─────────┘
                                                                      ▼
                                                              ┌───────────────┐
                                                              │     Attio     │
                                                              └───────────────┘
```

1. **Compile the ICP.** Filters a provider can filter on, plus checks that run per row.
   The buyer is a *function* — marketing, growth — not a title.
2. **Count, then qualify.** Free gates first. A row that fails is recorded, not bought.
3. **Find the person.** By function. A "decision makers" endpoint returns a map of the
   company, not your buying committee.
4. **Find, then verify the email.** A routed waterfall tries providers cheapest-per-hit;
   misses on per-success providers cost $0.00. Only `valid` enters the sequence.
5. **Write back.** Company → person → list entry, upserted on the domain and the email.

---

## Run it

```bash
# replay — no keys, no network, no spend. Deterministic.
node pipeline/run.mjs --replay

# live — source and enrich against the real APIs
cp .env.example .env          # TREG_TOKEN (treg.to), ATTIO_TOKEN (Attio workspace key)
node pipeline/run.mjs --live

# and write the survivors into Attio
node pipeline/run.mjs --live --write

# the page
npx serve site

# project 2 — shadow evaluation (no keys, no network)
node shadow/evaluate.mjs --universe site/data/run-mid-market.json \
  --baseline pipeline/rules/mid-market.json \
  --candidate shadow/configs/mid-market-tighten.json
```

Needs Node ≥ 18 (built-in `fetch`). No dependencies.

## Verify it

```bash
node scripts/verify.mjs         # 55 assertions: receipts, gate verdicts, determinism, rails, retries, CRM payloads
node scripts/check-secrets.mjs  # no credentials in the tree
```

`verify.mjs` runs the real pipeline and the real evaluator, then asserts the numbers they must
produce. These are **golden assertions, not unit tests** — they defend the two contracts that
matter: the recorded receipt reproduces, and the promotion gate reaches the same verdict. If a
refactor silently changes what the pipeline decides, CI fails.

Replay determinism is checked on *decisions*, not timestamps: `generated_at` is metadata and is
excluded rather than frozen.

Both run in CI on every push, with no install step and no secrets.

## Resilience

The paid steps are I/O bound and metered, so they run several at a time, and every failure has a
defined response rather than a blanket `catch`.

**Bounded concurrency.** `rules.spend.concurrency` workers, no more. The in-flight count is the
backpressure — no unbounded promise fan-out.

**Retries are classified, not blanket:**

| Response | Action | Why |
|---|---|---|
| `429 share_busy`, `409` | retry, honouring `retry_after_s` | the provider is capping concurrency; nothing was billed |
| `5xx`, `503 treg_saturated` | retry, exponential backoff + jitter | treg's own weather |
| network error | retry | never billed |
| **`4xx`** | **fail immediately** | it is our parameters. Retrying burns money across providers for one mistake |
| `402 route_max_cost` | fail | budget refusal, nothing charged |
| `410` | fail, surfacing the key and call id | the call completed and was charged; the same key cannot help |
| `502 response_buffer_limit` | fail | oversized now, oversized later |

**One idempotency key per logical call, reused across retries.** A call that reached the provider
and lost its answer on the way back is replayed from storage and charged nothing. A replay reports
`X-Treg-Cost-Micro: 0`, so summing attempt costs never double-bills.

**Reservation is atomic.** Under concurrency each worker reserves its per-call ceiling in the daily
ledger *before* spending and settles the difference afterwards, so a burst cannot slip through the
gap between checking the budget and spending it. A failed call is charged nothing, so its
reservation returns in full.

Nineteen of the 43 assertions cover the retry state machine, the concurrency cap, and reservation
arithmetic — driven by stubbed I/O. Retry logic that moves money should not be verified by hoping a
provider misbehaves.

**On Attio.** This demo deliberately runs on Attio rather than a legacy CRM, for the same
reason you would pick one: `PUT /v2/objects/{object}/records?matching_attribute=…` is an
idempotent upsert over a clean objects API, so a recurring pipeline updates instead of
duplicating — and the same surface is reachable over MCP.

---

## The ICP artifact

`pipeline/icps/mid-market.md` and `pipeline/icps/small-teams.md` are artifacts, not paragraphs
in a deck. Filters, checks and explicit exclusions in one file each. Edit one and the pipeline
re-compiles — nothing downstream is hard-coded.

The second profile is the interesting one: **under 50 employees, knowledge work**. That is the
segment most lists fail at, and the motion changes — at that size there is no marketing
function, so the buyer is the **founder**, and the **signal does more work than the fit**.

`pipeline/rules/<profile>.json` holds the numbers:

```json
"thresholds": { "icp_fit_pass": 0.5, "headcount": [51, 200] },
"spend":      { "cap_per_run_usd": 5.0, "qualify_before_enrich": true },
"tiers":      { "A": { "min_fit": 0.6, "requires_fresh_signal_days": 90 } },
"run":        { "owner_of_stop": "@ravadd", "mode": "shadow" }
```

A new market is a new profile, not new code:

```bash
node pipeline/run.mjs --list                 # mid-market, small-teams
node pipeline/run.mjs --replay --icp small-teams
```

---

## What we deliberately did not automate

Restraint is the differentiator. A workflow that shouldn't exist is a cost, not a feature.

- **No sending.** The pipeline proposes; a person approves. Adding a send step silently is
  a bug, not a feature.
- **No buying the whole list.** 21 of 48 rows dropped on a free check.
- **No "decision makers" endpoint.** On the recorded run it returned 45 senior people and
  no marketing at all.
- **No hand-rolled second email provider.** The routed waterfall already bills misses at
  $0.00 on per-success providers; a second call is just a second bill.

---

## The metric stack

| Health | Performance | Efficiency |
|---|---|---|
| counts agree per stage | replies by source, signal, tier | cost per usable result |
| enrichment fill rate | meetings held | share dropped before paying |
| share deliverable | opportunities created | spend against the cap |
| raw responses stored | time to first touch | rows per human hour |

Activity is not on the list.

---

## Deploy

The site is static and has no build step. All three hosts are free for it.

```bash
npx wrangler pages deploy site          # Cloudflare Pages
npx vercel deploy site --prod           # Vercel (Hobby is non-commercial only — see HOSTING.md)
git subtree push --prefix site origin gh-pages   # GitHub Pages
```

The page replays the recorded runs from `site/data/run-<profile>.json`; the live pipeline runs
from the CLI with your keys. **Keys are never in the browser.**

**[HOSTING.md](./HOSTING.md)** covers the stack, the free-tier limits, why Cloudflare beats
Vercel for this workload, and the full credential model — what lives where, what we need from
you, and what we never do. Check the tree for secrets with:

```bash
node scripts/check-secrets.mjs
```

---

## Method & credits

The playbook this follows — qualify before you enrich, search the buyer's *function*, find
then verify, work fit×timing in tiers, tag every row so pipeline traces back to its source —
is drawn from the **[treg.to GTM engineering playbook](https://treg.to/gtm-engineering)**,
and the replay data is treg.to's own published run of 23 Sep 2026. Everything else here is
ours.

No sends. Propose-only. One owner of the stop.
