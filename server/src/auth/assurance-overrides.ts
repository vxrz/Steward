import { RECORD_WORKFLOWS, controlPoint, effectiveRule, type AssuranceOverride, type AssurancePolicy, type RecordWorkflowKey } from '@sm/shared';
import { defaultIdentityRows, parseMcp } from '../platforms/identities.js';
import { db } from '../db.js';
import { parseJson } from '../util.js';

/**
 * The overrides of single items that add to the assurance policy (#210): they stay where they are – a process step, a
 * platform's MCP mode, a person review, a record type, a setting – and the policy page lists each with the rule that
 * applies to it and a link. Read straight from the tables (administrators see every item).
 */

const MAX_PER_POINT = 200;

/** The record type of firewall changes (#208): closing one of its records is the control point firewallChange.close. */
export const FIREWALL_CHANGE_TYPE = 'FWC';

/** Every object of a stored process definition (steps, graph nodes, nested groups) that matches. */
function walk(v: unknown, hit: (o: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 40 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) walk(x, hit, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  hit(o);
  for (const x of Object.values(o)) walk(x, hit, depth + 1);
}

export function listOverrides(policy: AssurancePolicy): AssuranceOverride[] {
  const out: AssuranceOverride[] = [];
  const rule = (point: string, fourEyes?: boolean) => {
    const r = effectiveRule(controlPoint(point)!, policy, { fourEyes });
    return { fourEyes: r.fourEyes, stepUp: r.stepUp };
  };
  const push = (o: AssuranceOverride) => {
    if (out.filter((x) => x.point === o.point).length < MAX_PER_POINT) out.push(o);
  };

  // record types: approval in their workflow (record.approve), the firewall change type (firewallChange.close)
  for (const t of db().all<{ id: string; key: string; name: string; workflow: string }>(
    'SELECT id, key, name, workflow FROM record_types WHERE archived = 0 ORDER BY key',
  )) {
    const wf = RECORD_WORKFLOWS[t.workflow as RecordWorkflowKey];
    const approvals = wf?.transitions.filter((x) => x.approval).map((x) => x.action) ?? [];
    if (approvals.length)
      push({
        point: 'record.approve',
        kind: 'recordType',
        label: `${t.key} – ${t.name}`,
        value: approvals.join(', '),
        link: '/records/types',
        effective: rule('record.approve'),
      });
    if (t.key === FIREWALL_CHANGE_TYPE)
      push({
        point: 'firewallChange.close',
        kind: 'recordType',
        label: `${t.key} – ${t.name}`,
        value: 'close',
        link: '/records/types',
        effective: rule('firewallChange.close'),
      });
  }

  // process steps: four-eyes approvals (run.decide) and manual steps with a verification (manualStep.verify)
  for (const p of db().all<{ id: string; name: string; definition: string }>(
    `SELECT p.id, p.name, v.definition FROM processes p JOIN process_versions v ON v.process_id = p.id AND v.version = p.current_version
     WHERE p.archived = 0 ORDER BY p.name`,
  )) {
    let fourEyes = 0;
    let verified = 0;
    const def = parseJson<{ privilegedFourEyes?: unknown } | null>(p.definition, null);
    // the process setting "Privileged runs need a second person" (0.14.0, ADR 0009 step 4)
    if (def?.privilegedFourEyes === true)
      push({
        point: 'platform.privilegedIdentity',
        kind: 'process',
        label: p.name,
        value: 'privilegedFourEyes',
        link: `/processes/${p.id}`,
        effective: rule('platform.privilegedIdentity', true),
      });
    walk(def, (o) => {
      if (o.fourEyes === true) fourEyes++;
      const v = o.verification as { required?: unknown } | undefined;
      if (v && typeof v === 'object' && v.required === true) verified++;
    });
    if (fourEyes)
      push({
        point: 'run.decide',
        kind: 'processStep',
        label: p.name,
        value: `fourEyes × ${fourEyes}`,
        link: `/processes/${p.id}`,
        effective: rule('run.decide', true),
      });
    if (verified)
      push({
        point: 'manualStep.verify',
        kind: 'manualStep',
        label: p.name,
        value: `verification × ${verified}`,
        link: `/processes/${p.id}`,
        effective: rule('manualStep.verify', true),
      });
  }

  // platforms: changing calls through MCP (mcp.write)
  // the mode is on the default identity (0.9.0, ADR 0009)
  const modes = defaultIdentityRows();
  for (const p of db().all<{ id: string; name: string; config: string }>('SELECT id, name, config FROM platforms ORDER BY name')) {
    const i = modes.get(p.id);
    const writes = i ? parseMcp(i.mcp).writes : parseJson<{ mcpGateway?: { enabled?: boolean; writes?: string } }>(p.config, {}).mcpGateway?.writes;
    if (!writes || writes === 'off') continue;
    push({
      point: 'mcp.write',
      kind: 'platformMcp',
      label: p.name,
      value: writes,
      link: `/platforms/${p.id}`,
      effective: rule('mcp.write', writes === 'fourEyes'),
    });
  }

  // person reviews that are still being decided: their own four-eyes switch (personReview.decide)
  for (const r of db().all<{ id: string; title: string; four_eyes: number }>(
    "SELECT id, title, four_eyes FROM person_reviews WHERE status IN ('open', 'submitted') ORDER BY created_at DESC",
  ))
    push({
      point: 'personReview.decide',
      kind: 'personReview',
      label: r.title,
      value: r.four_eyes ? 'fourEyes' : 'off',
      link: `/compliance/person-reviews/${r.id}`,
      effective: rule('personReview.decide', !!r.four_eyes),
    });

  // the instance setting of four-eyes dismissals of reconciliation findings (accessCheck.decide)
  const dismiss = parseJson<boolean>(db().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'findingDismissFourEyes')?.value ?? null, false);
  push({
    point: 'accessCheck.decide',
    kind: 'setting',
    label: 'findingDismissFourEyes',
    value: dismiss ? 'on' : 'off',
    link: '/settings/catalogue',
    effective: rule('accessCheck.decide', dismiss === true),
  });
  return out;
}
