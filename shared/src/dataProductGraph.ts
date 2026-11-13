import {
  DATA_PRODUCT_LIMITS,
  worstHealth,
  type DataElementKind,
  type DataHealthStatus,
  type DataMemberRole,
  type DataProductLifecycle,
  type DataProductType,
  type DataStepKind,
} from './dataProducts.js';

/**
 * The pictures of the data products module (ADR 0036 part 13, WP6): a product's **pipeline**, the **product map** and
 * the **lineage** of an element. The server builds the graph with the reader's rights applied – what they may not see
 * stays in the graph without a name or an id (`hidden`), so the picture stays true, and is counted – and the web app
 * lays it out (the shared `layeredLayout` / `compoundLayout`, or the pipeline's columns), memoised. Large graphs are
 * collapsed for the picture by the functions here (elements by parent, then by column; products by domain); the table
 * beside every picture lists everything the response holds.
 *
 * The builders are pure: the server reads in bulk, decides what the reader may see, and hands them plain rows.
 */

// ---------- limits ----------

export const DATA_GRAPH_LIMITS = {
  /** Nodes one response holds at most (the table lists them; the rest are counted in `truncated`) */
  nodes: 2_000,
  /** The pipeline picture draws at most this many nodes: beyond, elements collapse by parent, then by column */
  pipelinePicture: 150,
  /** The map draws at most this many products: beyond, domains become nodes with counts */
  mapPicture: 300,
  /** Lineage: depth and nodes (stepsAround) */
  lineageDepth: DATA_PRODUCT_LIMITS.lineageDepth,
  lineageNodes: DATA_PRODUCT_LIMITS.lineageNodes,
  /** A step with more ways than this (inputs × outputs) is drawn as a node of its own, not as that many edges */
  stepFan: 16,
  /** Step or port names an edge carries (the rest counted) */
  edgeLabels: 5,
  /** Plant collections a lineage shows */
  plantSinks: 20,
} as const;

export const DATA_GRAPH_VIEWS = ['pipeline', 'map', 'lineage'] as const;
export type DataGraphView = (typeof DATA_GRAPH_VIEWS)[number];

// ---------- the graph ----------

/** element: an element of the catalogue; step: a step with many ends; product, domain: the map; collapsed: many as one; plant: a plant collection. */
export const DATA_GRAPH_NODE_KINDS = ['element', 'step', 'product', 'domain', 'collapsed', 'plant'] as const;
export type DataGraphNodeKind = (typeof DATA_GRAPH_NODE_KINDS)[number];

/** Where a pipeline node sits: upstream neighbours, input members, internal members by layer, output members, downstream neighbours. */
export const DATA_GRAPH_COLUMN_KINDS = ['upstream', 'input', 'layer', 'output', 'downstream'] as const;
export type DataGraphColumnKind = (typeof DATA_GRAPH_COLUMN_KINDS)[number];

export interface DataGraphColumn {
  index: number;
  kind: DataGraphColumnKind;
  /** kind layer: the layer's name ('' : internal elements without a layer) */
  layer?: string;
}

export interface DataGraphNode {
  id: string;
  kind: DataGraphNodeKind;
  /** Its name ('' when hidden; collapsed: the parent's or the column's name) */
  label: string;
  /** A second line: the qualified name, a product's key */
  detail: string;
  /** Something the reader may not see: drawn without a name, never linked */
  hidden?: boolean;
  /** The area it is drawn in (a product in the lineage, a domain on the map) */
  parent?: string;
  /** An area drawn around the nodes that name it as their parent */
  group?: boolean;
  /** Its page in the web app (null: none, or the reader may not open it) */
  path: string | null;
  /** Health from linked checks (null: this kind has none); never OK without a check */
  health: DataHealthStatus | null;
  /** Linked checks: those the reader may see, those they may not (counted by status only) */
  checks?: { visible: number; hidden: number };
  // ----- elements -----
  elementKind?: DataElementKind;
  layer?: string;
  environment?: string;
  /** Pipeline: the role of a member in the product */
  role?: DataMemberRole;
  /** Pipeline: a neighbour outside the product; map: a product outside the filters (drawn greyed) */
  outside?: boolean;
  /** Products it is part of that the reader may see (names), and how many they may not */
  products?: string[];
  hiddenProducts?: number;
  /** Pipeline: the ports that expose or take it */
  ports?: string[];
  /** Not found by the last discovery run */
  missing?: boolean;
  /** Lineage: steps from the element shown (negative: upstream) */
  distance?: number;
  /** Pipeline: the column it is drawn in (step nodes sit between columns: x.5) */
  column?: number;
  /** The parent element's name (a schema, a bundle): collapsing groups by it */
  parentName?: string;
  /**
   * 0.25.0 (ADR 0037 part 0): a generic part's technology – its name and icon from the technology list, or the value as
   * typed with `listed: false` (_not in the list_)
   */
  technology?: GraphTechnology;
  // ----- products (map) -----
  productType?: DataProductType | null;
  lifecycle?: DataProductLifecycle;
  /** The domain it belongs to (a visible one; null: none or hidden) */
  domainId?: string | null;
  // ----- steps -----
  stepKind?: DataStepKind;
  // ----- collapsed -----
  /** How many nodes it stands for */
  count?: number;
  /** The ids of the nodes it stands for */
  members?: string[];
  /** What it collapses: elements of a parent, of a column, products of a domain, products without one, hidden ones */
  collapsedBy?: 'parent' | 'column' | 'domain' | 'noDomain' | 'hidden';
}

export interface DataGraphEdge {
  id: string;
  from: string;
  to: string;
  /** The names of the steps (pipeline, lineage) or ports (map) it stands for, at most DATA_GRAPH_LIMITS.edgeLabels */
  labels: string[];
  /** How many steps or port dependencies it stands for */
  count: number;
  /** The kind of its (first) step */
  stepKind?: DataStepKind | null;
  /** A step the reader may see no end of: drawn without a name */
  hidden?: boolean;
  /** Map: an input port consumes a deprecated or retired output port */
  deprecated?: boolean;
  /**
   * Lineage (0.24.0): a way a tool reports (OpenLineage, dbt, Snowflake object dependencies) that no step documents yet –
   * an open proposal; drawn dashed and named _proposed_, never merged with a documented way
   */
  proposed?: boolean;
  /** Map: the names among `labels` of the ports that are deprecated or retired (the others on the edge are not) */
  deprecatedLabels?: string[];
}

/** A step as the table lists it: its ends as node ids of the graph (hidden ones counted). */
export interface DataGraphStep {
  id: string;
  name: string;
  kind: DataStepKind;
  /** The runner in words (a tool, an application …; null: none or one the reader may not see) */
  runner: string | null;
  inputs: string[];
  outputs: string[];
  hidden: boolean;
  /** An open proposal of a lineage source, not a documented step (0.24.0) */
  proposed?: boolean;
}

export interface DataGraph {
  view: DataGraphView;
  nodes: DataGraphNode[];
  edges: DataGraphEdge[];
  steps: DataGraphStep[];
  /** Left out by the node limit (per direction for lineage) */
  truncated: { nodes: number; upstream: number; downstream: number };
  /** Elements and products in the graph the reader may not see (counted, never named) */
  hidden: { elements: number; products: number };
}

export interface DataPipelineView extends DataGraph {
  view: 'pipeline';
  product: { id: string; key: string; name: string };
  environment: string;
  /** The product's environments, production first */
  environments: string[];
  columns: DataGraphColumn[];
}

export interface DataProductMapView extends DataGraph {
  view: 'map';
  environment: string | null;
  /** What the filters offer (only what the reader may see) */
  options: {
    environments: string[];
    domains: { id: string; name: string; parentId: string | null }[];
  };
  /** Products that match the filters (the others in the graph are their neighbours) */
  matching: number;
}

export interface DataLineageView extends DataGraph {
  view: 'lineage';
  element: { id: string; name: string; qualifiedName: string; environment: string };
  depth: number;
}

// ---------- what the builders take ----------

/** A technology as the pictures draw it: its name, its icon (DATA_TECHNOLOGY_ICONS) and whether it is in the list. */
export interface GraphTechnology {
  name: string;
  icon: string;
  listed: boolean;
}

/** An element as the server hands it to a builder. */
export interface GraphElementInput {
  id: string;
  kind: DataElementKind;
  qualifiedName: string;
  displayName: string;
  layer: string;
  environment: string;
  missing: boolean;
  /** The reader may see it (or it is a member of the product shown, decision 15) */
  visible: boolean;
  /** The reader may open its page */
  linkable: boolean;
  /** Products it is part of the reader may see; those they may not (ids, for counting only – never handed out) */
  products: { id: string; name: string }[];
  hiddenProductIds: string[];
  parentName?: string | null;
  /** 0.25.0: a generic part's technology */
  technology?: GraphTechnology | null;
}

export interface GraphStepInput {
  id: string;
  name: string;
  kind: DataStepKind;
  runner: string | null;
  inputs: string[];
  outputs: string[];
  /** An open proposal of a lineage source (0.24.0): its ways are drawn as proposed */
  proposed?: boolean;
}

export interface GraphHealth {
  status: DataHealthStatus;
  checks: { visible: number; hidden: number };
}

export const dataElementPath = (id: string): string => `/data-elements/${encodeURIComponent(id)}`;
export const dataProductPath = (id: string): string => `/data-products/${encodeURIComponent(id)}`;

/** Hidden things get ids of their own per response (`hidden-1` …): never the real id, so nothing can be looked up. */
class Anonymiser {
  private ids = new Map<string, string>();
  of(real: string): string {
    let id = this.ids.get(real);
    if (!id) {
      id = `hidden-${this.ids.size + 1}`;
      this.ids.set(real, id);
    }
    return id;
  }
  get size(): number {
    return this.ids.size;
  }
}

/** Edges between nodes, merged per pair: the step (or port) names they carry, counted. */
class EdgeSet {
  private map = new Map<string, DataGraphEdge>();
  add(from: string, to: string, label: string, o: { stepKind?: DataStepKind | null; hidden?: boolean; deprecated?: boolean; proposed?: boolean } = {}): void {
    if (from === to) return;
    // a proposed way is an edge of its own beside a documented one between the same nodes
    const id = `${from}>${to}${o.proposed ? '~proposed' : ''}`;
    let e = this.map.get(id);
    if (!e) {
      e = { id, from, to, labels: [], count: 0, stepKind: o.stepKind ?? null, hidden: !!o.hidden, ...(o.proposed ? { proposed: true } : {}) };
      this.map.set(id, e);
    }
    e.count++;
    // a way stays nameless only while every step on it is
    if (!o.hidden) {
      e.hidden = false;
      if (label && !e.labels.includes(label) && e.labels.length < DATA_GRAPH_LIMITS.edgeLabels) e.labels.push(label);
    }
    if (o.deprecated) {
      e.deprecated = true;
      if (label && !o.hidden && e.labels.includes(label) && !e.deprecatedLabels?.includes(label)) (e.deprecatedLabels ??= []).push(label);
    }
  }
  list(): DataGraphEdge[] {
    return [...this.map.values()].map((e) => {
      const out: DataGraphEdge = { ...e };
      if (!out.hidden) delete out.hidden;
      if (!out.deprecated) delete out.deprecated;
      return out;
    });
  }
}

/** The ways of the steps between the nodes drawn: one edge per input and output, or a step node when it has many. */
function stepWays(
  steps: readonly GraphStepInput[],
  nodeOf: (elementId: string) => string | null,
  edges: EdgeSet,
  stepNode: (s: GraphStepInput, ins: string[], outs: string[]) => string,
  named: (s: GraphStepInput) => boolean,
): DataGraphStep[] {
  const out: DataGraphStep[] = [];
  for (const s of steps) {
    const ins = [...new Set(s.inputs.map(nodeOf).filter((x): x is string => !!x))];
    const outs = [...new Set(s.outputs.map(nodeOf).filter((x): x is string => !!x))];
    const show = named(s);
    const o = { stepKind: s.kind, hidden: !show, ...(s.proposed ? { proposed: true } : {}) };
    if (ins.length * outs.length > DATA_GRAPH_LIMITS.stepFan) {
      const hub = stepNode(s, ins, outs);
      for (const i of ins) edges.add(i, hub, show ? s.name : '', o);
      for (const x of outs) edges.add(hub, x, show ? s.name : '', o);
    } else for (const i of ins) for (const x of outs) edges.add(i, x, show ? s.name : '', o);
    if (ins.length || outs.length)
      out.push({
        id: show ? s.id : '',
        name: show ? s.name : '',
        kind: s.kind,
        runner: show ? s.runner : null,
        inputs: ins,
        outputs: outs,
        hidden: !show,
        ...(s.proposed ? { proposed: true } : {}),
      });
  }
  return out;
}

function elementNode(e: GraphElementInput, h: GraphHealth | undefined, anon: Anonymiser): DataGraphNode {
  if (!e.visible)
    return {
      id: anon.of(e.id),
      kind: 'element',
      label: '',
      detail: '',
      hidden: true,
      path: null,
      health: null,
      environment: e.environment,
    };
  const n: DataGraphNode = {
    id: e.id,
    kind: 'element',
    label: e.displayName || e.qualifiedName,
    detail: e.qualifiedName,
    path: e.linkable ? dataElementPath(e.id) : null,
    health: h?.status ?? 'noData',
    checks: h?.checks ?? { visible: 0, hidden: 0 },
    elementKind: e.kind,
    layer: e.layer,
    environment: e.environment,
    products: e.products.map((p) => p.name),
  };
  if (e.hiddenProductIds.length) n.hiddenProducts = e.hiddenProductIds.length;
  if (e.missing) n.missing = true;
  if (e.parentName) n.parentName = e.parentName;
  if (e.technology) n.technology = e.technology;
  return n;
}

// ---------- 1. the pipeline of a product ----------

const ROLE_ORDER: Record<DataMemberRole, number> = { output: 0, input: 1, internal: 2 };

/**
 * The pipeline of a product in one environment (part 13): its members in columns by role and layer – input ports,
 * internal elements by layer, output ports – and the neighbours its steps read from or write to outside the product
 * (upstream on the left, downstream on the right, greyed). Steps are labelled edges (a step with many ends a node of
 * its own). At most `maxNodes` elements: outputs, inputs and internal members first, neighbours after; the rest are
 * counted. Neighbours the reader may not see are drawn without a name or id.
 */
export function pipelineGraph(input: {
  layers: readonly string[];
  members: readonly { elementId: string; role: DataMemberRole; ports: string[] }[];
  elements: ReadonlyMap<string, GraphElementInput>;
  steps: readonly GraphStepInput[];
  health: ReadonlyMap<string, GraphHealth>;
  maxNodes?: number;
}): Pick<DataPipelineView, 'nodes' | 'edges' | 'steps' | 'columns' | 'truncated' | 'hidden'> {
  const max = input.maxNodes ?? DATA_GRAPH_LIMITS.nodes;
  const anon = new Anonymiser();
  const layers = input.layers;
  const memberOf = new Map(input.members.filter((m) => input.elements.has(m.elementId)).map((m) => [m.elementId, m]));
  // neighbours: read by a step of the pipeline (upstream), else written by one (downstream)
  const upstream = new Set<string>();
  const downstream = new Set<string>();
  for (const s of input.steps) {
    for (const id of s.inputs) if (!memberOf.has(id) && input.elements.has(id)) upstream.add(id);
    for (const id of s.outputs) if (!memberOf.has(id) && input.elements.has(id)) downstream.add(id);
  }
  for (const id of upstream) downstream.delete(id);
  const layerCol = (layer: string) => {
    const i = layers.indexOf(layer);
    return 2 + (i >= 0 ? i : layers.length);
  };
  const outputCol = 2 + layers.length + 1;
  const columnOf = (id: string): number => {
    const m = memberOf.get(id);
    if (m) return m.role === 'input' ? 1 : m.role === 'output' ? outputCol : layerCol(input.elements.get(id)!.layer);
    return upstream.has(id) ? 0 : outputCol + 1;
  };
  // which elements are drawn: members (outputs, inputs, internal), then neighbours, up to the limit
  const order = [...[...memberOf.values()].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]).map((m) => m.elementId), ...upstream, ...downstream];
  const drawn = order.slice(0, max);
  const truncated = { nodes: order.length - drawn.length, upstream: 0, downstream: 0 };
  for (const id of order.slice(max)) {
    if (upstream.has(id)) truncated.upstream++;
    else if (downstream.has(id)) truncated.downstream++;
  }
  const nodeIds = new Map<string, string>();
  const nodes: DataGraphNode[] = [];
  const columnOfNode = new Map<string, number>();
  const hiddenProducts = new Set<string>();
  let hiddenElements = 0;
  for (const id of drawn) {
    const e = input.elements.get(id)!;
    const m = memberOf.get(id);
    // a member is the product's content: always shown (decision 15)
    const n = elementNode(m ? { ...e, visible: true } : e, input.health.get(id), anon);
    n.column = columnOf(id);
    if (m) {
      n.role = m.role;
      if (m.ports.length) n.ports = m.ports;
    } else n.outside = true;
    if (n.hidden) hiddenElements++;
    else for (const p of e.hiddenProductIds) hiddenProducts.add(p);
    nodeIds.set(id, n.id);
    columnOfNode.set(n.id, n.column);
    nodes.push(n);
  }
  const edges = new EdgeSet();
  const steps = stepWays(
    input.steps,
    (id) => nodeIds.get(id) ?? null,
    edges,
    (s, ins) => {
      const id = `step:${s.id}`;
      if (!columnOfNode.has(id)) {
        // between the column of its last input and the next one
        const col = Math.max(0, ...ins.map((i) => columnOfNode.get(i) ?? 0)) + 0.5;
        columnOfNode.set(id, col);
        nodes.push({ id, kind: 'step', label: s.name, detail: s.runner ?? '', path: null, health: null, stepKind: s.kind, column: col });
      }
      return id;
    },
    // a step of the pipeline touches a member: always named
    () => true,
  );
  const used = [...new Set(nodes.map((n) => n.column ?? 0))].sort((a, b) => a - b);
  const columns: DataGraphColumn[] = used
    .filter((c) => Number.isInteger(c))
    .map((c) =>
      c === 0
        ? { index: c, kind: 'upstream' as const }
        : c === 1
          ? { index: c, kind: 'input' as const }
          : c === outputCol
            ? { index: c, kind: 'output' as const }
            : c > outputCol
              ? { index: c, kind: 'downstream' as const }
              : { index: c, kind: 'layer' as const, layer: layers[c - 2] ?? '' },
    );
  return { nodes, edges: edges.list(), steps, columns, truncated, hidden: { elements: hiddenElements, products: hiddenProducts.size } };
}

// ---------- 2. the product map ----------

export interface GraphProductInput {
  id: string;
  key: string;
  name: string;
  type: DataProductType | null;
  lifecycle: DataProductLifecycle;
  /** A domain the reader may see (null: none, or hidden) */
  domainId: string | null;
  health: DataHealthStatus | null;
}

/**
 * The product map (part 13): products as nodes in their domains (areas, sub-domains inside), edges from the product of
 * an output port to the product whose input port consumes it. Products that match the filters, and the products they
 * depend on or that depend on them (drawn greyed); products the reader may not see without a name or id. At most
 * `maxNodes` products (those matching first).
 */
export function mapGraph(input: {
  products: readonly GraphProductInput[];
  /** The products that match the filters */
  matching: ReadonlySet<string>;
  domains: readonly { id: string; name: string; parentId: string | null }[];
  /** Dependencies: `from` offers the output port, `to` consumes it; a product the reader may not see is `{ hidden: id }` */
  dependencies: readonly { from: string | { hidden: string }; to: string | { hidden: string }; port: string; deprecated: boolean }[];
  maxNodes?: number;
}): Pick<DataProductMapView, 'nodes' | 'edges' | 'steps' | 'truncated' | 'hidden' | 'matching'> {
  const max = input.maxNodes ?? DATA_GRAPH_LIMITS.nodes;
  const anon = new Anonymiser();
  const byId = new Map(input.products.map((p) => [p.id, p]));
  const key = (x: string | { hidden: string }) => (typeof x === 'string' ? x : `\u0000${x.hidden}`);
  // the products drawn: those matching, then their neighbours
  const touching = input.dependencies.filter(
    (d) => (typeof d.from === 'string' && input.matching.has(d.from)) || (typeof d.to === 'string' && input.matching.has(d.to)),
  );
  const neighbours = new Set<string>();
  for (const d of touching) for (const x of [d.from, d.to]) if (!(typeof x === 'string' && input.matching.has(x))) neighbours.add(key(x));
  const order = [
    ...input.products
      .filter((p) => input.matching.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => p.id),
    ...[...neighbours].sort(),
  ];
  const drawn = order.slice(0, max);
  const drawnSet = new Set(drawn);
  const nodes: DataGraphNode[] = [];
  const nodeOf = new Map<string, string>();
  let hiddenProducts = 0;
  for (const k of drawn) {
    if (k.startsWith('\u0000')) {
      const id = anon.of(k);
      nodeOf.set(k, id);
      hiddenProducts++;
      nodes.push({ id, kind: 'product', label: '', detail: '', hidden: true, path: null, health: null, outside: true });
      continue;
    }
    const p = byId.get(k);
    if (!p) continue;
    nodeOf.set(k, p.id);
    const n: DataGraphNode = {
      id: p.id,
      kind: 'product',
      label: p.name,
      detail: p.key,
      path: dataProductPath(p.id),
      health: p.health,
      productType: p.type,
      lifecycle: p.lifecycle,
      domainId: p.domainId,
    };
    if (!input.matching.has(p.id)) n.outside = true;
    if (p.domainId) n.parent = `domain:${p.domainId}`;
    nodes.push(n);
  }
  // the domains of the products drawn, and their parents
  const domainById = new Map(input.domains.map((d) => [d.id, d]));
  const usedDomains = new Set<string>();
  for (const n of nodes)
    for (let d = n.domainId ? domainById.get(n.domainId) : undefined, i = 0; d && i < 4; d = d.parentId ? domainById.get(d.parentId) : undefined, i++)
      usedDomains.add(d.id);
  for (const n of nodes) if (n.domainId && !domainById.has(n.domainId)) delete n.parent;
  const areas: DataGraphNode[] = [...usedDomains].map((id) => {
    const d = domainById.get(id)!;
    const a: DataGraphNode = { id: `domain:${d.id}`, kind: 'domain', label: d.name, detail: '', group: true, path: null, health: null };
    if (d.parentId && usedDomains.has(d.parentId)) a.parent = `domain:${d.parentId}`;
    return a;
  });
  const edges = new EdgeSet();
  for (const d of touching) {
    const a = nodeOf.get(key(d.from));
    const b = nodeOf.get(key(d.to));
    if (!a || !b) continue;
    const anyHidden = typeof d.from !== 'string' || typeof d.to !== 'string';
    // a port of a product the reader may not see is not named
    edges.add(a, b, typeof d.from === 'string' ? d.port : '', { deprecated: d.deprecated, hidden: anyHidden && typeof d.from !== 'string' });
  }
  return {
    nodes: [...areas, ...nodes],
    edges: edges.list(),
    steps: [],
    truncated: { nodes: order.length - drawnSet.size, upstream: 0, downstream: 0 },
    hidden: { elements: 0, products: hiddenProducts },
    matching: input.matching.size,
  };
}

// ---------- 3. the lineage of an element ----------

/**
 * The lineage of an element (part 9): the elements within `depth` steps upstream and downstream, products as areas
 * (an element in several in the first, the others named on it), plant collections that write to an element as nodes
 * upstream of it. Elements the reader may not see stay in the graph without a name or id, the steps between them
 * without a name.
 */
export function lineageGraph(input: {
  focus: string;
  /** Element id → distance (negative: upstream) */
  distances: ReadonlyMap<string, number>;
  elements: ReadonlyMap<string, GraphElementInput>;
  steps: readonly GraphStepInput[];
  health: ReadonlyMap<string, GraphHealth>;
  plant?: readonly { elementId: string; label: string | null; path: string | null }[];
  truncated: { upstream: number; downstream: number };
}): Pick<DataLineageView, 'nodes' | 'edges' | 'steps' | 'truncated' | 'hidden'> {
  const anon = new Anonymiser();
  const nodes: DataGraphNode[] = [];
  const nodeOf = new Map<string, string>();
  const areas = new Map<string, DataGraphNode>();
  let hiddenElements = 0;
  const hiddenProducts = new Set<string>();
  const stepNodes = new Set<string>();
  const ids = [...input.distances.keys()].filter((id) => input.elements.has(id));
  ids.sort((a, b) => input.distances.get(a)! - input.distances.get(b)! || a.localeCompare(b));
  for (const id of ids) {
    const e = input.elements.get(id)!;
    const n = elementNode(id === input.focus ? { ...e, visible: true } : e, input.health.get(id), anon);
    n.distance = input.distances.get(id)!;
    if (n.hidden) hiddenElements++;
    else {
      for (const p of e.hiddenProductIds) hiddenProducts.add(p);
      const first = e.products[0];
      if (first) {
        n.parent = `product:${first.id}`;
        if (!areas.has(first.id))
          areas.set(first.id, { id: n.parent, kind: 'product', label: first.name, detail: '', group: true, path: dataProductPath(first.id), health: null });
      }
    }
    nodeOf.set(id, n.id);
    nodes.push(n);
  }
  const edges = new EdgeSet();
  const visible = (id: string) => !!input.elements.get(id)?.visible || id === input.focus;
  const steps = stepWays(
    input.steps,
    (id) => nodeOf.get(id) ?? null,
    edges,
    (s) => {
      const named = [...s.inputs, ...s.outputs].some(visible);
      const id = named ? `step:${s.id}` : anon.of(`step:${s.id}`);
      if (!stepNodes.has(id)) {
        stepNodes.add(id);
        nodes.push({
          id,
          kind: 'step',
          label: named ? s.name : '',
          detail: named ? (s.runner ?? '') : '',
          hidden: !named || undefined,
          path: null,
          health: null,
          stepKind: s.kind,
        });
      }
      return id;
    },
    (s) => [...s.inputs, ...s.outputs].some(visible),
  );
  // plant collections that write to an element (where the reader may see the site, else without a name)
  (input.plant ?? []).slice(0, DATA_GRAPH_LIMITS.plantSinks).forEach((p, i) => {
    const to = nodeOf.get(p.elementId);
    if (!to) return;
    const id = `plant:${i + 1}`;
    nodes.push({
      id,
      kind: 'plant',
      label: p.label ?? '',
      detail: '',
      hidden: p.label === null || undefined,
      path: p.label === null ? null : p.path,
      health: null,
      distance: (input.distances.get(p.elementId) ?? 0) - 1,
    });
    edges.add(id, to, '');
  });
  return {
    nodes: [...areas.values(), ...nodes],
    edges: edges.list(),
    steps,
    truncated: { nodes: input.truncated.upstream + input.truncated.downstream, ...input.truncated },
    hidden: { elements: hiddenElements, products: hiddenProducts.size },
  };
}

// ---------- collapsing large graphs for the picture ----------

/** Nodes that are drawn (not areas). */
export const drawnNodes = (g: Pick<DataGraph, 'nodes'>): DataGraphNode[] => g.nodes.filter((n) => !n.group);

/**
 * Replaces nodes by representatives: edges are re-pointed and merged (their counts added, names kept up to the limit),
 * ways inside one representative dropped.
 */
export function mergeNodes(g: Pick<DataGraph, 'nodes' | 'edges'>, rep: ReadonlyMap<string, DataGraphNode>): Pick<DataGraph, 'nodes' | 'edges'> {
  if (!rep.size) return g;
  const target = (id: string) => rep.get(id)?.id ?? id;
  const nodes: DataGraphNode[] = [];
  const added = new Set<string>();
  for (const n of g.nodes) {
    const r = rep.get(n.id);
    if (!r) nodes.push(n);
    else if (!added.has(r.id)) {
      added.add(r.id);
      nodes.push(r);
    }
  }
  const edges = new Map<string, DataGraphEdge>();
  for (const e of g.edges) {
    const from = target(e.from);
    const to = target(e.to);
    if (from === to) continue;
    const id = `${from}>${to}${e.proposed ? '~proposed' : ''}`;
    const cur = edges.get(id);
    if (!cur) edges.set(id, { ...e, id, from, to, labels: [...e.labels], ...(e.deprecatedLabels ? { deprecatedLabels: [...e.deprecatedLabels] } : {}) });
    else {
      cur.count += e.count;
      for (const l of e.labels) if (!cur.labels.includes(l) && cur.labels.length < DATA_GRAPH_LIMITS.edgeLabels) cur.labels.push(l);
      if (!e.hidden) delete cur.hidden;
      if (e.deprecated) cur.deprecated = true;
      for (const l of e.deprecatedLabels ?? []) if (cur.labels.includes(l) && !cur.deprecatedLabels?.includes(l)) (cur.deprecatedLabels ??= []).push(l);
    }
  }
  return { nodes, edges: [...edges.values()] };
}

function collapsedNode(
  id: string,
  members: DataGraphNode[],
  label: string,
  by: NonNullable<DataGraphNode['collapsedBy']>,
  extra: Partial<DataGraphNode> = {},
): DataGraphNode {
  return {
    id,
    kind: 'collapsed',
    label,
    detail: '',
    path: null,
    health: worstHealth(members.map((m) => m.health)),
    count: members.reduce((a, m) => a + (m.count ?? 1), 0),
    members: members.flatMap((m) => m.members ?? [m.id]),
    collapsedBy: by,
    ...extra,
  };
}

/**
 * A pipeline for the picture (part 13): beyond `max` nodes, elements of a column collapse by parent – the largest
 * groups first (_14 tables of STAGED_), hidden ones per column – and if that is not enough, every column becomes one
 * node. Members and neighbours never share a collapsed node. The table keeps listing every element.
 */
export function collapsePipeline(
  g: Pick<DataGraph, 'nodes' | 'edges'>,
  max: number = DATA_GRAPH_LIMITS.pipelinePicture,
): Pick<DataGraph, 'nodes' | 'edges'> & { collapsed: boolean } {
  const count = (x: Pick<DataGraph, 'nodes'>) => drawnNodes(x).length;
  if (count(g) <= max) return { ...g, collapsed: false };
  // 1. by parent within a column (hidden elements: one group per column)
  const groups = new Map<string, DataGraphNode[]>();
  for (const n of g.nodes) {
    if (n.kind !== 'element') continue;
    const k = n.hidden ? `${n.column}\u0000hidden` : n.parentName ? `${n.column}\u0000${n.outside ? 'o' : 'm'}\u0000${n.parentName}` : null;
    if (k) groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  const rep = new Map<string, DataGraphNode>();
  let total = count(g);
  for (const [k, members] of [...groups].filter(([, m]) => m.length > 1).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    if (total <= max) break;
    const first = members[0]!;
    const node = collapsedNode(`collapsed:${k.split('\u0000').join(':')}`, members, first.hidden ? '' : first.parentName!, first.hidden ? 'hidden' : 'parent', {
      column: first.column,
      ...(first.outside ? { outside: true } : {}),
      ...(first.role ? { role: first.role } : {}),
      ...(first.elementKind && members.every((m) => m.elementKind === first.elementKind) ? { elementKind: first.elementKind } : {}),
    });
    for (const m of members) rep.set(m.id, node);
    total -= members.length - 1;
  }
  let out = mergeNodes(g, rep);
  if (count(out) <= max) return { ...out, collapsed: true };
  // 2. a column as one node (step nodes between columns stay)
  const byColumn = new Map<number, DataGraphNode[]>();
  for (const n of out.nodes)
    if ((n.kind === 'element' || n.kind === 'collapsed') && n.column !== undefined) byColumn.set(n.column, [...(byColumn.get(n.column) ?? []), n]);
  const rep2 = new Map<string, DataGraphNode>();
  for (const [col, members] of byColumn) {
    if (members.length < 2) continue;
    const node = collapsedNode(`column:${col}`, members, '', 'column', { column: col, ...(members.every((m) => m.outside) ? { outside: true } : {}) });
    for (const m of members) rep2.set(m.id, node);
  }
  out = mergeNodes(out, rep2);
  // 3. step nodes that now connect the same columns: their ways are kept as they are
  return { ...out, collapsed: true };
}

/**
 * A map for the picture: beyond `max` products, the products of each domain (the top domain) become one node with the
 * count – products without a domain one more, hidden ones another; edges between them carry the counts.
 */
export function collapseMap(
  g: Pick<DataGraph, 'nodes' | 'edges'>,
  max: number = DATA_GRAPH_LIMITS.mapPicture,
): Pick<DataGraph, 'nodes' | 'edges'> & { collapsed: boolean } {
  const products = g.nodes.filter((n) => n.kind === 'product' && !n.group);
  if (products.length <= max) return { ...g, collapsed: false };
  const areas = new Map(g.nodes.filter((n) => n.group).map((n) => [n.id, n]));
  const top = (id: string | undefined): DataGraphNode | undefined => {
    let a = id ? areas.get(id) : undefined;
    for (let i = 0; a?.parent && areas.has(a.parent) && i < 4; i++) a = areas.get(a.parent);
    return a;
  };
  const groups = new Map<string, { label: string; by: 'domain' | 'noDomain' | 'hidden'; members: DataGraphNode[] }>();
  for (const p of products) {
    const d = top(p.parent);
    const k = p.hidden ? 'collapsed:hidden' : d ? `collapsed:${d.id}` : 'collapsed:none';
    const cur = groups.get(k) ?? { label: p.hidden ? '' : (d?.label ?? ''), by: p.hidden ? 'hidden' : d ? 'domain' : 'noDomain', members: [] };
    cur.members.push(p);
    groups.set(k, cur);
  }
  const rep = new Map<string, DataGraphNode>();
  for (const [id, x] of groups) {
    const node = collapsedNode(id, x.members, x.label, x.by, x.members.every((m) => m.outside) ? { outside: true } : {});
    for (const m of x.members) rep.set(m.id, node);
  }
  const merged = mergeNodes({ nodes: g.nodes.filter((n) => !n.group), edges: g.edges }, rep);
  return { ...merged, collapsed: true };
}

// ---------- reading a graph ----------

/** The nodes reachable from `start` along the edges (up: against them, down: with them), with the edges taken. */
export function reachable(g: Pick<DataGraph, 'edges'>, start: string, dir: 'up' | 'down' | 'both' = 'both'): { nodes: Set<string>; edges: Set<string> } {
  const outOf = new Map<string, DataGraphEdge[]>();
  const into = new Map<string, DataGraphEdge[]>();
  for (const e of g.edges) {
    outOf.set(e.from, [...(outOf.get(e.from) ?? []), e]);
    into.set(e.to, [...(into.get(e.to) ?? []), e]);
  }
  const nodes = new Set<string>([start]);
  const edges = new Set<string>();
  const walk = (down: boolean) => {
    const seen = new Set<string>([start]);
    let frontier = [start];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier)
        for (const e of (down ? outOf : into).get(id) ?? []) {
          edges.add(e.id);
          const other = down ? e.to : e.from;
          nodes.add(other);
          if (!seen.has(other)) {
            seen.add(other);
            next.push(other);
          }
        }
      frontier = next;
    }
  };
  if (dir !== 'down') walk(false);
  if (dir !== 'up') walk(true);
  return { nodes, edges };
}
