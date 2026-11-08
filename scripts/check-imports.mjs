// Import rules of the code base (docs/ARCHITECTURE.md "Import rules"): no new runtime import cycles, and a few layer
// rules ESLint cannot express. It reads the sources with the TypeScript compiler API (no type check, a few seconds)
// and needs no other tool.
//
//   npm run check:imports                 check (CI: the lint job)
//   npm run check:imports -- --update     write the baseline anew (after removing a cycle, or a reviewed new one)
//   npm run check:imports -- --stats      also print the counts (modules, cycles, the largest knot, the PDF worker)
//   npm run check:imports -- --from <file>   list the modules a file loads at start (its runtime import closure)
//
// What counts: `import … from` and `export … from` whose bindings are used as values, and bare `import 'x'`. Type-only
// imports (`import type`, `{ type X }`, or names used only in types) are erased by the compiler and do not count;
// neither does `await import()` – a lazy import loads the module when it is called, not at start, and is the way to
// break a cycle when an event or a registration would be clumsier.
//
// Cycles: the baseline (scripts/import-baseline.json) lists every import edge that lies on a cycle today. The check
// fails when an edge on a cycle is not in it – a new cycle always has at least one such edge – and when a listed edge
// no longer lies on a cycle (the count only goes down: run --update and commit the smaller baseline).
//
// Exit status: 0 = clean, 1 = a rule is broken or the baseline is out of date, 2 = usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const HELP = `Check the import rules: no new runtime import cycles, layer rules (docs/ARCHITECTURE.md).

Usage:
  npm run check:imports [-- options]
  node scripts/check-imports.mjs [options]

Options:
  --update        Write scripts/import-baseline.json from the current cycles
  --stats         Print the counts: modules, cycles, strongly connected components, the PDF worker's modules
  --from <file>   Print the runtime import closure of a file (path relative to the repository root)
  --root <dir>    Check another checkout (tests; default: this repository)
  --lazy          With --stats or --from: follow lazy imports (\`await import()\`) too, as a bundler does
  -h, --help      Show this help

Exit status: 0 = clean, 1 = a rule is broken or the baseline is out of date, 2 = usage error.
`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      update: { type: 'boolean' },
      stats: { type: 'boolean' },
      from: { type: 'string' },
      lazy: { type: 'boolean' },
      root: { type: 'string' },
    },
    strict: true,
  }));
} catch (e) {
  process.stderr.write(`error: ${e.message.replace(/\. To specify a positional argument.*$/s, '')}\nRun 'node scripts/check-imports.mjs --help' for usage.\n`);
  process.exit(2);
}
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const root = args.root ? path.resolve(args.root) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(root, 'scripts', 'import-baseline.json');
const SOURCE_DIRS = ['server/src', 'shared/src', 'web/src'];
/** The PDF worker thread (server/src/reports/pdf/pool.ts): it draws from collected data and loads no more than that. */
const PDF_WORKER = 'server/src/reports/pdf/worker-entry.ts';

/**
 * Layer rules. `from`/`to` are path prefixes (ending in "/"), exact files (relative to the repository root) or regular
 * expressions; `except` exempts files the rule does not apply to, `toExcept` files it allows. `reach: true` checks the
 * whole runtime closure of the `from` files, not only their direct imports.
 */
const RULES = [
  {
    name: 'shared-is-shared',
    why: 'shared/ runs in the server and in the browser: it imports neither of them',
    from: ['shared/src/'],
    to: ['server/', 'web/'],
  },
  { name: 'web-not-server', why: 'the web app reaches the server over HTTP only', from: ['web/src/'], to: ['server/'] },
  { name: 'server-not-web', why: 'the server serves web/dist, it does not import the web sources', from: ['server/src/'], to: ['web/'] },
  {
    name: 'pdf-worker-draws-only',
    why: 'the PDF worker draws from collected data: no database, no engine, no services (reports/pdf/pool.ts)',
    from: [PDF_WORKER],
    reach: true,
    // config.ts parses the database address (database/sql.ts) – text only; the guard is what keeps db() shut
    toExcept: ['server/src/database/sql.ts', 'server/src/database/forbid.ts'],
    to: [
      'server/src/db.ts',
      'server/src/database/',
      'server/src/engine/',
      'server/src/scheduler.ts',
      'server/src/routes/',
      'server/src/migrations/',
      'server/src/platforms/',
      'server/src/features/',
    ],
    toPattern: [/\/service\.ts$/, /\/routes\.ts$/, /\/report-section\.ts$/],
  },
  {
    name: 'draw-is-pure',
    why: 'the draw half of a report section takes collected data and draws it: it reads no database (docs/ARCHITECTURE.md)',
    from: [/-draw\.ts$/, 'server/src/reports/pdf/'],
    except: ['server/src/reports/pdf/pool.ts'],
    reach: true,
    toExcept: ['server/src/database/sql.ts', 'server/src/database/forbid.ts'],
    to: ['server/src/db.ts', 'server/src/database/', 'server/src/engine/', 'server/src/features/'],
    toPattern: [/\/service\.ts$/, /\/routes\.ts$/, /\/report-section\.ts$/],
  },
  {
    name: 'engine-is-core',
    why: 'the engine runs steps; compliance, reports and monitors build on it, not the other way round (ADR 0011) – import lazily where a step needs them',
    from: ['server/src/engine/'],
    to: ['server/src/compliance/', 'server/src/reports/', 'server/src/monitors/', 'server/src/routes/', 'server/src/features/'],
  },
  {
    name: 'routes-are-leaves',
    why: 'routes call services; services never import routes (only the composition root and app.ts register them)',
    from: ['server/src/'],
    except: [
      'server/src/routes/',
      'server/src/features/',
      'server/src/api/',
      'server/src/app.ts',
      'server/src/main.ts',
      /\/routes\.ts$/,
      /-routes\.ts$/,
      /\/routes-[^/]+\.ts$/,
    ],
    to: ['server/src/routes/'],
    toPattern: [/\/routes\.ts$/, /-routes\.ts$/],
  },
  {
    name: 'composition-root-on-top',
    why: 'features/ wires the features together: only the entry points (app.ts and its route and public-API roots, main.ts, the CLIs) import it',
    from: ['server/src/'],
    except: ['server/src/features/', 'server/src/app.ts', 'server/src/main.ts', 'server/src/cli/', 'server/src/routes/index.ts', 'server/src/api/index.ts'],
    to: ['server/src/features/'],
  },
];

// ---------- reading the sources ----------

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  return out;
}

const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');

function resolveSpecifier(fromAbs, spec) {
  if (spec === '@sm/shared') return path.join(root, 'shared/src/index.ts');
  if (!spec.startsWith('.')) return null; // a package
  const base = path.resolve(path.dirname(fromAbs), spec.replace(/\?.*$/, ''));
  const candidates = [
    base,
    base.replace(/\.(m?js|jsx)$/, '.ts'),
    base.replace(/\.(m?js|jsx)$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) if (/\.(ts|tsx|mts)$/.test(c) && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null; // JSON, CSS, assets, .mjs scripts: not part of the graph
}

/** Names used in value positions (not in types, not as property names) – an import whose names appear here is kept. */
function valueNames(sf) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) return;
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isPropertyName =
        (p && (ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === node) ||
        (p && (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)) && p.name === node);
      if (!isPropertyName) names.add(node.text);
    }
    if (ts.isShorthandPropertyAssignment(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return names;
}

/** The runtime (static) and lazy (dynamic import()) imports of one file. */
function importsOf(abs) {
  const text = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, abs.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const used = valueNames(sf);
  const runtime = [];
  const lazy = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const c = st.importClause;
      let keep;
      if (!c)
        keep = true; // import 'x' – for its side effects
      else if (c.isTypeOnly) keep = false;
      else {
        const bound = [];
        if (c.name) bound.push(c.name.text);
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) bound.push(c.namedBindings.name.text);
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) if (!el.isTypeOnly) bound.push(el.name.text);
        keep = bound.some((n) => used.has(n));
      }
      if (keep) runtime.push(spec);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      if (st.isTypeOnly) continue;
      const els = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : null;
      if (els && els.length && els.every((e) => e.isTypeOnly)) continue;
      runtime.push(st.moduleSpecifier.text);
    }
  }
  const findLazy = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]))
      lazy.push(node.arguments[0].text);
    ts.forEachChild(node, findLazy);
  };
  findLazy(sf);
  const res = (specs) => [
    ...new Set(
      specs
        .map((s) => resolveSpecifier(abs, s))
        .filter(Boolean)
        .map(rel),
    ),
  ];
  return { runtime: res(runtime), lazy: res(lazy) };
}

const files = SOURCE_DIRS.flatMap(listFiles);
/** @type {Map<string, string[]>} runtime edges */
const graph = new Map();
for (const f of files) {
  const { runtime, lazy } = importsOf(f);
  graph.set(rel(f), args.lazy ? [...new Set([...runtime, ...lazy])] : runtime);
}
if (args.lazy && !args.stats && !args.from) {
  process.stderr.write('error: --lazy only goes with --stats or --from (the rules count runtime imports)\n');
  process.exit(2);
}

// ---------- cycles ----------

/** Tarjan: the strongly connected components with more than one file (or a file importing itself). */
function stronglyConnected() {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const on = new Set();
  const out = [];
  const strong = (v) => {
    // iterative, the graph is deep
    const work = [[v, 0]];
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    while (work.length) {
      const top = work[work.length - 1];
      const [n, i] = top;
      const next = graph.get(n) ?? [];
      if (i < next.length) {
        top[1]++;
        const w = next[i];
        if (!graph.has(w)) continue;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index++);
          stack.push(w);
          on.add(w);
          work.push([w, 0]);
        } else if (on.has(w)) low.set(n, Math.min(low.get(n), idx.get(w)));
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(n)));
        }
        if (low.get(n) === idx.get(n)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            on.delete(w);
            comp.push(w);
          } while (w !== n);
          if (comp.length > 1 || (graph.get(n) ?? []).includes(n)) out.push(comp.sort());
        }
      }
    }
  };
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) strong(v);
  return out;
}

/** Cycles as a depth-first search reports them (one per back edge it meets, like madge counts them). */
function dfsCycles() {
  const done = new Set();
  const cycles = [];
  for (const start of [...graph.keys()].sort()) {
    if (done.has(start)) continue;
    const pathStack = [];
    const onPath = new Set();
    const work = [[start, 0]];
    pathStack.push(start);
    onPath.add(start);
    while (work.length) {
      const top = work[work.length - 1];
      const [n, i] = top;
      const next = graph.get(n) ?? [];
      if (i < next.length) {
        top[1]++;
        const w = next[i];
        if (onPath.has(w)) cycles.push(pathStack.slice(pathStack.indexOf(w)));
        else if (!done.has(w) && graph.has(w)) {
          pathStack.push(w);
          onPath.add(w);
          work.push([w, 0]);
        }
      } else {
        work.pop();
        pathStack.pop();
        onPath.delete(n);
        done.add(n);
      }
    }
  }
  return cycles;
}

const sccs = stronglyConnected();
const sccOf = new Map();
sccs.forEach((c, i) => c.forEach((f) => sccOf.set(f, i)));
/** Every edge that lies on a cycle: both ends in the same component. */
const cycleEdges = [];
for (const [from, tos] of graph) for (const to of tos) if (sccOf.has(from) && sccOf.get(from) === sccOf.get(to)) cycleEdges.push(`${from} -> ${to}`);
cycleEdges.sort();

/** A shortest cycle through an edge (for the message): from `to` back to `from` inside the component. */
function cycleThrough(edge) {
  const [from, to] = edge.split(' -> ');
  const comp = sccOf.get(from);
  const prev = new Map([[to, null]]);
  const queue = [to];
  while (queue.length) {
    const n = queue.shift();
    if (n === from) break;
    for (const w of graph.get(n) ?? []) if (sccOf.get(w) === comp && !prev.has(w)) (prev.set(w, n), queue.push(w));
  }
  if (!prev.has(from)) return edge;
  const back = [];
  for (let n = from; n !== null; n = prev.get(n)) back.push(n);
  return [from, ...back.reverse()].join(' → ');
}

// ---------- closures and rules ----------

function closure(start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) for (const w of graph.get(queue.shift()) ?? []) if (!seen.has(w)) (seen.add(w), queue.push(w));
  return seen;
}

const matches = (file, list) => (list ?? []).some((p) => (typeof p === 'string' ? (p.endsWith('/') ? file.startsWith(p) : file === p) : p.test(file)));

const violations = [];
for (const rule of RULES) {
  const sources = [...graph.keys()].filter((f) => matches(f, rule.from) && !matches(f, rule.except));
  for (const f of sources) {
    const targets = rule.reach ? [...closure(f)].filter((x) => x !== f) : (graph.get(f) ?? []);
    for (const t of targets) {
      if (matches(t, rule.toExcept)) continue;
      if (matches(t, rule.to) || (rule.toPattern ?? []).some((re) => re.test(t))) violations.push(`${rule.name}: ${f} -> ${t}`);
    }
  }
}
violations.sort();

// ---------- output ----------

if (args.from) {
  const start = args.from.replace(/^\.\//, '');
  if (!graph.has(start)) {
    process.stderr.write(`error: ${start} is not a source file under ${SOURCE_DIRS.join(', ')}\n`);
    process.exit(2);
  }
  const c = [...closure(start)].sort();
  process.stdout.write(`${c.join('\n')}\n${c.length} modules (runtime imports of ${start}, lazy imports not followed)\n`);
  process.exit(0);
}

const cyclesFound = dfsCycles();
const stats = () => {
  const serverFiles = [...graph.keys()].filter((f) => f.startsWith('server/src/'));
  const largest = sccs.reduce((a, c) => (c.length > a.length ? c : a), []);
  const folderOf = (f) =>
    f
      .split('/')
      .slice(0, f.startsWith('server/src/') ? 3 : 2)
      .join('/');
  const crossing = cyclesFound.filter((c) => new Set(c.map((f) => (f.split('/').length > 4 ? folderOf(f) + '/' + f.split('/')[3] : folderOf(f)))).size > 1);
  const worker = graph.has(PDF_WORKER) ? closure(PDF_WORKER) : new Set();
  process.stdout.write(
    [
      `modules: ${graph.size} (server ${serverFiles.length})`,
      `runtime import cycles: ${cyclesFound.length} (${crossing.length} across folders)`,
      `strongly connected components: ${sccs.length}, largest ${largest.length} files${largest.length ? `: ${largest.join(', ')}` : ''}`,
      `edges on cycles: ${cycleEdges.length}`,
      `PDF worker (${PDF_WORKER}) loads ${[...worker].filter((f) => f.startsWith('server/src/')).length} server modules, ${worker.size} in all`,
      '',
    ].join('\n'),
  );
};
if (args.stats) stats();
// with lazy imports followed the graph is not the one the rules are about
if (args.lazy) process.exit(0);

if (args.update) {
  const body = {
    $comment:
      'Import edges on runtime cycles and accepted layer-rule exceptions as of the last `npm run check:imports -- --update`. The list only shrinks: remove a cycle, then update. See docs/ARCHITECTURE.md "Import rules".',
    cycleEdges,
    violations,
  };
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
  process.stdout.write(`✔ wrote ${rel(BASELINE)}: ${cycleEdges.length} edges on ${cyclesFound.length} cycles, ${violations.length} rule exceptions\n`);
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { cycleEdges: [], violations: [] };
const known = new Set(baseline.cycleEdges);
const knownViolations = new Set(baseline.violations);
const newEdges = cycleEdges.filter((e) => !known.has(e));
const goneEdges = baseline.cycleEdges.filter((e) => !cycleEdges.includes(e));
const newViolations = violations.filter((v) => !knownViolations.has(v));
const goneViolations = baseline.violations.filter((v) => !violations.includes(v));

let failed = false;
if (newEdges.length) {
  failed = true;
  process.stderr.write(`✘ ${newEdges.length} import(s) close a new runtime cycle:\n`);
  for (const e of newEdges) process.stderr.write(`  ${e}\n    cycle: ${cycleThrough(e)}\n`);
  process.stderr.write(
    '  Break it: import the type only (`import type`), move the shared part into its own module, register instead of importing, or import lazily (`await import()`).\n',
  );
}
if (newViolations.length) {
  failed = true;
  process.stderr.write(`✘ ${newViolations.length} import(s) break a layer rule:\n`);
  for (const v of newViolations) {
    const rule = RULES.find((r) => v.startsWith(`${r.name}:`));
    process.stderr.write(`  ${v}\n    rule: ${rule?.why ?? ''}\n`);
  }
}
if (goneEdges.length || goneViolations.length) {
  failed = true;
  process.stderr.write(
    `✘ the baseline lists ${goneEdges.length + goneViolations.length} import(s) that no longer close a cycle or break a rule – good; run "npm run check:imports -- --update" and commit ${rel(BASELINE)}:\n`,
  );
  for (const e of [...goneEdges, ...goneViolations]) process.stderr.write(`  ${e}\n`);
}
if (failed) process.exit(1);
process.stdout.write(
  `✔ imports: no new cycles (${cycleEdges.length} known edges on ${cyclesFound.length} cycles), layer rules kept (${violations.length} known exceptions), ${graph.size} modules\n`,
);
