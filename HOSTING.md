# Stack & hosting

## The stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node ≥ 18** | Built-in `fetch`. No transpiler, no bundler. |
| Pipeline | **plain ESM**, zero dependencies | One file you can read in a sitting and run anywhere. |
| Site | **static HTML/CSS/vanilla JS** | No build step. Deploys to any host, including a bucket. |
| Data layer | **treg.to** (REST, `X-Treg-Token`) | One token, 111 providers, pay-per-answer, misses free. |
| CRM | **Attio** (REST v2, Bearer) | Idempotent upsert on a unique attribute; same surface over MCP. |
| Scheduling | **Cloudflare Workers cron** (when you go live) | See below. |

Total dependency count: **0**. Nothing here needs `npm install`.

---

## Can it host for free? Yes — on all three.

| Host | What you deploy | Free tier | Verdict |
|---|---|---|---|
| **Cloudflare Pages** | `site/` | Unlimited requests + bandwidth on static assets | ✅ best static home |
| **GitHub Pages** | `site/` | Free for public repos | ✅ fine, no server logic |
| **Vercel** | `site/` | Hobby, static deploys free | ⚠️ see the licensing trap below |

The demo page is static, so all three work today. The difference only matters when you add
the **scheduled pipeline** — which is the next project.

---

## Vercel vs Cloudflare, for GTM engineering

**Verdict: Cloudflare.** Three reasons, in order of weight.

### 1. Licensing — this one is decisive

Vercel's Hobby plan is **non-commercial personal use only**. Their fair-use policy defines
commercial use as *any deployment made for the financial gain of anyone involved, including
a paid consultant who wrote the code* — so **client work is explicitly not permitted on
Hobby**; it needs Pro ($20/seat/mo).

For a GTM-engineering portfolio that exists to win client work, that is disqualifying.
Cloudflare's free plan carries no such restriction.
([Vercel plan docs](https://vercel.com/docs/plans/hobby))

### 2. Scheduling — the core GTME primitive

A GTM pipeline is a *scheduled* thing: re-score the universe nightly, watch for signals,
diff against the CRM. That is cron, and the free tiers are not close.

| | Vercel Hobby | Cloudflare Workers Free |
|---|---|---|
| Cron jobs | 100 / project | 5 / **account** |
| Minimum interval | **once per day** | **1 minute** |
| Hourly expression | *fails deployment* | supported |
| Precision | ±1 hour | ±seconds |

Vercel rejects `0 * * * *` and `*/30 * * * *` on Hobby with *"Hobby accounts are limited to
daily cron jobs"*. A morning digest at 7am is a lottery between 7:00 and 7:59.
([Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing))

### 3. Primitives that map to the actual workload

| GTME need | Cloudflare | Vercel |
|---|---|---|
| Scheduled runs | Workers **cron triggers** | Cron Jobs (daily on Hobby) |
| Fan-out, retries, backoff | **Queues** — 10k ops/day free, 24h retention | none built in |
| Run state, dedupe, ledger | **D1** — 5M reads / 100k writes/day, 5 GB | external Postgres |
| Raw responses, audit trail | **R2** | Blob |
| Cache, rate-limit counters | **KV** | KV |
| Webhook receiver | Worker route | Function |
| Scrape a page | **Browser Rendering** | external |
| Score a row without an API bill | **Workers AI** | bring a key |

([Queues on the free plan](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/),
[D1 free-tier limits](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/))

**When Vercel still wins:** if the portfolio were a Next.js *product* with auth, dashboards
and a paid plan, Vercel's DX is better and Pro is the honest cost of doing business. For
scheduled data pipelines behind a static page, Cloudflare.

---

## Credentials — where they live, and what never happens

Four environments. A key is only ever in the first three.

| Stage | Where the secret lives | Committed? |
|---|---|---|
| Local dev | `.env` (gitignored) | never |
| CI | repo/environment secrets | never |
| **Production** | platform env vars (Cloudflare `wrangler secret put`, Vercel project env) | never |
| **Browser** | *nothing* | **never** |

Rules the repo enforces or documents:

1. **`.env` is in `.gitignore`.** `.env.example` ships with empty values and is the only
   env file in the tree.
2. **`node scripts/check-secrets.mjs`** scans the working tree for GitHub/OpenAI/AWS/Slack
   tokens, JWTs, assigned secrets and password-bearing URLs, and exits non-zero on a hit.
   Run it in a pre-commit hook or CI.
3. **No secret ever reaches the client.** There is no `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_`
   variable anywhere in this project. Anything the browser can read is public forever.
4. **Server-side only.** When the site goes live, the browser calls *your* Worker/Function,
   which holds the key in its env. The key is never in the request, the response, or the bundle.
5. **Least privilege.** Give the Attio token only
   `record_permission:read-write`, `object_configuration:read`,
   `list_configuration:read-write`, `list_entry:read-write`. Use a per-org treg token, not an
   identity token.
6. **Never log a token.** The treg client logs call ids and settled cost — never the header.
7. **Rotate on exposure.** If a key was ever committed, deleting the commit is not enough —
   rotate it. Assume anything pushed to a public remote is public.

Free-tier note: platform env vars are encrypted at rest and injected at runtime, which is
strictly better than a `.env` file on a laptop. Segregate by environment (dev/prod tokens)
so a leaked dev key cannot touch production data.

---

## What we need from you

| Credential | Where to get it | Scope | Needed for |
|---|---|---|---|
| **`TREG_TOKEN`** | [treg.to](https://treg.to/llms.txt) → `treg login`, then a per-org token in team settings | org-scoped | the paid steps: people search, email find + verify, company enrich |
| **`ATTIO_TOKEN`** | Attio → Workspace settings → Developers → API key | the 4 scopes above | the writeback (companies, people, list entries) |
| *(optional)* **Cloudflare account** | dash.cloudflare.com | — | hosting the static site; Workers/Queues/D1 for project #2 |
| *(optional)* **Slack webhook URL** | Slack app → Incoming Webhooks | one channel | project #3's human-approval surface |

Nothing else. No Gemini/OpenAI key is required — scoring here is deterministic by design.
New treg teams start with **$1.00 of free credit**, which covers a ~120-company run at the
recorded $0.1165 per deliverable lead.

Send them as env values, never in a file you commit. If you'd rather not hand over a
production key, mint a throwaway workspace + a scoped treg org token and rotate after.
