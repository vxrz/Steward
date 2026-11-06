import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
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

  it('refuses a missing or wrong token from the headers, before the body is read (security review of #222)', async () => {
    // 20 MB announced, 1 KB sent and the rest never: only an answer from the headers arrives in time
    const headOnly = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const u = new URL(`${s.base}/api/hooks/db-schema/system/${systemId}`);
        const req = http.request(
          {
            host: u.hostname,
            port: u.port,
            path: u.pathname,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': String(20 * 1024 * 1024), ...headers },
          },
          (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () => {
              clearTimeout(timer);
              req.destroy();
              resolve({ status: res.statusCode!, body });
            });
          },
        );
        const timer = setTimeout(() => {
          req.destroy();
          reject(new Error('no answer before the body was complete'));
        }, 5000);
        req.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        req.write('x'.repeat(1024));
      });
    const wrong = await headOnly({ authorization: `Bearer sdbp_${'x'.repeat(43)}` });
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body).code).toBe('DB_SCHEMA_PUSH_TOKEN_INVALID');
    expect((await headOnly({})).status).toBe(401);
    const full = (await s.api('POST', '/me/tokens', { name: 'not here', scope: 'full' })).token;
    expect(JSON.parse((await headOnly({ authorization: `Bearer ${full}` })).body).code).toBe('DB_SCHEMA_PUSH_API_TOKEN');
    // a valid token of another target, and a valid one with the wrong content type: refused from the headers too
    const other = await s.api('POST', `/db-schemas/system/${otherSystem}/push-tokens`, { name: 'other target' });
    expect(said(JSON.parse((await headOnly({ authorization: `Bearer ${other.token}` })).body))).toEqual(said(JSON.parse(wrong.body)));
    const mine = await s.api('POST', `/db-schemas/system/${systemId}/push-tokens`, { name: 'wrong type' });
    expect((await headOnly({ authorization: `Bearer ${mine.token}`, 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    // the token still pushes a whole file
    expect((await push('system', systemId, mine.token)).status).toBe(200);
  });

  it('stops when its creator is deactivated or may no longer manage the database (owner decision, like API tokens)', async () => {
    const { user, temporaryPassword } = await s.api('POST', '/users', { username: 'cora-ci', roles: ['operator'] });
    const first = await s.as('cora-ci', temporaryPassword);
    await first('POST', '/auth/password', { current: temporaryPassword, next: 'Cora-password-123' });
    const cora = await s.as('cora-ci', 'Cora-password-123');
    const acl = (permissions: string[]) => s.api('PUT', `/platforms/${db.id}/access`, { acl: [{ subject: 'user:cora-ci', permissions }] });
    try {
      await acl(['manage']);
      const t = await cora('POST', `/db-schemas/platform/${db.id}/push-tokens`, { name: 'cora ci' });
      expect(t.createdBy).toBe('cora-ci');
      expect(t.creatorInactive).toBe(false);
      expect((await push('platform', db.id, t.token)).status).toBe(200);
      const wrong = await push('platform', db.id, `sdbp_${'x'.repeat(43)}`);
      const listed = async () => (await s.api('GET', `/db-schemas/platform/${db.id}/push-tokens`)).find((x: { id: string }) => x.id === t.id);

      await s.api('PUT', `/users/${user.id}`, { active: false });
      const off = await push('platform', db.id, t.token);
      expect(off.status).toBe(401);
      expect(said(off.json)).toEqual(said(wrong.json));
      expect((await listed()).creatorInactive).toBe(true);
      await s.api('PUT', `/users/${user.id}`, { active: true });
      expect((await push('platform', db.id, t.token)).status).toBe(200);

      // only "use" left: the token stops as well
      await acl(['use']);
      const lost = await push('platform', db.id, t.token);
      expect(lost.status).toBe(401);
      expect(said(lost.json)).toEqual(said(wrong.json));
      expect((await listed()).creatorInactive).toBe(true);
      // a token of someone who may still manage it goes on working
      const mine = await s.api('POST', `/db-schemas/platform/${db.id}/push-tokens`, { name: 'admin ci' });
      expect((await push('platform', db.id, mine.token)).status).toBe(200);
      expect((await listed()).creatorInactive).toBe(true);
    } finally {
      await s.api('PUT', `/platforms/${db.id}/access`, { acl: [] });
    }
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

describe('the history a push token cannot erase (security review of #222)', () => {
  const tbls = (tables: string[]) =>
    JSON.stringify({
      name: 'shop',
      driver: { name: 'postgres' },
      tables: tables.map((t) => ({ name: `public.${t}`, type: 'BASE TABLE', columns: [{ name: 'id', type: 'integer', nullable: false }] })),
    });

  it('a push removes imported snapshots only, never Steward’s own reads', async () => {
    await setEnv({ SM_RATE_LIMIT_PER_MINUTE: '10000' });
    try {
      await s.api('PUT', `/db-schemas/platform/${db.id}/settings`, { retention: 3, readIntervalHours: 0 });
      const read = (await s.api('POST', `/db-schemas/platform/${db.id}/read`)).snapshot;
      expect(read.source).toBe('read');
      const t = await s.api('POST', `/db-schemas/platform/${db.id}/push-tokens`, { name: 'many', rateLimitPerMinute: 120 });
      for (let i = 0; i < 8; i++) expect((await push('platform', db.id, t.token, tbls([`fake_${i}`]))).status).toBe(200);
      const o = await s.api('GET', `/db-schemas/platform/${db.id}`);
      expect(o.snapshots.some((x: { id: string }) => x.id === read.id)).toBe(true);
      expect(o.snapshots).toHaveLength(3);
      // a read prunes by the retention as before
      await s.api('PUT', `/db-schemas/platform/${db.id}/settings`, { retention: 30, readIntervalHours: 0 });
    } finally {
      await setEnv({ SM_RATE_LIMIT_PER_MINUTE: undefined });
    }
  });

  it('keeps a recorded breaking change while a monitor’s check still counts it', async () => {
    await setEnv({ SM_RATE_LIMIT_PER_MINUTE: '10000' });
    try {
      const run = async (watched: boolean) => {
        const sys = (await s.api('POST', '/systems', { name: `History ${watched ? 'watched' : 'unwatched'}`, kind: 'server' })).id;
        await s.api('PUT', `/db-schemas/system/${sys}/settings`, { retention: 2, readIntervalHours: 0 });
        if (watched)
          await s.api('POST', '/monitors', {
            definition: {
              name: `Schema of ${sys}`,
              checks: [{ id: 'schema', name: 'Schema', type: 'db-schema', system: sys, mode: 'breaking', withinHours: 24 }],
            },
          });
        const t = await s.api('POST', `/db-schemas/system/${sys}/push-tokens`, { name: 'ci', rateLimitPerMinute: 120 });
        expect((await push('system', sys, t.token, tbls(['a', 'b']))).status).toBe(200);
        // b removed: breaking
        const breaking = await push('system', sys, t.token, tbls(['a']));
        expect(breaking.json.diff.breaking).toBe(1);
        // then only additions, more than the retention
        for (let i = 0; i < 5; i++)
          expect((await push('system', sys, t.token, tbls(['a', ...Array.from({ length: i + 1 }, (_, k) => `n${k}`)]))).json.diff.breaking).toBe(0);
        const o = await s.api('GET', `/db-schemas/system/${sys}`);
        const check = await s.api('POST', '/monitors/check-preview', {
          check: { id: 'c', name: 'c', type: 'db-schema', system: sys, mode: 'breaking', withinHours: 24 },
        });
        return { kept: o.snapshots.some((x: { id: string }) => x.id === breaking.json.snapshot.id), count: o.snapshots.length, check };
      };
      const watched = await run(true);
      expect(watched.kept).toBe(true);
      expect(watched.count).toBeLessThanOrEqual(4);
      expect(watched.check).toMatchObject({ status: 'down', message: expect.stringMatching(/1 breaking schema change/) });
      // no monitor counts it: the retention alone decides, as before
      const unwatched = await run(false);
      expect(unwatched.kept).toBe(false);
      expect(unwatched.count).toBe(2);
    } finally {
      await setEnv({ SM_RATE_LIMIT_PER_MINUTE: undefined });
    }
  });
});
