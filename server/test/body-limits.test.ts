import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as BodyLimits from '../src/bodyLimits.js';
import { authHeaders, loginCookie, setup, startTestServer, ADMIN, type TestServer } from './helpers.js';

/**
 * Request body limits (server/src/bodyLimits.ts): 1 MB by default, larger only on the import and
 * definition routes named in LARGE_BODIES. The route matrix test checks that no other route sets more.
 */
let s: TestServer;
let admin: Record<string, string>;
// imported after the test server has set its data folder (the module loads the configuration)
let bodyTooLarge: typeof BodyLimits.bodyTooLarge;
let DEFAULT_BODY_LIMIT: number;
let LARGE_BODIES: typeof BodyLimits.LARGE_BODIES;
const MB = 1024 * 1024;

async function send(method: string, url: string, body: string | FormData): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'x-sm-client': '1', ...admin };
  if (typeof body === 'string') headers['content-type'] = 'application/json';
  const res = await fetch(s.base + '/api' + url, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}
/** A JSON body of about `bytes` bytes that no route accepts as valid input. */
const padded = (bytes: number) => JSON.stringify({ pad: 'x'.repeat(bytes - 10) });
/** A route of LARGE_BODIES with its path parameters filled in. */
const target = (route: string) => {
  const [method, url] = route.split(' ') as [string, string];
  return { method, url: url.replace(/^\/api/, '').replace(/:[a-zA-Z]+/g, 'x') };
};

beforeAll(async () => {
  s = await startTestServer();
  ({ bodyTooLarge, DEFAULT_BODY_LIMIT, LARGE_BODIES } = await import('../src/bodyLimits.js'));
  await setup(s);
  admin = authHeaders(await loginCookie(s.base, ADMIN.username, ADMIN.password));
});
afterAll(async () => {
  await s?.app.close();
});

describe('request body limits', () => {
  it('refuses a body above 1 MB on an ordinary route with 413 BODY_TOO_LARGE', async () => {
    expect(s.app.initialConfig.bodyLimit).toBe(DEFAULT_BODY_LIMIT);
    const r = await send('POST', '/records', padded(1.5 * MB));
    expect(r).toMatchObject({ status: 413, body: { code: 'BODY_TOO_LARGE', params: { maxMb: 1 } } });
    expect(r.body.error).toBe('The request is too large (at most 1 MB)');
    // just below the limit the route answers as before (validation, not 413)
    expect((await send('POST', '/records', padded(DEFAULT_BODY_LIMIT - 1024))).status).toBe(400);
    // routes with a smaller limit of their own name it in KB
    expect(await send('POST', '/audit/verify', padded(300 * 1024))).toMatchObject({
      status: 413,
      body: { code: 'BODY_TOO_LARGE_KIB', params: { maxKib: 256 } },
    });
  });

  it('accepts bodies above 1 MB on each large route, up to its own limit', async () => {
    for (const [name, l] of Object.entries(LARGE_BODIES)) {
      expect(l.bytes, name).toBeGreaterThan(DEFAULT_BODY_LIMIT);
      for (const route of l.routes) {
        const { method, url } = target(route);
        // past the body limit: whatever the route then says about the content (400, 403, 404 …), it is not 413
        expect((await send(method, url, padded(Math.min(1.25 * MB, l.bytes - 1024)))).status, route).not.toBe(413);
      }
      const { method, url } = target(l.routes[0]!);
      const over = await send(method, url, padded(l.bytes + 1024));
      expect(over, name).toMatchObject({ status: 413, body: { code: 'BODY_TOO_LARGE', params: bodyTooLarge(l.bytes).params } });
    }
  }, 120_000);

  it('imports content above 1 MB on the import and definition routes', async () => {
    // records: five Markdown files of 240 KB each (the import takes 2 MB together)
    const files = Array.from({ length: 5 }, (_, i) => ({ filename: `big-${i}.md`, content: `# Big decision ${i}\n\n` + 'Text. '.repeat(40_000) }));
    const body = JSON.stringify({ type: 'DR', files });
    expect(body.length).toBeGreaterThan(1.1 * MB);
    const imported = await send('POST', '/records/import', body);
    expect(imported.status).toBe(200);
    expect(imported.body.every((i: { ok: boolean }) => i.ok)).toBe(true);

    // a process definition of 1.5 MB as YAML text (the definition text may have 2 MB)
    const yaml = 'name: Big process\nsteps:\n  - id: log\n    type: log\n    message: hello\n' + '# a long comment line of the exported file\n'.repeat(38_000);
    expect(yaml.length).toBeGreaterThan(1.5 * MB);
    const created = await send('POST', '/processes', JSON.stringify({ text: yaml }));
    expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(200);
  }, 60_000);

  it('leaves multipart uploads to the file limits of their routes', async () => {
    const files = [{ filename: 'with-attachment.md', content: '# With an attachment\n\nText.\n' }];
    const imported = await send('POST', '/records/import', JSON.stringify({ type: 'DR', files }));
    const id = imported.body[0].id ?? imported.body[0].record?.id;
    expect(id, JSON.stringify(imported.body)).toBeTruthy();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(Buffer.alloc(1.5 * MB, 0x41))]), 'notes.txt');
    expect((await send('POST', `/records/${id}/attachments`, form)).status).toBe(200);
  });
});
