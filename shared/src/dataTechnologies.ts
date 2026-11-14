import { z } from 'zod';
import { DATA_ELEMENT_KIND_DEFS, DATA_ELEMENT_KINDS, type DataElementKind } from './dataProducts.js';

/**
 * Generic parts, bridges and the technology list (0.25.0, ADR 0037 part 0, docs/DATA-PRODUCTS.md#generic-parts-and-bridges).
 *
 * Technologies come and go faster than Steward learns to discover them, so a product can be described before Steward
 * knows its technology and gain discovery later without losing anything:
 *
 * - **Parts** are where data rests or flows (elements), **bridges** move it between parts (steps of kind `bridge`).
 * - **Generic element kinds** by role – `generic.dataset`, `generic.stream`, `generic.files`, `generic.endpoint` – carry a
 *   **technology**, a qualified name, an OpenLineage **namespace** (with the qualified name its identity and OpenLineage
 *   dataset, entered by people) and optional key: value **properties**. They take part in everything except discovery.
 * - **One technology list** for parts and bridges: the built-in entries below and those administrators add (Settings →
 *   Catalogue → Data products). A technology typed that is in neither shows as _not in the list_ – kept as it is.
 * - **Convert to …** turns a generic element into a specific kind of the same role (same id, ports, contracts, lineage,
 *   checks and history); discovery takes over from then on.
 */

// ---------- generic element kinds ----------

/** The generic kinds by role: table-like store, topic or queue, file location or prefix, API or service interface. */
export const GENERIC_ELEMENT_KINDS = ['generic.dataset', 'generic.stream', 'generic.files', 'generic.endpoint'] as const satisfies readonly DataElementKind[];
export type GenericElementKind = (typeof GENERIC_ELEMENT_KINDS)[number];
export const isGenericElementKind = (k: unknown): k is GenericElementKind => typeof k === 'string' && (GENERIC_ELEMENT_KINDS as readonly string[]).includes(k);

/**
 * The specific kinds a generic element may be converted to: the kinds of the same port type (a dataset → tables and
 * views, a stream → topics, files → paths and stages, an endpoint → APIs) that are neither containers nor generic, and
 * `other` never. Kinds added later (an MQTT topic) join their role by their port type.
 */
export function convertTargets(kind: DataElementKind): DataElementKind[] {
  if (!isGenericElementKind(kind)) return [];
  const type = DATA_ELEMENT_KIND_DEFS[kind].portType;
  return DATA_ELEMENT_KINDS.filter(
    (k) => k !== 'other' && !isGenericElementKind(k) && !DATA_ELEMENT_KIND_DEFS[k].container && DATA_ELEMENT_KIND_DEFS[k].portType === type,
  );
}

// ---------- the technology list ----------

/** What a technology is used as: a part (element), a bridge (step runner) or both. */
export const DATA_TECHNOLOGY_ROLES = ['part', 'bridge', 'both'] as const;
export type DataTechnologyRole = (typeof DATA_TECHNOLOGY_ROLES)[number];

/** The icons the pictures draw a technology with (the web app maps them to its icon set). */
export const DATA_TECHNOLOGY_ICONS = ['database', 'table', 'topic', 'file', 'api', 'bridge', 'flow', 'edge', 'cloud', 'sensor', 'other'] as const;
export type DataTechnologyIcon = (typeof DATA_TECHNOLOGY_ICONS)[number];

export const DATA_TECHNOLOGY_LIMITS = {
  /** Entries administrators add (the built-in ones do not count) */
  custom: 200,
  key: 60,
  name: 100,
  /** An OpenLineage namespace pattern such as `kafka://{host}:{port}` */
  pattern: 300,
  /** Properties of a generic element (key: value) */
  properties: 50,
  propertyKey: 100,
  propertyValue: 500,
  /** An OpenLineage namespace as entered */
  namespace: 500,
  /** A technology as stored on an element or a runner (a key of the list, or a free value) */
  value: 100,
} as const;

/** Keys of technologies: lower case letters, digits, `.`, `_`, `-`. */
export const DATA_TECHNOLOGY_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/;

export interface DataTechnologyDef {
  key: string;
  /** The product's name (not translated) */
  name: string;
  role: DataTechnologyRole;
  icon: DataTechnologyIcon;
  /** How its OpenLineage namespace looks (`kafka://{host}:{port}`): a hint in the forms; null: none */
  olNamespacePattern: string | null;
}

export interface DataTechnology extends DataTechnologyDef {
  /** Shipped with Steward (not changeable); false: added by an administrator */
  builtIn: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The technologies Steward ships (ADR 0037 part 0): parts, bridges and both, with their icon and namespace pattern. */
export const BUILT_IN_DATA_TECHNOLOGIES: readonly DataTechnologyDef[] = [
  { key: 'snowflake', name: 'Snowflake', role: 'part', icon: 'database', olNamespacePattern: 'snowflake://{organization}-{account}' },
  { key: 'kafka', name: 'Apache Kafka', role: 'part', icon: 'topic', olNamespacePattern: 'kafka://{bootstrap host}:{port}' },
  { key: 'confluent', name: 'Confluent', role: 'both', icon: 'topic', olNamespacePattern: 'kafka://{bootstrap host}:{port}' },
  { key: 'amazon-s3', name: 'Amazon S3', role: 'part', icon: 'file', olNamespacePattern: 's3://{bucket}' },
  { key: 'postgresql', name: 'PostgreSQL', role: 'part', icon: 'database', olNamespacePattern: 'postgres://{host}:{port}' },
  { key: 'sql-server', name: 'SQL Server', role: 'part', icon: 'database', olNamespacePattern: 'mssql://{host}:{port}' },
  { key: 'mysql', name: 'MySQL / MariaDB', role: 'part', icon: 'database', olNamespacePattern: 'mysql://{host}:{port}' },
  { key: 'mongodb', name: 'MongoDB', role: 'part', icon: 'database', olNamespacePattern: 'mongodb://{host}:{port}' },
  { key: 'mqtt', name: 'MQTT', role: 'part', icon: 'topic', olNamespacePattern: 'mqtt://{host}:{port}' },
  { key: 'opc-ua', name: 'OPC UA', role: 'part', icon: 'sensor', olNamespacePattern: 'opc.tcp://{host}:{port}' },
  { key: 'rest-api', name: 'REST API', role: 'part', icon: 'api', olNamespacePattern: 'https://{host}' },
  { key: 'debezium', name: 'Debezium', role: 'bridge', icon: 'bridge', olNamespacePattern: null },
  { key: 'kafka-connect', name: 'Kafka Connect', role: 'bridge', icon: 'bridge', olNamespacePattern: null },
  { key: 'node-red', name: 'Node-RED', role: 'bridge', icon: 'flow', olNamespacePattern: null },
  { key: 'apache-camel', name: 'Apache Camel', role: 'bridge', icon: 'flow', olNamespacePattern: null },
  { key: 'industrial-edge', name: 'Industrial Edge', role: 'both', icon: 'edge', olNamespacePattern: 'mqtt://{device}:{port}' },
  { key: 'dbt', name: 'dbt', role: 'bridge', icon: 'flow', olNamespacePattern: null },
  { key: 'spark', name: 'Apache Spark', role: 'bridge', icon: 'flow', olNamespacePattern: null },
  { key: 'airflow', name: 'Apache Airflow', role: 'bridge', icon: 'flow', olNamespacePattern: null },
];

/** The built-in entries as list entries. */
export const builtInTechnologies = (): DataTechnology[] => BUILT_IN_DATA_TECHNOLOGIES.map((t) => ({ ...t, builtIn: true, updatedAt: null, updatedBy: null }));

/** A technology value as compared: trimmed, lower case. */
const norm = (v: string): string => v.trim().toLowerCase();

/**
 * The entry of the list a stored value names – by key, else by name (both without case); null: a free value, _not in
 * the list_ (or none).
 */
export function findTechnology<T extends DataTechnologyDef>(list: readonly T[], value: string | null | undefined): T | null {
  if (!value?.trim()) return null;
  const v = norm(value);
  return list.find((t) => t.key === v) ?? list.find((t) => norm(t.name) === v) ?? null;
}

/** Whether a technology may serve as a part (element) or a bridge (runner). */
export const technologyServes = (t: Pick<DataTechnologyDef, 'role'>, as: 'part' | 'bridge'): boolean => t.role === 'both' || t.role === as;

// ---------- a generic element's properties ----------

/** A property of a generic element: a key and a value, like a tag (a Node-RED flow id, a Camel route id, a retention). */
export interface DataElementProperty {
  key: string;
  value: string;
}

// ---------- inputs ----------

/** A technology an administrator adds or changes (PUT …/technologies/:key). */
export const dataTechnologyInput = z
  .object({
    name: z.string().trim().min(1).max(DATA_TECHNOLOGY_LIMITS.name),
    role: z.enum(DATA_TECHNOLOGY_ROLES),
    icon: z.enum(DATA_TECHNOLOGY_ICONS).default('other'),
    olNamespacePattern: z.string().trim().max(DATA_TECHNOLOGY_LIMITS.pattern).nullable().default(null),
  })
  .strict();
export type DataTechnologyInput = z.input<typeof dataTechnologyInput>;

export const dataTechnologyKey = z.string().trim().regex(DATA_TECHNOLOGY_KEY_RE, 'lower case letters, digits, “.”, “_” and “-”');

/** A technology on an element or a runner: a key of the list or a free value. */
export const dataTechnologyValue = () => z.string().trim().max(DATA_TECHNOLOGY_LIMITS.value);

/** The OpenLineage namespace of a generic element (`scheme://authority`, or a plain name): no spaces. */
export const dataNamespaceValue = () =>
  z.string().trim().min(1).max(DATA_TECHNOLOGY_LIMITS.namespace).regex(/^\S+$/, 'an OpenLineage namespace without spaces, such as mqtt://broker.example:1883');

export const dataElementPropertiesInput = () =>
  z
    .array(
      z
        .object({
          key: z.string().trim().min(1).max(DATA_TECHNOLOGY_LIMITS.propertyKey),
          value: z.string().trim().max(DATA_TECHNOLOGY_LIMITS.propertyValue),
        })
        .strict(),
    )
    .max(DATA_TECHNOLOGY_LIMITS.properties);

/** Convert to …: the specific kind, its platform (where the kind needs one) and – optionally – the qualified name there. */
export const dataElementConvertInput = z
  .object({
    kind: z.enum(DATA_ELEMENT_KINDS),
    platformId: z.string().trim().min(1).max(100).nullable().default(null),
    qualifiedName: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type DataElementConvertInput = z.input<typeof dataElementConvertInput>;
