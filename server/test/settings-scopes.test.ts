import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, ADMIN, type TestServer } from './helpers.js';

/** Settings by scope (#136): instance settings at /api/settings/instance; the old /api/settings keeps working, marked deprecated. */

let s: TestServer;
let headers: Record<string, string>;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  headers = { 'x-sm-client': '1', ...authHeaders(await loginCookie(s.base, ADMIN.username, ADMIN.password)) };
});
afterAll(async () => {
  await s?.app.close();
});

describe('instance settings', () => {
  it('are read and changed at /api/settings/instance, without a deprecation note', async () => {
    const res = await fetch(`${s.base}/api/settings/instance`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toBeNull();
    expect((await res.json()).defaultLocale).toBeDefined();
    const saved = await s.api('PUT', '/settings/instance', { retentionNotificationDays: 45 });
    expect(saved.retentionNotificationDays).toBe(45);
    const audit = (await s.api('GET', '/audit?action=settings.updated&limit=1'))[0];
    expect(audit.details).toMatchObject({ scope: 'instance', retentionNotificationDays: 45 });
  });

  it('keep the old route working for one minor version, with a deprecation note pointing to the new one', async () => {
    const res = await fetch(`${s.base}/api/settings`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toBe('true');
    expect(res.headers.get('link')).toBe('</api/settings/instance>; rel="successor-version"');
    expect((await res.json()).retentionNotificationDays).toBe(45);
    // same document, both ways
    expect(await s.api('GET', '/settings')).toEqual(await s.api('GET', '/settings/instance'));
  });
});
