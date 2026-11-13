import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { DataGraph, DataPort, DataProduct, DataProductSummary, DataRef, ProductHealth } from '@sm/shared';
import { me } from '../auth/access.js';
import { HttpError } from '../util.js';
import { notFound } from '../api/v1/helpers.js';
import { linkNext } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import * as svc from './service.js';
import * as el from './elements.js';
import { elementHealthOf, healthOf, productHealthByEnvironment } from './health.js';
import { lineageView, pipelineView } from './views.js';
import { odpsDocument } from './odps.js';
import { membersOf } from './store.js';
import { scorecardsOf } from './scorecard.js';
import {
  DataElementV1ListQuery,
  DataObjectV1ListQuery,
  DataProductLineageQuery,
  DataProductOdpsQuery,
  DataProductOpenLineageQuery,
  DataProductV1ListQuery,
  DataSemanticModelV1Query,
  DataSemanticVersionsV1Query,
} from './api-schemas.js';
import { openLineageExport } from './openlineage-export.js';
import { semanticExport, semanticModelView, validAnswer } from './semantic.js';
import YAML from 'yaml';
import { SemanticModelQuery, ossieDocumentSchema } from '../api/v1/schemas.js';
import type { OssieVersion } from '../semantic/ossie.js';
import { dataObjectsSemanticModel } from './ossie.js';

/**
 * The data products module in the public, read-only API (ADR 0036 part 19): products (paged; domain, lifecycle, type,
 * environment, team), one product with its ports, bindings and contract ids, objectives, health, the scorecard summary
 * and data objects, its ODPS v1.0.0 document and its lineage; the element catalogue (paged; platform, kind,
 * environment, prefix) and an element; data objects. As the token owner, through the services of the web app: what
 * they may not see is not listed, counted or named. While the module is off every endpoint answers 404.
 */

type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const TAG = 'Data products';
const MODULE = 'Only while the data products module is on (Settings → Modules); otherwise 404.';
const page = (name: string, description: string) => ({
  type: 'object',
  description,
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: { $ref: `${name}#` } }, nextCursor: { type: ['string', 'null'] } },
});

/** A 404 of a service (an item the token owner may not see answers like a missing one) as the API's problem. */
function found<T>(f: () => T, what: string): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) throw notFound(what);
    throw e;
  }
}

const ref = (r: DataRef | null) => (r ? { id: r.id, key: r.key, name: r.name, hidden: !!r.hidden } : null);
const health = (h: ProductHealth | undefined) => (h ? { environment: h.environment, status: h.status, source: h.source } : null);

function entryOf(p: DataProductSummary, h: ProductHealth | undefined) {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    type: p.type,
    domain: ref(p.domain),
    lifecycle: p.lifecycle,
    sunsetDate: p.sunsetDate,
    criticality: p.criticality,
    tier: p.tier,
    rating: p.rating,
    classification: p.classification,
    ratingBelowObjects: p.ratingBelowObjects,
    valueTier: p.valueTier,
    environments: p.environments,
    owners: p.owners,
    owningTeams: p.owningTeams,
    tags: p.tags,
    version: p.version,
    health: health(h),
    updatedAt: p.updatedAt,
  };
}

const portOf = (x: DataPort) => ({
  id: x.id,
  direction: x.direction,
  name: x.name,
  type: x.type,
  version: x.version,
  description: x.description,
  lifecycle: x.lifecycle,
  sunsetDate: x.sunsetDate,
  successorId: x.successorId,
  objectives: x.objectives,
  source: !x.source
    ? null
    : x.source.kind === 'port'
      ? {
          kind: 'port',
          portId: x.source.product.hidden ? undefined : x.source.portId,
          product: ref(x.source.product),
          portName: x.source.portName,
          version: x.source.version,
        }
      : x.source.kind === 'element'
        ? { kind: 'element', elementId: x.source.elementId }
        : { kind: 'text', text: x.source.text },
  objects: { declared: x.objects.declared.map(ref), throughElements: x.objects.throughElements.map(ref) },
  bindings: x.bindings.map((b) => ({
    environment: b.environment,
    contractId: b.contractId,
    contractKey: b.contract && !b.contract.hidden ? b.contract.key : null,
    contract: ref(b.contract),
    contractVersion: b.contractVersion,
    contractServer: b.contract && b.contract.hidden ? null : b.contractServer,
    objectives: b.objectives,
    elementIds: b.elementIds,
  })),
  consumers: x.consumers,
  consumesDeprecated: x.consumesDeprecated,
});

/** The scorecard of a product in an environment, summed up: maturity and the state of each part (WP4: scorecard.ts). */
function scorecardSummary(productId: string, environment: string | undefined) {
  const c = scorecardsOf(me(), [productId], environment).get(productId);
  if (!c) return { environment: null, maturity: null, parts: [] };
  return { environment: c.environment, maturity: c.maturity, parts: c.parts.map((x) => ({ id: x.id, group: x.group, state: x.state })) };
}

/** One product as the public API gives it (shared with the MCP tools). */
export function productDetail(p: DataProduct) {
  const byEnv = productHealthByEnvironment(me(), p.id);
  const def = byEnv.find((h) => h.environment === (p.environments[0] ?? '')) ?? byEnv[0];
  return {
    ...entryOf(p, def),
    description: p.description,
    purpose: p.purpose,
    support: p.support,
    lifecycleDates: p.lifecycleDates,
    successor: ref(p.successor),
    valueStatement: p.valueStatement,
    valueAmount: p.valueAmount === null ? null : String(p.valueAmount / 1e6),
    valueCurrency: p.valueCurrency,
    externalRefs: p.externalRefs,
    environmentDetails: p.environmentDetails.map((e) => ({ environment: e.environment, state: e.state, production: e.production })),
    ports: p.ports.map(portOf),
    memberCounts: p.memberCounts,
    objects: p.objects.map(ref),
    healthByEnvironment: byEnv.map((h) => health(h)!),
    scorecard: scorecardSummary(p.id, def?.environment ?? undefined),
  };
}

/** The lineage of a product (its pipeline with the neighbours in other products), or of one of its elements. */
export async function productLineage(productId: string, q: { environment?: string; element?: string; depth: number }) {
  const { row } = svc.visibleProduct(productId);
  if (q.element) {
    if (!membersOf([row.id]).some((m) => m.element_id === q.element))
      throw new HttpError(404, `Element ${q.element} is not part of this product`, 'DATA_MEMBER_NOT_FOUND', { id: q.element });
    const v = await lineageView(q.element, q.depth);
    return graphOut(v, {
      view: 'lineage',
      product: { id: row.id, key: row.key, name: row.name },
      environment: v.element.environment,
      element: v.element,
      depth: v.depth,
    });
  }
  const v = pipelineView(row.id, q.environment);
  return graphOut(v, { view: 'pipeline', product: v.product, environment: v.environment, element: null, depth: null });
}

function graphOut(g: DataGraph, head: Record<string, unknown>) {
  return {
    ...head,
    nodes: g.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      detail: n.detail,
      ...(n.hidden ? { hidden: true } : {}),
      ...(n.parent ? { parent: n.parent } : {}),
      ...(n.group ? { group: true } : {}),
      health: n.health,
      ...(n.elementKind ? { elementKind: n.elementKind } : {}),
      ...(n.layer !== undefined ? { layer: n.layer } : {}),
      ...(n.environment !== undefined ? { environment: n.environment } : {}),
      ...(n.role ? { role: n.role } : {}),
      ...(n.outside ? { outside: true } : {}),
      ...(n.products ? { products: n.products } : {}),
      ...(n.hiddenProducts ? { hiddenProducts: n.hiddenProducts } : {}),
      ...(n.missing ? { missing: true } : {}),
      ...(n.distance !== undefined ? { distance: n.distance } : {}),
      ...(n.count !== undefined ? { count: n.count } : {}),
      ...(n.technology ? { technology: n.technology } : {}),
    })),
    // 0.24.0: ways a lineage source proposes are marked, never passed off as documented
    edges: g.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      labels: e.labels,
      count: e.count,
      ...(e.hidden ? { hidden: true } : {}),
      ...(e.proposed ? { proposed: true } : {}),
    })),
    steps: g.steps.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      runner: s.runner,
      inputs: s.inputs,
      outputs: s.outputs,
      hidden: s.hidden,
      ...(s.proposed ? { proposed: true } : {}),
    })),
    truncated: g.truncated,
    hidden: g.hidden,
  };
}

/** An element with its health (shared with the MCP tools). */
export function elementDetail(id: string) {
  const e = el.getElement(id);
  const h = elementHealthOf(me(), [e.id]).get(e.id);
  const {
    permissions: _p,
    discoverySourceId: _d,
    applicationId: _a,
    componentId: _c,
    plantSink: _s,
    revision: _r,
    createdAt: _ca,
    createdBy: _cb,
    updatedBy: _ub,
    ...rest
  } = e;
  return {
    ...rest,
    productRefs: e.productRefs.map((x) => ({ product: ref(x.product)!, role: x.role })),
    objects: e.objects.map(ref),
    readout: e.readout,
    health: { status: h?.status ?? 'noData', checks: h?.checks ?? { visible: 0, hidden: 0 } },
  };
}

export function dataProductApiRoutes(get: Get): void {
  get(
    '/data-products',
    {
      operationId: 'listDataProducts',
      tag: TAG,
      summary: 'List data products',
      description: `Data products the token owner may see, ordered by name, with their rating, lifecycle, environments and health in the default environment. Filter by domain (its sub-domains included), lifecycle, type, environment or owning team. ${MODULE}`,
      query: DataProductV1ListQuery,
      paginated: true,
      response: page('DataProductEntry', 'A page of data products'),
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof DataProductV1ListQuery>;
      const p = svc.listProducts({ ...q, limit: q.limit ?? 50 });
      const h = healthOf(
        me(),
        p.items.map((x) => x.id),
      );
      linkNext(req, reply, p.next);
      return { items: p.items.map((x) => entryOf(x, h.get(x.id))), nextCursor: p.next };
    },
  );
  get(
    '/data-products/:productId',
    {
      operationId: 'getDataProduct',
      tag: TAG,
      summary: 'Get a data product',
      description: `A product with its ports – bindings per environment with their data contract (Steward's id and the ODCS id), objectives, data objects and consumer counts –, member counts, the data objects it exposes, health per environment and the scorecard summary. ${MODULE}`,
      params: { productId: 'Data product id' },
      response: { $ref: 'DataProductDetail#' },
    },
    async (req) => {
      const id = (req.params as { productId: string }).productId;
      return productDetail(found(() => svc.getProduct(id), `Data product ${id}`));
    },
  );
  get(
    '/data-products/:productId/odps',
    {
      operationId: 'getDataProductOdps',
      tag: TAG,
      summary: 'Get a data product as ODPS v1.0.0',
      description: `The product as an Open Data Product Standard v1.0.0 document (JSON): ports with versions and the contract ids of one environment's bindings (production unless asked), team, support, tags and Steward's extras under customProperties. ${MODULE}`,
      params: { productId: 'Data product id' },
      query: DataProductOdpsQuery,
      response: { type: 'object', additionalProperties: true, description: 'An ODPS v1.0.0 document' },
    },
    async (req) => {
      const id = (req.params as { productId: string }).productId;
      const q = req.query as z.infer<typeof DataProductOdpsQuery>;
      return found(() => odpsDocument(id, q.environment), `Data product ${id}`);
    },
  );
  get(
    '/data-products/:productId/openlineage',
    {
      operationId: 'getDataProductOpenLineage',
      tag: TAG,
      summary: 'Export a data product as OpenLineage events',
      description: `The product's static lineage as OpenLineage 2-0-x events in JSON Lines (0.25.0): a DatasetEvent per element (with a schema facet from the bound data contract) and a JobEvent per step with the jobType facet – no run, Steward documents the pipeline. With ?step= one step only, with ?environment= the steps and members of one environment. Inputs and outputs the token owner may not see are counted in the facet steward_hiddenEnds, never named. ${MODULE}`,
      params: { productId: 'Data product id' },
      query: DataProductOpenLineageQuery,
      response: {
        // JSON Lines: one OpenLineage event (a JSON object) per line – no schema of its own (each line is an OpenLineage event)
        content: { 'application/x-ndjson': { schema: { description: 'One OpenLineage event (JSON) per line; empty when the product has no element' } } },
      },
    },
    async (req, reply) => {
      const id = (req.params as { productId: string }).productId;
      const q = req.query as z.infer<typeof DataProductOpenLineageQuery>;
      const f = found(() => openLineageExport(id, { environment: q.environment, stepId: q.step }), `Data product ${id}`);
      return reply.type('application/x-ndjson; charset=utf-8').send(f.body);
    },
  );
  get(
    '/data-products/:productId/lineage',
    {
      operationId: 'getDataProductLineage',
      tag: TAG,
      summary: 'Get the lineage of a data product',
      description: `The product's pipeline in an environment (its elements by layer, the steps between them and the neighbouring elements of other products), or with ?element= the lineage of one of its elements 1–4 steps up and down (at most 200 nodes, the rest counted). What the token owner may not see has no name and is counted. ${MODULE}`,
      params: { productId: 'Data product id' },
      query: DataProductLineageQuery,
      response: { $ref: 'DataLineage#' },
    },
    async (req) => {
      const id = (req.params as { productId: string }).productId;
      const q = req.query as z.infer<typeof DataProductLineageQuery>;
      try {
        return await productLineage(id, { ...q, depth: q.depth ?? 2 });
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Data product ${id}`);
        throw e;
      }
    },
  );

  get(
    '/data-elements',
    {
      operationId: 'listDataElements',
      tag: TAG,
      summary: 'List elements of the data catalogue',
      description: `Tables, views, topics, APIs and paths on platforms the token owner may see, ordered by qualified name, with the products they are part of (hidden ones counted). Filter by platform, kind, environment or a prefix of the qualified name. ${MODULE}`,
      query: DataElementV1ListQuery,
      paginated: true,
      response: page('DataElementEntry', 'A page of elements'),
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof DataElementV1ListQuery>;
      const p = el.listElements({ ...q, limit: q.limit ?? 50 });
      linkNext(req, reply, p.next);
      return { items: p.items, nextCursor: p.next };
    },
  );
  get(
    '/data-elements/:elementId',
    {
      operationId: 'getDataElement',
      tag: TAG,
      summary: 'Get an element of the data catalogue',
      description: `An element with its readout (metadata only), the products it is part of with its role, the data objects it implements and its health from linked checks. ${MODULE}`,
      params: { elementId: 'Element id' },
      response: { $ref: 'DataElementDetail#' },
    },
    async (req) => {
      const id = (req.params as { elementId: string }).elementId;
      return found(() => elementDetail(id), `Element ${id}`);
    },
  );

  get(
    '/data-objects',
    {
      operationId: 'listDataObjects',
      tag: TAG,
      summary: 'List data objects',
      description: `The business data – Customer, Order – the token owner may see, ordered by name, with rating, classification and personal data. ${MODULE}`,
      query: DataObjectV1ListQuery,
      paginated: true,
      response: page('DataObjectEntry', 'A page of data objects'),
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof DataObjectV1ListQuery>;
      const p = svc.listObjects({ ...q, limit: q.limit ?? 50 });
      linkNext(req, reply, p.next);
      return { items: p.items.map((o) => ({ ...o, domain: ref(o.domain) })), nextCursor: p.next };
    },
  );
  get(
    '/data-objects/semantic-model',
    {
      operationId: 'getDataObjectsSemanticModel',
      tag: TAG,
      summary: 'The data objects as an Apache Ossie semantic model',
      description: `The business vocabulary of the data products module as an [Apache Ossie](https://github.com/apache/ossie) document: each data object the token owner may see a dataset with its key attributes as fields, relationships from attributes named after another object's key. JSON or YAML (\`Accept: application/yaml\` or \`format=yaml\`). Unlike /semantic-model it differs between tokens (team scope). See docs/DATA-PRODUCTS.md. ${MODULE}`,
      query: SemanticModelQuery,
      response: {
        content: {
          'application/json': { schema: ossieDocumentSchema },
          'application/yaml': { schema: { type: 'string', description: 'The same document as YAML' } },
        },
      },
    },
    async (req, reply) => {
      const q = req.query as { format?: 'json' | 'yaml'; version: OssieVersion };
      const accept = String(req.headers.accept ?? '');
      const yamlFirst = /yaml/i.test(accept) && (!/json/i.test(accept) || accept.search(/yaml/i) < accept.search(/json/i));
      const doc = dataObjectsSemanticModel(me(), q.version);
      if (q.format === 'yaml' || (!q.format && yamlFirst)) return reply.type('application/yaml; charset=utf-8').send(YAML.stringify(doc, { lineWidth: 0 }));
      return reply.type('application/json; charset=utf-8').send(JSON.stringify(doc));
    },
  );
  get(
    '/data-objects/:objectId',
    {
      operationId: 'getDataObject',
      tag: TAG,
      summary: 'Get a data object',
      description: `A data object with its definition, rating, classification, personal data, legal basis, retention, roles, the elements that implement it (counted) and the products that expose it. ${MODULE}`,
      params: { objectId: 'Data object id' },
      response: { $ref: 'DataObjectDetail#' },
    },
    async (req) => {
      const id = (req.params as { objectId: string }).objectId;
      const o = found(() => svc.getObject(id), `Data object ${id}`);
      return { ...o, domain: ref(o.domain), products: { items: o.products.items.map(ref), hidden: o.products.hidden } };
    },
  );
  // 0.25.0 (ADR 0037 part 4): the product's semantic model – the governed copy, as stored, with its versions and sign-offs
  get(
    '/data-products/:productId/semantic-model',
    {
      operationId: 'getDataProductSemanticModel',
      tag: TAG,
      summary: 'Get the semantic model of a data product',
      description: `The product's Apache Ossie semantic model as it was stored (YAML or JSON, as written): the newest version, a given one (?version=) or the one signed off and valid on a day (?date=); with ?environment= the datasets' sources are rewritten to the product's elements of that environment. The headers x-steward-semantic-version and x-steward-sha256 name the version (the SHA-256 of the stored text). 404 when the product has none. See docs/DATA-PRODUCTS.md#semantic-models. ${MODULE}`,
      params: { productId: 'Data product id' },
      query: DataSemanticModelV1Query,
      response: {
        content: {
          'application/yaml': { schema: { type: 'string', description: 'The document as stored (YAML)' } },
          'application/json': { schema: { type: 'object', additionalProperties: true, description: 'The document as stored (JSON)' } },
        },
      },
    },
    async (req, reply) => {
      const id = (req.params as { productId: string }).productId;
      const q = req.query as z.infer<typeof DataSemanticModelV1Query>;
      const x = semanticFound(() => semanticExport(id, q), id);
      reply.header('x-steward-semantic-version', String(x.version.version));
      reply.header('x-steward-sha256', x.version.sha256);
      if (x.notRewritten) reply.header('x-steward-sources-not-rewritten', String(x.notRewritten));
      return reply.type(x.contentType).send(x.body);
    },
  );
  get(
    '/data-products/:productId/semantic-model/versions',
    {
      operationId: 'listDataProductSemanticModelVersions',
      tag: TAG,
      summary: 'List the versions of a data product’s semantic model',
      description: `Every saved version of the product's semantic model (who, when, SHA-256) with its sign-off; the version valid today; with ?date= which version was signed off and valid on that day, and who approved it. ${MODULE}`,
      params: { productId: 'Data product id' },
      query: DataSemanticVersionsV1Query,
      response: { $ref: 'DataSemanticVersions#' },
    },
    async (req) => {
      const id = (req.params as { productId: string }).productId;
      const q = req.query as z.infer<typeof DataSemanticVersionsV1Query>;
      const v = found(() => semanticModelView(id), `Data product ${id}`);
      return { productId: v.productId, versions: v.versions, validToday: v.validToday, validOn: q.date ? validAnswer(v.productId, q.date) : null };
    },
  );
}

/** A semantic model the product does not have answers 404 as the API's problem too. */
function semanticFound<T>(f: () => T, id: string): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404)
      throw notFound(e.code === 'DATA_SEMANTIC_MODEL_NOT_FOUND' ? `The semantic model of data product ${id}` : `Data product ${id}`);
    throw e;
  }
}
