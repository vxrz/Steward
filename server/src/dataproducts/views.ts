import {
  DATA_GRAPH_LIMITS,
  DEFAULT_DATA_LAYERS,
  elementShortName,
  isProductionEnvironment,
  lineageGraph,
  mapGraph,
  pipelineGraph,
  type AclEntry,
  type DataLineageView,
  type DataPipelineView,
  type DataProductLifecycle,
  type DataProductMapView,
  type DataProductType,
  type DataStepRunner,
  type GraphElementInput,
  type GraphProductInput,
  type GraphStepInput,
  type PlatformPermission,
  type ProcessPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { processPermissions } from '../auth/permissions.js';
import { platformAccess } from '../auth/policy.js';
import { canViewCatalogue } from '../records/access.js';
import { environmentList } from '../catalogue/environments.js';
import { parseJson } from '../util.js';
import { domainAccess, elementAccess, productAccess } from './access.js';
import { elementNotFound } from './common.js';
import { sortEnvironments, visibleProduct } from './service.js';
import {
  bindingsOf,
  chunks,
  elementRow,
  elementTeamIds,
  elementsByIds,
  environmentsOf,
  marks,
  membersOf,
  membershipsOfElements,
  portsOf,
  productsByIds,
  stepsAround,
  stepsOfElements,
  type ElementRow,
  type StepElementRow,
  type StepRow,
} from './store.js';
import { elementHealth, productHealth } from './views-health.js';
import { technologyOf } from './technologies.js';
import { openProposalsAround } from './lineage/proposals.js';

/**
 * The pictures of the data products module (ADR 0036 part 13, WP6): the pipeline of a product, the product map and the
 * lineage of an element. Each reads what it shows in bulk – a fixed number of statements whatever the number of
 * members, steps or products (IN lists chunked by the store) – applies the reader's rights (team scope: what they may
 * not see stays in the graph without a name or id and is counted) and hands plain rows to the builders of
 * shared/src/dataProductGraph.ts. Health comes through views-health.ts (WP3's seam).
 */

/** Rows of `sql` (ending with `IN (`…`)`) for these ids, chunked. */
function inChunks<T>(sql: (m: string) => string, ids: readonly string[]): T[] {
  const uniq = [...new Set(ids)];
  return chunks(uniq).flatMap((part) => db().all<T>(sql(marks(part.length)), ...part));
}

// ---------- elements as the reader sees them ----------

/**
 * The elements of `rows` for a builder: whether the reader may see each (owning teams in bulk), the products each is
 * part of (visible: named; hidden: counted by id, never handed out), the parent's name for collapsing.
 */
function graphElements(u: AuthUser | null, rows: ReadonlyMap<string, ElementRow>, exceptProduct?: string): Map<string, GraphElementInput> {
  const ids = [...rows.keys()];
  const teams = elementTeamIds(ids);
  const ms = membershipsOfElements(ids);
  const prods = productsByIds(ms.map((m) => m.product_id));
  const sees = new Map([...prods.values()].map((p) => [p.id, productAccess(u, p).permissions.length > 0]));
  const productsOf = new Map<string, { visible: { id: string; name: string }[]; hidden: string[] }>();
  for (const m of ms) {
    if (m.product_id === exceptProduct) continue;
    const p = prods.get(m.product_id);
    if (!p) continue;
    const cur = productsOf.get(m.element_id) ?? { visible: [], hidden: [] };
    if (sees.get(p.id)) cur.visible.push({ id: p.id, name: p.name });
    else cur.hidden.push(p.id);
    productsOf.set(m.element_id, cur);
  }
  const out = new Map<string, GraphElementInput>();
  for (const r of rows.values()) {
    const visible = elementAccess(u, teams.get(r.id) ?? []).permissions.length > 0;
    const p = productsOf.get(r.id);
    const dot = r.qualified_name.lastIndexOf('.');
    out.set(r.id, {
      id: r.id,
      kind: r.kind,
      qualifiedName: r.qualified_name,
      displayName: r.display_name,
      layer: r.layer,
      environment: r.environment,
      missing: !!r.missing_since,
      visible,
      linkable: visible,
      products: (p?.visible ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      hiddenProductIds: p?.hidden ?? [],
      // the parent (a schema, a bundle) by the qualified name: no read of the parent needed
      parentName: r.parent_id && dot > 0 ? elementShortName(r.qualified_name.slice(0, dot)) : null,
      // 0.25.0: a generic part's technology from the list (kept in memory: no statement of its own)
      technology: r.technology ? graphTechnology(r.technology) : null,
    });
  }
  return out;
}

/** A technology as the pictures draw it: the list's name and icon, or the value as typed (not in the list). */
function graphTechnology(value: string): { name: string; icon: string; listed: boolean } {
  const t = technologyOf(value);
  return t ? { name: t.name, icon: t.icon, listed: true } : { name: value, icon: 'other', listed: false };
}

/** The runners of these steps in words, in bulk (an application, platform, process or element the reader may not see: null). */
function runnerTexts(
  u: AuthUser | null,
  steps: readonly Pick<StepRow, 'id' | 'runner'>[],
  visibleElements: ReadonlyMap<string, GraphElementInput>,
): Map<string, string | null> {
  const parsed = steps.map((s) => ({ id: s.id, r: parseJson<DataStepRunner | null>(s.runner, null) }));
  const want = (k: DataStepRunner['kind']) =>
    parsed.flatMap((x) => (x.r && x.r.kind === k ? [x.r.kind === 'connector' ? x.r.platformId : 'id' in x.r ? x.r.id : ''] : [])).filter(Boolean);
  const platforms = new Map(
    inChunks<{ id: string; name: string; acl: string }>(
      (m) => `SELECT id, name, acl FROM platforms WHERE id IN (${m})`,
      [...want('platform'), ...want('connector')],
    )
      .filter((p) => platformAccess(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).permissions.length > 0)
      .map((p) => [p.id, p.name]),
  );
  const apps = new Map(
    inChunks<{ id: string; name: string; owners: string }>((m) => `SELECT id, name, owners FROM applications WHERE id IN (${m})`, want('application'))
      .filter((a) => canViewCatalogue(u, { kind: 'application', id: a.id, owners: parseJson<string[]>(a.owners, []) }))
      .map((a) => [a.id, a.name]),
  );
  const procs = new Map(
    inChunks<{ id: string; name: string; owner: string | null; acl: string }>(
      (m) => `SELECT id, name, owner, acl FROM processes WHERE id IN (${m})`,
      want('process'),
    )
      .filter((p) => processPermissions(u, { id: p.id, owner: p.owner, acl: parseJson<AclEntry<ProcessPermission>[]>(p.acl, []) }).includes('view'))
      .map((p) => [p.id, p.name]),
  );
  const elementIds = want('element').filter((id) => !visibleElements.has(id));
  const extra = elementIds.length ? graphElements(u, elementsByIds(elementIds)) : new Map<string, GraphElementInput>();
  const elementName = (id: string): string | null => {
    const e = visibleElements.get(id) ?? extra.get(id);
    return e?.visible ? e.qualifiedName : null;
  };
  const text = (r: DataStepRunner): string | null => {
    if (r.kind === 'tool') return [r.tool, r.text].filter(Boolean).join(' – ') || null;
    if (r.kind === 'connector') return platforms.has(r.platformId) ? `${r.name} (${platforms.get(r.platformId)})` : null;
    if (r.kind === 'platform') return platforms.get(r.id) ?? null;
    if (r.kind === 'application') return apps.get(r.id) ?? null;
    if (r.kind === 'process') return procs.get(r.id) ?? null;
    return elementName(r.id);
  };
  return new Map(
    parsed.map(({ id, r }) => {
      if (!r) return [id, null];
      const t = text(r);
      // 0.25.0: a bridge's runner names its technology first – "Debezium · shop-cdc (Kafka Connect (demo))"
      const tech = t && r.technology ? graphTechnology(r.technology).name : null;
      return [id, t && tech && !t.toLowerCase().startsWith(tech.toLowerCase()) ? `${tech} · ${t}` : t];
    }),
  );
}

function stepInputs(steps: readonly StepRow[], ends: readonly StepElementRow[], runners: ReadonlyMap<string, string | null>): GraphStepInput[] {
  const by = new Map<string, StepElementRow[]>();
  for (const e of ends) by.set(e.step_id, [...(by.get(e.step_id) ?? []), e]);
  return steps.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.step_kind,
    runner: runners.get(s.id) ?? null,
    inputs: (by.get(s.id) ?? []).filter((e) => e.direction === 'in').map((e) => e.element_id),
    outputs: (by.get(s.id) ?? []).filter((e) => e.direction === 'out').map((e) => e.element_id),
  }));
}

/** The layers of the columns: the defaults (Settings → Data products → Layers, WP5), then layers the elements name. */
function layersOf(rows: Iterable<ElementRow>): string[] {
  const out: string[] = [...DEFAULT_DATA_LAYERS];
  const more = new Set<string>();
  for (const r of rows) if (r.layer && !out.includes(r.layer)) more.add(r.layer);
  return [...out, ...[...more].sort((a, b) => a.localeCompare(b))];
}

// ---------- 1. the pipeline of a product ----------

/**
 * The pipeline of a product in an environment (default: its first, production first): members in columns by role and
 * layer, the neighbours its steps read from or write to, the steps between them, health on the elements.
 */
export function pipelineView(productId: string, environment?: string): DataPipelineView {
  const u = me();
  const { row } = visibleProduct(productId, u);
  const list = environmentList();
  const members = membersOf([row.id]);
  const memberRows = elementsByIds(members.map((m) => m.element_id));
  const environments = sortEnvironments(
    [...environmentsOf([row.id]).map((e) => e.environment), ...[...memberRows.values()].map((e) => e.environment)].filter(Boolean),
    list,
  );
  const env = environment ?? environments[0] ?? '';
  const inEnv = members.filter((m) => memberRows.get(m.element_id)?.environment === env);
  const memberIds = inEnv.map((m) => m.element_id);
  // the ports that expose or take each member in this environment
  const ports = portsOf([row.id]);
  const portName = new Map(ports.map((p) => [p.id, [p.name, p.version].filter(Boolean).join(' ')]));
  const portsOfElement = new Map<string, string[]>();
  for (const b of bindingsOf(ports.map((p) => p.id)))
    if (b.environment === env) for (const e of b.elementIds) portsOfElement.set(e, [...(portsOfElement.get(e) ?? []), portName.get(b.port_id) ?? '']);
  // the steps that read or write the members, and the elements outside the product they touch
  const { steps, ends } = stepsOfElements(memberIds);
  const memberSet = new Set(memberIds);
  const neighbourRows = elementsByIds(ends.map((e) => e.element_id).filter((id) => !memberSet.has(id)));
  const rows = new Map<string, ElementRow>([...memberIds.map((id) => [id, memberRows.get(id)!] as const), ...neighbourRows]);
  const elements = graphElements(u, rows, row.id);
  const health = elementHealth(
    u,
    [...rows.keys()].filter((id) => memberSet.has(id) || elements.get(id)?.visible),
    env,
  );
  const graph = pipelineGraph({
    layers: layersOf(rows.values()),
    members: inEnv.map((m) => ({ elementId: m.element_id, role: m.role, ports: portsOfElement.get(m.element_id) ?? [] })),
    elements,
    steps: stepInputs(steps, ends, runnerTexts(u, steps, elements)),
    health,
  });
  return {
    view: 'pipeline',
    product: { id: row.id, key: row.key, name: row.name },
    environment: env,
    environments: environments.includes(env) || !env ? environments : [...environments, env],
    ...graph,
  };
}

// ---------- 2. the product map ----------

export interface MapQuery {
  environment?: string;
  domain?: string;
  type?: DataProductType;
  lifecycle?: DataProductLifecycle;
  q?: string;
}

/**
 * The product map: every product the reader may see that matches the filters, the products their input ports consume
 * from and the products that consume theirs (drawn as neighbours), dependencies from output port to input port, domains
 * as areas. Products the reader may not see are drawn without a name where a visible one depends on them.
 */
export function mapView(q: MapQuery): DataProductMapView {
  const u = me();
  const list = environmentList();
  const all = db().all<{
    id: string;
    key: string;
    name: string;
    name_norm: string;
    owners: string;
    domain_id: string | null;
    type: string | null;
    lifecycle: string;
  }>('SELECT id, key, name, name_norm, owners, domain_id, type, lifecycle FROM dp_products');
  const visible = all.filter((p) => productAccess(u, p).permissions.length > 0);
  const visibleIds = new Set(visible.map((p) => p.id));
  const domains = db()
    .all<{ id: string; name: string; parent_id: string | null; owners: string }>('SELECT id, name, parent_id, owners FROM dp_domains ORDER BY name, id')
    .filter((d) => domainAccess(u, d).permissions.length > 0);
  const domainIds = new Set(domains.map((d) => d.id));
  const envRows = db().all<{ product_id: string; environment: string }>('SELECT product_id, environment FROM dp_product_environments');
  const envsOf = new Map<string, Set<string>>();
  for (const e of envRows) if (visibleIds.has(e.product_id)) envsOf.set(e.product_id, new Set([...(envsOf.get(e.product_id) ?? []), e.environment]));
  const environments = sortEnvironments(
    [...envsOf.values()].flatMap((s) => [...s]),
    list,
  );
  // the filters: a domain includes its sub-domains
  const inDomain = q.domain ? new Set([q.domain, ...domains.filter((d) => d.parent_id === q.domain).map((d) => d.id)]) : null;
  const text = q.q?.trim().toLowerCase();
  const matching = new Set(
    visible
      .filter(
        (p) =>
          (!inDomain || (p.domain_id !== null && inDomain.has(p.domain_id))) &&
          (!q.type || p.type === q.type) &&
          (!q.lifecycle || p.lifecycle === q.lifecycle) &&
          (!q.environment || !!envsOf.get(p.id)?.has(q.environment)) &&
          (!text || p.name_norm.includes(text) || p.key.includes(text)),
      )
      .map((p) => p.id),
  );
  // dependencies: an input port that names another product's output port as its source
  const deps = db().all<{ to_product: string; from_product: string; port: string; version: string; lifecycle: string }>(
    `SELECT i.product_id AS to_product, o.product_id AS from_product, o.name AS port, o.version AS version, o.lifecycle AS lifecycle
       FROM dp_ports i JOIN dp_ports o ON o.id = i.source_port_id
      WHERE i.direction = 'input' AND i.source_kind = 'port'`,
  );
  const side = (id: string): string | { hidden: string } => (visibleIds.has(id) ? id : { hidden: id });
  const healthEnv = q.environment ?? environments.find((e) => isProductionEnvironment(list, e)) ?? environments[0] ?? '';
  const health = productHealth(u, [...matching], healthEnv);
  const products: GraphProductInput[] = visible.map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    type: (p.type as DataProductType | null) ?? null,
    lifecycle: p.lifecycle as DataProductLifecycle,
    domainId: p.domain_id && domainIds.has(p.domain_id) ? p.domain_id : null,
    health: health.get(p.id) ?? 'noData',
  }));
  const graph = mapGraph({
    products,
    matching,
    domains: domains.map((d) => ({ id: d.id, name: d.name, parentId: d.parent_id && domainIds.has(d.parent_id) ? d.parent_id : null })),
    dependencies: deps.map((d) => ({
      from: side(d.from_product),
      to: side(d.to_product),
      port: [d.port, d.version].filter(Boolean).join(' '),
      deprecated: d.lifecycle === 'deprecated' || d.lifecycle === 'retired',
    })),
  });
  return {
    view: 'map',
    environment: q.environment ?? null,
    options: {
      environments,
      domains: domains.map((d) => ({ id: d.id, name: d.name, parentId: d.parent_id && domainIds.has(d.parent_id) ? d.parent_id : null })),
    },
    ...graph,
  };
}

// ---------- 3. the lineage of an element ----------

/** Plant collections that write to these elements (ADR 0036 part 9): named where the reader may see the site. */
async function plantSinks(rows: Iterable<ElementRow>): Promise<{ elementId: string; label: string | null; path: string | null }[]> {
  const linked = [...rows].filter((r) => r.plant_sink).slice(0, DATA_GRAPH_LIMITS.plantSinks);
  if (!linked.length) return [];
  // loaded when needed: the plant registry is a module of its own
  const { plantEnabled } = await import('../plant/settings.js');
  if (!plantEnabled()) return [];
  const { visibleAsset } = await import('../plant/service.js');
  const { collectionRowOf } = await import('../plant/collections-model.js');
  return linked.map((r) => {
    const sink = parseJson<{ assetId?: string; collectionId?: string } | null>(r.plant_sink, null);
    try {
      const { row: asset } = visibleAsset(sink?.assetId ?? '');
      const c = sink?.collectionId ? collectionRowOf(asset.id, sink.collectionId) : undefined;
      return {
        elementId: r.id,
        label: [c?.name, asset.name].filter(Boolean).join(' – '),
        path: `/plant/assets/${encodeURIComponent(asset.id)}/collections`,
      };
    } catch {
      return { elementId: r.id, label: null, path: null };
    }
  });
}

/** The lineage of an element: upstream and downstream `depth` steps (1–4), products as areas, plant collections. */
export async function lineageView(elementId: string, depth: number): Promise<DataLineageView> {
  const u = me();
  const focus = elementRow(elementId);
  if (!focus || !elementAccess(u, elementTeamIds([focus.id]).get(focus.id) ?? []).permissions.length) throw elementNotFound(elementId);
  const d = Math.max(1, Math.min(depth, DATA_GRAPH_LIMITS.lineageDepth));
  const around = stepsAround([focus.id], d, DATA_GRAPH_LIMITS.lineageNodes);
  // 0.24.0: open proposals of lineage sources between these elements, and their other ends one step further – drawn as
  // proposed ways beside the documented ones (sources the reader may not see are left out; elements as for steps)
  const distances = new Map(around.elements.map((e) => [e.id, e.distance]));
  const proposed = openProposalsAround([...distances.keys()]);
  for (const p of proposed)
    for (const o of p.outputs)
      for (const i of p.inputs) {
        if (distances.size >= DATA_GRAPH_LIMITS.lineageNodes) break;
        if (distances.has(o) && !distances.has(i) && Math.abs(distances.get(o)! - 1) <= d) distances.set(i, distances.get(o)! - 1);
        if (distances.has(i) && !distances.has(o) && Math.abs(distances.get(i)! + 1) <= d) distances.set(o, distances.get(i)! + 1);
      }
  const rows = elementsByIds([...distances.keys()]);
  const elements = graphElements(u, rows);
  const stepRows = inChunks<Pick<StepRow, 'id' | 'runner'>>(
    (m) => `SELECT id, runner FROM dp_steps WHERE id IN (${m})`,
    around.steps.map((s) => s.id),
  );
  const runners = runnerTexts(u, stepRows, elements);
  const health = elementHealth(
    u,
    [...elements.values()].filter((e) => e.visible).map((e) => e.id),
    focus.environment,
  );
  const graph = lineageGraph({
    focus: focus.id,
    distances,
    elements,
    steps: [
      ...around.steps.map((s) => ({ ...s, runner: runners.get(s.id) ?? null })),
      ...proposed.map((p) => ({
        id: `proposal:${p.id}`,
        name: p.name,
        kind: 'transform' as const,
        runner: p.tool,
        inputs: p.inputs,
        outputs: p.outputs,
        proposed: true,
      })),
    ],
    health,
    plant: await plantSinks(rows.values()),
    truncated: around.truncated,
  });
  return {
    view: 'lineage',
    element: { id: focus.id, name: focus.display_name || focus.qualified_name, qualifiedName: focus.qualified_name, environment: focus.environment },
    depth: d,
    ...graph,
  };
}
