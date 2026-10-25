import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, withRefusalReason, type Client, type TestServer } from './helpers.js';

/**
 * How claims become an account (#77), with the mock identity provider emitting configurable claims: the stable
 * identifier and its migration path, user name rules, names and profile fields with their sync rules, e-mail
 * confirmation, group overage, the linking policy, required claims, userinfo – and the test sign-in, which shows all
 * of it without signing in or changing an account.
 */
let s: TestServer;
let p = ''; // the demo provider ("Microsoft Entra ID (simulated)")
let mock: typeof import('../src/mock/mockOidc.js');
let dbm: typeof import('../src/db.js');

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  p = (await s.api('GET', '/sso/providers'))[0].id;
  // the identities made up here carry no role claim: everyone gets "viewer" (tests that need a mapping turn it on)
  const x = (await s.api('GET', '/sso/providers'))[0];
  const { id: _i, hasClientSecret: _h, createdAt: _c, updatedAt: _u, warnings: _w, ...input } = x;
  await s.api('PUT', `/sso/providers/${p}`, { ...input, requireMapping: false, defaultRoles: ['viewer'] });
  mock = await import('../src/mock/mockOidc.js');
  dbm = await import('../src/db.js');
});
afterAll(async () => {
  await s?.app.close();
});
afterEach(() => mock.resetMockIdentities());

const db = () => dbm.db();

/** The provider as an input body, with changes. */
async function provider(id = p): Promise<Record<string, any>> {
  const x = (await s.api('GET', '/sso/providers')).find((y: { id: string }) => y.id === id);
  const { id: _i, hasClientSecret: _h, createdAt: _c, updatedAt: _u, warnings: _w, ...input } = x;
  return input;
}
async function configure(patch: Record<string, unknown>, id = p): Promise<any> {
  return s.api('PUT', `/sso/providers/${id}`, { ...(await provider(id)), ...patch });
}

/** A sign-in through the mock: the client of the new session, or the error the callback reports. */
async function signIn(login: string, opts: { provider?: string; host?: string } = {}): Promise<{ client?: Client; error?: string }> {
  const start = await fetch(`${s.base}/api/auth/oidc/${opts.provider ?? p}/start`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location')!);
  if (!authorize.pathname.endsWith('/authorize')) return { error: decodeURIComponent(authorize.search) };
  authorize.pathname += '/approve';
  authorize.searchParams.set('login', login);
  const approve = await fetch(authorize, { redirect: 'manual' });
  const res = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual' });
  if (res.status !== 200) return { error: await withRefusalReason(s, res.headers.get('location') ?? String(res.status)) };
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const key = /localStorage\.setItem\("sm\.sessionKey","([^"]+)"\)/.exec(await res.text())![1]!;
  const client = (async (method: string, url: string, body?: unknown) => {
    const r = await fetch(s.base + '/api' + url, {
      method,
      headers: { 'x-sm-client': '1', cookie, 'x-sm-session': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${method} ${url} → ${r.status}: ${text}`), { status: r.status });
    return text ? JSON.parse(text) : null;
  }) as Client;
  return { client };
}
const meOf = async (c: Client) => (await c('GET', '/auth/me')).user;
const row = (username: string) =>
  db().get<{ id: string; external_id: string | null; external_sub: string | null; auth_source: string; profile: string | null }>(
    'SELECT id, external_id, external_sub, auth_source, profile FROM users WHERE username = ?',
    username,
  );
const lastAudit = async (action: string) => (await s.api('GET', `/audit?action=${action}&limit=1`))[0];

describe('defaults and existing providers', () => {
  it('reads a provider saved before these settings with today’s behaviour (linking by name) and keeps its seal', async () => {
    const created = await s.api('POST', '/sso/providers', { ...(await provider()), displayName: 'Legacy', clientSecret: 'demo-oidc-secret' });
    expect(created.linkExisting).toBe('bound'); // new providers
    // the configuration as an older version stored it (no #77 settings), sealed like it was
    const legacy = Object.fromEntries(
      Object.entries(JSON.parse(db().get<{ config: string }>('SELECT config FROM identity_providers WHERE id = ?', created.id)!.config)).filter(([k]) =>
        [
          'displayName',
          'type',
          'issuer',
          'clientId',
          'clientAuth',
          'scopes',
          'usernameClaim',
          'displayNameClaim',
          'emailClaim',
          'groupsClaim',
          'mappings',
          'defaultRoles',
          'autoProvision',
          'syncRoles',
          'requireMapping',
        ].includes(k),
      ),
    );
    const { configMac } = await import('../src/integrity.js');
    const { vault } = await import('../src/vault.js');
    const r = db().get<{ secret: string }>('SELECT secret FROM identity_providers WHERE id = ?', created.id)!;
    const secret = crypto
      .createHash('sha256')
      .update(JSON.stringify(vault().decrypt(r.secret)))
      .digest('hex');
    db().run(
      'UPDATE identity_providers SET config = ?, config_mac = ? WHERE id = ?',
      JSON.stringify(legacy),
      configMac('sso', created.id, { v: 1, config: legacy, enabled: true, secret }),
      created.id,
    );
    const read = (await s.api('GET', '/sso/providers')).find((x: { id: string }) => x.id === created.id);
    expect(read).toMatchObject({
      linkExisting: 'byName',
      stableIdClaims: ['sub'],
      usernameTransform: 'lowercase',
      firstNameClaim: 'given_name',
      lastNameClaim: 'family_name',
      groupValues: 'names',
      emailVerifiedByProvider: false,
      profileFields: [],
      sync: { displayName: 'always', firstName: 'always', lastName: 'always', email: 'always' },
    });
    expect(read.warnings).toContainEqual({ code: 'LINK_BY_NAME' });
    // still accepted (the seal covers the stored JSON) – a sign-in works
    const { client } = await signIn('b2e4', { provider: created.id });
    expect((await meOf(client!)).username).toBe('erik@contoso.example');
    // a request without the new settings keeps the stored ones
    const { linkExisting: _l, ...withoutPolicy } = await provider(created.id);
    const saved = await s.api('PUT', `/sso/providers/${created.id}`, withoutPolicy);
    expect(saved.linkExisting).toBe('byName');
    await s.api('DELETE', `/sso/providers/${created.id}`);
    db().run("DELETE FROM users WHERE username = 'erik@contoso.example'");
  });

  it('audits which claim settings changed', async () => {
    await configure({ usernameClaim: 'upn' });
    const entry = await lastAudit('sso.provider_updated');
    expect(entry.summary).toContain('changed: usernameClaim');
    expect(entry.details.before).toEqual({ usernameClaim: 'preferred_username' });
    await configure({ usernameClaim: 'preferred_username' });
  });

  it('validates the settings: bounded lists, unique profile fields, accepted values', async () => {
    const tooMany = await configure({ stableIdClaims: ['a', 'b', 'c', 'd'] }).catch((e) => e);
    expect(tooMany.message).toContain('400');
    const twice = await configure({
      profileFields: [
        { key: 'dept', label: 'Department', claim: 'department', sync: 'always' },
        { key: 'dept', label: 'Dept', claim: 'dep', sync: 'always' },
      ],
    }).catch((e) => e);
    expect(twice.message).toContain('SSO_PROFILE_FIELD_TWICE');
    const empty = await configure({ requiredClaims: [{ claim: 'hd', values: [] }] }).catch((e) => e);
    expect(empty.message).toContain('accepted value');
    // stripping domains needs the list of domains
    const noDomains = await configure({ usernameTransform: 'stripDomain', stripDomains: [] }).catch((e) => e);
    expect(noDomains.message).toContain('SSO_STRIP_DOMAINS_REQUIRED');
    const badDomain = await configure({ usernameTransform: 'stripDomain', stripDomains: ['not a domain'] }).catch((e) => e);
    expect(badDomain.message).toContain('400');
  });

  it('refuses a stable identifier many people share (tid, groups …) unless a subject claim is in it or it is confirmed', async () => {
    for (const claims of [['tid'], ['tid', 'groups'], ['hd'], ['iss', 'aud']]) {
      const e = await configure({ stableIdClaims: claims }).catch((x) => x);
      expect(e.message, claims.join('+')).toContain('SSO_STABLE_ID_NOT_UNIQUE');
      // a confirmation does not make shared claims unique
      const confirmed = await configure({ stableIdClaims: claims, stableIdConfirmedClaims: claims }).catch((x) => x);
      expect(confirmed.message, claims.join('+')).toContain('SSO_STABLE_ID_NOT_UNIQUE');
    }
    // a custom claim needs the administrator's confirmation (audited); a subject claim does not
    expect((await configure({ stableIdClaims: ['employeeId'] }).catch((x) => x)).message).toContain('SSO_STABLE_ID_NOT_UNIQUE');
    const custom = await configure({ stableIdClaims: ['tid', 'employeeId'], stableIdConfirmedClaims: ['employeeId', 'tid'] });
    expect(custom.stableIdClaims).toEqual(['tid', 'employeeId']);
    const entry = await lastAudit('sso.provider_updated');
    expect(entry.details.changed).toEqual(expect.arrayContaining(['stableIdClaims', 'stableIdConfirmedClaims']));
    expect(entry.details.stableIdConfirmedClaims).toEqual(['employeeId', 'tid']);
    // the confirmation is for those claims only: other claims need it again
    const other = await configure({ stableIdClaims: ['costCenter'] }).catch((x) => x);
    expect(other.message).toContain('SSO_STABLE_ID_NOT_UNIQUE');
    expect((await configure({ stableIdClaims: ['costCenter'], stableIdConfirmedClaims: ['costCenter'] })).stableIdClaims).toEqual(['costCenter']);
    // shared claims also nested or in other case – a confirmation does not help
    for (const claims of [['realm_access.roles'], ['TID'], ['extension.tid']]) {
      const e = await configure({ stableIdClaims: claims, stableIdConfirmedClaims: claims }).catch((x) => x);
      expect(e.message, claims[0]).toContain('SSO_STABLE_ID_NOT_UNIQUE');
    }
    expect((await configure({ stableIdClaims: ['tid', 'oid'], stableIdConfirmedClaims: [] })).stableIdClaims).toEqual(['tid', 'oid']);
    await configure({ stableIdClaims: ['sub'] });
  });
});

describe('the stable identifier', () => {
  it('re-links a link from before the setting (provider id + sub) at the next sign-in, audited', async () => {
    const first = await signIn('c3d5');
    const oskar = await meOf(first.client!);
    expect(row(oskar.username)!.external_id).toBe(`${p}#iss=${encodeURIComponent(`${s.base}/mock/oidc`)}#sub=c3d5`);
    // what an older version stored
    db().run('UPDATE users SET external_id = ?, external_sub = NULL WHERE id = ?', `${p}:c3d5`, oskar.id);
    const again = await signIn('c3d5');
    expect((await meOf(again.client!)).id).toBe(oskar.id);
    expect(row(oskar.username)!.external_id).toContain('#sub=c3d5');
    const entry = await lastAudit('user.sso_relinked');
    expect(entry.entityId).toBe(oskar.id);
    expect(entry.details).toMatchObject({ from: 'legacy' });
  });

  it('moves to other claims (tid + oid) through issuer + sub, and back', async () => {
    await configure({ stableIdClaims: ['tid', 'oid'] });
    const r = await signIn('c3d5');
    const oskar = await meOf(r.client!);
    expect(row(oskar.username)!.external_id).toContain(`#tid=${mock.DEMO_TENANT_ID}#oid=0c3d5000`);
    expect((await lastAudit('user.sso_relinked')).details).toMatchObject({ from: 'sub', stableIdClaims: ['tid', 'oid'] });
    const again = await signIn('c3d5');
    expect((await meOf(again.client!)).id).toBe(oskar.id);
    // back to sub: found by the recorded issuer + sub
    await configure({ stableIdClaims: ['sub'] });
    const back = await signIn('c3d5');
    expect((await meOf(back.client!)).id).toBe(oskar.id);
    expect(row(oskar.username)!.external_id).toMatch(/#sub=c3d5$/);
  });

  it('never re-links an account that the configured claims link to another identity', async () => {
    await configure({ stableIdClaims: ['oid'] });
    const max = await meOf((await signIn('a1f3')).client!);
    // Oskar's issuer + sub recorded on Max's account (stale): Max's link names the configured claim (oid) – not a candidate
    const oskarSub = row('oskar@contoso.example')!.external_sub!;
    const maxSub = row('max@contoso.example')!.external_sub!;
    db().run('UPDATE users SET external_sub = ? WHERE id = ?', oskarSub, max.id);
    db().run('UPDATE users SET external_id = ? WHERE username = ?', `${p}#iss=x#oid=gone`, 'oskar@contoso.example');
    db().run("UPDATE users SET external_sub = NULL WHERE username = 'oskar@contoso.example'");
    const r = await signIn('c3d5');
    // Oskar's own account has a link of the configured kind for another oid: refused, Max's account untouched
    expect(r.error).toContain('linked to another');
    expect(row('max@contoso.example')!.external_id).toContain('#oid=0a1f3000');
    db().run('UPDATE users SET external_id = NULL, external_sub = NULL, auth_source = ? WHERE username = ?', p, 'oskar@contoso.example');
    db().run('UPDATE users SET external_sub = ? WHERE id = ?', maxSub, max.id);
    await configure({ stableIdClaims: ['sub'] });
  });

  it('records issuer + sub only when an identity is linked: a shared identifier cannot move an account to the last signer', async () => {
    // an administrator confirmed a claim that turns out to be shared (Max and Nina both send employeeId E1)
    await configure({ stableIdClaims: ['employeeId'], stableIdConfirmedClaims: ['employeeId'] });
    mock.setMockIdentity('a1f3', { idToken: { employeeId: 'E1' } });
    mock.setMockIdentity('e5b7', { idToken: { employeeId: 'E1' } });
    const max = await meOf((await signIn('a1f3')).client!);
    const maxSub = row('max@contoso.example')!.external_sub;
    expect(maxSub).toMatch(/#sub=a1f3$/);
    // Nina gets Max's account (that is what the confirmed claim says) – but its recorded issuer + sub stays Max's
    expect((await meOf((await signIn('e5b7')).client!)).id).toBe(max.id);
    expect(row('max@contoso.example')!.external_sub).toBe(maxSub);
    // back to an identifier that names one person: Nina does not get Max's account, Max does
    await configure({ stableIdClaims: ['tid', 'oid'], stableIdConfirmedClaims: [] });
    const nina = await signIn('e5b7');
    expect(nina.client ? (await meOf(nina.client)).id : nina.error).not.toBe(max.id);
    expect((await meOf((await signIn('a1f3')).client!)).id).toBe(max.id);
    await configure({ stableIdClaims: ['sub'] });
    expect((await meOf((await signIn('a1f3')).client!)).id).toBe(max.id);
  });

  it('takes identifier values exactly as sent: no trimming, joining or cutting', async () => {
    await configure({ stableIdClaims: ['sub', 'employeeId'] });
    for (const bad of [['E1'], { id: 'E1' }, '', 'x'.repeat(257), true]) {
      mock.setMockIdentity('vic', { preferred_username: 'vic@contoso.example', idToken: { employeeId: bad } });
      expect((await signIn('vic')).error, JSON.stringify(bad)).toContain('usable values');
    }
    mock.setMockIdentity('vic', { preferred_username: 'vic@contoso.example', idToken: { employeeId: ' E1 ' } });
    await signIn('vic');
    expect(row('vic@contoso.example')!.external_id).toContain('#employeeId=%20E1%20');
    await configure({ stableIdClaims: ['sub'] });
  });

  it('refuses a sign-in without the claims that identify the person', async () => {
    await configure({ stableIdClaims: ['oid'] });
    mock.setMockIdentity('d4c6', { idToken: { oid: null } });
    const r = await signIn('d4c6');
    expect(r.error).toContain('did not send usable values for the claims that identify you (oid)');
    await configure({ stableIdClaims: ['sub'] });
  });

  it('ties links to the issuer: a new issuer is another namespace unless the administrator keeps the links', async () => {
    const issuer = `${s.base}/mock/oidc`;
    const other = issuer.replace('127.0.0.1', 'localhost'); // the mock names itself by the host it is called with
    const max = await meOf((await signIn('a1f3')).client!);
    // a link from before the setting: tied to the former issuer when the issuer changes
    db().run('UPDATE users SET external_id = ? WHERE id = ?', `${p}:a1f3`, max.id);
    await configure({ issuer: other });
    expect((await lastAudit('sso.provider_updated')).summary).toContain('1 link(s) kept to the former issuer');
    expect((await signIn('a1f3')).error).toContain('linked to another');
    // back, then moved deliberately: the same subjects at the new issuer keep their accounts
    await configure({ issuer });
    expect((await meOf((await signIn('a1f3')).client!)).id).toBe(max.id);
    await configure({ issuer: other, keepLinksOnIssuerChange: true });
    expect((await lastAudit('sso.provider_updated')).summary).toContain('moved to the new issuer');
    expect((await meOf((await signIn('a1f3')).client!)).id).toBe(max.id);
    await configure({ issuer, keepLinksOnIssuerChange: true });
  });

  it('keeps hashed (long) links when the issuer moves, re-linked through issuer + sub', async () => {
    const issuer = `${s.base}/mock/oidc`;
    const other = issuer.replace('127.0.0.1', 'localhost');
    await configure({ stableIdClaims: ['sub', 'badge'] });
    mock.setMockIdentity('hank', { preferred_username: 'hank@contoso.example', idToken: { badge: 'é'.repeat(250) } });
    const hank = await meOf((await signIn('hank')).client!);
    expect(row('hank@contoso.example')!.external_id).toMatch(/#h#sub%2Cbadge#[0-9a-f]{64}$/);
    await configure({ issuer: other, keepLinksOnIssuerChange: true });
    expect(row('hank@contoso.example')!.external_id).toContain('#moved=');
    expect((await meOf((await signIn('hank')).client!)).id).toBe(hank.id);
    expect((await lastAudit('user.sso_relinked')).entityId).toBe(hank.id);
    expect(row('hank@contoso.example')!.external_id).toMatch(/#h#sub%2Cbadge#/);
    await configure({ issuer, keepLinksOnIssuerChange: true, stableIdClaims: ['sub'] });
  });
});

describe('names, profile fields and sync rules', () => {
  it('fills first and last name, a display name template and nested profile claims; updates or keeps them by rule', async () => {
    await configure({
      displayNameTemplate: '{family_name}, {given_name}',
      profileFields: [
        { key: 'department', label: 'Department', claim: 'department', sync: 'always' },
        { key: 'city', label: 'City', claim: 'address.locality', sync: 'always' },
        { key: 'costCenter', label: 'Cost center', claim: 'extension.costCenter', sync: 'create' },
      ],
      sync: { displayName: 'always', firstName: 'always', lastName: 'create', email: 'always' },
    });
    const claims = {
      department: 'Service',
      address: { locality: 'Erlangen', country: 'DE' },
      extension: { costCenter: 'CC-1' },
      given_name: 'Pia',
      family_name: 'Probe',
    };
    mock.setMockIdentity('pia', { preferred_username: 'pia@contoso.example', idToken: claims });
    const first = await signIn('pia');
    if (!first.client) throw new Error(first.error);
    const c = first.client;
    const pia = await meOf(c);
    expect(pia).toMatchObject({ displayName: 'Probe, Pia', firstName: 'Pia', lastName: 'Probe' });
    expect(pia.profile).toEqual([
      { key: 'department', label: 'Department', value: 'Service' },
      { key: 'city', label: 'City', value: 'Erlangen' },
      { key: 'costCenter', label: 'Cost center', value: 'CC-1' },
    ]);
    expect(pia.managedFields).toEqual(['displayName', 'firstName', 'email']);
    // the provider changes: "always" follows, "create" stays; a field the provider no longer sends goes
    mock.setMockIdentity('pia', {
      preferred_username: 'pia@contoso.example',
      idToken: { ...claims, department: 'Field', address: null, extension: { costCenter: 'CC-2' }, given_name: 'Pina', family_name: 'Muster' },
    });
    const again = await meOf((await signIn('pia')).client!);
    expect(again).toMatchObject({ displayName: 'Muster, Pina', firstName: 'Pina', lastName: 'Probe' });
    expect(again.profile).toEqual([
      { key: 'department', label: 'Department', value: 'Field' },
      { key: 'costCenter', label: 'Cost center', value: 'CC-1' },
    ]);
    // fields the provider keeps up to date are not editable; "create" fields are
    const refused = await c('PATCH', '/me', { firstName: 'Other' }).catch((e) => e);
    expect(refused.message).toContain('SSO_MANAGED_PROFILE');
    expect((await c('PATCH', '/me', { lastName: 'Selbst' })).lastName).toBe('Selbst');
    const byAdmin = await s.api('PUT', `/users/${pia.id}`, { displayName: 'Changed' }).catch((e) => e);
    expect(byAdmin.message).toContain('SSO_MANAGED_PROFILE');
    // in the public API (reports, dashboards)
    const tok = (await s.api('POST', '/me/tokens', { name: 'claims', scope: 'read' })).token;
    const viaApi = await (await fetch(`${s.base}/api/v1/users/${pia.id}`, { headers: { authorization: `Bearer ${tok}` } })).json();
    expect(viaApi).toMatchObject({ firstName: 'Pina', lastName: 'Selbst', profile: [{ key: 'department', value: 'Field' }, { key: 'costCenter' }] });
    await configure({ displayNameTemplate: '', profileFields: [], sync: { displayName: 'always', firstName: 'always', lastName: 'always', email: 'always' } });
  });

  it('bounds claim values: length, control characters, lists', async () => {
    await configure({ profileFields: [{ key: 'notes', label: 'Notes', claim: 'notes', sync: 'always' }] });
    mock.setMockIdentity('long', { preferred_username: 'long@contoso.example', idToken: { notes: ['a\u0000b', 'x'.repeat(600)], name: 'L'.repeat(300) } });
    const u = await meOf((await signIn('long')).client!);
    expect(u.displayName).toHaveLength(100);
    expect(u.profile[0].value.startsWith('a b, xxx')).toBe(true);
    expect(u.profile[0].value).toHaveLength(500);
    await configure({ profileFields: [] });
  });

  it('local accounts edit first and last name themselves', async () => {
    const { user } = await s.api('POST', '/users', { username: 'local-names', roles: ['viewer'], firstName: 'Lo', lastName: 'Cal' });
    expect(user).toMatchObject({ firstName: 'Lo', lastName: 'Cal', managedFields: [], profile: [] });
    const updated = await s.api('PUT', `/users/${user.id}`, { firstName: 'Lou' });
    expect(updated.firstName).toBe('Lou');
  });
});

describe('user name rules', () => {
  it('strips the domain or keeps the case, and reports collisions', async () => {
    await configure({ usernameTransform: 'stripDomain', stripDomains: ['contoso.example'] });
    mock.setMockIdentity('ulla', { preferred_username: 'Ulla@Contoso.example' });
    expect((await meOf((await signIn('ulla')).client!)).username).toBe('ulla');
    // a domain that is not listed: refused, whatever the name
    mock.setMockIdentity('ulla2', { preferred_username: 'ulla@fabrikam.example' });
    expect((await signIn('ulla2')).error).toContain('not of a domain this provider strips');
    // a listed domain with the same name: the account belongs to the first identity
    await configure({ stripDomains: ['contoso.example', 'fabrikam.example'] });
    expect((await signIn('ulla2')).error).toContain('linked to another');
    await configure({ usernameTransform: 'none' });
    mock.setMockIdentity('Ken', { preferred_username: 'Ken.Keep@Contoso.example' });
    expect((await meOf((await signIn('Ken')).client!)).username).toBe('Ken.Keep@Contoso.example');
    // two accounts of this provider that would get the same name: reported with the provider
    mock.setMockIdentity('ken2', { preferred_username: 'ken.keep@fabrikam.example' });
    await configure({ usernameTransform: 'lowercase' });
    await signIn('ken2');
    const saved = await configure({ usernameTransform: 'stripDomain' });
    expect(saved.warnings).toContainEqual(expect.objectContaining({ code: 'USERNAME_COLLISIONS' }));
    expect(JSON.stringify(saved.warnings)).toContain('ken.keep ←');
    expect(saved.warnings).toContainEqual({ code: 'STRIP_DOMAIN' });
    await configure({ usernameTransform: 'lowercase' });
  });

  it('never lets a foreign domain claim an account when stripping domains (not even a bound administrator)', async () => {
    await configure({ usernameTransform: 'stripDomain', stripDomains: ['contoso.example'] });
    const { user } = await s.api('POST', '/users', { username: 'boss', roles: ['admin'], provider: p });
    mock.setMockIdentity('evil1', { preferred_username: 'boss@evil.example' });
    expect((await signIn('evil1')).error).toContain('not of a domain this provider strips');
    // a listed domain after another one: what is left still has a domain – refused
    mock.setMockIdentity('evil2', { preferred_username: 'boss@evil.example@contoso.example' });
    expect((await signIn('evil2')).error).toContain('not of a domain this provider strips');
    expect(row('boss')).toMatchObject({ id: user.id, external_id: null });
    mock.setMockIdentity('boss1', { preferred_username: 'boss@contoso.example', idToken: { roles: ['SM.Admins'] } });
    expect((await meOf((await signIn('boss1')).client!)).id).toBe(user.id);
    await configure({ usernameTransform: 'lowercase' });
  });

  it('normalises user names (NFKC) and refuses characters local user names cannot have', async () => {
    mock.setMockIdentity('fw', { preferred_username: 'ｆｕｌｌ＠contoso.example' });
    expect((await meOf((await signIn('fw')).client!)).username).toBe('full@contoso.example');
    mock.setMockIdentity('kelvin', { preferred_username: '\u212Aelvin@contoso.example' });
    expect((await meOf((await signIn('kelvin')).client!)).username).toBe('kelvin@contoso.example');
    for (const name of ['max\u202E@contoso.example', 'a b@contoso.example', 'x', 'é@contoso.example', 'a'.repeat(129)]) {
      mock.setMockIdentity('odd', { preferred_username: name });
      expect((await signIn('odd')).error, name).toContain('is not usable');
    }
  });

  it('keeps signing in linked identities whose name is not usable for new accounts (names from older versions)', async () => {
    const issuer = `${s.base}/mock/oidc`;
    const enc = encodeURIComponent;
    const ts = new Date().toISOString();
    // accounts an older version created with names it accepted: one linked by the current link, one by a legacy link
    for (const [id, name, link] of [
      ['usr_juergen', 'jürgen@contoso.example', `${p}#iss=${enc(issuer)}#sub=jue`],
      ['usr_jose', 'josé@contoso.example', `${p}:jos`],
    ]) {
      db().run(
        `INSERT INTO users (id, username, display_name, password_hash, roles, active, must_change_password, created_at, updated_at, auth_source, external_id)
         VALUES (?, ?, ?, '!sso', '["viewer"]', 1, 0, ?, ?, ?, ?)`,
        id,
        name,
        name,
        ts,
        ts,
        p,
        link,
      );
    }
    mock.setMockIdentity('jue', { preferred_username: 'jürgen@contoso.example' });
    expect((await meOf((await signIn('jue')).client!)).id).toBe('usr_juergen');
    mock.setMockIdentity('jos', { preferred_username: 'josé@contoso.example' });
    expect((await meOf((await signIn('jos')).client!)).id).toBe('usr_jose'); // re-linked
    // a new identity with such a name gets no account (and no existing one by name)
    mock.setMockIdentity('jue2', { preferred_username: 'jürgen2@contoso.example' });
    expect((await signIn('jue2')).error).toContain('is not usable');
    mock.setMockIdentity('jue3', { preferred_username: 'jürgen@contoso.example' });
    expect((await signIn('jue3')).error).toContain('is not usable');
  });
});

describe('e-mail confirmation', () => {
  it('needs email_verified whenever the e-mail claim names the account – unless the provider verifies addresses', async () => {
    await configure({ usernameClaim: 'email' });
    mock.setMockIdentity('eva', { preferred_username: 'eva@contoso.example' });
    expect((await signIn('eva')).error).toContain('email_verified');
    mock.setMockIdentity('eva', { preferred_username: 'eva@contoso.example', idToken: { email_verified: false } });
    expect((await signIn('eva')).error).toContain('email_verified');
    mock.setMockIdentity('eva', { preferred_username: 'eva@contoso.example', idToken: { email_verified: true } });
    expect((await meOf((await signIn('eva')).client!)).username).toBe('eva@contoso.example');
    mock.setMockIdentity('ewa', { preferred_username: 'ewa@contoso.example' });
    const trusted = await configure({ emailVerifiedByProvider: true });
    expect(trusted.warnings).toContainEqual({ code: 'EMAIL_TRUSTED' });
    expect((await meOf((await signIn('ewa')).client!)).username).toBe('ewa@contoso.example');
    // also when the e-mail claim is (part of) the stable identifier
    await configure({ usernameClaim: 'preferred_username', emailVerifiedByProvider: false, stableIdClaims: ['email'], stableIdConfirmedClaims: ['email'] });
    mock.setMockIdentity('eli', { preferred_username: 'eli@contoso.example' });
    expect((await signIn('eli')).error).toContain('email_verified');
    expect((await provider()).stableIdClaims).toEqual(['email']);
    expect((await s.api('GET', '/sso/providers'))[0].warnings).toContainEqual({ code: 'MUTABLE_STABLE_ID', params: { claims: ['email'] } });
    await configure({ stableIdClaims: ['sub'], stableIdConfirmedClaims: [] });
  });

  it('takes email_verified from where the e-mail address came from (ID token or userinfo)', async () => {
    await configure({ usernameClaim: 'email', useUserinfo: true });
    // the ID token confirms nothing it does not carry: the address only comes from userinfo, which does not confirm it
    mock.setMockIdentity('mix', {
      preferred_username: 'mix@contoso.example',
      idToken: { email: null, email_verified: true },
      userinfo: { email: 'mix@contoso.example', email_verified: false },
    });
    expect((await signIn('mix')).error).toContain('email_verified');
    mock.setMockIdentity('mix', {
      preferred_username: 'mix@contoso.example',
      idToken: { email: null },
      userinfo: { email: 'mix@contoso.example', email_verified: true },
    });
    expect((await meOf((await signIn('mix')).client!)).username).toBe('mix@contoso.example');
    await configure({ usernameClaim: 'preferred_username', useUserinfo: false });
  });

  it('names providers from before whose sign-ins need email_verified now (editor, startup log)', async () => {
    const created = await s.api('POST', '/sso/providers', { ...(await provider()), displayName: 'Old e-mail', usernameClaim: 'email', clientSecret: 'x' });
    const { configMac } = await import('../src/integrity.js');
    const { vault } = await import('../src/vault.js');
    /** Stores the provider as a version before #77 did (without the e-mail settings), sealed. */
    const makeLegacy = () => {
      const stored = JSON.parse(db().get<{ config: string }>('SELECT config FROM identity_providers WHERE id = ?', created.id)!.config);
      delete stored.emailVerifiedByProvider;
      delete stored.emailVerificationNotice;
      const r = db().get<{ secret: string }>('SELECT secret FROM identity_providers WHERE id = ?', created.id)!;
      const secret = crypto
        .createHash('sha256')
        .update(JSON.stringify(vault().decrypt(r.secret)))
        .digest('hex');
      db().run(
        'UPDATE identity_providers SET config = ?, config_mac = ? WHERE id = ?',
        JSON.stringify(stored),
        configMac('sso', created.id, { v: 1, config: stored, enabled: true, secret }),
        created.id,
      );
    };
    makeLegacy();
    const listed = (await s.api('GET', '/sso/providers')).find((x: { id: string }) => x.id === created.id);
    expect(listed.warnings).toContainEqual({ code: 'EMAIL_VERIFIED_NOW_REQUIRED', params: { claim: 'email' } });
    const { logger } = await import('../src/log.js');
    const warned: string[] = [];
    const original = logger.warn.bind(logger);
    (logger as { warn: unknown }).warn = (o: { name?: string }, msg: string) => warned.push(`${o.name}: ${msg}`);
    try {
      (await import('../src/auth/sso.js')).warnEmailVerifiedProviders();
    } finally {
      (logger as { warn: unknown }).warn = original;
    }
    expect(warned.some((w) => w.startsWith('Old e-mail:') && w.includes('email_verified'))).toBe(true);
    const notice = async () =>
      (await s.api('GET', '/sso/providers'))
        .find((x: { id: string }) => x.id === created.id)
        .warnings.some((w: { code: string }) => w.code === 'EMAIL_VERIFIED_NOW_REQUIRED');
    // a save without a decision keeps the notice
    await configure({ displayName: 'Old e-mail (renamed)' }, created.id);
    expect(await notice()).toBe(true);
    // decided: keep requiring email_verified
    await configure({ emailVerificationNotice: false }, created.id);
    expect(await notice()).toBe(false);
    // decided: the provider verifies every address
    makeLegacy();
    expect(await notice()).toBe(true);
    await configure({ emailVerifiedByProvider: true }, created.id);
    expect(await notice()).toBe(false);
    // the e-mail claim no longer names accounts
    makeLegacy();
    await configure({ usernameClaim: 'preferred_username' }, created.id);
    expect(await notice()).toBe(false);
    await s.api('DELETE', `/sso/providers/${created.id}`);
  });
});

describe('cost of the provider and user lists', () => {
  it('the sign-in page reads no accounts; the user list reads each provider’s sync rules once', async () => {
    const d = db();
    const all = d.all.bind(d);
    const get = d.get.bind(d);
    const seen: string[] = [];
    (d as { all: unknown }).all = (sql: string, ...a: unknown[]) => (seen.push(sql), all(sql, ...(a as [])));
    (d as { get: unknown }).get = (sql: string, ...a: unknown[]) => (seen.push(sql), get(sql, ...(a as [])));
    try {
      const sso = await import('../src/auth/sso.js');
      sso.publicProviders();
      expect(seen.filter((q) => /FROM users/.test(q))).toEqual([]);
      seen.length = 0;
      const { listUsers } = await import('../src/auth/users.js');
      const users = listUsers();
      const providerReads = seen.filter((q) => /FROM identity_providers/.test(q)).length;
      expect(users.length).toBeGreaterThan(5);
      expect(providerReads).toBeLessThanOrEqual(new Set(users.map((u) => u.authSource).filter((x) => x !== 'local')).size);
    } finally {
      (d as { all: unknown }).all = all;
      (d as { get: unknown }).get = get;
    }
  });
});

describe('groups and roles', () => {
  it('flags group overage (Entra ID _claim_names / hasgroups): audited, no roles from the missing groups', async () => {
    await configure({
      groupsClaim: 'groups',
      groupValues: 'ids',
      requireMapping: true,
      defaultRoles: [],
      mappings: [{ claimValue: 'Grp-A1', roles: ['operator'], teams: [] }],
    });
    mock.setMockIdentity('gina', {
      preferred_username: 'gina@contoso.example',
      idToken: {
        roles: null,
        _claim_names: { groups: 'src1' },
        _claim_sources: { src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/x/getMemberObjects' } },
      },
    });
    const r = await signIn('gina');
    expect(r.error).toContain('left the groups out');
    const entry = await lastAudit('sso.groups_overage');
    expect(entry.summary).toContain('gina@contoso.example');
    mock.setMockIdentity('gina', { preferred_username: 'gina@contoso.example', idToken: { hasgroups: true } });
    expect((await signIn('gina')).error).toContain('left the groups out');
    // ids are matched exactly, names ignoring case
    mock.setMockIdentity('gina', { preferred_username: 'gina@contoso.example', idToken: { groups: ['grp-a1'] } });
    expect((await signIn('gina')).error).toContain('no role assigned');
    await configure({ groupValues: 'names' });
    expect((await meOf((await signIn('gina')).client!)).roles).toEqual(['operator']);
    await configure({ groupsClaim: 'roles', groupValues: 'names', mappings: DEMO_MAPPINGS, requireMapping: false, defaultRoles: ['viewer'] });
  });
});

const DEMO_MAPPINGS = [
  { claimValue: 'SM.Admins', roles: ['admin'], teams: [] },
  { claimValue: 'SM.Designers', roles: ['designer'], teams: [] },
  { claimValue: 'SM.Operators', roles: ['operator'], teams: ['Service Desk'] },
  { claimValue: 'SM.Approvers', roles: ['approver'], teams: ['Service Desk'] },
];

describe('linking existing accounts at the first sign-in', () => {
  it('by name, only bound accounts, or never', async () => {
    const local = (name: string) => s.api('POST', '/users', { username: name, roles: ['viewer'], password: 'Local-pw-12345678' });
    const asIdentity = (sub: string, name: string) => mock.setMockIdentity(sub, { preferred_username: name, idToken: { roles: ['SM.Operators'] } });
    // bound (the default for new providers): a local account with the name is refused …
    await local('lia@contoso.example');
    asIdentity('lia', 'lia@contoso.example');
    expect((await signIn('lia')).error).toContain('has to bind it to');
    // … until an administrator binds it
    const lia = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'lia@contoso.example');
    await s.api('PUT', `/users/${lia.id}`, { provider: p });
    expect((await meOf((await signIn('lia')).client!)).id).toBe(lia.id);
    // by name: linked, audited with the policy
    await configure({ linkExisting: 'byName' });
    const { user: leo } = await local('leo@contoso.example');
    asIdentity('leo', 'leo@contoso.example');
    expect((await meOf((await signIn('leo')).client!)).id).toBe(leo.id);
    expect((await lastAudit('user.linked_sso')).details).toMatchObject({ linkExisting: 'byName', bound: false });
    // never: not even a bound account; a new name still gets a new account
    await configure({ linkExisting: 'never' });
    const { user: bound } = await s.api('POST', '/users', { username: 'lux@contoso.example', roles: ['viewer'], provider: p });
    asIdentity('lux', 'lux@contoso.example');
    expect((await signIn('lux')).error).toContain('does not link existing accounts');
    expect(row('lux@contoso.example')!.external_id).toBeNull();
    asIdentity('lena', 'lena@contoso.example');
    expect((await meOf((await signIn('lena')).client!)).username).toBe('lena@contoso.example');
    // already linked identities keep signing in
    expect((await meOf((await signIn('leo')).client!)).id).toBe(leo.id);
    await configure({ linkExisting: 'bound' });
    expect((await meOf((await signIn('lux')).client!)).id).toBe(bound.id);
  });

  it('only lets identities with the required claim values in (e.g. tid, hd)', async () => {
    const saved = await configure({ requiredClaims: [{ claim: 'tid', values: [mock.DEMO_TENANT_ID.toUpperCase()] }] });
    expect(saved.requiredClaims).toHaveLength(1);
    expect((await meOf((await signIn('b2e4')).client!)).username).toBe('erik@contoso.example');
    mock.setMockIdentity('b2e4', { idToken: { tid: '00000000-0000-4000-8000-000000000000' } });
    expect((await signIn('b2e4')).error).toContain('does not belong to the organisation');
    await configure({ requiredClaims: [] });
  });

  it('reads claims from the userinfo endpoint when set to', async () => {
    await configure({ useUserinfo: true, profileFields: [{ key: 'jobTitle', label: 'Job title', claim: 'jobTitle', sync: 'always' }] });
    mock.setMockIdentity('uwe', { preferred_username: 'uwe@contoso.example', userinfo: { jobTitle: 'Technician' } });
    expect((await meOf((await signIn('uwe')).client!)).profile).toEqual([{ key: 'jobTitle', label: 'Job title', value: 'Technician' }]);
    await configure({ useUserinfo: false, profileFields: [] });
  });
});

describe('test sign-in', () => {
  /** Starts a test sign-in as the given client and signs in at the mock as `login`; returns the callback response. */
  async function testSignIn(client: Client, login: string, id = p) {
    const start = await client('POST', `/sso/providers/${id}/test-sign-in`, {});
    const authorize = new URL(start.authorizationUrl);
    expect(authorize.searchParams.get('prompt')).toBe('select_account');
    authorize.pathname += '/approve';
    authorize.searchParams.set('login', login);
    const approve = await fetch(authorize, { redirect: 'manual' });
    const res = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual' });
    return { start, res, body: await res.text() };
  }

  it('shows the claims and the resulting account without signing in or changing anything', async () => {
    const users = () => db().get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
    const sessions = () => db().get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n;
    const before = { users: users(), sessions: sessions() };
    await configure({ profileFields: [{ key: 'city', label: 'City', claim: 'address.locality', sync: 'always' }] });
    mock.setMockIdentity('tess', {
      preferred_username: 'Tess@Contoso.example',
      idToken: { address: { locality: 'Nürnberg' }, given_name: 'Tess', family_name: 'Ter', roles: ['SM.Operators'], _claim_names: { groups: 'src1' } },
      userinfo: { only_in_userinfo: 'x' },
    });
    const admin = (await s.as('admin', 'Admin-password-1')) as Client;
    const pending = await admin('POST', `/sso/test-sign-ins/${(await admin('POST', `/sso/providers/${p}/test-sign-in`, {})).testId}`, {});
    expect(pending.status).toBe('pending');
    const { start, res, body } = await testSignIn(admin, 'tess');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(body).toContain('Test sign-in finished');
    expect(body).not.toContain('sm.sessionKey');
    const result = await admin('POST', `/sso/test-sign-ins/${start.testId}`, {});
    expect(result.status).toBe('done');
    const claim = (list: { name: string; value: string }[], name: string) => list.find((c) => c.name === name)?.value;
    expect(claim(result.idToken, 'address')).toBe('{"locality":"Nürnberg"}');
    expect(claim(result.idToken, 'sub')).toBe('"tess"');
    expect(claim(result.userinfo, 'only_in_userinfo')).toBe('"x"');
    expect(result.preview).toMatchObject({
      outcome: 'create',
      username: 'tess@contoso.example',
      usernameFrom: { claim: 'preferred_username', value: 'Tess@Contoso.example' },
      firstName: 'Tess',
      lastName: 'Ter',
      profile: [{ key: 'city', value: 'Nürnberg' }],
      // the groups were left out, but the configured claim is roles (app roles): no overage
      groups: { claim: 'roles', matched: ['SM.Operators'], overage: false },
      roles: ['viewer', 'operator'],
      teams: ['Service Desk'],
    });
    expect(result.preview.notes.map((n: { code: string }) => n.code)).not.toContain('GROUPS_OVERAGE');
    expect(result.preview.notes).toContainEqual({ code: 'USERNAME_TRANSFORMED', params: { from: 'Tess@Contoso.example', to: 'tess@contoso.example' } });
    // never a token or the client secret
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/eyJ[\w-]+\.[\w-]+\./);
    expect(text).not.toContain('access_token');
    expect(text).not.toContain('demo-oidc-secret');
    // nothing changed (the admin's own new session from s.as aside)
    expect(users()).toBe(before.users);
    expect(sessions()).toBe(before.sessions + 1);
    expect(row('tess@contoso.example')).toBeUndefined();
    expect((await lastAudit('sso.test_sign_in')).summary).toContain('no account or session was changed');

    // the editor's unsaved settings: the preview follows (e.g. a policy that refuses)
    const draft = {
      ...(await provider()),
      usernameTransform: 'stripDomain',
      autoProvision: false,
      groupsClaim: 'groups',
      requireMapping: true,
      defaultRoles: [],
    };
    const refused = await admin('POST', `/sso/test-sign-ins/${start.testId}`, { config: draft });
    expect(refused.preview).toMatchObject({ outcome: 'refuse', username: 'tess', refusal: { code: 'SSO_NO_ROLE_MAPPING', params: { context: 'overage' } } });
    expect(refused.preview.notes).toContainEqual({ code: 'GROUPS_OVERAGE', params: { claim: 'groups' } });
    const linking = await admin('POST', `/sso/test-sign-ins/${start.testId}`, { config: { ...draft, requireMapping: false, usernameTransform: 'lowercase' } });
    expect(linking.preview.refusal.code).toBe('SSO_NO_ACCOUNT');
    // an existing account: which one it would link to, or why not
    const { user } = await s.api('POST', '/users', { username: 'tess@contoso.example', roles: ['viewer'] });
    const local = await admin('POST', `/sso/test-sign-ins/${start.testId}`, {});
    expect(local.preview).toMatchObject({ outcome: 'refuse', account: { id: user.id }, refusal: { code: 'SSO_LINK_BOUND_ONLY' } });
    const byName = await admin('POST', `/sso/test-sign-ins/${start.testId}`, { config: { ...(await provider()), linkExisting: 'byName' } });
    expect(byName.preview).toMatchObject({ outcome: 'link', account: { id: user.id } });
    expect(row('tess@contoso.example')!.external_id).toBeNull(); // still not linked
    await configure({ profileFields: [] });
  });

  it('belongs to the administrator who started it; other roles cannot start one', async () => {
    const admin = (await s.as('admin', 'Admin-password-1')) as Client;
    const { start } = await testSignIn(admin, 'e5b7');
    // another administrator (the demo's Max, signed in with single sign-on) cannot read it
    const max = (await signIn('a1f3')).client!;
    const other = await max('POST', `/sso/test-sign-ins/${start.testId}`, {}).catch((e) => e);
    expect(other.status).toBe(404);
    const olivia = (await s.as('olivia', 'Demo-password-1')) as Client;
    const denied = await olivia('POST', `/sso/providers/${p}/test-sign-in`, {}).catch((e) => e);
    expect(String(denied.message)).toContain('403');
    // a disabled provider can be tested (before it is turned on)
    await configure({ enabled: false, requireMapping: true });
    const r = await testSignIn(admin, 'e5b7');
    expect(r.body).toContain('Test sign-in finished');
    const result = await admin('POST', `/sso/test-sign-ins/${r.start.testId}`, {});
    expect(result.preview.refusal.code).toBe('SSO_NO_ROLE_MAPPING'); // Nina has no role
    await configure({ enabled: true, requireMapping: false });
  });

  it('records a failure at the identity provider', async () => {
    const admin = (await s.as('admin', 'Admin-password-1')) as Client;
    const start = await admin('POST', `/sso/providers/${p}/test-sign-in`, {});
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const res = await fetch(`${s.base}/api/auth/oidc/callback?state=${state}&error=access_denied&error_description=${encodeURIComponent('<b>no</b>')}`, {
      redirect: 'manual',
    });
    const body = await res.text();
    expect(body).toContain('test sign-in failed');
    expect(body).not.toContain('<b>no</b>');
    const result = await admin('POST', `/sso/test-sign-ins/${start.testId}`, {});
    expect(result).toMatchObject({ status: 'failed', error: 'Identity provider: <b>no</b>' });
  });
});
