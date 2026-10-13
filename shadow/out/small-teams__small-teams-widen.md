# Shadow evaluation — small-teams-widen.json vs small-teams.json

Universe: `run-small-teams.json` · reference date 2026-10-13

## Verdict: **PROMOTE**

no rows leave the working set; 4 change tier

| | baseline | candidate |
|---|---|---|
| rows in the working set | 30 | 30 |
| rows dropped | — | 0 |
| rows added | — | 0 |
| tier changes | — | 4 |
| **deliverables lost** | — | **0** |

No cost projection: this universe had no enrichable rows (enrichment not run).

## Tier changes

- boxes.dev: B → A (signal 133d old)
- Outmarket AI: B → A (signal 153d old)
- Greenboard: B → A (signal 154d old)
- Paragon: B → A (signal 160d old)

## What this can and cannot tell you

- It **can** tell you whether the change is safe: nothing that was producing a deliverable is lost.
- It **can** tell you what the change costs.
- It **cannot** tell you the change is *better*. That needs outcome labels (`--labels`); fit is not outcome.
