/**
 * Vega-Lite widgets (#120): what a spec may contain. The chart only ever shows the widget's dataset, so a spec may
 * not load anything (no `url`), carry its own data, or link anywhere (no `href`). Expressions are evaluated by an
 * interpreter in the browser, never compiled to code, so the Content Security Policy stays without `unsafe-eval`.
 */

/** The name under which the dataset's rows reach the chart (`data: { name: "dataset" }`). */
export const VEGA_DATA_NAME = 'dataset';

export const VEGA_LIMITS = {
  /** Size of the spec as JSON */
  bytes: 64_000,
  /** Nesting depth of the spec */
  depth: 40,
  /** Rows handed to the chart */
  rows: 5000,
} as const;

/** Keys that load or link to something outside the dataset, anywhere in the spec. */
const FORBIDDEN_KEYS = new Set(['url', 'href', 'datasets', 'loader']);

/** Why a spec is not allowed, or null. Paths are given like `layer.1.encoding.href`. */
export function vegaSpecProblem(spec: unknown): string | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return 'The spec must be a Vega-Lite object';
  let json: string;
  try {
    json = JSON.stringify(spec);
  } catch {
    return 'The spec must be plain JSON';
  }
  if (json.length > VEGA_LIMITS.bytes) return `The spec is larger than ${VEGA_LIMITS.bytes / 1000} kB`;
  const schema = (spec as Record<string, unknown>).$schema;
  if (schema !== undefined && (typeof schema !== 'string' || !schema.includes('vega-lite'))) return 'Only Vega-Lite specs are supported, not Vega';
  return walk(spec, [], 0);
}

function walk(v: unknown, path: (string | number)[], depth: number): string | null {
  if (depth > VEGA_LIMITS.depth) return `The spec is nested deeper than ${VEGA_LIMITS.depth} levels`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = walk(v[i], [...path, i], depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  for (const [k, child] of Object.entries(v)) {
    const at = [...path, k].join('.');
    if (FORBIDDEN_KEYS.has(k)) return `${at}: the chart shows the widget's dataset only – loading data or links are not allowed`;
    if (k === 'data' && child != null) {
      // only references to the dataset by name: { name: "dataset" }
      const keys = typeof child === 'object' && !Array.isArray(child) ? Object.keys(child) : null;
      const name = keys && (child as Record<string, unknown>).name;
      if (!keys || keys.some((x) => x !== 'name') || typeof name !== 'string')
        return `${at}: data comes from the widget's dataset; leave "data" out or write { name: "${VEGA_DATA_NAME}" }`;
      continue;
    }
    const p = walk(child, [...path, k], depth + 1);
    if (p) return p;
  }
  return null;
}

/** Fields the spec's encodings use, for the table next to the chart (accessibility). */
export function vegaSpecFields(spec: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, inEncoding: boolean, depth: number) => {
    if (depth > VEGA_LIMITS.depth || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, inEncoding, depth + 1));
    for (const [k, child] of Object.entries(v)) {
      if (inEncoding && k === 'field' && typeof child === 'string') out.add(child.split('.')[0].replace(/\\/g, ''));
      else visit(child, inEncoding || k === 'encoding', depth + 1);
    }
  };
  visit(spec, false, 0);
  return [...out];
}

/** A starting point for new widgets: a bar chart of rows per status. */
export const VEGA_EXAMPLE_SPEC: Record<string, unknown> = {
  mark: 'bar',
  encoding: {
    x: { field: '_status', type: 'nominal', title: 'Status', sort: ['good', 'warning', 'serious', 'critical', 'unknown'] },
    y: { aggregate: 'count', type: 'quantitative', title: 'Rows' },
    color: {
      field: '_status',
      type: 'nominal',
      scale: { domain: ['good', 'warning', 'serious', 'critical', 'unknown'], scheme: 'steward-status' },
      legend: null,
    },
  },
};
