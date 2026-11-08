import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { ZipReader } from '../src/compliance/zip.js';

/**
 * Postman export routes (#204): GET /api/processes/:id/export/postman and GET /api/platforms/:id/export/postman on the
 * demo data. Who may see the process or platform may export it; the download is a ZIP of Postman's two files (or one
 * of them as JSON), carries no secret of the demo platforms and is audited.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
/** Credential values of the demo platforms (server/src/mock/mockPlatform.ts) */
const SECRETS = ['demo-secret', 'demo-client', 'demo-password'];
const here = path.dirname(fileURLToPath(import.meta.url));
const validateCollection = new Ajv({ allErrors: true, strict: false }).compile(
  JSON.parse(fs.readFileSync(path.join(here, 'fixtures/postman/collection-v2.1.0.schema.json'), 'utf8')),
);

let s: TestServer;
let olivia: Client; // operator: uses the demo platforms
let vera: Client; // viewer: sees processes, no platform
let hub: string;
let iem: string;

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const lastAudit = async (action: string) => (await s.api('GET', `/audit?action=${action}&limit=1`))[0];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const platforms = await s.api('GET', '/platforms');
  hub = platforms.find((p: { kind: string }) => p.kind === 'insights-hub').id;
  iem = platforms.find((p: { kind: string }) => p.kind === 'industrial-edge-management').id;
  [olivia, vera] = await Promise.all(['olivia', 'vera'].map((u) => s.as(u, PW)));
}, 180_000);

describe('process export', () => {
  it('a ZIP with the collection and the environment, without secrets, audited', async () => {
    const cookie = await loginCookie(s.base, 'olivia', PW);
    const res = await fetch(`${s.base}/api/processes/ih-health-check/export/postman`, { headers: { 'x-sm-client': '1', ...authHeaders(cookie) } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('filename="ih-health-check.postman.zip"');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-postman-'));
    try {
      const file = path.join(dir, 'x.zip');
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      const zip = await ZipReader.open(file);
      expect(zip.entries.map((e) => e.name).sort()).toEqual(['ih-health-check.postman_collection.json', 'ih-health-check.postman_environment.json']);
      const read = async (name: string) => {
        const chunks: Buffer[] = [];
        for await (const c of await zip.stream(zip.entries.find((e) => e.name === name)!)) chunks.push(c as Buffer);
        return Buffer.concat(chunks).toString('utf8');
      };
      const collectionText = await read('ih-health-check.postman_collection.json');
      const environmentText = await read('ih-health-check.postman_environment.json');
      for (const secret of SECRETS) {
        expect(collectionText).not.toContain(secret);
        expect(environmentText).not.toContain(secret);
      }
      const collection = JSON.parse(collectionText);
      expect(validateCollection(collection), JSON.stringify(validateCollection.errors?.slice(0, 3))).toBe(true);
      expect(collection.item[0].item.map((i: { id: string }) => i.id)).toEqual(['idm', 'am']);
      // the only Insights Hub platform the operator can see is taken for the connection
      expect(collection.item[0].description).toContain(
        '`hub`: platform "Insights Hub (demo)" (insights-hub), the only platform of kind insights-hub you can see',
      );
      const env = JSON.parse(environmentText);
      expect(env._postman_variable_scope).toBe('environment');
      expect(env.values).toContainEqual({ key: 'hub.clientSecret', value: '', type: 'secret', enabled: true });
      expect(env.values).toContainEqual({ key: 'hub.clientId', value: '', type: 'secret', enabled: true });
      expect(env.values.find((v: { key: string }) => v.key === 'hub.baseUrl').value).toMatch(/\/mock\/ih$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const a = await lastAudit('process.exported_postman');
    expect(a).toMatchObject({ actor: 'olivia', entityType: 'process', entityId: 'ih-health-check' });
    expect(a.details).toMatchObject({ file: 'zip', platforms: { hub } });
  });

  it('one file as JSON; a viewer without platform rights gets the connection without a platform', async () => {
    const c = await vera('GET', '/processes/ih-health-check/export/postman?file=collection');
    expect(c.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(c.item[0].description).toContain('`hub` (insights-hub): exported without a platform');
    const e = await vera('GET', '/processes/ih-health-check/export/postman?file=environment');
    expect(e.values).toContainEqual({ key: 'hub.baseUrl', value: '', type: 'default', enabled: true });
    expect((await lastAudit('process.exported_postman')).details).toMatchObject({ file: 'environment', platforms: {} });
  });

  it('a chosen platform (the run dialog remembers it), a version, and refusals', async () => {
    const c = await s.api('GET', `/processes/ih-health-check/export/postman?file=collection&version=1&bindings=hub:${hub}`);
    expect(c.item[0].description).toContain('as chosen for the export');
    expect(c.item[0].description).toContain('version 1');
    // a platform the person cannot see is not used
    const v = await vera('GET', `/processes/ih-health-check/export/postman?file=collection&bindings=hub:${iem}`);
    expect(v.item[0].description).toContain('the chosen platform is not available');
    expect(await status(s.api('GET', '/processes/ih-health-check/export/postman?bindings=not a binding'))).toBe(400);
    expect(await status(s.api('GET', '/processes/ih-health-check/export/postman?file=both'))).toBe(400);
    expect(await status(s.api('GET', '/processes/no-such-process/export/postman'))).toBe(404);
    expect(await status(s.api('GET', '/processes/ih-health-check/export/postman?version=999'))).toBe(404);
  });
});

describe('platform export', () => {
  it('environment and the operations of the API description; who may use the platform may export it, audited', async () => {
    const c = await olivia('GET', `/platforms/${hub}/export/postman?file=collection`);
    expect(validateCollection(c), JSON.stringify(validateCollection.errors?.slice(0, 3))).toBe(true);
    expect(c.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] });
    expect(c.event[0].script.exec.join('\n')).toContain('pm.sendRequest');
    const ops = (await olivia('GET', `/platforms/${hub}/operations`)).length;
    expect(ops).toBeGreaterThan(0);
    const count = (items: { item?: unknown[] }[]): number => items.reduce((n, i) => n + (i.item ? count(i.item as never) : 1), 0);
    // the operations plus the connection test
    expect(count(c.item)).toBe(ops + 1);
    const e = await olivia('GET', `/platforms/${hub}/export/postman?file=environment`);
    expect(e.values).toContainEqual({ key: 'clientSecret', value: '', type: 'secret', enabled: true });
    expect(e.values).toContainEqual({ key: 'tenant', value: 'demotenant', type: 'default', enabled: true });
    for (const secret of SECRETS) expect(JSON.stringify([c, e])).not.toContain(secret);
    const a = await lastAudit('platform.exported_postman');
    expect(a).toMatchObject({ actor: 'olivia', entityType: 'platform', entityId: hub });
    expect(a.details).toMatchObject({ operations: ops, file: 'environment' });
  });

  it('the login request of the IEM demo becomes a pre-request script; its password stays out', async () => {
    const c = await s.api('GET', `/platforms/${iem}/export/postman?file=collection`);
    const pre = c.event[0].script.exec.join('\n');
    expect(pre).toContain('pm.sendRequest(request');
    expect(JSON.stringify(c)).not.toContain('demo-password');
    expect(validateCollection(c)).toBe(true);
  });

  it('a person without a right on the platform gets 404', async () => {
    expect(await status(vera('GET', `/platforms/${hub}/export/postman`))).toBe(404);
    expect(await status(s.api('GET', '/platforms/plt_nope/export/postman'))).toBe(404);
  });
});
