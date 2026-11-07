import { DATA_CONTRACT_LIMITS, type DataContractBreakingReason, type DataContractChange, type DataContractChangeKind, type DataContractDiff } from '@sm/shared';
import { isObj, str, type OdcsDoc } from './odcs.js';

/**
 * Changes between two versions of an ODCS v3 contract (#221, docs/DATA-CONTRACTS.md#breaking-changes), seen from a
 * consumer: what the data promised before and no longer promises – a schema object or a field removed, a type changed
 * or narrowed, a field that becomes required (or a new required field), a field that becomes unique, a quality rule
 * added or tightened – is breaking. Additions of optional fields, loosened rules, removed rules, new servers, a new
 * status or version number are listed but do not break consumers.
 *
 * Schema objects are matched by name, properties by their path (customer.address.city), quality rules by their `id`,
 * else their `name`, else their type and rule (or metric). SQL rules whose query changed are listed as changed: Steward
 * cannot judge SQL. Everything here is plain string and number work – no regular expressions over the document.
 */

type Obj = Record<string, unknown>;

const short = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
};

class Collector {
  readonly changes: DataContractChange[] = [];
  total = 0;
  breaking = 0;
  add(
    kind: DataContractChangeKind,
    where: { schema?: string; field?: string; rule?: string },
    before: unknown,
    after: unknown,
    reason?: DataContractBreakingReason,
  ) {
    this.total++;
    if (reason) this.breaking++;
    if (this.changes.length >= DATA_CONTRACT_LIMITS.changes) return;
    const c: DataContractChange = { kind, ...where, breaking: !!reason };
    if (before !== undefined) c.before = short(before);
    if (after !== undefined) c.after = short(after);
    if (reason) c.reason = reason;
    this.changes.push(c);
  }
}

const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const byName = (items: Obj[], key = 'name'): Map<string, Obj> => {
  const m = new Map<string, Obj>();
  for (const x of items) {
    const n = str(x[key]);
    if (n && !m.has(n)) m.set(n, x);
  }
  return m;
};

/**
 * Properties of a schema object by path, all levels (array items' properties belong to the array's path), with the
 * path of each one's parent property ('' on the top level).
 */
function propertiesByPath(schemaObject: Obj): { props: Map<string, Obj>; parent: Map<string, string> } {
  const props = new Map<string, Obj>();
  const parent = new Map<string, string>();
  const stack: [Obj, string][] = [[schemaObject, '']];
  while (stack.length && props.size < DATA_CONTRACT_LIMITS.properties) {
    const [x, prefix] = stack.pop()!;
    for (const p of list(x.properties)) {
      const name = str(p.name);
      if (!name) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      if (props.has(path)) continue;
      props.set(path, p);
      parent.set(path, prefix);
      stack.push([p, path]);
      if (isObj(p.items)) stack.push([p.items, path]);
    }
  }
  return { props, parent };
}

/** Whether a parent property of `path` (any level) is in `set` – a walk up the parents, at most the nesting depth. */
function hasAncestorIn(path: string, parent: Map<string, string>, set: Set<string>): boolean {
  for (let p = parent.get(path); p; p = parent.get(p)) if (set.has(p)) return true;
  return false;
}

// ---------- types ----------

/** Physical types that hold more than the one before them (case-insensitive) */
const WIDER: string[][] = [
  ['tinyint', 'smallint', 'int2', 'integer', 'int', 'int4', 'mediumint', 'bigint', 'int8'],
  ['real', 'float4', 'float', 'double', 'double precision', 'float8'],
  ['char', 'character', 'varchar', 'character varying', 'nvarchar', 'text', 'string'],
  ['date', 'timestamp', 'datetime', 'timestamp with time zone', 'timestamptz'],
];
const rankOf = (base: string): [number, number] | null => {
  for (let g = 0; g < WIDER.length; g++) {
    const i = WIDER[g]!.indexOf(base);
    if (i >= 0) return [g, i];
  }
  return null;
};

/** "numeric(10,2)" → { base: 'numeric', args: [10, 2] } (no arguments: []) */
function parsePhysical(t: string): { base: string; args: number[] } {
  const s = t.trim().toLowerCase();
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < open) return { base: s, args: [] };
  const args = s
    .slice(open + 1, close)
    .split(',')
    .map((x) => Number(x.trim()));
  return {
    base: `${s.slice(0, open).trim()}${s.slice(close + 1).trim() ? ` ${s.slice(close + 1).trim()}` : ''}`,
    args: args.every(Number.isFinite) ? args : [],
  };
}

/** How a physical type changed: wider, narrower, or different. */
export function comparePhysical(before: string, after: string): 'same' | 'wider' | 'narrower' | 'changed' {
  const a = parsePhysical(before);
  const b = parsePhysical(after);
  if (a.base === b.base) {
    if (a.args.length !== b.args.length)
      return b.args.length === 0 && (a.base.includes('char') || a.base === 'numeric' || a.base === 'decimal') ? 'wider' : 'changed';
    const up = a.args.some((x, i) => b.args[i]! > x);
    const down = a.args.some((x, i) => b.args[i]! < x);
    return up && !down ? 'wider' : down && !up ? 'narrower' : up && down ? 'changed' : 'same';
  }
  const ra = rankOf(a.base);
  const rb = rankOf(b.base);
  if (ra && rb && ra[0] === rb[0]) {
    if (rb[1] === ra[1]) return 'same';
    // a length on the wider type (varchar(10) → text is wider; char(200) → varchar(10) may not be)
    if (rb[1] > ra[1]) return b.args.length && a.args.length && b.args[0]! < a.args[0]! ? 'changed' : 'wider';
    return 'narrower';
  }
  return 'changed';
}

const UPPER = ['maxLength', 'maxItems', 'maximum', 'exclusiveMaximum', 'maxProperties'];
const LOWER = ['minLength', 'minItems', 'minimum', 'exclusiveMinimum', 'minProperties'];

function compareOptions(c: Collector, where: { schema: string; field: string }, a: Obj, b: Obj): void {
  for (const k of [...UPPER, ...LOWER]) {
    const x = typeof a[k] === 'number' ? (a[k] as number) : undefined;
    const y = typeof b[k] === 'number' ? (b[k] as number) : undefined;
    if (x === y) continue;
    const upper = UPPER.includes(k);
    const narrower = x === undefined ? true : y === undefined ? false : upper ? y < x : y > x;
    if (narrower) c.add('type-narrowed', where, `${k}: ${x ?? '–'}`, `${k}: ${y ?? '–'}`, 'typeNarrowed');
    else c.add('type-widened', where, `${k}: ${x ?? '–'}`, `${k}: ${y ?? '–'}`);
  }
  // a pattern or format is a promise about every value: a new or other one narrows, none widens
  for (const k of ['pattern', 'format']) {
    const x = str(a[k]);
    const y = str(b[k]);
    if (x === y) continue;
    if (y === null) c.add('type-widened', where, `${k}: ${x}`, `${k}: –`);
    else
      c.add(
        k === 'format' && x !== null ? 'type-changed' : 'type-narrowed',
        where,
        x === null ? null : `${k}: ${x}`,
        `${k}: ${y}`,
        k === 'format' && x !== null ? 'typeChanged' : 'typeNarrowed',
      );
  }
}

function compareProperty(c: Collector, schema: string, field: string, a: Obj, b: Obj): void {
  const where = { schema, field };
  // another column behind the same name: consumers read other data
  if (str(a.physicalName) !== str(b.physicalName)) c.add('physical-name-changed', where, str(a.physicalName), str(b.physicalName), 'physicalNameChanged');
  const la = str(a.logicalType);
  const lb = str(b.logicalType);
  if (la !== lb) {
    if (la === 'integer' && lb === 'number') c.add('type-widened', where, la, lb);
    else if (la === null) c.add('type-narrowed', where, null, lb, 'typeNarrowed');
    else if (lb === null) c.add('type-widened', where, la, null);
    else c.add('type-changed', where, la, lb, 'typeChanged');
  }
  const pa = str(a.physicalType);
  const pb = str(b.physicalType);
  if (pa !== pb) {
    if (pa === null) c.add('type-narrowed', where, null, pb, 'typeNarrowed');
    else if (pb === null) c.add('type-widened', where, pa, null);
    else {
      const how = comparePhysical(pa, pb);
      if (how === 'wider') c.add('type-widened', where, pa, pb);
      else if (how === 'narrower') c.add('type-narrowed', where, pa, pb, 'typeNarrowed');
      else if (how === 'changed') c.add('type-changed', where, pa, pb, 'typeChanged');
    }
  }
  compareOptions(c, where, isObj(a.logicalTypeOptions) ? a.logicalTypeOptions : {}, isObj(b.logicalTypeOptions) ? b.logicalTypeOptions : {});
  if (!a.required && b.required === true) c.add('required-added', where, false, true, 'requiredAdded');
  if (a.required === true && !b.required) c.add('required-removed', where, true, false);
  if (!a.unique && b.unique === true) c.add('unique-added', where, false, true, 'uniqueAdded');
  if (a.unique === true && !b.unique) c.add('unique-removed', where, true, false);
  compareQuality(c, schema, field, a.quality, b.quality);
}

// ---------- quality rules ----------

function ruleKey(q: Obj): string {
  return str(q.id) ?? str(q.name) ?? `${str(q.type) ?? 'library'}:${str(q.rule) ?? str(q.metric) ?? str(q.query) ?? str(q.description) ?? ''}`;
}

/** Rules by key; rules with the same key are numbered (#2, #3 …) – a counter per key, so many alike stay linear. */
function rulesByKey(v: unknown): Map<string, Obj> {
  const m = new Map<string, Obj>();
  const next = new Map<string, number>();
  for (const q of list(v)) {
    const base = ruleKey(q);
    let k = base;
    if (m.has(k)) {
      let i = next.get(base) ?? 2;
      for (k = `${base} #${i}`; m.has(k); i++) k = `${base} #${i + 1}`;
      next.set(base, i + 1);
    }
    m.set(k, q);
  }
  return m;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** A threshold that is set but not a number (refused on save since 0.9.0): judged as changed, never as loosened */
const odd = (v: unknown): boolean => v !== undefined && num(v) === undefined;
const pair = (v: unknown): [number, number] | undefined =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' ? [Math.min(v[0], v[1]), Math.max(v[0], v[1])] : undefined;

/** tighter / looser / changed / same, for the thresholds of one rule */
function compareThresholds(a: Obj, b: Obj): 'same' | 'tighter' | 'looser' | 'changed' {
  let tighter = false;
  let looser = false;
  const bound = (keys: string[], upper: boolean) => {
    for (const k of keys) {
      if (odd(a[k]) || odd(b[k])) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) tighter = looser = true;
        continue;
      }
      const x = num(a[k]);
      const y = num(b[k]);
      if (x === y) continue;
      if (x === undefined) tighter = true;
      else if (y === undefined) looser = true;
      else if (upper ? y < x : y > x) tighter = true;
      else looser = true;
    }
  };
  bound(['mustBeLessThan', 'mustBeLessOrEqualTo'], true);
  bound(['mustBeGreaterThan', 'mustBeGreaterOrEqualTo'], false);
  const ba = pair(a.mustBeBetween);
  const bb = pair(b.mustBeBetween);
  if (ba || bb) {
    if (!ba) tighter = true;
    else if (!bb) looser = true;
    else {
      if (bb[0] > ba[0] || bb[1] < ba[1]) tighter = true;
      if (bb[0] < ba[0] || bb[1] > ba[1]) looser = true;
    }
  }
  const na = pair(a.mustNotBeBetween);
  const nb = pair(b.mustNotBeBetween);
  if (na || nb) {
    if (!na) tighter = true;
    else if (!nb) looser = true;
    else {
      if (nb[0] < na[0] || nb[1] > na[1]) tighter = true;
      if (nb[0] > na[0] || nb[1] < na[1]) looser = true;
    }
  }
  for (const k of ['mustBe', 'mustNotBe']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) tighter = true;
  if (tighter && looser) return 'changed';
  return tighter ? 'tighter' : looser ? 'looser' : 'same';
}

const thresholdText = (q: Obj): string =>
  ['mustBe', 'mustNotBe', 'mustBeLessThan', 'mustBeLessOrEqualTo', 'mustBeGreaterThan', 'mustBeGreaterOrEqualTo', 'mustBeBetween', 'mustNotBeBetween']
    .filter((k) => q[k] !== undefined)
    .map((k) => `${k} ${JSON.stringify(q[k])}`)
    .join(', ');

function compareQuality(c: Collector, schema: string, field: string | undefined, va: unknown, vb: unknown): void {
  const a = rulesByKey(va);
  const b = rulesByKey(vb);
  for (const [k, q] of a) if (!b.has(k)) c.add('quality-removed', { schema, field, rule: k }, thresholdText(q) || null, null);
  for (const [k, q] of b) {
    const before = a.get(k);
    if (!before) {
      // a new rule is a new promise; a rule of type text promises nothing a test can check
      const text = str(q.type) === 'text';
      c.add('quality-added', { schema, field, rule: k }, null, thresholdText(q) || str(q.type) || null, text ? undefined : 'qualityAdded');
      continue;
    }
    const how = compareThresholds(before, q);
    if (how === 'tighter') c.add('quality-tightened', { schema, field, rule: k }, thresholdText(before), thresholdText(q), 'qualityTightened');
    else if (how === 'looser') c.add('quality-loosened', { schema, field, rule: k }, thresholdText(before), thresholdText(q));
    else if (how === 'changed') c.add('quality-changed', { schema, field, rule: k }, thresholdText(before), thresholdText(q), 'qualityTightened');
    else if (str(before.query) !== str(q.query) || str(before.rule) !== str(q.rule) || str(before.metric) !== str(q.metric))
      c.add(
        'quality-changed',
        { schema, field, rule: k },
        str(before.query) ?? str(before.rule) ?? str(before.metric),
        str(q.query) ?? str(q.rule) ?? str(q.metric),
      );
  }
}

// ---------- the whole contract ----------

/** What says where a server's data is (ODCS v3 server fields) */
const SERVER_FIELDS = ['type', 'host', 'port', 'database', 'schema', 'catalog', 'project', 'dataset', 'account', 'location', 'path', 'topic'];

export function diffContracts(a: OdcsDoc, b: OdcsDoc): DataContractDiff {
  const c = new Collector();
  if (str(a.version) !== str(b.version)) c.add('version-changed', {}, str(a.version), str(b.version));
  if (str(a.status) !== str(b.status)) c.add('status-changed', {}, str(a.status), str(b.status));
  const sa = byName(list(a.servers), 'server');
  const sb = byName(list(b.servers), 'server');
  for (const [name, s] of sa) if (!sb.has(name)) c.add('server-removed', { field: name }, str(s.type), null);
  for (const [name, s] of sb) {
    const before = sa.get(name);
    if (!before) {
      c.add('server-added', { field: name }, null, str(s.type));
      continue;
    }
    // the same server name pointing elsewhere: consumers find the data somewhere else
    const moved = SERVER_FIELDS.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(s[k] ?? null));
    if (moved.length)
      c.add(
        'server-changed',
        { field: name },
        moved.map((k) => `${k}: ${short(before[k]) ?? '–'}`).join(', '),
        moved.map((k) => `${k}: ${short(s[k]) ?? '–'}`).join(', '),
        'serverChanged',
      );
  }
  const oa = byName(list(a.schema));
  const ob = byName(list(b.schema));
  for (const name of oa.keys()) if (!ob.has(name)) c.add('schema-removed', { schema: name }, name, null, 'schemaRemoved');
  for (const name of ob.keys()) if (!oa.has(name)) c.add('schema-added', { schema: name }, null, name);
  for (const [name, before] of oa) {
    const after = ob.get(name);
    if (!after) continue;
    if (str(before.physicalName) !== str(after.physicalName))
      c.add('physical-name-changed', { schema: name }, str(before.physicalName), str(after.physicalName), 'physicalNameChanged');
    compareQuality(c, name, undefined, before.quality, after.quality);
    const { props: pa, parent: parentA } = propertiesByPath(before);
    const { props: pb, parent: parentB } = propertiesByPath(after);
    const removed = new Set([...pa.keys()].filter((p) => !pb.has(p)));
    // a removed parent says it all: its children are not listed again
    for (const p of [...removed].sort())
      if (!hasAncestorIn(p, parentA, removed)) c.add('field-removed', { schema: name, field: p }, str(pa.get(p)!.logicalType), null, 'fieldRemoved');
    const added = new Set([...pb.keys()].filter((p) => !pa.has(p)));
    for (const p of [...added].sort()) {
      if (hasAncestorIn(p, parentB, added)) continue;
      const prop = pb.get(p)!;
      c.add('field-added', { schema: name, field: p }, null, str(prop.logicalType), prop.required === true ? 'requiredAdded' : undefined);
    }
    for (const p of [...pa.keys()].filter((x) => pb.has(x)).sort()) compareProperty(c, name, p, pa.get(p)!, pb.get(p)!);
  }
  return { changes: c.changes, total: c.total, breaking: c.breaking };
}
