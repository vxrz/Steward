import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, type TestServer } from './helpers.js';

// Regression tests for security review A (authentication, authorization, uploads).
let s: TestServer;
let platformId = '';
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  platformId = (await s.api<{ id: string; kind: string }[]>('GET', '/platforms')).find((p) => p.kind === 'insights-hub')!.id;
});
afterAll(async () => s.app.close());

/** Sends a raw HTTP/1.1 request and returns the status code. */
function raw(requestLine: string, headers: string[] = []): Promise<number> {
  const { port } = new URL(s.base);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), '127.0.0.1', () => {
      sock.write([requestLine, `Host: localhost:${port}`, 'Connection: close', ...headers, '', ''].join('\r\n'));
    });
    let data = '';
    sock.on('data', (d) => (data += d.toString()));
    sock.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
    sock.on('error', reject);
  });
}

async function upload(name: string, type: string, content: Buffer | string): Promise<string> {
  const login = await fetch(`${s.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin-password-1' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const sessionKey = login.headers.get('x-sm-session-key')!;
  const fd = new FormData();
  fd.set('title', name);
  fd.set('file', new Blob([typeof content === 'string' ? content : new Uint8Array(content)], { type }), name);
  const res = await fetch(`${s.base}/api/platforms/${platformId}/docs`, {
    method: 'POST',
    headers: { 'x-sm-client': '1', cookie, 'x-sm-session': sessionKey },
    body: fd,
  });
  expect(res.ok).toBe(true);
  const doc = (await res.json()) as { id: string };
  return doc.id;
}

describe('request targets', () => {
  it('rejects absolute-form request targets instead of skipping authentication', async () => {
    expect(await raw('GET http://evil.example/api/subjects HTTP/1.1')).toBe(400);
    expect(await raw('GET http://evil.example/api/platforms HTTP/1.1')).toBe(400);
  });
  it('requires sign-in for encoded spellings of API paths', async () => {
    expect(await raw('GET /api/subjects HTTP/1.1')).toBe(401);
    for (const p of ['/%61pi/subjects', '/api/%73ubjects', '/api//subjects']) expect([401, 403, 404]).toContain(await raw(`GET ${p} HTTP/1.1`));
  });
});

describe('uploaded platform documents', () => {
  const fileOf = async (id: string) => {
    const res = await fetch(`${s.base}/api/docs/${id}/file`, { headers: authHeaders(await adminCookie()) });
    return {
      type: res.headers.get('content-type') ?? '',
      disposition: res.headers.get('content-disposition') ?? '',
      csp: res.headers.get('content-security-policy') ?? '',
    };
  };
  let cookie = '';
  const adminCookie = async () => {
    if (cookie) return cookie;
    return (cookie = await loginCookie(s.base, 'admin', 'Admin-password-1'));
  };
  it('serves HTML, SVG and JavaScript uploads as downloads, never as pages or scripts', async () => {
    for (const [name, type, body] of [
      ['x.html', 'text/html', '<script src="/api/docs/x/file"></script>'],
      ['x.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      ['x.js', 'application/javascript', 'alert(1)'],
    ] as const) {
      const f = await fileOf(await upload(name, type, body));
      expect(f.type).toContain('application/octet-stream');
      expect(f.disposition).toMatch(/^attachment/);
      expect(f.csp).toContain('sandbox');
    }
  });
  it('shows PDFs inline, typed by their content', async () => {
    const f = await fileOf(await upload('manual.pdf', 'text/html', '%PDF-1.7\n%…'));
    expect(f.type).toBe('application/pdf');
    expect(f.disposition).toMatch(/^inline/);
  });
  it('accepts only http(s) links', async () => {
    await expect(s.api('POST', `/platforms/${platformId}/docs`, { title: 'x', kind: 'link', url: 'javascript:alert(1)' })).rejects.toMatchObject({
      status: 400,
    });
    await s.api('POST', `/platforms/${platformId}/docs`, { title: 'ok', kind: 'link', url: 'https://example.com/docs' });
  });
});

describe('least privilege for read-only accounts', () => {
  it('hides users, teams, settings and platforms from viewers', async () => {
    const vera = await s.as('vera', 'Demo-password-1');
    await expect(vera('GET', '/subjects')).rejects.toMatchObject({ status: 403 });
    await expect(vera('GET', '/teams')).rejects.toMatchObject({ status: 403 });
    await expect(vera('GET', '/settings')).rejects.toMatchObject({ status: 403 });
    expect(await vera('GET', '/platforms')).toEqual([]);
    await expect(vera('GET', `/platforms/${platformId}`)).rejects.toMatchObject({ status: 404 });
    await expect(vera('GET', `/platforms/${platformId}/docs`)).rejects.toMatchObject({ status: 404 });
  });
  it('still lets designers pick subjects and use platforms', async () => {
    const dana = await s.as('dana', 'Demo-password-1');
    expect((await dana('GET', '/subjects')).length).toBeGreaterThan(0);
    expect((await dana('GET', '/platforms')).length).toBeGreaterThan(0);
  });
});

describe('sessions', () => {
  it('signs out other sessions when the password changes', async () => {
    const other = await s.as('olivia', 'Demo-password-1');
    const current = await s.as('olivia', 'Demo-password-1');
    await current('POST', '/auth/password', { current: 'Demo-password-1', next: 'Another-password-2' });
    await expect(other('GET', '/auth/me')).rejects.toMatchObject({ status: 401 });
    expect((await current('GET', '/auth/me')).user.username).toBe('olivia');
  });
});
