import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Platform identities, step 1 (0.9.0, #228, ADR 0009): one default identity per platform, no change in behaviour.
 * The SQL migration, the one-time step after unlock (also after a crash), the resolver, the caches per identity, key
 * rotation, the API fields, and a scan that keeps platforms.secrets inside the resolver.
 */
let s: TestServer;
let echo: http.Server;
let echoBase = '';
let tokensIssued = 0;
/** Authorization header (or API key header) of the last request to the echo server */
let lastAuth: string | undefined;

const PASSPHRASE = 'correct horse battery';
const MIGRATED = 'security.platformIdentitiesMigrated';

const db = async () => (await import('../src/db.js')).db();

beforeAll(async () => {
  echo = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/oauth/token') {
      tokensIssued++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: `tok-${tokensIssued}`, expires_in: 1800 }));
      return;
    }
    lastAuth = (req.headers.authorization as string | undefined) ?? (req.headers['x-api-key'] as string | undefined);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  echoBase = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await s?.app.close();
  echo?.close();
});

const http0 = { proxy: 'none' };

async function apiKeyPlatform(name: string, key = 'key-value-1234'): Promise<any> {
  const p = await s.api('POST', '/platforms', {
    name,
    kind: 'generic',
    baseUrl: echoBase,
    config: { variables: {}, http: http0, auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' }, testPath: '/ping' },
  });
  await s.api('PUT', `/platforms/${p.id}/secrets`, { apiKey: key });
  return p;
}

async function oauthPlatform(name: string): Promise<any> {
  const p = await s.api('POST', '/platforms', {
    name,
    kind: 'generic',
    baseUrl: echoBase,
    config: {
      variables: {},
      http: http0,
      auth: { type: 'oauth2_client_credentials', tokenUrl: `${echoBase}/oauth/token`, clientAuth: 'body' },
      testPath: '/ping',
    },
  });
  await s.api('PUT', `/platforms/${p.id}/secrets`, { clientId: 'svc', clientSecret: 'client-secret-value-1' });
  return p;
}

/** What a client sees of a platform – the parts that must not change with the upgrade. */
const view = (p: any) => ({ config: p.config, secretKeys: p.secretKeys, integrity: p.integrity, acl: p.acl, permissions: p.permissions });

/**
 * Puts every platform back into the 0.8.0 layout (credentials and MCP mode on the platform row, sealed as 0.8.0 sealed
 * them) and runs the INSERT of the migration platforms-005-identities again – the state right after an update, before
 * the vault is unlocked.
 */
async function toOldLayout(): Promise<void> {
  const d = await db();
  const { PLATFORM_MIGRATIONS } = await import('../src/migrations/platforms.js');
  const { sealPlatform } = await import('../src/platforms/integrity.js');
  for (const p of d.all<{ id: string; config: string }>('SELECT id, config FROM platforms')) {
    const i = d.get<{ secrets: string | null; mcp: string }>('SELECT secrets, mcp FROM platform_identities WHERE platform_id = ? AND is_default = 1', p.id)!;
    const cfg = JSON.parse(p.config);
    const mcp = JSON.parse(i.mcp);
    if (cfg.mcpGateway || mcp.mode !== 'off' || mcp.writes) {
      const prefixes = cfg.mcpGateway?.allowedPathPrefixes ?? [];
      cfg.mcpGateway = {
        enabled: mcp.mode !== 'off',
        ...(prefixes.length ? { allowedPathPrefixes: prefixes } : {}),
        ...(mcp.writes ? { writes: mcp.writes } : {}),
      };
    }
    d.run('UPDATE platforms SET secrets = ?, config = ? WHERE id = ?', i.secrets, JSON.stringify(cfg), p.id);
  }
  d.run('DELETE FROM platform_identities');
  const m = PLATFORM_MIGRATIONS.find((x) => x.name === 'platforms-005-identities')!;
  const sql = d.dialect === 'postgres' ? m.pg! : m.sql;
  d.exec(sql.slice(sql.indexOf('INSERT INTO platform_identities')));
  for (const p of d.all<{ id: string }>('SELECT id FROM platforms')) sealPlatform(p.id);
  d.run('DELETE FROM settings WHERE key = ?', MIGRATED);
}

/** Locks and unlocks the vault: the one-time step runs after the unlock. */
async function relock(): Promise<void> {
  await s.api('POST', '/vault/lock');
  await s.api('POST', '/vault/unlock', { passphrase: PASSPHRASE });
}

const createdEntries = async () => (await s.api('GET', '/audit?action=platform.identities_created&limit=50')) as any[];

describe('the SQL migration and the one-time step after unlock', () => {
  it('moves credentials and MCP modes to sealed default identities – nothing changes for clients', async () => {
    const a = await apiKeyPlatform('Identity A');
    const b = await oauthPlatform('Identity B');
    const c = await apiKeyPlatform('Identity C');
    await s.api('PUT', `/platforms/${a.id}/mcp-gateway`, { enabled: true, allowedPathPrefixes: ['/api/v1/devices'] });
    await s.api('PUT', `/platforms/${b.id}/mcp-gateway`, { enabled: true, writes: 'confirm' });
    // turned off again: the approval mode chosen before is remembered (as in 0.8.0)
    await s.api('PUT', `/platforms/${c.id}/mcp-gateway`, { enabled: true, writes: 'fourEyes' });
    await s.api('PUT', `/platforms/${c.id}/mcp-gateway`, { enabled: false });
    const before = new Map((await s.api('GET', '/platforms')).map((p: any) => [p.id, view(p)]));
    await s.api('POST', `/platforms/${a.id}/test`);
    const authBefore = lastAuth;

    await toOldLayout();
    const d = await db();
    // the SQL migration: deterministic ids, the ciphertext copied unchanged, the MCP mode from config.mcpGateway, unsealed
    const rowsA = d.all<any>('SELECT * FROM platform_identities WHERE platform_id = ?', a.id);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({
      id: `pi_${a.id.slice(3)}`,
      name: 'Default',
      auth: null,
      variables: '{}',
      acl: '[]',
      config_mac: null,
      created_by: 'system',
    });
    expect(Number(rowsA[0].is_default)).toBe(1);
    expect(rowsA[0].secrets).toBe(d.get<{ secrets: string }>('SELECT secrets FROM platforms WHERE id = ?', a.id)!.secrets);
    const mcpOf = (id: string) => JSON.parse(d.get<{ mcp: string }>('SELECT mcp FROM platform_identities WHERE platform_id = ?', id)!.mcp);
    expect(mcpOf(a.id)).toEqual({ mode: 'read' });
    expect(mcpOf(b.id)).toEqual({ mode: 'writes', writes: 'confirm' });
    expect(mcpOf(c.id)).toEqual({ mode: 'off', writes: 'fourEyes' });
    // an unsealed identity is never used (the vault is locked at this point after a real update)
    await expect(s.api('POST', `/platforms/${a.id}/test`)).rejects.toMatchObject({ status: 409 });

    const entriesBefore = (await createdEntries()).length;
    await relock();
    expect(d.all('SELECT id FROM platforms WHERE secrets IS NOT NULL')).toEqual([]);
    expect(d.all("SELECT id FROM platform_identities WHERE config_mac IS NULL OR config_mac = ''")).toEqual([]);
    for (const p of d.all<{ config: string }>('SELECT config FROM platforms')) {
      const g = JSON.parse(p.config).mcpGateway;
      if (g) expect(Object.keys(g)).toEqual(['allowedPathPrefixes']);
    }
    // the same view as before: MCP mode, path prefixes, credential names, integrity
    const after = await s.api('GET', '/platforms');
    for (const p of after) expect(view(p), p.name).toEqual(before.get(p.id));
    expect(after.find((p: any) => p.id === a.id).config.mcpGateway).toEqual({ enabled: true, allowedPathPrefixes: ['/api/v1/devices'] });
    expect(after.find((p: any) => p.id === c.id).config.mcpGateway).toEqual({ enabled: false, writes: 'fourEyes' });
    // the same credentials are sent
    lastAuth = undefined;
    expect((await s.api('POST', `/platforms/${a.id}/test`)).ok).toBe(true);
    expect(lastAuth).toBe(authBefore);
    expect((await s.api('POST', `/platforms/${b.id}/test`)).ok).toBe(true);
    // one audit entry, the setting written
    const entries = await createdEntries();
    expect(entries.length).toBe(entriesBefore + 1);
    expect(entries[0]).toMatchObject({ actor: 'system', details: { count: after.length } });
    expect(entries[0].details.platforms).toEqual(expect.arrayContaining(['Identity A', 'Identity B', 'Identity C']));
    expect(JSON.stringify(entries[0])).not.toContain('key-value-1234');
    expect(d.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', MIGRATED)!.value).toBe('true');
    // idempotent: another unlock changes nothing and writes nothing
    await relock();
    expect((await createdEntries()).length).toBe(entriesBefore + 1);
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
  });

  it('keeps a platform that was changed outside Steward unconverted and refused until an administrator confirms', async () => {
    const p = await apiKeyPlatform('Identity tampered', 'tampered-key-5678');
    await toOldLayout();
    const d = await db();
    d.run("UPDATE platforms SET environment = 'changed in the database' WHERE id = ?", p.id);
    await relock();
    // not converted: the credentials stay on the platform row, the identity stays unsealed – both refused
    expect(d.get<{ secrets: string | null }>('SELECT secrets FROM platforms WHERE id = ?', p.id)!.secrets).not.toBeNull();
    expect(d.get<{ config_mac: string | null }>('SELECT config_mac FROM platform_identities WHERE platform_id = ?', p.id)!.config_mac).toBeNull();
    const shown = await s.api('GET', `/platforms/${p.id}`);
    expect(shown.integrity).toBe('mismatch');
    expect(shown.identities[0].integrity).toBe('unsealed');
    await expect(s.api('POST', `/platforms/${p.id}/test`)).rejects.toMatchObject({ status: 409, body: { code: 'PLATFORM_CONFIG_UNVERIFIED' } });
    const entry = (await createdEntries())[0];
    expect(entry.details.notIntact).toContain('Identity tampered');
    // the administrator confirms: credentials moved, both sealed, usable again
    await s.api('POST', `/platforms/${p.id}/confirm-config`);
    expect(d.get<{ secrets: string | null }>('SELECT secrets FROM platforms WHERE id = ?', p.id)!.secrets).toBeNull();
    const confirmed = await s.api('GET', `/platforms/${p.id}`);
    expect(confirmed.integrity).toBe('ok');
    expect(confirmed.identities[0]).toMatchObject({ integrity: 'ok', secretKeys: ['apiKey'] });
    lastAuth = undefined;
    expect((await s.api('POST', `/platforms/${p.id}/test`)).ok).toBe(true);
    expect(lastAuth).toBe('tampered-key-5678');
  });

  it('never seals what was put into an identity row in the database before the step (the platform row decides)', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'Identity without credentials',
      kind: 'generic',
      baseUrl: echoBase,
      config: { variables: {}, http: http0, auth: { type: 'none' } },
    });
    const other = await apiKeyPlatform('Identity with credentials', 'other-key-9012');
    await toOldLayout();
    const d = await db();
    const foreign = d.get<{ secrets: string }>('SELECT secrets FROM platform_identities WHERE platform_id = ?', other.id)!.secrets;
    // a database administrator plants credentials and a sign-in pointing elsewhere into the unsealed row
    d.run(
      'UPDATE platform_identities SET secrets = ?, auth = ?, variables = ? WHERE platform_id = ?',
      foreign,
      JSON.stringify({ type: 'bearer' }),
      JSON.stringify({ tenant: 'evil' }),
      p.id,
    );
    await relock();
    const row = d.get<any>('SELECT * FROM platform_identities WHERE platform_id = ?', p.id);
    expect(row).toMatchObject({ secrets: null, auth: null, variables: '{}' });
    expect((await s.api('GET', `/platforms/${p.id}`)).integrity).toBe('ok');
  });

  it('survives a crash in the middle: a failed platform is rolled back and moved at the next unlock', async () => {
    const a = await apiKeyPlatform('Crash first', 'crash-key-aaaa');
    const b = await apiKeyPlatform('Crash second', 'crash-key-bbbb');
    await toOldLayout();
    const d = await db();
    // the "crash": emptying the second platform's credentials fails inside its transaction
    if (d.dialect === 'postgres') {
      d.exec(`CREATE FUNCTION crash_identities() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.secrets IS NULL AND OLD.secrets IS NOT NULL AND OLD.id = '${b.id}' THEN RAISE EXCEPTION 'crash'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER crash_identities BEFORE UPDATE ON platforms FOR EACH ROW EXECUTE FUNCTION crash_identities();`);
    } else {
      d.exec(`CREATE TRIGGER crash_identities BEFORE UPDATE OF secrets ON platforms
        WHEN NEW.secrets IS NULL AND OLD.secrets IS NOT NULL AND OLD.id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'crash'); END;`);
    }
    try {
      await relock(); // the unlock itself succeeds
    } finally {
      d.exec(d.dialect === 'postgres' ? 'DROP TRIGGER crash_identities ON platforms; DROP FUNCTION crash_identities();' : 'DROP TRIGGER crash_identities;');
    }
    const secretsOf = (id: string) => d.get<{ secrets: string | null }>('SELECT secrets FROM platforms WHERE id = ?', id)!.secrets;
    expect(secretsOf(a.id)).toBeNull();
    // rolled back completely: old layout, identity unsealed (refused), the setting not written
    expect(secretsOf(b.id)).not.toBeNull();
    expect(d.get<{ config_mac: string | null }>('SELECT config_mac FROM platform_identities WHERE platform_id = ?', b.id)!.config_mac).toBeNull();
    await expect(s.api('POST', `/platforms/${b.id}/test`)).rejects.toMatchObject({ status: 409 });
    expect(d.get('SELECT value FROM settings WHERE key = ?', MIGRATED)).toBeUndefined();
    expect((await createdEntries())[0].details.failed).toBe(1);
    // the next unlock carries on: only the second platform is left
    await relock();
    expect(secretsOf(b.id)).toBeNull();
    expect((await createdEntries())[0].details.platforms).toEqual(['Crash second']);
    for (const [p, key] of [
      [a, 'crash-key-aaaa'],
      [b, 'crash-key-bbbb'],
    ] as const) {
      lastAuth = undefined;
      expect((await s.api('POST', `/platforms/${p.id}/test`)).ok).toBe(true);
      expect(lastAuth).toBe(key);
    }
  });

  it('skips a platform converted before a crash between two platforms', async () => {
    const a = await apiKeyPlatform('Between first', 'between-key-aaaa');
    const b = await apiKeyPlatform('Between second', 'between-key-bbbb');
    await toOldLayout();
    const { moveToDefaultIdentity } = await import('../src/platforms/integrity.js');
    moveToDefaultIdentity(a.id); // done before the "crash"; the setting was never written
    const d = await db();
    const macA = d.get<{ config_mac: string }>('SELECT config_mac FROM platform_identities WHERE platform_id = ?', a.id)!.config_mac;
    await relock();
    expect(d.get<{ config_mac: string }>('SELECT config_mac FROM platform_identities WHERE platform_id = ?', a.id)!.config_mac).toBe(macA);
    const moved = (await createdEntries())[0].details.platforms as string[];
    expect(moved).toContain('Between second');
    expect(moved).not.toContain('Between first');
    for (const p of [a, b]) expect((await s.api('POST', `/platforms/${p.id}/test`)).ok).toBe(true);
  });
});

describe('migration packages', () => {
  it('converts the platforms of a package from an older version that were intact on the source, and seals new-layout identities', async () => {
    const { sealImported } = await import('../src/migration/import.js');
    const a = await apiKeyPlatform('Package intact', 'package-key-aaaa');
    const b = await apiKeyPlatform('Package changed', 'package-key-bbbb');
    const d = await db();
    const all = d.all<{ id: string }>('SELECT id FROM platforms').map((r) => r.id);
    // an older package: old layout, no identityIntegrity in its manifest
    await toOldLayout();
    sealImported(Object.fromEntries(all.map((id) => [id, id === b.id ? 'mismatch' : 'ok'])), undefined);
    const secretsOf = (id: string) => d.get<{ secrets: string | null }>('SELECT secrets FROM platforms WHERE id = ?', id)!.secrets;
    expect(secretsOf(a.id)).toBeNull();
    expect((await s.api('GET', `/platforms/${a.id}`)).integrity).toBe('ok');
    lastAuth = undefined;
    expect((await s.api('POST', `/platforms/${a.id}/test`)).ok).toBe(true);
    expect(lastAuth).toBe('package-key-aaaa');
    // changed on the source: unsealed, old layout, refused until an administrator confirms
    expect(secretsOf(b.id)).not.toBeNull();
    expect((await s.api('GET', `/platforms/${b.id}`)).integrity).toBe('unsealed');
    await s.api('POST', `/platforms/${b.id}/confirm-config`);
    // a package of this version: identities sealed when they were intact on the source, the others not
    const ia = `pi_${a.id.slice(3)}`;
    const ib = `pi_${b.id.slice(3)}`;
    sealImported(
      Object.fromEntries(all.map((id) => [id, 'ok'])),
      Object.fromEntries(d.all<{ id: string }>('SELECT id FROM platform_identities').map((r) => [r.id, r.id === ib ? 'mismatch' : 'ok'])),
    );
    expect(d.get<{ config_mac: string | null }>('SELECT config_mac FROM platform_identities WHERE id = ?', ia)!.config_mac).toBeTruthy();
    expect(d.get<{ config_mac: string | null }>('SELECT config_mac FROM platform_identities WHERE id = ?', ib)!.config_mac).toBeNull();
    await expect(s.api('POST', `/platforms/${b.id}/test`)).rejects.toMatchObject({ status: 409 });
    await s.api('POST', `/platforms/${b.id}/confirm-config`);
    expect((await s.api('POST', `/platforms/${b.id}/test`)).ok).toBe(true);
  });
});

describe('the resolver getConnection()', () => {
  it('gives the platform with its default identity merged in, checks both seals', async () => {
    const { getConnection, getPlatform, getSecrets } = await import('../src/platforms/service.js');
    const p = await apiKeyPlatform('Resolver', 'resolver-key-1234');
    const c = getConnection(p.id);
    expect(c.platform).toMatchObject({ id: p.id, identityId: `pi_${p.id.slice(3)}`, identityName: 'Default' });
    expect(c.platform.config.auth).toEqual(getPlatform(p.id).config.auth);
    expect(c.identity).toMatchObject({
      default: true,
      readOnly: false,
      privileged: false,
      mcp: { mode: 'off' },
      operationFilter: null,
      secretKeys: ['apiKey'],
    });
    expect(c.secrets).toEqual({ apiKey: 'resolver-key-1234' });
    expect(getSecrets(p.id)).toEqual(c.secrets);
    expect(() => getConnection(p.id, 'pi_unknown')).toThrow(expect.objectContaining({ code: 'IDENTITY_NOT_FOUND' }));
    const other = await apiKeyPlatform('Resolver other');
    expect(() => getConnection(p.id, `pi_${other.id.slice(3)}`)).toThrow(expect.objectContaining({ code: 'IDENTITY_NOT_FOUND' }));
    const d = await db();

    // the seal binds an identity to its platform: the same row under another platform id does not verify
    const { identityIntegrity } = await import('../src/platforms/integrity.js');
    const row = d.get<any>('SELECT * FROM platform_identities WHERE platform_id = ?', p.id);
    expect(identityIntegrity(row)).toBe('ok');
    expect(identityIntegrity({ ...row, platform_id: other.id })).toBe('mismatch');
    // an identity row moved to another platform in the database (renamed, as names are unique per platform): refused
    const iid = `pi_${p.id.slice(3)}`;
    d.run("UPDATE platform_identities SET is_default = 0, platform_id = ?, name = 'Moved' WHERE id = ?", other.id, iid);
    try {
      expect(() => getConnection(other.id, iid)).toThrow(expect.objectContaining({ code: 'PLATFORM_CONFIG_UNVERIFIED' }));
      // and the platform without its default identity is refused, too
      expect(() => getConnection(p.id)).toThrow(expect.objectContaining({ code: 'PLATFORM_CONFIG_UNVERIFIED' }));
      expect((await s.api('GET', `/platforms/${p.id}`)).integrity).toBe('unsealed');
    } finally {
      d.run("UPDATE platform_identities SET is_default = 1, platform_id = ?, name = 'Default' WHERE id = ?", p.id, iid);
    }
    expect(getConnection(p.id).secrets).toEqual({ apiKey: 'resolver-key-1234' });
    // a changed MCP mode in the row breaks the identity's seal
    d.run(`UPDATE platform_identities SET mcp = '{"mode":"writes","writes":"confirm"}' WHERE id = ?`, iid);
    try {
      expect(() => getConnection(p.id)).toThrow(expect.objectContaining({ code: 'PLATFORM_CONFIG_UNVERIFIED' }));
      await expect(s.api('PUT', `/platforms/${p.id}/secrets`, { apiKey: 'x-new-1234' })).rejects.toMatchObject({ status: 409 });
    } finally {
      d.run(`UPDATE platform_identities SET mcp = '{"mode":"off"}' WHERE id = ?`, iid);
    }
    expect(getConnection(p.id).identity.integrity).toBe('ok');
    // credentials that cannot be read (garbage written in the database): shown as changed outside, refused, no error
    const good = d.get<{ secrets: string }>('SELECT secrets FROM platform_identities WHERE id = ?', iid)!.secrets;
    d.run("UPDATE platform_identities SET secrets = 'not-a-vault-blob' WHERE id = ?", iid);
    try {
      const shown = await s.api('GET', `/platforms/${p.id}`);
      expect(shown).toMatchObject({ integrity: 'mismatch', secretKeys: [] });
      await expect(s.api('POST', `/platforms/${p.id}/test`)).rejects.toMatchObject({ status: 409 });
    } finally {
      d.run('UPDATE platform_identities SET secrets = ? WHERE id = ?', good, iid);
    }
  });

  it('saving credentials and the MCP gateway writes the default identity, audited without values', async () => {
    const p = await apiKeyPlatform('Writes default', 'first-key-1234');
    await s.api('PUT', `/platforms/${p.id}/secrets`, { apiKey: 'second-key-5678' });
    const d = await db();
    expect(d.get<{ secrets: string | null }>('SELECT secrets FROM platforms WHERE id = ?', p.id)!.secrets).toBeNull();
    const { getConnection } = await import('../src/platforms/service.js');
    expect(getConnection(p.id).secrets).toEqual({ apiKey: 'second-key-5678' });
    const entry = (await s.api('GET', `/audit?entityType=platform&entityId=${p.id}`)).find((a: any) => a.action === 'platform.secrets_changed');
    expect(entry.details).toMatchObject({ set: ['apiKey'], identityId: `pi_${p.id.slice(3)}` });
    expect(JSON.stringify(entry)).not.toContain('second-key-5678');
    await s.api('PUT', `/platforms/${p.id}/mcp-gateway`, { enabled: true, writes: 'fourEyes', allowedPathPrefixes: ['/x'] });
    expect(JSON.parse(d.get<{ mcp: string }>('SELECT mcp FROM platform_identities WHERE platform_id = ?', p.id)!.mcp)).toEqual({
      mode: 'writes',
      writes: 'fourEyes',
    });
    expect(JSON.parse(d.get<{ config: string }>('SELECT config FROM platforms WHERE id = ?', p.id)!.config).mcpGateway).toEqual({
      allowedPathPrefixes: ['/x'],
    });
    expect((await s.api('GET', `/platforms/${p.id}`)).config.mcpGateway).toEqual({ enabled: true, writes: 'fourEyes', allowedPathPrefixes: ['/x'] });
    // other settings keep the stored config (the MCP mode is not written back to the platform)
    await s.api('PUT', `/platforms/${p.id}`, { name: 'Writes default (renamed)' });
    expect(JSON.parse(d.get<{ config: string }>('SELECT config FROM platforms WHERE id = ?', p.id)!.config).mcpGateway).toEqual({
      allowedPathPrefixes: ['/x'],
    });
    expect((await s.api('GET', `/platforms/${p.id}`)).integrity).toBe('ok');
    // deleting the platform removes its identities
    await s.api('DELETE', `/platforms/${p.id}`);
    expect(d.all('SELECT id FROM platform_identities WHERE platform_id = ?', p.id)).toEqual([]);
  });
});

describe('caches per identity', () => {
  it('keys tokens by platform and identity; the default identity shares its entry with plain platform objects', async () => {
    const { getConnection, getPlatform, getSecrets } = await import('../src/platforms/service.js');
    const { identityKey, invalidateIdentityCaches, invalidatePlatformCaches, platformRequest, tokenInfo } = await import('../src/platforms/http.js');
    const p = await oauthPlatform('Cache platform');
    const c = getConnection(p.id);
    expect(identityKey(c.platform)).toBe(`${p.id}:pi_${p.id.slice(3)}`);
    expect(identityKey(getPlatform(p.id))).toBe(identityKey(c.platform));
    const start = tokensIssued;
    await platformRequest(c.platform, c.secrets, { method: 'GET', url: '/x' });
    await platformRequest(getPlatform(p.id), getSecrets(p.id), { method: 'GET', url: '/x' });
    expect(tokensIssued).toBe(start + 1);
    // another identity of the same platform has its own token
    const second = { ...c.platform, identityId: 'pi_second' };
    expect(tokenInfo(second)).toBeNull();
    await platformRequest(second, c.secrets, { method: 'GET', url: '/x' });
    expect(tokensIssued).toBe(start + 2);
    expect(tokenInfo(second)).not.toBeNull();
    expect(tokenInfo(c.platform)).not.toBeNull();
    // changing one identity clears only its entries
    invalidateIdentityCaches(p.id, 'pi_second');
    expect(tokenInfo(second)).toBeNull();
    expect(tokenInfo(c.platform)).not.toBeNull();
    await platformRequest(c.platform, c.secrets, { method: 'GET', url: '/x' });
    expect(tokensIssued).toBe(start + 2);
    // new credentials of the default identity: a new login for it
    await s.api('PUT', `/platforms/${p.id}/secrets`, { clientSecret: 'client-secret-value-2' });
    expect(tokenInfo(c.platform)).toBeNull();
    // the platform's settings: every identity
    await platformRequest(second, c.secrets, { method: 'GET', url: '/x' });
    invalidatePlatformCaches(p.id);
    expect(tokenInfo(second)).toBeNull();
  });

  it('keeps database pools per identity and closes one identity or all of a platform', async () => {
    const { closePool, poolCount, poolFor } = await import('../src/dbms/pool.js');
    const opener = async () => {
      throw new Error('not opened in this test');
    };
    const before = poolCount();
    poolFor('pf_poolx:pi_a', '1', 1, opener);
    poolFor('pf_poolx:pi_b', '1', 1, opener);
    poolFor('pf_pooly:pi_c', '1', 1, opener);
    expect(poolCount()).toBe(before + 3);
    closePool('pf_poolx', 'pi_a');
    expect(poolCount()).toBe(before + 2);
    closePool('pf_poolx');
    expect(poolCount()).toBe(before + 1);
    closePool('pf_pooly');
    expect(poolCount()).toBe(before);
  });
});

describe('vault key rotation', () => {
  it('re-encrypts the identities’ credentials; seals and requests stay intact', async () => {
    const p = await apiKeyPlatform('Rotation', 'rotation-key-1234');
    const d = await db();
    const blob = () => d.get<{ secrets: string }>('SELECT secrets FROM platform_identities WHERE platform_id = ?', p.id)!.secrets;
    const before = blob();
    const r = await s.api('POST', '/vault/passphrase', { current: PASSPHRASE, next: 'a rotated passphrase 2026', rotateDataKey: true });
    expect(r.rotated).toBe(true);
    try {
      expect(blob()).not.toBe(before);
      expect((await s.api('GET', `/platforms/${p.id}`)).integrity).toBe('ok');
      lastAuth = undefined;
      expect((await s.api('POST', `/platforms/${p.id}/test`)).ok).toBe(true);
      expect(lastAuth).toBe('rotation-key-1234');
    } finally {
      await s.api('POST', '/vault/passphrase', { current: 'a rotated passphrase 2026', next: PASSPHRASE, rotateDataKey: false });
    }
  });
});

describe('API fields', () => {
  it('/api/v1 and the internal API show names and flags only, to whoever sees the platform', async () => {
    const p = await apiKeyPlatform('Api fields', 'api-fields-key-1234');
    await s.api('PUT', `/platforms/${p.id}/mcp-gateway`, { enabled: true });
    const token = (await s.api('POST', '/me/tokens', { name: 'identities', scope: 'read' })).token;
    const v1 = async (url: string, t = token) => {
      const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${t}` } });
      return { status: res.status, text: await res.text() };
    };
    const one = await v1(`/platforms/${p.id}`);
    expect(one.status).toBe(200);
    const body = JSON.parse(one.text);
    expect(body.identities).toEqual([
      {
        id: `pi_${p.id.slice(3)}`,
        name: 'Default',
        description: '',
        default: true,
        readOnly: false,
        privileged: false,
        mcp: { mode: 'read' },
        operationFilter: null,
        mayUse: true,
      },
    ]);
    const list = await v1('/platforms?limit=200');
    expect(JSON.parse(list.text).items.find((x: any) => x.id === p.id).identities).toHaveLength(1);
    for (const text of [one.text, list.text]) {
      expect(text).not.toContain('api-fields-key-1234');
      expect(text).not.toContain('secretKeys');
    }
    const internal = await s.api('GET', `/platforms/${p.id}`);
    expect(internal.identities[0]).toMatchObject({ default: true, secretKeys: ['apiKey'], ownSignIn: false, mayUse: true, integrity: 'ok' });
    expect(JSON.stringify(internal)).not.toContain('api-fields-key-1234');

    // a person without any right on the platform: hidden, identities included
    await s.api('PUT', `/platforms/${p.id}/access`, { acl: [{ subject: `user:${ADMIN.username}`, permissions: ['manage'] }] });
    const { temporaryPassword } = await s.api('POST', '/users', { username: 'idviewer', roles: ['viewer'] });
    const viewer = await s.as('idviewer', temporaryPassword);
    await viewer('POST', '/auth/password', { current: temporaryPassword, next: 'Viewer-password-1' });
    await expect(viewer('GET', `/platforms/${p.id}`)).rejects.toMatchObject({ status: 404 });
    expect(((await viewer('GET', '/platforms')) as any[]).some((x) => x.id === p.id)).toBe(false);
    const viewerToken = (await viewer('POST', '/me/tokens', { name: 'viewer', scope: 'read' })).token;
    expect((await v1(`/platforms/${p.id}`, viewerToken)).status).toBe(404);
    expect((await v1('/platforms?limit=200', viewerToken)).text).not.toContain(p.id.slice(3));
  });
});

describe('platforms.secrets stays inside the resolver', () => {
  /**
   * Only these files may read platforms.secrets (or select every column of platforms): the resolver and the seals, the
   * migration that copies it, and the generic table handling of key rotation and migration packages. Everything else
   * goes through getConnection() (or getSecrets(), the default identity).
   */
  const ALLOWED = new Set([
    'platforms/service.ts',
    'platforms/integrity.ts',
    'migrations/platforms.ts',
    'migration/export.ts',
    'migration/import.ts',
    'vault-rotation.ts',
  ]);
  const SRC = path.resolve(__dirname, '../src');
  const files = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));

  /** String and template literals that are SQL on the platforms table naming its secrets column, or selecting all columns. */
  function offending(source: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < source.length) {
      const q = source[i]!;
      if (q === '/' && source[i + 1] === '/') {
        i = source.indexOf('\n', i);
        if (i < 0) break;
        continue;
      }
      if (q === '/' && source[i + 1] === '*') {
        i = source.indexOf('*/', i + 2) + 2;
        if (i < 2) break;
        continue;
      }
      if (q !== "'" && q !== '"' && q !== '`') {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < source.length && source[j] !== q) j += source[j] === '\\' ? 2 : 1;
      const lit = source.slice(i + 1, j);
      i = j + 1;
      const words = lit.split(/[^A-Za-z0-9_.*]+/);
      const onPlatforms = words.some((w, k) => /^(from|update|into|join)$/i.test(w) && words[k + 1] === 'platforms');
      if (!onPlatforms) continue;
      if (words.includes('secrets') || words.includes('platforms.secrets') || /select\s+\*\s+from\s+platforms\b(?!_)/i.test(lit))
        out.push(lit.trim().slice(0, 120));
    }
    return out;
  }

  it('finds the readers it should find', () => {
    expect(offending("db().get('SELECT secrets FROM platforms WHERE id = ?', id)")).toHaveLength(1);
    expect(offending('db().all(`SELECT *\n FROM platforms`)')).toHaveLength(1);
    expect(offending("db().run('UPDATE platforms SET secrets = ? WHERE id = ?')")).toHaveLength(1);
    expect(offending("db().get('SELECT name, acl FROM platforms WHERE id = ?', id)")).toEqual([]);
    expect(offending("db().get('SELECT secrets FROM platform_identities WHERE id = ?', id)")).toEqual([]);
    expect(offending("app.put('/platforms/:id/secrets', handler)")).toEqual([]);
  });

  it('no other source file reads platforms.secrets', () => {
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      for (const lit of offending(fs.readFileSync(f, 'utf8'))) found.push(`${rel}: ${lit}`);
    }
    expect(found).toEqual([]);
  });

  /**
   * The call sites that still read the default identity's credentials with getSecrets() / platformFor() instead of
   * getConnection(): they move one module at a time in step 2 (ADR 0009). The list may only shrink.
   */
  it('lists the call sites not converted to getConnection() yet', () => {
    const callers = files(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
      .filter((rel) => rel !== 'platforms/service.ts' && /\bgetSecrets\(/.test(fs.readFileSync(path.join(SRC, rel), 'utf8')))
      .sort();
    expect(callers).toEqual([
      'ai/routes.ts',
      'backup/service.ts',
      'catalogue/lifecycle.ts',
      'compliance/evidence-pack.ts',
      'compliance/reconciliation.ts',
      'dbschema/service.ts',
      'engine/contract.ts',
      'engine/inspect.ts',
      'entra/register.ts',
      'kafka/service.ts',
      'mqtt/listener.ts',
      'platforms/connectors.ts',
      'platforms/policyContext.ts',
      'platforms/recordings.ts',
    ]);
  });
});
