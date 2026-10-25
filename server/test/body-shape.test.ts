import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bodyShapeProblem, DEFAULT_BODY_SHAPE, IMPORT_BODY_SHAPE } from '../src/bodyShape.js';
import { authHeaders, loginCookie, setup, startTestServer, ADMIN, type TestServer } from './helpers.js';

/**
 * Limits on the shape of parsed request bodies (server/src/bodyShape.ts): zod keeps one issue per
 * failing array element, also above `.max()`, so a large body could make validation allocate gigabytes
 * (GHSA-mrhx-c7xc-m3w5).
 */
let s: TestServer;
let admin: Record<string, string>;

async function post(url: string, body: string, headers: Record<string, string> = admin): Promise<{ status: number; body: any }> {
  const res = await fetch(s.base + '/api' + url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sm-client': '1', ...headers }, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const nested = (depth: number): unknown => (depth <= 1 ? {} : { a: nested(depth - 1) });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  admin = authHeaders(await loginCookie(s.base, ADMIN.username, ADMIN.password));
});
afterAll(async () => {
  await s?.app.close();
});

describe('body shape limits', () => {
  it('names the first limit a value exceeds', () => {
    const l = { arrayItems: 3, objectKeys: 3, values: 10, depth: 3 };
    expect(bodyShapeProblem({ a: [1, 2, 3], b: { c: 1 } }, l)).toBeNull();
    expect(bodyShapeProblem([1, 2, 3, 4], l)).toEqual({ limit: 'arrayItems', max: 3 });
    expect(bodyShapeProblem({ a: 1, b: 2, c: 3, d: 4 }, l)).toEqual({ limit: 'objectKeys', max: 3 });
    expect(bodyShapeProblem({ a: [1, 2, 3], b: [1, 2, 3], c: [1, 2, 3] }, l)).toEqual({ limit: 'values', max: 10 });
    expect(bodyShapeProblem({ a: { b: { c: {} } } }, l)).toEqual({ limit: 'depth', max: 3 });
    // scalars, raw webhook bodies and no body at all are not walked
    for (const v of [undefined, null, 'text', 42, Buffer.from('[1,2,3,4,5]')]) expect(bodyShapeProblem(v, l)).toBeNull();
    // deep nesting doesn't overflow the stack
    let deep: unknown = {};
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(bodyShapeProblem(deep, DEFAULT_BODY_SHAPE)).toEqual({ limit: 'depth', max: DEFAULT_BODY_SHAPE.depth });
  });

  it('refuses a body with millions of list items quickly, before the route validates it', async () => {
    // 12 million items, 24 MB: zod 3 needed 18 s and 3 GB for this. Ordinary routes refuse such a body by its
    // size (1 MB, bodyLimits.ts); the bundle import accepts 25 MB, so its shape limits must hold.
    const body = '{"bundle":{"format":"steward-bundle/1","processes":[' + '1,'.repeat(12_000_000) + '1]}}';
    const heap = process.memoryUsage().heapUsed;
    const t = Date.now();
    const r = await post('/bundle/import', body);
    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ code: 'BODY_TOO_COMPLEX', params: { limit: IMPORT_BODY_SHAPE.arrayItems } });
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(1024 * 1024 * 1024);
  });

  it('refuses too many items in one list, fields in one object, values or levels', async () => {
    const big = DEFAULT_BODY_SHAPE.arrayItems + 1;
    expect((await post('/records', JSON.stringify({ tags: Array(big).fill('t') }))).body.code).toBe('BODY_TOO_COMPLEX');
    expect((await post('/records', JSON.stringify({ fields: Object.fromEntries(Array.from({ length: big }, (_, i) => [`f${i}`, 1])) }))).body.code).toBe(
      'BODY_TOO_COMPLEX',
    );
    const many = Array.from({ length: 30 }, () => Array(DEFAULT_BODY_SHAPE.values / 20).fill(0));
    expect(await post('/records', JSON.stringify({ many }))).toMatchObject({ status: 413, body: { params: { limit: DEFAULT_BODY_SHAPE.values } } });
    expect(await post('/records', JSON.stringify(nested(DEFAULT_BODY_SHAPE.depth + 1)))).toMatchObject({
      status: 413,
      body: { params: { limit: DEFAULT_BODY_SHAPE.depth } },
    });
    // within the limits the route answers as before (validation error, not 413)
    const ok = await post('/records', JSON.stringify(nested(DEFAULT_BODY_SHAPE.depth)));
    expect(ok.status).not.toBe(413);
  });

  it('allows larger bodies on the import routes', async () => {
    const processes = Array.from({ length: DEFAULT_BODY_SHAPE.arrayItems + 1 }, () => ({}));
    const r = await post('/bundle/import', JSON.stringify({ bundle: { format: 'steward-bundle/1', processes }, onConflict: 'skip' }));
    expect(r.status).not.toBe(413);
    const tooMany = Array.from({ length: IMPORT_BODY_SHAPE.arrayItems + 1 }, () => 0);
    expect((await post('/bundle/import', JSON.stringify({ bundle: { processes: tooMany } }))).status).toBe(413);
  });

  it('refuses a body without a length from clients that are not signed in', async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify({ username: 'admin', password: 'x' })));
        c.close();
      },
    });
    const res = await fetch(s.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(411);
    // with a length, sign-in works as before
    expect((await post('/auth/login', JSON.stringify({ username: ADMIN.username, password: ADMIN.password }), {})).status).toBe(200);
  });
});
