import {
  byDimension,
  CIA_DIMENSIONS,
  levelRank,
  ratingFloor,
  type CiaDimension,
  type DataClassification,
  type DataRating,
  type DataRatingInput,
  type ExposedObject,
  type RatingFloor,
  type RatingFloorDimension,
} from '@sm/shared';
import { db } from '../db.js';
import { checkLevel, currentScale, requireValidScale } from '../catalogue/cia.js';
import { nowIso, parseJson } from '../util.js';
import {
  bindingsOf,
  chunks,
  marks,
  membersOf,
  objectsByIds,
  objectsOfElements,
  portObjectsOf,
  portsOf,
  ratingsOf,
  type BindingWithElements,
  type MemberRow,
  type ObjectRow,
  type PortRow,
  type RatingRow,
} from './store.js';

/**
 * Ratings of data products and data objects (ADR 0036 parts 2 and 3): a CIA rating on the instance's CIA scale with a
 * justification per dimension, stored and re-rated exactly as application ratings (dp_ratings; a change of the scale
 * maps or flags them in catalogue/cia.ts), and the rating floor of a product: per dimension at least the highest
 * rating of the data objects it exposes, and the same for the classification – lower only with a reason, warned,
 * never blocked (decision 8).
 */

type Scale = ReturnType<typeof currentScale>;

function toRating(rows: RatingRow[], scale: Scale): DataRating {
  return byDimension((d) => {
    const r = rows.find((x) => x.dimension === d);
    if (!r) return null;
    return {
      level: r.level,
      justification: r.justification,
      ratedAt: r.rated_at,
      ratedBy: r.rated_by,
      needsRerating: !!r.needs_rerating || levelRank(scale.levels[d], r.level) < 0,
      previousLabel: r.previous_label ?? null,
    };
  });
}

/** The ratings of these items (an item without any: every dimension null). */
export function ratingsByItem(kind: 'product' | 'object', ids: readonly string[], scale: Scale = currentScale()): Map<string, DataRating> {
  const rows = ratingsOf(kind, ids);
  const by = new Map<string, RatingRow[]>();
  for (const r of rows) by.set(r.item_id, [...(by.get(r.item_id) ?? []), r]);
  return new Map(ids.map((id) => [id, toRating(by.get(id) ?? [], scale)]));
}

export const needsRerating = (r: DataRating): boolean => CIA_DIMENSIONS.some((d) => !!r[d]?.needsRerating);

export interface RatingChange {
  dimension: CiaDimension;
  from: string | null;
  to: string | null;
}

/**
 * Writes a rating (per dimension: a level with its justification, null removes it, missing keeps it). Levels must be on
 * the current scale, and the scale must be valid. Returns what changed (for the audit entry); call inside the change's
 * transaction.
 */
export function writeRating(kind: 'product' | 'object', itemId: string, input: DataRatingInput, actor: string): RatingChange[] {
  const scale = currentScale();
  requireValidScale(scale);
  const before = ratingsByItem(kind, [itemId], scale).get(itemId)!;
  const changes: RatingChange[] = [];
  const now = nowIso();
  for (const d of CIA_DIMENSIONS) {
    const v = input[d];
    if (v === undefined) continue;
    const had = before[d];
    if (v === null) {
      if (had) {
        db().run('DELETE FROM dp_ratings WHERE kind = ? AND item_id = ? AND dimension = ?', kind, itemId, d);
        changes.push({ dimension: d, from: had.level, to: null });
      }
      continue;
    }
    checkLevel(d, v.level, scale);
    if (had && had.level === v.level && had.justification === v.justification && !had.needsRerating) continue;
    db().run(
      `INSERT INTO dp_ratings (kind, item_id, dimension, level, justification, rated_at, rated_by, needs_rerating, previous_label) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT (kind, item_id, dimension) DO UPDATE SET level = excluded.level, justification = excluded.justification, rated_at = excluded.rated_at,
         rated_by = excluded.rated_by, needs_rerating = 0, previous_label = NULL`,
      kind,
      itemId,
      d,
      v.level,
      v.justification,
      now,
      actor,
    );
    changes.push({ dimension: d, from: had?.level ?? null, to: v.level });
  }
  return changes;
}

export function deleteRatings(kind: 'product' | 'object', itemId: string): void {
  db().run('DELETE FROM dp_ratings WHERE kind = ? AND item_id = ?', kind, itemId);
}

// ---------- what a product exposes, and its floor ----------

/**
 * What the reads of a product page or scorecard share (0.25.0): the ports, bindings, members, declared objects and the
 * data objects of elements that exposedObjectsOf reads – a caller that needs them too passes the same object and reads
 * each kind once (the statement budgets of dataproducts-perf.test.ts). Each list is of all the products' ports (both
 * directions) and members; `objectElements` covers every bound element and every output member.
 */
export interface ProductReads {
  ports?: PortRow[];
  bindings?: BindingWithElements[];
  members?: MemberRow[];
  portObjects?: { port_id: string; object_id: string }[];
  objectElements?: { object_id: string; element_id: string; note: string }[];
  /** The exposed data objects' rows (floorsOf) */
  objects?: Map<string, ObjectRow>;
}

/**
 * The data objects each product exposes (part 2): declared on its output ports, and implemented by the elements of its
 * output ports' bindings or its output members. In bulk: a fixed number of statements for any number of products;
 * what `reads` holds already is not read again, what is read is left there.
 */
export function exposedObjectsOf(productIds: readonly string[], reads: ProductReads = {}): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(productIds.map((id) => [id, new Set<string>()]));
  if (!productIds.length) return out;
  const ports = (reads.ports ??= portsOf(productIds));
  const outputs = ports.filter((p) => p.direction === 'output');
  const productOfPort = new Map(outputs.map((p) => [p.id, p.product_id]));
  const portIds = ports.map((p) => p.id);
  for (const po of (reads.portObjects ??= portObjectsOf(portIds))) {
    const product = productOfPort.get(po.port_id);
    if (product) out.get(product)?.add(po.object_id);
  }
  const bindings = (reads.bindings ??= bindingsOf(portIds));
  const members = (reads.members ??= membersOf(productIds));
  const elementsOf = new Map<string, Set<string>>();
  const addElement = (productId: string, elementId: string) => {
    const s = elementsOf.get(elementId) ?? new Set<string>();
    s.add(productId);
    elementsOf.set(elementId, s);
  };
  for (const b of bindings) {
    const product = productOfPort.get(b.port_id);
    if (product) for (const e of b.elementIds) addElement(product, e);
  }
  for (const m of members) if (m.role === 'output') addElement(m.product_id, m.element_id);
  // every bound element (the ports' views name the objects of input bindings too) and the output members
  reads.objectElements ??= objectsOfElements([...new Set([...bindings.flatMap((b) => b.elementIds), ...elementsOf.keys()])]);
  for (const oe of reads.objectElements) for (const p of elementsOf.get(oe.element_id) ?? []) out.get(p)?.add(oe.object_id);
  return out;
}

/** The products that expose or process (a member element implements it) these data objects: object → product ids. */
export function productsOfObjects(objectIds: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(objectIds.map((id) => [id, new Set<string>()]));
  for (const part of chunks([...new Set(objectIds)])) {
    for (const r of db().all<{ object_id: string; product_id: string }>(
      `SELECT po.object_id, p.product_id FROM dp_port_objects po JOIN dp_ports p ON p.id = po.port_id WHERE po.object_id IN (${marks(part.length)})
       UNION SELECT oe.object_id, m.product_id FROM dp_object_elements oe JOIN dp_members m ON m.element_id = oe.element_id WHERE oe.object_id IN (${marks(part.length)})`,
      ...part,
      ...part,
    ))
      out.get(r.object_id)?.add(r.product_id);
  }
  return out;
}

/** The rating floor of each product (bulk): its own rating, classification and reasons against its exposed objects. */
export function floorsOf(
  products: readonly { id: string; classification: string | null; rating_reason: string }[],
  ratings: Map<string, DataRating>,
  scale: Scale = currentScale(),
  /** Receives the exposed data objects' rows and what was read to find them (a caller that shows them reads them only once) */
  read?: ProductReads,
): Map<string, RatingFloor & { objectIds: string[] }> {
  const exposed = exposedObjectsOf(
    products.map((p) => p.id),
    read,
  );
  const objectIds = [...new Set([...exposed.values()].flatMap((s) => [...s]))];
  const objects = objectsByIds(objectIds);
  if (read) read.objects = objects;
  const objectRatings = ratingsByItem('object', objectIds, scale);
  const out = new Map<string, RatingFloor & { objectIds: string[] }>();
  for (const p of products) {
    const ids = [...(exposed.get(p.id) ?? [])].filter((id) => objects.has(id));
    const xs: ExposedObject[] = ids.map((id) => ({
      id,
      rating: objectRatings.get(id) ?? {},
      classification: (objects.get(id)!.classification as DataClassification | null) ?? null,
    }));
    const floor = ratingFloor(
      { rating: ratings.get(p.id) ?? {}, classification: (p.classification as DataClassification | null) ?? null },
      xs,
      scale.levels,
      parseJson<Partial<Record<RatingFloorDimension, string>>>(p.rating_reason, {}),
    );
    out.set(p.id, { ...floor, objectIds: ids });
  }
  return out;
}
