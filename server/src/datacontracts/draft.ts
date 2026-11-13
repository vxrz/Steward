import {
  DATA_CONTRACT_LIMITS,
  ODCS_DRAFT_API_VERSION,
  dataContractDraftInput,
  qualifiedTable,
  type DataContractDraft,
  type DataContractLinkInput,
  type DbSchemaDialect,
  type DbSchemaTable,
} from '@sm/shared';
import { me } from '../auth/access.js';
import { getDataset } from '../dashboards/datasets.js';
import { getPlatform, getSpecContent, specPlatformId } from '../platforms/service.js';
import { listRecordings } from '../platforms/recordings.js';
import { resolveRef } from '../platforms/openapi.js';
import { getSnapshot, subjectOf } from '../dbschema/service.js';
import { parseYaml, SPEC_YAML } from '../yaml-safe.js';
import { HttpError, slugify } from '../util.js';
import { isObj, lintContract, str, toYaml, type OdcsDoc } from './odcs.js';

/**
 * Drafts of a contract from what Steward already has (#221): the response schema of an OpenAPI operation, a recorded
 * platform response (#105), the columns (and sample rows) of a dataset, the tables of a database schema snapshot (#222).
 * A draft is YAML for the editor – nothing is saved – with the links it suggests. Only what the caller may see is read:
 * the platform's specification and recordings need its "use" right, a dataset its rows, a schema its platform or
 * system. Types are guessed conservatively; the draft says what to review in its warnings.
 */

type Obj = Record<string, unknown>;
type Property = Obj;

const L = DATA_CONTRACT_LIMITS;
const MAX_DEPTH = 6;
const MAX_PROPS = 500;

/** A contract skeleton (ODCS v3.0.2, status draft). */
function skeleton(name: string, purpose: string): OdcsDoc {
  return {
    apiVersion: ODCS_DRAFT_API_VERSION,
    kind: 'DataContract',
    id: slugify(name),
    name,
    version: '0.1.0',
    status: 'draft',
    description: { purpose },
  };
}

function finish(doc: OdcsDoc, links: DataContractLinkInput[], warnings: string[]): DataContractDraft {
  // a draft must pass the JSON Schema of ODCS: a problem here is Steward's own mistake
  const lint = lintContract(doc);
  if (lint.length) warnings.push(...lint.slice(0, 5).map((f) => `${f.path}: ${f.message}`));
  return { yaml: toYaml(doc), links, warnings };
}

// ---------- from JSON Schema (OpenAPI) ----------

const LOGICAL: Record<string, string> = { string: 'string', integer: 'integer', number: 'number', boolean: 'boolean', object: 'object', array: 'array' };

/** An ODCS property from a JSON Schema (OpenAPI 3 or Swagger 2), $refs resolved, recursion and size limited. */
function propertyFromSchema(doc: Obj, name: string, raw: unknown, required: boolean, budget: { n: number }, depth: number, seen: Set<string>): Property {
  const ref = isObj(raw) ? str(raw.$ref) : null;
  const s = (resolveRef(doc, raw) as Obj | undefined) ?? {};
  const p: Property = { name };
  budget.n++;
  const anyOf = (Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.allOf) && s.allOf.length === 1 ? s.allOf : null) as
    unknown[] | null;
  const effective = anyOf?.length
    ? ((resolveRef(doc, anyOf.find((x) => (resolveRef(doc, x) as Obj | undefined)?.type !== 'null') ?? anyOf[0]) as Obj | undefined) ?? s)
    : s;
  const type = Array.isArray(effective.type) ? str(effective.type.find((x) => x !== 'null')) : str(effective.type);
  const format = str(effective.format);
  let logical = type ? LOGICAL[type] : effective.properties ? 'object' : undefined;
  if (logical === 'string' && (format === 'date' || format === 'date-time')) logical = 'date';
  if (logical) p.logicalType = logical;
  if (str(effective.description)) p.description = str(effective.description)!.slice(0, 2000);
  if (required) p.required = true;
  const options: Obj = {};
  if (logical === 'string') {
    for (const k of ['minLength', 'maxLength'] as const) if (typeof effective[k] === 'number') options[k] = effective[k];
    // a pattern is copied as data: Steward never runs it
    if (str(effective.pattern)) options.pattern = str(effective.pattern);
    if (format && format !== 'date' && format !== 'date-time') options.format = format;
  }
  if (logical === 'integer' || logical === 'number')
    for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) if (typeof effective[k] === 'number') options[k] = effective[k];
  if (Object.keys(options).length) p.logicalTypeOptions = options;
  if (Array.isArray(effective.examples) && effective.examples.length) p.examples = effective.examples.slice(0, 3);
  else if (effective.example !== undefined && (typeof effective.example !== 'object' || effective.example === null)) p.examples = [effective.example];
  if (depth >= MAX_DEPTH || budget.n >= MAX_PROPS || (ref && seen.has(ref))) return p;
  const next = ref ? new Set(seen).add(ref) : seen;
  if (logical === 'object' && isObj(effective.properties)) {
    const req = new Set(Array.isArray(effective.required) ? effective.required.map(String) : []);
    p.properties = Object.entries(effective.properties)
      .filter(([k]) => k !== '__proto__')
      .slice(0, MAX_PROPS)
      .map(([k, v]) => propertyFromSchema(doc, k, v, req.has(k), budget, depth + 1, next));
  }
  if (logical === 'array' && effective.items) p.items = propertyFromSchema(doc, 'item', effective.items, false, budget, depth + 1, next);
  return p;
}

function fromOpenApi(input: { platformId: string; specId: string; method: string; path: string }): DataContractDraft {
  const p = getPlatform(input.platformId);
  if (!p.permissions.includes('use') || specPlatformId(input.specId) !== p.id)
    throw new HttpError(400, `Specification ${input.specId} not found`, 'DATA_CONTRACT_DRAFT_SOURCE', { id: input.specId });
  const text = getSpecContent(input.specId);
  const doc = (text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text, SPEC_YAML)) as Obj;
  const paths = isObj(doc.paths) ? doc.paths : {};
  const item = Object.entries(paths).find(([k]) => k === input.path)?.[1];
  const op = isObj(item) ? item[input.method.toLowerCase()] : undefined;
  if (!isObj(op))
    throw new HttpError(400, `${input.method} ${input.path} is not an operation of the specification`, 'DATA_CONTRACT_DRAFT_SOURCE', {
      id: `${input.method} ${input.path}`,
    });
  const responses = isObj(op.responses) ? op.responses : {};
  const code =
    ['200', '201', '202', '203', '206'].find((c) => responses[c] !== undefined) ?? Object.keys(responses).find((c) => c.startsWith('2')) ?? 'default';
  const response = resolveRef(doc, responses[code]) as Obj | undefined;
  const content = isObj(response?.content) ? response.content : null;
  const media = content ? (Object.entries(content).find(([k]) => k.includes('json'))?.[1] ?? Object.values(content)[0]) : null;
  const schema = isObj(media) ? media.schema : response?.schema;
  if (!schema) throw new HttpError(400, `${input.method} ${input.path} documents no response schema`, 'DATA_CONTRACT_DRAFT_EMPTY');
  const warnings: string[] = [];
  const operationId = str(op.operationId);
  const name =
    operationId ??
    input.path
      .split('/')
      .filter((x) => x && !x.startsWith('{'))
      .pop() ??
    'response';
  let root = resolveRef(doc, schema) as Obj;
  if (root?.type === 'array' && root.items) {
    root = (resolveRef(doc, root.items) as Obj) ?? {};
    warnings.push('The response is a list: the contract describes one item of it');
  }
  const budget = { n: 0 };
  const object = propertyFromSchema(doc, name, root, false, budget, 0, new Set());
  if (budget.n >= MAX_PROPS) warnings.push(`Only the first ${MAX_PROPS} properties are drafted`);
  const out = skeleton(
    `${p.name} ${name}`.trim(),
    `The response of ${input.method.toUpperCase()} ${input.path} of ${p.name} (drafted from its OpenAPI description)`,
  );
  out.schema = [
    {
      name,
      logicalType: 'object',
      ...(str(op.summary) ? { description: str(op.summary)! } : {}),
      properties: (object.properties as Property[] | undefined) ?? [],
    },
  ];
  if (!(object.properties as unknown[] | undefined)?.length) warnings.push('The response schema has no properties to draft');
  warnings.push('API servers are not drafted: Steward tests database servers – add the server for the CLI if you test the API elsewhere');
  return finish(out, [{ kind: 'spec', targetId: input.specId, detail: `${input.method.toUpperCase()} ${input.path}`, schema: name }], warnings);
}

// ---------- from values (recorded responses, dataset rows) ----------

type Seen = { types: Set<string>; nulls: number; count: number; children?: Map<string, Seen>; items?: Seen };

function observe(seen: Seen, v: unknown, depth: number): void {
  seen.count++;
  if (v === null || v === undefined) {
    seen.nulls++;
    return;
  }
  if (Array.isArray(v)) {
    seen.types.add('array');
    if (depth < MAX_DEPTH) {
      seen.items ??= { types: new Set(), nulls: 0, count: 0 };
      for (const x of v.slice(0, 20)) observe(seen.items, x, depth + 1);
    }
    return;
  }
  if (typeof v === 'object') {
    seen.types.add('object');
    if (depth < MAX_DEPTH) {
      seen.children ??= new Map();
      for (const [k, x] of Object.entries(v as Obj).slice(0, MAX_PROPS)) {
        if (k === '__proto__') continue;
        let c = seen.children.get(k);
        if (!c) {
          if (seen.children.size >= MAX_PROPS) continue;
          c = { types: new Set(), nulls: 0, count: 0 };
          seen.children.set(k, c);
        }
        observe(c, x, depth + 1);
      }
    }
    return;
  }
  if (typeof v === 'number') seen.types.add(Number.isInteger(v) ? 'integer' : 'number');
  else if (typeof v === 'boolean') seen.types.add('boolean');
  else if (typeof v === 'string') seen.types.add(isDateText(v) ? 'date' : 'string');
  else seen.types.add('string');
}

/** 2026-11-06 or 2026-11-06T10:00:00Z – checked with string functions, not a pattern. */
function isDateText(s: string): boolean {
  if (s.length < 10 || s.length > 35 || s[4] !== '-' || s[7] !== '-') return false;
  if (s.length > 10 && s[10] !== 'T' && s[10] !== ' ') return false;
  return !Number.isNaN(Date.parse(s));
}

function logicalOf(types: Set<string>): string | undefined {
  const t = [...types];
  if (!t.length) return undefined;
  if (t.length === 1) return t[0];
  if (t.every((x) => x === 'integer' || x === 'number')) return 'number';
  if (t.every((x) => x === 'date' || x === 'string')) return 'string';
  return undefined;
}

/** Properties from what was seen; `rows` were seen per row: a field present and non-null in every row is required. */
function propertiesOf(children: Map<string, Seen>, rows: number | null): Property[] {
  return [...children.entries()].map(([name, c]) => {
    const p: Property = { name };
    const logical = logicalOf(c.types);
    if (logical) p.logicalType = logical;
    if (rows !== null && c.count === rows && c.nulls === 0) p.required = true;
    if (logical === 'object' && c.children) p.properties = propertiesOf(c.children, c.count - c.nulls);
    if (logical === 'array' && c.items) {
      const item: Property = { name: 'item' };
      const it = logicalOf(c.items.types);
      if (it) item.logicalType = it;
      if (it === 'object' && c.items.children) item.properties = propertiesOf(c.items.children, null);
      p.items = item;
    }
    return p;
  });
}

function fromValues(name: string, purpose: string, value: unknown, warnings: string[]): OdcsDoc {
  const rows = Array.isArray(value)
    ? value
    : isObj(value) && Array.isArray(Object.values(value).find(Array.isArray)) && Object.keys(value).length <= 3
      ? (Object.values(value).find(Array.isArray) as unknown[])
      : [value];
  if (rows !== value && !Array.isArray(value)) warnings.push('The response wraps a list: the contract describes one item of it');
  const sample = rows.slice(0, L.draftSampleRows);
  if (rows.length > sample.length) warnings.push(`Types were guessed from the first ${sample.length} of ${rows.length} rows`);
  const seen: Seen = { types: new Set(), nulls: 0, count: 0, children: new Map() };
  for (const r of sample) if (isObj(r)) observe(seen, r, 0);
  const doc = skeleton(name, purpose);
  doc.schema = [
    {
      name: slugify(name).split('-').join('_') || 'data',
      logicalType: 'object',
      properties: propertiesOf(seen.children ?? new Map(), sample.filter(isObj).length),
    },
  ];
  if (!seen.children?.size) warnings.push('No fields were found to draft');
  warnings.push('Required fields and types were guessed from sample values – review them');
  return doc;
}

function fromRecording(input: { platformId: string; recordingId: string }): DataContractDraft {
  const r = listRecordings(input.platformId).find((x) => x.id === input.recordingId);
  if (!r) throw new HttpError(400, `Recorded response ${input.recordingId} not found`, 'DATA_CONTRACT_DRAFT_SOURCE', { id: input.recordingId });
  const p = getPlatform(input.platformId);
  const warnings: string[] = [];
  const last =
    r.path
      .split('/')
      .filter((x) => x && !x.startsWith('{'))
      .pop() ?? 'response';
  const doc = fromValues(`${p.name} ${last}`, `The response of ${r.method} ${r.path} of ${p.name} (drafted from a recorded response)`, r.body, warnings);
  return finish(doc, [], warnings);
}

function fromDataset(input: { dataset: string }): DataContractDraft {
  const d = getDataset(input.dataset);
  const warnings: string[] = [];
  // the dataset's own column list decides what is in it; values only guess the types (built as entries: column names
  // come from a process – never assigned as properties)
  const names = d.columns.filter((c) => c !== '_source' && c !== '__proto__' && c !== 'constructor' && c !== 'prototype');
  const rows = d.rows.map((r) => Object.fromEntries(names.map((c) => [c, Object.hasOwn(r, c) ? (r as Record<string, unknown>)[c] : null])));
  const doc = fromValues(
    d.title || d.key,
    `The dataset ${d.key} of process ${d.processName} (drafted from its columns and rows)`,
    rows.length ? rows : [Object.fromEntries(d.columns.map((c) => [c, null]))],
    warnings,
  );
  const schema = (doc.schema as Obj[])[0]!;
  return finish(doc, [{ kind: 'dataset', targetId: d.key, schema: String(schema.name) }], warnings);
}

// ---------- from a database schema snapshot ----------

/** The logical type of a column's data type (all three DBMS and tbls' names). */
export function logicalOfSql(type: string): string {
  const t = type.toLowerCase();
  const base = t.split('(')[0]!.trim();
  if (['smallint', 'integer', 'int', 'bigint', 'int2', 'int4', 'int8', 'tinyint', 'mediumint', 'serial', 'bigserial', 'smallserial'].includes(base))
    return 'integer';
  if (['numeric', 'decimal', 'real', 'double precision', 'double', 'float', 'float4', 'float8', 'money', 'smallmoney', 'number'].includes(base))
    return 'number';
  if (['boolean', 'bool', 'bit'].includes(base)) return 'boolean';
  if (base === 'date' || base.startsWith('timestamp') || base.startsWith('datetime') || base === 'smalldatetime' || base === 'datetimeoffset') return 'date';
  if (base === 'json' || base === 'jsonb') return 'object';
  if (base.endsWith('[]') || base === 'array') return 'array';
  return 'string';
}

const SERVER_TYPE: Record<DbSchemaDialect, string | null> = { postgresql: 'postgresql', mysql: 'mysql', sqlserver: 'sqlserver', sqlite: null, other: null };

function tableObject(t: DbSchemaTable): Obj {
  const pk = t.primaryKey?.columns ?? [];
  const unique = new Set(t.indexes.filter((i) => i.unique && !i.primary && i.columns.length === 1).map((i) => i.columns[0]!));
  return {
    name: t.name,
    physicalName: qualifiedTable(t),
    physicalType: t.type === 'BASE TABLE' ? 'table' : t.type.toLowerCase(),
    ...(t.comment ? { description: t.comment.slice(0, 2000) } : {}),
    properties: t.columns.map((c) => {
      const p: Property = { name: c.name, logicalType: logicalOfSql(c.type), physicalType: c.type };
      if (c.comment) p.description = c.comment.slice(0, 2000);
      if (!c.nullable) p.required = true;
      const at = pk.indexOf(c.name);
      if (at >= 0) {
        p.primaryKey = true;
        p.primaryKeyPosition = at + 1;
      }
      if (unique.has(c.name)) p.unique = true;
      return p;
    }),
  };
}

function fromTables(input: { subjectKind: 'platform' | 'system'; subjectId: string; tables: string[] }): DataContractDraft {
  const subject = subjectOf(input.subjectKind, input.subjectId);
  let snap;
  try {
    snap = getSnapshot(input.subjectKind, input.subjectId, 'latest');
  } catch {
    throw new HttpError(400, `"${subject.name}" has no schema snapshot yet – read or import its schema first`, 'DATA_CONTRACT_DRAFT_NO_SNAPSHOT', {
      name: subject.name,
    });
  }
  const wanted = input.tables.map((x) => x.toLowerCase());
  const tables = snap.schema.tables.filter((t) => wanted.includes(qualifiedTable(t).toLowerCase()));
  if (!tables.length) throw new HttpError(400, 'None of the tables is in the latest schema snapshot', 'DATA_CONTRACT_DRAFT_SOURCE', { id: input.tables[0]! });
  const warnings: string[] = [];
  const missing = input.tables.filter((x) => !tables.some((t) => qualifiedTable(t).toLowerCase() === x.toLowerCase()));
  if (missing.length) warnings.push(`Not in the latest snapshot: ${missing.join(', ')}`);
  const name = tables.length === 1 ? `${subject.name} ${tables[0]!.name}` : subject.name;
  const doc = skeleton(name, `Tables of ${subject.name} (drafted from the schema snapshot of ${snap.takenAt.slice(0, 10)})`);
  const links: DataContractLinkInput[] = tables.map((t) => ({
    kind: 'table',
    targetKind: input.subjectKind,
    targetId: input.subjectId,
    detail: qualifiedTable(t),
    schema: t.name,
  }));
  const type = SERVER_TYPE[snap.dialect];
  if (input.subjectKind === 'platform' && subject.platform && type) {
    const s = subject.platform.config.database as { host?: string; port?: number; database?: string } | undefined;
    const server = slugify(subject.platform.environment || 'production');
    const schemaName = tables[0]!.schema;
    doc.servers = [
      {
        server,
        type,
        ...(s?.host ? { host: s.host } : {}),
        ...(s?.port ? { port: s.port } : {}),
        database: s?.database ?? snap.database ?? '',
        ...(schemaName && type !== 'mysql' ? { schema: schemaName } : {}),
      },
    ];
    // the server is answered by the platform it was read from – only for who may use it (its credentials go to the service)
    if (subject.canRead) links.push({ kind: 'server', targetId: subject.id, detail: server });
    else warnings.push('Link the server to a database platform you may use before testing');
  } else warnings.push('No server was drafted: link the contract to a database platform to test it');
  doc.schema = tables.map(tableObject);
  if (snap.truncated) warnings.push('The snapshot was truncated: some tables or columns may be missing');
  return finish(doc, links, warnings);
}

// ---------- from an element of the data products catalogue (ADR 0036 part 7) ----------

/**
 * A Snowflake table's columns (INFORMATION_SCHEMA.COLUMNS, read now), a Kafka topic's schema (the Schema Registry's
 * latest `<topic>-value`), or a database table (its latest schema snapshot, as the table source). The caller must see
 * the element and may use its platform; metadata only.
 */
async function fromElement(input: { elementId: string }): Promise<DataContractDraft> {
  const { moduleEnabled } = await import('../modules/registry.js');
  const { elementFor } = await import('../dataproducts/checks/element.js');
  const el = moduleEnabled('dataProducts') ? elementFor(me(), input.elementId) : null;
  if (!el?.platform_id) throw new HttpError(400, `Data element ${input.elementId} not found`, 'DATA_CONTRACT_DRAFT_SOURCE', { id: input.elementId });
  let p;
  try {
    p = getPlatform(el.platform_id);
  } catch {
    p = null;
  }
  if (!p?.permissions.includes('use'))
    throw new HttpError(400, `Data element ${input.elementId} not found`, 'DATA_CONTRACT_DRAFT_SOURCE', { id: input.elementId });
  if (el.kind === 'sql.table' || el.kind === 'sql.view') return fromTables({ subjectKind: 'platform', subjectId: el.platform_id, tables: [el.qualified_name] });
  if (el.kind === 'files.path') return fromFiles(el);
  const { readActualSchema } = await import('../dataproducts/checks/schema.js');
  const { getConnection } = await import('../platforms/service.js');
  const actual = await readActualSchema(el, p, getConnection(p.id).secrets);
  if ('unknown' in actual) throw new HttpError(400, actual.unknown, 'DATA_CONTRACT_DRAFT_EMPTY');
  const warnings: string[] = [];
  const name = el.display_name || el.qualified_name;
  const doc = skeleton(`${p.name} ${name}`.trim(), `${el.qualified_name} on ${p.name} (drafted from ${actual.source})`);
  doc.schema = [actual.object];
  if (actual.server) {
    doc.servers = [{ ...actual.server, server: slugify(el.environment || 'production') || 'production' }];
    warnings.push('Steward does not test Snowflake and Kafka servers yet – the server is documentation until then');
  }
  warnings.push('Types come from the platform’s metadata – review them, and add descriptions and quality rules');
  return finish(doc, [], warnings);
}

/**
 * A file location on object storage (0.25.0, ADR 0037 part 2): a contract with an ODCS server of type `s3` – its location
 * and, from the last discovery, the format of its files and their partition keys. Steward reads no file, so the schema
 * is left to the person drafting.
 */
async function fromFiles(el: { qualified_name: string; display_name: string; environment: string; id: string }): Promise<DataContractDraft> {
  const { parseObjectStorageUrl } = await import('@sm/shared');
  const { readoutsOf } = await import('../dataproducts/store.js');
  const u = parseObjectStorageUrl(el.qualified_name);
  if (!u) throw new HttpError(400, `${el.qualified_name} is not an S3 location (s3://bucket/prefix/)`, 'DATA_CONTRACT_DRAFT_EMPTY');
  const readout = JSON.parse(readoutsOf([el.id]).get(el.id)?.data ?? '{}') as Record<string, unknown>;
  const format = typeof readout.format === 'string' && ['parquet', 'delta', 'json', 'csv'].includes(readout.format) ? readout.format : null;
  const keys = typeof readout.partitionKeys === 'string' && readout.partitionKeys ? readout.partitionKeys : null;
  const glob = format ? `*.${format === 'delta' ? 'parquet' : format}` : '*';
  const doc = skeleton(`${el.display_name || el.qualified_name}`.trim(), `The files under ${el.qualified_name}`);
  doc.servers = [
    {
      server: slugify(el.environment || 'production') || 'production',
      type: 's3',
      location: `s3://${u.bucket}/${u.prefix}${keys ? '**/' : ''}${glob}`,
      ...(format ? { format } : {}),
      ...(format === 'csv' ? { delimiter: 'comma' } : {}),
      ...(keys ? { customProperties: [{ property: 'partitionKeys', value: keys }] } : {}),
    },
  ];
  const warnings = ['Steward reads no file contents – add the schema of the files (their columns) yourself'];
  if (!format) warnings.push('The format of the files is not known yet (a discovery reads it) – add it to the server');
  return finish(doc, [], warnings);
}

/** A draft from one of the sources (the caller must be signed in; each source checks its own rights). */
export function draftContract(body: unknown): DataContractDraft | Promise<DataContractDraft> {
  me();
  const input = dataContractDraftInput.parse(body);
  switch (input.source) {
    case 'openapi':
      return fromOpenApi(input);
    case 'recording':
      return fromRecording(input);
    case 'dataset':
      return fromDataset(input);
    case 'table':
      return fromTables(input);
    case 'element':
      return fromElement(input);
  }
}
