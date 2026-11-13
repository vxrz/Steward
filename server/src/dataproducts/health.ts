import { worstStatus, type CatalogueEnvironment, type DataHealthStatus, type ElementHealth, type MonitorStatus, type ProductHealth } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { environmentList } from '../catalogue/environments.js';
import { db } from '../db.js';
import { loadedMonitor } from '../monitors/engine.js';
import { permissionsOfRow } from '../monitors/model.js';
import { sortEnvironments } from './service.js';
import {
  bindingsOf,
  checkLinksOf,
  chunks,
  elementsByIds,
  environmentsOf,
  marks,
  membersOf,
  portsOf,
  type CheckLinkRow,
  type ElementRow,
  type ProductEnvironmentRow,
} from './store.js';

/**
 * Health of elements and products (ADR 0036 part 10, decision 18) – from the **stored** check states, never a call to a
 * platform on a page load, in bulk: a fixed number of statements whatever the number of products or elements (one per
 * kind of fact and chunk of 500).
 *
 *   element   the worst status of its linked checks that run (enabled monitor and check); a check of a monitor the
 *             reader may not see counts by its status only (counted as hidden, never named); no running check: No data
 *   product   per environment: its monitor's status while that monitor runs; else the worst of its output-port
 *             elements in the environment, internal elements at most degrading (input elements are other products'
 *             or sources'); nothing linked: No data – never OK without a check
 *
 * `healthOf` and `elementHealthOf` are the module's API for the scorecard, notices, pictures, `/api/v1` and MCP (WP4,
 * WP6, WP7): they take the reader and decide nothing else about rights – callers pass products and elements the
 * reader may see (a product's member elements are shown as its content, decision 15).
 */

interface MonitorFacts {
  id: string;
  key: string;
  name: string;
  owner: string;
  acl: string;
  enabled: number;
  is_template: number;
  status: MonitorStatus | null;
  since: string | null;
}

/** The monitors with their aggregated state (one statement per chunk). */
export function monitorFacts(ids: readonly string[]): Map<string, MonitorFacts> {
  const uniq = [...new Set(ids)];
  const out = new Map<string, MonitorFacts>();
  for (const part of chunks(uniq))
    for (const r of db().all<MonitorFacts>(
      `SELECT m.id, m.key, m.name, m.owner, m.acl, m.enabled, m.is_template, s.status, s.since FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id WHERE m.id IN (${marks(part.length)})`,
      ...part,
    ))
      out.set(r.id, r);
  return out;
}

export interface CheckState {
  status: MonitorStatus;
  since: string | null;
  last_result: string | null;
}

/** The stored states of the checks of these monitors, by `monitor|check` (one statement per chunk). */
export function checkStates(monitorIds: readonly string[], withResult = false): Map<string, CheckState> {
  const out = new Map<string, CheckState>();
  for (const part of chunks([...new Set(monitorIds)]))
    for (const r of db().all<CheckState & { monitor_id: string; check_id: string }>(
      `SELECT monitor_id, check_id, status, since${withResult ? ', last_result' : ', NULL AS last_result'} FROM monitor_checks WHERE monitor_id IN (${marks(part.length)})`,
      ...part,
    ))
      out.set(`${r.monitor_id}|${r.check_id}`, r);
  return out;
}

/**
 * Whether a check counts: its monitor exists, is enabled and no template, and the check is in it and enabled. The
 * engine's loaded definition answers without a statement; a monitor it has not loaded counts a check by its stored row.
 */
export function checkRuns(m: MonitorFacts | undefined, checkId: string, states: Map<string, CheckState>): boolean {
  if (!m || !m.enabled || m.is_template) return false;
  const loaded = loadedMonitor(m.id);
  if (loaded) {
    const c = loaded.def.checks.find((x) => x.id === checkId);
    return !!c && c.enabled !== false;
  }
  return states.has(`${m.id}|${checkId}`);
}

/** A status for health: maintenance counts as up (alerts are silenced, the data is not stale because of it). */
const asHealth = (s: MonitorStatus): MonitorStatus => (s === 'maintenance' ? 'up' : s === 'blocked' ? 'unknown' : s);

/** The health of elements from their links (the links read by the caller, or here). */
function healthFromLinks(
  u: AuthUser | null,
  elementIds: readonly string[],
  links: CheckLinkRow[],
): { health: Map<string, ElementHealth>; monitors: Map<string, MonitorFacts>; states: Map<string, CheckState> } {
  const monitors = monitorFacts(links.map((l) => l.monitor_id));
  const states = checkStates([...monitors.keys()]);
  const visible = new Map<string, boolean>();
  const canView = (m: MonitorFacts) => {
    let v = visible.get(m.id);
    if (v === undefined) visible.set(m.id, (v = permissionsOfRow(m, u).includes('view')));
    return v;
  };
  const byElement = new Map<string, CheckLinkRow[]>();
  for (const l of links) if (l.element_id) byElement.set(l.element_id, [...(byElement.get(l.element_id) ?? []), l]);
  const health = new Map<string, ElementHealth>();
  for (const id of elementIds) {
    const seen = new Set<string>();
    const statuses: MonitorStatus[] = [];
    let shown = 0;
    let hidden = 0;
    for (const l of byElement.get(id) ?? []) {
      const key = `${l.monitor_id}|${l.check_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const m = monitors.get(l.monitor_id);
      if (!checkRuns(m, l.check_id, states)) continue;
      statuses.push(asHealth(states.get(key)?.status ?? 'unknown'));
      if (canView(m!)) shown++;
      else hidden++;
    }
    health.set(id, { elementId: id, status: statuses.length ? worstStatus(statuses) : 'noData', checks: { visible: shown, hidden } });
  }
  return { health, monitors, states };
}

/** Health of elements, by id (the reader decides which checks are named; statuses of hidden ones count). */
export function elementHealthOf(u: AuthUser | null, elementIds: readonly string[]): Map<string, ElementHealth> {
  const ids = [...new Set(elementIds)];
  return healthFromLinks(u, ids, checkLinksOf(ids)).health;
}

const RANK: Record<string, number> = { noData: -2, off: -1, up: 0, maintenance: 1, blocked: 2, unknown: 3, degraded: 4, down: 5 };
/** The worse of two health statuses (No data is the least: any status of a check says more). */
export const worseHealth = (a: DataHealthStatus, b: DataHealthStatus): DataHealthStatus => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

/** Internal elements only degrade a product (ADR 0036 part 10). */
const capped = (s: DataHealthStatus): DataHealthStatus => (s === 'down' ? 'degraded' : s);

/** The environment health is shown for when none is asked: production, else the product's first. */
export function defaultEnvironment(envs: readonly string[], list: CatalogueEnvironment[] = environmentList()): string | null {
  return sortEnvironments(envs, list)[0] ?? null;
}

/**
 * Health of products in an environment (null: each product's default – production, else its first environment).
 * Statements: environments, ports, bindings (two), members, elements, check links (one per chunk of 500 each), monitors
 * and check states – whatever the number of products.
 */
export function healthOf(u: AuthUser | null, productIds: readonly string[], environment: string | null = null): Map<string, ProductHealth> {
  const ids = [...new Set(productIds)];
  const out = new Map<string, ProductHealth>();
  if (!ids.length) return out;
  const envRows = environmentsOf(ids);
  const envsOf = new Map<string, ProductEnvironmentRow[]>();
  for (const e of envRows) envsOf.set(e.product_id, [...(envsOf.get(e.product_id) ?? []), e]);
  const ports = portsOf(ids).filter((p) => p.direction === 'output');
  const bindings = bindingsOf(ports.map((p) => p.id));
  const productOfPort = new Map(ports.map((p) => [p.id, p.product_id]));
  const members = membersOf(ids).filter((m) => m.role !== 'input');
  const elements = elementsByIds([...members.map((m) => m.element_id), ...bindings.flatMap((b) => b.elementIds)]);
  // the environment per product, and its elements there: output (bound to an output port there, or an output member) and internal
  const envOf = new Map<string, string | null>();
  // Settings → Environments, read once for all products
  const list = environment ? [] : environmentList();
  for (const id of ids) {
    const names = new Set((envsOf.get(id) ?? []).map((e) => e.environment));
    if (!names.size) for (const m of members) if (m.product_id === id) names.add(elements.get(m.element_id)?.environment ?? '');
    envOf.set(id, environment ?? defaultEnvironment([...names].filter(Boolean), list));
  }
  const outputs = new Map<string, Set<string>>();
  const internals = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, pid: string, eid: string) => map.set(pid, (map.get(pid) ?? new Set()).add(eid));
  const inEnv = (pid: string, el: ElementRow | undefined) => !!el && el.environment === envOf.get(pid);
  for (const b of bindings) {
    const pid = productOfPort.get(b.port_id)!;
    if (b.environment !== envOf.get(pid)) continue;
    for (const e of b.elementIds) if (inEnv(pid, elements.get(e))) add(outputs, pid, e);
  }
  for (const m of members) {
    if (!inEnv(m.product_id, elements.get(m.element_id))) continue;
    if (m.role === 'output') add(outputs, m.product_id, m.element_id);
    else if (!outputs.get(m.product_id)?.has(m.element_id)) add(internals, m.product_id, m.element_id);
  }
  const allElements = [...new Set([...outputs.values(), ...internals.values()].flatMap((s) => [...s]))];
  const monitorIds = new Map<string, string>();
  for (const id of ids) {
    const row = (envsOf.get(id) ?? []).find((e) => e.environment === envOf.get(id));
    if (row?.monitor_id) monitorIds.set(id, row.monitor_id);
  }
  const links = checkLinksOf(allElements);
  const { health, monitors: linked } = healthFromLinks(u, allElements, links);
  const missing = [...monitorIds.values()].filter((m) => !linked.has(m));
  const productMonitors = missing.length ? new Map([...linked, ...monitorFacts(missing)]) : linked;
  for (const id of ids) {
    const env = envOf.get(id) ?? '';
    const outs = [...(outputs.get(id) ?? [])].map((e) => health.get(e)!);
    const ins = [...(internals.get(id) ?? [])].map((e) => health.get(e)!);
    const els = [...outs, ...ins];
    let status: DataHealthStatus = 'noData';
    for (const h of outs) status = worseHealth(status, h.status);
    for (const h of ins) status = worseHealth(status, capped(h.status));
    let source: ProductHealth['source'] = status === 'noData' ? 'none' : 'elements';
    const m = productMonitors.get(monitorIds.get(id) ?? '');
    let monitorId: string | null = null;
    // the product's monitor while it runs; a disabled draft (Create monitor) does not speak for the product yet
    if (m && m.enabled && !m.is_template) {
      status = asHealth(m.status ?? 'unknown');
      source = 'monitor';
      // a monitor the reader may not see: its status only (as a check you may not see)
      monitorId = permissionsOfRow(m, u).includes('view') ? m.id : null;
    }
    out.set(id, { productId: id, environment: env, status, source, monitorId, elements: els });
  }
  return out;
}

/** Health of one product in each of its environments (production first). */
export function productHealthByEnvironment(u: AuthUser | null, productId: string): ProductHealth[] {
  const envs = sortEnvironments([...new Set(environmentsOf([productId]).map((e) => e.environment))]);
  if (!envs.length) return [...healthOf(u, [productId]).values()];
  return envs.map((env) => healthOf(u, [productId], env).get(productId)!);
}
