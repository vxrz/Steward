import type { TemplateParam } from '@sm/shared';
import { render } from '../engine/expr.js';
import { HttpError } from '../util.js';

/**
 * Monitor templates: a definition with {{ params.<name> }} placeholders,
 * rendered once when an instance is created (or re-synced). A string that is
 * exactly one placeholder takes the parameter's type (e.g. a port number).
 * Runtime placeholders of outputs (${monitor.key}) are left alone.
 */

export function coerceParams(defs: TemplateParam[], given: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of defs) {
    let v = given[p.name];
    if (v === undefined || v === null || v === '') v = p.default;
    if (v === undefined || v === null || v === '') {
      if (p.required) throw new HttpError(400, `Parameter "${p.label ?? p.name}" is required`, 'TEMPLATE_PARAM_REQUIRED', { name: p.label ?? p.name });
      continue;
    }
    if (p.type === 'number') {
      const n = typeof v === 'number' ? v : Number(String(v).trim());
      if (!Number.isFinite(n))
        throw new HttpError(400, `Parameter "${p.label ?? p.name}" must be a number`, 'TEMPLATE_PARAM_NUMBER', { name: p.label ?? p.name });
      out[p.name] = n;
    } else out[p.name] = String(v);
  }
  const unknown = Object.keys(given).filter((k) => !defs.some((p) => p.name === k) && !['name', 'key'].includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown parameter(s): ${unknown.join(', ')}`, 'TEMPLATE_PARAM_UNKNOWN', { names: unknown });
  return out;
}

/** Example values used to validate a template (defaults, else "example" / 1). */
export function sampleParams(defs: TemplateParam[]): Record<string, unknown> {
  return Object.fromEntries(defs.map((p) => [p.name, p.default ?? (p.type === 'number' ? 1 : 'example')]));
}

export async function renderTemplate(def: Record<string, unknown>, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { parameters: _p, ...rest } = def;
  try {
    return (await render(rest, { params }, {}, { timeoutMs: 1000, maxDepth: 100 })) as Record<string, unknown>;
  } catch (e) {
    throw new HttpError(400, `Template could not be rendered: ${(e as Error).message}`, 'TEMPLATE_RENDER', { detail: (e as Error).message });
  }
}

/** Minimal RFC 4180 CSV (quotes, escaped quotes, CRLF); first line = header. Separator: , or ; (auto). */
export function parseCsv(text: string): Record<string, string>[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  if (rows.length < 2) throw new HttpError(400, 'The CSV needs a header line and at least one row', 'CSV_EMPTY');
  const header = rows[0]!.map((h) => h.trim());
  if (rows.length > 501) throw new HttpError(400, 'At most 500 rows per upload', 'CSV_TOO_MANY_ROWS', { max: 500 });
  return rows.slice(1).map((r, i) => {
    if (r.length > header.length) throw new HttpError(400, `CSV line ${i + 2} has more cells than the header`, 'CSV_TOO_MANY_CELLS', { line: i + 2 });
    return Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()]));
  });
}
