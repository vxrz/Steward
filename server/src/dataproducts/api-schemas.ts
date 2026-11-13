import { z, type ZodTypeAny } from 'zod';
import {
  DATA_CLASSIFICATIONS,
  DATA_ELEMENT_KINDS,
  DATA_ELEMENT_SOURCES,
  DATA_ENVIRONMENT_STATES,
  DATA_MEMBER_ROLES,
  DATA_OBJECT_LIFECYCLES,
  DATA_PORT_DIRECTIONS,
  DATA_PORT_LIFECYCLES,
  DATA_PORT_TYPES,
  DATA_PRODUCT_CRITICALITIES,
  DATA_PRODUCT_LIFECYCLES,
  DATA_PRODUCT_TYPES,
  DATA_SCORECARD_STATES,
  DATA_VALUE_TIERS,
  LEGAL_BASES,
  PERSONAL_DATA_LEVELS,
} from '@sm/shared';

/**
 * Response and query schemas of the data products module in the public API (/api/v1/data-products, /data-elements,
 * /data-objects; ADR 0036 part 19). Read-only, as the token owner: what they may not see is not listed, counted or
 * named – a reference to it is `{ hidden: true }` without a name or id.
 */

const ts = () => z.string().describe('ISO 8601 timestamp (UTC)');
const limit = z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)');
const cursor = z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)');
const id = z.string().max(200);
const HEALTH = ['up', 'degraded', 'down', 'blocked', 'unknown', 'maintenance', 'off', 'noData'] as const;

const Ref = z
  .object({
    id: z.string().nullable(),
    key: z.string().nullable(),
    name: z.string().nullable(),
    hidden: z.boolean().describe('Something the token owner may not see: no id, key or name'),
  })
  .describe('A domain, product, data object or contract – or one the token owner may not see');

const Dimension = z
  .object({ level: z.string(), justification: z.string(), ratedAt: ts(), ratedBy: z.string(), needsRerating: z.boolean() })
  .nullable()
  .describe('A level of the instance’s CIA scale (GET /cia-scale); null: not rated');
const Rating = z.object({ confidentiality: Dimension, integrity: Dimension, availability: Dimension });

const Objectives = z
  .object({
    freshnessMinutes: z.number().nullable().optional(),
    availabilityPct: z.number().nullable().optional(),
    completeness: z.string().nullable().optional(),
    completenessPct: z.number().nullable().optional(),
    updateSchedule: z.string().nullable().optional(),
    retention: z.string().nullable().optional(),
  })
  .describe('Objectives (SLO): freshness in minutes, availability and completeness in percent over 30 days, an update schedule and retention');

const Health = z.object({
  environment: z.string(),
  status: z.enum(HEALTH).describe('From the linked checks; noData without one (never OK without a check)'),
  source: z.enum(['monitor', 'elements', 'none']),
});

export const DataProductEntry = z.object({
  id: z.string(),
  key: z.string().describe('Unique key (the file format’s and ODPS id)'),
  name: z.string(),
  type: z.enum(DATA_PRODUCT_TYPES).nullable(),
  domain: Ref.nullable(),
  lifecycle: z.enum(DATA_PRODUCT_LIFECYCLES),
  sunsetDate: z.string().nullable(),
  criticality: z.enum(DATA_PRODUCT_CRITICALITIES).nullable(),
  tier: z.number().int().nullable().describe('Support tier 1–3'),
  rating: Rating,
  classification: z.enum(DATA_CLASSIFICATIONS).nullable(),
  ratingBelowObjects: z.boolean().describe('Rated below the data objects it exposes without a reason'),
  valueTier: z.enum(DATA_VALUE_TIERS).nullable(),
  environments: z.array(z.string()).describe('Production first'),
  owners: z.array(z.string()).describe('Product owners: user:<name> or team:<name>'),
  owningTeams: z.array(z.object({ id: z.string(), name: z.string() })),
  tags: z.array(z.string()),
  version: z.string(),
  health: Health.nullable().describe('In the product’s default environment (production, else its first)'),
  updatedAt: ts(),
});

const Binding = z.object({
  environment: z.string(),
  contractId: z.string().nullable().describe('Steward’s id of the data contract (null: none, or one the token owner may not see)'),
  contractKey: z.string().nullable().describe('The contract’s ODCS id'),
  contract: Ref.nullable(),
  contractVersion: z.number().int().nullable().describe('The version it is held to (null: the current one)'),
  contractServer: z.string().nullable(),
  objectives: Objectives.describe('Objectives that differ from the port’s'),
  elementIds: z.array(z.string()),
});

const Port = z.object({
  id: z.string(),
  direction: z.enum(DATA_PORT_DIRECTIONS),
  name: z.string(),
  type: z.enum(DATA_PORT_TYPES),
  version: z.string(),
  description: z.string(),
  lifecycle: z.enum(DATA_PORT_LIFECYCLES),
  sunsetDate: z.string().nullable(),
  successorId: z.string().nullable(),
  objectives: Objectives,
  source: z
    .object({
      kind: z.enum(['port', 'element', 'text']),
      portId: z.string().optional(),
      product: Ref.optional(),
      portName: z.string().nullable().optional(),
      version: z.string().nullable().optional(),
      elementId: z.string().optional(),
      text: z.string().optional(),
    })
    .nullable()
    .describe('Input ports: another product’s output port, an element of a source system, or a text'),
  objects: z.object({ declared: z.array(Ref), throughElements: z.array(Ref) }),
  bindings: z.array(Binding),
  consumers: z.object({ registered: z.number().int(), derived: z.number().int() }),
  consumesDeprecated: z.boolean(),
});

export const DataProductDetail = DataProductEntry.extend({
  description: z.string(),
  purpose: z.string(),
  support: z.object({ channel: z.string(), url: z.string(), hours: z.string() }),
  lifecycleDates: z.record(z.string(), z.string()).describe('When each lifecycle state was reached'),
  successor: Ref.nullable(),
  valueStatement: z.string(),
  valueAmount: z.string().nullable().describe('A yearly amount as a decimal in valueCurrency'),
  valueCurrency: z.string().nullable(),
  externalRefs: z.array(z.object({ label: z.string(), url: z.string() })),
  environmentDetails: z.array(z.object({ environment: z.string(), state: z.enum(DATA_ENVIRONMENT_STATES), production: z.boolean() })),
  ports: z.array(Port),
  memberCounts: z.object({ input: z.number().int(), internal: z.number().int(), output: z.number().int() }),
  objects: z.array(Ref).describe('Data objects its output ports expose (declared or through their elements)'),
  healthByEnvironment: z.array(Health),
  scorecard: z
    .object({
      environment: z.string().nullable(),
      maturity: z.number().int().nullable().describe('Computed from the scorecard, never typed: 0 not yet documented … 4 reliable'),
      parts: z.array(z.object({ id: z.string(), group: z.enum(['part', 'iso25012']), state: z.enum(DATA_SCORECARD_STATES) })),
    })
    .describe('The scorecard in the default environment, summed up: each part and ISO/IEC 25012 dimension with its state'),
});

export const DataElementEntry = z.object({
  id: z.string(),
  platformId: z.string().nullable().describe('null: no platform, or one the token owner may not see (platformHidden)'),
  platformName: z.string().nullable(),
  platformHidden: z.boolean(),
  kind: z.enum(DATA_ELEMENT_KINDS),
  qualifiedName: z.string(),
  displayName: z.string(),
  environment: z.string(),
  layer: z.string(),
  source: z.enum(DATA_ELEMENT_SOURCES),
  parentId: z.string().nullable(),
  missingSince: z.string().nullable(),
  products: z.object({ visible: z.number().int(), hidden: z.number().int() }).describe('Products it is part of (those the token owner may not see counted)'),
  updatedAt: ts(),
});

export const DataElementDetail = DataElementEntry.extend({
  description: z.string(),
  typeLabel: z.string(),
  externalId: z.string().nullable(),
  olNamespace: z.string().nullable(),
  olName: z.string().nullable(),
  apiRef: z.object({ url: z.string().optional(), operations: z.array(z.string()).optional() }).nullable(),
  flags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  owningTeams: z.array(z.object({ id: z.string(), name: z.string() })),
  productRefs: z.array(z.object({ product: Ref, role: z.enum(DATA_MEMBER_ROLES) })),
  objects: z.array(Ref),
  readout: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .nullable()
    .describe('What the last discovery read (metadata: row count, bytes, last altered …; never data)'),
  health: z.object({ status: z.enum(HEALTH), checks: z.object({ visible: z.number().int(), hidden: z.number().int() }) }),
});

export const DataObjectEntry = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  domain: Ref.nullable(),
  lifecycle: z.enum(DATA_OBJECT_LIFECYCLES),
  classification: z.enum(DATA_CLASSIFICATIONS).nullable(),
  personalData: z.enum(PERSONAL_DATA_LEVELS),
  rating: Rating,
  owner: z.string().nullable(),
  updatedAt: ts(),
});

export const DataObjectDetail = DataObjectEntry.extend({
  definition: z.string(),
  synonyms: z.array(z.string()),
  categories: z.array(z.string()),
  specialCategories: z.array(z.string()),
  subjects: z.array(z.string()),
  legalBasis: z.enum(LEGAL_BASES).nullable(),
  legalNote: z.string(),
  purposes: z.array(z.string()),
  retention: z.string(),
  deletionRule: z.string(),
  regulatoryFlags: z.array(z.string()),
  attributes: z.array(z.object({ name: z.string(), description: z.string(), personal: z.boolean() })),
  stewards: z.array(z.string()),
  custodians: z.array(z.string()),
  externalRefs: z.array(z.object({ label: z.string(), url: z.string() })),
  owningTeams: z.array(z.object({ id: z.string(), name: z.string() })),
  elements: z.object({ visible: z.number().int(), hidden: z.number().int() }).describe('Elements that implement it'),
  products: z.object({ items: z.array(Ref), hidden: z.number().int() }).describe('Products that expose or process it'),
});

const GraphNode = z.object({
  id: z.string(),
  kind: z.enum(['element', 'step', 'product', 'domain', 'collapsed', 'plant']),
  label: z.string().describe('Empty when hidden'),
  detail: z.string(),
  hidden: z.boolean().optional(),
  parent: z.string().optional(),
  group: z.boolean().optional(),
  health: z.enum(HEALTH).nullable(),
  elementKind: z.enum(DATA_ELEMENT_KINDS).optional(),
  layer: z.string().optional(),
  environment: z.string().optional(),
  role: z.enum(DATA_MEMBER_ROLES).optional(),
  outside: z.boolean().optional(),
  products: z.array(z.string()).optional(),
  hiddenProducts: z.number().int().optional(),
  missing: z.boolean().optional(),
  distance: z.number().int().optional().describe('Lineage: steps from the element (negative: upstream)'),
  count: z.number().int().optional(),
});

export const DataLineage = z.object({
  view: z.enum(['lineage', 'pipeline']).describe('lineage: around an element (?element); pipeline: the product with its neighbours'),
  product: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  environment: z.string(),
  element: z.object({ id: z.string(), name: z.string(), qualifiedName: z.string(), environment: z.string() }).nullable(),
  depth: z.number().int().nullable(),
  nodes: z.array(GraphNode),
  edges: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      labels: z.array(z.string()),
      count: z.number().int(),
      hidden: z.boolean().optional(),
      proposed: z.boolean().optional().describe('A way a lineage source reports that no step documents yet (an open proposal)'),
    }),
  ),
  steps: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      runner: z.string().nullable(),
      inputs: z.array(z.string()),
      outputs: z.array(z.string()),
      hidden: z.boolean(),
      proposed: z.boolean().optional().describe('An open proposal of a lineage source, not a documented step'),
    }),
  ),
  truncated: z
    .object({ nodes: z.number().int(), upstream: z.number().int(), downstream: z.number().int() })
    .describe('Left out by the node limit (200 in a lineage)'),
  hidden: z.object({ elements: z.number().int(), products: z.number().int() }).describe('Counted, never named'),
});

export const DATA_PRODUCT_COMPONENTS: Record<string, ZodTypeAny> = {
  DataProductEntry,
  DataProductDetail,
  DataElementEntry,
  DataElementDetail,
  DataObjectEntry,
  DataObjectDetail,
  DataLineage,
};

export const DataProductV1ListQuery = z.object({
  limit,
  cursor,
  domain: id.optional().describe('A domain’s id (its sub-domains’ products too)'),
  lifecycle: z.enum(DATA_PRODUCT_LIFECYCLES).optional(),
  type: z.enum(DATA_PRODUCT_TYPES).optional(),
  environment: z.string().max(60).optional().describe('Products that exist in this environment'),
  team: id.optional().describe('An owning team’s id'),
});

export const DataElementV1ListQuery = z.object({
  limit,
  cursor,
  platformId: id.optional(),
  kind: z.enum(DATA_ELEMENT_KINDS).optional(),
  environment: z.string().max(60).optional(),
  prefix: z.string().max(1000).optional().describe('Qualified names starting with this (case-insensitive)'),
});

export const DataObjectV1ListQuery = z.object({
  limit,
  cursor,
  domain: id.optional(),
  lifecycle: z.enum(DATA_OBJECT_LIFECYCLES).optional(),
  classification: z.enum(DATA_CLASSIFICATIONS).optional(),
  personalData: z.enum(PERSONAL_DATA_LEVELS).optional(),
});

export const DataProductOdpsQuery = z.object({
  environment: z.string().max(60).optional().describe('Whose bindings give the ports’ contracts (default: production)'),
});

export const DataProductLineageQuery = z.object({
  environment: z.string().max(60).optional().describe('The pipeline’s environment (default: production)'),
  element: id.optional().describe('An element of the product: its lineage instead of the product’s pipeline'),
  depth: z.number().int().min(1).max(4).default(2).describe('Steps up and down around the element (1–4)'),
});
