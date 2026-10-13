# Shadow evaluation — mid-market-tighten.json vs mid-market.json

Universe: `run-mid-market.json` · reference date 2026-09-23

## Verdict: **HOLD**

drops 3 row(s) that produced a deliverable — you are trading a working lead for a cheaper list

| | baseline | candidate |
|---|---|---|
| rows in the working set | 27 | 22 |
| rows dropped | — | 5 |
| rows added | — | 0 |
| tier changes | — | 2 |
| **deliverables lost** | — | **3** |
| projected spend | $2.33 | $1.9 |

Projected spend is an estimate: $0.0863/row (the recorded run's spend ÷ its working set), applied to each config.

## Rows that leave the working set

- **Flam** (was tier C) — fit below threshold — recorded, not bought
- **Defense Unicorns** (was tier B, **deliverable**) — fit below threshold — recorded, not bought
- **RudderStack** (was tier C, **deliverable**) — fit below threshold — recorded, not bought
- **Cypress.io** (was tier C, **deliverable**) — fit below threshold — recorded, not bought
- **Hiver** (was tier C) — fit below threshold — recorded, not bought

## Tier changes

- Orum: A → B (signal 70d old)
- Aligned: A → B (signal 84d old)

## What this can and cannot tell you

- It **can** tell you whether the change is safe: nothing that was producing a deliverable is lost.
- It **can** tell you what the change costs.
- It **cannot** tell you the change is *better*. That needs outcome labels (`--labels`); fit is not outcome.
