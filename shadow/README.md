# Project 2 — Shadow evaluation

**Decide whether a config change is safe to promote, before it ships.**

```
node shadow/evaluate.mjs \
  --universe site/data/run-mid-market.json \
  --baseline pipeline/rules/mid-market.json \
  --candidate shadow/configs/mid-market-tighten.json
```

---

## Why this exists

Every GTM system accumulates unmeasured changes. Someone raises the fit threshold because
the list "felt noisy". Someone widens the signal window because tier A looked thin. Someone
re-weights a signal because a competitor tweets about it. Nobody can say afterwards whether
the change helped — and by the time it shows up in reply rates, three other things changed
too.

The doctrine says *test a signal before you give it a weight* and *know when to kill a
workflow*. Almost nobody actually runs the test, because there is no rig for it. This is the
rig.

## What it does

Replays **two configs over the same recorded rows** and answers three questions:

1. **Which rows move**, and which leave the working set?
2. **Of the rows that leave, how many had produced a deliverable?**
3. **What does the change save or cost?**

The baseline is always the *recorded* verdict — what actually ran — never a recomputation.
The candidate is an **overlay** deep-merged onto the baseline, so a change is a 3-line diff
rather than a second copy of the config that drifts.

## The gate

A row that was working may not be silently dropped. That single rule produces four verdicts:

| Verdict | When | Meaning |
|---|---|---|
| `HOLD` | drops a row that produced a deliverable | you are trading a working lead for a cheaper list |
| `HOLD` | working set grows past `--gate-agreement` | the volume dial is out of bounds |
| `PROMOTE TO SHADOW` | adds rows that no evidence covers yet | pay for them only after the labels justify it |
| `PROMOTE` | nothing working is lost, nothing unproven is added | ship it |

The `PROMOTE TO SHADOW` row is the one people skip. Adding rows is not free *and not proven* —
a bigger list is a hypothesis, not a result, until something has measured it.

## The real result

`shadow/configs/mid-market-tighten.json` raises the fit threshold `0.50 → 0.55` and shortens
the signal window `90 → 60` days. It is the change a GTM engineer proposes after looking at a
noisy list.

```
working set  27 → 22   (−5 / +0)
tier changes 2
deliverables lost  3
projected spend    $2.33 → $1.9  (Δ −0.43)

VERDICT  HOLD — drops 3 row(s) that produced a deliverable
```

It saves **$0.43** and throws away **three leads that had verified work emails** — Defense
Unicorns, RudderStack, Cypress.io — plus demotes Orum and Aligned from tier A on a
signal-age technicality. A 43-cent saving against a working pipeline is not a trade; it is a
regression dressed as rigour.

That is the entire argument for this tool. The tightening instinct is usually right in
principle and wrong in the specific, and only a replay tells you which.

## What it can and cannot tell you

- It **can** tell you the change is *safe*: nothing that was producing a deliverable is lost.
- It **can** tell you what the change *costs*.
- It **cannot** tell you the change is *better*. Fit is not outcome.

For that, pass outcome labels and it measures lift by tier instead of guessing:

```bash
node shadow/evaluate.mjs \
  --universe site/data/run-mid-market.json \
  --baseline pipeline/rules/mid-market.json \
  --candidate shadow/configs/mid-market-loosen.json \
  --labels outcomes.csv        # company,outcome   (won | lost)

# bound how far the working set may grow
--gate-agreement 5
```

Outcome labels come from the CRM once the pipeline has been live for a cycle — the join is
`source_list → tier → replied → meeting`. Until then this tool is honest about being a safety
check, not a proof of lift. That distinction is the difference between measurement and
marketing.

## Output

Writes `shadow/out/<baseline>__<candidate>.md` and `.json`. Commit the reports — they are the
audit trail of why each config change was approved.

## Files

```
shadow/
  evaluate.mjs              the rig
  configs/                  candidate overlays
    mid-market-tighten.json
    mid-market-loosen.json
    small-teams-widen.json
  out/                      generated reports
```

Reuses `pipeline/lib/score.mjs` directly, so the evaluator and the pipeline can never
disagree about what a gate or a tier means.
