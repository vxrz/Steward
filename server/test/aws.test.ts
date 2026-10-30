import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * AWS accounts (#116): the API client against the demo account (every request signed per service and checked by the
 * mock), the endpoints of real AWS, and where credentials may go.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

let s: TestServer;
let mockBase: string;
let platformId: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  mockBase = `${s.base.replace(/\/$/, '')}/mock`;
  const p = await s.api('POST', '/platforms', {
    name: 'AWS demo account',
    kind: 'aws',
    baseUrl: `${mockBase}/aws-api`,
    config: {
      auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 'sts' } },
      variables: { regions: 'eu-central-1, eu-west-1' },
      http: { proxy: 'none' },
    },
    secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
  });
  platformId = p.id;
});
afterAll(async () => {
  await s?.app.close();
});

async function client() {
  const { AwsClient } = await import('../src/aws/client.js');
  const { getPlatform, getSecrets } = await import('../src/platforms/service.js');
  return new AwsClient(getPlatform(platformId), getSecrets(platformId));
}

describe('AWS API client', () => {
  it('reads the account, tagged resources, costs and IAM keys – each call signed for its own service', async () => {
    const c = await client();
    expect(await c.callerIdentity()).toMatchObject({ account: '123456789012', arn: 'arn:aws:iam::123456789012:user/steward-reader' });
    const eu1 = await c.taggedResources('eu-central-1', 'application');
    expect(eu1).toHaveLength(7);
    expect(eu1.filter((r) => r.tags.application === 'shop')).toHaveLength(5);
    expect(await c.taggedResources('eu-west-1', 'application')).toHaveLength(2);
    const costs = await c.costs({ start: '2026-05-01', end: '2026-10-31', tagKey: 'application' });
    expect(new Set(costs.byTag.map((r) => r.month))).toEqual(new Set(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']));
    expect(costs.byTag.find((r) => r.month === '2026-05' && r.tag === 'shop')).toMatchObject({ amount: 1840, unit: 'USD' });
    expect(costs.byTag.some((r) => r.tag === '')).toBe(true);
    expect(costs.byService.some((r) => r.service === 'Amazon Relational Database Service')).toBe(true);
    const users = await c.iamUsers();
    expect(users.map((u) => u.userName)).toEqual(['ci-deploy', 'backup-writer', 'old-intern']);
    expect(users[0]!.keys[0]).toMatchObject({ accessKeyId: 'AKIADEMOCIDEPLOY001', status: 'Active', lastService: 'ecs' });
    expect(users[2]!.keys[0]).toMatchObject({ status: 'Inactive', lastUsed: null, lastService: null });
  });

  it('refuses a wrong secret (the mock checks every signature)', async () => {
    await s.api('PUT', `/platforms/${platformId}/secrets`, { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'wrong' });
    const c = await client();
    await expect(c.callerIdentity()).rejects.toThrow(/HTTP 403.*signature/);
    await s.api('PUT', `/platforms/${platformId}/secrets`, { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' });
  });

  it('knows the endpoints of real AWS, and sends credentials only to AWS itself', async () => {
    const { endpointFor, parseArn } = await import('../src/aws/client.js');
    const { credentialsAllowed, isAwsEndpoint } = await import('../src/platforms/http.js');
    const real = {
      id: 'x',
      name: 'x',
      kind: 'aws',
      baseUrl: 'https://sts.eu-central-1.amazonaws.com',
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 'sts' } } },
    } as any;
    expect(endpointFor(real, 'tagging', 'eu-west-1')).toBe('https://tagging.eu-west-1.amazonaws.com');
    expect(endpointFor(real, 'ce', 'eu-west-1')).toBe('https://ce.us-east-1.amazonaws.com');
    expect(endpointFor(real, 'iam', 'eu-central-1')).toBe('https://iam.amazonaws.com');
    expect(endpointFor(real, 'tagging', 'cn-north-1')).toBe('https://tagging.cn-north-1.amazonaws.com.cn');
    expect(isAwsEndpoint('https://ce.us-east-1.amazonaws.com')).toBe(true);
    expect(isAwsEndpoint('https://evil.example.com/.amazonaws.com')).toBe(false);
    expect(isAwsEndpoint('https://amazonaws.com.evil.example')).toBe(false);
    expect(isAwsEndpoint('http://iam.amazonaws.com')).toBe(false);
    expect(await credentialsAllowed(real, {}, 'https://iam.amazonaws.com/')).toBe(true);
    expect(await credentialsAllowed(real, {}, 'https://example.com/')).toBe(false);
    // only AWS account platforms: an S3 bucket platform keeps to its own origin
    expect(await credentialsAllowed({ ...real, kind: 'generic' }, {}, 'https://iam.amazonaws.com/')).toBe(false);
    expect(parseArn('arn:aws:ec2:eu-central-1:123456789012:instance/i-1')).toMatchObject({
      service: 'ec2',
      region: 'eu-central-1',
      type: 'instance',
      name: 'i-1',
    });
    expect(parseArn('arn:aws:rds:eu-central-1:123456789012:db:shop-orders')).toMatchObject({ type: 'db', name: 'shop-orders' });
    expect(parseArn('arn:aws:s3:::shop-assets')).toMatchObject({ service: 's3', type: 'bucket', name: 'shop-assets' });
  });
});

describe('cloud-account components on an AWS platform', () => {
  it('lists the resources with the application tag, their costs and the tagged IAM users with their keys', async () => {
    const app = await s.api('POST', '/applications', { name: 'Shop on AWS', owners: [] });
    // only an AWS platform, and a tag value as the name
    const other = await s.api('POST', '/platforms', {
      name: 'Not AWS',
      kind: 'generic',
      baseUrl: `${mockBase}/test`,
      config: { auth: { type: 'none' }, variables: {}, http: {} },
    });
    await expect(s.api('POST', `/applications/${app.id}/components`, { type: 'cloud-account', name: 'shop', platformId: other.id })).rejects.toThrow(
      /AWS platform/,
    );
    await expect(s.api('POST', `/applications/${app.id}/components`, { type: 'cloud-account', name: 'shop<1>', platformId })).rejects.toThrow(
      /application tag/,
    );
    // without a platform, a cloud account stays a plain entry (as before)
    await s.api('POST', `/applications/${app.id}/components`, { type: 'cloud-account', name: 'Azure subscription (manual)' });
    const a = await s.api('POST', `/applications/${app.id}/components`, { type: 'cloud-account', name: 'shop', platformId });
    const cmp = a.components.find((c: any) => c.name === 'shop');
    expect(cmp).toMatchObject({ platformId, aws: null });
    const read = await s.api('POST', `/applications/${app.id}/components/${cmp.id}/aws`, {});
    const r = read.components.find((c: any) => c.id === cmp.id).aws;
    expect(r).toMatchObject({
      error: null,
      account: '123456789012',
      tagKey: 'application',
      tagValue: 'shop',
      regions: ['eu-central-1', 'eu-west-1'],
      warnings: [],
    });
    // 5 in eu-central-1 (the bucket is global), 1 in eu-west-1; nothing of crm
    expect(r.resources).toHaveLength(6);
    expect(r.resources.every((x: any) => x.tags.application === 'shop')).toBe(true);
    expect(r.services).toEqual({ ec2: 3, rds: 1, elasticloadbalancing: 1, s3: 1 });
    expect(r.resources.find((x: any) => x.service === 's3')).toMatchObject({ type: 'bucket', region: '' });
    expect(r.costs.error).toBeNull();
    expect(r.costs.months).toHaveLength(6);
    expect(r.costs.months[0]).toMatchObject({ amount: 1840, currency: 'USD' });
    expect(r.users.map((u: any) => u.userName)).toEqual(['ci-deploy']);
    expect(r.users[0].keys[0]).toMatchObject({ accessKeyId: 'AKIADEMOCIDEPLOY001', status: 'Active', lastService: 'ecs' });
    // processes see it as the readout of the component
    const { db } = await import('../src/db.js');
    const cached = db().all<{ part: string }>('SELECT part FROM aws_account_cache WHERE platform_id = ? ORDER BY part', platformId);
    expect(cached.map((x) => x.part)).toEqual(['costs', 'iam', 'resources']);
  });

  it('shares one account read between components, reads costs once a day, and refreshes in the background', async () => {
    const { db } = await import('../src/db.js');
    const costsBefore = db().get<{ read_at: string }>("SELECT read_at FROM aws_account_cache WHERE platform_id = ? AND part = 'costs'", platformId)!.read_at;
    const app = await s.api('POST', '/applications', { name: 'CRM on AWS', owners: [] });
    const a = await s.api('POST', `/applications/${app.id}/components`, { type: 'cloud-account', name: 'crm', platformId });
    const cmp = a.components.find((c: any) => c.name === 'crm');
    const read = await s.api('POST', `/applications/${app.id}/components/${cmp.id}/aws`, {});
    const r = read.components.find((c: any) => c.id === cmp.id).aws;
    expect(r.resources.map((x: any) => x.name).sort()).toEqual(['crm-cluster/crm-api', 'crm-contacts', 'crm-sync']);
    expect(r.users.map((u: any) => u.userName)).toEqual(['old-intern']);
    // "Read now" reads resources and IAM again, but not the costs (Cost Explorer charges per request)
    expect(db().get<{ read_at: string }>("SELECT read_at FROM aws_account_cache WHERE platform_id = ? AND part = 'costs'", platformId)!.read_at).toBe(
      costsBefore,
    );
    const { runAwsJob } = await import('../src/aws/service.js');
    expect(await runAwsJob(Date.now())).toBe(0);
    expect(await runAwsJob(Date.now() + 7 * 3_600_000)).toBeGreaterThanOrEqual(2);
  });

  it('keeps the last readout when the account cannot be read, and says why', async () => {
    const app = await s.api('POST', '/applications', { name: 'Shop again', owners: [] });
    const a = await s.api('POST', `/applications/${app.id}/components`, { type: 'cloud-account', name: 'shop', platformId });
    const cmp = a.components.find((c: any) => c.name === 'shop');
    await s.api('POST', `/applications/${app.id}/components/${cmp.id}/aws`, {});
    await s.api('PUT', `/platforms/${platformId}/secrets`, { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'wrong' });
    const read = await s.api('POST', `/applications/${app.id}/components/${cmp.id}/aws`, {});
    const r = read.components.find((c: any) => c.id === cmp.id).aws;
    expect(r.error).toMatch(/HTTP 403/);
    expect(r.resources).toHaveLength(6);
    await s.api('PUT', `/platforms/${platformId}/secrets`, { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' });
  });

  it('tests the connection with STS', async () => {
    const t = await s.api('POST', `/platforms/${platformId}/test`, {});
    expect(t).toMatchObject({ ok: true, message: expect.stringContaining('AWS account 123456789012 as arn:aws:iam::123456789012:user/steward-reader') });
  });
});
