import type { ProcessDefinition, ScopeHints, Wire } from '@sm/shared';

/** One autocomplete suggestion. `insert` replaces the token before the caret. */
export interface Suggestion {
  label: string;
  insert: string;
  kind: 'input' | 'const' | 'var' | 'conn' | 'run' | 'loop' | 'item' | 'fn' | 'root';
  detail?: string;
  /** Function signature / longer help */
  help?: string;
}

export interface FnHint {
  name: string;
  signature: string;
  help: string;
}

/** Built-in helpers plus the most used JSONata functions (merged with the server's list when available). */
export const STATIC_FUNCTIONS: FnHint[] = [
  { name: '$daysSince', signature: '$daysSince(timestamp)', help: 'Days since a timestamp (ISO or epoch). Empty → undefined.' },
  { name: '$daysAgo', signature: '$daysAgo(n)', help: 'ISO timestamp n days in the past.' },
  { name: '$ts', signature: '$ts(value)', help: 'Parse a timestamp into epoch milliseconds.' },
  { name: '$uuid', signature: '$uuid()', help: 'A random UUID.' },
  { name: '$pvar', signature: '$pvar(slot, name, default)', help: 'Platform variable of a connection slot.' },
  { name: '$secret', signature: '$secret(slot, key)', help: 'Secret of a connection slot (redacted in logs).' },
  { name: '$count', signature: '$count(array)', help: 'Number of items.' },
  { name: '$sum', signature: '$sum(array)', help: 'Sum of numbers.' },
  { name: '$max', signature: '$max(array)', help: 'Largest number.' },
  { name: '$min', signature: '$min(array)', help: 'Smallest number.' },
  { name: '$average', signature: '$average(array)', help: 'Mean of numbers.' },
  { name: '$join', signature: '$join(array, separator?)', help: 'Join strings.' },
  { name: '$split', signature: '$split(str, separator, limit?)', help: 'Split a string into a list.' },
  { name: '$string', signature: '$string(value, prettify?)', help: 'Convert to a string (objects → JSON).' },
  { name: '$number', signature: '$number(value)', help: 'Convert to a number.' },
  { name: '$boolean', signature: '$boolean(value)', help: 'Convert to true/false.' },
  { name: '$not', signature: '$not(value)', help: 'Logical not.' },
  { name: '$exists', signature: '$exists(value)', help: 'true if the value is defined.' },
  { name: '$length', signature: '$length(str)', help: 'Length of a string.' },
  { name: '$lowercase', signature: '$lowercase(str)', help: 'Lower case.' },
  { name: '$uppercase', signature: '$uppercase(str)', help: 'Upper case.' },
  { name: '$trim', signature: '$trim(str)', help: 'Remove surrounding whitespace.' },
  { name: '$substring', signature: '$substring(str, start, length?)', help: 'Part of a string.' },
  { name: '$substringBefore', signature: '$substringBefore(str, chars)', help: 'Text before the first occurrence.' },
  { name: '$substringAfter', signature: '$substringAfter(str, chars)', help: 'Text after the first occurrence.' },
  { name: '$contains', signature: '$contains(str, pattern)', help: 'true if the string contains the pattern.' },
  { name: '$replace', signature: '$replace(str, pattern, replacement, limit?)', help: 'Replace text or regex matches.' },
  { name: '$match', signature: '$match(str, regex, limit?)', help: 'Regex matches.' },
  { name: '$pad', signature: '$pad(str, width, char?)', help: 'Pad a string.' },
  { name: '$keys', signature: '$keys(object)', help: 'Keys of an object.' },
  { name: '$lookup', signature: '$lookup(object, key)', help: 'Value of a key.' },
  { name: '$merge', signature: '$merge(array<object>)', help: 'Merge objects into one.' },
  { name: '$each', signature: '$each(object, function($v, $k))', help: 'Map over key/value pairs.' },
  { name: '$map', signature: '$map(array, function($v, $i))', help: 'Transform each item.' },
  { name: '$filter', signature: '$filter(array, function($v, $i))', help: 'Keep matching items.' },
  { name: '$reduce', signature: '$reduce(array, function($acc, $v), init?)', help: 'Fold a list into one value.' },
  { name: '$sort', signature: '$sort(array, function($a, $b)?)', help: 'Sort a list.' },
  { name: '$reverse', signature: '$reverse(array)', help: 'Reverse a list.' },
  { name: '$distinct', signature: '$distinct(array)', help: 'Remove duplicates.' },
  { name: '$append', signature: '$append(array1, array2)', help: 'Concatenate lists.' },
  { name: '$zip', signature: '$zip(array1, array2, …)', help: 'Combine lists item by item.' },
  { name: '$now', signature: '$now()', help: 'Current time as ISO string.' },
  { name: '$millis', signature: '$millis()', help: 'Current time in epoch milliseconds.' },
  { name: '$fromMillis', signature: '$fromMillis(ms, picture?)', help: 'Epoch milliseconds → ISO string.' },
  { name: '$toMillis', signature: '$toMillis(timestamp, picture?)', help: 'ISO string → epoch milliseconds.' },
  { name: '$round', signature: '$round(number, precision?)', help: 'Round a number.' },
  { name: '$floor', signature: '$floor(number)', help: 'Round down.' },
  { name: '$ceil', signature: '$ceil(number)', help: 'Round up.' },
  { name: '$abs', signature: '$abs(number)', help: 'Absolute value.' },
  { name: '$type', signature: '$type(value)', help: 'Type name of a value.' },
  { name: '$base64encode', signature: '$base64encode(str)', help: 'Base64 encode.' },
  { name: '$base64decode', signature: '$base64decode(str)', help: 'Base64 decode.' },
  { name: '$encodeUrlComponent', signature: '$encodeUrlComponent(str)', help: 'URL-encode a value.' },
];

const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** For-each nodes whose "each item" branch reaches the node (innermost last is not guaranteed). */
export function enclosingLoops(def: ProcessDefinition, nodeId: string | undefined): string[] {
  if (!nodeId) return [];
  const out = new Map<string, Wire[]>();
  for (const w of def.wires ?? []) out.set(w.from, [...(out.get(w.from) ?? []), w]);
  const result: string[] = [];
  for (const n of def.nodes) {
    if (n.type !== 'forEach' || !n.as) continue;
    const seen = new Set<string>();
    const stack = (out.get(n.id) ?? []).filter((w) => w.port === 'each').map((w) => w.to);
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id) || id === n.id) continue;
      seen.add(id);
      for (const w of out.get(id) ?? []) stack.push(w.to);
    }
    if (seen.has(nodeId)) result.push(n.as);
  }
  return result;
}

/** Top-level keys of a JSON object sample – also works when the sample is truncated. */
export function sampleKeys(sample: string): string[] {
  const t = sample.trim();
  if (!t.startsWith('{')) return [];
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < t.length && keys.length < 30) {
    const c = t[i]!;
    if (c === '"') {
      let j = i + 1;
      let str = '';
      while (j < t.length && t[j] !== '"') {
        if (t[j] === '\\') j++;
        str += t[j] ?? '';
        j++;
      }
      let k = j + 1;
      while (t[k] === ' ') k++;
      if (depth === 1 && t[k] === ':' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(str)) keys.push(str);
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  return keys;
}

/** All suggestions for a node (static ones from the definition, merged with server scope hints). */
export function buildSuggestions(def: ProcessDefinition, scope: ScopeHints | undefined, nodeId: string | undefined): Suggestion[] {
  const list: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (s: Suggestion) => {
    if (seen.has(s.insert)) return;
    seen.add(s.insert);
    list.push(s);
  };
  const loops = enclosingLoops(def, nodeId);
  const allLoops = def.nodes.flatMap((n) => (n.type === 'forEach' && n.as ? [n.as] : []));

  // loop variables first – most likely needed inside a loop body
  for (const as of loops) {
    add({ label: `vars.${as}`, insert: `vars.${as}`, kind: 'loop', detail: 'current loop item' });
    add({ label: `vars.${as}Index`, insert: `vars.${as}Index`, kind: 'loop', detail: 'loop index (0-based)' });
  }
  for (const i of def.inputs ?? []) add({ label: `inputs.${i.name}`, insert: `inputs.${i.name}`, kind: 'input', detail: i.label ? `${i.type} · ${i.label}` : i.type });
  for (const n of scope?.inputs ?? []) add({ label: `inputs.${n}`, insert: `inputs.${n}`, kind: 'input', detail: 'input' });
  for (const k of Object.keys(def.constants ?? {})) {
    const v = (def.constants ?? {})[k];
    add({ label: `const.${k}`, insert: `const.${k}`, kind: 'const', detail: short(typeof v === 'string' ? v : JSON.stringify(v) ?? '', 40) });
  }
  for (const k of scope?.constants ?? []) add({ label: `const.${k}`, insert: `const.${k}`, kind: 'const', detail: 'constant' });
  for (const v of scope?.vars ?? []) {
    add({ label: `vars.${v.name}`, insert: `vars.${v.name}`, kind: 'var', detail: short(v.sample, 50) });
    for (const k of sampleKeys(v.sample)) add({ label: `vars.${v.name}.${k}`, insert: `vars.${v.name}.${k}`, kind: 'var', detail: 'field' });
  }
  // variables the definition will create
  for (const n of def.nodes) {
    if (n.saveAs) add({ label: `vars.${n.saveAs}`, insert: `vars.${n.saveAs}`, kind: 'var', detail: `result of ${n.name || n.id}` });
    if (n.type === 'set') for (const k of Object.keys(n.values ?? {})) add({ label: `vars.${k}`, insert: `vars.${k}`, kind: 'var', detail: `set by ${n.name || n.id}` });
  }
  for (const as of allLoops) if (!loops.includes(as)) add({ label: `vars.${as}`, insert: `vars.${as}`, kind: 'loop', detail: 'loop item (inside its loop)' });
  const connVars = new Map((scope?.connections ?? []).map((c) => [c.slot, c.vars]));
  for (const c of def.connections ?? []) {
    add({ label: `conn.${c.slot}.baseUrl`, insert: `conn.${c.slot}.baseUrl`, kind: 'conn', detail: c.kind ?? 'connection' });
    add({ label: `conn.${c.slot}.name`, insert: `conn.${c.slot}.name`, kind: 'conn', detail: 'platform name' });
    for (const v of connVars.get(c.slot) ?? []) add({ label: `conn.${c.slot}.vars.${v}`, insert: `conn.${c.slot}.vars.${v}`, kind: 'conn', detail: 'platform variable' });
  }
  for (const c of scope?.connections ?? []) for (const v of c.vars) add({ label: `conn.${c.slot}.vars.${v}`, insert: `conn.${c.slot}.vars.${v}`, kind: 'conn', detail: 'platform variable' });
  for (const [k, d] of [
    ['run.id', 'run id'],
    ['run.dryRun', 'true in dry runs'],
    ['run.actor', 'who started the run'],
    ['run.startedAt', 'start time'],
  ] as const)
    add({ label: k, insert: k, kind: 'run', detail: d });
  add({ label: '$item', insert: '$item', kind: 'item', detail: 'current item (per-item fields)' });
  add({ label: '$inputs', insert: '$inputs', kind: 'root', detail: 'inputs inside filters [ ]' });
  add({ label: '$vars', insert: '$vars', kind: 'root', detail: 'vars inside filters [ ]' });
  add({ label: '$const', insert: '$const', kind: 'root', detail: 'constants inside filters [ ]' });
  const fns = new Map<string, FnHint>();
  for (const f of STATIC_FUNCTIONS) fns.set(f.name, f);
  for (const f of scope?.functions ?? []) fns.set(f.name.startsWith('$') ? f.name : `$${f.name}`, { ...f, name: f.name.startsWith('$') ? f.name : `$${f.name}` });
  for (const f of fns.values()) add({ label: f.name, insert: `${f.name}(`, kind: 'fn', detail: f.signature, help: f.help });
  return list;
}

/** Top-level roots offered right after "{{" or on Ctrl+Space with an empty token. */
const ROOTS: Suggestion[] = [
  { label: 'inputs.', insert: 'inputs.', kind: 'root', detail: 'run inputs' },
  { label: 'vars.', insert: 'vars.', kind: 'root', detail: 'node results, loop items' },
  { label: 'const.', insert: 'const.', kind: 'root', detail: 'constants' },
  { label: 'conn.', insert: 'conn.', kind: 'root', detail: 'connections' },
  { label: 'run.', insert: 'run.', kind: 'root', detail: 'run info' },
  { label: '$', insert: '$', kind: 'root', detail: 'functions' },
];

const TOKEN_CHAR = /[A-Za-z0-9_.$]/;

/**
 * Finds the token being typed at `caret`. Returns null when no suggestions
 * apply (e.g. outside {{ }} in a template).
 */
export function tokenAt(text: string, caret: number, template: boolean): { start: number; token: string; exprStart: boolean } | null {
  const before = text.slice(0, caret);
  let exprFrom = 0;
  if (template) {
    const open = before.lastIndexOf('{{');
    if (open < 0) return null;
    if (before.indexOf('}}', open) >= 0) return null;
    exprFrom = open + 2;
  }
  let i = caret;
  while (i > exprFrom && TOKEN_CHAR.test(text[i - 1]!)) i--;
  const token = text.slice(i, caret);
  // inside a string literal? (odd number of quotes since the expression start)
  const segment = text.slice(exprFrom, i);
  const quotes = (segment.match(/"/g)?.length ?? 0) + (segment.match(/'/g)?.length ?? 0);
  if (quotes % 2 === 1) return null;
  const exprStart = segment.trim() === '';
  return { start: i, token, exprStart };
}

export function filterSuggestions(all: Suggestion[], token: string, exprStart: boolean, force: boolean, limit = 12): Suggestion[] {
  if (!token) return exprStart || force ? ROOTS : [];
  // a number literal or a lone dot: nothing to suggest
  if (/^\d/.test(token)) return [];
  const t = token.toLowerCase();
  const starts: Suggestion[] = [];
  const contains: Suggestion[] = [];
  for (const s of all) {
    const l = s.insert.toLowerCase();
    if (l === t || l === `${t}(`) continue;
    if (l.startsWith(t)) starts.push(s);
    else if (!t.includes('.') && t.length >= 2 && (l.split('.').pop() ?? '').includes(t.replace(/^\$/, ''))) contains.push(s);
  }
  // after "vars." prefer direct children over deep fields
  const depth = t.split('.').length;
  starts.sort((a, b) => Math.abs(a.insert.split('.').length - depth) - Math.abs(b.insert.split('.').length - depth));
  return [...starts, ...contains].slice(0, limit);
}

/** Compact one-line JSON for previews. */
export function compactJson(v: unknown, max = 240): { text: string; truncated: boolean } {
  let s: string;
  if (v === undefined) s = 'undefined';
  else if (typeof v === 'string') s = JSON.stringify(v);
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  return s.length > max ? { text: s.slice(0, max - 1) + '…', truncated: true } : { text: s, truncated: false };
}
