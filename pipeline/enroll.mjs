#!/usr/bin/env node
// Hand a qualified list to a sending tool.
//
//   node pipeline/enroll.mjs --run site/data/run-mid-market.json \
//                            --sequencer lemlist --campaign cam_abc123
//
//   add --write to actually enrol. Without it, this prints what it would do.
//
// This is deliberately NOT part of run.mjs. The pipeline proposes; a human decides. Putting
// contacts into a sequencer is the first irreversible step in the whole system, so it is a
// separate command with its own flag, its own dry run, and its own receipt.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { createSequencer, knownSequencers } from './lib/sequence/index.mjs';
import { mapPool } from './lib/pool.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function loadEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
  const a = { write: false, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--write') a.write = true;
    else if (t === '--run') a.run = argv[++i];
    else if (t === '--sequencer') a.sequencer = argv[++i];
    else if (t === '--campaign') a.campaign = argv[++i];
    else if (t === '--limit') a.limit = Number(argv[++i]);
    else if (t === '--concurrency') a.concurrency = Number(argv[++i]);
  }
  return a;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const log = (s) => console.log(s);

  if (!args.run) throw new Error(`--run <path to run.json> is required. Sequencers: ${knownSequencers().join(', ')}`);
  if (!args.sequencer) throw new Error(`--sequencer is required. Known: ${knownSequencers().join(', ')}`);
  if (!args.campaign) throw new Error('--campaign is required — enrolment must name its destination');

  const killSwitch = (process.env.ORIGINATION_KILL_SWITCH || 'off') === 'on';
  if (killSwitch) {
    log('✋ kill switch engaged (ORIGINATION_KILL_SWITCH=on) — nothing enrolled.');
    return;
  }

  const run = JSON.parse(readFileSync(resolve(ROOT, args.run), 'utf8'));
  const leads = run.leads ?? [];

  const eligible = leads.filter((l) => l.deliverable && l.email);
  const noAddress = leads.filter((l) => l.deliverable && !l.email).length;
  const targets = args.limit ? eligible.slice(0, args.limit) : eligible;

  const seq = createSequencer(args.sequencer, { dryRun: !args.write, log: (l) => log(`         ${l}`) });

  log(`run        ${args.run}  (${run.meta?.icp ?? '?'}, ${leads.length} rows)`);
  log(`sequencer  ${seq.name}  →  campaign ${args.campaign}`);
  log(`mode       ${args.write ? 'ENROLLING' : 'dry run (add --write to enrol)'}`);
  log('');
  log(`eligible   ${eligible.length} of ${leads.length} rows (deliverable + has an address)`);
  if (noAddress) log(`skipped    ${noAddress} deliverable row(s) have no address in this dataset`);
  if (!targets.length) {
    log('\nNothing to enrol. A live run is what produces addresses — the published dataset omits them.\n');
    return;
  }

  const results = await mapPool(targets, args.concurrency, async (lead) => {
    try {
      return await seq.enroll({
        campaignId: args.campaign,
        lead: {
          email: lead.email,
          fullName: lead.person_name,
          firstName: lead.person_name?.split(' ')[0],
          lastName: lead.person_name?.split(' ').slice(1).join(' ') || undefined,
          title: lead.person_title,
          company: lead.company,
          // Provenance rides along as custom variables, so a reply can be traced to its source.
          custom: {
            sourceList: lead.source_list,
            tier: lead.tier,
            signal: lead.signal_label ?? undefined,
            fit: String(lead.fit ?? ''),
            emailProvider: lead.email_provider ?? undefined,
            verify: lead.verify ?? undefined,
          },
        },
      });
    } catch (err) {
      return { enrolled: false, error: err.message };
    }
  });

  const tally = results.reduce((acc, r) => {
    const k = r.error ? 'errored' : r.enrolled ? 'enrolled' : `skipped:${r.skipped ?? 'unknown'}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  log('');
  for (const [k, v] of Object.entries(tally).sort()) log(`${k.padEnd(26)} ${v}`);
  log('');
  log(`receipt  ${JSON.stringify({ ...seq.receipt(), eligible: eligible.length, attempted: targets.length })}`);
  if (!args.write) log('\nNothing was sent. Re-run with --write to enrol.');
}

main().catch((err) => { console.error('\n✗', err.message); process.exit(1); });
