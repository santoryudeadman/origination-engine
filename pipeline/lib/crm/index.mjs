// The CRM port. One interface, three vendors.
//
// Every adapter exposes the same shape:
//   upsertCompany({ domain, name, description }) -> recordId
//   upsertPerson({ email, firstName, lastName, fullName, title, companyDomain }) -> recordId
//   ensureList({ name, slug, parentObject }) -> listId | null
//   addToList({ listId, recordId, parentObject, entryValues })
//   supportsLists: boolean
//
// The pipeline never learns which CRM it is talking to. Adding a fourth vendor is one file.

import { attio } from './attio.mjs';
import { hubspot } from './hubspot.mjs';
import { salesforce } from './salesforce.mjs';

const ADAPTERS = { attio, hubspot, salesforce };

export const knownCrms = () => Object.keys(ADAPTERS).sort();

export function createCrm(name = 'attio', opts = {}) {
  const make = ADAPTERS[String(name).toLowerCase()];
  if (!make) throw new Error(`unknown CRM "${name}" — known: ${knownCrms().join(', ')}`);
  const crm = make(opts);
  crm.supportsLists = crm.supportsLists !== false;
  return crm;
}
