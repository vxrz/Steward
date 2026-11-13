import { beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@sm/shared';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The Access tab's API (ADR 0033 part 7, #290): GET|PUT /api/access/:kind/:id/shares, PUT …/scope, POST …/preview –
 * one set of routes for every kind switched to shares. The kinds are wired in their own issues; these tests switch
 * the data contract kind with a share model of their own (and a site, for module access), as shares.test.ts does.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let mia: Client; // viewer – Manage on c1 by a share; confirms by hand
let ed: Client; // viewer – Edit on c1
let dana: Client; // designer – Manage on c2 by a share; may list users and teams
let sh: typeof import('../src/auth/shares.js');
let policy: typeof import('../src/auth/policy.js');

type P = 'view' | 'test' | 'edit' | 'manage';
const ALL: readonly P[] = ['view', 'test', 'edit', 'manage'];
const MODEL = { levels: { view: ['view'], edit: ['view', 'edit'], manage: ['view', 'edit', 'manage'] }, actions: { test: ['test'] } } as const;
// nobody but administrators by role: every other right comes from a share
const DEFAULTS: Record<Role, readonly P[]> = { admin: ALL, designer: [], operator: [], approver: [], auditor: ['view'], viewer: [], status: [], plant: [] };

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string; params?: Record<string, unknown> } }) => e.body?.code ?? 'error',
  );
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { body?: { code?: string; params?: Record<string, unknown> } }) => e.body ?? null,
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  sh = await import('../src/auth/shares.js');
  policy = await import('../src/auth/policy.js');
  const users = await import('../src/auth/users.js');
  const OWNERS: Record<string, string[]> = { c1: ['user:otto'], c2: [] };
  sh.registerShareKind({
    kind: 'contract',
    model: MODEL,
    name: (id) => (id.startsWith('c') ? `Invented contract ${id}` : undefined),
    link: (id) => `/data-contracts/${id}`,
    rights: (u, id) => policy.decide(u, { kind: 'contract', id, acl: [] }, ALL, DEFAULTS, 'view', { shares: MODEL }).permissions,
    implied: (id) => (OWNERS[id] ?? []).map((subject) => ({ subject, level: 'edit' as const, as: 'owner' as const })),
  });
  // a plant site: shares only to who uses the plant registry (ADR 0034 decision 15)
  sh.registerShareKind({
    kind: 'site',
    model: { levels: { view: ['view'], edit: ['view'], manage: ['view', 'manage'] } },
    name: (id) => (id === 'site1' ? 'Invented plant' : undefined),
    link: () => '/plant',
    rights: (u) => (u.roles.includes('admin') ? ['view', 'manage'] : []),
  });
  for (const [username, roles] of [
    ['mia', ['viewer']],
    ['ed', ['viewer']],
    ['vic', ['viewer']],
    ['pat', ['viewer']],
    ['otto', ['operator']],
    ['dana', ['designer']],
    ['aud', ['auditor']],
  ] as [string, Role[]][])
    users.createUser({ username, roles, password: PW, mustChangePassword: false });
  await s.api('POST', '/teams', { name: 'Payments', members: ['pat'] });
  mia = await s.as('mia', PW, { autoStepUp: false });
  ed = await s.as('ed', PW, { autoStepUp: false });
  // a fresh sign-in counts as a confirmation: Mia and Ed confirm by hand
  await mia('DELETE', '/auth/step-up');
  await ed('DELETE', '/auth/step-up');
  dana = await s.as('dana', PW);
  await s.api('PUT', '/access/contract/c1/shares', {
    shares: [
      { subject: 'user:mia', level: 'manage', actions: ['test'] },
      { subject: 'user:ed', level: 'edit' },
      { subject: 'team:payments', level: 'view' },
    ],
  });
  await s.api('PUT', '/access/contract/c2/shares', { shares: [{ subject: 'user:dana', level: 'manage' }] });
});

describe('reading the Access tab', () => {
  it('shows a Manage holder the scope, the shares, the implied owner share and what they hold', async () => {
    const v = await dana('GET', '/access/contract/c2/shares');
    expect(v).toMatchObject({
      kind: 'contract',
      id: 'c2',
      name: 'Invented contract c2',
      scope: 'instance',
      restricted: false,
      owningTeams: [],
      hidden: 0,
      implied: [],
      actions: ['test', 'relax'],
      canManage: true,
      canRestrict: false,
      held: { level: 'manage', actions: [] },
    });
    expect(v.shares.map((x: { subject: string; known: boolean }) => [x.subject, x.known])).toEqual([['user:dana', true]]);
    const admin = await s.api('GET', '/access/contract/c1/shares');
    expect(admin).toMatchObject({ held: 'all', canRestrict: true, implied: [{ subject: 'user:otto', level: 'edit', as: 'owner', outside: false }] });
  });

  it('gives others who see the item their own reasons only; hides the item from who may not see it', async () => {
    const v = await ed('GET', '/access/contract/c1/shares');
    expect(v).toMatchObject({ shares: null, hidden: 0, canManage: false });
    // an auditor reads the list (access reviews)
    expect((await (await s.as('aud', PW))('GET', '/access/contract/c1/shares')).shares).toHaveLength(3);
    // Vic has no share on c1: it answers like a missing item
    expect(await code((await s.as('vic', PW))('GET', '/access/contract/c1/shares'))).toBe('DATA_CONTRACT_NOT_FOUND');
    // a kind that is not switched to shares, a missing item
    expect(await code(s.api('GET', '/access/dashboard/x/shares'))).toBe('DASHBOARD_NOT_FOUND');
    expect(await code(s.api('GET', '/access/contract/zz/shares'))).toBe('DATA_CONTRACT_NOT_FOUND');
  });

  it('counts the subjects a reader may not see, without naming them', async () => {
    // Mia is a viewer: she may not list users and teams – she sees her own share only
    const v = await mia('GET', '/access/contract/c1/shares');
    expect(v.shares.map((x: { subject: string }) => x.subject)).toEqual(['user:mia']);
    expect(v.hidden).toBe(2);
    expect(JSON.stringify(v)).not.toContain('payments');
  });

  it('is for signed-in sessions only (API tokens: SESSION_REQUIRED)', async () => {
    const token = (await dana('POST', '/me/tokens', { name: 'dana read', scope: 'read' })).token as string;
    const res = await fetch(`${s.base}/api/access/contract/c2/shares`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SESSION_REQUIRED');
  });
});

describe('changing the shares', () => {
  it('keeps the shares a reader may not see when they save', async () => {
    // Mia sends only what she sees (her own share); Ed's and the team's stay as they are
    const v = await mia('PUT', '/access/contract/c1/shares', { shares: [{ subject: 'user:mia', level: 'manage', actions: ['test'] }] });
    expect(v.hidden).toBe(2);
    expect(sh.sharesOf('contract', 'c1').map((x) => x.subject)).toEqual(['team:payments', 'user:ed', 'user:mia']);
  });

  it('asks for the step-up when a share gives someone a right; narrowing does not ask', async () => {
    const narrower = { shares: [{ subject: 'user:dana', level: 'manage' }] };
    expect(
      await code(
        dana('PUT', '/access/contract/c2/shares', {
          shares: [
            { subject: 'user:dana', level: 'manage' },
            { subject: 'user:vic', level: 'view' },
          ],
        }),
      ),
    ).toBe('ok');
    // without a confirmation (Mia confirms by hand): a new share is refused until she confirms
    expect(
      await code(
        mia('PUT', '/access/contract/c1/shares', {
          shares: [
            { subject: 'user:mia', level: 'manage' },
            { subject: 'user:vic', level: 'view' },
          ],
        }),
      ),
    ).toBe('STEP_UP_REQUIRED');
    // dropping her own action right narrows: no step-up
    expect(await code(mia('PUT', '/access/contract/c1/shares', { shares: [{ subject: 'user:mia', level: 'manage' }] }))).toBe('ok');
    // Edit may not re-share; nobody shares more than they hold
    expect(await code(ed('PUT', '/access/contract/c1/shares', { shares: [] }))).toBe('FORBIDDEN');
    expect(await code(dana('PUT', '/access/contract/c2/shares', { shares: [{ subject: 'user:dana', level: 'manage', actions: ['test'] }] }))).toBe(
      'SHARE_EXCEEDS_OWN_RIGHTS',
    );
    expect(await code(dana('PUT', '/access/contract/c2/shares', narrower))).toBe('ok');
    const audit = (await s.api('GET', '/audit?action=access.share_added&entityId=c2&limit=10')) as { summary: string }[];
    expect(audit.some((e) => e.summary.includes('user:vic'))).toBe(true);
  });

  it('previews who gains and who loses what, nothing stored', async () => {
    const before = sh.sharesOf('contract', 'c1');
    const p = await s.api('POST', '/access/contract/c1/preview', {
      shares: [
        { subject: 'user:mia', level: 'view' },
        { subject: 'user:ed', level: 'manage' },
        { subject: 'user:vic', level: 'view', expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10) },
      ],
    });
    expect(p.gains).toEqual([
      { subject: 'user:ed', rights: ['manage'] },
      { subject: 'user:vic', rights: ['view'] },
    ]);
    expect(p.losses).toEqual([
      { subject: 'team:payments', rights: ['view'] },
      { subject: 'user:mia', rights: ['edit', 'manage'] },
    ]);
    expect((await s.api('POST', '/access/contract/c1/preview', { restricted: true })).losses).toEqual([{ subject: 'scope', rights: ['roleDefaults'] }]);
    expect(sh.sharesOf('contract', 'c1')).toEqual(before);
    // only who manages the item previews a change
    expect(await code(ed('POST', '/access/contract/c1/preview', { shares: [] }))).toBe('FORBIDDEN');
  });

  it('switches Restricted for administrators; switching it off asks for the step-up', async () => {
    expect(await code(dana('PUT', '/access/contract/c2/scope', { restricted: true }))).toBe('FORBIDDEN');
    const on = await s.api('PUT', '/access/contract/c2/scope', { restricted: true });
    expect(on).toMatchObject({ restricted: true, scope: 'restricted' });
    const admin = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    await admin('DELETE', '/auth/step-up');
    expect(await code(admin('PUT', '/access/contract/c2/scope', { restricted: false }))).toBe('STEP_UP_REQUIRED');
    expect((await s.api('PUT', '/access/contract/c2/scope', { restricted: false })).restricted).toBe(false);
    const audit = (await s.api('GET', '/audit?action=access.scope_changed&entityId=c2&limit=10')) as unknown[];
    expect(audit).toHaveLength(2);
  });

  it('shows an implied owner share from outside the owning teams as outside', async () => {
    const team = (await s.api('POST', '/teams', { name: 'Data', members: ['dana'] })) as { id: string };
    // (the test kind has no rows of its own: the owning teams are set directly)
    policy.setOwningTeams('contract', 'c1', [team.id]);
    const v = await s.api('GET', '/access/contract/c1/shares');
    expect(v).toMatchObject({ scope: 'teams', owningTeams: [{ name: 'Data' }], implied: [{ subject: 'user:otto', outside: true }] });
    policy.setOwningTeams('contract', 'c1', []);
  });
});

describe('module items (ADR 0034 decision 15)', () => {
  it('refuses a share to someone who does not use the module, with the hint', async () => {
    await s.api('PUT', '/settings/modules/plant/access', { mode: 'selected', grants: [{ subject: 'team:payments' }] });
    try {
      const refused = await failure(s.api('PUT', '/access/site/site1/shares', { shares: [{ subject: 'user:vic', level: 'view' }] }));
      expect(refused).toMatchObject({ code: 'SHARE_SUBJECT_UNSUITABLE', params: { subject: 'user:vic', context: 'module', module: 'plant' } });
      // the team on the module's list, and its member, may be given one
      expect(
        await code(
          s.api('PUT', '/access/site/site1/shares', {
            shares: [
              { subject: 'team:payments', level: 'view' },
              { subject: 'user:pat', level: 'view' },
            ],
          }),
        ),
      ).toBe('ok');
    } finally {
      await s.api('PUT', '/settings/modules/plant/access', { mode: 'everyone', grants: [] });
    }
  });
});
