---
name: origination-engine
description: Turn an ideal-customer-profile into a sourced, scored and verified account universe written to Attio. Use when the user gives an ICP (or asks for a lead list, TAM, account universe, "find companies like X", "build me a pipeline for <market>", or wants contacts written into a CRM). Handles market construction from a profile that no database sells directly — qualification gates, people search by function, waterfall email find + verify, fit×timing tiering, and CRM writeback with a cost receipt.
---

# Origination Engine

ICP in, qualified pipeline out. The boring stack, in order — nothing expensive runs
before something cheap has passed.

## When to use this skill

- The user describes a **market**, not a list: "US B2B software, 51–200 staff, buyer is marketing".
- They want **companies and people at them**, with **verified work emails**.
- They want the result **in a CRM** (Attio), not in a CSV.
- They say: lead list, TAM, account universe, market construction, lookalikes of a best-fit account.

## The motion

| # | Step | Tool | Rule |
|---|------|------|------|
| 1 | Compile the ICP into **filters** + **checks** | `pipeline/icps/*.md` | If a part of the ICP cannot be a filter, it is a check, and it runs before any expensive step. |
| 2 | **Count, then qualify** — free gates first | `pipeline/rules/*.json` | No expensive lookup runs on a row that has not passed. Every drop carries a reason. |
| 3 | **Find the person** by function | `treg.people.search` | Search the buyer's function; a "decision makers" list is a map of the company, not your committee. Under 50 staff, search the founder. |
| 4 | **Find, then verify** the email | `treg.people.email.find` + `verify` | Only a verified-deliverable address enters the sequence. Found is not deliverable. |
| 5 | **Write back** | `pipeline/lib/attio.mjs` | Company first, then person (a record-reference cannot create its target). Writeback is the product. |

## Run it

```bash
# replay a recorded run — no keys, no spend, deterministic
node pipeline/run.mjs --replay
node pipeline/run.mjs --replay --icp small-teams   # under-50 profile
node pipeline/run.mjs --list                       # available profiles

# real run: source, enrich, verify (needs TREG_TOKEN)
node pipeline/run.mjs --live

# and write the survivors into Attio (needs ATTIO_TOKEN)
node pipeline/run.mjs --live --write
```

Setup for the data layer is one line: `set up treg — https://treg.to/llms.txt`.

**A new market is a new profile**, not new code: add `pipeline/icps/<slug>.md` and
`pipeline/rules/<slug>.json`, then `node run.mjs --icp <slug>`. The slug picks the rules,
the rules name the ICP and the source, and the run writes `site/data/run-<slug>.json`.

## Guardrails — do not skip these

- **Never send.** This skill proposes. It writes records a human reviews. There is no
  send step, and adding one silently is a bug, not a feature.
- **Qualify before enrich.** `rules.spend.qualify_before_enrich` is the hard rule. On the
  reference run it dropped 23 of 50 rows before a single paid call.
- **Respect the spend cap.** `rules.spend.cap_per_run_usd`. The treg client throws
  `SpendCapExceeded` and stops — it does not quietly continue.
- **Honour the kill switch.** `ORIGINATION_KILL_SWITCH=on` stops paid steps and writes.
- **Tag every row.** Source list, signal, provider, verdict. A row without its source does
  not go into a sequence.
- **One owner of the stop.** `rules.run.owner_of_stop` is a person, not a team.

## Output

The pipeline writes `site/data/run.json`: the leads (with gate, fit, tier, signal, verify,
provider) plus the receipt — rows scanned, passed, dropped-before-paying, deliverable,
spend, and cost per deliverable. The site renders that file directly. Regenerate it every
run so the page never drifts from the data.

## Extending

- New market → edit `icp.md` and `rules.json`, then re-run. Nothing else is hard-coded.
- New provider or step → add it to `pipeline/lib/`, and add its cost to the receipt.
- New signal → add it to `rules.json` and **test it against wins and losses before giving it
  a weight**. A signal that does not separate wins from losses is not a signal.
