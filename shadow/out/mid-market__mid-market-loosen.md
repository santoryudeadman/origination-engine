# Shadow evaluation — mid-market-loosen.json vs mid-market.json

Universe: `run-mid-market.json` · reference date 2026-09-23

## Verdict: **PROMOTE TO SHADOW**

adds 5 row(s) that no evidence covers yet and costs $0.43 more per run — pay for them only after the labels justify it

| | baseline | candidate |
|---|---|---|
| rows in the working set | 27 | 32 |
| rows dropped | — | 0 |
| rows added | — | 5 |
| tier changes | — | 3 |
| **deliverables lost** | — | **0** |
| projected spend | $2.33 | $2.76 |

Projected spend is an estimate: $0.0863/row (the recorded run's spend ÷ its working set), applied to each config.

## Rows that join

- **Nanonets** → tier C
- **Gridware** → tier C
- **LoanStreet Inc.** → tier C
- **Wellfound** → tier C
- **Roboflow** → tier C

## Tier changes

- Certa.ai: B → A (signal 107d old)
- Triomics: C → B (signal 114d old)
- RudderStack: C → B (signal 93d old)

## What this can and cannot tell you

- It **can** tell you whether the change is safe: nothing that was producing a deliverable is lost.
- It **can** tell you what the change costs.
- It **cannot** tell you the change is *better*. That needs outcome labels (`--labels`); fit is not outcome.
