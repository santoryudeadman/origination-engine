# ICP — example: US B2B software, outbound-led, 51–200 staff

> Status: **example**. This file *is* the artifact. Edit it; the pipeline re-compiles.
> Nothing downstream is hard-coded — filters, checks and exclusions are read from here.

A detailed, explanatory definition. Not a vague persona.

## Who we sell to

We sell **GTM engineering** — sourced account universes, waterfall enrichment, signal
systems, CRM writeback — to companies that *already run outbound themselves* and feel
the pain of doing it by hand. The buyer is the person who owns the top of funnel.

**Buyer function, not title: marketing or growth.**
Titles are downstream of the function. Search the function; the "decision makers"
endpoint is a map of the company, not your buying committee.

## Filters (a provider can filter on these)

| Field | Value | Why |
|---|---|---|
| country | `US` | Sending infrastructure + data coverage |
| headcount | `51–200` | Has a motion, still founder-led enough to move fast |
| category | `B2B software / SaaS` | Product-led or sales-led software, not services |
| funding | active, any stage ≥ seed | Budget exists for the current cycle |
| domain | resolves, primary | A row with no primary domain is not a row |

## Checks (judgement per row — run **before** any paid step)

1. **Does the product sell to a GTM function?** (sales, marketing, revenue, growth)
   A dev tool with no commercial motion is out, however good the fit score looks.
2. **Is there an inbound motion?** Self-serve / docs / pricing page present → the
   team already thinks about funnel. Pure enterprise-gate = deprioritise.
3. **Is outbound visible?** Job posts for sales/marketing/growth in the last 60 days,
   or a blog/newsroom that publishes — evidence someone owns the top of funnel.

## Exclusions (explicit)

- Agencies, consultancies, dev shops, staffing.
- Pre-product / no pricing page.
- Companies whose only "GTM motion" is a founder's personal network — no system to sell into.
- Anything already in the CRM (drop before the queue, not after the spend).

## The threshold

The fit threshold is a **number in the rules file**, not a vibe. At `0.50`, 27 of 48
companies passed. At `0.60`, only 14 would have. Raising the threshold is a spend
decision: fewer rows bought, higher quality per row.
