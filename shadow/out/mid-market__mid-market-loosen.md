# Shadow evaluation — mid-market-loosen.json vs mid-market.json

Universe: `run-mid-market.json` · reference date 2026-09-23

## Verdict: **HOLD**

tier A win rate falls 33.3% → 28.6% on your labels — the added rows dilute the top tier

| | baseline | candidate |
|---|---|---|
| rows in the working set | 27 | 32 |
| rows dropped | — | 0 |
| rows added | — | 5 |
| tier changes | — | 3 |
| **deliverables lost** | — | **0** |
| projected spend | $2.33 | $2.76 |

## Measured lift (from your labels)

| | baseline | candidate |
|---|---|---|
| **tier A win rate** | 33.3% | 28.6% |
| all-rows win rate | 7.4% | 6.3% |

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
- It measured lift from the labels you supplied.
