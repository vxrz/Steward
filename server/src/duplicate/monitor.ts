/** Duplicating monitors, and saving a monitor as a template (0.4.0). */
import { HIDDEN_MONITOR_REF, RESERVED_MONITOR_KEYS, templateParamSchema, type MonitorDetail, type TemplateParam } from '@sm/shared';
import { db } from '../db.js';
import { HttpError } from '../util.js';
import { me } from '../auth/access.js';
import { createMonitor, getMonitor } from '../monitors/service.js';
import { canCreateMonitors } from '../monitors/model.js';
import * as engine from '../monitors/engine.js';
import { copyOwningTeams, type CopyInput, type Duplicator } from './common.js';

type Check = Record<string, unknown> & { id: string; type: string };
type Def = Record<string, unknown> & { checks?: Check[]; links?: { from: string; to: string }[] };

/** Fields that never become parameters: what identifies the card, and where it is drawn. */
const NOT_PARAMETERS = new Set(['id', 'type', 'x', 'y', 'enabled', 'critical']);

/** The definition with the chosen fields as {{ params.<name> }}; each parameter's default is the value it had. */
export function asTemplate(def: Def, choices: NonNullable<CopyInput['template']>['parameters']): Def {
  const checks = def.checks ?? [];
  const parameters: TemplateParam[] = [];
  for (const p of choices) {
    const name = templateParamSchema.shape.name.safeParse(p.name);
    if (!name.success || p.name === 'name' || p.name === 'key')
      throw new HttpError(400, `Parameter name "${p.name}": letters, digits and _ (not "name" or "key")`, 'DUPLICATE_TEMPLATE_PARAM', { name: p.name });
    if (parameters.some((x) => x.name === p.name)) throw new HttpError(400, 'Template parameter names must be unique', 'TEMPLATE_PARAM_DUPLICATE');
    let type: 'string' | 'number' = 'string';
    let value: string | number | undefined;
    for (const f of p.fields) {
      const c = checks.find((x) => x.id === f.checkId);
      const v = c?.[f.field];
      if (!c || NOT_PARAMETERS.has(f.field) || (typeof v !== 'string' && typeof v !== 'number'))
        throw new HttpError(400, `Check "${f.checkId}" has no field "${f.field}" that can become a parameter`, 'DUPLICATE_TEMPLATE_FIELD', {
          checkId: f.checkId,
          field: f.field,
        });
      if (typeof v === 'number') type = 'number';
      value ??= v;
      c[f.field] = `{{ params.${p.name} }}`;
    }
    parameters.push({ name: p.name, label: p.label || p.name, type, required: true, ...(value !== undefined && value !== '' ? { default: value } : {}) });
  }
  return { ...def, parameters };
}

type Cells = Record<string, string>;
type StateRow = Record<string, unknown> & { when?: Cells; requires?: string[]; expect?: Cells };

/**
 * The states table without the cells of the given (left out) checks – condition, required and expected. A row whose
 * condition named only those checks has none left and is dropped; returns how many rows were dropped.
 */
export function dropStateCells(def: Def, gone: Set<string>): number {
  const states = def.states as { from?: string; cases?: StateRow[] } | undefined;
  if (!states?.cases?.length) return 0;
  const without = (cells: Cells | undefined) => (cells ? Object.fromEntries(Object.entries(cells).filter(([id]) => !gone.has(id))) : cells);
  const hasCondition = (r: StateRow) => Object.values(r.when ?? {}).some((c) => c !== 'any');
  const before = states.cases.length;
  states.cases = states.cases
    .map((r) => {
      const had = hasCondition(r);
      const row: StateRow = { ...r, when: without(r.when), expect: without(r.expect), requires: r.requires?.filter((id) => !gone.has(id)) };
      for (const k of ['when', 'expect', 'requires'] as const) if (row[k] === undefined || !Object.keys(row[k]).length) delete row[k];
      // a follower's rows have no condition; a row that had one and lost it would match nothing (or everything)
      return had && !hasCondition(row) ? null : row;
    })
    .filter((r): r is StateRow => r !== null);
  return before - states.cases.length;
}

export const monitorDuplicator: Duplicator<MonitorDetail> = {
  kind: 'monitor',
  entityType: 'monitor',
  label: 'Monitor',
  accessApplies: true,
  async: true,
  allowsTemplate: true,
  view(id) {
    const m = getMonitor(id);
    return { id: m.id, name: m.name, key: m.key, mayManage: m.permissions.includes('manage'), data: m };
  },
  mayCreate: () => canCreateMonitors(me()),
  keyTaken: (k) => RESERVED_MONITOR_KEYS.includes(k.toLowerCase()) || !!db().get('SELECT 1 FROM monitors WHERE key = ?', k.toLowerCase()),
  keyMax: 64,
  async copy(src, input) {
    const m = src.data;
    const skipped: { what: string; count: number }[] = [];
    // the definition as the person sees it: sub-monitors they may not see are left out (with their links)
    let def = structuredClone(m.definition) as unknown as Def;
    if (!m.isTemplate) {
      const hidden = new Set((def.checks ?? []).filter((c) => c.type === 'monitor' && c.monitor === HIDDEN_MONITOR_REF).map((c) => c.id));
      if (hidden.size) {
        def.checks = (def.checks ?? []).filter((c) => !hidden.has(c.id));
        def.links = (def.links ?? []).filter((l) => !hidden.has(l.from) && !hidden.has(l.to));
        skipped.push({ what: 'hiddenSubMonitors', count: hidden.size });
        const dropped = dropStateCells(def, hidden);
        if (dropped) skipped.push({ what: 'hiddenStateRows', count: dropped });
      }
      // a leader the person may not see cannot be followed by the copy: it is evaluated as without states
      const states = def.states as { from?: string } | undefined;
      if (states?.from === HIDDEN_MONITOR_REF) {
        delete def.states;
        skipped.push({ what: 'hiddenStatesLeader', count: 1 });
      }
      // gateway keys and heartbeat endpoints belong to the original: the copy's heartbeat checks get new secrets
      for (const c of def.checks ?? []) delete c.key;
    }
    def.name = input.name;
    const template = !!input.template;
    if (template) {
      if (m.isTemplate) throw new HttpError(400, `"${m.name}" is a template already – duplicate it instead`, 'DUPLICATE_TEMPLATE_UNSUPPORTED');
      def = asTemplate(def, input.template!.parameters);
    }
    const r = await createMonitor({ key: input.key ?? undefined, isTemplate: m.isTemplate || template, enabled: m.enabled, definition: def });
    const id = r.monitor.id;
    if (input.copyAccess) {
      db().tx(() => {
        db().run('UPDATE monitors SET acl = ? WHERE id = ?', JSON.stringify(m.acl), id);
        copyOwningTeams('monitor', m.id, id);
      });
      engine.reloadMonitor(id);
    }
    return {
      id,
      name: r.monitor.name,
      key: r.monitor.key,
      skipped,
      secrets: r.secrets,
      details: {
        ...(template ? { asTemplate: true, parameters: (def.parameters as TemplateParam[]).map((p) => p.name) } : {}),
        heartbeatSecrets: r.secrets.map((s) => s.checkId),
      },
    };
  },
  paths: (id) => ({ path: `/monitors/${id}`, editPath: `/monitors/${id}/edit` }),
};
