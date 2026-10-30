import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Credentials register (#125): "used by" links to applications and external pages, and the roles and permissions a
 * credential holds – changes of the roles write their own history event and audit entry, without a rotation; the
 * overview searches and filters by role; applications list their credentials; the public API carries both.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, vera: Client;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, vera] = await Promise.all(['dana', 'vera'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

const ENTRY = {
  name: 'IH technical user modev',
  type: 'technicalUser',
  platformText: 'Insights Hub',
  environment: 'modev',
  owners: [],
};

describe('credential roles and links', () => {
  let app: any;
  let cred: any;
  it('links an application and external pages; the application lists the credential with what is due', async () => {
    app = await dana('POST', '/applications', { name: 'Insights Hub (roles test)', owners: [] });
    cred = await dana('POST', '/credentials', {
      ...ENTRY,
      expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      usedBy: {
        text: '',
        links: [{ kind: 'application', id: app.id }],
        urls: [{ label: 'Swagger', url: 'https://gateway.eu1.mindsphere.io/api/swagger' }],
      },
      roles: [{ role: 'mdsp:core:TenantAdmin', scope: 'tenant modev', grantedAt: '2026-01-15', note: 'for onboarding' }],
    });
    expect(cred.usedBy.links).toEqual([{ kind: 'application', id: app.id, label: 'Insights Hub (roles test)' }]);
    expect(cred.usedBy.urls).toEqual([{ label: 'Swagger', url: 'https://gateway.eu1.mindsphere.io/api/swagger' }]);
    expect(cred.roles).toEqual([{ role: 'mdsp:core:TenantAdmin', scope: 'tenant modev', grantedAt: '2026-01-15T00:00:00.000Z', note: 'for onboarding' }]);
    // only entries the reader may see: a viewer sees none, the designer sees it
    expect((await vera('GET', `/applications/${app.id}`)).credentials).toEqual([]);
    const a = await dana('GET', `/applications/${app.id}`);
    expect(a.credentials).toEqual([
      {
        id: cred.id,
        name: 'IH technical user modev',
        type: 'technicalUser',
        status: 'dueSoon',
        nextDueAt: expect.any(String),
        roles: ['mdsp:core:TenantAdmin'],
        // linked as "used by" (#125), not belonging to the application or one of its components (#143)
        relation: 'usedBy',
        componentName: null,
      },
    ]);
    // the creation's roles are in the history as well
    const h = await dana('GET', `/credentials/${cred.id}/history`);
    expect(h.map((e: any) => e.kind)).toEqual(['rolesChanged', 'created']);
  });

  it('refuses links other than http(s) and roles without a name', async () => {
    const bad = (over: Record<string, unknown>) => status(dana('POST', '/credentials', { ...ENTRY, name: `x ${Math.random()}`, ...over }));
    expect(await bad({ usedBy: { urls: [{ label: 'x', url: 'javascript:alert(1)' }] } })).toBe(400);
    expect(await bad({ usedBy: { urls: [{ label: 'x', url: 'keepass://db.kdbx' }] } })).toBe(400);
    expect(await bad({ roles: [{ role: ' ' }] })).toBe(400);
    expect(await bad({ roles: Array.from({ length: 51 }, (_, i) => ({ role: `r${i}` })) })).toBe(400);
  });

  it('writes a history event and an audit entry of its own when roles change – nothing else changes', async () => {
    const before = await dana('GET', `/credentials/${cred.id}`);
    const next = await dana('PUT', `/credentials/${cred.id}`, {
      ...ENTRY,
      expiresAt: before.expiresAt,
      usedBy: before.usedBy,
      version: before.version,
      roles: [
        { role: 'mdsp:core:TenantAdmin', scope: 'tenant modev', grantedAt: '2026-01-15', note: 'for onboarding, until go-live' },
        { role: 'mdsp:core:im.iam.admin', scope: 'tenant modev' },
      ],
      rolesComment: 'CHG0012345',
    });
    expect(next.roles.map((r: any) => r.role)).toEqual(['mdsp:core:TenantAdmin', 'mdsp:core:im.iam.admin']);
    expect(next.lastRotatedAt).toBe(before.lastRotatedAt);
    const h = await dana('GET', `/credentials/${cred.id}/history`);
    expect(h[0]).toMatchObject({ kind: 'rolesChanged', actor: 'dana', comment: 'CHG0012345' });
    expect(h[0].details.added).toEqual([{ role: 'mdsp:core:im.iam.admin', scope: 'tenant modev', grantedAt: null, note: '' }]);
    expect(h[0].details.changed[0].to.note).toBe('for onboarding, until go-live');
    // only roles changed: no "changed" event besides
    expect(h[1].kind).toBe('rolesChanged');
    const audit = await s.api('GET', `/audit?entityType=credential&entityId=${cred.id}&limit=10`);
    expect(audit[0]).toMatchObject({ action: 'credential.roles_changed' });
    expect(audit[0].summary).toContain('+mdsp:core:im.iam.admin (tenant modev)');
    expect(audit.some((e: any) => e.action === 'credential.updated')).toBe(false);

    // saved without roles: they stay; removing one is recorded
    const again = await dana('GET', `/credentials/${cred.id}`);
    const kept = await dana('PUT', `/credentials/${cred.id}`, {
      ...ENTRY,
      expiresAt: again.expiresAt,
      usedBy: again.usedBy,
      notes: 'x',
      version: again.version,
    });
    expect(kept.roles).toHaveLength(2);
    const removed = await dana('PUT', `/credentials/${cred.id}`, {
      ...ENTRY,
      expiresAt: kept.expiresAt,
      usedBy: kept.usedBy,
      notes: 'x',
      version: kept.version,
      roles: [kept.roles[1]],
    });
    expect(removed.roles.map((r: any) => r.role)).toEqual(['mdsp:core:im.iam.admin']);
    expect((await dana('GET', `/credentials/${cred.id}/history`))[0].details.removed[0].role).toBe('mdsp:core:TenantAdmin');
  });

  it('searches and filters by role; the public API carries roles and links', async () => {
    const other = await dana('POST', '/credentials', { ...ENTRY, name: 'Other client', roles: [{ role: 'mdsp:core:StandardUser' }] });
    const ids = (r: any) => r.items.map((c: any) => c.id);
    expect(ids(await dana('GET', '/credentials?role=MDSP:CORE:IM.IAM.ADMIN'))).toEqual([cred.id]);
    expect(ids(await dana('GET', '/credentials?q=standarduser'))).toEqual([other.id]);
    const token = (await dana('POST', '/me/tokens', { name: 'roles', scope: 'read' })).token;
    const res = await fetch(`${s.base}/api/v1/credentials?role=mdsp:core:im.iam.admin`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json();
    expect(body.items.map((c: any) => c.id)).toEqual([cred.id]);
    expect(body.items[0].roles[0]).toMatchObject({ role: 'mdsp:core:im.iam.admin', scope: 'tenant modev' });
    expect(body.items[0].usedBy.urls[0].label).toBe('Swagger');
  });
});
