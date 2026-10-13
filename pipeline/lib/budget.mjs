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

  const persist = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  };

  const budget = {
    kind: 'file',
    path,
    capMicro,

    spentMicro() { return data[day()] ?? 0; },

    wouldExceed(projectedMicro) {
      return budget.spentMicro() + projectedMicro > capMicro;
    },

    /**
     * Reserve BEFORE the call. Synchronous, therefore atomic: with N concurrent workers each
     * reserves its ceiling before any of them settles, so a burst cannot cross the day's budget.
     */
    reserve(projectedMicro) {
      if (budget.wouldExceed(projectedMicro)) return false;
      data[day()] = (data[day()] ?? 0) + projectedMicro;
      persist();
      return true;
    },

    /** Settle AFTER the call: refund the difference between the reserved ceiling and the real charge. */
    settle(reservedMicro, actualMicro) {
      const delta = (actualMicro ?? 0) - reservedMicro;
      if (delta) {
        data[day()] = (data[day()] ?? 0) + delta;
        persist();
      }
    },

    /** For callers that already know the final number. */
    addMicro(n) {
      if (!n) return;
      data[day()] = (data[day()] ?? 0) + n;
      persist();
    },

    snapshot() {
      return { day: day(), spent_micro: budget.spentMicro(), cap_micro: capMicro, path };
    },
  };

  return budget;
}
