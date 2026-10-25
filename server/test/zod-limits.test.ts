import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { boundedRecord, validateProcess } from '@sm/shared';
import { DEFAULT_BODY_SHAPE } from '../src/bodyShape.js';
import { authHeaders, loginCookie, setup, startTestServer, ADMIN, type TestServer } from './helpers.js';

/**
 * Zod keeps one issue per failing array element or record value (GHSA-mrhx-c7xc-m3w5). Since zod
 * 4.6.6 an array with `.max()` stops before it checks any element; a record gets the same from
 * `boundedRecord` (shared/src/zodLimits.ts). These tests check that every array and record a schema
 * reads from input has such a limit, and that the limit stops validation early.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCES = ['server/src', 'shared/src'];
/** Response schemas (OpenAPI only, never parsed): only their query schemas (`…Query`) read input. */
const RESPONSE_SCHEMAS = /(^|\/)(api-schemas|api\/v1\/schemas)\.ts$/;
/** A schema that never reads input says why on its line or the line before. */
const EXEMPT = 'zod-unbounded:';
/** Methods that may come before the length limit without disabling its early stop. */
const BEFORE_MAX = new Set(['min', 'nonempty']);

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

/** Method names called on the result of `node`, in order (`z.array(x).min(1).max(5).optional()` → min, max, optional). */
function chain(node: ts.Node): string[] {
  const out: string[] = [];
  let cur = node;
  while (ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur && ts.isCallExpression(cur.parent.parent)) {
    out.push(cur.parent.name.text);
    cur = cur.parent.parent;
  }
  return out;
}

function zodCall(node: ts.Node, name: string): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === name &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'z'
  );
}

function unbounded(): string[] {
  const problems: string[] = [];
  for (const file of SOURCES.flatMap((d) => files(path.join(ROOT, d)))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (rel === 'shared/src/zodLimits.ts') continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes("from 'zod'")) continue;
    const lines = text.split('\n');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const responseFile = RESPONSE_SCHEMAS.test(rel);
    const inQuery = (n: ts.Node): boolean => {
      for (let p: ts.Node | undefined = n; p; p = p.parent) if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return /Query$/.test(p.name.text);
      return false;
    };
    const visit = (n: ts.Node): void => {
      const isArray =
        zodCall(n, 'array') ||
        (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'array' && n.arguments.length === 0);
      const isRecord = zodCall(n, 'record');
      if ((isArray || isRecord) && (!responseFile || inQuery(n))) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line;
        const exempt = lines[line]!.includes(EXEMPT) || (line > 0 && lines[line - 1]!.includes(EXEMPT));
        if (!exempt) {
          const where = `${rel}:${line + 1}`;
          if (isRecord) problems.push(`${where}: z.record without a key limit – use boundedRecord()`);
          else {
            const c = chain(n);
            const i = c.findIndex((m) => m === 'max' || m === 'length');
            if (i < 0 || c.slice(0, i).some((m) => !BEFORE_MAX.has(m))) problems.push(`${where}: z.array without .max() right after it`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return problems;
}

describe('zod length limits', () => {
  it('every input array has .max() and every input record a key limit', () => {
    expect(unbounded()).toEqual([]);
  });

  it('stops at the length limit of an array before it checks any element', () => {
    // 2 million invalid items: zod 3 (and zod 4 without .max()) keeps one issue per item
    const nodes = Array.from({ length: 2_000_000 }, () => 1);
    const t = Date.now();
    const r = validateProcess({ name: 'x', nodes });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([expect.objectContaining({ path: 'nodes', message: expect.stringMatching(/Too big/) })]);

    // the same array without a limit: one issue per item
    expect(z.array(z.string()).safeParse(nodes.slice(0, 1000)).error?.issues).toHaveLength(1000);
  });

  it('stops at the key limit of a record before it checks any value', () => {
    const schema = z.object({ inputs: boundedRecord(z.string(), 100) });
    const inputs = Object.fromEntries(Array.from({ length: 200_000 }, (_, i) => [`k${i}`, i]));
    const t = Date.now();
    const r = schema.safeParse({ inputs });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.error?.issues).toEqual([expect.objectContaining({ code: 'too_big', path: ['inputs'], maximum: 100 })]);
    // within the limit the values are checked as before
    expect(schema.safeParse({ inputs: { a: 1 } }).error?.issues).toEqual([expect.objectContaining({ code: 'invalid_type', path: ['inputs', 'a'] })]);
    expect(schema.parse({ inputs: { a: 'b' } })).toEqual({ inputs: { a: 'b' } });
    // arrays are not records
    expect(schema.safeParse({ inputs: ['a'] }).success).toBe(false);
  });
});

describe('length limits of request bodies', () => {
  let s: TestServer;
  let admin: Record<string, string>;
  beforeAll(async () => {
    s = await startTestServer();
    await setup(s);
    admin = authHeaders(await loginCookie(s.base, ADMIN.username, ADMIN.password));
  });
  afterAll(async () => {
    await s?.app.close();
  });
  const post = async (url: string, body: unknown) => {
    const res = await fetch(s.base + '/api' + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1', ...admin },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { code?: string; error?: string; params?: { details?: string } } };
  };

  it('refuses a list longer than its limit with one issue, not one per item', async () => {
    // within the body shape limits (bodyShape.ts), so only the schema stops it
    const tags = Array.from({ length: DEFAULT_BODY_SHAPE.arrayItems - 1 }, (_, i) => i);
    const r = await post('/records', { type: 'CR', title: 'x', tags });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_INPUT');
    expect(r.body.params?.details).toBe('tags: Too big: expected array to have <=30 items');
  });

  it('refuses a map with more keys than its limit with one issue, not one per value', async () => {
    const inputs = Object.fromEntries(Array.from({ length: DEFAULT_BODY_SHAPE.objectKeys - 1 }, (_, i) => [`k${i}`, i]));
    const r = await post('/schedules', { name: 'x', processId: 'p', cron: '0 * * * *', inputs, bindings: inputs });
    expect(r.status).toBe(400);
    expect(r.body.params?.details).toBe('inputs: Too big: expected object to have <=200 entries; bindings: Too big: expected object to have <=100 entries');
  });
});
