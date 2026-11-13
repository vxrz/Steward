import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  DATA_SEMANTIC_LIMITS as L,
  OSSIE_REVISIONS,
  elementShortName,
  type AclEntry,
  type DataSemanticFinding,
  type DataSemanticFindings,
  type OssieRevision,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import type { AuthUser } from '../auth/context.js';
import { contractAccess, platformAccess } from '../auth/policy.js';
import { isObj, parseContract, str } from '../datacontracts/odcs.js';
import { readAsset } from '../reports/pdf/assets.js';
import { parseYaml } from '../yaml-safe.js';
import { parseJson } from '../util.js';
import { personalFieldsOfDoc } from './personal-fields.js';
import { bindingsOf, chunks, elementsByIds, marks, portsOf, type ElementRow } from './store.js';

/**
 * Lint and drift of semantic models (ADR 0037 part 4, docs/DATA-PRODUCTS.md#semantic-models):
 *
 * - **Lint** checks a stored document against the vendored official Apache Ossie JSON Schema of the revision it names
 *   (0.1.1, the released one, or the pinned development revision 0.2.0.dev0; server/assets/ossie with the Apache 2.0
 *   licence) – a document that names neither is checked against 0.1.1 and says so. Findings never block saving.
 * - **Drift** compares the document with what Steward knows of the product, on every read (nothing is stored): sources
 *   that are no element bound to the product's ports, columns missing from the bound contract or the latest schema
 *   snapshot, personal fields (as the contract marks them) without an `ai_context` note, metrics that name unknown
 *   datasets or fields. Contracts and platforms the reader may not see are not used (counted). A fixed number of
 *   statements: the product's ports, bindings and elements, the contract versions (one per 500) and the snapshots
 *   (one statement).
 */

type Obj = Record<string, unknown>;
const finding = (
  kind: DataSemanticFinding['kind'],
  severity: DataSemanticFinding['severity'],
  path: string,
  message: string,
  params: DataSemanticFinding['params'] = {},
): DataSemanticFinding => ({
  kind,
  severity,
  path,
  message,
  params,
});

const bounded = (all: DataSemanticFinding[]): DataSemanticFindings => ({ findings: all.slice(0, L.findings), more: Math.max(0, all.length - L.findings) });

/** YAML (a superset of JSON) within limits; null and a finding when it does not parse. */
export function parseSemanticDocument(text: string): { doc: unknown; format: 'yaml' | 'json'; problem: DataSemanticFinding | null } {
  const trimmed = text.trimStart();
  const format = trimmed.startsWith('{') ? 'json' : 'yaml';
  try {
    const doc = parseYaml(text, { maxBytes: L.documentBytes, maxKeys: 200_000, maxAliasCount: 50 });
    if (!isObj(doc)) return { doc: null, format, problem: finding('parse', 'error', '', 'An Ossie document is a mapping (version, semantic_model …)') };
    return { doc, format, problem: null };
  } catch (e) {
    const message = (e as Error).message.split('\n')[0]!.slice(0, 300);
    return { doc: null, format, problem: finding('parse', 'error', '', `The document does not parse: ${message}`, { detail: message }) };
  }
}

/** The revision a document names, when Steward knows it. */
export function revisionOf(doc: unknown): OssieRevision | null {
  const v = isObj(doc) ? str(doc.version) : null;
  return (OSSIE_REVISIONS as readonly string[]).includes(v ?? '') ? (v as OssieRevision) : null;
}

const validators = new Map<OssieRevision, ValidateFunction>();
function validatorOf(revision: OssieRevision): ValidateFunction {
  let v = validators.get(revision);
  if (!v) {
    const schema = JSON.parse(readAsset(`ossie/ossie-${revision}.schema.json`).toString('utf8')) as Obj;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    v = ajv.compile(schema);
    validators.set(revision, v);
  }
  return v;
}

/** Lint: the document against the official schema of its revision (0.1.1 when it names none Steward knows). */
export function lintSemanticDocument(text: string): DataSemanticFindings & { revision: OssieRevision; ossieVersion: string | null; format: 'yaml' | 'json' } {
  const parsed = parseSemanticDocument(text);
  if (parsed.problem) return { ...bounded([parsed.problem]), revision: '0.1.1', ossieVersion: null, format: parsed.format };
  const named = revisionOf(parsed.doc);
  const revision = named ?? '0.1.1';
  const out: DataSemanticFinding[] = [];
  if (!named) {
    const said = isObj(parsed.doc) ? (str(parsed.doc.version) ?? '') : '';
    out.push(
      finding('version', 'warning', '/version', `The document names no Ossie revision Steward knows (${OSSIE_REVISIONS.join(', ')}) – checked against 0.1.1`, {
        version: said.slice(0, 60),
      }),
    );
  }
  const validate = validatorOf(revision);
  if (!validate(parsed.doc))
    for (const e of (validate.errors ?? []) as ErrorObject[]) {
      // a oneOf of ai_context repeats each branch's error: one line per place and keyword is enough
      const message = `${e.instancePath || '/'} ${e.message ?? ''}${e.keyword === 'additionalProperties' ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})` : ''}`;
      if (out.some((x) => x.kind === 'schema' && x.path === e.instancePath && x.params.keyword === e.keyword)) continue;
      out.push(finding('schema', 'error', e.instancePath, message.trim(), { keyword: e.keyword, detail: (e.message ?? '').slice(0, 200) }));
    }
  return { ...bounded(out), revision, ossieVersion: named, format: parsed.format };
}

// ---------- the model, whichever revision ----------

interface ModelField {
  name: string;
  column: string;
  path: string;
  aiContext: boolean;
}
interface ModelDataset {
  name: string;
  source: string;
  path: string;
  fields: ModelField[];
}
interface ModelMetric {
  name: string;
  path: string;
  expressions: string[];
  /** The dataset of a dataset-level metric (0.2.0.dev0) */
  dataset: string | null;
}

const hasAiContext = (v: unknown): boolean =>
  (typeof v === 'string' && v.trim().length > 0) ||
  (isObj(v) && ((typeof v.instructions === 'string' && v.instructions.trim().length > 0) || (Array.isArray(v.examples) && v.examples.length > 0)));

const expressionsOf = (v: unknown): string[] =>
  isObj(v) && Array.isArray(v.dialects) ? v.dialects.filter(isObj).flatMap((d) => (typeof d.expression === 'string' ? [d.expression] : [])) : [];

/** The column a field reads: a lone (quoted) identifier in its expressions, else its name. */
function columnOf(name: string, expressions: string[]): string {
  for (const e of expressions) {
    const m = /^\s*(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))\s*$/.exec(e);
    if (m) return (m[1]?.replaceAll('""', '"') ?? m[2] ?? m[3] ?? m[4])!;
  }
  return name;
}

/** Datasets, fields and metrics of a document of 0.1.1 (`semantic_model: [...]`) or 0.2.0.dev0 (one model). */
export function modelOf(doc: unknown): { datasets: ModelDataset[]; metrics: ModelMetric[] } {
  const datasets: ModelDataset[] = [];
  const metrics: ModelMetric[] = [];
  if (!isObj(doc)) return { datasets, metrics };
  const models: [Obj, string][] = Array.isArray(doc.semantic_model)
    ? doc.semantic_model.flatMap((m, i) => (isObj(m) ? [[m, `/semantic_model/${i}`] as [Obj, string]] : []))
    : [[doc, '']];
  for (const [m, base] of models) {
    (Array.isArray(m.datasets) ? m.datasets : []).forEach((d, i) => {
      if (!isObj(d)) return;
      const path = `${base}/datasets/${i}`;
      const name = str(d.name) ?? '';
      datasets.push({
        name,
        source: str(d.source) ?? '',
        path,
        fields: (Array.isArray(d.fields) ? d.fields : []).flatMap((f, j) => {
          if (!isObj(f)) return [];
          const fname = str(f.name) ?? '';
          return [{ name: fname, column: columnOf(fname, expressionsOf(f.expression)), path: `${path}/fields/${j}`, aiContext: hasAiContext(f.ai_context) }];
        }),
      });
      (Array.isArray(d.metrics) ? d.metrics : []).forEach((x, k) => {
        if (isObj(x)) metrics.push({ name: str(x.name) ?? '', path: `${path}/metrics/${k}`, expressions: expressionsOf(x.expression), dataset: name });
      });
    });
    (Array.isArray(m.metrics) ? m.metrics : []).forEach((x, k) => {
      if (isObj(x)) metrics.push({ name: str(x.name) ?? '', path: `${base}/metrics/${k}`, expressions: expressionsOf(x.expression), dataset: null });
    });
  }
  return { datasets, metrics };
}

// ---------- drift ----------

/** `a.b` references in an expression – quoted or bare identifiers, outside string literals. */
export function qualifiedRefs(expression: string): [string, string][] {
  const noStrings = expression.replace(/'(?:[^']|'')*'/g, "''");
  const id = String.raw`(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))`;
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from fixed fragments
  const re = new RegExp(`${id}\\s*\\.\\s*${id}`, 'g');
  const out: [string, string][] = [];
  for (const m of noStrings.matchAll(re)) {
    const a = m[1]?.replaceAll('""', '"') ?? m[2]!;
    const b = m[3]?.replaceAll('""', '"') ?? m[4]!;
    out.push([a, b]);
  }
  return out.slice(0, 200);
}

interface ContractColumns {
  /** lower-case column paths of the schema object that describes the element */
  columns: Set<string>;
  personal: Set<string>;
}

const VERSION_CACHE = new Map<string, Obj | null>();
const VERSION_CACHE_MAX = 500;

/** The parsed documents of these contract versions (keyed `contract#version`), one statement per 500 not in memory. */
export function contractDocsOf(keys: readonly string[]): Map<string, Obj | null> {
  const missing = [...new Set(keys)].filter((k) => !VERSION_CACHE.has(k));
  for (const part of chunks(missing)) {
    const where = part.map(() => '(contract_id = ? AND version = ?)').join(' OR ');
    const args = part.flatMap((k) => {
      const [c, v] = k.split('#') as [string, string];
      return [c, Number(v)];
    });
    for (const r of db().all<{ contract_id: string; version: number; yaml: string }>(
      `SELECT contract_id, version, yaml FROM data_contract_versions WHERE ${where}`,
      ...args,
    )) {
      let doc: Obj | null;
      try {
        doc = parseContract(r.yaml).doc;
      } catch {
        // a stored version always parses (it was checked on save); one that does not gives no columns
        doc = null;
      }
      if (VERSION_CACHE.size >= VERSION_CACHE_MAX) VERSION_CACHE.delete(VERSION_CACHE.keys().next().value!);
      VERSION_CACHE.set(`${r.contract_id}#${Number(r.version)}`, doc);
    }
  }
  return new Map(keys.map((k) => [k, VERSION_CACHE.get(k) ?? null]));
}

/** The schema object of a contract that describes an element: by physical name or name, else the only one. */
export function schemaObjectFor(doc: Obj, el: Pick<ElementRow, 'qualified_name'>): Obj | null {
  const objects = Array.isArray(doc.schema) ? doc.schema.filter(isObj) : [];
  const q = el.qualified_name.toLowerCase();
  const short = elementShortName(el.qualified_name).toLowerCase();
  const hit = objects.find((o) => {
    const phys = (str(o.physicalName) ?? '').toLowerCase();
    const name = (str(o.name) ?? '').toLowerCase();
    return phys === q || name === q || (phys && (phys === short || phys.endsWith(`.${short}`))) || name === short;
  });
  return hit ?? (objects.length === 1 ? objects[0]! : null);
}

/** Column paths (lower case) of a schema object, nested properties as `a.b`. */
function columnsOfObject(o: Obj): Set<string> {
  const out = new Set<string>();
  const stack: [unknown, string][] = (Array.isArray(o.properties) ? o.properties : []).map((p) => [p, ''] as [unknown, string]);
  let budget = 20_000;
  while (stack.length && budget-- > 0) {
    const [p, parent] = stack.pop()!;
    if (!isObj(p)) continue;
    const name = str(p.name) ?? '';
    if (!name) continue;
    const path = parent ? `${parent}.${name}` : name;
    out.add(path.toLowerCase());
    const kids = [...(Array.isArray(p.properties) ? p.properties : []), ...(isObj(p.items) && Array.isArray(p.items.properties) ? p.items.properties : [])];
    for (const k of kids) stack.push([k, path]);
  }
  return out;
}

export interface DriftContext {
  /** Elements bound to the product's ports (any direction and environment), by lower-case qualified name */
  bound: Map<string, ElementRow[]>;
  /** What is known of the columns of an element: from the contracts bound with it, else the schema snapshot */
  columns: Map<string, ContractColumns & { from: 'contract' | 'snapshot' }>;
  hiddenContracts: number;
}

/** What drift needs to know of a product, as `u` may see it (a fixed number of statements). */
export function driftContext(u: AuthUser | null, productId: string): DriftContext {
  const ports = portsOf([productId]);
  const bindings = bindingsOf(ports.map((p) => p.id));
  const elements = elementsByIds([...new Set(bindings.flatMap((b) => b.elementIds))]);
  const bound = new Map<string, ElementRow[]>();
  for (const e of elements.values()) bound.set(e.qualified_name.toLowerCase(), [...(bound.get(e.qualified_name.toLowerCase()) ?? []), e]);
  // contracts: the version each binding is held to, else the current one; only those the reader may see
  const withContract = bindings.filter((b) => b.contract_id);
  const contracts = new Map(
    chunks([...new Set(withContract.map((b) => b.contract_id!))]).flatMap((part) =>
      db()
        .all<{ id: string; current_version: number }>(`SELECT id, current_version FROM data_contracts WHERE id IN (${marks(part.length)})`, ...part)
        .map((r) => [r.id, Number(r.current_version)] as const),
    ),
  );
  const hidden = new Set<string>();
  const visibleBindings = withContract.filter((b) => {
    if (!contracts.has(b.contract_id!)) return false;
    if (contractAccess(u, { id: b.contract_id! }).permissions.includes('view')) return true;
    hidden.add(b.contract_id!);
    return false;
  });
  const keyOf = (b: (typeof visibleBindings)[number]) => `${b.contract_id}#${b.contract_version ?? contracts.get(b.contract_id!)}`;
  const docs = contractDocsOf(visibleBindings.map(keyOf));
  const columns: DriftContext['columns'] = new Map();
  for (const b of visibleBindings) {
    const doc = docs.get(keyOf(b));
    if (!doc) continue;
    const personalAll = personalFieldsOfDoc(doc).filter((f) => f.personal);
    for (const id of b.elementIds) {
      const el = elements.get(id);
      if (!el) continue;
      const o = schemaObjectFor(doc, el);
      if (!o) continue;
      const cur = columns.get(id) ?? { columns: new Set<string>(), personal: new Set<string>(), from: 'contract' as const };
      for (const c of columnsOfObject(o)) cur.columns.add(c);
      for (const f of personalAll.filter((x) => x.schema === (str(o.name) ?? ''))) cur.personal.add(f.field.toLowerCase());
      columns.set(id, cur);
    }
  }
  // SQL tables and views without a contract's columns: the latest schema snapshot of their platform, if the reader sees it
  const sqlEls = [...elements.values()].filter((e) => (e.kind === 'sql.table' || e.kind === 'sql.view') && e.platform_id && !columns.has(e.id));
  const platformIds = [...new Set(sqlEls.map((e) => e.platform_id))];
  if (platformIds.length) {
    const seen = new Set(
      chunks(platformIds).flatMap((part) =>
        db()
          .all<{ id: string; acl: string }>(`SELECT id, acl FROM platforms WHERE id IN (${marks(part.length)})`, ...part)
          .filter((p) => platformAccess(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).permissions.length > 0)
          .map((p) => p.id),
      ),
    );
    const ids = platformIds.filter((p) => seen.has(p));
    const snaps = new Map<string, { schema: string }>();
    for (const part of chunks(ids))
      for (const r of db().all<{ subject_id: string; schema_doc: string }>(
        `SELECT s.subject_id, s.schema_doc FROM db_schema_snapshots s WHERE s.subject_kind = 'platform' AND s.subject_id IN (${marks(part.length)})
           AND s.taken_at = (SELECT MAX(x.taken_at) FROM db_schema_snapshots x WHERE x.subject_kind = 'platform' AND x.subject_id = s.subject_id)`,
        ...part,
      ))
        snaps.set(r.subject_id, { schema: r.schema_doc });
    const parsed = new Map(
      [...snaps].map(([k, v]) => [k, parseJson<{ tables?: { schema: string | null; name: string; columns: { name: string }[] }[] }>(v.schema, {})]),
    );
    for (const e of sqlEls) {
      const snap = parsed.get(e.platform_id);
      const t = snap?.tables?.find((x) => `${x.schema ? `${x.schema}.` : ''}${x.name}`.toLowerCase() === e.name_norm || x.name.toLowerCase() === e.name_norm);
      if (t) columns.set(e.id, { columns: new Set(t.columns.map((c) => c.name.toLowerCase())), personal: new Set(), from: 'snapshot' });
    }
  }
  return { bound, columns, hiddenContracts: hidden.size };
}

/** Drift findings of a document against the product (empty for a document that does not parse). */
export function driftFindings(doc: unknown, ctx: DriftContext): DataSemanticFindings & { datasetsChecked: number } {
  const out: DataSemanticFinding[] = [];
  const { datasets, metrics } = modelOf(doc);
  let checked = 0;
  const unquote = (s: string) => s.trim().replace(/^["`[]|["`\]]$/g, '');
  for (const d of datasets) {
    const source = unquote(d.source);
    const els = ctx.bound.get(source.toLowerCase()) ?? [];
    if (!els.length) {
      out.push(
        finding(
          'sourceNotBound',
          'warning',
          `${d.path}/source`,
          `The source of the dataset "${d.name}" (${source.slice(0, 200)}) is no element bound to the product's ports`,
          {
            dataset: d.name,
            source: source.slice(0, 200),
          },
        ),
      );
      continue;
    }
    // the columns of every bound element of that name (the environments may differ): known in one is enough
    const known = els.map((e) => ctx.columns.get(e.id)).filter((x): x is NonNullable<typeof x> => !!x);
    if (!known.length) continue;
    checked++;
    const all = new Set(known.flatMap((k) => [...k.columns]));
    const personal = new Set(known.flatMap((k) => [...k.personal]));
    const from = known.some((k) => k.from === 'contract') ? 'contract' : 'snapshot';
    for (const f of d.fields) {
      const col = f.column.toLowerCase();
      if (!all.has(col))
        out.push(
          finding(
            'columnMissing',
            'warning',
            `${f.path}`,
            `The field "${f.name}" of "${d.name}" reads the column "${f.column}", which is not in the bound ${from === 'contract' ? 'contract' : 'schema snapshot'}`,
            { dataset: d.name, field: f.name, column: f.column, from },
          ),
        );
      else if (personal.has(col) && !f.aiContext)
        out.push(
          finding(
            'personalNoAiContext',
            'warning',
            `${f.path}`,
            `The field "${f.name}" of "${d.name}" is personal data in the bound contract but has no ai_context note`,
            {
              dataset: d.name,
              field: f.name,
            },
          ),
        );
    }
  }
  const byName = new Map(datasets.map((d) => [d.name.toLowerCase(), d]));
  for (const m of metrics) {
    const reported = new Set<string>();
    for (const e of m.expressions)
      for (const [a, b] of qualifiedRefs(e)) {
        const key = `${a}.${b}`.toLowerCase();
        if (reported.has(key)) continue;
        const d = byName.get(a.toLowerCase());
        if (!d) {
          // a qualified name of another kind (a function's schema, a field of the metric's own dataset by alias) is not
          // a dataset: only names that look like references of this model are reported – datasets of the same document
          if (m.dataset) continue;
          reported.add(key);
          out.push(
            finding('metricUnknownDataset', 'warning', `${m.path}/expression`, `The metric "${m.name}" names "${a}", which is no dataset of the model`, {
              metric: m.name,
              dataset: a,
            }),
          );
          continue;
        }
        if (!d.fields.some((f) => f.name.toLowerCase() === b.toLowerCase())) {
          reported.add(key);
          out.push(
            finding('metricUnknownField', 'warning', `${m.path}/expression`, `The metric "${m.name}" names "${a}.${b}", which is no field of "${d.name}"`, {
              metric: m.name,
              dataset: d.name,
              field: b,
            }),
          );
        }
      }
  }
  return { ...bounded(out), datasetsChecked: checked };
}
