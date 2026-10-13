// The sequencer port.
//
//   enroll({ campaignId, lead }) -> { enrolled, leadId?, contactId?, skipped? }
//
// Every adapter treats "already there" as a no-op with a reason, not an exception. A
// re-run must be boring: the second run should change nothing and say so.

import { lemlist } from './lemlist.mjs';
import { emailbison } from './emailbison.mjs';

const SEQUENCERS = { lemlist, emailbison };

export const knownSequencers = () => Object.keys(SEQUENCERS).sort();

export function createSequencer(name, opts = {}) {
  const make = SEQUENCERS[String(name || '').toLowerCase()];
  if (!make) throw new Error(`unknown sequencer "${name}" — known: ${knownSequencers().join(', ')}`);
  return make(opts);
}
