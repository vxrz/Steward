/**
 * A small, documented subset of JSONata (docs/POSTMAN.md) parsed into a tree, so the Postman export can turn
 * Steward's expressions into plain JavaScript for Postman scripts or into Postman variables. Nothing is evaluated
 * here: the parser only reads the expression text. Everything outside the subset makes `parseSubset` return null,
 * and the caller falls back (JSONata in Postman via pm.require, or a variable set by hand).
 *
 * The subset: paths (names, `backtick names`, numeric indexes like [0] or [-1]), the variables $inputs, $vars,
 * $const (and others the caller allows), string, number, true/false/null literals, = != < <= > >=, and, or,
 * parentheses, and the functions $count, $exists, $length, $not (plus $pvar and $secret, which the caller resolves).
 */

export type PathStep = { key: string; index?: number };

export type Node =
  | { t: 'lit'; v: string | number | boolean | null }
  | { t: 'path'; variable?: string; steps: PathStep[] }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'bin'; op: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or'; l: Node; r: Node };

/** Functions of the subset with a plain JavaScript equivalent (JS_HELPERS). */
export const SUBSET_FUNCTIONS = ['count', 'exists', 'length', 'not'] as const;
/** Steward's functions the export resolves to Postman variables (a platform variable, a secret). */
const RESOLVED_FUNCTIONS = ['pvar', 'secret'];

type Tok = { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'name'; v: string } | { k: 'var'; v: string } | { k: 'op'; v: string };

class Unsupported extends Error {}

const MAX_EXPRESSION = 2000;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') throw new Unsupported('comment');
    if (/[0-9]/.test(c)) {
      const m = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new Unsupported('number');
      out.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          const e = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '/': '/', b: '\b', f: '\f' };
          if (e === undefined || !(e in map)) throw new Unsupported('escape');
          s += map[e];
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new Unsupported('unterminated string');
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw new Unsupported('unterminated name');
      out.push({ k: 'name', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (!m) throw new Unsupported('variable');
      out.push({ k: 'var', v: m[1]! });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '!=' || two === '<=' || two === '>=') {
      out.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if ('=<>.[](),-'.includes(c)) {
      out.push({ k: 'op', v: c });
      i++;
      continue;
    }
    throw new Unsupported(`character ${c}`);
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.k === 'op' && t.v === v;
  }
  private isWord(v: string): boolean {
    const t = this.peek();
    return !!t && t.k === 'name' && t.v === v;
  }
  private expect(v: string): void {
    if (!this.isOp(v)) throw new Unsupported(`expected ${v}`);
    this.i++;
  }

  parse(): Node {
    const n = this.or();
    if (this.i !== this.toks.length) throw new Unsupported('trailing input');
    return n;
  }

  private or(): Node {
    let l = this.and();
    while (this.isWord('or')) {
      this.i++;
      l = { t: 'bin', op: 'or', l, r: this.and() };
    }
    return l;
  }

  private and(): Node {
    let l = this.cmp();
    while (this.isWord('and')) {
      this.i++;
      l = { t: 'bin', op: 'and', l, r: this.cmp() };
    }
    return l;
  }

  private cmp(): Node {
    const l = this.primary();
    const t = this.peek();
    if (t && t.k === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      this.i++;
      const r = this.primary();
      const next = this.peek();
      // a = b = c is not JSONata either; anything after the comparison but and/or is outside the subset
      if (next && next.k === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(next.v)) throw new Unsupported('chained comparison');
      return { t: 'bin', op: t.v as '=', l, r };
    }
    return l;
  }

  private primary(): Node {
    const t = this.peek();
    if (!t) throw new Unsupported('unexpected end');
    if (t.k === 'op' && t.v === '(') {
      this.i++;
      const n = this.or();
      this.expect(')');
      return this.noPathAfter(n);
    }
    if (t.k === 'op' && t.v === '-') {
      this.i++;
      const n = this.peek();
      if (!n || n.k !== 'num') throw new Unsupported('unary minus');
      this.i++;
      return { t: 'lit', v: -n.v };
    }
    if (t.k === 'num' || t.k === 'str') {
      this.i++;
      return this.noPathAfter({ t: 'lit', v: t.v });
    }
    if (t.k === 'name' && (t.v === 'true' || t.v === 'false' || t.v === 'null')) {
      this.i++;
      return this.noPathAfter({ t: 'lit', v: t.v === 'null' ? null : t.v === 'true' });
    }
    if (t.k === 'name' && (t.v === 'and' || t.v === 'or' || t.v === 'in')) throw new Unsupported(`operator ${t.v} as a name`);
    if (t.k === 'var') {
      this.i++;
      if (this.isOp('(')) {
        this.i++;
        const args: Node[] = [];
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.or());
            if (this.isOp(',')) {
              this.i++;
              continue;
            }
            break;
          }
        }
        this.expect(')');
        if ((SUBSET_FUNCTIONS as readonly string[]).includes(t.v) ? args.length !== 1 : !RESOLVED_FUNCTIONS.includes(t.v))
          throw new Unsupported(`function $${t.v}`);
        return this.noPathAfter({ t: 'call', fn: t.v, args });
      }
      // $inputs.x, $vars.y …: a path that starts at a variable
      const steps: PathStep[] = [];
      this.indexes(steps, true);
      while (this.isOp('.')) {
        this.i++;
        steps.push(this.step());
      }
      return { t: 'path', variable: t.v, steps };
    }
    if (t.k === 'name') {
      const steps: PathStep[] = [this.step()];
      while (this.isOp('.')) {
        this.i++;
        steps.push(this.step());
      }
      return { t: 'path', steps };
    }
    throw new Unsupported('unexpected token');
  }

  /** A path step: a name with at most one numeric index. */
  private step(): PathStep {
    const t = this.peek();
    if (!t || t.k !== 'name') throw new Unsupported('path step');
    this.i++;
    const s: PathStep = { key: t.v };
    this.indexes([s], false);
    return s;
  }

  private indexes(steps: PathStep[], onVariable: boolean): void {
    if (!this.isOp('[')) return;
    if (onVariable) throw new Unsupported('index on a variable');
    this.i++;
    let sign = 1;
    if (this.isOp('-')) {
      sign = -1;
      this.i++;
    }
    const n = this.peek();
    if (!n || n.k !== 'num' || !Number.isInteger(n.v)) throw new Unsupported('filter');
    this.i++;
    this.expect(']');
    steps[steps.length - 1]!.index = sign * n.v;
    if (this.isOp('[')) throw new Unsupported('second index');
  }

  /** `(a).b`, `"x".y` and `$f().y` are outside the subset. */
  private noPathAfter(n: Node): Node {
    if (this.isOp('.') || this.isOp('[')) throw new Unsupported('path after a value');
    return n;
  }
}

/** The tree of an expression in the subset, or null when it uses anything else. */
export function parseSubset(expression: string): Node | null {
  const src = expression.trim();
  if (!src || src.length > MAX_EXPRESSION) return null;
  try {
    return new Parser(tokenize(src)).parse();
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

/** The path as written in Steward, e.g. vars.users.body.resources[0].id (names that need it in backticks). */
export function pathText(steps: PathStep[], variable?: string): string {
  const parts = steps.map((s) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.key) ? s.key : `\`${s.key}\``) + (s.index !== undefined ? `[${s.index}]` : ''));
  return (variable ? [`$${variable}`, ...parts] : parts).join('.');
}

/** Names the expression's paths start with, as `vars.x` (for the JSONata fallback: which values it needs). */
export function referencedVars(expression: string): Set<string> {
  const out = new Set<string>();
  for (const m of expression.matchAll(/(?<![A-Za-z0-9_.`])\$?vars\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]!);
  return out;
}

/**
 * How the JavaScript of a path is written: the caller decides where a path's value comes from (the response, a
 * collection variable, a literal of the definition …). Returns null for a path it cannot provide.
 */
export interface JsScope {
  path(steps: PathStep[], variable?: string): string | null;
  /** Functions other than the subset's own ($pvar, $secret); null: not translatable */
  call?(fn: string, args: Node[]): string | null;
}

/** JavaScript for a tree of the subset (using JS_HELPERS), or null when a path or function has no translation. */
export function toJs(n: Node, scope: JsScope): string | null {
  switch (n.t) {
    case 'lit':
      return JSON.stringify(n.v);
    case 'path':
      return scope.path(n.steps, n.variable);
    case 'call': {
      if ((SUBSET_FUNCTIONS as readonly string[]).includes(n.fn)) {
        if (n.args.length !== 1) return null;
        const a = toJs(n.args[0]!, scope);
        return a === null ? null : `$${n.fn}(${a})`;
      }
      return scope.call ? scope.call(n.fn, n.args) : null;
    }
    case 'bin': {
      const l = toJs(n.l, scope);
      const r = toJs(n.r, scope);
      if (l === null || r === null) return null;
      switch (n.op) {
        case 'and':
          return `($bool(${l}) && $bool(${r}))`;
        case 'or':
          return `($bool(${l}) || $bool(${r}))`;
        case '=':
          return `$eq(${l}, ${r})`;
        case '!=':
          return `$ne(${l}, ${r})`;
        default:
          return `$cmp(${JSON.stringify(n.op)}, ${l}, ${r})`;
      }
    }
  }
}

/** The steps of a path as the helpers take them: [["body"], ["items", 0], ["id"]]. */
export function stepsJs(steps: PathStep[]): string {
  return JSON.stringify(steps.map((s) => (s.index === undefined ? [s.key] : [s.key, s.index])));
}

/**
 * The JavaScript helpers the translated expressions use: JSONata's path navigation (sequences of arrays are
 * flattened, a single value is not wrapped, an array value kept as it is), its truthiness, equality and comparisons.
 * Plain ES2017, for the Postman sandbox (and any JavaScript engine).
 */
export const JS_HELPERS: string[] = [
  "const SEQ = typeof Symbol === 'function' ? Symbol('sequence') : '__sequence';",
  'function $seq(a) { a[SEQ] = true; return a; }',
  'function $look(v, k) {',
  '  if (Array.isArray(v)) { const r = $seq([]); for (const x of v) { const y = $look(x, k); if (y !== undefined) { if (Array.isArray(y)) r.push(...y); else r.push(y); } } return r; }',
  "  return v !== null && typeof v === 'object' ? v[k] : undefined;",
  '}',
  'function $one(v) { return Array.isArray(v) && v[SEQ] ? (v.length === 0 ? undefined : v.length === 1 ? v[0] : v) : v; }',
  'function $idx(v, n) { const a = Array.isArray(v) ? v : [v]; const item = a[n < 0 ? a.length + n : n]; return item === undefined ? $seq([]) : Array.isArray(item) ? item : $seq([item]); }',
  'function $p(v, steps) {',
  '  if (v === undefined) return undefined;',
  '  if (!steps.length) return v;',
  '  let input = Array.isArray(v) ? v : [v];',
  '  let out = [];',
  '  for (let i = 0; i < steps.length; i++) {',
  '    const res = [];',
  '    for (const item of input) { let r = $one($look(item, steps[i][0])); if (steps[i].length > 1) r = $idx(r, steps[i][1]); if (r !== undefined) res.push(r); }',
  '    if (i === steps.length - 1 && res.length === 1 && Array.isArray(res[0]) && !res[0][SEQ]) return res[0];',
  '    out = [];',
  '    for (const r of res) { if (Array.isArray(r)) out.push(...r); else out.push(r); }',
  '    if (!out.length) return undefined;',
  '    input = out;',
  '  }',
  '  return out.length === 1 ? out[0] : out;',
  '}',
  'function $boolean(v) {',
  '  if (v === undefined) return undefined;',
  '  if (Array.isArray(v)) return v.length === 1 ? $boolean(v[0]) : v.length > 1 && v.some((x) => $boolean(x));',
  "  if (typeof v === 'string') return v.length > 0;",
  "  if (typeof v === 'number') return v !== 0;",
  "  if (v !== null && typeof v === 'object') return Object.keys(v).length > 0;",
  '  return v === true;',
  '}',
  'function $bool(v) { return $boolean(v) === true; }',
  'function $truthy(v) { return Array.isArray(v) ? v.length > 0 : Boolean(v); }',
  'function $deq(a, b) {',
  '  if (a === b) return true;',
  '  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => $deq(x, b[i]));',
  "  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) { const ka = Object.keys(a); const kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => $deq(a[k], b[k])); }",
  '  return false;',
  '}',
  'function $eq(a, b) { return a === undefined || b === undefined ? false : $deq(a, b); }',
  'function $ne(a, b) { return a === undefined || b === undefined ? false : !$deq(a, b); }',
  'function $cmp(op, a, b) {',
  "  const ok = (x) => x === undefined || typeof x === 'string' || typeof x === 'number';",
  "  if (!ok(a) || !ok(b)) throw new Error('Only numbers and strings can be compared with ' + op);",
  '  if (a === undefined || b === undefined) return undefined;',
  "  if (typeof a !== typeof b) throw new Error('Cannot compare a ' + typeof a + ' with a ' + typeof b);",
  "  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;",
  '}',
  'function $count(v) { return v === undefined ? 0 : Array.isArray(v) ? v.length : 1; }',
  'function $exists(v) { return v !== undefined; }',
  "function $length(v) { if (v === undefined) return undefined; if (typeof v !== 'string') throw new Error('$length needs a string'); return Array.from(v).length; }",
  'function $not(v) { const b = $boolean(v); return b === undefined ? undefined : !b; }',
];
