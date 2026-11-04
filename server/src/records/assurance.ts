import type { FastifyRequest } from 'fastify';
import type { StepUpRule } from '../auth/step-up.js';
import { FIREWALL_CHANGE_TYPE } from '../auth/assurance-overrides.js';
import { requireRecordRow } from './model.js';
import { requireType } from './types.js';
import { getRecord, workflowOf } from './service.js';

/**
 * The control points of record transitions (#210, auth/assurance.ts): approving or rejecting a record
 * (record.approve, an electronic-signature-like confirmation) and closing a firewall change (firewallChange.close,
 * records of the type FWC – inert while that type does not exist). Their step-up is off until an administrator turns
 * it on under Settings → Assurance policy.
 */

const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
const actionOf = (req: FastifyRequest) => String(((req.body ?? {}) as { action?: unknown }).action ?? '');

export const recordTransitionStepUp: StepUpRule = {
  action: 'approveRecord',
  optional: true,
  // only someone the transition is open to is asked (everyone else gets the route's own refusal)
  who: (req) => !!getRecord(idOf(req)).actions.find((a) => a.action === actionOf(req) && a.allowed),
  points: (req) => {
    const r = requireRecordRow(idOf(req));
    const t = requireType(r.type_id);
    const def = workflowOf(t).transitions.find((x) => x.action === actionOf(req));
    if (!def) return [];
    return [...(def.approval ? ['record.approve'] : []), ...(t.key === FIREWALL_CHANGE_TYPE && def.to === 'closed' ? ['firewallChange.close'] : [])];
  },
};
