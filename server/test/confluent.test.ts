import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confluentCrnProblem } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Confluent Cloud as an access review source (v0.4.0, docs/CONFLUENT.md): the preset, role bindings under a CRN (paged),
 * principals mapped to e-mail addresses and names, Kafka ACLs with the cluster API key, snapshots and person reviews.
 * Against the simulated Confluent Cloud API (mock/mockConfluent.ts).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let platformId: string;
let mock: typeof import('../src/mock/mockConfluent.js');
const ORG = 'crn://confluent.cloud/organization=org-demo';
const ENV = `${ORG}/environment=env-demo1`;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  mock = await import('../src/mock/mockConfluent.js');
  const preset = (await s.api('GET', '/platform-presets')).find((p: any) => p.kind === 'confluent-cloud');
  const p = await s.api('POST', '/platforms', {
    name: 'Confluent Cloud',
    kind: preset.kind,
    baseUrl: `${s.base}/mock/confluent`,
    config: { ...preset.config, http: { proxy: 'none' } },
    secrets: { username: mock.DEMO_CONFLUENT.cloudKey, password: mock.DEMO_CONFLUENT.cloudSecret },
  });
  platformId = p.id;
});
afterAll(async () => {
  mock?.resetConfluent();
  await s?.app.close();
});

describe('Confluent Cloud platform', () => {
  it('has a preset (Cloud API key, basic auth) and its connection test reads the users', async () => {
    const preset = (await s.api('GET', '/platform-presets')).find((p: any) => p.kind === 'confluent-cloud');
    expect(preset).toMatchObject({ baseUrl: 'https://api.confluent.cloud', config: { auth: { type: 'basic' }, testPath: '/iam/v2/users?page_size=1' } });
    expect(preset.secretFields.map((f: any) => f.key)).toEqual(['username', 'password', 'clusterApiKey', 'clusterApiSecret']);
    expect(await s.api('POST', `/platforms/${platformId}/test`, {})).toMatchObject({ ok: true, status: 200 });
  });

  it('checks CRNs by a scan', () => {
    expect(confluentCrnProblem(ENV)).toBeNull();
    expect(confluentCrnProblem(`${ENV}/cloud-cluster=lkc-1/kafka=lkc-1/topic=orders`)).toBeNull();
    expect(confluentCrnProblem(`${ORG}/environment=*`)).toBeNull();
    expect(confluentCrnProblem('crn://other/organization=x')).toMatch(/starts with/);
    expect(confluentCrnProblem('crn://confluent.cloud/environment=env-1')).toMatch(/organization/);
    expect(confluentCrnProblem(`${ORG}/environment=env 1`)).toMatch(/characters/);
    expect(confluentCrnProblem(`${ORG}/bogus=1`)).toMatch(/Unknown/);
    expect(confluentCrnProblem(`${ORG}/environment`)).toMatch(/name=value/);
    expect(confluentCrnProblem(`${ORG}/${'environment=a/'.repeat(60)}`)).toMatch(/longer/);
  });
});

describe('Confluent access checks', () => {
  let checkId: string;
  it('needs a Confluent platform and a CRN', async () => {
    const base = { name: 'Confluent', platformId, source: 'confluent', cron: '0 6 * * *' };
    await expect(s.api('POST', '/compliance/access-checks', base)).rejects.toThrow(/CRN/);
    await expect(s.api('POST', '/compliance/access-checks', { ...base, scope: 'acme/shop' })).rejects.toThrow(/crn:\/\/confluent.cloud/);
    const gitlab = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'gitlab').id;
    await expect(s.api('POST', '/compliance/access-checks', { ...base, platformId: gitlab, scope: ENV })).rejects.toMatchObject({
      body: { code: 'ACCESS_CHECK_CONFLUENT_SOURCE' },
    });
    // the other sources keep their scope rules
    await expect(s.api('POST', '/compliance/access-checks', { ...base, platformId: gitlab, source: 'git', scope: ENV })).rejects.toThrow(/Scope/);
    const c = await s.api('POST', '/compliance/access-checks', { ...base, scope: ENV });
    expect(c).toMatchObject({ source: 'confluent', scope: ENV, platformKind: 'confluent-cloud' });
    checkId = c.id;
  });

  it('snapshots the role bindings under the CRN with users by e-mail and service accounts by id', async () => {
    const r = await s.api('POST', `/compliance/access-checks/${checkId}/run`, {});
    expect(r.baseline).toBe(true);
    const snap = await s.api('GET', `/compliance/access-checks/${checkId}/snapshots/${r.snapshot.id}`);
    const subjects = snap.data.map((x: any) => ({ id: x.id, name: x.name, type: x.type, rights: x.rights }));
    // bindings on the environment and below (the organisation's own binding is above it); paged two at a time
    expect(subjects).toEqual([
      { id: 'bob@example.com', name: 'Bob Builder', type: 'user', rights: ['EnvironmentAdmin on environment=env-demo1'] },
      {
        id: 'erika.mustermann@example.com',
        name: 'Erika Mustermann',
        type: 'user',
        rights: ['CloudClusterAdmin on environment=env-demo1/cloud-cluster=lkc-demo1'],
      },
      {
        id: 'sa-orders',
        name: 'orders-service',
        type: 'technical',
        rights: ['DeveloperRead on environment=env-demo1/cloud-cluster=lkc-demo1/kafka=lkc-demo1/topic=orders'],
      },
      // a binding of a user that no longer exists is kept with its id
      { id: 'u-gone9', name: 'u-gone9', type: 'user', rights: ['MetricsViewer on environment=env-demo1'] },
    ]);
    expect(snap.data.find((x: any) => x.id === 'bob@example.com').aliases).toEqual(['User:u-bob22', 'u-bob22']);
  });

  it('adds the Kafka ACLs with the cluster API key, and a new binding is a finding', async () => {
    const p = await s.api('GET', `/platforms/${platformId}`);
    await s.api('PUT', `/platforms/${platformId}`, {
      config: { ...p.config, variables: { kafkaRestUrl: `${s.base}/mock/confluent/kafka-rest`, clusterId: mock.DEMO_CONFLUENT.cluster } },
    });
    await s.api('PUT', `/platforms/${platformId}/secrets`, {
      clusterApiKey: mock.DEMO_CONFLUENT.clusterKey,
      clusterApiSecret: mock.DEMO_CONFLUENT.clusterSecret,
    });
    mock.addConfluentBinding('User:u-alice1', 'EnvironmentAdmin', ENV);
    const r = await s.api('POST', `/compliance/access-checks/${checkId}/run`, {});
    const snap = await s.api('GET', `/compliance/access-checks/${checkId}/snapshots/${r.snapshot.id}`);
    const rights = Object.fromEntries(snap.data.map((x: any) => [x.id, x.rights]));
    expect(rights['sa-orders']).toEqual([
      'ACL ALLOW READ GROUP:order-service*',
      'ACL ALLOW READ TOPIC:orders',
      'DeveloperRead on environment=env-demo1/cloud-cluster=lkc-demo1/kafka=lkc-demo1/topic=orders',
    ]);
    expect(rights['sa-billing']).toEqual(['ACL ALLOW WRITE TOPIC:payments']);
    expect(rights['alice@example.com']).toEqual(['EnvironmentAdmin on environment=env-demo1']);
    // the new binding and the ACLs are undocumented changes
    expect(r.findings.map((f: any) => f.subjectId).sort()).toEqual(['alice@example.com', 'sa-billing', 'sa-orders']);
    // a wrong cluster key: the read fails with a clear message
    await s.api('PUT', `/platforms/${platformId}/secrets`, { clusterApiSecret: 'wrong' });
    await expect(s.api('POST', `/compliance/access-checks/${checkId}/run`, {})).rejects.toThrow(/Kafka REST API \(ACLs\) answered HTTP 401/);
    await s.api('PUT', `/platforms/${platformId}/secrets`, { clusterApiSecret: mock.DEMO_CONFLUENT.clusterSecret });
  });

  it('is part of person reviews: a colleague found by e-mail address', async () => {
    const r = await s.api('POST', '/compliance/person-reviews', {
      title: 'Mover: Erika',
      personName: 'Erika Mustermann',
      identifiers: ['erika.mustermann@example.com'],
      checkIds: [checkId],
      fourEyes: false,
    });
    expect(r.sources.map((x: any) => [x.source, x.origin, x.matched])).toEqual([['confluent', 'live', 1]]);
    expect(r.items.map((i: any) => i.right)).toEqual(['CloudClusterAdmin on environment=env-demo1/cloud-cluster=lkc-demo1']);
  });
});
