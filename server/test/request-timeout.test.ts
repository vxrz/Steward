import net from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, authHeaders, loginCookie, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Request timeouts (security review 0.19.0 M1): without signing in, a client sent a body one byte every 20 s and held the
 * connection open for ever. Now the body has SM_REQUEST_TIMEOUT_SECONDS; signed-in uploads get SM_UPLOAD_TIMEOUT_SECONDS.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_REQUEST_TIMEOUT_SECONDS = '1';
process.env.SM_UPLOAD_TIMEOUT_SECONDS = '20';
process.env.SM_KEEP_ALIVE_TIMEOUT_SECONDS = '5';

let s: TestServer;
let port: number;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  port = Number(new URL(s.base).port);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends the head and the first part of the body, waits, then the rest: what came back and whether the server closed. */
function slowRequest(head: string, first: string, rest: string, waitMs: number): Promise<{ answer: string; closedAfterMs: number | null }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let answer = '';
    let closedAfterMs: number | null = null;
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(head + first);
      setTimeout(() => {
        if (!sock.destroyed && closedAfterMs === null) sock.write(rest);
      }, waitMs);
    });
    sock.on('data', (d) => (answer += d.toString('latin1')));
    sock.on('close', () => {
      closedAfterMs ??= Date.now() - started;
      resolve({ answer, closedAfterMs });
    });
    sock.on('error', () => undefined); // the server closed it: reported by "close"
    setTimeout(() => {
      sock.destroy();
    }, waitMs + 4000);
  });
}

describe('request timeouts', () => {
  it('sets the connection limits on the server', () => {
    expect(s.app.server.keepAliveTimeout).toBe(5000);
    expect(s.app.server.requestTimeout).toBe(20_000);
    expect(s.app.initialConfig.connectionTimeout).toBe(600_000);
  });

  it('closes a connection whose body does not arrive in time (no sign-in needed)', async () => {
    const body = JSON.stringify({ username: 'admin', password: 'x'.repeat(20) });
    const head = `POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nx-sm-client: 1\r\nContent-Length: ${body.length}\r\n\r\n`;
    const r = await slowRequest(head, body.slice(0, 5), body.slice(5), 3000);
    expect(r.answer).toMatch(/^HTTP\/1\.1 408/);
    expect(r.closedAfterMs).toBeGreaterThanOrEqual(900);
    expect(r.closedAfterMs).toBeLessThan(2900);
  });

  it('also for a signed-in JSON body that is not an upload', async () => {
    const cookie = await loginCookie(s.base, ADMIN.username, ADMIN.password);
    const h = authHeaders(cookie);
    const body = JSON.stringify({ displayName: 'Slow admin' });
    const head = `PATCH /api/me HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nx-sm-client: 1\r\ncookie: ${h.cookie}\r\nx-sm-session: ${h['x-sm-session']}\r\nContent-Length: ${body.length}\r\n\r\n`;
    const r = await slowRequest(head, body.slice(0, 3), body.slice(3), 2500);
    expect(r.answer).toMatch(/^HTTP\/1\.1 408/);
  });

  it('gives a signed-in upload longer', async () => {
    const cookie = await loginCookie(s.base, ADMIN.username, ADMIN.password);
    const h = authHeaders(cookie);
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('latin1');
    const boundary = 'invented-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n${png}\r\n--${boundary}--\r\n`;
    const head = `POST /api/settings/theme/logo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nx-sm-client: 1\r\nConnection: close\r\ncookie: ${h.cookie}\r\nx-sm-session: ${h['x-sm-session']}\r\nContent-Length: ${Buffer.byteLength(body, 'latin1')}\r\n\r\n`;
    const r = await slowRequest(head, body.slice(0, 40), body.slice(40), 2000);
    // answered by the route (accepted or refused as an image), not by the timeout
    expect(r.answer).toMatch(/^HTTP\/1\.1 (200|400)/);
    expect(r.closedAfterMs).toBeGreaterThan(1900);
  });

  it('leaves a keep-alive connection alone once a request was answered', async () => {
    const r = await new Promise<string>((resolve) => {
      let answer = '';
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
      sock.on('data', (d) => (answer += d.toString('latin1')));
      // a second request on the same connection, after the request timeout of the first
      setTimeout(() => sock.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'), 1600);
      sock.on('close', () => resolve(answer));
      setTimeout(() => sock.destroy(), 5000);
    });
    expect(r.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
    expect(r).not.toMatch(/HTTP\/1\.1 408/);
    await sleep(10);
  });
});
