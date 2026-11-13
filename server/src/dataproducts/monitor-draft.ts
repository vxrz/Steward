import {
  dataMonitorInput,
  elementCheckModes,
  type CheckDef,
  type DataMemberRole,
  type DataMonitorDraftCheck,
  type DataMonitorProposal,
  type DataMonitorResult,
  type DataMonitorSkipReason,
  type DataObjectives,
  type MonitorDefinition,
} from '@sm/shared';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { db } from '../db.js';
import { permissionsOf as contractPermissionsOf } from '../datacontracts/service.js';
import { canCreateMonitors, monitorRow, permissionsOfRow } from '../monitors/model.js';
import { moduleEnabled } from '../modules/registry.js';
import { HttpError, nowIso, parseJson, slugify } from '../util.js';
import { elementAccess } from './access.js';
import { findChecks, storeFound } from './check-links.js';
import { L } from './common.js';
import { defaultEnvironment } from './health.js';
import { editableProduct, visibleProduct } from './service.js';
import {
  addCheckLink,
  bindingsOf,
  checkLinksOf,
  elementsByIds,
  elementTeamIds,
  environmentsOf,
  membersOf,
  portsOf,
  setProductMonitor,
  stepsOfElements,
  type ElementRow,
  type ProductRow,
} from './store.js';

/**
 * _Create monitor_ and _Update monitor_ on a product (ADR 0036 part 10, decision 17) – the pattern of the Insights Hub
 * mapping: a **disabled draft** monitor for review, never enabled by Steward, for one environment (production first):
 *
 *   - a `data-element` freshness check per element that supports one – output-port elements first (critical, the
 *     port's freshness objective as the maximum age), then the pipeline's internal and input elements (not critical:
 *     they only degrade the monitor; the smallest output objective, else a day);
 *   - a schema check per element of an output binding with a contract, and a `data-contract` check in `findings` mode
 *     per contract (while the data contracts module is on);
 *   - existing checks that watch an element (linked, or found by their fields) are not repeated – found ones are linked;
 *   - **soft links along the steps** – an upstream element's check → the next checked element downstream – so a stale
 *     raw table explains a stale mart as its root cause, and only the root cause alerts;
 *   - at most 100 checks (the monitor limit): beyond, the output ports and the layer before them, and what was left out
 *     is said.
 *
 * _Update monitor_ proposes the checks for elements added since (the same rules, against the monitor's checks) and adds
 * them when applied by a person. The checks are linked to their elements when they are made (`made`).
 */

const DEFAULT_MAX_AGE = 1440;
const ROLE_ORDER: Record<DataMemberRole, number> = { output: 0, internal: 1, input: 2 };

interface Planned extends DataMonitorDraftCheck {
  def: CheckDef;
  /** Priority within the limit: output, contract, the layer before outputs, the rest */
  rank: number;
}

interface Plan {
  product: ProductRow;
  environment: string;
  monitor: { id: string; key: string; name: string; enabled: boolean; definition: MonitorDefinition; version: number } | null;
  monitorHidden: boolean;
  checks: Planned[];
  links: { from: string; to: string }[];
  skipped: Map<DataMonitorSkipReason, { id: string; name: string }[]>;
  found: ReturnType<typeof findChecks>;
  canApply: boolean;
}

const elementName = (e: ElementRow) => e.display_name || e.qualified_name;

/** A check id from a prefix and a name, unique among `taken` (letters, digits, _ and -; at most 48). */
function checkId(prefix: string, name: string, taken: Set<string>): string {
  const base = `${prefix}-${slugify(name)}`.slice(0, 44);
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}

/** The environment of the draft: the one asked for, else production, else the product's first. */
function environmentOf(productId: string, asked: string | undefined, elementEnvs: string[]): string {
  if (asked) return asked;
  const envs = environmentsOf([productId]).map((e) => e.environment);
  const env = defaultEnvironment(envs.length ? envs : elementEnvs.filter(Boolean));
  if (!env) throw new HttpError(409, 'The data product has no elements to watch', 'DATA_PRODUCT_MONITOR_EMPTY', { context: 'noElements' });
  return env;
}

/** The plan of the draft (or of the checks to add): nothing is written. */
function plan(u: AuthUser, product: ProductRow, asked: string | undefined): Plan {
  const members = membersOf([product.id]);
  const ports = portsOf([product.id]).filter((p) => p.direction === 'output');
  const bindings = bindingsOf(ports.map((p) => p.id));
  const all = elementsByIds([...members.map((m) => m.element_id), ...bindings.flatMap((b) => b.elementIds)]);
  const environment = environmentOf(
    product.id,
    asked,
    [...all.values()].map((e) => e.environment),
  );
  const envBindings = bindings.filter((b) => b.environment === environment);
  // roles in this environment: bound to an output port, else the membership's role
  const role = new Map<string, DataMemberRole>();
  for (const m of members) if (all.get(m.element_id)?.environment === environment) role.set(m.element_id, m.role);
  for (const b of envBindings) for (const e of b.elementIds) if (all.get(e)?.environment === environment) role.set(e, 'output');
  const teams = elementTeamIds([...role.keys()]);
  const skipped = new Map<DataMonitorSkipReason, { id: string; name: string }[]>();
  const skip = (reason: DataMonitorSkipReason, e: { id: string; name: string }) => skipped.set(reason, [...(skipped.get(reason) ?? []), e]);
  const visible: ElementRow[] = [];
  for (const id of role.keys()) {
    const e = all.get(id)!;
    if (elementAccess(u, teams.get(id) ?? []).permissions.includes('view')) visible.push(e);
    // an element the person may not see is left out and counted, never named
    else skip('hidden', { id: '', name: '' });
  }
  visible.sort((a, b) => ROLE_ORDER[role.get(a.id)!] - ROLE_ORDER[role.get(b.id)!] || a.name_norm.localeCompare(b.name_norm));

  // the product's monitor in this environment
  const envRow = environmentsOf([product.id]).find((e) => e.environment === environment);
  const mrow = envRow?.monitor_id ? monitorRow(envRow.monitor_id) : undefined;
  const monitorVisible = !!mrow && permissionsOfRow(mrow, u).includes('view');
  const monitor =
    mrow && monitorVisible
      ? {
          id: mrow.id,
          key: mrow.key,
          name: mrow.name,
          enabled: !!mrow.enabled,
          definition: parseJson<MonitorDefinition>(mrow.definition, {} as MonitorDefinition),
          version: mrow.version,
        }
      : null;
  const existing = monitor?.definition.checks ?? [];
  const taken = new Set(existing.map((c) => c.id));

  // what watches each element already: stored links and checks found by their fields
  const links = checkLinksOf(visible.map((e) => e.id));
  const found = findChecks(visible);
  const watchedBy = new Map<string, { monitorId: string; checkId: string; purpose: string }[]>();
  for (const l of links)
    if (l.element_id)
      watchedBy.set(l.element_id, [...(watchedBy.get(l.element_id) ?? []), { monitorId: l.monitor_id, checkId: l.check_id, purpose: l.purpose }]);
  for (const f of found)
    watchedBy.set(f.elementId, [...(watchedBy.get(f.elementId) ?? []), { monitorId: f.monitorId, checkId: f.checkId, purpose: f.purpose }]);
  const monitorIds = new Set([...links.map((l) => l.monitor_id), ...found.map((f) => f.monitorId)]);
  const liveMonitors = new Set(
    [...monitorIds].filter((id) => {
      const r = monitorRow(id);
      return !!r && !r.is_template;
    }),
  );
  const inProductMonitor = (eid: string, purpose: string) =>
    (watchedBy.get(eid) ?? []).find((w) => monitor && w.monitorId === monitor.id && w.purpose === purpose && existing.some((c) => c.id === w.checkId));
  const elsewhere = (eid: string, purpose: string) =>
    (watchedBy.get(eid) ?? []).some((w) => (!monitor || w.monitorId !== monitor.id) && w.purpose === purpose && liveMonitors.has(w.monitorId));

  // freshness objectives of the output ports in this environment (the binding's override the port's)
  const objective = new Map<string, number>();
  for (const b of envBindings) {
    const port = ports.find((p) => p.id === b.port_id)!;
    const o = { ...parseJson<DataObjectives>(port.objectives, {}), ...stripNull(parseJson<DataObjectives>(b.objectives, {})) };
    if (!o.freshnessMinutes) continue;
    for (const e of b.elementIds) objective.set(e, Math.min(objective.get(e) ?? Infinity, o.freshnessMinutes));
  }
  const smallest = objective.size ? Math.min(...objective.values()) : DEFAULT_MAX_AGE;

  // the steps between the visible elements: what is one step before an output (the layer before)
  const { ends } = stepsOfElements(visible.map((e) => e.id));
  const downstream = new Map<string, Set<string>>();
  const byStep = new Map<string, { ins: string[]; outs: string[] }>();
  for (const e of ends) {
    const s = byStep.get(e.step_id) ?? { ins: [], outs: [] };
    (e.direction === 'in' ? s.ins : s.outs).push(e.element_id);
    byStep.set(e.step_id, s);
  }
  for (const s of byStep.values()) for (const i of s.ins) for (const o of s.outs) if (i !== o) downstream.set(i, (downstream.get(i) ?? new Set()).add(o));
  const beforeOutput = new Set([...downstream].filter(([, outs]) => [...outs].some((o) => role.get(o) === 'output')).map(([i]) => i));

  const checks: Planned[] = [];
  const freshnessOf = new Map<string, string>();
  for (const e of visible) {
    const r = role.get(e.id)!;
    const modes = elementCheckModes(e.kind);
    const have = inProductMonitor(e.id, 'freshness');
    if (have) {
      freshnessOf.set(e.id, have.checkId);
      continue;
    }
    if (!modes.includes('freshness')) {
      if (!modes.includes('schema') || r !== 'output') skip('unsupported', { id: e.id, name: elementName(e) });
      continue;
    }
    if (elsewhere(e.id, 'freshness')) {
      skip('watched', { id: e.id, name: elementName(e) });
      continue;
    }
    const maxAge = r === 'output' ? (objective.get(e.id) ?? DEFAULT_MAX_AGE) : smallest;
    const id = checkId('fresh', e.qualified_name, taken);
    freshnessOf.set(e.id, id);
    const critical = r === 'output';
    checks.push({
      id,
      name: `${elementName(e)} fresh`.slice(0, 120),
      type: 'data-element',
      mode: 'freshness',
      elementId: e.id,
      elementName: elementName(e),
      role: r,
      critical,
      maxAgeMinutes: maxAge,
      contractId: null,
      rank: r === 'output' ? 0 : beforeOutput.has(e.id) ? 3 : 4,
      def: {
        id,
        name: `${elementName(e)} fresh`.slice(0, 120),
        type: 'data-element',
        element: e.id,
        mode: 'freshness',
        maxAgeMinutes: maxAge,
        each: 'any',
        failAs: 'down',
        warningAs: 'degraded',
        ...(critical ? {} : { critical: false }),
      } as CheckDef,
    });
  }
  // schema checks: elements of output bindings with a contract
  const contracts = new Set<string>();
  for (const b of envBindings) {
    if (!b.contract_id) continue;
    contracts.add(b.contract_id);
    for (const eid of b.elementIds) {
      const e = visible.find((x) => x.id === eid);
      if (!e || !elementCheckModes(e.kind).includes('schema') || inProductMonitor(e.id, 'schema') || elsewhere(e.id, 'schema')) continue;
      if (checks.some((c) => c.mode === 'schema' && c.elementId === e.id)) continue;
      const id = checkId('schema', e.qualified_name, taken);
      checks.push({
        id,
        name: `${elementName(e)} matches its contract`.slice(0, 120),
        type: 'data-element',
        mode: 'schema',
        elementId: e.id,
        elementName: elementName(e),
        role: 'output',
        critical: true,
        maxAgeMinutes: null,
        contractId: b.contract_id,
        rank: 1,
        def: {
          id,
          name: `${elementName(e)} matches its contract`.slice(0, 120),
          type: 'data-element',
          element: e.id,
          mode: 'schema',
          each: 'any',
          failAs: 'down',
          warningAs: 'degraded',
        } as CheckDef,
      });
    }
  }
  // a data contract check per contract, while the data contracts module is on (contracts the person may see)
  if (contracts.size && !moduleEnabled('dataContracts')) skip('noContractModule', { id: '', name: '' });
  else
    for (const cid of contracts) {
      const row = db().get<{ id: string; name: string }>('SELECT id, name FROM data_contracts WHERE id = ?', cid);
      if (!row || !contractVisible(u, row.id)) continue;
      if (existing.some((c) => c.type === 'data-contract' && c.contract === row.id)) continue;
      const id = checkId('contract', row.name, taken);
      checks.push({
        id,
        name: `Contract ${row.name} holds`.slice(0, 120),
        type: 'data-contract',
        mode: 'findings',
        elementId: null,
        elementName: null,
        role: null,
        critical: true,
        maxAgeMinutes: null,
        contractId: row.id,
        rank: 2,
        def: {
          id,
          name: `Contract ${row.name} holds`.slice(0, 120),
          type: 'data-contract',
          contract: row.id,
          mode: 'findings',
          testedWithinDays: 7,
          failAs: 'down',
          warningAs: 'degraded',
        } as CheckDef,
      });
    }

  // the monitor limit: output ports and the layer before them first
  const room = L.draftMonitorChecks - existing.length;
  const ranked = [...checks].sort((a, b) => a.rank - b.rank);
  const kept = new Set(ranked.slice(0, Math.max(0, room)).map((c) => c.id));
  for (const c of ranked.slice(Math.max(0, room)))
    if (c.elementId) {
      skip('limit', { id: c.elementId, name: c.elementName ?? '' });
      if (freshnessOf.get(c.elementId) === c.id) freshnessOf.delete(c.elementId);
    }
  const chosen = checks.filter((c) => kept.has(c.id));

  // soft links along the steps: an element's freshness check → the next checked element downstream (through unchecked ones)
  const existingLinks = new Set((monitor?.definition.links ?? []).map((l) => `${l.from}|${l.to}`));
  const newIds = new Set(chosen.map((c) => c.id));
  const graph = new Map<string, Set<string>>();
  for (const l of monitor?.definition.links ?? []) graph.set(l.from, (graph.get(l.from) ?? new Set()).add(l.to));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === to) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of graph.get(x) ?? []) stack.push(y);
    }
    return false;
  };
  const out: { from: string; to: string }[] = [];
  for (const e of visible) {
    const from = freshnessOf.get(e.id);
    if (!from) continue;
    // the nearest checked elements downstream (a bounded walk)
    const targets = new Set<string>();
    const seen = new Set<string>([e.id]);
    let frontier = [...(downstream.get(e.id) ?? [])];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const next: string[] = [];
      for (const d of frontier) {
        if (seen.has(d)) continue;
        seen.add(d);
        const to = freshnessOf.get(d);
        if (to) targets.add(to);
        else next.push(...(downstream.get(d) ?? []));
      }
      frontier = next;
    }
    for (const to of targets) {
      if (to === from || existingLinks.has(`${from}|${to}`)) continue;
      // only links that touch a new check (Update monitor never rewires what a person arranged), never a cycle
      if (!newIds.has(from) && !newIds.has(to)) continue;
      if (reaches(to, from)) continue;
      graph.set(from, (graph.get(from) ?? new Set()).add(to));
      existingLinks.add(`${from}|${to}`);
      out.push({ from, to });
    }
  }
  const productPerms = visibleProduct(product.id, u).perms;
  const canApply =
    productPerms.includes('edit') && (monitor ? permissionsOfRow(mrow!, u).includes('edit') : !mrow && canCreateMonitors(u)) && chosen.length > 0;
  return {
    product,
    environment,
    monitor,
    monitorHidden: !!mrow && !monitorVisible,
    checks: chosen,
    links: out,
    skipped,
    found,
    canApply,
  };
}

const stripNull = (o: DataObjectives): DataObjectives =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as DataObjectives;

/** The data contracts module's own rule (datacontracts/service.ts), as the person. */
const contractVisible = (u: AuthUser, id: string): boolean => contractPermissionsOf({ id }, u).includes('view');

function proposalOf(p: Plan): DataMonitorProposal {
  return {
    productId: p.product.id,
    environment: p.environment,
    monitor: p.monitor ? { id: p.monitor.id, key: p.monitor.key, name: p.monitor.name, enabled: p.monitor.enabled } : null,
    monitorHidden: p.monitorHidden,
    checks: p.checks.map(({ def: _def, rank: _rank, ...c }) => c),
    links: p.links,
    skipped: [...p.skipped].map(([reason, list]) => ({
      reason,
      count: list.length,
      elements: list.filter((e) => e.id).slice(0, 20),
    })),
    canApply: p.canApply,
  };
}

/** GET /api/data-products/:id/monitor?environment= – what Create monitor would make, or what Update monitor would add. */
export function monitorProposal(productId: string, query: unknown): DataMonitorProposal {
  const u = me();
  const { row } = visibleProduct(productId, u);
  const q = dataMonitorInput.pick({ environment: true }).parse(query ?? {});
  return proposalOf(plan(u, row, q.environment));
}

/** POST /api/data-products/:id/monitor – creates the disabled draft, or adds the proposed checks to the product's monitor. */
export async function applyMonitor(productId: string, body: unknown): Promise<DataMonitorResult> {
  const u = me();
  const { row: product } = editableProduct(productId);
  const input = dataMonitorInput.parse(body ?? {});
  const p = plan(u, product, input.environment);
  if (p.monitorHidden) throw new HttpError(403, 'The data product’s monitor is one you may not see', 'FORBIDDEN', { context: 'right_edit' });
  if (!p.checks.length)
    throw new HttpError(409, 'Every element is watched already, or none can be read – nothing to add', 'DATA_PRODUCT_MONITOR_EMPTY', {
      context: 'nothingToAdd',
    });
  const svc = await import('../monitors/service.js');
  const engine = await import('../monitors/engine.js');
  const at = nowIso();
  let result!: { id: string; key: string; name: string; enabled: boolean };
  const created = !p.monitor;
  db().tx(() => {
    if (!p.monitor) {
      const definition = {
        name: input.name ?? `${product.name} (${p.environment})`.slice(0, 160),
        description: [
          `Draft made from the data product "${product.name}" (${product.key}) in ${p.environment}: a freshness check per element along its pipeline, a schema check per output port element with a data contract, and the contracts' findings.`,
          'Checks of output ports are critical; the others only degrade the monitor. Soft links follow the pipeline’s steps, so a stale upstream element is reported as the root cause of what is stale below it.',
          'Freshness is metadata (LAST_ALTERED moves on DDL and maintenance too): review the maximum ages, then enable it.',
        ].join('\n\n'),
        tags: ['data-product'],
        intervalSeconds: 900,
        aggregate: { rule: 'critical' },
        checks: layout(p.checks.map((c) => c.def)),
        links: p.links.map((l) => ({ ...l, mode: 'soft' })),
      };
      // never enabled here: a draft for review
      const saved = svc.createMonitorNow({ enabled: false, definition });
      result = { id: saved.monitor.id, key: saved.monitor.key, name: saved.monitor.name, enabled: saved.monitor.enabled };
      setProductMonitor(product.id, p.environment, saved.monitor.id, u.username);
    } else {
      const def = p.monitor.definition;
      const definition = {
        ...def,
        checks: [
          ...def.checks,
          ...layout(
            p.checks.map((c) => c.def),
            def.checks.length,
          ),
        ],
        links: [...(def.links ?? []), ...p.links.map((l) => ({ ...l, mode: 'soft' as const }))],
      };
      const saved = svc.updateMonitorNow(p.monitor.id, { definition, version: p.monitor.version });
      result = { id: saved.monitor.id, key: saved.monitor.key, name: saved.monitor.name, enabled: saved.monitor.enabled };
    }
    for (const c of p.checks)
      if (c.elementId)
        addCheckLink({
          element_id: c.elementId,
          step_id: null,
          monitor_id: result.id,
          check_id: c.id,
          purpose: c.mode === 'schema' ? 'schema' : 'freshness',
          origin: 'made',
          created_by: u.username,
          created_at: at,
        });
    storeFound(p.found, u.username);
    audit({
      action: 'dataproduct.monitor_created',
      entityType: 'data_product',
      entityId: product.id,
      summary: `${created ? `Monitor "${result.name}" created (disabled)` : `${p.checks.length} check(s) added to monitor "${result.name}"`} for data product "${product.name}" in ${p.environment}`,
      details: {
        monitor: result.id,
        environment: p.environment,
        created,
        checks: p.checks.map((c) => ({ id: c.id, mode: c.mode, element: c.elementId, contract: c.contractId })),
        links: p.links.length,
        skipped: Object.fromEntries([...p.skipped].map(([k, v]) => [k, v.length])),
      },
    });
  });
  engine.reloadMonitor(result.id);
  return {
    monitor: result,
    created,
    added: p.checks.length,
    linked: p.checks.filter((c) => c.elementId).length,
    proposal: monitorProposal(product.id, { environment: p.environment }),
  };
}

/** Positions of new cards: rows of four below what is there. */
function layout(defs: CheckDef[], offset = 0): CheckDef[] {
  return defs.map((d, i) => ({ ...d, x: ((offset + i) % 4) * 220, y: Math.floor((offset + i) / 4) * 160 }));
}
