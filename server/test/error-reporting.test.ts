import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { scrubEvent, scrubString, scrubBreadcrumb } from '@sm/shared';
import { startFakeSentry, type FakeSentry } from './fakeSentry.js';

const PLATFORM_SECRET = 'platform-secret-value-123';
const API_TOKEN = 'smt_AbCdEf0123456789xyz';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.c2lnbmF0dXJlLXBhcnQ';
const ENV_SECRET = 'env-secret-from-SM_SMTP_PASSWORD';

let sentry: FakeSentry;
let app: FastifyInstance;
let base: string;
const exporter = new InMemorySpanExporter();

beforeAll(async () => {
  sentry = await startFakeSentry();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  Object.assign(process.env, {
    SM_DATA_DIR: dataDir,
    SM_PORT: String(port),
    SM_SENTRY_DSN: sentry.dsn,
    SM_SENTRY_ENVIRONMENT: 'test',
    SM_SENTRY_TRACES_SAMPLE_RATE: '0.5', // must be ignored: OpenTelemetry export is on below
    SM_SMTP_PASSWORD: ENV_SECRET,
  });
  await import('../src/bootstrap.js');
  const { ensureDataDirs } = await import('../src/config.js');
  ensureDataDirs();
  // OpenTelemetry tracing and error reporting at the same time
  const { initTelemetry } = await import('../src/telemetry.js');
  initTelemetry({ exporter, simple: true });
  const { initErrorReporting } = await import('../src/errorReporting.js');
  expect(await initErrorReporting({ secretValues: () => [PLATFORM_SECRET] })).toBe(true);

  const { buildApp } = await import('../src/app.js');
  const { HttpError } = await import('../src/util.js');
  const { withSpan } = await import('../src/telemetry.js');
  app = await buildApp();
  // test-only routes outside /api (no sign-in needed); the app's error handler applies
  app.get('/__test/boom', async () =>
    withSpan('boom', {}, async () => {
      throw new TypeError(
        `boom: token ${API_TOKEN}, secret ${PLATFORM_SECRET}, ${ENV_SECRET}, jwt ${JWT}, mail jane.doe@example.com, ip 10.1.2.3, url https://user:pw@hub.example.com/x?apikey=abc123`,
      );
    }),
  );
  app.get('/__test/not-found', async () => {
    throw new HttpError(404, 'Platform not found');
  });
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app?.close();
  const { closeErrorReporting } = await import('../src/errorReporting.js');
  await closeErrorReporting();
  await sentry?.close();
  for (const k of ['SM_SENTRY_DSN', 'SM_SENTRY_ENVIRONMENT', 'SM_SENTRY_TRACES_SAMPLE_RATE', 'SM_SMTP_PASSWORD']) delete process.env[k];
});

describe('error reporting (Sentry-compatible)', () => {
  it('reports a 5xx with scrubbed request data, secrets and personal data', async () => {
    const res = await fetch(`${base}/__test/boom?token=${API_TOKEN}&password=hunter2&q=1`, {
      headers: {
        cookie: 'sm_session=session-cookie-value-1234',
        authorization: `Bearer ${API_TOKEN}`,
        'x-space-auth-key': 'Basic dXNlcjpwYXNzd29yZA==',
        'user-agent': 'vitest',
      },
    });
    expect(res.status).toBe(500);
    const [event] = await sentry.waitForEvents(1);
    expect(event).toBeTruthy();
    const all = sentry.raw.join('\n');
    for (const leaked of [
      API_TOKEN,
      PLATFORM_SECRET,
      ENV_SECRET,
      JWT,
      'hunter2',
      'session-cookie-value-1234',
      'dXNlcjpwYXNzd29yZA',
      'jane.doe',
      '10.1.2.3',
      'abc123',
      'user:pw',
      os.hostname(),
    ]) {
      expect(all, `must not contain ${leaked}`).not.toContain(leaked);
    }
    expect(event.exception.values[0].type).toBe('TypeError');
    expect(event.exception.values[0].value).toContain('boom: token smt_***');
    expect(event.tags.route).toBe('/__test/boom');
    expect(event.environment).toBe('test');
    expect(event.release).toMatch(/^steward@\d/);
    expect(event.server_name).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.headers?.authorization).toBeUndefined();
    expect(event.contexts.route).toEqual({ method: 'GET', path: '/__test/boom' });
    // the OpenTelemetry tracer provider stays in charge (spans still go to the OTLP exporter)
    expect(exporter.getFinishedSpans().some((sp) => sp.name === 'boom')).toBe(true);
    // errors only: no transactions/spans sent to Sentry, no sessions
    expect(sentry.items.filter((i) => i.type !== 'event')).toEqual([]);
  });

  it('tags errors inside a span with the OpenTelemetry trace id (engine errors)', async () => {
    const { reportError, flushErrorReporting } = await import('../src/errorReporting.js');
    const { withSpan } = await import('../src/telemetry.js');
    const before = sentry.events().length;
    await withSpan(
      'step',
      {},
      async () => void reportError(new RangeError('engine bug'), { tags: { phase: 'step', run_id: 'r_123456789012' }, secrets: ['run-only-secret'] }),
    );
    await flushErrorReporting();
    const events = await sentry.waitForEvents(before + 1);
    const ev = events.at(-1);
    expect(ev.tags).toMatchObject({ phase: 'step', run_id: 'r_123456789012' });
    expect(ev.tags.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(exporter.getFinishedSpans().some((sp) => sp.name === 'step' && sp.spanContext().traceId === ev.tags.trace_id)).toBe(true);
  });

  it('does not report expected outcomes (4xx)', async () => {
    const before = sentry.events().length;
    expect((await fetch(`${base}/__test/not-found`)).status).toBe(404);
    expect((await fetch(`${base}/api/runs`)).status).toBe(401);
    await new Promise((r) => setTimeout(r, 300));
    const { flushErrorReporting } = await import('../src/errorReporting.js');
    await flushErrorReporting();
    expect(sentry.events().length).toBe(before);
  });

  it('gives the web UI its DSN at runtime and allows the host in the CSP', async () => {
    const res = await fetch(`${base}/api/client-config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ errorReporting: { dsn: sentry.dsn, environment: 'test', release: expect.stringMatching(/^steward@/) } });
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain(`connect-src 'self' ${sentry.origin}`);
  });
});

describe('scrubbing', () => {
  it('masks tokens, credentials, personal data and query strings in strings', () => {
    const s = scrubString(
      `GET https://hub.example.com/api/assets?filter=x&token=abc failed for ${API_TOKEN} Bearer abc.def.ghi Basic dXNlcjpwYXNzd29yZA== ${JWT} ` +
        'password=hunter2 "client_secret": "s3cr3t" john@corp.example 192.168.0.12 fe80::1ff:fe23:4567:890a C:\\Users\\jdoe\\AppData /home/jdoe/x ' +
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789 0123456789abcdef0123456789abcdef01234567 at 10:30:45',
      { secrets: ['my-own-secret'] },
    );
    for (const leaked of [
      'token=abc',
      API_TOKEN,
      'abc.def.ghi',
      'dXNlcjpwYXNzd29yZA',
      JWT,
      'hunter2',
      's3cr3t',
      'john@',
      '192.168.0.12',
      'fe80::1ff',
      'jdoe',
      'ghp_',
      '0123456789abcdef0123',
    ]) {
      expect(s).not.toContain(leaked);
    }
    expect(s).toContain('https://hub.example.com/api/assets?***');
    expect(s).toContain('10:30:45'); // times are not IPv6 addresses
    expect(scrubString('value my-own-secret here', { secrets: ['my-own-secret'] })).toBe('value *** here');
  });

  it('removes request details, user data and host name from events', () => {
    const e = scrubEvent({
      server_name: 'LAPTOP-JDOE',
      user: { id: 'abc', email: 'a@b.example', ip_address: '1.2.3.4', username: 'jdoe' },
      request: {
        method: 'POST',
        url: 'https://x.example/api/p?token=1',
        headers: { Cookie: 'a=b', Authorization: 'x', 'User-Agent': 'UA' },
        cookies: { a: 'b' },
        data: { password: 'p' },
        query_string: 'token=1',
      },
      extra: { nested: { password: 'p', note: `uses ${API_TOKEN}` } },
      contexts: {
        device: { device_name: 'LAPTOP-JDOE', arch: 'x64' },
        trace: { trace_id: '0123456789abcdef0123456789abcdef', data: { 'enduser.id': 'jdoe' } },
      },
      exception: { values: [{ type: 'Error', value: 'x', stacktrace: { frames: [{ filename: '/home/jdoe/app/x.js', vars: { secret: 'v' } }] } }] },
      breadcrumbs: [
        { category: 'console', message: 'secret log line' },
        { category: 'fetch', data: { url: '/api/runs?q=secret', method: 'GET' } },
      ],
    });
    expect(e.server_name).toBeUndefined();
    expect(e.user).toEqual({ id: 'abc' });
    expect(e.request).toEqual({ method: 'POST', url: '/api/p', headers: { 'User-Agent': 'UA' } });
    expect(e.extra).toEqual({ nested: { password: '***', note: 'uses smt_***' } });
    expect(e.contexts).toEqual({ device: { arch: 'x64' }, trace: { trace_id: '0123456789abcdef0123456789abcdef', data: { 'enduser.id': '***' } } });
    const frame = (e.exception as any).values[0].stacktrace.frames[0];
    expect(frame).toEqual({ filename: '/home/<user>/app/x.js' });
    expect(e.breadcrumbs).toEqual([{ category: 'fetch', data: { url: '/api/runs', method: 'GET' } }]);
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
  });

  it('tells internal errors from business outcomes', async () => {
    const { isInternalError, isUnexpected } = await import('../src/errorReporting.js');
    const { HttpError } = await import('../src/util.js');
    expect(isInternalError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(true);
    expect(isInternalError(new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }))).toBe(false);
    expect(isInternalError(new Error('Step "x" failed: HTTP 404'))).toBe(false);
    expect(isInternalError(new HttpError(502, 'bad gateway'))).toBe(true);
    expect(isUnexpected(new HttpError(404, 'nope'))).toBe(false);
    expect(isUnexpected(new Error('disk full'))).toBe(true);
  });
});
