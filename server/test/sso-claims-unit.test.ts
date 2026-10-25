import { describe, expect, it } from 'vitest';
import { isSharedClaim, ssoConfigWarnings, stableIdProblem, SSO_PRESET_INFO, SSO_PRESETS } from '@sm/shared';
import {
  claimAt,
  claimList,
  claimText,
  groupOverage,
  identityKeys,
  keyClaimNames,
  keyIssuer,
  renderTemplate,
  shownClaims,
  transformUsername,
  withDefaults,
  withIssuer,
} from '../src/auth/sso-claims.js';

/** The pure parts of the claim mapping (#77): claim paths, values, user name rules, links. */
describe('claims', () => {
  it('reads nested claims, prefers a literal name and never walks into the prototype', () => {
    const c = { address: { locality: 'Erlangen' }, 'https://example.com/roles': ['a'], 'a.b': 1, a: { b: 2 } };
    expect(claimAt(c, 'address.locality')).toBe('Erlangen');
    expect(claimAt(c, 'https://example.com/roles')).toEqual(['a']);
    expect(claimAt(c, 'a.b')).toBe(1);
    expect(claimAt(c, '__proto__')).toBeUndefined();
    expect(claimAt(c, 'address.constructor')).toBeUndefined();
    expect(claimAt(c, 'address.toString')).toBeUndefined();
    expect(claimAt(c, 'a.b.c.d.e.f')).toBeUndefined();
    expect(claimAt(c, 'address..locality')).toBeUndefined();
  });

  it('turns values into bounded text', () => {
    expect(claimText(' x\u0007y  ', 10)).toBe('x y');
    expect(claimText(['a', 1, true, { no: 1 }], 50)).toBe('a, 1, true');
    expect(claimText({ a: 1 }, 50)).toBeUndefined();
    expect(claimText('', 50)).toBeUndefined();
    expect(claimText('abcdef', 3)).toBe('abc');
    // bidi controls would reorder text in the audit log and the UI
    expect(claimText('ab\u202ecd\u2066e\u200f', 50)).toBe('ab cd e');
    expect(claimList('a b,c')).toEqual(['a', 'b', 'c']);
    expect(claimList(['x', 2, { y: 1 }])).toEqual(['x', '2']);
  });

  it('applies the user name rule', () => {
    expect(transformUsername(' Max@Contoso.com ', 'lowercase')).toBe('max@contoso.com');
    expect(transformUsername('Max@Contoso.com', 'stripDomain', ['contoso.com'])).toBe('max');
    // only listed domains: any other is refused (null), so boss@evil.example never becomes "boss"
    expect(transformUsername('boss@evil.example', 'stripDomain', ['contoso.com'])).toBeNull();
    expect(transformUsername('Max@Contoso.com', 'stripDomain')).toBeNull();
    expect(transformUsername('@contoso.com', 'stripDomain', ['contoso.com'])).toBeNull();
    // a name that still has a domain after stripping one (boss@evil.example@contoso.example) is refused
    expect(transformUsername('a@b@c.com', 'stripDomain', ['c.com'])).toBeNull();
    expect(transformUsername('boss@evil.example@contoso.example', 'stripDomain', ['contoso.example'])).toBeNull();
    expect(transformUsername('max', 'stripDomain', ['c.com'])).toBe('max');
    // NFKC first: look-alikes become the letters they stand for
    expect(transformUsername('\u212Aate', 'lowercase')).toBe('kate');
    expect(transformUsername('ｂｏｂ', 'none')).toBe('bob');
    expect(transformUsername('Max@Contoso.com', 'none')).toBe('Max@Contoso.com');
  });

  it('renders display name templates', () => {
    expect(renderTemplate('{given_name} {family_name}', { given_name: 'Max', family_name: 'Admin' })).toBe('Max Admin');
    expect(renderTemplate('{family_name}, {given_name} ({address.locality})', { given_name: 'Max', address: { locality: 'Köln' } })).toBe(', Max (Köln)');
    expect(renderTemplate('{missing}', {})).toBe('');
    expect(renderTemplate('{n}', { n: 'x'.repeat(300) })).toHaveLength(100);
  });

  it('recognises group overage indicators', () => {
    expect(groupOverage({ _claim_names: { groups: 'src1' }, _claim_sources: {} }, 'groups')).toBe(true);
    // only the configured claim counts: left-out groups say nothing about app roles
    expect(groupOverage({ _claim_names: { groups: 'src1' }, _claim_sources: {} }, 'roles')).toBe(false);
    expect(groupOverage({ hasgroups: true }, 'roles')).toBe(false);
    expect(groupOverage({ _claim_names: { wids: 'src1' } }, 'wids')).toBe(true);
    expect(groupOverage({ hasgroups: true }, 'groups')).toBe(true);
    expect(groupOverage({ hasgroups: 'true' }, 'groups')).toBe(true);
    expect(groupOverage({ groups: ['a'] }, 'groups')).toBe(false);
  });

  it('builds links that cannot be confused with each other', () => {
    const k = identityKeys('idp_1', { iss: 'https://idp.example/', sub: 'a#b=c', tid: 't', oid: 'o' }, ['tid', 'oid']);
    expect(k.key).toBe('idp_1#iss=https%3A%2F%2Fidp.example#tid=t#oid=o');
    expect(k.subKey).toBe('idp_1#iss=https%3A%2F%2Fidp.example#sub=a%23b%3Dc');
    expect(k.legacyKey).toBe('idp_1:a#b=c');
    expect(keyClaimNames(k.key!, 'idp_1')).toEqual(['tid', 'oid']);
    expect(keyClaimNames(k.legacyKey, 'idp_1')).toBe('legacy');
    expect(keyClaimNames(k.key!, 'idp_2')).toBeNull();
    expect(keyIssuer(k.key!, 'idp_1')).toBe('https://idp.example');
    expect(withIssuer(k.key!, 'idp_1', 'https://new.example/')).toBe('idp_1#iss=https%3A%2F%2Fnew.example#tid=t#oid=o');
    expect(identityKeys('idp_1', { iss: 'x', sub: 's' }, ['oid']).key).toBeUndefined();
    // a (non-standard) numeric sub gives the same link as the stable id ['sub'] and the recorded issuer + sub
    const numericSub = identityKeys('idp_1', { iss: 'x', sub: 123 }, ['sub']);
    expect(numericSub.subKey).toBe(numericSub.key);
    expect(numericSub.subKey).not.toBe(identityKeys('idp_1', { iss: 'x', sub: '123' }, ['sub']).subKey);
    // values exactly as sent: what claimText would trim, join or cut never makes two values the same
    const keyOf = (oid: unknown) => identityKeys('idp_1', { iss: 'x', sub: 's', oid }, ['oid']).key;
    expect(keyOf(' v ')).not.toBe(keyOf('v'));
    for (const bad of [['v'], ['a', 'b'], { v: 1 }, '', true, null, 'x'.repeat(257), Number.NaN]) expect(keyOf(bad)).toBeUndefined();
    // a number never gives the link of the same digits as a string
    expect(keyOf(42)).toBe('idp_1#iss=x#oid==42');
    expect(keyOf('42')).toBe('idp_1#iss=x#oid=42');
    expect(keyClaimNames(keyOf(42)!, 'idp_1')).toEqual(['oid']);
    expect(keyOf('x'.repeat(256))).toBeDefined();
    expect(keyClaimNames('idp_1#moved=abc', 'idp_1')).toBe('moved');
    expect(keyClaimNames('idp_1#retired=abc', 'idp_1')).toBeNull();
    // long values: hashed, the claim names stay readable
    const long = identityKeys('idp_1', { iss: 'x', sub: 's', a: 'é'.repeat(250), b: 'é'.repeat(250) }, ['a', 'b']);
    expect(long.key).toMatch(/^idp_1#h#a%2Cb#[0-9a-f]{64}$/);
    expect(keyClaimNames(long.key!, 'idp_1')).toEqual(['a', 'b']);
  });

  it('shows claims bounded, as JSON text', () => {
    const shown = shownClaims({ a: 'x', b: { c: 1 }, big: 'y'.repeat(5000) });
    expect(shown[0]).toEqual({ name: 'a', value: '"x"' });
    expect(shown[1]).toEqual({ name: 'b', value: '{"c":1}' });
    expect(shown[2]!.truncated).toBe(true);
    expect(shown[2]!.value).toHaveLength(2000);
  });

  it('keeps today’s behaviour for settings a provider was saved without', () => {
    const c = withDefaults({ type: 'entra' } as never);
    expect(c).toMatchObject({ preset: 'entra', linkExisting: 'byName', stableIdClaims: ['sub'], usernameTransform: 'lowercase', groupValues: 'names' });
  });
});

describe('stable identifier claims', () => {
  it('must name one person', () => {
    expect(stableIdProblem(['sub'], [])).toBeNull();
    expect(stableIdProblem(['tid', 'oid'], [])).toBeNull();
    expect(stableIdProblem(['tid'], [])).toBe('NOT_UNIQUE');
    expect(stableIdProblem(['tid'], ['tid'])).toBe('NOT_UNIQUE');
    expect(stableIdProblem(['groups', 'roles', 'hd'], ['groups', 'roles', 'hd'])).toBe('NOT_UNIQUE');
    expect(stableIdProblem(['employeeId'], [])).toBe('NOT_UNIQUE');
    expect(stableIdProblem(['employeeId'], ['employeeId'])).toBeNull();
    expect(stableIdProblem([], ['x'])).toBe('NONE');
  });

  it('holds a confirmation only for exactly the claims it was given for', () => {
    expect(stableIdProblem(['costCenter'], ['employeeId'])).toBe('NOT_UNIQUE');
    expect(stableIdProblem(['employeeId', 'costCenter'], ['employeeId'])).toBe('NOT_UNIQUE');
    expect(stableIdProblem(['costCenter', 'employeeId'], ['employeeId', 'costCenter'])).toBeNull();
  });

  it('knows shared claims also nested and in other case', () => {
    for (const c of ['TID', 'Groups', 'realm_access.roles', 'resource_access.app.roles', 'extension.tid', 'Address.Country']) {
      expect(isSharedClaim(c), c).toBe(true);
      expect(stableIdProblem([c], [c]), c).toBe('NOT_UNIQUE');
    }
    expect(isSharedClaim('extension.employeeId')).toBe(false);
  });
});

describe('presets and configuration warnings', () => {
  it('pre-fill every setting with a docs section', () => {
    for (const id of SSO_PRESETS) {
      const p = SSO_PRESET_INFO[id];
      expect(p.docsAnchor).toMatch(/^[a-z-]+$/);
      expect(p.defaults.linkExisting).toBe('bound');
      expect(p.defaults.scopes).toContain('openid');
    }
    expect(SSO_PRESET_INFO.entra.defaults.stableIdClaims).toEqual(['tid', 'oid']);
    expect(SSO_PRESET_INFO.google.defaults.requiredClaims).toEqual([{ claim: 'hd', values: [] }]);
  });

  it('warn about claims others can influence', () => {
    const base = { ...SSO_PRESET_INFO.entra.defaults, type: 'entra' as const, issuer: 'https://login.microsoftonline.com/organizations/v2.0' } as never;
    const codes = (x: object) => ssoConfigWarnings({ ...(base as object), ...x } as never).map((w) => w.code);
    expect(codes({})).toEqual(expect.arrayContaining(['MULTI_TENANT_ISSUER', 'TENANT_INFLUENCED_CLAIM']));
    expect(codes({ requiredClaims: [{ claim: 'tid', values: ['t'] }] })).not.toContain('MULTI_TENANT_ISSUER');
    expect(codes({ issuer: 'https://login.microsoftonline.com/t/v2.0' })).toEqual([]);
    expect(codes({ issuer: 'https://idp', usernameClaim: 'name' })).toContain('USER_INFLUENCED_CLAIM');
    expect(codes({ issuer: 'https://idp', stableIdClaims: ['upn'] })).toContain('MUTABLE_STABLE_ID');
    expect(codes({ issuer: 'https://accounts.google.com', preset: 'google', requiredClaims: [] })).toContain('NO_DOMAIN_RESTRICTION');
    expect(codes({ issuer: 'https://idp', linkExisting: 'byName', usernameTransform: 'stripDomain' })).toEqual(['LINK_BY_NAME', 'STRIP_DOMAIN']);
  });
});
