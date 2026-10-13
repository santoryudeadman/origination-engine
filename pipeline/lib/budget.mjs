// A spend rail that survives between runs.
//
// The per-run cap in the Treg client dies with the process. This one is a daily ledger on
// disk, so a cron job that fires every hour cannot spend the day's budget five times over.
//
// Kept out of treg.mjs on purpose: the client takes a budget object, so it stays portable
// (a Worker would inject a D1-backed one instead of a file).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const day = () => new Date().toISOString().slice(0, 10);

/**
 * @param {{path: string, capPerDayUsd: number}} opts
 */
export function fileBudget({ path, capPerDayUsd }) {
  let data = {};
  if (existsSync(path)) {
    try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { data = {}; }
  }
  const capMicro = Math.round(capPerDayUsd * 1e6);

  return {
    kind: 'file',
    path,
    capMicro,

    spentMicro() { return data[day()] ?? 0; },

    /** Reserve BEFORE the call: refuse if today's spend plus the call's ceiling would exceed the cap. */
    wouldExceed(projectedMicro) {
      return this.spentMicro() + projectedMicro > capMicro;
    },

    /** Settle AFTER the call, using the provider's actual charge. */
    addMicro(n) {
      if (!n) return;
      data[day()] = (data[day()] ?? 0) + n;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(data, null, 2));
    },

    snapshot() {
      return { day: day(), spent_micro: this.spentMicro(), cap_micro: capMicro, path };
    },
  };
}
