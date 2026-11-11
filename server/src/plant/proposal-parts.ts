/**
 * Plant proposals in parts (0.17.0, docs/PLANT.md "Proposals in parts"). A manual with hundreds of data points does not
 * fit into one MCP request, so an assistant sends its document in parts – each a document of the import format by itself
 * – and Steward combines them into one document before the import's preview runs on it.
 *
 * How parts combine, deterministically and in the order they came:
 * - the one-entry keys (`site`, `device_profile`, `assignment` …) count as their lists (`sites`, `device_profiles` …);
 * - objects are merged key by key: a key only a later part gives is added;
 * - a list of entries that all have an id (`id`; `asset`, `site`, `collection` for the entries that name them;
 *   `data_point`, `interface`, `job`, a group's `name` …) is merged entry by entry: an entry of a later part with an id
 *   that is there already is merged into that entry the same way, a new one is appended – so one device profile's
 *   interfaces, groups and data points can be spread over several parts;
 * - a list of plain values (tags, known-as names, a KPI input's data points) gets the values it does not have yet;
 * - the same value twice is fine; two different values for the same place (a data point's unit `kW` in one part and
 *   `W` in another), and a list without ids given differently in two parts, refuse the part – it is not kept.
 *
 * The rules that keep a proposal to adding and changing (never a removal, never a dropped item) apply to the combined
 * document, when the last part has come.
 *
 * Keys are matched as the document's own (Object.hasOwn), never through the prototype – a key such as `toString`
 * combines like any other – and a part with a key `__proto__`, `constructor` or `prototype` anywhere is refused: they
 * name no field of the format and would change how the combined object behaves (security review 0.17.0, L7).
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

/** The one-entry keys of the format and the lists they stand for. */
const LISTS: Record<string, string> = {
  site: 'sites',
  device_profile: 'device_profiles',
  kpi_definition: 'kpi_definitions',
  assignment: 'assignments',
  ot_network: 'ot_networks',
  asset_network: 'asset_networks',
};

/** The keys entries of a list are matched by, in this order (the first one every entry has, without repeats). */
const ITEM_KEYS = ['id', 'asset', 'site', 'collection', 'data_point', 'interface', 'job', 'kpi', 'name', 'output_name', 'key', 'cidr', 'start', 'address'];

/** Keys a part may not have anywhere: they could reach an object's prototype when parts are combined. */
export const REFUSED_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** A part with a key it may not have (REFUSED_KEYS): refused before anything is combined. */
export class PartKeyRefused extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export class PartConflict extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const shown = (v: unknown) => {
  const s = JSON.stringify(v) ?? 'null';
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

/** The key the entries of both lists are matched by: every entry has it as text, no two in a list the same. */
function itemKey(a: Json[], b: Json[]): string | null {
  const all = [...a, ...b];
  if (!all.length || !all.every(isObj)) return null;
  for (const k of ITEM_KEYS) {
    if (!all.every((x) => typeof (x as Obj)[k] === 'string')) continue;
    const unique = (l: Json[]) => new Set(l.map((x) => (x as Obj)[k])).size === l.length;
    if (unique(a) && unique(b)) return k;
  }
  return null;
}

function merge(a: Json, b: Json, path: string, part: number): Json {
  if (same(a, b)) return a;
  if (isObj(a) && isObj(b)) {
    const out: Obj = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = Object.hasOwn(out, k) ? merge(out[k]!, v, path ? `${path}.${k}` : k, part) : v;
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const key = itemKey(a, b);
    if (key) {
      const out = [...a];
      const at = new Map(out.map((x, i) => [(x as Obj)[key] as string, i]));
      for (const x of b) {
        const id = (x as Obj)[key] as string;
        const i = at.get(id);
        if (i === undefined) {
          at.set(id, out.length);
          out.push(x);
        } else out[i] = merge(out[i]!, x, `${path}[${id}]`, part);
      }
      return out;
    }
    if ([...a, ...b].every((x) => x === null || typeof x !== 'object')) {
      const out = [...a];
      for (const x of b) if (!out.some((y) => same(y, x))) out.push(x);
      return out;
    }
    throw new PartConflict(
      path,
      `${path}: part ${part} gives this list differently from an earlier part, and its entries have no ids to combine them by – give the whole list in one part`,
    );
  }
  throw new PartConflict(path, `${path}: part ${part} gives ${shown(b)}, an earlier part ${shown(a)} – give each value once, or the same in every part`);
}

/** A part with its one-entry keys as lists (`device_profile: {…}` → `device_profiles: [{…}]`). */
function normalised(doc: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(doc)) {
    // where an editor finds the schema: no part of the content
    if (k === '$schema') continue;
    const list = Object.hasOwn(LISTS, k) ? LISTS[k] : undefined;
    const had = (key: string) => (Object.hasOwn(out, key) ? (out[key] as Json[]) : []);
    if (list) out[list] = [...had(list), v];
    else if (Object.values(LISTS).includes(k)) out[k] = [...had(k), ...(Array.isArray(v) ? v : [v])];
    else out[k] = v;
  }
  return out;
}

/** Refuses a key of REFUSED_KEYS anywhere in a part (JSON.parse makes `__proto__` an own key). */
function refuseKeys(v: unknown, path: string, part: number): void {
  if (Array.isArray(v)) v.forEach((x, i) => refuseKeys(x, `${path}[${i}]`, part));
  else if (isObj(v))
    for (const k of Object.keys(v)) {
      const at = path ? `${path}.${k}` : k;
      if (REFUSED_KEYS.includes(k))
        throw new PartKeyRefused(at, `${at}: part ${part} has the key "${k}" – no field of the import format is called so; leave it out`);
      refuseKeys(v[k], at, part);
    }
}

/**
 * The parts (documents of the import format, in the order they came) as one document; a conflict throws PartConflict,
 * a key of REFUSED_KEYS PartKeyRefused.
 */
export function combineParts(parts: unknown[]): Obj {
  parts.forEach((p, i) => refuseKeys(p, '', i + 1));
  let out: Json = {};
  parts.forEach((p, i) => {
    out = merge(out, normalised(p as Obj), '', i + 1);
  });
  return out as Obj;
}
