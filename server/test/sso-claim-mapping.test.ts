import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

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
  if (res.status !== 200) return { error: decodeURIComponent(res.headers.get('location') ?? String(res.status)) };
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

  it('refuses a sign-in without the claims that identify the person', async () => {
    await configure({ stableIdClaims: ['oid'] });
    mock.setMockIdentity('d4c6', { idToken: { oid: null } });
    const r = await signIn('d4c6');
    expect(r.error).toContain('did not send the claims that identify you (oid)');
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
    await configure({ usernameTransform: 'stripDomain' });
    mock.setMockIdentity('ulla', { preferred_username: 'Ulla@Contoso.example' });
    expect((await meOf((await signIn('ulla')).client!)).username).toBe('ulla');
    // the same name at another domain: the account belongs to the first identity
    mock.setMockIdentity('ulla2', { preferred_username: 'ulla@fabrikam.example' });
    expect((await signIn('ulla2')).error).toContain('linked to another');
    await configure({ usernameTransform: 'none' });
    mock.setMockIdentity('Ken', { preferred_username: 'Ken.Keep@Contoso.example' });
    expect((await meOf((await signIn('Ken')).client!)).username).toBe('Ken.Keep@Contoso.example');
    // two accounts of this provider that would get the same name: reported with the provider
    await configure({ usernameTransform: 'stripDomain' });
    mock.setMockIdentity('ken2', { preferred_username: 'ken.keep@fabrikam.example' });
    await configure({ usernameTransform: 'lowercase' });
    await signIn('ken2');
    const saved = await configure({ usernameTransform: 'stripDomain' });
    expect(saved.warnings).toContainEqual(expect.objectContaining({ code: 'USERNAME_COLLISIONS' }));
    expect(JSON.stringify(saved.warnings)).toContain('ken.keep ←');
    expect(saved.warnings).toContainEqual({ code: 'STRIP_DOMAIN' });
    await configure({ usernameTransform: 'lowercase' });
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
    await configure({ usernameClaim: 'preferred_username', emailVerifiedByProvider: false, stableIdClaims: ['email'] });
    mock.setMockIdentity('eli', { preferred_username: 'eli@contoso.example' });
    expect((await signIn('eli')).error).toContain('email_verified');
    expect((await provider()).stableIdClaims).toEqual(['email']);
    expect((await s.api('GET', '/sso/providers'))[0].warnings).toContainEqual({ code: 'MUTABLE_STABLE_ID', params: { claims: ['email'] } });
    await configure({ stableIdClaims: ['sub'] });
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
      groups: { claim: 'roles', matched: ['SM.Operators'], overage: true },
      roles: ['viewer', 'operator'],
      teams: ['Service Desk'],
    });
    expect(result.preview.notes).toContainEqual({ code: 'GROUPS_OVERAGE', params: { claim: 'roles' } });
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
