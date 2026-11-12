import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { changedDestination, platformDestination } from '../src/platforms/destination.js';

/**
 * A new address of a platform's stored credentials (security review 0.19.0 H1): a platform manager – or an API token –
 * could repoint a platform and collect its credentials. Now only a signed-in session after a step-up may, and the
 * credentials are removed unless an administrator keeps them.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client;
let token: string;
const PW = 'Dana-password-123';

const refused = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, body: {} as any }),
    (e: { status: number; body: any }) => ({ status: e.status, body: e.body }),
  );

async function bearer(method: string, url: string, body?: unknown) {
  const res = await fetch(`${s.base}/api${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

let n = 0;
async function platform(extra: Record<string, unknown> = {}) {
  return s.api('POST', '/platforms', {
    name: `Invented API ${++n}`,
    kind: 'generic',
    baseUrl: 'https://api.invented.example/v1',
    config: { auth: { type: 'bearer' }, variables: { region: 'eu' } },
    secrets: { token: 'stored-token-value' },
    ...extra,
  });
}

const auditOf = async (id: string) => (await s.api('GET', `/audit?action=platform.destination_changed&entityId=${id}`)) as any[];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  token = (await s.api('POST', '/me/tokens', { name: 'full', scope: 'full' })).token;
  const { temporaryPassword } = await s.api('POST', '/users', { username: 'dana', roles: ['designer'] });
  await (
    await s.as('dana', temporaryPassword)
  )('POST', '/auth/password', { current: temporaryPassword, next: PW });
  dana = await s.as('dana', PW);
});

describe('what counts as a new address', () => {
  const base = { kind: 'generic', baseUrl: 'https://{{ vars.region }}.api.invented.example/v1', config: { variables: { region: 'eu' } } };
  const changed = (after: any) => changedDestination(platformDestination(base), platformDestination(after));

  it('compares the filled-in origins, not the text', () => {
    expect(changed({ ...base, baseUrl: 'https://eu.api.invented.example/v2' })).toEqual([]);
    expect(changed({ ...base, config: { variables: { region: 'attacker.example/x?' } } })).toEqual(['baseUrl']);
    expect(changed({ ...base, config: { ...base.config, http: { trustedOrigins: ['https://collector.example'] } } })).toEqual(['trustedOrigins']);
    expect(changed({ ...base, config: { ...base.config, auth: { type: 'oauth2_client_credentials', tokenUrl: 'https://idp.example/token' } } })).toEqual([
      'signIn',
    ]);
    // a relative login request goes to the base URL: no other address
    expect(changed({ ...base, config: { ...base.config, auth: { type: 'token_request', request: { method: 'POST', url: '/login' } } } })).toEqual(['signIn']);
    expect(changed({ ...base, config: { ...base.config, http: { proxy: 'http://proxy.example:3128' } } })).toEqual(['proxy']);
    expect(changed({ ...base, config: { ...base.config, portalUrl: 'https://portal.example' } })).toEqual(['portalUrl']);
  });

  it('knows the connections of brokers and databases', () => {
    const kafka = { kind: 'kafka', baseUrl: '', config: { variables: { bootstrap: 'b1.invented.example:9092, b2.invented.example:9092' } } };
    const k = (vars: Record<string, string>) => changedDestination(platformDestination(kafka), platformDestination({ ...kafka, config: { variables: vars } }));
    expect(k({ bootstrap: 'b2.invented.example:9092,b1.invented.example:9092' })).toEqual([]);
    expect(k({ bootstrap: 'b1.invented.example:9092,evil.example:9092' })).toEqual(['connection']);
    expect(k({ ...kafka.config.variables, tokenUrl: 'https://idp.example/token' })).toEqual(['connection']);
    expect(k({ ...kafka.config.variables, schemaRegistryUrl: 'https://sr.example' })).toEqual(['connection']);
    const mqtt = { kind: 'mqtt', baseUrl: '', config: { variables: { url: 'mqtts://broker.invented.example:8883' } } };
    expect(
      changedDestination(platformDestination(mqtt), platformDestination({ ...mqtt, config: { variables: { url: 'mqtts://evil.example:8883' } } })),
    ).toEqual(['connection']);
    const db = { kind: 'database', baseUrl: '', config: { database: { dialect: 'postgresql', host: 'db.invented.example', database: 'shop' } } } as any;
    const moved = { ...db, config: { database: { ...db.config.database, host: 'evil.example' } } };
    expect(changedDestination(platformDestination(db), platformDestination(moved))).toEqual(['connection']);
    // the default port written out is the same address
    const port = { ...db, config: { database: { ...db.config.database, port: 5432 } } };
    expect(changedDestination(platformDestination(db), platformDestination(port))).toEqual([]);
  });
});

const base0 = { kind: 'generic', baseUrl: '', config: {} };

describe('changing the address of a platform with stored credentials', () => {
  it('refuses API tokens, also an administrator’s full one – other changes still work with a token', async () => {
    const p = await platform();
    const r = await bearer('PUT', `/platforms/${p.id}`, { baseUrl: 'http://127.0.0.1:4398/collect', credentials: 'keep' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SESSION_REQUIRED');
    const trusted = await bearer('PUT', `/platforms/${p.id}`, { config: { ...p.config, http: { trustedOrigins: ['https://collector.example'] } } });
    expect(trusted.status).toBe(403);
    expect((await s.api('GET', `/platforms/${p.id}`)).baseUrl).toBe('https://api.invented.example/v1');
    const renamed = await bearer('PUT', `/platforms/${p.id}`, { name: 'Renamed by token', description: 'still here' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.secretKeys).toEqual(['token']);
  });

  it('asks for a step-up first', async () => {
    const p = await platform();
    const fresh = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    await fresh('DELETE', '/auth/step-up');
    const r = await refused(fresh('PUT', `/platforms/${p.id}`, { baseUrl: 'https://elsewhere.example', credentials: 'keep' }));
    expect(r).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED', stepUp: { action: 'changePlatformDestination' } } });
    // a new name needs none
    await fresh('PUT', `/platforms/${p.id}`, { name: `${p.name} (renamed)` });
  });

  it('asks what happens to the credentials, and an administrator may keep them', async () => {
    const p = await platform();
    const r = await refused(s.api('PUT', `/platforms/${p.id}`, { baseUrl: 'https://elsewhere.example/v1' }));
    expect(r).toMatchObject({ status: 409, body: { code: 'PLATFORM_DESTINATION_CREDENTIALS', params: { name: p.name, admin: true } } });
    expect((await s.api('GET', `/platforms/${p.id}`)).baseUrl).toBe('https://api.invented.example/v1');
    const kept = await s.api('PUT', `/platforms/${p.id}`, { baseUrl: 'https://elsewhere.example/v1', credentials: 'keep' });
    expect(kept.baseUrl).toBe('https://elsewhere.example/v1');
    expect(kept.secretKeys).toEqual(['token']);
    const [entry] = await auditOf(p.id);
    expect(entry.details).toMatchObject({
      changed: ['baseUrl'],
      credentials: 'kept',
      before: { baseUrl: 'https://api.invented.example' },
      after: { baseUrl: 'https://elsewhere.example' },
    });
  });

  it('removes them when an administrator says so', async () => {
    const p = await platform();
    await s.api('POST', `/platforms/${p.id}/identities`, { name: 'Second' });
    const second = (await s.api('GET', `/platforms/${p.id}/identities`)).find((i: any) => i.name === 'Second');
    await s.api('PUT', `/platforms/${p.id}/identities/${second.id}/secrets`, { token: 'second-token' });
    const after = await s.api('PUT', `/platforms/${p.id}`, {
      config: { ...p.config, http: { trustedOrigins: ['https://collector.example'] } },
      credentials: 'clear',
    });
    expect(after.secretKeys).toEqual([]);
    expect(after.identities.every((i: any) => i.secretKeys.length === 0)).toBe(true);
    const [entry] = await auditOf(p.id);
    expect(entry.details).toMatchObject({ changed: ['trustedOrigins'], credentials: 'removed', after: { trustedOrigins: ['https://collector.example'] } });
    expect(entry.details.identities.sort()).toEqual(['Default', 'Second'].sort());
    // without credentials, the address changes like any other setting (still audited)
    await bearer('PUT', `/platforms/${p.id}`, { baseUrl: 'https://third.example' }).then((r) => expect(r.status).toBe(200));
    expect((await auditOf(p.id))[0].details).toMatchObject({ credentials: 'none', after: { baseUrl: 'https://third.example' } });
  });

  it('a platform manager who is not an administrator can only remove them', async () => {
    const p = await platform({ config: { auth: { type: 'oauth2_client_credentials', tokenUrl: 'https://login.invented.example/token' }, variables: {} } });
    await s.api('PUT', `/platforms/${p.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['manage'] }] });
    const changed = { config: { ...p.config, auth: { ...p.config.auth, tokenUrl: 'https://attacker.example/token' } } };
    expect(await refused(dana('PUT', `/platforms/${p.id}`, changed))).toMatchObject({
      status: 409,
      body: { code: 'PLATFORM_DESTINATION_CREDENTIALS', params: { admin: false } },
    });
    expect(await refused(dana('PUT', `/platforms/${p.id}`, { ...changed, credentials: 'keep' }))).toMatchObject({
      status: 403,
      body: { code: 'PLATFORM_CREDENTIALS_KEEP_ADMIN' },
    });
    expect((await s.api('GET', `/platforms/${p.id}`)).secretKeys).toEqual(['token']);
    const after = await dana('PUT', `/platforms/${p.id}`, { ...changed, credentials: 'clear' });
    expect(after.config.auth.tokenUrl).toBe('https://attacker.example/token');
    expect(after.secretKeys).toEqual([]);
    expect((await auditOf(p.id))[0]).toMatchObject({ actor: 'dana', details: { changed: ['signIn'], credentials: 'removed' } });
  });

  it('treats a secret a destination template names as part of the address (security review 0.19.0 L3)', async () => {
    // the base URL uses a stored secret: changing it alone would send the stored token to another host
    const p = await platform({ baseUrl: 'https://{{ secrets.tenant }}.api.invented.example/v1', secrets: { token: 'stored-token-value', tenant: 'acme' } });
    await s.api('PUT', `/platforms/${p.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['manage'] }] });
    const identity = (await s.api('GET', `/platforms/${p.id}/identities`))[0].id;
    expect(await refused(dana('PUT', `/platforms/${p.id}/identities/${identity}/secrets`, { tenant: 'attacker' }))).toMatchObject({
      status: 403,
      body: { code: 'PLATFORM_DESTINATION_SECRET', params: { keys: ['tenant'] } },
    });
    expect(await refused(dana('PUT', `/platforms/${p.id}/secrets`, { tenant: null }))).toMatchObject({
      status: 403,
      body: { code: 'PLATFORM_DESTINATION_SECRET' },
    });
    // other credentials change as before
    expect(await refused(dana('PUT', `/platforms/${p.id}/identities/${identity}/secrets`, { token: 'rotated' }))).toMatchObject({ status: 200 });
    // an API token cannot, an administrator confirms it first
    expect((await bearer('PUT', `/platforms/${p.id}/identities/${identity}/secrets`, { tenant: 'other' })).body.code).toBe('SESSION_REQUIRED');
    const fresh = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    await fresh('DELETE', '/auth/step-up');
    expect(await refused(fresh('PUT', `/platforms/${p.id}/identities/${identity}/secrets`, { tenant: 'other' }))).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED', stepUp: { action: 'changePlatformDestination' } },
    });
    expect(await refused(s.api('PUT', `/platforms/${p.id}/identities/${identity}/secrets`, { tenant: 'other' }))).toMatchObject({ status: 200 });
    // a template that reads the platform's name: a rename moves the address
    const named = { ...base0, baseUrl: 'https://{{ platform.name }}.invented.example' };
    expect(changedDestination(platformDestination({ ...named, name: 'a' }), platformDestination({ ...named, name: 'b' }))).toEqual(['connection']);
    const { destinationSecretKeys } = await import('../src/platforms/destination.js');
    expect(
      destinationSecretKeys({
        ...base0,
        baseUrl: 'https://{{ secrets["region"] }}.example',
        config: { auth: { type: 'oauth2_client_credentials', tokenUrl: '{{ secrets.idp }}/token' } } as any,
      }),
    ).toEqual(new Set(['region', 'idp']));
    expect(destinationSecretKeys({ ...base0, baseUrl: 'https://{{ secrets[vars.k] }}.example' })).toBe('all');
  });

  it('counts a variable that moves the base URL, and leaves other variables alone', async () => {
    const p = await platform({
      baseUrl: 'https://{{ vars.region }}.api.invented.example',
      config: { auth: { type: 'bearer' }, variables: { region: 'eu', team: 'a' } },
    });
    await s.api('PUT', `/platforms/${p.id}`, { config: { ...p.config, variables: { region: 'eu', team: 'b' } } });
    expect(await auditOf(p.id)).toEqual([]);
    expect(await refused(s.api('PUT', `/platforms/${p.id}`, { config: { ...p.config, variables: { region: 'evil.example#', team: 'b' } } }))).toMatchObject({
      status: 409,
    });
  });

  it('applies to the host of a database platform', async () => {
    const db = await s.api('POST', '/platforms', {
      name: 'Invented shop database',
      kind: 'database',
      config: { database: { dialect: 'postgresql', host: 'db.invented.example', database: 'shop' } },
      secrets: { username: 'reader', password: 'reader-password' },
    });
    const settings = (await s.api('GET', `/platforms/${db.id}`)).config.database;
    expect((await bearer('PUT', `/platforms/${db.id}/database`, { ...settings, host: 'evil.example' })).status).toBe(403);
    // the limits are not an address
    expect((await bearer('PUT', `/platforms/${db.id}/database`, { ...settings, limits: { maxRows: 50 } })).status).toBe(200);
    expect(await refused(s.api('PUT', `/platforms/${db.id}/database`, { ...settings, host: 'evil.example' }))).toMatchObject({ status: 409 });
    const after = await s.api('PUT', `/platforms/${db.id}/database`, { ...settings, port: 6543, credentials: 'clear' });
    expect(after.secretKeys).toEqual([]);
    expect((await auditOf(db.id))[0].details).toMatchObject({ changed: ['connection'], after: { connection: ['database=db.invented.example:6543'] } });
  });

  it('keeps an identity from moving a Kafka connection with its own variables', async () => {
    const k = await s.api('POST', '/platforms', {
      name: 'Invented Kafka',
      kind: 'kafka',
      config: { auth: { type: 'none' }, variables: { bootstrap: 'b1.invented.example:9092' } },
      secrets: { username: 'key', password: 'secret' },
    });
    expect(await refused(s.api('POST', `/platforms/${k.id}/identities`, { name: 'Elsewhere', variables: { bootstrap: 'evil.example:9092' } }))).toMatchObject({
      status: 400,
      body: { code: 'IDENTITY_VARIABLE_FIXED' },
    });
  });
});
