import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers.js';

/**
 * The internal API contract between the web app and the server (architecture review A5): the web calls the server
 * with plain-string URLs (`get('/runs')`, `post(`/processes/${id}/duplicate`)`), so nothing but this test notices a
 * renamed or removed route before a person does.
 *
 * It reads every call of the API helpers of web/src/api.ts (get, post, put, patch, del, api, getOptional, apiUrl) and
 * every app-relative "/api/…" link (withBase, appUrl) with the TypeScript parser, turns the URL argument into a path
 * template (`${…}` becomes a placeholder, the query string is cut off) and checks:
 *   - every call matches a route the server registers (method and path),
 *   - every internal route is called by the web app or named in API_ONLY below, with the reason.
 *
 * URLs built from a constant, a conditional, a small helper (`siteBase(id)`), a parameter of a function or component
 * of the same file, or a table of URL functions are followed; the few that cannot be say which routes they call in
 * DYNAMIC.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const WEB = path.join(ROOT, 'web/src');
const API_MODULE = path.join(WEB, 'api.ts');
const BASE_MODULE = path.join(WEB, 'basePath.ts');

/** The helpers of web/src/api.ts and their HTTP method (`api` takes it as its first argument). */
const API_HELPERS: Record<string, string | null> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  del: 'DELETE',
  getOptional: 'GET',
  apiUrl: 'GET',
  api: null,
};
/** The helpers of web/src/basePath.ts that take an app-relative path ("/api/…" for the API). */
const BASE_HELPERS = new Set(['withBase', 'appUrl']);

/**
 * Internal routes the web app does not call: machine-to-machine endpoints, probes, files and routes used by other
 * clients. A key ending in "/*" covers everything below it.
 */
const API_ONLY: Record<string, string> = {
  // the web UI itself and its files
  'GET /': 'the web UI (hint page without a build)',
  'GET /*': 'the web UI (static files)',
  'GET /manifest.webmanifest': 'linked from index.html',
  // probes (the others are shown on the system status page)
  'GET /api/instance': 'instance proof for other Steward instances and the desktop launcher',
  // the public API, its documentation, MCP and OAuth for MCP clients
  'GET /api/v1/*': 'public API (docs/API.md)',
  'POST /api/v1/*': 'public API (docs/API.md)',
  'PUT /api/v1/*': 'public API (docs/API.md)',
  'PATCH /api/v1/*': 'public API (docs/API.md)',
  'DELETE /api/v1/*': 'public API (docs/API.md)',
  'GET /api/docs/*': 'Swagger UI of the public API (linked from the URL /api/public-api returns)',
  'GET /api/docs': 'Swagger UI of the public API (linked from the URL /api/public-api returns)',
  'POST /api/mcp': 'MCP endpoint (docs/MCP.md)',
  'GET /api/mcp': 'MCP endpoint: answers 405',
  'PUT /api/mcp': 'MCP endpoint: answers 405',
  'PATCH /api/mcp': 'MCP endpoint: answers 405',
  'DELETE /api/mcp': 'MCP endpoint: answers 405',
  'GET /.well-known/*': 'OAuth metadata for MCP clients',
  'POST /oauth/*': 'OAuth for MCP clients',
  // inbound webhooks, authenticated by their own secret
  'POST /api/hooks/*': 'inbound webhooks',
  // sign-in, single sign-on and emergency access
  'GET /api/auth/oidc/callback': 'redirect target of the identity provider',
  'POST /api/auth/step-up/sso/complete': 'posted by the page the step-up callback renders (routes/auth.ts)',
  'POST /api/auth/emergency/grant': 'the emergency-access command line (loopback only)',
  'GET /api/auth/me': 'scripts; the web app reads the same from /auth/status',
  'DELETE /api/auth/step-up': 'scripts and tests: ends a confirmation early',
  'GET /api/vault/status': 'scripts; the web app reads the vault state from /auth/status',
  // the plant map: the map library reads these from the style the web app points it to (mapShared.tsx)
  'GET /api/plant/map/tiles/:layer/:z/:x/:y': 'map tiles, read by the map library',
  'GET /api/plant/map/glyphs/:fontstack/:range': 'map fonts, read by the map library',
  'GET /api/plant/map/sprites/:sprite': 'map icons, read by the map library',
  // 0.13.0: a draft's operation changed in place – the web app saves the entry's form again (one operation per entry)
  'PUT /api/plant/change-sets/:changeSetId/operations/:seq': 'scripts change an operation of a draft; the web app saves the form again',
  // command line tools
  'POST /api/platforms/:id/contract-check': 'npm run contract (server/src/cli/contract.ts)',
  // internal API for scripts: a single entry the web app reads as part of a list, or a step it does another way
  'GET /api/ai/usage': 'AI usage log for scripts (docs/AI.md); the web app shows it per platform',
  'GET /api/assurance/policy/as-of': 'the policy in force at a time (docs/ASSURANCE.md)',
  'GET /api/compliance/access-changes/:accessChangeId': 'one access change; the web app reads the list',
  'GET /api/compliance/access-checks/:accessCheckId': 'one access check; the web app reads the list',
  'GET /api/compliance/access-checks/:accessCheckId/snapshots/:snapshotId': 'one snapshot; the web app reads the list',
  'GET /api/compliance/controls/:controlId': 'one control; the web app reads the coverage list',
  'GET /api/compliance/tagged': 'controls tagged on an object, for scripts',
  'GET /api/datasets/:key/sources': 'the sources of a dataset, for scripts',
  'GET /api/library-releases/:id': 'one release; the web app reads its review',
  'POST /api/libraries/:library/rollback': 'rollback for scripts; the web app installs the previous release from its page',
  'POST /api/monitors/validate': 'checks a monitor definition, for scripts',
  'GET /api/monitors/:id/maintenance': 'deprecated in 0.11, kept for scripts (use /api/maintenance-windows)',
  'DELETE /api/monitors/:id/maintenance/:wid': 'deprecated in 0.11, kept for scripts (use /api/maintenance-windows)',
  'POST /api/processes/to-yaml': 'turns a definition into YAML, for scripts',
  'GET /api/records/:id/editions': 'the editions of a record; the web app reads them with the record',
  'GET /api/records/:id/reviews': 'the reviews of a record; the web app reads them with the record',
  'GET /api/records/:id/versions/:version': 'one version of a record; the web app reads the list',
  'GET /api/report-schedules/:id/reports': 'the reports of a schedule, for scripts',
  'GET /api/runs/:id/report.pdf': 'a report in one step, for scripts (docs/REPORTS.md)',
  'GET /api/settings': 'all settings at once, for scripts; the web app reads each area',
  'PUT /api/settings': 'all settings at once, for scripts; the web app writes each area',
  'GET /api/status-pages/:pageId': 'one status page; the web app reads the list and the view',
  'GET /api/sync-sources/:id': 'one Git sync source; the web app reads the list',
  'GET /api/tasks/:id': 'one manual task; the web app reads it with its run',
  // no page yet: the API is complete, the web app has not caught up
  'DELETE /api/compliance/access-checks/:accessCheckId': 'removing an access check',
  'POST /api/compliance/catalogues': 'own control catalogues (the web app imports catalogues)',
  'PUT /api/compliance/catalogues/:catalogueId': 'own control catalogues',
  'DELETE /api/compliance/catalogues/:catalogueId': 'own control catalogues',
  'POST /api/compliance/catalogues/:catalogueId/controls': 'own control catalogues',
  'PUT /api/library-keys/:id': "changing a signing key's expiry",
};

/** Call sites whose URL the parser cannot follow, by file and call text, with the routes they call. */
const DYNAMIC: Record<string, string[]> = {};

type Call = { where: string; method: string; url: string };
const PLACEHOLDER = '\u0000';
const ANY = '*';

function webFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? webFiles(p) : /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

/** The function a parameter belongs to, and its name in this file (function declaration, or `const f = (…) =>`). */
function functionName(fn: ts.SignatureDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return undefined;
}

/** Every web source file, parsed once. */
const SOURCES: Extractor[] = [];

class Extractor {
  private seen = new Set<ts.Node>();
  constructor(readonly sf: ts.SourceFile) {}

  /** The URL templates an expression can evaluate to, or undefined when it cannot be followed. */
  urls(e: ts.Expression | undefined): string[] | undefined {
    if (!e || this.seen.has(e)) return undefined;
    this.seen.add(e);
    try {
      return this.eval(e);
    } finally {
      this.seen.delete(e);
    }
  }

  private eval(e: ts.Expression): string[] | undefined {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) return this.urls(e.expression);
    if (ts.isTemplateExpression(e)) {
      let acc = [e.head.text];
      for (const span of e.templateSpans) {
        // a constant or a URL helper inside the template is followed, any other value is a placeholder
        const inner =
          ts.isIdentifier(span.expression) || ts.isCallExpression(span.expression) || ts.isConditionalExpression(span.expression)
            ? this.urls(span.expression)
            : undefined;
        const parts = inner ?? [PLACEHOLDER];
        acc = acc.flatMap((a) => parts.map((p) => a + p + span.literal.text));
      }
      return acc;
    }
    if (ts.isConditionalExpression(e)) {
      const a = this.urls(e.whenTrue);
      const b = this.urls(e.whenFalse);
      return a && b ? [...a, ...b] : undefined;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = this.urls(e.left);
      const b = this.urls(e.right) ?? [PLACEHOLDER];
      return a?.flatMap((x) => b.map((y) => x + y));
    }
    if (ts.isIdentifier(e)) return this.identifier(e);
    if (ts.isCallExpression(e)) return this.call(e);
    return undefined;
  }

  /** `helper(x)` with `const helper = (…) => `…``, or `TABLE[kind](id)` with a table of such functions. */
  private call(e: ts.CallExpression): string[] | undefined {
    const bodies: ts.Expression[] = [];
    const fnBody = (f: ts.Node | undefined) => {
      if (f && (ts.isArrowFunction(f) || ts.isFunctionExpression(f))) {
        if (!ts.isBlock(f.body)) bodies.push(f.body);
        else for (const st of f.body.statements) if (ts.isReturnStatement(st) && st.expression) bodies.push(st.expression);
      }
    };
    if (ts.isIdentifier(e.expression)) {
      const d = this.declaration(e.expression.text, e.expression);
      if (d && ts.isFunctionDeclaration(d)) {
        for (const st of d.body?.statements ?? []) if (ts.isReturnStatement(st) && st.expression) bodies.push(st.expression);
      } else fnBody(d);
    } else if (ts.isElementAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
      const table = this.declaration(e.expression.expression.text, e.expression.expression);
      const obj = table && !ts.isFunctionDeclaration(table) ? stripType(table) : undefined;
      if (obj && ts.isObjectLiteralExpression(obj)) for (const p of obj.properties) if (ts.isPropertyAssignment(p)) fnBody(p.initializer);
    }
    if (!bodies.length) return undefined;
    const out: string[] = [];
    for (const b of bodies) {
      const u = this.urls(b);
      if (!u) return undefined;
      out.push(...u);
    }
    return out;
  }

  private identifier(id: ts.Identifier): string[] | undefined {
    const d = this.declaration(id.text, id);
    if (d && !ts.isFunctionDeclaration(d)) return this.urls(d);
    // a parameter: the arguments of every call of its function (or the attribute of every element of its component)
    const param = this.parameter(id.text, id);
    if (!param) return undefined;
    const { fn, index, prop } = param;
    // a parameter typed as a union of string literals (`to: 'attachments' | 'evidence'`) takes one of them
    const declared = fn.parameters[index]!;
    const literals = prop === undefined ? stringLiterals(declared.type) : undefined;
    if (literals) return literals;
    const name = functionName(fn);
    if (!name) return undefined;
    // a function's calls in this file; a component's elements in every file
    const args: { x: Extractor; e: ts.Expression }[] = [];
    for (const x of prop === undefined ? [this as Extractor] : SOURCES) {
      const visit = (n: ts.Node) => {
        if (prop === undefined && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
          // a left-out argument takes the parameter's default
          const a = n.arguments[index] ?? declared.initializer;
          if (a) args.push({ x, e: a });
        }
        if (prop !== undefined && (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName) && n.tagName.text === name) {
          for (const a of n.attributes.properties)
            if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === prop && a.initializer) {
              if (ts.isStringLiteral(a.initializer)) args.push({ x, e: a.initializer });
              else if (ts.isJsxExpression(a.initializer) && a.initializer.expression) args.push({ x, e: a.initializer.expression });
            }
        }
        ts.forEachChild(n, visit);
      };
      visit(x.sf);
    }
    if (!args.length) return undefined;
    const out: string[] = [];
    for (const a of args) {
      const u = a.x.urls(a.e);
      if (!u) return undefined;
      out.push(...u);
    }
    return out;
  }

  /** The initializer of the nearest `const`/`let` of that name in scope, or a function declaration. */
  private declaration(name: string, from: ts.Node): ts.Expression | ts.FunctionDeclaration | undefined {
    for (let n: ts.Node | undefined = from.parent; n; n = n.parent) {
      if (ts.isFunctionLike(n) && n.parameters.some((p) => bindsName(p.name, name))) return undefined;
      if (!(ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n))) continue;
      for (const st of n.statements) {
        if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
        if (ts.isVariableStatement(st))
          for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
      }
    }
    return undefined;
  }

  private parameter(name: string, from: ts.Node): { fn: ts.SignatureDeclaration; index: number; prop?: string } | undefined {
    for (let n: ts.Node | undefined = from.parent; n; n = n.parent) {
      if (!ts.isFunctionLike(n)) continue;
      const index = n.parameters.findIndex((p) => bindsName(p.name, name));
      if (index < 0) continue;
      const p = n.parameters[index]!;
      return ts.isIdentifier(p.name) ? { fn: n, index } : { fn: n, index, prop: name };
    }
    return undefined;
  }
}

function stringLiterals(t: ts.TypeNode | undefined): string[] | undefined {
  if (!t) return undefined;
  const parts = ts.isUnionTypeNode(t) ? t.types : [t];
  const out = parts.map((p) => (ts.isLiteralTypeNode(p) && ts.isStringLiteral(p.literal) ? p.literal.text : undefined));
  return out.every((x) => x !== undefined) ? (out as string[]) : undefined;
}

function stripType(e: ts.Expression): ts.Expression {
  return ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) ? stripType(e.expression) : e;
}

function bindsName(b: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(b)) return b.text === name;
  return b.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, name));
}

/** The method a `fetch(url, { method })` call uses (GET without one). */
function fetchMethod(call: ts.CallExpression): string[] | undefined {
  const parent = call.parent;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== call || !ts.isIdentifier(parent.expression) || parent.expression.text !== 'fetch') return ['GET'];
  const init = parent.arguments[1];
  if (!init || !ts.isObjectLiteralExpression(init)) return init ? undefined : ['GET'];
  const m = init.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'method');
  if (!m) return ['GET'];
  return ts.isStringLiteral(m.initializer) ? [m.initializer.text.toUpperCase()] : undefined;
}

function webCalls(): { calls: Call[]; dynamic: string[] } {
  const calls: Call[] = [];
  const dynamic: string[] = [];
  for (const file of webFiles(WEB)) {
    if (file === API_MODULE || file === BASE_MODULE) continue;
    SOURCES.push(
      new Extractor(
        ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
      ),
    );
  }
  for (const x of SOURCES) {
    const sf = x.sf;
    const rel = path.relative(WEB, sf.fileName).split(path.sep).join('/');
    const local = new Map<string, { module: 'api' | 'base'; name: string }>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue;
      const target = path.resolve(path.dirname(sf.fileName), st.moduleSpecifier.text);
      const module = target + '.ts' === API_MODULE ? 'api' : target + '.ts' === BASE_MODULE ? 'base' : undefined;
      const bindings = st.importClause?.namedBindings;
      if (!module || !bindings || !ts.isNamedImports(bindings)) continue;
      for (const el of bindings.elements) {
        const name = (el.propertyName ?? el.name).text;
        if (module === 'api' ? name in API_HELPERS : BASE_HELPERS.has(name) || name === 'BASE_PATH') local.set(el.name.text, { module, name });
      }
    }
    if (!local.size) continue;
    const visit = (n: ts.Node) => {
      // `${BASE_PATH}/api/…`: a link the browser follows (an image, a map style); one ending in "/" is a prefix
      if (ts.isTemplateExpression(n)) {
        const i = n.templateSpans.findIndex((sp) => ts.isIdentifier(sp.expression) && local.get(sp.expression.text)?.name === 'BASE_PATH');
        const rest = n.templateSpans[i]?.literal.text;
        if (rest?.startsWith('/api/') && !(i === n.templateSpans.length - 1 && rest.endsWith('/'))) {
          let urls = [rest.slice('/api'.length)];
          for (const sp of n.templateSpans.slice(i + 1)) urls = urls.map((u) => u + PLACEHOLDER + sp.literal.text);
          const where = `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
          for (const url of urls) calls.push({ where, method: 'GET', url });
        }
      }
      const helper = ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? local.get(n.expression.text) : undefined;
      if (helper && helper.name !== 'BASE_PATH' && ts.isCallExpression(n)) {
        const where = `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
        const urlArg = helper.name === 'api' ? n.arguments[1] : n.arguments[0];
        let urls = x.urls(urlArg);
        // appUrl() builds an address to copy (a webhook, the MCP endpoint): any method of the route will do
        let methods =
          helper.name === 'appUrl'
            ? [ANY]
            : helper.module === 'base'
              ? fetchMethod(n)
              : helper.name === 'api'
                ? x.urls(n.arguments[0])
                : [API_HELPERS[helper.name]!];
        if (helper.module === 'base') {
          // app-relative links outside the API (pages, files) and addresses the server hands out are not this test's business
          urls = (urls ?? []).filter((u) => u.startsWith('/api/')).map((u) => u.slice('/api'.length));
          if (!urls.length) methods = [];
        }
        const key = `${rel} ${n.expression.getText()}(${urlArg?.getText() ?? ''})`;
        if (DYNAMIC[key]) {
          dynamic.push(key);
          for (const k of DYNAMIC[key]) {
            const [method, url] = k.split(' ') as [string, string];
            calls.push({ where, method, url: url.replace(/^\/api/, '') });
          }
        } else if (!urls || !methods) {
          calls.push({ where: `${where} (cannot follow ${key} – name its routes in DYNAMIC)`, method: '?', url: '?' });
        } else for (const method of methods) for (const url of urls) calls.push({ where, method, url });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { calls, dynamic };
}

type Route = { method: string; url: string };

/** One path segment of a web URL template against one of a route: a placeholder stands for any text. */
function segmentMatches(web: string, route: string): boolean {
  if (route.startsWith(':')) return web.length > 0;
  if (!web.includes(PLACEHOLDER)) return web === route;
  const re = web
    .split(PLACEHOLDER)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`).test(route);
}

function callMatches(call: Call, route: Route): boolean {
  if (call.method !== route.method && call.method !== ANY) return false;
  const full = '/api' + call.url.split('?')[0]!.split('#')[0]!;
  const ws = full.split('/');
  const rs = route.url.split('/');
  if (rs.at(-1) === '*') return ws.length >= rs.length && rs.slice(0, -1).every((s, i) => segmentMatches(ws[i]!, s));
  return ws.length === rs.length && rs.every((s, i) => segmentMatches(ws[i]!, s));
}

/** API_ONLY entries: exact "METHOD /url", or "METHOD /prefix/*" for everything below the prefix. */
function allowed(route: Route): string | undefined {
  const k = `${route.method} ${route.url}`;
  if (API_ONLY[k]) return k;
  return Object.keys(API_ONLY).find((a) => {
    if (!a.endsWith('/*') || !a.startsWith(route.method + ' ')) return false;
    const prefix = a.slice(route.method.length + 1, -2);
    // "GET /*" is the web UI's own route, not a prefix
    return prefix !== '' && route.url.startsWith(prefix + '/');
  });
}

let s: TestServer;
let routes: Route[] = [];
let calls: Call[] = [];
let dynamic: string[] = [];

// parses every source file of the web app (about 30 s of CPU on a developer machine): more than the default hook time
// on a shared CI runner with other test files beside it
beforeAll(async () => {
  s = await startTestServer();
  const { registeredRoutes } = await import('../src/app.js');
  routes = registeredRoutes(s.app)
    .filter((r) => !r.url.startsWith('/mock/'))
    .map(({ method, url }) => ({ method, url }));
  ({ calls, dynamic } = webCalls());
}, 180_000);
afterAll(async () => {
  await s?.app.close();
});

describe('web ↔ server route contract', () => {
  it('finds the web app’s API calls', () => {
    expect(calls.length).toBeGreaterThan(700);
    expect(routes.length).toBeGreaterThan(700);
  });

  it('calls only routes the server registers (method and path)', () => {
    const unknown = calls
      .filter((c) => !routes.some((r) => callMatches(c, r)))
      .map((c) => `${c.where}: ${c.method} /api${c.url.replaceAll(PLACEHOLDER, '{…}')}`);
    expect(unknown, 'web calls without a server route').toEqual([]);
  });

  it('calls every internal route, or names it in API_ONLY', () => {
    const unused = routes
      .filter((r) => !allowed(r) && !calls.some((c) => callMatches(c, r)))
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(unused, 'routes neither the web app calls nor API_ONLY names').toEqual([]);
  });

  it('keeps API_ONLY and DYNAMIC current', () => {
    const exact = Object.keys(API_ONLY).filter((k) => !k.endsWith('/*'));
    const keys = new Set(routes.map((r) => `${r.method} ${r.url}`));
    // which of the two web UI routes exists depends on whether web/dist is built
    expect(
      exact.filter((k) => !keys.has(k) && k !== 'GET /' && k !== 'GET /*'),
      'API_ONLY entries without a route',
    ).toEqual([]);
    expect(
      Object.keys(API_ONLY).filter((k) => k.endsWith('/*') && k !== 'GET /*' && !routes.some((r) => allowed(r) === k)),
      'API_ONLY prefixes without a route',
    ).toEqual([]);
    const called = routes.filter((r) => exact.includes(`${r.method} ${r.url}`) && calls.some((c) => callMatches(c, r))).map((r) => `${r.method} ${r.url}`);
    expect(called, 'API_ONLY entries the web app calls after all').toEqual([]);
    expect(
      Object.keys(DYNAMIC).filter((k) => !dynamic.includes(k)),
      'DYNAMIC entries without a call site',
    ).toEqual([]);
  });
});
