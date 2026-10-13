#!/usr/bin/env node
// Generate a per-recipient portfolio link, so you can tell who opened it.
//
//   node scripts/link.mjs acme
//   node scripts/link.mjs acme northwind globex
//
// Send a different slug to each person. The pages are identical; only the URL differs, and
// /hits reports which slug was opened and whether a browser rendered it or a robot just
// fetched it.

const BASE = (process.env.PORTFOLIO_URL || 'https://portfolio.santoryudeadman.workers.dev').replace(/\/$/, '');
const READ = `${BASE}/hits?token=<HITS_TOKEN>`;

const slugs = process.argv.slice(2);
if (!slugs.length) {
  console.error('usage: node scripts/link.mjs <slug> [slug ...]');
  process.exit(1);
}

for (const raw of slugs) {
  const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  if (!slug) { console.error(`skipped "${raw}" — no usable characters`); continue; }
  console.log(`${slug.padEnd(22)} ${BASE}/r/${slug}`);
}

console.log(`\nread the log:  ${READ}`);
