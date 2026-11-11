import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Kafka "Add topics by prefix" (v0.4.0, docs/KAFKA.md): the cluster's topics under a prefix (read-only), added as Kafka
 * topic components with an environment, and "keep in sync" – new topics under the prefix are offered on the
 * application and in the daily summary until they are added or dismissed. Against the simulated cluster.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let kafkaId: string;
let vera: Client;
let mock: typeof import('../src/mock/mockKafka.js');

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  kafkaId = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'Kafka (demo)').id;
  vera = await s.as('vera', PW);
  mock = await import('../src/mock/mockKafka.js');
  mock.resetKafka();
  for (const t of ['smo-ie.dev.machines', 'smo-ie.dev.alerts', 'smo-ie.prod.machines', 'smo-ie.dev', '_smo-ie.dev.internal']) mock.addKafkaTopic(t);
});
afterAll(async () => {
  mock?.resetKafka();
  await s?.app.close();
});

describe('Kafka topics by prefix', () => {
  it('lists the topics under a prefix, adds the chosen ones with an environment and keeps the prefix in sync', async () => {
    const app = await s.api('POST', '/applications', { name: 'Shop-floor IE', owners: [] });
    // the prefix is checked; the platform must be a Kafka platform the user may use
    await expect(s.api('POST', `/applications/${app.id}/kafka-topics/list`, { platformId: kafkaId, prefix: 'a b' })).rejects.toMatchObject({ status: 400 });
    const gitlab = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'gitlab').id;
    await expect(s.api('POST', `/applications/${app.id}/kafka-topics/list`, { platformId: gitlab, prefix: 'smo-ie.dev.' })).rejects.toMatchObject({
      status: 400,
      body: { code: 'COMPONENT_TOPIC_PLATFORM' },
    });
    const listed = await s.api('POST', `/applications/${app.id}/kafka-topics/list`, { platformId: kafkaId, prefix: 'smo-ie.dev.' });
    // a plain prefix (no pattern): "smo-ie.dev" itself and the internal topic are not under "smo-ie.dev."
    expect(listed).toEqual({
      prefix: 'smo-ie.dev.',
      topics: [
        { name: 'smo-ie.dev.alerts', added: false },
        { name: 'smo-ie.dev.machines', added: false },
      ],
      truncated: false,
    });
    // a viewer may list nothing and add nothing
    await expect(
      vera('POST', `/applications/${app.id}/kafka-topics`, { platformId: kafkaId, prefix: 'smo-ie.dev.', topics: ['smo-ie.dev.alerts'] }),
    ).rejects.toMatchObject({
      status: expect.any(Number),
    });

    const r = await s.api('POST', `/applications/${app.id}/kafka-topics`, {
      platformId: kafkaId,
      prefix: 'smo-ie.dev.',
      environment: 'dev',
      topics: ['smo-ie.dev.machines', 'orders', 'smo-ie.dev.nope'],
      keepInSync: true,
    });
    expect(r.added).toEqual(['smo-ie.dev.machines']);
    expect(r.skipped.map((x: any) => x.name)).toEqual(['orders', 'smo-ie.dev.nope']);
    expect(r.application.components.filter((c: any) => c.type === 'kafka-topic')).toMatchObject([
      { name: 'smo-ie.dev.machines', environment: 'dev', platformId: kafkaId },
    ]);
    // listed and not chosen (alerts): not offered later – the owner saw it
    expect(r.sync).toMatchObject({ prefix: 'smo-ie.dev.', environment: 'dev', offered: [], platformName: 'Kafka (demo)' });
    const again = await s.api('POST', `/applications/${app.id}/kafka-topics/list`, { platformId: kafkaId, prefix: 'smo-ie.dev.', environment: 'dev' });
    expect(again.topics).toEqual([
      { name: 'smo-ie.dev.alerts', added: false },
      { name: 'smo-ie.dev.machines', added: true },
    ]);

    // a new topic under the prefix is offered after the next check
    mock.addKafkaTopic('smo-ie.dev.energy');
    const prefixes = await import('../src/kafka/prefixes.js');
    expect(await prefixes.runTopicPrefixJob()).toBe(0); // checked a moment ago
    expect(await prefixes.runTopicPrefixJob(Date.now() + 25 * 3_600_000)).toBe(1);
    const [sync] = await s.api('GET', `/applications/${app.id}/topic-prefixes`);
    expect(sync).toMatchObject({ offered: ['smo-ie.dev.energy'], error: null });
    expect(await vera('GET', `/applications/${app.id}/topic-prefixes`)).toHaveLength(1);

    // in the daily summary of who may change the application
    const sum = await import('../src/notifications/summary.js');
    const users = await import('../src/auth/users.js');
    const prefs = {
      enabled: true,
      time: '08:00',
      timeZone: 'UTC',
      days: 'everyday' as const,
      channel: 'inApp' as const,
      sections: ['topics' as const],
      skipEmpty: true,
    };
    const forAdmin = sum.buildSummary(users.findUserByName('admin')!, prefs, Date.now() - 86_400_000, Date.now());
    expect(forAdmin.sections[0]).toMatchObject({
      id: 'topics',
      count: 1,
      items: [{ title: 'Shop-floor IE: 1 new topic(s) under smo-ie.dev.', detail: 'smo-ie.dev.energy · dev', link: `/applications/${app.id}` }],
    });
    expect(sum.buildSummary(users.findUserByName('vera')!, prefs, Date.now() - 86_400_000, Date.now()).sections[0]!.count).toBe(0);

    // adding the offered topic ends the offer; a dismissed one is not offered again
    const added = await s.api('POST', `/applications/${app.id}/kafka-topics`, {
      platformId: kafkaId,
      prefix: 'smo-ie.dev.',
      environment: 'dev',
      topics: ['smo-ie.dev.energy'],
    });
    expect(added.sync.offered).toEqual([]);
    mock.addKafkaTopic('smo-ie.dev.scrap');
    expect((await s.api('POST', `/applications/${app.id}/topic-prefixes/${sync.id}/check`, {})).offered).toEqual(['smo-ie.dev.scrap']);
    await expect(vera('POST', `/applications/${app.id}/topic-prefixes/${sync.id}/dismiss`, { topics: ['smo-ie.dev.scrap'] })).rejects.toMatchObject({
      status: 403,
    });
    expect((await s.api('POST', `/applications/${app.id}/topic-prefixes/${sync.id}/dismiss`, { topics: ['smo-ie.dev.scrap'] })).offered).toEqual([]);
    expect((await s.api('POST', `/applications/${app.id}/topic-prefixes/${sync.id}/check`, {})).offered).toEqual([]);

    // stop syncing; every change is in the application's history
    await s.api('DELETE', `/applications/${app.id}/topic-prefixes/${sync.id}`);
    expect(await s.api('GET', `/applications/${app.id}/topic-prefixes`)).toEqual([]);
    const log = (await s.api('GET', `/audit?entityId=${app.id}&limit=50`)) as any[];
    expect(log.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'application.topics_added',
        'application.topic_prefix_synced',
        'application.topics_offered',
        'application.topics_dismissed',
        'application.topic_prefix_unsynced',
      ]),
    );
  });
});

describe('daily summary sections added later', () => {
  it('adds a new section only for people who had every section of the time, and keeps a section left out since', async () => {
    const sum = await import('../src/notifications/summary.js');
    const users = await import('../src/auth/users.js');
    const dbm = await import('../src/db.js');
    const olivia = users.findUserByName('olivia')!;
    const old = ['runs', 'tasks', 'monitors', 'credentials', 'tickets', 'records', 'reviews', 'duties', 'reports'];
    const store = (prefs: object) =>
      dbm.db().run(
        `INSERT INTO daily_summary_prefs (user_id, enabled, prefs, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs`,
        olivia.id,
        JSON.stringify(prefs),
        new Date().toISOString(),
      );
    const base = { enabled: true, time: '08:00', timeZone: 'UTC', days: 'weekdays', channel: 'inApp', skipEmpty: true };
    // saved before 0.2.6 with every section of the time: trends, topics and suppliers are added
    store({ ...base, sections: old });
    expect(sum.getPrefs(olivia.id).sections).toEqual([...old, 'trends', 'topics', 'suppliers']);
    // saved before 0.4.0 without trends: nothing is added (as before)
    store({ ...base, sections: old.slice(1) });
    expect(sum.getPrefs(olivia.id).sections).toEqual(old.slice(1));
    // saved since 0.4.0 without topics: it stays out
    const c = await s.as('olivia', PW);
    await c('PUT', '/me/daily-summary', { ...base, sections: [...old, 'trends'] });
    expect(sum.getPrefs(olivia.id).sections).toEqual([...old, 'trends']);
    expect((await c('GET', '/me/daily-summary')).prefs.sections).toEqual([...old, 'trends']);
  });
});
