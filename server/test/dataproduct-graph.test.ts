import { describe, expect, it } from 'vitest';
import {
  DATA_GRAPH_LIMITS,
  collapseMap,
  collapsePipeline,
  drawnNodes,
  lineageGraph,
  mapGraph,
  pipelineGraph,
  reachable,
  worstHealth,
  type GraphElementInput,
  type GraphHealth,
  type GraphProductInput,
  type GraphStepInput,
} from '@sm/shared';

/**
 * The graph builders of the data products pictures (ADR 0036 part 13, WP6, shared/src/dataProductGraph.ts): columns by
 * role and layer, neighbours outside the product, steps as edges or nodes, limits with the rest counted, hidden elements
 * and products drawn without a name or id, collapsing for the picture, and a graph of 2,000 nodes built and collapsed
 * quickly.
 */

const LAYERS = ['source', 'raw', 'staged', 'curated', 'mart'];

function el(id: string, o: Partial<GraphElementInput> = {}): GraphElementInput {
  return {
    id,
    kind: 'snowflake.table',
    qualifiedName: `SHOP.${(o.layer ?? 'raw').toUpperCase()}.${id.toUpperCase()}`,
    displayName: id.toUpperCase(),
    layer: 'raw',
    environment: 'prod',
    missing: false,
    visible: true,
    linkable: true,
    products: [],
    hiddenProductIds: [],
    ...o,
  };
}

const step = (id: string, inputs: string[], outputs: string[], o: Partial<GraphStepInput> = {}): GraphStepInput => ({
  id,
  name: id,
  kind: 'transform',
  runner: null,
  inputs,
  outputs,
  ...o,
});

const elements = (...xs: GraphElementInput[]) => new Map(xs.map((x) => [x.id, x]));

describe('the pipeline of a product', () => {
  it('draws members in columns by role and layer, neighbours outside, steps as labelled edges', () => {
    const g = pipelineGraph({
      layers: LAYERS,
      members: [
        { elementId: 'topic', role: 'input', ports: ['orders-in v1'] },
        { elementId: 'raw', role: 'internal', ports: [] },
        { elementId: 'curated', role: 'internal', ports: [] },
        { elementId: 'mart', role: 'output', ports: ['orders v2'] },
      ],
      elements: elements(
        el('topic', { kind: 'kafka.topic', layer: 'source' }),
        el('raw', { layer: 'raw' }),
        el('curated', { layer: 'curated' }),
        el('mart', { layer: 'mart' }),
        el('crm', { layer: 'curated', products: [{ id: 'p2', name: 'Customer 360' }] }),
        el('report', { layer: 'mart' }),
      ),
      steps: [
        step('ingest', ['topic'], ['raw'], { kind: 'ingest', runner: 'Kafka Connect' }),
        step('curate', ['raw', 'crm'], ['curated'], { kind: 'curate' }),
        step('publish', ['curated'], ['mart'], { kind: 'publish' }),
        step('report', ['mart'], ['report']),
      ],
      health: new Map<string, GraphHealth>([['mart', { status: 'down', checks: { visible: 1, hidden: 1 } }]]),
    });
    const col = (id: string) => g.nodes.find((n) => n.id === id)?.column;
    // upstream 0, inputs 1, layers 2.., outputs after the layers, downstream last
    expect([col('crm'), col('topic'), col('raw'), col('curated'), col('mart'), col('report')]).toEqual([0, 1, 3, 5, 8, 9]);
    expect(g.columns.map((c) => c.kind)).toEqual(['upstream', 'input', 'layer', 'layer', 'output', 'downstream']);
    expect(g.columns.filter((c) => c.kind === 'layer').map((c) => c.layer)).toEqual(['raw', 'curated']);
    const crm = g.nodes.find((n) => n.id === 'crm')!;
    expect(crm).toMatchObject({ outside: true, products: ['Customer 360'], path: '/data-elements/crm' });
    expect(g.nodes.find((n) => n.id === 'mart')).toMatchObject({ role: 'output', ports: ['orders v2'], health: 'down', checks: { visible: 1, hidden: 1 } });
    // never OK without a check
    expect(g.nodes.find((n) => n.id === 'raw')?.health).toBe('noData');
    expect(g.edges.find((e) => e.id === 'raw>curated')).toMatchObject({ labels: ['curate'], count: 1, stepKind: 'curate' });
    expect(g.edges.find((e) => e.id === 'crm>curated')).toBeTruthy();
    expect(g.steps.find((s) => s.id === 'ingest')).toMatchObject({ runner: 'Kafka Connect', inputs: ['topic'], outputs: ['raw'] });
    expect(g.truncated).toEqual({ nodes: 0, upstream: 0, downstream: 0 });
  });

  it('draws neighbours the reader may not see without a name or id, and counts them and their hidden products', () => {
    const g = pipelineGraph({
      layers: LAYERS,
      // a member the reader may not see otherwise is the product's content: shown (decision 15)
      members: [{ elementId: 'raw', role: 'internal', ports: [] }],
      elements: elements(
        el('raw', { visible: false, hiddenProductIds: ['secret-product'] }),
        el('secret-src', { visible: false, displayName: 'SECRET', qualifiedName: 'SECRET.SRC', hiddenProductIds: ['secret-product'] }),
        el('other-src', { hiddenProductIds: ['secret-product', 'another'] }),
      ),
      steps: [step('load', ['secret-src', 'other-src'], ['raw'])],
      health: new Map(),
    });
    const raw = g.nodes.find((n) => n.id === 'raw')!;
    expect(raw.label).toBe('RAW');
    expect(raw.hidden).toBeFalsy();
    const hidden = g.nodes.filter((n) => n.hidden);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({ id: 'hidden-1', label: '', detail: '', path: null, outside: true });
    const text = JSON.stringify(g);
    expect(text).not.toContain('secret-src');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('secret-product');
    // the hidden products of what is drawn by name, each once
    expect(g.hidden).toEqual({ elements: 1, products: 2 });
    expect(g.nodes.find((n) => n.id === 'other-src')?.hiddenProducts).toBe(2);
  });

  it('draws a step with many ends as a node of its own', () => {
    const ins = Array.from({ length: 5 }, (_, i) => `in${i}`);
    const outs = Array.from({ length: 4 }, (_, i) => `out${i}`);
    const g = pipelineGraph({
      layers: LAYERS,
      members: [...ins, ...outs].map((id) => ({ elementId: id, role: 'internal' as const, ports: [] })),
      elements: elements(...ins.map((id) => el(id, { layer: 'raw' })), ...outs.map((id) => el(id, { layer: 'staged' }))),
      steps: [step('fan', ins, outs)],
      health: new Map(),
    });
    // 5 × 4 = 20 > 16 ways: a step node between raw (3) and staged (4)
    expect(g.nodes.find((n) => n.id === 'step:fan')).toMatchObject({ kind: 'step', column: 3.5 });
    expect(g.edges).toHaveLength(9);
  });

  it('keeps members before neighbours at the node limit and counts the rest per direction', () => {
    const ms = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const up = Array.from({ length: 6 }, (_, i) => `u${i}`);
    const g = pipelineGraph({
      layers: LAYERS,
      members: ms.map((id) => ({ elementId: id, role: 'internal' as const, ports: [] })),
      elements: elements(...ms.map((id) => el(id)), ...up.map((id) => el(id))),
      steps: [step('s', up, ['m0'])],
      health: new Map(),
      maxNodes: 12,
    });
    expect(drawnNodes(g)).toHaveLength(12);
    expect(g.truncated).toEqual({ nodes: 4, upstream: 4, downstream: 0 });
    expect(ms.every((id) => g.nodes.some((n) => n.id === id))).toBe(true);
  });
});

describe('collapsing a pipeline for the picture', () => {
  const big = (n: number) => {
    const ids = Array.from({ length: n }, (_, i) => `t${i}`);
    return pipelineGraph({
      layers: LAYERS,
      members: ids.map((id, i) => ({ elementId: id, role: i % 10 === 0 ? ('output' as const) : ('internal' as const), ports: [] })),
      elements: elements(
        ...ids.map((id, i) =>
          el(id, {
            layer: i % 2 ? 'staged' : 'raw',
            qualifiedName: `SHOP.${i % 2 ? 'STAGED' : 'RAW'}.${id}`,
            parentName: i % 2 ? 'STAGED' : 'RAW',
            visible: i % 7 !== 3,
          }),
        ),
      ),
      steps: ids.slice(1).map((id, i) => step(`s${i}`, [ids[i]!], [id])),
      health: new Map<string, GraphHealth>([['t3', { status: 'down', checks: { visible: 1, hidden: 0 } }]]),
    });
  };

  it('leaves a small pipeline alone', () => {
    const g = big(20);
    expect(collapsePipeline(g).collapsed).toBe(false);
  });

  it('collapses elements by parent within a column first, the largest groups first, with the worst health', () => {
    const g = big(200);
    const c = collapsePipeline(g, DATA_GRAPH_LIMITS.pipelinePicture);
    expect(c.collapsed).toBe(true);
    expect(drawnNodes(c).length).toBeLessThanOrEqual(DATA_GRAPH_LIMITS.pipelinePicture);
    // STAGED (100 elements) is the largest group: collapsing it is enough
    const staged = c.nodes.find((n) => n.kind === 'collapsed' && n.label === 'STAGED' && n.collapsedBy === 'parent');
    expect(staged).toMatchObject({ count: 100, health: 'down', elementKind: 'snowflake.table', role: 'internal' });
    expect(c.nodes.some((n) => n.label === 'RAW' && n.kind === 'collapsed')).toBe(false);
    // every element is still somewhere: drawn or in a collapsed node
    const covered = new Set(c.nodes.flatMap((n) => n.members ?? [n.id]));
    for (const n of g.nodes) expect(covered.has(n.id), n.id).toBe(true);
    // no way inside one collapsed node, and every edge ends at a drawn node
    const ids = new Set(c.nodes.map((n) => n.id));
    for (const e of c.edges) {
      expect(e.from).not.toBe(e.to);
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    }
  });

  it('collapses whole columns when parents are not enough', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `x${i}`);
    const g = pipelineGraph({
      layers: LAYERS,
      members: ids.map((id) => ({ elementId: id, role: 'internal' as const, ports: [] })),
      // no parents: nothing to collapse by parent
      elements: elements(...ids.map((id, i) => el(id, { layer: LAYERS[i % 5]! }))),
      steps: [],
      health: new Map(),
    });
    const c = collapsePipeline(g, 150);
    expect(c.nodes.filter((n) => n.collapsedBy === 'column')).toHaveLength(5);
    expect(c.nodes.find((n) => n.collapsedBy === 'column')?.count).toBe(80);
  });

  it('builds and collapses a pipeline of 2,000 elements and 2,000 steps quickly', () => {
    const t0 = performance.now();
    const g = big(2_000);
    const c = collapsePipeline(g);
    const ms = performance.now() - t0;
    expect(drawnNodes(g)).toHaveLength(2_000);
    expect(drawnNodes(c).length).toBeLessThanOrEqual(DATA_GRAPH_LIMITS.pipelinePicture);
    expect(ms).toBeLessThan(1_500);
  });
});

describe('the product map', () => {
  const product = (id: string, o: Partial<GraphProductInput> = {}): GraphProductInput => ({
    id,
    key: id,
    name: id.toUpperCase(),
    type: 'sourceAligned',
    lifecycle: 'active',
    domainId: null,
    health: 'noData',
    ...o,
  });

  it('draws matching products in their domains, their neighbours greyed, hidden products without a name', () => {
    const g = mapGraph({
      products: [product('orders', { domainId: 'sub' }), product('mart', { domainId: 'other' }), product('lonely')],
      matching: new Set(['orders', 'lonely']),
      domains: [
        { id: 'sales', name: 'Sales', parentId: null },
        { id: 'sub', name: 'Orders', parentId: 'sales' },
        { id: 'other', name: 'Other', parentId: null },
      ],
      dependencies: [
        { from: 'orders', to: 'mart', port: 'orders v2', deprecated: false },
        { from: 'orders', to: 'mart', port: 'orders v1', deprecated: true },
        { from: { hidden: 'dpr_secret' }, to: 'orders', port: 'secret port', deprecated: true },
        { from: 'mart', to: 'unrelated', port: 'x', deprecated: false },
      ],
    });
    expect(g.matching).toBe(2);
    expect(g.nodes.find((n) => n.id === 'orders')).toMatchObject({ parent: 'domain:sub', path: '/data-products/orders' });
    expect(g.nodes.find((n) => n.id === 'orders')?.outside).toBeFalsy();
    expect(g.nodes.find((n) => n.id === 'mart')).toMatchObject({ outside: true, parent: 'domain:other' });
    expect(g.nodes.find((n) => n.id === 'domain:sub')).toMatchObject({ group: true, parent: 'domain:sales' });
    const hidden = g.nodes.find((n) => n.hidden)!;
    expect(hidden).toMatchObject({ id: 'hidden-1', label: '' });
    expect(JSON.stringify(g)).not.toContain('dpr_secret');
    expect(JSON.stringify(g)).not.toContain('secret port');
    expect(g.edges.find((e) => e.to === 'orders')).toMatchObject({ from: 'hidden-1', deprecated: true, labels: [] });
    // the deprecated port is named as such, the current one on the same way is not
    expect(g.edges.find((e) => e.id === 'orders>mart')).toMatchObject({
      labels: ['orders v2', 'orders v1'],
      deprecated: true,
      deprecatedLabels: ['orders v1'],
    });
    expect(g.edges.find((e) => e.to === 'orders')?.deprecatedLabels).toBeUndefined();
    // a dependency between two products outside the filters is not drawn
    expect(g.nodes.some((n) => n.id === 'unrelated')).toBe(false);
    expect(g.hidden.products).toBe(1);
  });

  it('turns domains into nodes with counts beyond the picture limit', () => {
    const ps = Array.from({ length: 400 }, (_, i) => product(`p${i}`, { domainId: i % 2 ? 'a' : i % 3 ? 'b' : null, health: i === 5 ? 'down' : 'up' }));
    const g = mapGraph({
      products: ps,
      matching: new Set(ps.map((p) => p.id)),
      domains: [
        { id: 'a', name: 'A', parentId: null },
        { id: 'b', name: 'B', parentId: 'a' },
      ],
      dependencies: ps.slice(1).map((p, i) => ({ from: ps[i]!.id, to: p.id, port: 'x', deprecated: false })),
    });
    const c = collapseMap(g);
    expect(c.collapsed).toBe(true);
    // B is a sub-domain of A: one node for A, one for products without a domain
    expect(c.nodes.map((n) => n.id).sort()).toEqual(['collapsed:domain:a', 'collapsed:none']);
    expect(c.nodes.find((n) => n.id === 'collapsed:domain:a')).toMatchObject({ count: 200 + 133, health: 'down', label: 'A' });
    expect(c.edges.every((e) => e.count > 0)).toBe(true);
  });
});

describe('the lineage of an element', () => {
  it('groups elements by product, keeps hidden ones nameless with their steps, adds plant collections', () => {
    const g = lineageGraph({
      focus: 'curated',
      distances: new Map([
        ['curated', 0],
        ['staged', -1],
        ['secret', -2],
        ['mart', 1],
      ]),
      elements: elements(
        el('curated', { products: [{ id: 'orders', name: 'Orders' }] }),
        el('staged', { products: [{ id: 'orders', name: 'Orders' }] }),
        el('secret', { visible: false, displayName: 'SECRET' }),
        el('mart', { products: [], hiddenProductIds: ['p-hidden'] }),
      ),
      steps: [step('stage', ['secret'], ['staged'], { runner: 'dbt' }), step('curate', ['staged'], ['curated']), step('publish', ['curated'], ['mart'])],
      health: new Map(),
      plant: [
        { elementId: 'secret', label: null, path: null },
        { elementId: 'staged', label: 'Mill data – Milling centre 17', path: '/plant/assets/a1/collections' },
      ],
      truncated: { upstream: 0, downstream: 3 },
    });
    expect(g.nodes.find((n) => n.id === 'product:orders')).toMatchObject({ group: true, label: 'Orders' });
    expect(g.nodes.find((n) => n.id === 'staged')).toMatchObject({ parent: 'product:orders', distance: -1 });
    expect(g.nodes.find((n) => n.id === 'hidden-1')).toMatchObject({ hidden: true, distance: -2 });
    // a step with a visible end keeps its name
    expect(g.edges.find((e) => e.from === 'hidden-1')).toMatchObject({ labels: ['stage'] });
    expect(g.nodes.filter((n) => n.kind === 'plant').map((n) => [n.label, n.hidden ?? false])).toEqual([
      ['', true],
      ['Mill data – Milling centre 17', false],
    ]);
    expect(g.hidden).toEqual({ elements: 1, products: 1 });
    expect(g.truncated).toEqual({ nodes: 3, upstream: 0, downstream: 3 });
    expect(JSON.stringify(g)).not.toContain('SECRET');
  });

  it('draws a step between elements the reader may not see without a name', () => {
    const g = lineageGraph({
      focus: 'a',
      distances: new Map([
        ['a', 0],
        ['b', -1],
        ['c', -2],
      ]),
      elements: elements(el('a'), el('b', { visible: false }), el('c', { visible: false })),
      steps: [step('secret-step', ['c'], ['b'], { runner: 'secret runner' }), step('visible', ['b'], ['a'])],
      health: new Map(),
      truncated: { upstream: 0, downstream: 0 },
    });
    const between = g.edges.find((e) => e.from === 'hidden-1' && e.to === 'hidden-2');
    expect(between).toMatchObject({ labels: [], hidden: true });
    expect(g.steps.find((s) => s.hidden)).toMatchObject({ id: '', name: '', runner: null });
    expect(JSON.stringify(g)).not.toContain('secret');
  });
});

describe('reading a graph', () => {
  it('finds what is upstream and downstream of a node', () => {
    const edges = [
      { id: 'a>b', from: 'a', to: 'b', labels: [], count: 1 },
      { id: 'b>c', from: 'b', to: 'c', labels: [], count: 1 },
      { id: 'x>b', from: 'x', to: 'b', labels: [], count: 1 },
      { id: 'c>d', from: 'c', to: 'd', labels: [], count: 1 },
    ];
    expect([...reachable({ edges }, 'c', 'up').nodes].sort()).toEqual(['a', 'b', 'c', 'x']);
    expect([...reachable({ edges }, 'b', 'down').nodes].sort()).toEqual(['b', 'c', 'd']);
    expect(reachable({ edges }, 'b').edges.size).toBe(4);
  });

  it('takes the worst health of a group', () => {
    expect(worstHealth(['up', 'noData', 'degraded'])).toBe('degraded');
    expect(worstHealth(['up', null])).toBe('up');
    expect(worstHealth([])).toBe(null);
  });

  it("has one health order for the whole module: the monitors' ranking with No data last", async () => {
    const { DATA_HEALTH_ORDER, HEALTH_STATUSES, MONITOR_STATUSES, worseHealth, worstStatus } = await import('@sm/shared');
    expect(DATA_HEALTH_ORDER).toEqual(['down', 'degraded', 'unknown', 'blocked', 'maintenance', 'up', 'off', 'noData']);
    // the list's sort and filter: the same order, best first
    expect(HEALTH_STATUSES).toEqual([...DATA_HEALTH_ORDER].reverse());
    // every pair agrees with the monitors' aggregation, and any status of a check says more than none
    for (const a of MONITOR_STATUSES) {
      expect(worseHealth(a, 'noData')).toBe(a);
      expect(worseHealth('noData', a)).toBe(a);
      for (const b of MONITOR_STATUSES) {
        expect(worseHealth(a, b), `${a} ${b}`).toBe(worstStatus([a, b]));
        expect(worstHealth([a, b]), `${a} ${b}`).toBe(worstStatus([a, b]));
      }
    }
    expect(worstHealth(['up', 'off', 'noData'])).toBe('up');
    expect(worstHealth(['noData'])).toBe('noData');
  });
});
