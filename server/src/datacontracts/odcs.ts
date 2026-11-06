import { Ajv2019, type ErrorObject, type ValidateFunction } from 'ajv/dist/2019.js';
import YAML from 'yaml';
import { DATA_CONTRACT_LIMITS, ODCS_SCHEMA_VERSION, type DataContractFacts, type DataContractLintFinding } from '@sm/shared';
import { readAsset } from '../reports/pdf/assets.js';
import { parseYamlDocument } from '../yaml-safe.js';
import { HttpError } from '../util.js';

/**
 * ODCS v3 documents (#221): reading a contract within limits (the YAML library and the limits of the plant registry
 * import – size, keys, aliases, depth), the check against the official JSON Schema of ODCS v3.0.2 (vendored in
 * server/assets/odcs with its Apache 2.0 licence, https://github.com/bitol-io/open-data-contract-standard), and the
 * facts Steward reads from it (id, name, version, status, schema objects and their properties, servers, team).
 *
 * Nothing here builds a regular expression from the document: `logicalTypeOptions.pattern` and the like are data.
 */

const L = DATA_CONTRACT_LIMITS;
/** The v3 versions the vendored JSON Schema accepts (its apiVersion enum). */
const ODCS_CHECKED_VERSIONS = ['v3.0.0', 'v3.0.1', 'v3.0.2'];

export type OdcsDoc = Record<string, unknown>;
type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);

/** Nesting depth of a parsed document (iterative: deep nesting cannot overflow the stack). */
function depthOf(v: unknown, max: number): number {
  let deepest = 0;
  const stack: [unknown, number][] = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    if (d > deepest) deepest = d;
    if (d > max + 1) return d;
    for (const c of Array.isArray(x) ? x : Object.values(x)) stack.push([c, d + 1]);
  }
  return deepest;
}

export interface ParsedContract {
  doc: OdcsDoc;
  /** Problems that make the text unusable as a contract (YAML errors, not ODCS v3); empty: it can be saved */
  problems: DataContractLintFinding[];
}

const problem = (message: string, path = '/'): DataContractLintFinding => ({ path, message, severity: 'error', source: 'yaml' });

/**
 * Parses a contract. Limits that make reading unsafe (size, keys) answer 413/400 at once; a YAML error, a document
 * nested too deep, more aliases than allowed or something that is not an ODCS v3 contract come back as problems.
 */
export function parseContract(text: string): ParsedContract {
  const doc = parseYamlDocument(text, { maxBytes: L.yamlBytes, maxKeys: L.keys });
  if (doc.errors.length) {
    const e = doc.errors[0]!;
    const pos = e.linePos?.[0];
    return { doc: {}, problems: [problem(e.message.split('\n')[0]!, pos ? `line ${pos.line}, column ${pos.col}` : '/')] };
  }
  let raw: unknown;
  try {
    // aliases are expanded at most this often: a "billion laughs" document is refused, not expanded
    raw = doc.toJS({ maxAliasCount: L.aliases });
  } catch (e) {
    return { doc: {}, problems: [problem((e as Error).message.split('\n')[0]!.slice(0, 300))] };
  }
  if (depthOf(raw, L.depth) > L.depth) return { doc: {}, problems: [problem(`The document is nested deeper than ${L.depth} levels`)] };
  if (!isObj(raw)) return { doc: {}, problems: [problem('A data contract is a YAML mapping (apiVersion, kind, id, …)')] };
  const problems: DataContractLintFinding[] = [];
  if (raw.kind !== 'DataContract') problems.push(problem('kind must be DataContract', '/kind'));
  const apiVersion = str(raw.apiVersion) ?? '';
  if (!apiVersion.startsWith('v3.')) problems.push(problem(`apiVersion must be an ODCS v3 version (${ODCS_SCHEMA_VERSION}, v3.0.1, v3.0.0 …)`, '/apiVersion'));
  const id = str(raw.id)?.trim() ?? '';
  if (!id) problems.push(problem('id is required: the contract’s identifier', '/id'));
  else if (id.length > L.nameChars) problems.push(problem(`id is longer than ${L.nameChars} characters`, '/id'));
  const schemas = Array.isArray(raw.schema) ? raw.schema : [];
  if (schemas.length > L.schemaObjects) problems.push(problem(`More than ${L.schemaObjects} schema objects`, '/schema'));
  if (countProperties(schemas) > L.properties) problems.push(problem(`More than ${L.properties} properties`, '/schema'));
  return { doc: raw, problems };
}

/** Properties of all schema objects, all levels (iterative). */
function countProperties(schemas: unknown[]): number {
  let n = 0;
  const stack: unknown[] = [...schemas];
  while (stack.length && n <= L.properties) {
    const x = stack.pop();
    if (!isObj(x)) continue;
    for (const p of Array.isArray(x.properties) ? x.properties : []) {
      n++;
      stack.push(p);
    }
    if (isObj(x.items)) stack.push(x.items);
  }
  return n;
}

// ---------- the JSON Schema check ----------

let validator: ValidateFunction | null = null;

/** The official JSON Schema of ODCS v3.0.2, compiled once. */
function odcsValidator(): ValidateFunction {
  if (validator) return validator;
  const schema = JSON.parse(readAsset('odcs/odcs-json-schema-v3.0.2.json').toString('utf8')) as Obj;
  const ajv = new Ajv2019({ allErrors: true, strict: false, validateFormats: true });
  // the three formats the schema uses, checked without regular expressions over the value
  ajv.addFormat('date', { type: 'string', validate: (s: string) => isDate(s) });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (s: string) => s.length >= 20 && s.length <= 40 && isDate(s.slice(0, 10)) && s[10]?.toUpperCase() === 'T' && !Number.isNaN(Date.parse(s)),
  });
  ajv.addFormat('uri', { type: 'string', validate: (s: string) => s.length <= 4096 && URL.canParse(s) });
  validator = ajv.compile(schema);
  return validator;
}

function isDate(s: string): boolean {
  if (s.length !== 10 || s[4] !== '-' || s[7] !== '-') return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function errorText(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  if (e.keyword === 'enum' && Array.isArray(p.allowedValues)) return `must be one of: ${p.allowedValues.map(String).join(', ')}`.slice(0, 300);
  if ((e.keyword === 'additionalProperties' || e.keyword === 'unevaluatedProperties') && typeof (p.additionalProperty ?? p.unevaluatedProperty) === 'string')
    return `${String(p.additionalProperty ?? p.unevaluatedProperty)} is not a field of ODCS ${ODCS_SCHEMA_VERSION}`;
  if (e.keyword === 'required' && typeof p.missingProperty === 'string') return `${p.missingProperty} is required`;
  return (e.message ?? e.keyword).slice(0, 300);
}

/**
 * The JSON Schema check of ODCS v3.0.2. A contract of a later v3 version (v3.1.0, v3.2.0) is not checked against it –
 * the finding says so, and the data contract service's lint checks it against its own schema.
 */
export function lintContract(doc: OdcsDoc): DataContractLintFinding[] {
  const apiVersion = str(doc.apiVersion) ?? '';
  if (!ODCS_CHECKED_VERSIONS.includes(apiVersion) && apiVersion.startsWith('v3.'))
    return [
      {
        path: '/apiVersion',
        message: `Checked against ODCS ${ODCS_SCHEMA_VERSION} only: ${apiVersion} is newer – use "Lint with the service" for the full check`,
        severity: 'info',
        source: 'schema',
      },
    ];
  const validate = odcsValidator();
  if (validate(doc)) return [];
  const seen = new Set<string>();
  const out: DataContractLintFinding[] = [];
  // "must match then schema" only repeats the errors of the branch; and a field that fails its own check is no longer
  // "evaluated", so the schema also calls every sibling unknown – only real unknown fields are kept
  const errors = (validate.errors ?? []).filter((e) => e.keyword !== 'if' && e.keyword !== 'allOf');
  const failing = errors.filter((e) => e.keyword !== 'unevaluatedProperties').map((e) => e.instancePath);
  for (const e of errors) {
    if (e.keyword === 'unevaluatedProperties' && failing.some((p) => p === e.instancePath || p.startsWith(`${e.instancePath}/`))) continue;
    const f: DataContractLintFinding = { path: e.instancePath || '/', message: errorText(e), severity: 'error', source: 'schema' };
    const k = `${f.path}|${f.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
    if (out.length >= L.lintFindings) break;
  }
  return out;
}

// ---------- facts ----------

/** The property paths of a schema object (nested objects and array items: a.b, a.items.c is written a.c). */
export function propertyPaths(schemaObject: unknown): string[] {
  const out: string[] = [];
  const stack: [unknown, string][] = [[schemaObject, '']];
  while (stack.length && out.length < L.properties) {
    const [x, prefix] = stack.pop()!;
    if (!isObj(x)) continue;
    const props = Array.isArray(x.properties) ? x.properties : [];
    for (let i = props.length - 1; i >= 0; i--) {
      const p = props[i];
      const name = isObj(p) ? str(p.name) : null;
      if (!name) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      out.push(path);
      stack.push([p, path]);
      if (isObj(p) && isObj(p.items)) stack.push([p.items, path]);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function factsOf(doc: OdcsDoc): DataContractFacts {
  const key = str(doc.id)?.trim() ?? '';
  const schemas = (Array.isArray(doc.schema) ? doc.schema : []).filter(isObj).map((s) => ({
    name: str(s.name) ?? '',
    physicalName: str(s.physicalName),
    properties: propertyPaths(s),
  }));
  const servers = (Array.isArray(doc.servers) ? doc.servers : []).filter(isObj).map((s) => ({ server: str(s.server) ?? '', type: str(s.type) ?? '' }));
  // team: a list of members in v3.0, an object with members from v3.1 on
  const members = Array.isArray(doc.team) ? doc.team : isObj(doc.team) && Array.isArray(doc.team.members) ? doc.team.members : [];
  const team = members
    .filter(isObj)
    .map((m) => str(m.username) ?? str(m.name) ?? '')
    .filter(Boolean)
    .slice(0, 100);
  return {
    key,
    name: (str(doc.name) ?? key).trim().slice(0, L.nameChars) || key,
    version: (str(doc.version) ?? '').slice(0, 100),
    apiVersion: (str(doc.apiVersion) ?? '').slice(0, 20),
    status: (str(doc.status) ?? '').slice(0, 50),
    domain: str(doc.domain)?.slice(0, 200) ?? null,
    schemas,
    servers,
    team,
  };
}

/** Checks a text to be saved: 400 DATA_CONTRACT_INVALID with the problems when it cannot be a contract. */
export function readContract(text: string): { doc: OdcsDoc; facts: DataContractFacts; lint: DataContractLintFinding[] } {
  const p = parseContract(text);
  if (p.problems.length) {
    const first = p.problems[0]!;
    throw Object.assign(
      new HttpError(400, `Not a valid data contract: ${first.message} (${first.path})`, 'DATA_CONTRACT_INVALID', { message: first.message, path: first.path }),
      {
        issues: p.problems.map((x) => ({ path: x.path, message: x.message })),
      },
    );
  }
  return { doc: p.doc, facts: factsOf(p.doc), lint: lintContract(p.doc) };
}

/** A contract as YAML in Steward's layout (drafts, exports of generated contracts). */
export function toYaml(doc: OdcsDoc): string {
  return YAML.stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false });
}
