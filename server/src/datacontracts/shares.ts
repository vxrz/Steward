import { db } from '../db.js';
import { CONTRACT_SHARE_MODEL, contractRights, type ContractRight } from '../auth/policy.js';
import type { ShareKindDef } from '../auth/shares.js';

/**
 * Data contracts switched to shares (0.23.0, ADR 0033 phase 2, #297): View, Edit (new versions, links) and Manage (its
 * shares), with _test_ and _relax the breaking-change rule_ (decision 12, the former `manage`) beside the level. Manage
 * by default: designers among the members of its owning teams, all designers while it has none (decision 13).
 */
const name = (id: string) => db().get<{ name: string }>('SELECT name FROM data_contracts WHERE id = ?', id)?.name;

export const CONTRACT_SHARE_KIND: ShareKindDef<ContractRight> = {
  kind: 'contract',
  model: CONTRACT_SHARE_MODEL,
  name,
  link: (id) => `/data-contracts/${id}`,
  rights: (u, id) => (name(id) === undefined ? [] : contractRights(u, { id }).permissions),
};
