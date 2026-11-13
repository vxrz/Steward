import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { AccessReason, Role } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Shares and the Restricted scope (ADR 0033, #289) – the core every kind builds on: the policy per level and subject,
 * the widening check (step-up, API tokens refused, narrowing never asks), the audit family, end dates (ended shares
 * stop at once, the job removes them, Manage holders are reminded 7 days before), bulk reads, and the subject
 * references of team renames and deletions. No kind is switched to shares yet: the tests use the data contract kind
 * with a share model of their own, through two routes only these tests register.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
const DAY = 86_400_000;
let s: TestServer;
let mia: Client; // viewer – given Manage on c1; confirms by hand
let ed: Client; // viewer – given Edit on c1
let sh: typeof import('../src/auth/shares.js');
let policy: typeof import('../src/auth/policy.js');
let ctx: typeof import('../src/auth/context.js');
let users: typeof import('../src/auth/users.js');

type P = 'view' | 'test' | 'edit' | 'manage';
const ALL: readonly P[] = ['view', 'test', 'edit', 'manage'];
const MODEL = { levels: { view: ['view'], edit: ['view', 'edit'], manage: ['view', 'edit', 'manage'] }, actions: { test: ['test'] } } as const;
const DEFAULTS: Record<Role, readonly P[]> = {
  admin: ALL,
  designer: ['view', 'test', 'edit'],
  operator: ['view', 'test'],
  approver: ['view'],
  auditor: ['view'],
  viewer: ['view'],
  status: [],
  plant: [],
};

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code ?? 'error',
  );
const db = async () => (await import('../src/db.js')).db();
const userOf = (name: string) => users.toAuthUser(users.findUserByName(name)!);
/** The rights of `name` on a contract id, decided with the test model (in a job-like context: indexes per call). */
const decideFor = (name: string, id: string) =>
  ctx.runAs(null, () => policy.decide(userOf(name), { kind: 'contract', id, acl: [] }, ALL, DEFAULTS, 'view', { shares: MODEL }));
const rights = (name: string, id: string) => decideFor(name, id).permissions;
const entries = async (action: string, id: string) =>
  (await s.api('GET', `/audit?action=${action}&entityId=${id}&limit=50`)) as {
    action: string;
    actor: string;
    summary: string;
    details?: Record<string, unknown>;
  }[];
/** Stores a share directly (end dates in the past, state for the decision tests). */
async function store(id: string, subject: string, level: string, opts: { actions?: string[]; expiresAt?: string | null } = {}) {
  (await db()).run(
    'INSERT INTO resource_shares (kind, resource_id, subject, level, actions, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'contract',
    id,
    subject,
    level,
    JSON.stringify(opts.actions ?? []),
    opts.expiresAt ?? null,
    'admin',
    new Date().toISOString(),
  );
}
const restrict = async (id: string) =>
  (await db()).run(
    'INSERT INTO resource_restrictions (kind, resource_id, created_by, created_at) VALUES (?, ?, ?, ?)',
    'contract',
    id,
    'admin',
    new Date().toISOString(),
  );

beforeAll(async () => {
  s = await startTestServer({
    // the routes #290 brings for real, reduced to the core: replace a contract's shares, switch its scope
    routes: (app) => {
      const id = (req: FastifyRequest) => (req.params as { id: string }).id;
      const body = (req: FastifyRequest) => (req.body ?? {}) as { shares?: never[]; restricted?: boolean };
      const held = (rid: string) => {
        const u = ctx.currentUser()!;
        return policy.heldShare(u, MODEL, policy.decide(u, { kind: 'contract', id: rid, acl: [] }, ALL, DEFAULTS, 'view', { shares: MODEL }).permissions);
      };
      app.put(
        '/api/test/shares/:id',
        {
          config: {
            stepUp: {
              action: 'grantAccess',
              when: (req: FastifyRequest) => {
                try {
                  return sh.sharesWiden('contract', id(req), body(req).shares ?? []);
                } catch {
                  return false;
                }
              },
            },
          },
        },
        async (req) => ({ shares: sh.setShares({ kind: 'contract', id: id(req), held: held(id(req)), shares: body(req).shares ?? [] }) }),
      );
      app.put(
        '/api/test/scope/:id',
        {
          config: { stepUp: { action: 'grantAccess', when: (req: FastifyRequest) => body(req).restricted === false && sh.isRestricted('contract', id(req)) } },
        },
        async (req) => ({ changed: sh.setRestricted({ kind: 'contract', id: id(req), restricted: !!body(req).restricted, held: held(id(req)) }) }),
      );
    },
  });
  await setup(s);
  sh = await import('../src/auth/shares.js');
  policy = await import('../src/auth/policy.js');
  ctx = await import('../src/auth/context.js');
  users = await import('../src/auth/users.js');
  for (const [username, roles] of [
    ['mia', ['viewer']],
    ['ed', ['viewer']],
    ['vic', ['viewer']],
    ['pat', ['viewer']],
    ['otto', ['operator']],
    ['dana', ['designer']],
    ['stat', ['status']],
    ['flora', ['plant']],
    ['aud', ['auditor']],
  ] as [string, Role[]][])
    users.createUser({ username, roles, password: PW, mustChangePassword: false });
  await s.api('POST', '/teams', { name: 'Payments', members: ['pat'] });
  await s.api('POST', '/teams', { name: 'Orders', members: ['dana'] });
  mia = await s.as('mia', PW, { autoStepUp: false });
  ed = await s.as('ed', PW, { autoStepUp: false });
  // c1: Mia manages it, Ed edits it (administrators may share anything)
  await s.api('PUT', '/test/shares/c1', {
    shares: [
      { subject: 'user:mia', level: 'manage' },
      { subject: 'user:ed', level: 'edit' },
    ],
  });
});

describe('the policy', () => {
  it('gives each level its rights and adds the action rights beside it', async () => {
    await store('lv', 'user:vic', 'view');
    await store('lv', 'user:pat', 'edit', { actions: ['test'] });
    await store('lv', 'user:otto', 'manage');
    await restrict('lv');
    expect(rights('vic', 'lv')).toEqual(['view']);
    expect(rights('pat', 'lv')).toEqual(['view', 'test', 'edit']);
    expect(rights('otto', 'lv')).toEqual(['view', 'edit', 'manage']);
    const reason = decideFor('pat', 'lv').reasons.find((r) => r.source === 'share') as AccessReason;
    expect(reason).toMatchObject({ source: 'share', subject: 'user:pat', level: 'edit', actions: ['test'] });
  });

  it('matches user, team and role subjects', async () => {
    await store('sb', 'team:payments', 'edit');
    await store('sb', 'role:operator', 'view', { actions: ['test'] });
    await restrict('sb');
    expect(rights('pat', 'sb')).toEqual(['view', 'edit']); // a member of Payments
    expect(rights('otto', 'sb')).toEqual(['view', 'test']); // the instance role operator
    expect(rights('vic', 'sb')).toEqual([]); // neither
    expect(decideFor('pat', 'sb').reasons).toEqual([{ source: 'share', subject: 'team:payments', level: 'edit', permissions: ['view', 'edit'] }]);
  });

  it('Restricted keeps instance roles out; without it they keep their defaults and shares add', async () => {
    await store('open', 'user:vic', 'edit');
    expect(rights('dana', 'open')).toEqual(['view', 'test', 'edit']); // designer by role
    expect(rights('vic', 'open')).toEqual(['view', 'edit']); // viewer + Edit share
    await restrict('open');
    expect(rights('dana', 'open')).toEqual([]);
    expect(rights('vic', 'open')).toEqual(['view', 'edit']);
    // auditors still view, administrators have everything
    expect(rights('aud', 'open')).toEqual(['view']);
    expect(rights('admin', 'open')).toEqual(ALL);
  });

  it('on an owned resource a share adds an exception for an outsider; Restricted does not touch the members', async () => {
    const orders = (await s.api('GET', '/teams')).find((t: { name: string }) => t.name === 'Orders').id as string;
    policy.setOwningTeams('contract', 'owned', [orders]);
    await store('owned', 'user:vic', 'view');
    await restrict('owned');
    expect(rights('dana', 'owned')).toEqual(['view', 'test', 'edit']); // member of Orders
    expect(rights('vic', 'owned')).toEqual(['view']); // the share
    expect(rights('otto', 'owned')).toEqual([]);
  });

  it('a share that has ended stops at once, before the job removes it', async () => {
    await store('ended', 'user:vic', 'manage', { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await store('ended', 'user:pat', 'view', { expiresAt: new Date(Date.now() + DAY).toISOString() });
    await restrict('ended');
    expect(rights('vic', 'ended')).toEqual([]);
    expect(rights('pat', 'ended')).toEqual(['view']);
    expect(decideFor('pat', 'ended').reasons[0]!.expiresAt).toBeTruthy();
  });

  it('counts nothing for a kind that passes no share model (no kind is switched yet)', async () => {
    await store('nomodel', 'user:vic', 'manage');
    await restrict('nomodel');
    const d = ctx.runAs(null, () => policy.decide(userOf('vic'), { kind: 'contract', id: 'nomodel', acl: [] }, ALL, DEFAULTS, 'view'));
    expect(d.permissions).toEqual(['view']); // the viewer's role default, the share and Restricted ignored
    expect(ctx.runAs(null, () => policy.contractAccess(userOf('vic'), { id: 'nomodel' })).reasons.some((r) => r.source === 'share')).toBe(false);
  });

  it('says what someone holds in share terms; only Manage changes shares', () => {
    expect(policy.heldShare(userOf('dana'), MODEL, ['view', 'test', 'edit'])).toEqual({ level: 'edit', actions: ['test'] });
    expect(policy.heldShare(userOf('vic'), MODEL, ['view', 'edit', 'manage'])).toEqual({ level: 'manage', actions: [] });
    expect(policy.heldShare(userOf('vic'), MODEL, [])).toEqual({ level: null, actions: [] });
    expect(policy.heldShare(userOf('admin'), MODEL, [])).toBe('all');
    expect(policy.managesShares({ level: 'edit', actions: ['test'] })).toBe(false);
    expect(policy.managesShares({ level: 'manage', actions: [] })).toBe(true);
    expect(policy.managesShares('all')).toBe(true);
  });

  it('reads shares in bulk: deciding many resources costs the same statements as a few', async () => {
    const { requestDbStats } = await import('../src/database/timing.js');
    for (let i = 0; i < 60; i++) await store(`bulk-${i}`, i % 2 ? 'user:vic' : 'team:payments', 'view');
    const count = (name: string, n: number) => {
      const st = { statements: 0, ms: 0 };
      requestDbStats.run(st, () =>
        ctx.runAs(null, () => {
          const u = userOf(name);
          for (let i = 0; i < n; i++) policy.decide(u, { kind: 'contract', id: `bulk-${i}`, acl: [] }, ALL, DEFAULTS, 'view', { shares: MODEL });
        }),
      );
      return st.statements;
    };
    const few = count('vic', 3);
    const many = count('vic', 60);
    expect(many).toBe(few);
    // the user, the owning teams, the memberships, the shares of the kind, the Restricted ones of the kind
    expect(many).toBeLessThanOrEqual(8);
  });
});

describe('changing shares', () => {
  it('asks for the step-up when a share gives someone a right, and audits it with the proof', async () => {
    const body = {
      shares: [
        { subject: 'user:mia', level: 'manage' },
        { subject: 'user:ed', level: 'edit' },
        { subject: 'team:payments', level: 'view' },
      ],
    };
    await mia('DELETE', '/auth/step-up'); // signing in confirmed it a moment ago
    expect(await code(mia('PUT', '/test/shares/c1', body))).toBe('STEP_UP_REQUIRED');
    await mia('POST', '/auth/step-up', { password: PW });
    await mia('PUT', '/test/shares/c1', body);
    const [added] = await entries('access.share_added', 'c1');
    expect(added).toMatchObject({ actor: 'mia', details: { subject: 'team:payments', after: { level: 'view' }, granted: ['view'] } });
    expect(added!.details!.assurance).toEqual([expect.objectContaining({ point: 'access.grant', stepUp: expect.objectContaining({ method: 'password' }) })]);
    expect(rights('pat', 'c1')).toEqual(['view']);
    await mia('DELETE', '/auth/step-up');
  });

  it('never asks when it narrows: a lower level, an earlier end, a removed share', async () => {
    const until = new Date(Date.now() + 30 * DAY).toISOString();
    await s.api('PUT', '/test/shares/c1', {
      shares: [
        { subject: 'user:mia', level: 'manage' },
        { subject: 'user:ed', level: 'edit' },
        { subject: 'team:payments', level: 'edit', expiresAt: until },
      ],
    });
    const earlier = new Date(Date.now() + 10 * DAY).toISOString();
    const { shares } = await mia('PUT', '/test/shares/c1', {
      shares: [
        { subject: 'user:mia', level: 'manage' },
        { subject: 'team:payments', level: 'view', expiresAt: earlier },
      ],
    });
    expect(shares.map((x: { subject: string; level: string }) => `${x.subject}=${x.level}`)).toEqual(['team:payments=view', 'user:mia=manage']);
    const [changed] = await entries('access.share_changed', 'c1');
    expect(changed!.details).toMatchObject({ subject: 'team:payments', before: { level: 'edit' }, after: { level: 'view', expiresAt: earlier }, granted: [] });
    expect(changed!.details!.assurance).toBeUndefined();
    const [removed] = await entries('access.share_removed', 'c1');
    expect(removed).toMatchObject({ actor: 'mia', details: { subject: 'user:ed', before: { level: 'edit' } } });
  });

  it('asks when an end date moves later or goes', async () => {
    const shares = (expiresAt: string | null) => ({
      shares: [
        { subject: 'user:mia', level: 'manage' },
        { subject: 'team:payments', level: 'view', expiresAt },
      ],
    });
    expect(await code(mia('PUT', '/test/shares/c1', shares(new Date(Date.now() + 60 * DAY).toISOString())))).toBe('STEP_UP_REQUIRED');
    expect(await code(mia('PUT', '/test/shares/c1', shares(null)))).toBe('STEP_UP_REQUIRED');
    const gains = sh.shareGains(
      { restricted: true, shares: [{ subject: 'user:a', level: 'view', actions: [], expiresAt: '2030-01-01T00:00:00.000Z', createdBy: '', createdAt: '' }] },
      { restricted: true, shares: [{ subject: 'user:a', level: 'view', actions: [], expiresAt: null, createdBy: '', createdAt: '' }] },
    );
    expect(gains).toEqual([{ subject: 'user:a', rights: ['extended'] }]);
  });

  it('refuses API tokens a widening; narrowing works with one', async () => {
    await mia('POST', '/auth/step-up', { password: PW });
    const token = (await mia('POST', '/me/tokens', { name: 'mia full', scope: 'full' })).token as string;
    await mia('DELETE', '/auth/step-up');
    const put = (body: unknown) =>
      fetch(`${s.base}/api/test/shares/c1`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const wide = await put({
      shares: [
        { subject: 'user:mia', level: 'manage' },
        { subject: 'user:vic', level: 'view' },
      ],
    });
    expect(wide.status).toBe(403);
    expect((await wide.json()).code).toBe('SESSION_REQUIRED');
    const narrow = await put({ shares: [{ subject: 'user:mia', level: 'manage' }] });
    expect(narrow.status).toBe(200);
  });

  it('asks again in the service, so a path without the route rule never widens unconfirmed', () => {
    // a signed-in person without a session (an API token, an import, an MCP tool) cannot confirm
    expect(() =>
      ctx.runAs(userOf('admin'), () => sh.setShares({ kind: 'contract', id: 'svc', held: 'all', shares: [{ subject: 'user:vic', level: 'view' }] })),
    ).toThrow(expect.objectContaining({ code: 'SESSION_REQUIRED' }));
    expect(sh.sharesOf('contract', 'svc')).toEqual([]);
  });

  it('lets only Manage change shares – Edit may not re-share', async () => {
    await s.api('PUT', '/test/shares/c1', {
      shares: [
        { subject: 'user:mia', level: 'manage' },
        { subject: 'user:ed', level: 'edit' },
      ],
    });
    await ed('POST', '/auth/step-up', { password: PW });
    expect(await code(ed('PUT', '/test/shares/c1', { shares: [{ subject: 'user:mia', level: 'manage' }] }))).toBe('FORBIDDEN');
    expect(await code(ed('PUT', '/test/scope/c1', { restricted: true }))).toBe('FORBIDDEN');
  });

  it('lets nobody share more than they hold (administrators excepted)', async () => {
    await mia('POST', '/auth/step-up', { password: PW });
    const base = [
      { subject: 'user:mia', level: 'manage' },
      { subject: 'user:ed', level: 'edit' },
    ];
    // Mia (a viewer with Manage) has no right to test the contract: she cannot give it
    expect(await code(mia('PUT', '/test/shares/c1', { shares: [...base, { subject: 'user:vic', level: 'view', actions: ['test'] }] }))).toBe(
      'SHARE_EXCEEDS_OWN_RIGHTS',
    );
    await s.api('PUT', '/test/shares/c1', { shares: [...base, { subject: 'user:otto', level: 'view', actions: ['test'] }] });
    // keeping a share she could not give herself is fine; raising its level is within her rights
    await mia('PUT', '/test/shares/c1', { shares: [...base, { subject: 'user:otto', level: 'edit', actions: ['test'] }] }).then(
      () => expect.unreachable('raising a share with an action right she lacks'),
      (e: { body?: { code?: string } }) => expect(e.body?.code).toBe('SHARE_EXCEEDS_OWN_RIGHTS'),
    );
    await mia('PUT', '/test/shares/c1', {
      shares: [...base, { subject: 'user:otto', level: 'view', actions: ['test'] }, { subject: 'user:vic', level: 'edit' }],
    });
    expect(rights('vic', 'c1')).toEqual(['view', 'edit']);
  });

  it('refuses unknown and unsuitable subjects, unknown action rights and end dates beyond a year', async () => {
    const put = (share: Record<string, unknown>) => code(s.api('PUT', '/test/shares/c2', { shares: [share] }));
    expect(await put({ subject: 'user:nobody', level: 'view' })).toBe('USER_UNKNOWN');
    expect(await put({ subject: 'team:nowhere', level: 'view' })).toBe('TEAM_UNKNOWN');
    expect(await put({ subject: 'group:x', level: 'view' })).toBe('ACL_SUBJECT_INVALID');
    expect(await put({ subject: 'role:wizard', level: 'view' })).toBe('ACL_SUBJECT_INVALID');
    expect(await put({ subject: 'user:stat', level: 'view' })).toBe('SHARE_SUBJECT_UNSUITABLE');
    expect(await put({ subject: 'role:status', level: 'view' })).toBe('SHARE_SUBJECT_UNSUITABLE');
    // a plant viewer only on the plant registry's kinds
    expect(await put({ subject: 'user:flora', level: 'view' })).toBe('SHARE_SUBJECT_UNSUITABLE');
    expect(await put({ subject: 'role:plant', level: 'view' })).toBe('SHARE_SUBJECT_UNSUITABLE');
    expect(await put({ subject: 'user:vic', level: 'view', actions: ['run'] })).toBe('SHARE_ACTION_UNKNOWN');
    expect(await put({ subject: 'user:vic', level: 'view', expiresAt: new Date(Date.now() + 400 * DAY).toISOString() })).toBe('SHARE_EXPIRY_INVALID');
    expect(await put({ subject: 'user:vic', level: 'view', expiresAt: new Date(Date.now() - DAY).toISOString() })).toBe('SHARE_EXPIRY_INVALID');
    expect(await put({ subject: 'user:vic', level: 'view', expiresAt: 'soon' })).toBe('SHARE_EXPIRY_INVALID');
    expect(await put({ subject: 'User:Vic', level: 'view', expiresAt: new Date(Date.now() + 300 * DAY).toISOString().slice(0, 10) })).toBe('ok');
    expect(sh.sharesOf('contract', 'c2')).toEqual([expect.objectContaining({ subject: 'user:vic', expiresAt: expect.stringMatching(/T23:59:59.999Z$/) })]);
  });

  it('switching Restricted on narrows; switching it off asks for the step-up; both are audited', async () => {
    await mia('DELETE', '/auth/step-up');
    expect(await mia('PUT', '/test/scope/c1', { restricted: true })).toEqual({ changed: true });
    expect(rights('dana', 'c1')).toEqual([]); // the designer's role default is gone
    expect(await code(mia('PUT', '/test/scope/c1', { restricted: false }))).toBe('STEP_UP_REQUIRED');
    await mia('POST', '/auth/step-up', { password: PW });
    await mia('PUT', '/test/scope/c1', { restricted: false });
    expect(rights('dana', 'c1')).toEqual(['view', 'test', 'edit']);
    const [off, on] = await entries('access.scope_changed', 'c1');
    expect(on!.details).toMatchObject({ before: 'open', after: 'restricted' });
    expect(off!.details).toMatchObject({ before: 'restricted', after: 'open', granted: [{ subject: 'scope', rights: ['roleDefaults'] }] });
    expect(off!.details!.assurance).toBeTruthy();
    // the whole family under one filter (the audit log, evidence packs)
    const family = new Set(((await s.api('GET', '/audit?action=access.&entityId=c1&limit=100')) as { action: string }[]).map((e) => e.action));
    expect([...family].sort()).toEqual(['access.scope_changed', 'access.share_added', 'access.share_changed', 'access.share_removed']);
  });

  it('shows the confirmed changes in the assurance report', async () => {
    const from = new Date(Date.now() - DAY).toISOString();
    const to = new Date(Date.now() + DAY).toISOString();
    const { collectAssuranceReport } = await import('../src/compliance/assurance-report.js');
    const report = collectAssuranceReport({ from, to, lang: 'en' }, userOf('admin'));
    const actions = new Set(report.events.map((e) => e.action));
    expect(actions.has('access.share_added')).toBe(true);
    expect(actions.has('access.scope_changed')).toBe(true);
  });

  it('accessGrantRule: asks when the change widens, leaves refusals to the route', async () => {
    const { accessGrantRule, gainedRights } = await import('../src/auth/access-change.js');
    const rule = accessGrantRule((req) => (req.body as { wide: boolean }).wide);
    expect(rule.action).toBe('grantAccess');
    expect(rule.when!({ body: { wide: true } } as FastifyRequest)).toBe(true);
    expect(rule.when!({ body: { wide: false } } as FastifyRequest)).toBe(false);
    expect(rule.when!({ body: null } as FastifyRequest)).toBe(false); // throws: the route answers
    expect(
      gainedRights(
        new Map([['team:a', new Set(['view'])]]),
        new Map([
          ['team:a', new Set(['view', 'edit'])],
          ['user:b', new Set(['view'])],
        ]),
      ),
    ).toEqual([
      { subject: 'team:a', rights: ['edit'] },
      { subject: 'user:b', rights: ['view'] },
    ]);
  });
});

describe('end dates', () => {
  it('the job removes ended shares and audits each as the system', async () => {
    await store('exp', 'user:vic', 'edit', { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await store('exp', 'user:pat', 'view', { expiresAt: new Date(Date.now() + 20 * DAY).toISOString() });
    const { runShareJob } = await import('../src/auth/share-jobs.js');
    expect(runShareJob().expired).toBeGreaterThanOrEqual(1);
    expect(sh.sharesOf('contract', 'exp', { expired: true }).map((x) => x.subject)).toEqual(['user:pat']);
    const [e] = await entries('access.share_expired', 'exp');
    expect(e).toMatchObject({ actor: 'system', details: { subject: 'user:vic', before: { level: 'edit' }, removed: ['user:vic'] } });
  });

  it('reminds the Manage holders 7 days before, once, and again after an extension', async () => {
    // a kind switched to shares (what #291–#293 declare in their feature manifests)
    sh.registerShareKind({
      kind: 'contract',
      model: MODEL,
      name: (id) => `Invented contract ${id}`,
      link: (id) => `/data-contracts/${id}`,
      rights: (u, id) => policy.decide(u, { kind: 'contract', id, acl: [] }, ALL, DEFAULTS, 'view', { shares: MODEL }).permissions,
    });
    const soon = new Date(Date.now() + 3 * DAY).toISOString();
    await store('rem', 'user:mia', 'manage');
    await store('rem', 'user:vic', 'view', { expiresAt: soon });
    await store('rem', 'user:pat', 'view', { expiresAt: new Date(Date.now() + 9 * DAY).toISOString() });
    await restrict('rem');
    const { remindExpiringShares, shareReminderRecipients } = await import('../src/auth/share-jobs.js');
    const all = users.listUsers().filter((u) => u.active);
    expect(
      ctx
        .runAs(null, () => shareReminderRecipients('contract', 'rem', all))
        .map((u) => u.username)
        .sort(),
    ).toEqual(['admin', 'mia']);
    expect(remindExpiringShares()).toBe(1);
    expect(remindExpiringShares()).toBe(0);
    type Note = { event: string; title: string; link?: string };
    const notes = async (c: Client) => {
      const r = (await c('GET', '/notifications')) as { items?: Note[] } | Note[];
      return Array.isArray(r) ? r : (r.items ?? []);
    };
    const list = await notes(mia);
    const note = list.find((n) => n.event === 'access.share_expiring');
    expect(note).toMatchObject({ link: '/data-contracts/rem' });
    expect(note!.title).toBe('Invented contract rem: the share with vic ends in 3 days');
    // Vic does not manage it: no reminder for him
    expect((await notes(await s.as('vic', PW))).some((n) => n.event === 'access.share_expiring')).toBe(false);
    // a new end date arms it again
    await s.api('PUT', '/test/shares/rem', {
      shares: [
        { subject: 'user:mia', level: 'manage' },
        { subject: 'user:vic', level: 'view', expiresAt: new Date(Date.now() + 5 * DAY).toISOString() },
        { subject: 'user:pat', level: 'view', expiresAt: new Date(Date.now() + 9 * DAY).toISOString() },
      ],
    });
    expect(remindExpiringShares()).toBe(1);
  });

  it('a kind that is not switched reminds the administrators', async () => {
    const { shareReminderRecipients } = await import('../src/auth/share-jobs.js');
    const all = users.listUsers().filter((u) => u.active);
    expect(shareReminderRecipients('dashboard', 'x', all).map((u) => u.username)).toEqual(['admin']);
  });
});

describe('subjects of shares', () => {
  it('follow a team rename; a deleted team stays a share that matches nobody', async () => {
    const t = (await s.api('POST', '/teams', { name: 'Billing', members: ['vic'] })).id as string;
    await s.api('PUT', '/test/shares/ren', { shares: [{ subject: 'team:billing', level: 'edit' }] });
    await s.api('PUT', `/teams/${t}`, { name: 'Invoicing', members: ['vic'] });
    expect(sh.sharesOf('contract', 'ren').map((x) => x.subject)).toEqual(['team:invoicing']);
    await s.api('DELETE', `/teams/${t}`);
    expect(sh.sharesOf('contract', 'ren').map((x) => x.subject)).toEqual(['team:invoicing']);
  });

  it('a rename onto a former team name keeps the renamed team’s share only', async () => {
    const { rewriteTeamReferences } = await import('../src/auth/subjects.js');
    await store('clash', 'team:alpha', 'view');
    await store('clash', 'team:beta', 'manage'); // a former team "beta" (deleted): it matched nobody
    (await db()).tx(() => rewriteTeamReferences('alpha', 'beta'));
    expect(sh.sharesOf('contract', 'clash').map((x) => `${x.subject}=${x.level}`)).toEqual(['team:beta=view']);
  });

  it('are named where a user is named (personal data) and mapped in migration packages', async () => {
    const { mapValue } = await import('../src/migration/refs.js');
    const maps = {
      users: new Map([['vic', 'victor']]),
      teams: new Map<string, string | null>([
        ['payments', 'finance'],
        ['gone', null],
      ]),
    };
    expect(mapValue('subject', 'user:vic', maps)).toBe('user:victor');
    expect(mapValue('subject', 'team:payments', maps)).toBe('team:finance');
    expect(mapValue('subject', 'team:gone', maps)).toBeNull();
    expect(mapValue('subject', 'role:operator', maps)).toBe('role:operator');
    const { subjectReferences } = await import('../src/auth/subjects.js');
    expect(subjectReferences('user', 'mia').some((r) => r.table === 'resource_shares')).toBe(true);
  });
});
