import { qualifiedTable, type CheckOf, type DataContractChange, type MonitorStatus, type Platform } from '@sm/shared';
import { getSnapshot } from '../../dbschema/service.js';
import { logicalOfSql } from '../../datacontracts/draft.js';
import { diffContracts } from '../../datacontracts/diff.js';
import { isObj, str, type OdcsDoc } from '../../datacontracts/odcs.js';
import { currentDoc, visibleContract } from '../../datacontracts/service.js';
import type { SnowflakeClient } from '../../snowflake/client.js';
import type { BindingWithElements, ElementRow } from '../store.js';
import { snowflakeIdent, snowflakeParts, worse, type CheckResult } from './freshness.js';

/**
 * Schema conformance of an element (ADR 0036 part 10): what the platform says the element's columns or fields are,
 * against the schema object of the ODCS contract its output port is bound to. Snowflake: `INFORMATION_SCHEMA.COLUMNS`
 * (metadata); Kafka: the subject `<topic>-value` of the Schema Registry (Avro record fields or JSON Schema properties;
 * Protobuf is not compared); SQL databases: the latest schema snapshot – no new read.
 *
 * The comparison is the contract comparison of the data contracts module (diff.ts), on logical types and required
 * fields only (physical types differ by platform): a field of the contract that is missing, or of another type family,
 * fails (`failAs`); required ↔ nullable and columns the contract does not name are warnings (`warningAs`).
 *
 * The same readers draft a contract from an element (datacontracts/draft.ts, source `element`).
 */

type Obj = Record<string, unknown>;
type Check = CheckOf<'data-element'>;

/** What the platform says an element looks like: an ODCS schema object (with physical types), or why it cannot say. */
export type ActualSchema = { object: Obj; source: string; server: Obj | null } | { unknown: string };

const MAX_FIELDS = 2_000;

// ---------- Snowflake ----------

/** The logical type of a Snowflake column (`DATA_TYPE` of INFORMATION_SCHEMA.COLUMNS, with its scale). */
export function logicalOfSnowflake(dataType: string, scale: string | number | null | undefined): string {
  const t = dataType.trim().toUpperCase().split('(')[0]!.trim();
  if (['NUMBER', 'DECIMAL', 'NUMERIC', 'FIXED', 'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'BYTEINT'].includes(t))
    return Number(scale ?? 0) > 0 ? 'number' : 'integer';
  if (['FLOAT', 'FLOAT4', 'FLOAT8', 'DOUBLE', 'DOUBLE PRECISION', 'REAL', 'DECFLOAT'].includes(t)) return 'number';
  if (t === 'BOOLEAN') return 'boolean';
  if (t === 'DATE' || t.startsWith('TIMESTAMP') || t === 'DATETIME') return 'date';
  if (t === 'VARIANT' || t === 'OBJECT') return 'object';
  if (t === 'ARRAY') return 'array';
  return 'string';
}

function physicalOfSnowflake(c: Record<string, string | null>): string {
  const t = String(c.DATA_TYPE ?? '').toUpperCase();
  if (t === 'NUMBER' && c.NUMERIC_PRECISION) return `NUMBER(${c.NUMERIC_PRECISION},${c.NUMERIC_SCALE ?? 0})`;
  if ((t === 'TEXT' || t === 'VARCHAR') && c.CHARACTER_MAXIMUM_LENGTH) return `VARCHAR(${c.CHARACTER_MAXIMUM_LENGTH})`;
  return t;
}

async function snowflakeSchema(el: ElementRow, sf: SnowflakeClient, account: string): Promise<ActualSchema> {
  const parts = snowflakeParts(el.qualified_name);
  if (!parts || parts.length !== 3) return { unknown: `"${el.qualified_name}" is not DATABASE.SCHEMA.TABLE` };
  const [d, s, t] = parts as [string, string, string];
  const rows = await sf.query(
    `/* steward:dp-columns */ SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, NUMERIC_PRECISION, NUMERIC_SCALE, CHARACTER_MAXIMUM_LENGTH, COMMENT
     FROM IDENTIFIER(?) WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT ${MAX_FIELDS}`,
    [`${snowflakeIdent(d)}.INFORMATION_SCHEMA.COLUMNS`, s, t],
  );
  if (!rows.length) return { unknown: `Snowflake: no columns of ${parts.join('.')} (no such table, or no access to its metadata)` };
  return {
    source: 'Snowflake INFORMATION_SCHEMA.COLUMNS',
    server: { server: 'snowflake', type: 'snowflake', account, database: d, schema: s },
    object: {
      name: t.toLowerCase(),
      physicalName: parts.join('.'),
      physicalType: el.kind === 'snowflake.view' ? 'view' : 'table',
      properties: rows.map((c) => ({
        name: String(c.COLUMN_NAME ?? ''),
        logicalType: logicalOfSnowflake(String(c.DATA_TYPE ?? ''), c.NUMERIC_SCALE),
        physicalType: physicalOfSnowflake(c),
        ...(c.IS_NULLABLE === 'NO' ? { required: true } : {}),
        ...(c.COMMENT ? { description: String(c.COMMENT).slice(0, 2000) } : {}),
      })),
    },
  };
}

// ---------- Kafka (Schema Registry) ----------

const AVRO: Record<string, string> = {
  string: 'string',
  int: 'integer',
  long: 'integer',
  float: 'number',
  double: 'number',
  boolean: 'boolean',
  bytes: 'string',
  fixed: 'string',
  enum: 'string',
  record: 'object',
  map: 'object',
  array: 'array',
};

/** An ODCS property from an Avro field type (a union with null: optional). */
function avroProperty(name: string, type: unknown, budget: { n: number }, depth: number): Obj {
  budget.n++;
  let t = type;
  let required = true;
  if (Array.isArray(t)) {
    const nonNull = t.filter((x) => x !== 'null');
    required = nonNull.length === t.length;
    t = nonNull.length === 1 ? nonNull[0] : nonNull[0];
  }
  const o = isObj(t) ? t : { type: t };
  const base = str(o.type) ?? 'string';
  const logical = str(o.logicalType);
  const lt =
    logical === 'date' || (logical ?? '').startsWith('timestamp') || (logical ?? '').startsWith('local-timestamp')
      ? 'date'
      : logical === 'decimal'
        ? 'number'
        : (AVRO[base] ?? (isObj(t) ? 'object' : 'string'));
  const p: Obj = { name, logicalType: lt, physicalType: logical ? `${base} (${logical})` : base };
  if (required) p.required = true;
  if (str(o.doc)) p.description = str(o.doc)!.slice(0, 2000);
  if (depth < 6 && budget.n < MAX_FIELDS) {
    if (base === 'record' && Array.isArray(o.fields))
      p.properties = o.fields.filter(isObj).map((f) => avroProperty(String(f.name ?? ''), f.type, budget, depth + 1));
    if (base === 'array') p.items = avroProperty('item', o.items, budget, depth + 1);
  }
  return p;
}

const JSON_TYPES: Record<string, string> = { string: 'string', integer: 'integer', number: 'number', boolean: 'boolean', object: 'object', array: 'array' };

/** An ODCS property from a JSON Schema (no $ref resolution: a subject's schema is self-contained or left as object). */
function jsonProperty(name: string, s: unknown, required: boolean, budget: { n: number }, depth: number): Obj {
  budget.n++;
  const o = isObj(s) ? s : {};
  const type = Array.isArray(o.type) ? str(o.type.find((x) => x !== 'null')) : str(o.type);
  const nullable = Array.isArray(o.type) && o.type.includes('null');
  let lt = type ? JSON_TYPES[type] : isObj(o.properties) ? 'object' : undefined;
  if (lt === 'string' && (o.format === 'date' || o.format === 'date-time')) lt = 'date';
  const p: Obj = { name, ...(lt ? { logicalType: lt } : {}), ...(type ? { physicalType: type } : {}) };
  if (required && !nullable) p.required = true;
  if (depth < 6 && budget.n < MAX_FIELDS) {
    if (isObj(o.properties)) {
      const req = new Set(Array.isArray(o.required) ? o.required.map(String) : []);
      p.properties = Object.entries(o.properties)
        .filter(([k]) => k !== '__proto__')
        .map(([k, v]) => jsonProperty(k, v, req.has(k), budget, depth + 1));
    }
    if (lt === 'array' && o.items) p.items = jsonProperty('item', o.items, false, budget, depth + 1);
  }
  return p;
}

async function kafkaSchema(el: ElementRow, platform: Platform, secrets: Record<string, string>, version?: number): Promise<ActualSchema> {
  if (platform.kind !== 'kafka') return { unknown: `"${platform.name}" is not a Kafka platform with a Schema Registry` };
  if (!platform.baseUrl) return { unknown: `"${platform.name}" has no Schema Registry (its base URL)` };
  const { registryGet } = await import('../../kafka/service.js');
  const subject = `${el.qualified_name}-value`;
  const v = (await registryGet(platform, secrets, `/subjects/${encodeURIComponent(subject)}/versions/${version ?? 'latest'}`)) as {
    version?: number;
    schemaType?: string;
    schema?: string;
  } | null;
  if (!v?.schema) return { unknown: `Kafka: no schema ${subject}${version ? ` version ${version}` : ''} in the Schema Registry` };
  const type = String(v.schemaType ?? 'AVRO').toUpperCase();
  if (type === 'PROTOBUF') return { unknown: `Kafka: ${subject} is a Protobuf schema – Steward does not compare it (not compared)` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(v.schema);
  } catch {
    return { unknown: `Kafka: the schema ${subject} version ${v.version ?? '?'} could not be read` };
  }
  const budget = { n: 0 };
  const root = type === 'JSON' ? jsonProperty(el.qualified_name, parsed, false, budget, 0) : avroProperty(el.qualified_name, parsed, budget, 0);
  return {
    source: `Schema Registry ${subject} version ${v.version ?? '?'} (${type === 'JSON' ? 'JSON Schema' : 'Avro'})`,
    server: {
      server: 'kafka',
      type: 'kafka',
      host: String(platform.config.variables?.bootstrap ?? '')
        .split(',')[0]!
        .trim(),
      format: type === 'JSON' ? 'json' : 'avro',
    },
    object: { name: el.qualified_name, physicalName: el.qualified_name, physicalType: 'topic', properties: (root.properties as Obj[] | undefined) ?? [] },
  };
}

// ---------- SQL databases (the latest snapshot) ----------

function sqlSchema(el: ElementRow): ActualSchema {
  let snap;
  try {
    snap = getSnapshot('platform', el.platform_id, 'latest');
  } catch {
    return { unknown: 'The database has no schema snapshot yet – read its schema first' };
  }
  const t = snap.schema.tables.find((x) => qualifiedTable(x).toLowerCase() === el.name_norm || x.name.toLowerCase() === el.name_norm);
  if (!t) return { unknown: `${el.qualified_name} is not in the latest schema snapshot (${snap.takenAt.slice(0, 10)})` };
  return {
    source: `the schema snapshot of ${snap.takenAt.slice(0, 10)}`,
    server: null,
    object: {
      name: t.name,
      physicalName: qualifiedTable(t),
      physicalType: t.type === 'BASE TABLE' ? 'table' : t.type.toLowerCase(),
      properties: t.columns.map((c) => ({
        name: c.name,
        logicalType: logicalOfSql(c.type),
        physicalType: c.type,
        ...(c.nullable ? {} : { required: true }),
      })),
    },
  };
}

/** What the element looks like on its platform (the caller resolved the platform with the right person's rights). */
export async function readActualSchema(
  el: ElementRow,
  platform: Platform,
  secrets: Record<string, string>,
  opts: { schemaVersion?: number; snowflake?: () => SnowflakeClient } = {},
): Promise<ActualSchema> {
  if (el.kind.startsWith('snowflake.')) {
    if (!['snowflake.table', 'snowflake.view', 'snowflake.dynamicTable'].includes(el.kind)) return { unknown: `The columns of a ${el.kind} are not read` };
    const { SnowflakeClient } = await import('../../snowflake/client.js');
    return snowflakeSchema(el, opts.snowflake?.() ?? new SnowflakeClient(platform, secrets), String(platform.config.variables?.account ?? ''));
  }
  if (el.kind === 'kafka.topic') return kafkaSchema(el, platform, secrets, opts.schemaVersion);
  if (el.kind === 'sql.table' || el.kind === 'sql.view') return sqlSchema(el);
  return { unknown: `The schema of a ${el.kind} is not read` };
}

// ---------- the comparison ----------

/** The schema object of a contract that describes the element: by physical name, else by name, else the only one. */
export function contractObjectFor(doc: OdcsDoc, el: ElementRow, actual: Obj): Obj | null {
  const objects = (Array.isArray(doc.schema) ? doc.schema : []).filter(isObj);
  const lc = (v: unknown) => (str(v) ?? '').toLowerCase();
  const physical = lc(actual.physicalName);
  const short = lc(actual.name);
  return (
    objects.find((o) => lc(o.physicalName) === physical || lc(o.physicalName) === el.name_norm) ??
    objects.find((o) => lc(o.name) === short || lc(o.physicalName).split('.').pop() === short) ??
    (objects.length === 1 ? objects[0]! : null)
  );
}

/** Only what the check compares: names (case ignored), logical types, required – all levels. */
function comparable(o: Obj, depth = 0): Obj {
  const out: Obj = { name: (str(o.name) ?? '').toLowerCase() };
  if (str(o.logicalType)) out.logicalType = str(o.logicalType);
  if (o.required === true) out.required = true;
  if (depth < 6 && Array.isArray(o.properties)) out.properties = o.properties.filter(isObj).map((p) => comparable(p, depth + 1));
  if (depth < 6 && isObj(o.items)) out.items = comparable(o.items, depth + 1);
  return out;
}

/** Errors (missing fields, other types) and warnings (required ↔ nullable, extra fields) of the element against the contract object. */
export function conformance(contractObject: Obj, actual: Obj): { errors: DataContractChange[]; warnings: DataContractChange[]; total: number } {
  const a = comparable(contractObject);
  const b = { ...comparable(actual), name: a.name };
  const diff = diffContracts({ schema: [a] }, { schema: [b] });
  const errors: DataContractChange[] = [];
  const warnings: DataContractChange[] = [];
  for (const c of diff.changes) {
    // the data, not a new contract version: nullability and extra columns are warnings either way (ADR 0036 part 10)
    const warning = c.kind === 'required-added' || c.kind === 'required-removed' || c.kind === 'field-added' || !c.breaking;
    (warning ? warnings : errors).push(c);
  }
  return { errors, warnings, total: diff.total };
}

const changeText = (c: DataContractChange): string => {
  const f = c.field ?? c.schema ?? '';
  switch (c.kind) {
    case 'field-removed':
      return `${f} missing`;
    case 'field-added':
      return `${f} not in the contract`;
    case 'type-changed':
    case 'type-narrowed':
    case 'type-widened':
      return `${f} is ${c.after ?? '?'} (contract: ${c.before ?? '?'})`;
    case 'required-added':
      return `${f} is required (contract: optional)`;
    case 'required-removed':
      return `${f} is nullable (contract: required)`;
    default:
      return `${f} ${c.kind}`;
  }
};

/** The contracts an element is held to: its output bindings in its environment that name one (at most 5). */
export function boundContracts(el: ElementRow, bindings: BindingWithElements[]): { contractId: string; version: number | null }[] {
  const seen = new Set<string>();
  const out: { contractId: string; version: number | null }[] = [];
  for (const b of bindings) {
    if (!b.contract_id || b.environment !== el.environment || !b.elementIds.includes(el.id)) continue;
    const k = `${b.contract_id}|${b.contract_version ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ contractId: b.contract_id, version: b.contract_version });
  }
  return out.slice(0, 5);
}

/**
 * The schema mode of the check: the actual schema against each bound contract (run as the monitor owner – a contract
 * the owner may not see does not count, and says so).
 */
export function judgeSchema(c: Check, el: ElementRow, actual: ActualSchema, contracts: { contractId: string; version: number | null }[]): CheckResult {
  if ('unknown' in actual) return { status: 'unknown', message: actual.unknown };
  if (!contracts.length)
    return { status: 'unknown', message: `${el.qualified_name} is bound to no output port with a data contract in ${el.environment || 'its environment'}` };
  let status: MonitorStatus = 'up';
  const parts: string[] = [];
  const value: { contracts: { id: string; version: number; errors: number; warnings: number }[] } = { contracts: [] };
  for (const k of contracts) {
    let row;
    try {
      row = visibleContract(k.contractId).row;
    } catch {
      status = worse(status, 'unknown');
      parts.push('a bound contract the monitor owner may not see');
      continue;
    }
    let doc;
    try {
      doc = currentDoc(k.version ? { id: row.id, current_version: k.version } : row);
    } catch {
      status = worse(status, 'unknown');
      parts.push(`"${row.name}" has no version ${k.version}`);
      continue;
    }
    const object = contractObjectFor(doc.doc, el, actual.object);
    if (!object) {
      status = worse(status, 'unknown');
      parts.push(`"${row.name}" v${doc.version} describes no ${el.qualified_name}`);
      continue;
    }
    const r = conformance(object, actual.object);
    value.contracts.push({ id: row.id, version: doc.version, errors: r.errors.length, warnings: r.warnings.length });
    if (r.errors.length) status = worse(status, c.failAs);
    else if (r.warnings.length) status = worse(status, c.warningAs);
    const list = [...r.errors, ...r.warnings];
    parts.push(
      list.length
        ? `"${row.name}" v${doc.version}: ${list.slice(0, 6).map(changeText).join(', ')}${r.total > 6 ? ` and ${r.total - 6} more` : ''}`
        : `"${row.name}" v${doc.version}: matches`,
    );
  }
  return { status, message: `Schema of ${el.qualified_name} (${actual.source}) – ${parts.join('; ')}`.slice(0, 1000), value };
}
