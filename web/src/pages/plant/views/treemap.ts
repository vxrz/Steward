/** A rectangle of a treemap. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The squarified treemap layout (Bruls, Huizing, van Wijk 2000): items become rectangles whose areas follow their
 * values and whose sides stay as close to squares as the order allows. Items keep the given order within a row.
 */
export function squarify<T extends { value: number }>(items: T[], box: Rect): (T & { rect: Rect })[] {
  const list = items.filter((i) => i.value > 0);
  const total = list.reduce((a, i) => a + i.value, 0);
  if (!total || box.w <= 0 || box.h <= 0) return [];
  const scale = (box.w * box.h) / total;
  const rest = [...list].sort((a, b) => b.value - a.value).map((item) => ({ item, area: item.value * scale }));
  const out: (T & { rect: Rect })[] = [];
  let { x, y, w, h } = box;
  const worst = (row: { area: number }[], side: number) => {
    const s = row.reduce((a, r) => a + r.area, 0);
    const max = Math.max(...row.map((r) => r.area));
    const min = Math.min(...row.map((r) => r.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const place = (row: { item: T; area: number }[]) => {
    const s = row.reduce((a, r) => a + r.area, 0);
    if (w >= h) {
      const cw = s / h;
      let cy = y;
      for (const r of row) {
        const rh = r.area / cw;
        out.push({ ...r.item, rect: { x, y: cy, w: cw, h: rh } });
        cy += rh;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = s / w;
      let cx = x;
      for (const r of row) {
        const rw = r.area / rh;
        out.push({ ...r.item, rect: { x: cx, y, w: rw, h: rh } });
        cx += rw;
      }
      y += rh;
      h -= rh;
    }
  };
  let row: { item: T; area: number }[] = [];
  while (rest.length) {
    const side = Math.min(w, h);
    const next = rest[0]!;
    if (!row.length || worst([...row, next], side) <= worst(row, side)) {
      row.push(next);
      rest.shift();
    } else {
      place(row);
      row = [];
    }
  }
  if (row.length) place(row);
  return out;
}

/** A rectangle with a gap around it (the space between tiles). */
export const inset = (r: Rect, d: number): Rect => ({ x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) });
