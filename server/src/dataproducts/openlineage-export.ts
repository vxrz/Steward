import { elementShortName, openLineageDataset, type DataStep, type DataStepRunner } from '@sm/shared';
import { db } from '../db.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { contractAccess } from '../auth/policy.js';
import { isObj, parseContract, str } from '../datacontracts/odcs.js';
import { stepNotFound } from './common.js';
import { platformAddresses } from './ol-addresses.js';
import { visibleProduct } from './service.js';
import { productSteps } from './steps.js';
import { bindingsOf, chunks, elementsByIds, marks, membersOf, portsOf, type ElementRow } from './store.js';

/**
 * The OpenLineage static export of a product and of one of its steps (0.25.0, ADR 0037 part 5): JSON Lines of
 * OpenLineage 2-0-x events, as Steward documents the pipeline – nothing runs, so there is no run:
 *
 * - a **DatasetEvent** per element the export names (the product's members, the steps' ends), its dataset the
 *   OpenLineage namespace and name discovery (or a person, for a generic part) gave it – else `steward://elements/<env>`
 *   and `<kind>/<qualified name>` – with a **schema** facet from the data contract bound to the product's output port in
 *   the element's environment (the contract version it is held to, the schema object of the element's name or the only
 *   one; the reader must see the contract);
 * - a **JobEvent** per step (job namespace `steward://data-products/<product key>`, its name) with the **jobType** facet
 *   (processing BATCH, STREAMING for bridges and connector runners; integration the runner's technology or tool, else
 *   STEWARD; jobType the step's kind) and its inputs and outputs.
 *
 * Team scope: an end the reader may not see is not named – the step counts it in the Steward facet `steward_hiddenEnds`
 * (docs/data-products/steward-openlineage-facets.json); a runner they may not see gives no integration. Validated in
 * the tests against the OpenLineage spec and facet schemas (server/test/fixtures/openlineage) and with the push's own
 * check (lineage/openlineage.ts) – an export can be pushed back to a lineage source.
 */

export const OL_SPEC_URL = 'https://openlineage.io/spec/2-0-2/OpenLineage.json';
export const OL_PRODUCER = 'https://github.com/vxrz/Steward';
const JOB_TYPE_URL = 'https://openlineage.io/spec/facets/2-0-4/JobTypeJobFacet.json#/$defs/JobTypeJobFacet';
const SCHEMA_FACET_URL = 'https://openlineage.io/spec/facets/1-2-0/SchemaDatasetFacet.json#/$defs/SchemaDatasetFacet';
export const STEWARD_FACETS_URL = 'https://github.com/vxrz/Steward/blob/main/docs/data-products/steward-openlineage-facets.json';

/** Fields of one schema facet, and how deep nested fields go. */
const MAX_FIELDS = 1_000;
const MAX_DEPTH = 10;

type Obj = Record<string, unknown>;

interface SchemaField {
  name: string;
  type?: string;
  description?: string;
  fields?: SchemaField[];
}

/** The fields of an ODCS schema object (properties, nested properties and items), at most MAX_FIELDS. */
function fieldsOf(props: unknown, budget: { n: number }, depth = 0): SchemaField[] {
  if (!Array.isArray(props) || depth > MAX_DEPTH) return [];
  const out: SchemaField[] = [];
  for (const p of props) {
    if (!isObj(p) || budget.n <= 0) continue;
    const name = str(p.name);
    if (!name) continue;
    budget.n--;
    const type = str(p.physicalType) ?? str(p.logicalType);
    const description = str(p.description);
    const kids = [...(Array.isArray(p.properties) ? p.properties : []), ...(isObj(p.items) && Array.isArray(p.items.properties) ? p.items.properties : [])];
    const nested = kids.length ? fieldsOf(kids, budget, depth + 1) : [];
    out.push({
      name,
      ...(type ? { type } : {}),
      ...(description ? { description: description.slice(0, 2_000) } : {}),
      ...(nested.length ? { fields: nested } : {}),
    });
  }
  return out;
}

/** The dataset of an element: its OpenLineage namespace and name, else its platform's (as discovery would give it), else Steward's. */
function datasetOf(r: ElementRow, addresses: ReadonlyMap<string, { address: string; prefix: string } | null>): { namespace: string; name: string } {
  if (r.ol_namespace && r.ol_name) return { namespace: r.ol_namespace, name: r.ol_name };
  const a = r.platform_id ? addresses.get(r.platform_id) : null;
  const ds = a ? openLineageDataset(r.kind, a.address, `${a.prefix}${r.qualified_name}`) : null;
  if (ds) return ds;
  return { namespace: `steward://elements/${encodeURIComponent(r.environment || '-')}`, name: `${r.kind}/${r.qualified_name}` };
}

/** The schema facets of these elements from the contracts bound to the product's output ports (by element id). */
function schemaFacets(u: AuthUser, productId: string, rows: ReadonlyMap<string, ElementRow>): Map<string, SchemaField[]> {
  const out = new Map<string, SchemaField[]>();
  const ports = portsOf([productId]).filter((p) => p.direction === 'output');
  const wanted: { elementId: string; contractId: string; version: number | null }[] = [];
  for (const b of bindingsOf(ports.map((p) => p.id)))
    if (b.contract_id)
      for (const e of b.elementIds) {
        const r = rows.get(e);
        if (r && r.environment === b.environment) wanted.push({ elementId: e, contractId: b.contract_id, version: b.contract_version });
      }
  if (!wanted.length) return out;
  const ids = [...new Set(wanted.map((w) => w.contractId))].filter((id) => contractAccess(u, { id }).permissions.includes('view'));
  const current = new Map(
    chunks(ids).flatMap((part) =>
      db()
        .all<{ id: string; current_version: number }>(`SELECT id, current_version FROM data_contracts WHERE id IN (${marks(part.length)})`, ...part)
        .map((c) => [c.id, Number(c.current_version)] as const),
    ),
  );
  const pairs = [...new Set(wanted.filter((w) => current.has(w.contractId)).map((w) => `${w.contractId}#${w.version ?? current.get(w.contractId)}`))];
  const docs = new Map<string, Obj>();
  for (const part of chunks(pairs)) {
    const where = part.map(() => '(contract_id = ? AND version = ?)').join(' OR ');
    for (const r of db().all<{ contract_id: string; version: number; yaml: string }>(
      `SELECT contract_id, version, yaml FROM data_contract_versions WHERE ${where}`,
      ...part.flatMap((k) => {
        const [c, v] = k.split('#') as [string, string];
        return [c, Number(v)];
      }),
    )) {
      try {
        docs.set(`${r.contract_id}#${Number(r.version)}`, parseContract(r.yaml).doc);
      } catch {
        // a stored version always parses (it was checked on save); one that does not gives no schema
      }
    }
  }
  for (const w of wanted) {
    if (out.has(w.elementId) || !current.has(w.contractId)) continue;
    const doc = docs.get(`${w.contractId}#${w.version ?? current.get(w.contractId)}`);
    const schemas = doc && Array.isArray(doc.schema) ? doc.schema.filter(isObj) : [];
    const r = rows.get(w.elementId)!;
    const short = elementShortName(r.qualified_name).toLowerCase();
    const s =
      schemas.find((x) => [str(x.name), str(x.physicalName)].some((n) => n?.toLowerCase() === short || n?.toLowerCase() === r.qualified_name.toLowerCase())) ??
      (schemas.length === 1 ? schemas[0] : undefined);
    if (!s) continue;
    const fields = fieldsOf(s.properties, { n: MAX_FIELDS });
    if (fields.length) out.set(w.elementId, fields);
  }
  return out;
}

/** The integration of a step's runner: its technology, a tool's name, else Steward. */
function integrationOf(r: DataStepRunner | null): string {
  const raw = r?.technology || (r?.kind === 'tool' ? r.tool : '') || (r?.kind === 'connector' ? 'kafka-connect' : '') || 'steward';
  return (
    raw
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'STEWARD'
  );
}

const STREAMING_TECHNOLOGIES = new Set(['debezium', 'kafka-connect', 'confluent', 'node-red', 'apache-camel', 'industrial-edge', 'mqtt']);

function jobEvent(productKey: string, s: DataStep, name: string, datasets: Map<string, { namespace: string; name: string }>, at: string): Obj {
  const streaming = s.kind === 'bridge' || s.runner?.kind === 'connector' || STREAMING_TECHNOLOGIES.has((s.runner?.technology ?? '').toLowerCase());
  const facets: Obj = {
    jobType: {
      _producer: OL_PRODUCER,
      _schemaURL: JOB_TYPE_URL,
      processingType: streaming ? 'STREAMING' : 'BATCH',
      integration: integrationOf(s.runnerHidden ? null : s.runner),
      jobType: s.kind.toUpperCase(),
    },
  };
  if (s.hiddenInputs || s.hiddenOutputs)
    facets.steward_hiddenEnds = {
      _producer: OL_PRODUCER,
      _schemaURL: `${STEWARD_FACETS_URL}#/$defs/HiddenEndsJobFacet`,
      inputs: s.hiddenInputs,
      outputs: s.hiddenOutputs,
    };
  return {
    eventTime: at,
    producer: OL_PRODUCER,
    schemaURL: `${OL_SPEC_URL}#/$defs/JobEvent`,
    job: { namespace: `steward://data-products/${encodeURIComponent(productKey)}`, name, facets },
    inputs: s.inputs.flatMap((id) => (datasets.has(id) ? [datasets.get(id)!] : [])),
    outputs: s.outputs.flatMap((id) => (datasets.has(id) ? [datasets.get(id)!] : [])),
  };
}

export interface OpenLineageExport {
  fileName: string;
  events: Obj[];
  /** The events as JSON Lines (one per line, a line break after each) */
  body: string;
}

/**
 * The events of a product (`stepId`: of one of its steps) as the reader may see them; `environment`: only the steps
 * with an end there and the members there (default: every environment).
 */
export function openLineageExport(productId: string, opts: { environment?: string; stepId?: string } = {}, now = new Date()): OpenLineageExport {
  const u = me();
  const { row: p } = visibleProduct(productId, u);
  const all = productSteps(p.id);
  let steps = all;
  if (opts.stepId) {
    steps = all.filter((s) => s.id === opts.stepId);
    if (!steps.length) throw stepNotFound(opts.stepId);
  }
  const members = opts.stepId ? [] : membersOf([p.id]).map((m) => m.element_id);
  const rows = elementsByIds([...new Set([...members, ...steps.flatMap((s) => [...s.inputs, ...s.outputs])])]);
  const env = opts.environment;
  if (env !== undefined && env !== '') steps = steps.filter((s) => [...s.inputs, ...s.outputs].some((id) => rows.get(id)?.environment === env));
  const named = new Set(
    [
      ...members.filter((id) => env === undefined || env === '' || rows.get(id)?.environment === env),
      ...steps.flatMap((s) => [...s.inputs, ...s.outputs]),
    ].filter((id) => rows.has(id)),
  );
  const addresses = platformAddresses([...named].map((id) => rows.get(id)!.platform_id));
  const datasets = new Map([...named].map((id) => [id, datasetOf(rows.get(id)!, addresses)] as const));
  const schemas = schemaFacets(u, p.id, new Map([...named].map((id) => [id, rows.get(id)!] as const)));
  const at = now.toISOString();
  const events: Obj[] = [];
  // one dataset event per dataset (two elements with one dataset: the first with a schema)
  const seen = new Set<string>();
  const order = [...named].sort((a, b) => (schemas.has(b) ? 1 : 0) - (schemas.has(a) ? 1 : 0) || rows.get(a)!.name_norm.localeCompare(rows.get(b)!.name_norm));
  for (const id of order) {
    const d = datasets.get(id)!;
    const k = `${d.namespace.toLowerCase()}\n${d.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const fields = schemas.get(id);
    events.push({
      eventTime: at,
      producer: OL_PRODUCER,
      schemaURL: `${OL_SPEC_URL}#/$defs/DatasetEvent`,
      dataset: { ...d, ...(fields ? { facets: { schema: { _producer: OL_PRODUCER, _schemaURL: SCHEMA_FACET_URL, fields } } } : {}) },
    });
  }
  // job names are unique within the product's namespace: a second step of one name is numbered
  const used = new Map<string, number>();
  for (const s of steps) {
    const n = (used.get(s.name) ?? 0) + 1;
    used.set(s.name, n);
    events.push(jobEvent(p.key, s, n > 1 ? `${s.name} (${n})` : s.name, datasets, at));
  }
  const base = String(p.key).replace(/[^a-z0-9._-]+/gi, '-');
  const stepPart = opts.stepId ? `-${(steps[0]!.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'step').slice(0, 60)}` : '';
  return {
    fileName: `${base}${stepPart}.openlineage.jsonl`,
    events,
    body: events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''),
  };
}
