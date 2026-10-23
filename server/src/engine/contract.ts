import type { ApiOperation, ContractCheckResult } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { parseJson } from '../util.js';
import { getPlatform, getSecrets } from '../platforms/service.js';
import { platformRequest, secretValues } from '../platforms/http.js';
import { resolveRef } from '../platforms/openapi.js';
import { parseYaml, SPEC_YAML } from '../yaml-safe.js';

/**
 * Sandbox contract test: call every documented GET operation without required
 * path parameters and compare status and top-level response shape with the
 * platform's imported OpenAPI specifications.
 */

type Doc = Record<string, unknown>;
type Schema = Record<string, unknown>;

const MAX_OPERATIONS = 30;

function parseDoc(content: string): Doc | undefined {
  try {
    const d = content.trim().startsWith('{') ? JSON.parse(content) : parseYaml(content, SPEC_YAML);
    return d && typeof d === 'object' ? (d as Doc) : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve $ref and merge allOf parts into one schema (properties, required, type). */
function flatten(doc: Doc, s: unknown, depth = 0): Schema | undefined {
  const r = resolveRef(doc, s) as Schema | undefined;
  if (!r || typeof r !== 'object' || depth > 10) return undefined;
  if (!Array.isArray(r.allOf)) return r;
  const merged: Schema = { ...r, properties: { ...((r.properties as object) ?? {}) }, required: [...((r.required as string[]) ?? [])] };
  delete merged.allOf;
  for (const part of r.allOf as unknown[]) {
    const f = flatten(doc, part, depth + 1);
    if (!f) continue;
    if (f.type && !merged.type) merged.type = f.type;
    Object.assign(merged.properties as object, (f.properties as object) ?? {});
    (merged.required as string[]).push(...((f.required as string[]) ?? []));
  }
  return merged;
}

function responseSchema(doc: Doc | undefined, op: ApiOperation, status: number): Schema | undefined {
  if (!doc) return undefined;
  const pathItem = (doc.paths as Record<string, Record<string, unknown>> | undefined)?.[op.path];
  const operation = pathItem?.[op.method.toLowerCase()] as Record<string, unknown> | undefined;
  const responses = (operation?.responses ?? {}) as Record<string, unknown>;
  const pick = responses[String(status)] ?? responses[`${String(status)[0]}XX`] ?? responses[String(op.successStatus?.[0] ?? 200)] ?? responses.default;
  const res = resolveRef(doc, pick) as { content?: Record<string, { schema?: unknown }>; schema?: unknown } | undefined;
  if (!res) return undefined;
  if (res.content) {
    const ct = Object.keys(res.content).find((c) => c.includes('json'));
    return ct ? flatten(doc, res.content[ct]?.schema) : undefined;
  }
  return res.schema ? flatten(doc, res.schema) : undefined;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected: unknown, actual: string, nullable: boolean): boolean {
  const list = (Array.isArray(expected) ? expected : [expected]).map(String);
  if (actual === 'null') return nullable || list.includes('null');
  if (list.includes(actual)) return true;
  return actual === 'integer' && list.includes('number');
}

/** Top-level shape problems of a JSON body against a schema (type, required and documented property types). */
export function shapeProblems(doc: Doc, schema: Schema, body: unknown): string[] {
  const problems: string[] = [];
  const type = schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined);
  const actual = typeOf(body);
  if (type && !typeMatches(type, actual, !!schema.nullable)) {
    problems.push(
      `response is ${actual === 'string' ? 'not JSON / a string' : `a${actual === 'array' || actual === 'object' || actual === 'integer' ? 'n' : ''} ${actual}`}, documented as ${String(type)}`,
    );
    return problems;
  }
  const checkObject = (obj: Record<string, unknown>, s: Schema, where: string) => {
    for (const req of (s.required as string[] | undefined) ?? []) if (!(req in obj)) problems.push(`${where}missing required property "${req}"`);
    for (const [k, ps] of Object.entries((s.properties as Record<string, unknown>) ?? {})) {
      if (!(k in obj) || obj[k] === undefined) continue;
      const p = flatten(doc, ps);
      const pt = p?.type ?? (p?.properties ? 'object' : p?.items ? 'array' : undefined);
      if (pt && !typeMatches(pt, typeOf(obj[k]), !!p?.nullable)) problems.push(`${where}property "${k}" is ${typeOf(obj[k])}, documented as ${String(pt)}`);
    }
  };
  if (actual === 'object') checkObject(body as Record<string, unknown>, schema, '');
  if (actual === 'array' && (body as unknown[]).length) {
    const item = flatten(doc, schema.items);
    const first = (body as unknown[])[0];
    const it = item?.type ?? (item?.properties ? 'object' : undefined);
    if (item && it && !typeMatches(it, typeOf(first), !!item.nullable)) problems.push(`items are ${typeOf(first)}, documented as ${String(it)}`);
    else if (item && typeOf(first) === 'object') checkObject(first as Record<string, unknown>, item, 'item: ');
  }
  return problems;
}

export async function contractCheck(platformId: string): Promise<ContractCheckResult> {
  const p = getPlatform(platformId);
  const secrets = getSecrets(platformId);
  const specs = db().all<{ id: string; content: string; operations: string }>(
    'SELECT id, content, operations FROM platform_specs WHERE platform_id = ? ORDER BY created_at',
    platformId,
  );
  const candidates: { op: ApiOperation; doc?: Doc }[] = [];
  let skipped = 0;
  for (const s of specs) {
    const doc = parseDoc(s.content);
    for (const op of parseJson<ApiOperation[]>(s.operations, [])) {
      if (op.method.toUpperCase() !== 'GET') continue;
      const pathParams = (op.parameters ?? []).filter((x) => x.in === 'path' && x.required);
      if (pathParams.length || /\{[^}]+\}/.test(op.path)) {
        skipped++;
        continue;
      }
      if (candidates.length >= MAX_OPERATIONS) {
        skipped++;
        continue;
      }
      candidates.push({ op: { ...op, specId: s.id }, doc });
    }
  }
  const mask = (text: string) => secretValues(secrets).reduce((t, v) => (v && t.includes(v) ? t.split(v).join('***') : t), text);
  const results: ContractCheckResult['results'] = [];
  for (const { op, doc } of candidates) {
    const problems: string[] = [];
    const query: Record<string, unknown> = {};
    for (const q of op.parameters ?? []) {
      if (q.in !== 'query' || !q.required) continue;
      const v = q.schema?.default ?? q.schema?.enum?.[0];
      if (v !== undefined) query[q.name] = v;
      else problems.push(`required query parameter "${q.name}" has no default – called without it`);
    }
    let status = 0;
    let durationMs: number | undefined;
    try {
      const res = await platformRequest(p, secrets, { method: 'GET', url: op.path, query });
      status = res.status;
      durationMs = res.durationMs;
      const expected = op.successStatus?.length ? op.successStatus : undefined;
      const statusOk = expected ? expected.includes(status) : status >= 200 && status < 300;
      if (!statusOk) problems.push(`HTTP ${status}, expected ${expected ? expected.join('/') : '2xx'}`);
      else {
        const schema = responseSchema(doc, op, status);
        if (schema && res.body !== null && res.body !== '') problems.push(...shapeProblems(doc!, schema, res.body));
      }
    } catch (e) {
      problems.push(mask((e as Error).message));
    }
    const ok = status > 0 && !problems.some((x) => !x.startsWith('required query parameter'));
    results.push({ operationId: op.operationId, method: 'GET', path: op.path, status, ok, problems: problems.map(mask), durationMs });
  }
  const passed = results.filter((r) => r.ok).length;
  const out: ContractCheckResult = { platformId, checked: results.length, passed, failed: results.length - passed, skipped, results };
  audit({
    action: 'platform.contract_checked',
    entityType: 'platform',
    entityId: platformId,
    summary: results.length
      ? `Contract check "${p.name}": ${passed} of ${results.length} operation(s) passed`
      : `Contract check "${p.name}": no GET operations without path parameters to check`,
    details: {
      checked: out.checked,
      passed,
      failed: out.failed,
      skipped,
      failures: results.filter((r) => !r.ok).map((r) => ({ path: r.path, status: r.status, problems: r.problems })),
    },
  });
  return out;
}
