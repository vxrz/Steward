import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The notification centre (U9 of the 0.10 review): an unread decision request stays in the list however many alerts
 * came after it, and one group (the notifications of some events) can be marked read on its own.
 */
let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => s?.app.close());

describe('notification groups', () => {
  it('keeps unread decisions in the list and marks one group read', async () => {
    const store = await import('../src/notifications/store.js');
    const { db } = await import('../src/db.js');
    const me = await s.api('GET', '/auth/me');
    const userId: string = me.user?.id ?? me.id;
    expect(userId).toBeTruthy();
    store.addInApp(userId, { event: 'task.assigned', title: 'Decide on the access review', body: '', link: '/tasks' }, 0);
    // the decision is the oldest: 30 alerts come after it
    db().run("UPDATE notifications SET ts = '2020-01-01T00:00:00.000Z' WHERE event = 'task.assigned'");
    for (let i = 0; i < 30; i++) store.addInApp(userId, { event: 'check.failed', title: `Check ${i} failed`, body: '' }, 0);
    store.addInApp(userId, { event: 'report.ready', title: 'Weekly report', body: '' }, 0);

    const list = await s.api('GET', '/notifications?limit=10');
    expect(list.items).toHaveLength(11);
    expect(list.items.some((n: { event: string }) => n.event === 'task.assigned')).toBe(true);
    expect(list.unread).toBe(32);

    // one group: only the check alerts
    await s.api('POST', '/notifications/read-all', { events: ['check.failed'] });
    const after = await s.api('GET', '/notifications?limit=50');
    expect(after.unread).toBe(2);
    expect(
      after.items
        .filter((n: { read: boolean }) => !n.read)
        .map((n: { event: string }) => n.event)
        .sort(),
    ).toEqual(['report.ready', 'task.assigned']);
    // a read decision is an ordinary entry again: it is not added beyond the limit
    await s.api('POST', '/notifications/read-all', { events: ['task.assigned'] });
    expect((await s.api('GET', '/notifications?limit=5')).items).toHaveLength(5);
    // unknown events are refused; no body marks everything
    await expect(s.api('POST', '/notifications/read-all', { events: ['nonsense'] })).rejects.toThrow(/400/);
    await s.api('POST', '/notifications/read-all', {});
    expect((await s.api('GET', '/notifications')).unread).toBe(0);
  });

  it('keeps the notifications of retired events readable, never sends them and offers none to subscribe to', async () => {
    const shared = await import('@sm/shared');
    const store = await import('../src/notifications/store.js');
    const service = await import('../src/notifications/service.js');
    const users = await import('../src/auth/users.js');
    const me = await s.api('GET', '/auth/me');
    const userId: string = me.user?.id ?? me.id;
    for (const e of shared.RETIRED_NOTIFICATION_EVENTS) expect(shared.NOTIFICATION_EVENTS as readonly string[]).not.toContain(e);
    // a notification of 0.25.0 is listed and marked read as its group
    const before = (await s.api('GET', '/notifications')).unread as number;
    store.addInApp(userId, { event: 'dataproduct.access_requested' as never, title: 'Access to Orders requested', body: '' }, 0);
    expect((await s.api('GET', '/notifications')).items.map((n: { event: string }) => n.event)).toContain('dataproduct.access_requested');
    await s.api('POST', '/notifications/read-all', { events: ['dataproduct.access_requested', 'dataproduct.access_decided'] });
    expect((await s.api('GET', '/notifications')).unread).toBe(before);
    // nothing sends one any more
    const admin = users.listUsers().find((u) => u.id === userId)!;
    service.notify({
      event: 'dataproduct.access_decided' as never,
      recipients: [admin],
      text: () => ({ title: 'Access decided', body: 'x' }),
      inAppKey: 'retired',
      externalKey: 'retired',
    });
    expect((await s.api('GET', '/notifications?limit=500')).items.filter((n: { event: string }) => n.event === 'dataproduct.access_decided')).toEqual([]);
    // nobody subscribes to it: the instance's routes and Teams (personal) do not know it
    const settings = await s.api('GET', '/settings/notifications');
    expect(Object.keys(settings.routes ?? {})).not.toContain('dataproduct.access_requested');
    // the labels stay in both languages
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const lang of ['en', 'de']) {
      const texts = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../web/src/locales/${lang}/notifications.json`), 'utf8'));
      for (const e of shared.RETIRED_NOTIFICATION_EVENTS) {
        const [a, b] = e.split('.') as [string, string];
        expect(texts.events[a][b].label, `${lang} ${e}`).toBeTruthy();
        if (lang === 'en') expect(texts.events[a][b].info).toBe(shared.RETIRED_NOTIFICATION_EVENT_INFO[e]);
      }
    }
  });
});
