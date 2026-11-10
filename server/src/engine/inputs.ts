import { parseTableCsv, type InputDef } from '@sm/shared';
import { HttpError } from '../util.js';
import { applicationInputValue, applicationsInputValue } from '../catalogue/components.js';

/** A run's inputs: coerced to their declared types when the run starts (undeclared inputs are left out). */

/** `lenient`: a missing required input is left empty (a single-node debug run needs only what its node reads). */
export function coerceInputs(defs: InputDef[], raw: Record<string, unknown>, lenient = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    let v = raw[d.name];
    if (v === undefined || v === '' || v === null) v = d.default;
    if (v === undefined || v === '' || v === null) {
      if (d.required && !lenient) throw new HttpError(400, `Input "${d.label ?? d.name}" is required`);
      // applications: empty means every application that is not archived
      out[d.name] =
        d.type === 'applications'
          ? applicationsInputValue([], d.label ?? d.name)
          : d.type === 'list' || d.type === 'table'
            ? []
            : d.type === 'boolean'
              ? false
              : null;
      continue;
    }
    switch (d.type) {
      case 'number': {
        const n = Number(v);
        if (Number.isNaN(n)) throw new HttpError(400, `Input "${d.name}" must be a number`);
        out[d.name] = n;
        break;
      }
      case 'boolean':
        out[d.name] = v === true || v === 'true' || v === '1' || v === 1 || v === 'yes';
        break;
      case 'select':
        if (d.options?.length && !d.options.includes(String(v))) throw new HttpError(400, `Input "${d.name}" must be one of ${d.options.join(', ')}`);
        out[d.name] = String(v);
        break;
      case 'list':
        out[d.name] = Array.isArray(v)
          ? v.map(String)
          : String(v)
              .split(/[\n,;]/)
              .map((s) => s.trim())
              .filter(Boolean);
        break;
      case 'table': {
        const rows = Array.isArray(v) ? v : parseTableCsv(String(v), d.columns);
        // a required table with nothing in it would run with no rows ("Onboard 0 user(s)?"): refused at start
        if (d.required && !lenient && !rows.length)
          throw new HttpError(400, `${d.label ?? d.name} has no rows`, 'INPUT_TABLE_EMPTY', { input: d.label ?? d.name });
        out[d.name] = rows;
        break;
      }
      case 'application':
        out[d.name] = applicationInputValue(v, d.label ?? d.name);
        break;
      case 'applications':
        out[d.name] = applicationsInputValue(v, d.label ?? d.name);
        break;
      case 'json':
        if (typeof v === 'string') {
          try {
            out[d.name] = JSON.parse(v);
          } catch {
            throw new HttpError(400, `Input "${d.name}" must be valid JSON`);
          }
        } else out[d.name] = v;
        break;
      default:
        out[d.name] = String(v);
    }
  }
  // keep undeclared inputs out of the run to keep it reproducible
  return out;
}

/** CSV text as rows (the header row, or the declared columns when the first line names none of them). */
export const parseCsv = (text: string, columns?: string[]): Record<string, string>[] => parseTableCsv(text, columns);
