import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeTag, splitTag, tagLabel, tagProblem, tagsMatch } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Tags with an optional value (#143): `key` or `key=value`, filters by key (any value) or key=value in the lists and
 * the public API; tags from before stay as they are.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

describe('tag rules', () => {
  it('splits, normalises, labels and matches', () => {
    expect(splitTag('env=prod')).toEqual({ key: 'env', value: 'prod' });
    expect(splitTag('pci')).toEqual({ key: 'pci', value: null });
    expect(normalizeTag(' env = prod ')).toBe('env=prod');
    expect(normalizeTag('env: prod')).toBe('env=prod');
    // a colon without a space is part of the key (e.g. a role name)
    expect(normalizeTag('mdsp:core')).toBe('mdsp:core');
    expect(normalizeTag('env=')).toBe('env');
    expect(tagLabel('env=prod')).toBe('env: prod');
    expect(tagProblem('team/data=orders')).toBeNull();
    expect(tagProblem('needs review')).toBeNull(); // a plain tag from before
    expect(tagProblem('needs review=yes')).toBe('key');
    expect(tagsMatch(['env=prod', 'pci'], 'env')).toBe(true);
    expect(tagsMatch(['env=prod', 'pci'], 'ENV=Prod')).toBe(true);
    expect(tagsMatch(['env=prod'], 'env=test')).toBe(false);
    expect(tagsMatch(['environment'], 'env')).toBe(false);
    expect(tagsMatch(['pci'], 'pci')).toBe(true);
    expect(tagsMatch([], null)).toBe(true);
  });
});

describe('tags in the lists and the API', () => {
  let s: TestServer;
  let token = '';
  beforeAll(async () => {
    s = await startTestServer();
    await setup(s);
    token = (await s.api('POST', '/me/tokens', { name: 'tags', scope: 'read' })).token;
  });
  afterAll(async () => {
    await s?.app.close();
  });
  const v1 = async (path: string) => (await fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } })).json();

  it('stores key=value, refuses a bad key, and filters by key or key=value', async () => {
    const prod = await s.api('POST', '/applications', { name: 'Tagged prod', tags: ['Env: Prod', 'pci'] });
    expect(prod.tags).toEqual(['env=prod', 'pci']);
    await s.api('POST', '/applications', { name: 'Tagged test', tags: ['env=test'] });
    await s.api('POST', '/applications', { name: 'Untagged' });
    await expect(s.api('POST', '/applications', { name: 'Bad', tags: ['bad key=x'] })).rejects.toMatchObject({ status: 400 });
    const names = async (q: string) => (await v1(`/applications?tag=${encodeURIComponent(q)}`)).items.map((a: any) => a.name).sort();
    expect(await names('env')).toEqual(['Tagged prod', 'Tagged test']);
    expect(await names('env=prod')).toEqual(['Tagged prod']);
    expect(await names('pci')).toEqual(['Tagged prod']);

    await s.api('POST', '/services', { name: 'Svc prod', tags: ['env=prod'] });
    expect((await v1('/services?tag=env=prod')).items.map((x: any) => x.name)).toEqual(['Svc prod']);

    await s.api('POST', '/credentials', { name: 'Cred prod', type: 'token', tags: ['env=prod'] });
    await s.api('POST', '/credentials', { name: 'Cred test', type: 'token', tags: ['env=test'] });
    expect((await s.api('GET', '/credentials?tag=env')).items.map((x: any) => x.name).sort()).toEqual(['Cred prod', 'Cred test']);
    expect((await v1('/credentials?tag=env=test')).items.map((x: any) => x.name)).toEqual(['Cred test']);

    const rec = await s.api('POST', '/records', { type: 'ADR', title: 'Tagged decision', tags: ['Area=Data'] });
    expect(rec.tags).toEqual(['area=data']);
    expect((await s.api('GET', '/records?tag=area')).map((x: any) => x.id)).toContain(rec.id);
    expect((await s.api('GET', '/records?tag=area=ops')).map((x: any) => x.id)).not.toContain(rec.id);
  });

  it('filters processes by key=value', async () => {
    await s.api('POST', '/processes', {
      definition: { name: 'Tagged process', tags: ['team=ops'], steps: [{ id: 'l', type: 'log', message: 'x' }] },
    });
    expect((await v1('/processes?tag=team')).items.map((x: any) => x.name)).toContain('Tagged process');
    expect((await v1('/processes?tag=team=dev')).items.map((x: any) => x.name)).not.toContain('Tagged process');
  });
});
