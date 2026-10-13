// Shared plumbing for every CRM adapter: the shared HTTP client plus the counters a
// writeback reports back. The dry run is the point — a writeback layer that can only be
// exercised with live credentials is a writeback layer nobody tests.

import { createHttpClient } from '../http.mjs';

export function createClient(opts) {
  const c = createHttpClient(opts);
  const written = { companies: 0, people: 0, list_entries: 0 };

  return {
    ...c,
    written,
    receipt: () => ({
      vendor: c.vendor,
      dry_run: c.dryRun,
      written: { ...written },
      requests: c.requests.length,
    }),
  };
}
