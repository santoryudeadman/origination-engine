# AGENTS.md

Instructions for any coding agent working in this repo — Cursor, Codex, Claude Code, omp.

Read this before editing. The invariants below are load-bearing: breaking one silently turns a
verifiable system into a plausible-looking demo.

## Non-negotiables

1. **`pipeline/lib/score.mjs` stays deterministic.** No model calls, no clock reads, no network.
   Gates and tiers are pure functions of a normalized lead. If a rule needs judgement, it belongs
   in the `fit` score, not in the gate.

2. **Never fabricate data.** No invented companies, emails, outcomes, or receipts. Every row in
   `site/data/` is real and sourced. Test fixtures are generated at runtime into a temp directory
   and deleted — never committed.

3. **Writes are dry-run by default.** `--write` is opt-in. Any new adapter must print the exact
   request it would send when it is not writing, and must refuse to run without a token rather
   than silently no-op.

4. **Money movement needs a rail.** Any new paid step must respect the per-run cap, the per-day
   ledger, and the per-call ceiling. Reserve *before* spending; settle the difference after.

5. **Retries must be classified.** Retry `429`/`409`/`5xx`/network. Never retry `4xx` — that is our
   mistake, and retrying burns money across providers. One `Idempotency-Key` per logical call,
   reused across attempts.

6. **The pipeline never sends.** It proposes. Do not add a send step, a sequencer auto-enrol, or
   anything that reaches a prospect without a human. If asked to, add it behind an explicit flag
   and a documented kill switch.

7. **No secrets in the tree.** `.env` is gitignored; there is no `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_`
   variable anywhere. Run `node scripts/check-secrets.mjs` before proposing a commit.

## Before you claim something works

```bash
node scripts/verify.mjs         # 82 assertions over the real pipeline and evaluator
node scripts/check-secrets.mjs
```

Both run in CI. If you change behaviour, the assertion count moves with it — update
`scripts/verify.mjs` and the number quoted in `README.md`.

## Structure of record

| Path | What it owns |
|---|---|
| `pipeline/icps/*.md` | the ICP, in prose. The artifact. |
| `pipeline/rules/*.json` | thresholds, gates, spend rails, owner of the stop |
| `pipeline/lib/score.mjs` | gates + tiers. Pure. |
| `pipeline/lib/treg.mjs` | the data layer, with retries and cost accounting |
| `pipeline/lib/crm/` | writeback adapters — one file per vendor, one shared client |
| `shadow/` | the promotion gate. Reuses `score.mjs` so the two can never disagree. |
| `site/` | static. Replays recorded runs. Holds no credential, ever. |

Adding a market means adding an ICP file and a rules file — not new code.
Adding a CRM means adding one adapter, not touching the pipeline.
