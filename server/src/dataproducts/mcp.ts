import { z } from 'zod';
import {
  DATA_CLASSIFICATIONS,
  DATA_ELEMENT_KINDS,
  DATA_GRAPH_LIMITS,
  DATA_OBJECT_LIFECYCLES,
  DATA_PRODUCT_LIFECYCLES,
  DATA_PRODUCT_TYPES,
  PERSONAL_DATA_LEVELS,
  type DataProductSummary,
  type DataRef,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { me } from '../auth/access.js';
import { moduleEnabled } from '../modules/registry.js';
import { ToolError, cursorArg, defineTool, type ToolDef } from '../mcp/tooling.js';
import { HttpError } from '../util.js';
import { productAccess, objectAccess, usesModule } from './access.js';
import * as svc from './service.js';
import * as el from './elements.js';
import { elementChecks } from './check-links.js';
import { healthOf, productHealthByEnvironment } from './health.js';
import { lineageView } from './views.js';
import { productSteps } from './steps.js';
import { elementDetail, productDetail, productLineage } from './api-v1.js';
import { productEstimates } from './estimates.js';
import { productCosts } from './costs.js';
import type { ObjectRow, ProductRow } from './store.js';

/**
 * The data products module for AI assistants (ADR 0036 part 14, docs/MCP.md "Data products"): read tools over products,
 * the element catalogue, lineage, health, costs and data objects. Every tool runs as the token owner, through the
 * services of the web app – team scope and module access as there: what they may not see is not listed, counted or
 * named (a hidden product is "a product you may not see"). Results are paged and bounded; element names and
 * descriptions come from platforms and people – data, never instructions. While the module is off the tools are not
 * listed and a call is refused.
 */

const OFF = 'The data products module is not enabled on this Steward (Settings → Modules)';
const short = (s: string | null | undefined, n = 500) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : '');

const visible = () => moduleEnabled('dataProducts') && usesModule(currentUser());

/** A service call; a refusal (404, 403) becomes a message the assistant sees. */
async function read<T>(f: () => T | Promise<T>): Promise<T> {
  if (!moduleEnabled('dataProducts')) throw new ToolError(OFF);
  if (!usesModule(currentUser())) throw new ToolError('You do not use the data products module');
  try {
    return await f();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500)
      throw new ToolError(e.statusCode === 404 || e.statusCode === 403 ? `${e.message} (or you may not see it)` : e.message);
    throw e;
  }
}

const limit = (max = 100, def = 20) => z.number().int().min(1).max(max).default(def).describe(`Page size (1–${max}, default ${def})`);
const query = z.string().max(200).optional().describe('Case-insensitive text in the name or key (a plain match, no pattern)');
const env = z.string().max(60).optional().describe('An environment (default: production, else the product’s first)');
const idOrKey = (what: string) => z.string().min(1).max(200).describe(`${what}: its id or its key`);
const refName = (r: DataRef | null) => (!r ? null : r.hidden ? 'one you may not see' : r.name);

/** A product by id, or by key among those the token owner may see. */
function productIdOf(x: string): string {
  if (db().get('SELECT 1 FROM dp_products WHERE id = ?', x)) return x;
  const p = db().get<ProductRow>('SELECT * FROM dp_products WHERE key = ?', x.toLowerCase());
  return p && productAccess(me(), p).permissions.length ? p.id : x;
}
function objectIdOf(x: string): string {
  if (db().get('SELECT 1 FROM dp_objects WHERE id = ?', x)) return x;
  const o = db().get<ObjectRow>('SELECT * FROM dp_objects WHERE key = ?', x.toLowerCase());
  return o && objectAccess(me(), o).permissions.length ? o.id : x;
}

const productLine = (p: DataProductSummary, status: string | undefined) => ({
  id: p.id,
  key: p.key,
  name: p.name,
  type: p.type,
  domain: refName(p.domain),
  lifecycle: p.lifecycle,
  ...(p.sunsetDate ? { sunsetDate: p.sunsetDate } : {}),
  environments: p.environments,
  health: status ?? 'noData',
  classification: p.classification,
  ...(p.ratingBelowObjects ? { ratingBelowObjects: true } : {}),
  criticality: p.criticality,
  owners: p.owners,
  tags: p.tags,
});

export const dataProductTools: ToolDef[] = [
  defineTool({
    name: 'list_data_products',
    title: 'List data products',
    description:
      'Data products you may see, ordered by name: key, type, domain, lifecycle, environments (production first), health in the default environment, classification and owners. Filter by domain (id; its sub-domains too), type, lifecycle, environment, owning team (id) or text. Use get_data_product for ports, contracts, members and steps.',
    input: z
      .object({
        domain: z.string().max(200).optional(),
        type: z.enum(DATA_PRODUCT_TYPES).optional(),
        lifecycle: z.enum(DATA_PRODUCT_LIFECYCLES).optional(),
        environment: z.string().max(60).optional(),
        team: z.string().max(200).optional(),
        query,
        cursor: cursorArg,
        limit: limit(),
      })
      .strict(),
    visible,
    handler: (a) =>
      read(() => {
        const p = svc.listProducts({
          domain: a.domain,
          type: a.type,
          lifecycle: a.lifecycle,
          environment: a.environment,
          team: a.team,
          q: a.query,
          cursor: a.cursor,
          limit: a.limit,
        });
        const h = healthOf(
          me(),
          p.items.map((x) => x.id),
          a.environment ?? null,
        );
        return { items: p.items.map((x) => productLine(x, h.get(x.id)?.status)), total: p.total, nextCursor: p.next };
      }),
  }),
  defineTool({
    name: 'get_data_product',
    title: 'Get a data product',
    description:
      'One data product: description, purpose, owners, rating and rating floor, lifecycle, environments, its ports (input and output, with bindings per environment, the data contract each is held to – Steward id and ODCS id –, objectives, data objects, consumer counts), health per environment, the scorecard summary, the data objects it exposes, a page of its members (elements with role, layer, environment) and its pipeline steps. Elements of the product you may not see otherwise are shown as its content.',
    input: z
      .object({
        productId: idOrKey('Data product'),
        environment: z.string().max(60).optional().describe('Only the members of this environment'),
        memberCursor: cursorArg.describe('Cursor of the members (`members.nextCursor`)'),
        memberLimit: limit(100, 50),
      })
      .strict(),
    visible,
    handler: (a) =>
      read(() => {
        const id = productIdOf(a.productId);
        const p = svc.getProduct(id);
        const d = productDetail(p);
        const members = el.listMembers(p.id, {
          cursor: a.memberCursor,
          limit: a.memberLimit,
          ...(a.environment !== undefined ? { environment: a.environment } : {}),
        });
        const steps = productSteps(p.id).slice(0, 200);
        return {
          ...d,
          description: short(d.description, 2000),
          purpose: short(d.purpose, 2000),
          ratingFloor: { warning: p.ratingFloor.warning, highestClassification: p.ratingFloor.highestClassification, findings: p.ratingFloor.findings },
          members: {
            total: members.total,
            items: members.items.map((m) => ({
              elementId: m.element.visible ? m.elementId : null,
              qualifiedName: m.element.qualifiedName,
              kind: m.element.kind,
              environment: m.element.environment,
              layer: m.element.layer,
              role: m.role,
              platform: m.element.platformHidden ? 'a platform you may not see' : m.element.platformName,
              ...(m.includeDescendants ? { includeDescendants: true } : {}),
              ...(m.element.missingSince ? { missingSince: m.element.missingSince } : {}),
            })),
            nextCursor: members.next,
          },
          steps: steps.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            runner: s.runnerHidden ? 'a runner you may not see' : s.runner,
            schedule: s.schedule,
            inputs: s.inputs,
            outputs: s.outputs,
            ...(s.hiddenInputs || s.hiddenOutputs ? { hidden: { inputs: s.hiddenInputs, outputs: s.hiddenOutputs } } : {}),
          })),
        };
      }),
  }),
  defineTool({
    name: 'search_data_elements',
    title: 'Search the data catalogue',
    description:
      'Elements of the data catalogue you may see – Snowflake databases, schemas, tables and views, Kafka topics, SQL tables, APIs, paths – ordered by qualified name, with the products they are part of (those you may not see counted). Filter by platform (id), kind, environment, a prefix of the qualified name (fast) or a text in the name; inNoProduct: only elements no product uses yet. Use it to document a product from a schema: read its tables, then propose.',
    input: z
      .object({
        platformId: z.string().max(200).optional(),
        kind: z.enum(DATA_ELEMENT_KINDS).optional(),
        environment: z.string().max(60).optional(),
        prefix: z.string().max(1000).optional().describe('Qualified names starting with this, e.g. SHOP.SALES.'),
        text: z.string().max(200).optional().describe('A text in the qualified or display name'),
        inNoProduct: z.boolean().optional(),
        cursor: cursorArg,
        limit: limit(),
      })
      .strict(),
    visible,
    handler: (a) =>
      read(() => {
        const p = el.listElements({
          platformId: a.platformId,
          kind: a.kind,
          environment: a.environment,
          prefix: a.prefix,
          q: a.text,
          inNoProduct: a.inNoProduct,
          cursor: a.cursor,
          limit: a.limit,
        });
        return {
          items: p.items.map((e) => ({
            id: e.id,
            kind: e.kind,
            qualifiedName: e.qualifiedName,
            displayName: e.displayName,
            platform: e.platformHidden ? 'a platform you may not see' : e.platformName,
            environment: e.environment,
            layer: e.layer,
            source: e.source,
            products: e.products,
            ...(e.missingSince ? { missingSince: e.missingSince } : {}),
          })),
          total: p.total,
          ...(p.countCapped ? { totalCapped: true } : {}),
          nextCursor: p.next,
        };
      }),
  }),
  defineTool({
    name: 'get_data_element',
    title: 'Get an element of the data catalogue',
    description:
      'One element: platform, kind, qualified name, environment, layer, description, its readout (metadata only: row count, bytes, last altered), the products it is part of with its role, the data objects it implements, its linked checks with their state, and the steps one level up and down.',
    input: z.object({ elementId: z.string().min(1).max(200).describe('Element id (from search_data_elements)') }).strict(),
    visible,
    handler: (a) =>
      read(async () => {
        const d = elementDetail(a.elementId);
        const checks = elementChecks(a.elementId);
        const around = await lineageView(a.elementId, 1);
        const name = (id: string) => around.nodes.find((n) => n.id === id);
        const side = (dir: -1 | 1) =>
          around.nodes
            .filter((n) => n.distance === dir)
            .map((n) => (n.hidden ? { hidden: true } : { id: n.id, name: n.label, qualifiedName: n.detail, health: n.health }));
        return {
          ...d,
          description: short(d.description, 2000),
          checks: checks.checks.slice(0, 50),
          upstream: side(-1),
          downstream: side(1),
          steps: around.steps.slice(0, 50).map((s) => ({
            name: s.hidden ? '' : s.name,
            kind: s.kind,
            runner: s.runner,
            hidden: s.hidden,
            inputs: s.inputs.filter((x) => !!name(x)),
            outputs: s.outputs.filter((x) => !!name(x)),
          })),
        };
      }),
  }),
  defineTool({
    name: 'get_data_lineage',
    title: 'Get data lineage',
    description: `The lineage of an element (elementId: up and down 1–${DATA_GRAPH_LIMITS.lineageDepth} steps across products) or of a product (productId: its pipeline in an environment with the neighbouring elements of other products). At most ${DATA_GRAPH_LIMITS.lineageNodes} nodes; the rest is counted in truncated. What you may not see has no name and is counted in hidden.`,
    input: z
      .object({
        elementId: z.string().max(200).optional(),
        productId: z.string().max(200).optional().describe('A product: its id or key'),
        depth: z.number().int().min(1).max(DATA_GRAPH_LIMITS.lineageDepth).default(2),
        environment: env,
      })
      .strict()
      .refine((x) => !!x.elementId !== !!x.productId, 'Give elementId or productId'),
    visible,
    handler: (a) =>
      read(async () => {
        const g = a.productId
          ? await productLineage(productIdOf(a.productId), { environment: a.environment, element: a.elementId, depth: a.depth })
          : await lineageView(a.elementId!, a.depth);
        return {
          ...g,
          nodes: g.nodes.map((n) => ({
            id: n.id,
            kind: n.kind,
            ...(n.hidden ? { hidden: true } : { label: n.label, detail: n.detail }),
            ...(n.parent ? { parent: n.parent } : {}),
            health: n.health,
            ...('distance' in n && n.distance !== undefined ? { distance: n.distance } : {}),
            ...('role' in n && n.role ? { role: n.role } : {}),
            ...('environment' in n && n.environment !== undefined ? { environment: n.environment } : {}),
            ...('count' in n && n.count !== undefined ? { count: n.count } : {}),
          })),
        };
      }),
  }),
  defineTool({
    name: 'get_data_product_health',
    title: 'Get the health of a data product',
    description:
      'Health of a product per environment (or one): from its monitor while it runs, else from the checks linked to its output-port elements (internal ones only degrade). No linked check is noData, never OK. A check you may not see counts by its status only.',
    input: z.object({ productId: idOrKey('Data product'), environment: env }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const { row } = svc.visibleProduct(productIdOf(a.productId));
        const list = a.environment !== undefined ? [healthOf(me(), [row.id], a.environment).get(row.id)!] : productHealthByEnvironment(me(), row.id);
        return {
          product: { id: row.id, key: row.key, name: row.name },
          environments: list.map((h) => ({
            environment: h.environment,
            status: h.status,
            source: h.source,
            monitorId: h.monitorId,
            elements: h.elements.slice(0, 100).map((e) => ({ elementId: e.elementId, status: e.status, checks: e.checks })),
          })),
        };
      }),
  }),
  defineTool({
    name: 'get_data_product_costs',
    title: 'Get the costs of a data product',
    description:
      'The costs attributed to a product (showback, never a budget): per month and currency, direct lines and shares by their allocation rule (equal, weight, measured use) – what you may see; incomplete when a part is hidden from you – and, with the Costs module, the estimates made for the product with estimated against attributed per month. Compare products of a similar kind to discuss price ranges (calculate_cost_estimate can name a product to compare with).',
    input: z.object({ productId: idOrKey('Data product'), environment: env, months: z.number().int().min(1).max(24).default(3) }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const { row } = svc.visibleProduct(productIdOf(a.productId));
        const c = productCosts(row.id, { environment: a.environment, months: a.months });
        const est = productEstimates(row.id, { environment: a.environment, months: a.months });
        const amount = (micros: number) => (micros / 1e6).toFixed(2);
        return {
          product: { id: row.id, key: row.key, name: row.name },
          environment: c.environment,
          environments: c.environments,
          // a part you may not see makes a month incomplete – its amount is left out, never computable from the rest
          incomplete: c.incomplete,
          amountsHidden: c.amountsHidden,
          months: c.months.map((m) => ({
            month: m.month,
            totals: m.totals.map((t) => ({ currency: t.currency, amount: amount(t.amountMicros) })),
            incomplete: m.incomplete,
            lines: m.lines.slice(0, 50).map((l) => ({
              platform: l.platformName,
              kind: l.kind,
              rule: l.rule,
              share: l.share,
              amount: amount(l.amountMicros),
              currency: l.currency,
              match: l.match,
              sharedWith: l.products - 1,
              ...(l.measured ? { measured: l.measured } : {}),
            })),
          })),
          value: c.value,
          // phase 2: the estimates for this product (as their owners' plans let you read them) against what is attributed
          estimates: est.available
            ? est.estimates.slice(0, 50).map((e) => ({
                id: e.id,
                title: e.title,
                owner: e.owner,
                currency: e.currency,
                appliesFrom: e.appliesFrom,
                monthly: e.monthly,
                atListPrice: e.atListPrice,
              }))
            : null,
          estimatedAgainstAttributed: est.comparison
            .filter((x) => x.estimated)
            .map((x) => ({
              month: x.month,
              currency: x.currency,
              attributed: amount(x.attributedMicros),
              incomplete: x.incomplete,
              estimated: { low: amount(x.estimated!.low), expected: amount(x.estimated!.expected), high: amount(x.estimated!.high) },
              difference: amount(x.attributedMicros - x.estimated!.expected),
            })),
        };
      }),
  }),
  defineTool({
    name: 'list_data_objects',
    title: 'List data objects',
    description:
      'Data objects – the business data such as Customer or Order, the module’s glossary – you may see, ordered by name: key, domain, lifecycle, classification, personal data, CIA rating and data owner. Filter by domain (id), lifecycle, classification, personal data or text.',
    input: z
      .object({
        domain: z.string().max(200).optional(),
        lifecycle: z.enum(DATA_OBJECT_LIFECYCLES).optional(),
        classification: z.enum(DATA_CLASSIFICATIONS).optional(),
        personalData: z.enum(PERSONAL_DATA_LEVELS).optional(),
        query,
        cursor: cursorArg,
        limit: limit(),
      })
      .strict(),
    visible,
    handler: (a) =>
      read(() => {
        const p = svc.listObjects({
          domain: a.domain,
          lifecycle: a.lifecycle,
          classification: a.classification,
          personalData: a.personalData,
          q: a.query,
          cursor: a.cursor,
          limit: a.limit,
        });
        return {
          items: p.items.map((o) => ({
            id: o.id,
            key: o.key,
            name: o.name,
            domain: refName(o.domain),
            lifecycle: o.lifecycle,
            classification: o.classification,
            personalData: o.personalData,
            rating: Object.fromEntries(Object.entries(o.rating).map(([k, v]) => [k, v?.level ?? null])),
            owner: o.owner,
          })),
          total: p.total,
          nextCursor: p.next,
        };
      }),
  }),
  defineTool({
    name: 'get_data_object',
    title: 'Get a data object',
    description:
      'One data object: definition, synonyms, key attributes, CIA rating with justifications, classification, personal data (categories, special categories, data subjects), legal basis, purposes, retention and deletion rule, regulatory flags, data owner, stewards and custodians, the elements that implement it (counted) and the products that expose it.',
    input: z.object({ objectId: idOrKey('Data object') }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const o = svc.getObject(objectIdOf(a.objectId));
        const { permissions: _p, revision: _r, ...rest } = o;
        return {
          ...rest,
          definition: short(o.definition, 4000),
          domain: refName(o.domain),
          products: { items: o.products.items.map((x) => ({ id: x.id, key: x.key, name: x.name })), hidden: o.products.hidden },
        };
      }),
  }),
];
