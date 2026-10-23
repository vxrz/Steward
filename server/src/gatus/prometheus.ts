/**
 * A small, defensive parser for the Prometheus text exposition format (0.0.4),
 * as served by Gatus' /metrics (prometheus/client_golang).
 *
 *   # HELP gatus_results_total Number of results per endpoint
 *   # TYPE gatus_results_total counter
 *   gatus_results_total{group="core",key="core_api",name="API",success="true",type="HTTP"} 42
 *
 * Malformed lines are counted and skipped, never thrown. Limits bound the work an
 * unexpected or hostile answer can cause: bytes, lines, samples, labels per sample
 * and label value length.
 */

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
  /** Optional sample timestamp (ms since epoch) */
  timestamp?: number;
}

export interface PromParseResult {
  samples: PromSample[];
  /** # TYPE lines: metric name → counter, gauge, … */
  types: Map<string, string>;
  /** Lines that could not be parsed */
  malformed: number;
  /** A limit was reached; the rest of the input was ignored */
  truncated: boolean;
}

export interface PromParseOptions {
  /** Keep only samples whose metric name passes (others are parsed for syntax but not kept) */
  keep?: (name: string) => boolean;
  maxBytes?: number;
  maxLines?: number;
  maxSamples?: number;
  maxLabels?: number;
  maxLabelValue?: number;
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*/;

export function parsePromValue(s: string): number | null {
  switch (s) {
    case '+Inf':
    case 'Inf':
      return Infinity;
    case '-Inf':
      return -Infinity;
    case 'NaN':
      return NaN;
  }
  // unambiguous (linear): \d+\.?\d* backtracked quadratically on long digit runs
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parses `{a="x",b="y"}` starting at `line[i] === '{'`. Returns the labels and the index after `}`, or null. */
function parseLabels(line: string, i: number, maxLabels: number, maxValue: number): { labels: Record<string, string>; end: number } | null {
  const labels: Record<string, string> = Object.create(null);
  let count = 0;
  i++; // {
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (line[i] === '}') return { labels, end: i + 1 };
    const m = LABEL_NAME.exec(line.slice(i, i + 200));
    if (!m) return null;
    const key = m[0];
    i += key.length;
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (line[i] !== '=') return null;
    i++;
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (line[i] !== '"') return null;
    i++;
    let value = '';
    for (;;) {
      if (i >= line.length) return null;
      const c = line[i]!;
      if (c === '\\') {
        const n = line[i + 1];
        if (n === 'n') value += '\n';
        else if (n === '\\' || n === '"') value += n;
        else return null;
        i += 2;
      } else if (c === '"') {
        i++;
        break;
      } else {
        value += c;
        i++;
      }
      if (value.length > maxValue) return null;
    }
    if (++count > maxLabels) return null;
    if (key in labels) return null; // duplicate label
    labels[key] = value;
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (line[i] === ',') {
      i++;
      continue;
    }
    if (line[i] === '}') return { labels, end: i + 1 };
    return null;
  }
}

export function parsePrometheus(text: string, o: PromParseOptions = {}): PromParseResult {
  const maxBytes = o.maxBytes ?? 8 * 1024 * 1024;
  const maxLines = o.maxLines ?? 200_000;
  const maxSamples = o.maxSamples ?? 100_000;
  const maxLabels = o.maxLabels ?? 32;
  const maxLabelValue = o.maxLabelValue ?? 1024;
  const out: PromParseResult = { samples: [], types: new Map(), malformed: 0, truncated: false };
  let input = text;
  if (input.length > maxBytes) {
    input = input.slice(0, maxBytes);
    // drop the partial last line
    input = input.slice(0, Math.max(0, input.lastIndexOf('\n')));
    out.truncated = true;
  }
  let lines = 0;
  let pos = 0;
  while (pos < input.length) {
    const nl = input.indexOf('\n', pos);
    const raw = input.slice(pos, nl < 0 ? input.length : nl);
    pos = nl < 0 ? input.length : nl + 1;
    if (++lines > maxLines) {
      out.truncated = true;
      break;
    }
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const t = /^#\s*TYPE\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(\w+)\s*$/.exec(trimmed);
      if (t) out.types.set(t[1]!, t[2]!);
      continue; // HELP and other comments
    }
    const nm = NAME.exec(trimmed);
    if (!nm) {
      out.malformed++;
      continue;
    }
    const name = nm[0];
    let i = name.length;
    let labels: Record<string, string> = Object.create(null);
    // blanks may separate the name from the label set
    let j = i;
    while (trimmed[j] === ' ' || trimmed[j] === '\t') j++;
    if (trimmed[j] === '{') i = j;
    if (trimmed[i] === '{') {
      const l = parseLabels(trimmed, i, maxLabels, maxLabelValue);
      if (!l) {
        out.malformed++;
        continue;
      }
      labels = l.labels;
      i = l.end;
    }
    const rest = trimmed.slice(i);
    if (!/^[ \t]/.test(rest)) {
      out.malformed++;
      continue;
    }
    const parts = rest.trim().split(/[ \t]+/);
    if (parts.length < 1 || parts.length > 2) {
      out.malformed++;
      continue;
    }
    const value = parsePromValue(parts[0]!);
    if (value === null) {
      out.malformed++;
      continue;
    }
    let timestamp: number | undefined;
    if (parts[1] !== undefined) {
      if (!/^-?\d{1,16}$/.test(parts[1])) {
        out.malformed++;
        continue;
      }
      timestamp = Number(parts[1]);
    }
    if (o.keep && !o.keep(name)) continue;
    if (out.samples.length >= maxSamples) {
      out.truncated = true;
      break;
    }
    out.samples.push({ name, labels: { ...labels }, value, ...(timestamp !== undefined ? { timestamp } : {}) });
  }
  return out;
}
