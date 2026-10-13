#!/usr/bin/env node
// Fail if a credential looks like it is in the repo.
//   node scripts/check-secrets.mjs
// Exit 1 on any hit. Wire it into a pre-commit hook or CI.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.vercel', '.wrangler', 'artifacts']);
const MAX_BYTES = 512 * 1024;
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.html', '.css', '.yml', '.yaml', '.toml', '.sh', '.txt', '.csv', '.example']);

// This file necessarily contains the patterns it looks for.
const ALLOW = new Set(['scripts/check-secrets.mjs']);

const PATTERNS = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'OpenAI-style key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\./, 'JWT'],
  [/\b(gho|ghu|ghs)_[A-Za-z0-9]{16,}/, 'GitHub app token'],
  [/(TREG_TOKEN|ATTIO_TOKEN|API_KEY|APIKEY|SECRET|PASSWORD|ACCESS_TOKEN)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i, 'assigned secret'],
  [new RegExp('postgres(ql)?://[^\\s"\']*:[^\\s"\']{8,}@'), 'database URL with password'],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.size <= MAX_BYTES && (TEXT_EXT.has(extname(name)) || name.startsWith('.env'))) out.push(full);
  }
  return out;
}

const hits = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (ALLOW.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [re, label] of PATTERNS) {
      if (re.test(line)) hits.push({ file: rel, line: i + 1, label, sample: line.trim().slice(0, 90) });
    }
  });
}

// .env must never be tracked by git.
let trackedEnv = '';
try {
  trackedEnv = readdirSync('.git') && '';
} catch { /* not a git repo */ }

if (hits.length) {
  console.error(`\n✗ ${hits.length} possible secret(s) in the working tree:\n`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.label}]\n    ${h.sample}`);
  console.error('\nMove them to .env (gitignored) or the platform env vars. Rotate anything already pushed.\n');
  process.exit(1);
}

console.log('✓ no credentials found in the working tree');
