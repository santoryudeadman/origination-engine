# Stack & hosting

## Status

Deployed on **Cloudflare Workers** (static assets): `origination-engine.santoryudeadman.workers.dev`

```bash
npx wrangler deploy          # wrangler.toml → [assets] directory = "./site"
```

The page replays recorded runs from `site/data/*.json`. It holds **no credential** — every live
call happens in the CLI, never in the browser.

---

## Did they actually look?

The portfolio Worker logs every request, and separates three events of increasing strength:

| Event | What it means |
|---|---|
| `document` | The HTML was fetched. **Could be a robot.** Mail scanners and Slack unfurls do this. |
| `asset` | A sub-resource (CSS/JS/data) was fetched. Something rendered it. |
| `beacon` | JavaScript ran on the page. Scanners don't execute JS. **This is a person.** |

That distinction is the whole point. A single hit seconds after you send is almost always an email
security scanner, not a reader. A **`beacon`** means a real browser had the page open.

### Sending a tagged link

```bash
node scripts/link.mjs acme northwind globex
# acme      https://portfolio.santoryudeadman.workers.dev/r/acme
# northwind https://portfolio.santoryudeadman.workers.dev/r/northwind
```

The page served is identical — only the URL differs — so the slug never leaks into the content.

### Reading the log

```bash
curl "https://portfolio.santoryudeadman.workers.dev/hits?token=$HITS_TOKEN"
```

```json
{
  "slug": "acme",
  "first_seen": "2026-10-13T22:29:38Z",
  "last_seen": "2026-10-13T22:29:39Z",
  "page_views": 1, "asset_requests": 0, "js_beacons": 1,
  "verdict": "rendered-in-a-browser",
  "distinct_user_agents": 1,
  "countries": ["US"]
}
```

How to read the verdicts:

- **`touched-only`** — probably a scanner. Don't count it.
- **`loaded-assets`** — something rendered the HTML.
- **`rendered-in-a-browser`** — a person had it open.
- **`distinct_user_agents > 1`** — usually a scanner *plus* the actual person.

### Operations

`HITS_TOKEN` is a Worker secret — set it, never commit it:

```bash
printf '%s' "$(node -e 'console.log(require("crypto").randomBytes(18).toString("hex"))')" \
  | npx wrangler secret put HITS_TOKEN --config wrangler.landing.toml
```

Hits live in the `HITS` KV namespace with a 120-day TTL. Free tier allows 1,000 writes/day — a
portfolio will not approach that. **No cookies, no IP addresses stored**: a timestamp, a user
agent, a country, a viewport size and a timezone.

⚠️ Hits are logged, not guaranteed. KV is eventually consistent, so a very recent visit may take a
few seconds to appear.

> **Worth saying out loud:** there is no such thing as a read receipt. Anyone who tells you they
> can confirm *a specific person* read a page is selling something. This tells you a link was
> opened by something that runs JavaScript, from a country, at a time. That's the honest ceiling.

---


## Cost rails

Money can leave in exactly four places. Three are enforced in code; one is enforced by the platform.

| Rail | Where it lives | Enforced by | Behaviour |
|---|---|---|---|
| **Per-run cap** | `rules.spend.cap_per_run_usd` | `pipeline/lib/treg.mjs` | throws `SpendCapExceeded` before the call |
| **Per-day cap** | `rules.spend.cap_per_day_usd` | `pipeline/lib/budget.mjs` | daily ledger on disk; reserves *before* spending, so a scheduled job cannot re-spend the day |
| **Per-call ceiling** | `X-Treg-Route-Max-Cost` | treg.to | 402 refusal, nothing charged |
| **Qualify before enrich** | `rules.spend.qualify_before_enrich` | gate order | 23 of 50 rows never cost anything |

Override the daily cap for one run: `ORIGINATION_CAP_PER_DAY_USD=1.00 node pipeline/run.mjs --live`.

**Model spend in the pipeline: `$0`.** There is no model in the runtime — scoring is
deterministic by design. `omp` is an authoring and research tool, bounded with `--max-time`, and
never sits in the request path.

**Hosting: `$0` and unbillable.** Workers Free has no payment method attached, so the 100,000
requests/day ceiling returns errors rather than an invoice. That hard stop *is* the rail — not a
limit you have to monitor. `compatibility_date` is pinned in `wrangler.toml` so a runtime change
cannot silently alter behaviour.

---

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
| **Cloudflare Workers** (static assets) | `site/` via `wrangler deploy` | 100k requests/day, hard-capped and unbillable | ✅ **deployed** — see Status |
| **Cloudflare Pages** | `site/` | Unlimited requests + bandwidth on static assets | ✅ works, but wrangler 4 now delegates Pages to Workers |
| **GitHub Pages** | `site/` | Free for public repos | ✅ fine, no server logic |
| **Vercel** | `site/` | Hobby, static deploys free | ⚠️ see the licensing trap below |

The page is static, so any of these work. The difference matters when you add the **scheduled
pipeline** — which is why Workers is the right home: the same account and the same deploy
already carry the cron, Queues and D1 that the next project needs.


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
