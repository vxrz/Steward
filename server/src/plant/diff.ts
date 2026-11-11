import { PLANT_DIFF_LIMITS, type PlantFieldDiff } from '@sm/shared';

/**
 * Field-level differences of an entry an import changes (0.12.0): what the preview and an assistant's proposal show
 * for a changed entry – `interfaces[opc].groups[State].dataPoints[run].description: "…" → "…"`. Lists of entries are
 * compared by their id (or interface, data point, name …), other values as they are. Values are cut to a readable
 * size; an entry shows at most PLANT_DIFF_LIMITS.perEntry differences.
 */

const KEYS = ['id', 'interface', 'dataPoint', 'job', 'name', 'key', 'cidr', 'start', 'item', 'address'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A value cut to a readable size (long text, long lists, deep nesting). */
export const cutValue = (v: unknown): unknown => cut(v);
function cut(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > PLANT_DIFF_LIMITS.text ? `${v.slice(0, PLANT_DIFF_LIMITS.text)}…` : v;
  if (v === undefined) return null;
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 3) return '…';
  if (Array.isArray(v)) {
    const out = v.slice(0, PLANT_DIFF_LIMITS.list).map((x) => cut(x, depth + 1));
    if (v.length > PLANT_DIFF_LIMITS.list) out.push(`… ${v.length - PLANT_DIFF_LIMITS.list} more`);
    return out;
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x, depth + 1)]));
}

/** The key the entries of a list are matched by, when every entry has one and no two the same. */
function listKey(a: unknown[], b: unknown[]): (typeof KEYS)[number] | null {
  const all = [...a, ...b];
  if (!all.length || !all.every(isObj)) return null;
  for (const k of KEYS) {
    if (!all.every((x) => typeof x[k] === 'string')) continue;
    const unique = (l: unknown[]) => new Set(l.map((x) => (x as Record<string, unknown>)[k])).size === l.length;
    if (unique(a) && unique(b)) return k;
  }
  return null;
}

function walk(before: unknown, after: unknown, path: string, out: PlantFieldDiff[]): void {
  if (out.length >= PLANT_DIFF_LIMITS.perEntry || same(before, after)) return;
  if (isObj(before) && isObj(after)) {
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])]) walk(before[k], after[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const k = listKey(before, after);
    if (k) {
      const by = (l: unknown[]) => new Map(l.map((x) => [(x as Record<string, string>)[k]!, x]));
      const b = by(before);
      const a = by(after);
      for (const id of [...new Set([...b.keys(), ...a.keys()])]) walk(b.get(id) ?? null, a.get(id) ?? null, `${path}[${id}]`, out);
      return;
    }
  }
  out.push({ path: path || '(entry)', before: cut(before), after: cut(after) });
}

/** The differences between an entry's stored values and the values an import writes. */
export function fieldDiff(before: object, after: object): PlantFieldDiff[] {
  const out: PlantFieldDiff[] = [];
  walk(before, after, '', out);
  return out;
}

/**
 * Items a change drops from a list inside an entry (0.12.0: an assistant's proposal may not): an entry of a list of
 * entries whose id is gone, a value of a list of values that is gone, or – a list of entries without ids – a shorter
 * list. Changed fields of an item that stays are no drop. Paths as in `fieldDiff`; at most `max` of them.
 */
export function droppedItems(before: unknown, after: unknown, max = 20): string[] {
  const out: string[] = [];
  const go = (b: unknown, a: unknown, path: string) => {
    if (out.length >= max || same(b, a)) return;
    if (Array.isArray(b)) {
      if (!b.length) return;
      const list = Array.isArray(a) ? a : [];
      const k = listKey(b, list);
      if (k) {
        const now = new Map(list.map((x) => [(x as Record<string, string>)[k]!, x]));
        for (const x of b) {
          const id = (x as Record<string, string>)[k]!;
          if (!now.has(id)) out.push(`${path}[${id}]`);
          else go(x, now.get(id), `${path}[${id}]`);
          if (out.length >= max) return;
        }
        return;
      }
      if (b.every((x) => x === null || typeof x !== 'object')) {
        const now = new Set(list.map((x) => JSON.stringify(x)));
        for (const x of b) if (!now.has(JSON.stringify(x)) && out.length < max) out.push(`${path}: ${String(x).slice(0, PLANT_DIFF_LIMITS.text)}`);
        return;
      }
      if (list.length < b.length) out.push(`${path} (${b.length} → ${list.length})`);
      return;
    }
    if (isObj(b)) {
      const o = isObj(a) ? a : {};
      for (const key of Object.keys(b)) go(b[key], o[key], path ? `${path}.${key}` : key);
    }
  };
  go(before, after, '');
  return out;
}
