# Origination Engine

**ICP in. Qualified pipeline out.**

A GTM-engineering demo. Turn an ideal-customer-profile into a deduplicated, scored and
verified account universe — written into **Attio**, with a receipt for every row.
Data from **treg.to**, launched from **omp**.

```
repo/
  pipeline/         the motion — one file per stage, no dependencies
    icps/           the ICP profiles (the artifact)
    rules/          thresholds, gates, spend caps, owner — one per profile
    lib/            treg · attio · scoring · csv
  site/             the deployable page (static)
  scripts/          check-secrets.mjs
  skills/           the omp skill: type an ICP, get a pipeline
  HOSTING.md        stack, free tiers, Vercel vs Cloudflare, credential model
  .env.example      TREG_TOKEN · ATTIO_TOKEN · kill switch
```

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
| written to Attio | 20 companies · 20 people · 20 list entries |

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
| profile | 51–200 staff | **under 50 staff** |
| buyer | a *function* — marketing / growth | **the founder** |
| universe built by | a provider run (treg.to) | targeted research (omp) |
| rows sourced | 50 | 20 |
| passed the free gates | 27 | 20 |
| **tier A — contact now** | 6 | **13** |
| enrichment | recorded · $2.33 | not run (needs a data token) |

**The contrast is the point.** When you *buy* a list, the gates do the work — 23 of 50 rows
never cost a cent. When you *construct* the market, the ICP is already applied, so the gates
become a safety net and **timing** is the real constraint: 7 of the 20 had no recent reason
to write. Fit was high across the board; the signal is what separated them.

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
```

Needs Node ≥ 18 (built-in `fetch`). No dependencies.

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
