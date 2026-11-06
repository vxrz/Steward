import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_KIND } from '@sm/shared';
import { setEnv, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Push tokens of the tbls import from CI (#222, docs/DATABASES.md#tbls-from-ci): bound to one database platform or
 * system, stored as a hash only and shown once, created, rotated and revoked by who may manage the target, audited on
 * every change and push; the endpoint POST /api/hooks/db-schema/<kind>/<id> takes nothing else – no API token, no
 * session – and answers a token of another target, a revoked or expired one and a refused address like a wrong one.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(here, 'fixtures', 'tbls', 'schema.json'), 'utf8');
const LINT = fs.readFileSync(path.join(here, 'fixtures', 'tbls', 'lint.txt'), 'utf8');
const PW = 'Demo-password-1';

let s: TestServer;
let db: { id: string };
let systemId: string;
let otherSystem: string;
let olivia: Client;
let vera: Client;
/** What an answer says, without the request's own address and id */
const said = (j: Record<string, unknown>) => ({ error: j.error, code: j.code, status: j.status, title: j.title, type: j.type });
const sha = (x: string) => crypto.createHash('sha256').update(x).digest('hex');

async function push(kind: string, id: string, token: string | null, body: string = SCHEMA, headers: Record<string, string> = {}) {
  const res = await fetch(`${s.base}/api/hooks/db-schema/${kind}/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  db = (await s.api('GET', '/platforms')).find((p: { kind: string }) => p.kind === DATABASE_KIND);
  systemId = (await s.api('POST', '/systems', { name: 'Bakery database', kind: 'server' })).id;
  otherSystem = (await s.api('POST', '/systems', { name: 'Other database', kind: 'server' })).id;
}, 120_000);
beforeEach(async () => {
  (await import('../src/dbschema/push.js')).resetPushState();
});
afterAll(async () => {
  await s?.app.close();
});

describe('push tokens', () => {
  it('are created by who may manage the target, shown once and stored as a hash only', async () => {
    await expect(olivia('POST', `/db-schemas/platform/${db.id}/push-tokens`, { name: 'ci' })).rejects.toMatchObject({ status: 403 });
    await expect(vera('GET', `/db-schemas/platform/${db.id}/push-tokens`)).rejects.toMatchObject({ status: 404 });
    await expect(vera('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'ci' })).rejects.toMatchObject({ status: 403 });
    const t = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'GitHub Actions', expiresInDays: 30 });
    expect(t.token).toMatch(/^sdbp_[A-Za-z0-9_-]{40,}$/);
    expect(t).toMatchObject({
      name: 'GitHub Actions',
      path: `/api/hooks/db-schema/system/${systemId}`,
      lastUsedAt: null,
      expired: false,
      rateLimitPerMinute: 10,
    });
    expect(t.prefix).toBe(t.token.slice(0, 11));
    const list = await s.api('GET', `/db-schemas/system/${systemId}/push-tokens`);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(t.token);
    const { db: store } = await import('../src/db.js');
    const row = store().get<Record<string, unknown>>('SELECT * FROM db_schema_push_tokens WHERE id = ?', t.id)!;
    expect(row.hash).toBe(sha(t.token));
    expect(JSON.stringify(row)).not.toContain(t.token);
    const [entry] = await s.api('GET', `/audit?action=dbschema.push_token_created&entityId=${systemId}`);
    expect(entry.details).toMatchObject({ tokenId: t.id, name: 'GitHub Actions' });
    expect(JSON.stringify(entry)).not.toContain(t.token);
    // nor does the log or the audit export: the audit log as a whole never holds the secret
    expect(JSON.stringify(await s.api('GET', '/audit?limit=200'))).not.toContain(t.token);
  });

  it('refuses invalid address ranges', async () => {
    await expect(s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'x', allowedCidrs: ['10.0.0.0/99'] })).rejects.toMatchObject({
      status: 400,
      body: { code: 'DB_SCHEMA_PUSH_CIDR' },
    });
  });
});

describe('the push endpoint', () => {
  it('imports the file with the token of its target, audited with the token and the SHA-256', async () => {
    const t = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'ci main' });
    const r = await push('system', systemId, t.token);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ created: true, snapshot: { source: 'tbls', via: 'push', actor: 'push token "ci main"', sha256: sha(SCHEMA) } });
    // the same file again: no new snapshot; with the lint output: { schema, lint, fileName }
    expect((await push('system', systemId, t.token)).json).toMatchObject({ created: false });
    const lint = await push('system', systemId, t.token, JSON.stringify({ schema: SCHEMA, lint: LINT, fileName: 'ci/schema.json' }));
    expect(lint.json).toMatchObject({ created: true, snapshot: { checks: 3, fileName: 'ci_schema.json' } });
    const entries = await s.api('GET', `/audit?action=dbschema.imported&entityId=${systemId}`);
    expect(entries[0]).toMatchObject({ actor: 'push token "ci main"' });
    expect(entries[0].details).toMatchObject({ via: 'push', tokenId: t.id, tokenName: 'ci main', sha256: sha(SCHEMA), checks: 3 });
    expect(JSON.stringify(entries)).not.toContain(t.token);
    const listed = (await s.api('GET', `/db-schemas/system/${systemId}/push-tokens`)).find((x: { id: string }) => x.id === t.id);
    expect(listed.lastUsedAt).toBeTruthy();
    expect(listed.lastUsedIp).toBeTruthy();
  });

  it('answers a token of another target, an unknown, revoked or expired one alike', async () => {
    const t = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'bound' });
    const other = await push('system', otherSystem, t.token);
    const wrong = await push('system', systemId, `sdbp_${'x'.repeat(43)}`);
    const unknownTarget = await push('system', 'sys_nope', t.token);
    const otherKind = await push('platform', systemId, t.token);
    for (const r of [other, wrong, unknownTarget, otherKind]) {
      expect(r.status).toBe(401);
      expect(said(r.json)).toEqual(said(wrong.json));
      expect(r.json).toMatchObject({ error: 'Invalid push token for this database', code: 'DB_SCHEMA_PUSH_TOKEN_INVALID' });
    }
    await s.api('DELETE', `/db-schemas/system/${systemId}/push-tokens/${t.id}`);
    expect(said((await push('system', systemId, t.token)).json)).toEqual(said(wrong.json));
    const [revoked] = await s.api('GET', `/audit?action=dbschema.push_token_revoked&entityId=${systemId}`);
    expect(revoked.details).toMatchObject({ tokenId: t.id });
    // expired
    const e = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'old', expiresInDays: 1 });
    const { db: store } = await import('../src/db.js');
    store().run('UPDATE db_schema_push_tokens SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), e.id);
    expect(said((await push('system', systemId, e.token)).json)).toEqual(said(wrong.json));
    expect((await s.api('GET', `/db-schemas/system/${systemId}/push-tokens`)).find((x: { id: string }) => x.id === e.id).expired).toBe(true);
  });

  it('rotates: the old secret stops working at once', async () => {
    const t = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'rotating' });
    const r = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens/${t.id}/rotate`);
    expect(r.token).not.toBe(t.token);
    expect((await push('system', systemId, t.token)).status).toBe(401);
    expect((await push('system', systemId, r.token)).status).toBe(200);
    const [entry] = await s.api('GET', `/audit?action=dbschema.push_token_rotated&entityId=${systemId}`);
    expect(entry.details).toMatchObject({ tokenId: t.id, previousPrefix: t.prefix });
    await expect(olivia('POST', `/db-schemas/platform/${db.id}/push-tokens/${t.id}/rotate`)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an address outside the allowed ranges like a wrong token', async () => {
    const t = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'lan only', allowedCidrs: ['10.20.0.0/16'] });
    const r = await push('system', systemId, t.token);
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('DB_SCHEMA_PUSH_TOKEN_INVALID');
    const ok = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'local', allowedCidrs: ['127.0.0.1', '::1'] });
    expect((await push('system', systemId, ok.token)).status).toBe(200);
  });

  it('takes no API token and no session', async () => {
    const full = (await s.api('POST', '/me/tokens', { name: 'full', scope: 'full' })).token;
    const r = await push('system', systemId, full);
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('DB_SCHEMA_PUSH_API_TOKEN');
    expect(r.json.error).toMatch(/not an API token/);
    const read = (await s.api('POST', '/me/tokens', { name: 'read', scope: 'read' })).token;
    expect((await push('system', systemId, read)).status).toBe(403);
    const t = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'with cookie' });
    const withSession = await push('system', systemId, t.token, SCHEMA, { cookie: 'sm_session=whatever' });
    expect(withSession.status).toBe(400);
    expect(withSession.json.code).toBe('DB_SCHEMA_PUSH_SESSION');
    // signed in through the internal API: the session goes nowhere either
    await expect(s.api('POST', `/hooks/db-schema/system/${systemId}`, { schema: SCHEMA })).rejects.toMatchObject({ status: 400 });
    expect((await push('system', systemId, null)).json.code).toBe('DB_SCHEMA_PUSH_TOKEN_MISSING');
    // the public API does not write
    const v1 = await fetch(`${s.base}/api/v1/systems/${systemId}/schema/tbls`, { method: 'POST', headers: { authorization: `Bearer ${full}` }, body: SCHEMA });
    expect(v1.status).toBe(405);
  });

  it('refuses what is not a tbls schema, and a body that is not JSON', async () => {
    const t = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'bad files' });
    expect((await push('system', systemId, t.token, '{"tables": 1}')).json.code).toBe('DB_SCHEMA_TBLS_INVALID');
    expect((await push('system', systemId, t.token, '')).status).toBe(400);
    expect((await push('system', systemId, t.token, SCHEMA, { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
  });

  it('keeps to the rate limit of the token', async () => {
    await setEnv({ SM_RATE_LIMIT_PER_MINUTE: '10000' });
    const t = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'busy', rateLimitPerMinute: 2 });
    expect((await push('system', systemId, t.token)).status).toBe(200);
    expect((await push('system', systemId, t.token)).status).toBe(200);
    const third = await push('system', systemId, t.token);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    await setEnv({ SM_RATE_LIMIT_PER_MINUTE: undefined });
  });

  it('pushes for a database platform too, and its token dies with the platform', async () => {
    const t = await s.api('POST', `/db-schemas/platform/${db.id}/push-tokens`, { name: 'platform ci' });
    expect((await push('platform', db.id, t.token)).status).toBe(200);
    const sys = await s.api('POST', '/systems', { name: 'Short-lived', kind: 'server' });
    const gone = await s.api('POST', `/db-schemas/system/${sys.id}/push-tokens`, { name: 'gone' });
    await s.api('DELETE', `/systems/${sys.id}`);
    await (await import('../src/dbschema/service.js')).runSchemaJob();
    const { db: store } = await import('../src/db.js');
    expect(store().get('SELECT 1 AS x FROM db_schema_push_tokens WHERE id = ?', gone.id)).toBeUndefined();
  });
});
