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

/**
 * Nesting depth, values and quality rules of a parsed document, in one iterative walk (deep nesting cannot overflow the
 * stack); stops as soon as a limit is passed.
 */
function shapeOf(v: unknown): { depth: number; nodes: number; quality: number } {
  let depth = 0;
  let nodes = 0;
  let quality = 0;
  const stack: [unknown, number][] = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (++nodes > L.nodes) break;
    if (x === null || typeof x !== 'object') continue;
    if (d > depth) depth = d;
    if (d > L.depth + 1) break;
    if (Array.isArray(x)) for (const c of x) stack.push([c, d + 1]);
    else
      for (const [k, c] of Object.entries(x)) {
        if (k === 'quality' && Array.isArray(c) && (quality += c.length) > L.qualityRules) return { depth, nodes, quality };
        stack.push([c, d + 1]);
      }
  }
  return { depth, nodes, quality };
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
  const shape = shapeOf(raw);
  if (shape.depth > L.depth) return { doc: {}, problems: [problem(`The document is nested deeper than ${L.depth} levels`)] };
  if (shape.nodes > L.nodes) return { doc: {}, problems: [problem(`The document has more than ${L.nodes} values`)] };
  if (shape.quality > L.qualityRules) return { doc: {}, problems: [problem(`More than ${L.qualityRules} quality rules`, '/schema')] };
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
  else problems.push(...comparedFields(raw, schemas));
  return { doc: raw, problems };
}

/** The flags of a property Steward compares (a string "true" is not true: refused, so the comparison cannot be fooled) */
const FLAGS = ['required', 'unique', 'primaryKey', 'partitioned', 'criticalDataElement'];
/** Limits of logicalTypeOptions that are numbers */
export const NUMERIC_OPTIONS = [
  'maxLength',
  'maxItems',
  'maximum',
  'exclusiveMaximum',
  'maxProperties',
  'minLength',
  'minItems',
  'minimum',
  'exclusiveMinimum',
  'minProperties',
];
/** Thresholds of quality rules that are numbers (mustBeBetween / mustNotBeBetween: two numbers) */
export const NUMERIC_THRESHOLDS = ['mustBeLessThan', 'mustBeLessOrEqualTo', 'mustBeGreaterThan', 'mustBeGreaterOrEqualTo'];
const MAX_FIELD_PROBLEMS = 50;

/**
 * What the comparison of versions relies on (docs/DATA-CONTRACTS.md#breaking-changes), refused when it does not hold:
 * unique names of servers, schema objects and of the properties on one level, the property limit, and the types of the
 * compared values – flags are true or false, limits and thresholds are numbers. One iterative walk over the schema.
 */
function comparedFields(raw: Obj, schemas: unknown[]): DataContractLintFinding[] {
  const out: DataContractLintFinding[] = [];
  const add = (path: string, message: string) => out.length < MAX_FIELD_PROBLEMS && out.push(problem(message, path));
  const unique = (items: unknown[], key: string, what: string, base: string) => {
    const seen = new Set<string>();
    items.forEach((x, i) => {
      const n = isObj(x) ? str(x[key]) : null;
      if (n === null) return;
      if (seen.has(n)) add(`${base}/${i}/${key}`, `Two ${what} are named "${n.slice(0, 100)}" – names must be unique`);
      seen.add(n);
    });
  };
  if (Array.isArray(raw.servers)) unique(raw.servers, 'server', 'servers', '/servers');
  unique(schemas, 'name', 'schema objects', '/schema');
  const quality = (v: unknown, base: string) => {
    if (!Array.isArray(v)) return;
    v.forEach((q, i) => {
      if (!isObj(q)) return;
      for (const k of NUMERIC_THRESHOLDS)
        if (q[k] !== undefined && !(typeof q[k] === 'number' && Number.isFinite(q[k]))) add(`${base}/${i}/${k}`, `${k} must be a number`);
      for (const k of ['mustBeBetween', 'mustNotBeBetween'])
        if (q[k] !== undefined && !(Array.isArray(q[k]) && q[k].length === 2 && q[k].every((n) => typeof n === 'number' && Number.isFinite(n))))
          add(`${base}/${i}/${k}`, `${k} must be two numbers`);
    });
  };
  let properties = 0;
  const stack: [unknown, string][] = schemas.map((s, i) => [s, `/schema/${i}`]);
  while (stack.length && out.length < MAX_FIELD_PROBLEMS) {
    const [x, at] = stack.pop()!;
    if (!isObj(x)) continue;
    quality(x.quality, `${at}/quality`);
    if (isObj(x.items)) stack.push([x.items, `${at}/items`]);
    if (!Array.isArray(x.properties)) continue;
    properties += x.properties.length;
    if (properties > L.properties) return [problem(`More than ${L.properties} properties`, '/schema')];
    unique(x.properties, 'name', 'properties on one level', `${at}/properties`);
    x.properties.forEach((p, i) => {
      if (!isObj(p)) return;
      const here = `${at}/properties/${i}`;
      for (const k of FLAGS) if (p[k] !== undefined && typeof p[k] !== 'boolean') add(`${here}/${k}`, `${k} must be true or false`);
      const o = p.logicalTypeOptions;
      if (isObj(o))
        for (const k of NUMERIC_OPTIONS)
          if (o[k] !== undefined && !(typeof o[k] === 'number' && Number.isFinite(o[k]))) add(`${here}/logicalTypeOptions/${k}`, `${k} must be a number`);
      stack.push([p, here]);
    });
  }
  return out;
}

// ---------- the JSON Schema check ----------

let validators: { first: ValidateFunction; all: ValidateFunction } | null = null;

/**
 * The official JSON Schema of ODCS v3.0.2, compiled once – twice: `first` stops at the first error (linear, for the
 * whole document), `all` collects every error (Ajv's allErrors is slow on long lists of failing items, so it only sees
 * a copy with lists cut to LINT_ITEMS, see lintContract).
 */
function odcsValidators(): { first: ValidateFunction; all: ValidateFunction } {
  if (validators) return validators;
  const schema = JSON.parse(readAsset('odcs/odcs-json-schema-v3.0.2.json').toString('utf8')) as Obj;
  const compile = (allErrors: boolean) => {
    const ajv = new Ajv2019({ allErrors, strict: false, validateFormats: true });
    // the three formats the schema uses, checked without regular expressions over the value
    ajv.addFormat('date', { type: 'string', validate: (s: string) => isDate(s) });
    ajv.addFormat('date-time', {
      type: 'string',
      validate: (s: string) => s.length >= 20 && s.length <= 40 && isDate(s.slice(0, 10)) && s[10]?.toUpperCase() === 'T' && !Number.isNaN(Date.parse(s)),
    });
    ajv.addFormat('uri', { type: 'string', validate: (s: string) => s.length <= 4096 && URL.canParse(s) });
    return ajv.compile(schema);
  };
  validators = { first: compile(false), all: compile(true) };
  return validators;
}

/** Items of each list the full check looks at (the check that stops at the first error sees all of them). */
const LINT_ITEMS = 500;

/** A copy with every list cut to `max` items (documents are at most L.depth deep: checked when read). */
function cutLists(v: unknown, max: number, depth = 0): { value: unknown; cut: boolean } {
  if (v === null || typeof v !== 'object' || depth > L.depth + 1) return { value: v, cut: false };
  let cut = false;
  if (Array.isArray(v)) {
    if (v.length > max) cut = true;
    const value = v.slice(0, max).map((x) => {
      const c = cutLists(x, max, depth + 1);
      cut ||= c.cut;
      return c.value;
    });
    return { value, cut };
  }
  const value = Object.fromEntries(
    Object.entries(v).map(([k, x]) => {
      const c = cutLists(x, max, depth + 1);
      cut ||= c.cut;
      return [k, c.value];
    }),
  );
  return { value, cut };
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
  const { first, all } = odcsValidators();
  if (first(doc)) return [];
  const sample = cutLists(doc, LINT_ITEMS);
  all(sample.value);
  const seen = new Set<string>();
  const out: DataContractLintFinding[] = [];
  // "must match then schema" only repeats the errors of the branch; and a field that fails its own check is no longer
  // "evaluated", so the schema also calls every sibling unknown – only real unknown fields are kept
  const errors = [...(all.errors ?? []), ...(first.errors ?? [])].filter((e) => e.keyword !== 'if' && e.keyword !== 'allOf');
  // every path that fails a check, and every path above one: an "unevaluated" error there is only the echo (linear –
  // a path has at most `depth` levels)
  const failing = new Set<string>();
  for (const e of errors) {
    if (e.keyword === 'unevaluatedProperties') continue;
    let p = e.instancePath;
    while (!failing.has(p)) {
      failing.add(p);
      if (!p) break;
      p = p.slice(0, p.lastIndexOf('/'));
    }
  }
  for (const e of errors) {
    if (e.keyword === 'unevaluatedProperties' && failing.has(e.instancePath)) continue;
    const f: DataContractLintFinding = { path: e.instancePath || '/', message: errorText(e), severity: 'error', source: 'schema' };
    const k = `${f.path}|${f.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
    if (out.length >= L.lintFindings) break;
  }
  if (sample.cut && out.length < L.lintFindings)
    out.push({
      path: '/',
      message: `Lists longer than ${LINT_ITEMS} items: only their first ${LINT_ITEMS} items are listed here`,
      severity: 'info',
      source: 'schema',
    });
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
