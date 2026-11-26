import { beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@sm/shared';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Access at creation (ADR 0040 part 1): the create routes of processes, monitors and dashboards take an optional
 * `access` object (owning teams, Restricted, shares) that is applied in the creation's transaction – narrowing asks
 * for nothing, widening asks for the step-up and a refusal creates nothing; the audit entries are the Access tab's.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let admin: Client; // never asked to confirm
let strict: Client; // administrator, confirms by hand
let desi: Client; // designer, member of the payments team (its default team)
let vic: Client; // viewer outside the team
let sam: Client; // viewer outside the team, shared with
let team = '';
let other = '';

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code ?? 'error',
  );
const entries = async (action: string, id: string) =>
  (await s.api('GET', `/audit?action=${action}&entityId=${id}&limit=20`)) as { details?: Record<string, unknown> }[];
const name = (kind: string, n: number) => `Invented ${kind} ${n}`;
let n = 0;

/** One create call per kind: returns the id, with the body the route takes. */
const KINDS = {
  process: {
    list: '/processes',
    create: (c: Client, access?: unknown) =>
      c('POST', '/processes', {
        definition: { name: name('process', ++n), connections: [], inputs: [], nodes: [{ id: 'start', type: 'start', name: 'Start', x: 0, y: 0 }], wires: [] },
        ...(access ? { access } : {}),
      }).then((r: { id: string }) => r.id),
    view: (id: string) => `/processes/${id}`,
  },
  dashboard: {
    list: '/dashboards',
    create: (c: Client, access?: unknown) =>
      c('POST', '/dashboards', { definition: { name: name('dashboard', ++n), widgets: [] }, ...(access ? { access } : {}) }).then((r: { id: string }) => r.id),
    view: (id: string) => `/dashboards/${id}`,
  },
  monitor: {
    list: '/monitors',
    create: (c: Client, access?: unknown) =>
      c('POST', '/monitors', {
        definition: { name: name('monitor', ++n), checks: [{ id: 'alive', name: 'Alive', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 180 }] },
        ...(access ? { access } : {}),
      }).then((r: { monitor: { id: string } }) => r.monitor.id),
    view: (id: string) => `/monitors/${id}`,
  },
} as const;
const count = async (kind: keyof typeof KINDS) => ((await s.api('GET', KINDS[kind].list)) as unknown[]).length;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s, { newItemVisibility: 'owningTeams' });
  const users = await import('../src/auth/users.js');
  for (const [username, roles] of [
    ['desi', ['designer']],
    ['vic', ['viewer']],
    ['sam', ['viewer']],
  ] as [string, Role[]][])
    users.createUser({ username, roles, password: PW, mustChangePassword: false });
  team = (await s.api('POST', '/teams', { name: 'Invented payments', members: ['desi'] })).id;
  other = (await s.api('POST', '/teams', { name: 'Invented logistics', members: [] })).id;
  // desi's new items belong to the payments team
  desi = await s.as('desi', PW, { autoStepUp: false });
  await desi('PUT', '/me/new-resource-teams', { teamId: team });
  await desi('DELETE', '/auth/step-up');
  vic = await s.as('vic', PW);
  sam = await s.as('sam', PW);
  admin = s.api;
  strict = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
});

for (const kind of ['process', 'dashboard', 'monitor'] as const) {
  describe(`${kind}: access at creation`, () => {
    it('without access: unchanged – the creator defaults, open to the instance for an administrator', async () => {
      // an administrator without a team creates open items only where new items are open (with "owning teams only" they name a team)
      expect(await code(KINDS[kind].create(admin))).toBe('ACCESS_OWNING_TEAM_REQUIRED');
      await s.api('PUT', '/settings/instance', { newItemVisibility: 'everyone' });
      const id = await KINDS[kind].create(admin);
      await s.api('PUT', '/settings/instance', { newItemVisibility: 'owningTeams' });
      expect((await s.api('GET', `/owning-teams/${kind}/${id}`)).teams).toEqual([]);
      expect(await code(vic('GET', KINDS[kind].view(id)))).toBe('ok');
      const mine = await KINDS[kind].create(desi);
      expect((await s.api('GET', `/owning-teams/${kind}/${mine}`)).teams.map((t: { id: string }) => t.id)).toEqual([team]);
      expect(await entries('access.owning_teams_changed', mine)).toHaveLength(0);
    });

    it('narrowed: owning team and Restricted need no confirmation and the item is hidden at once', async () => {
      await strict('DELETE', '/auth/step-up');
      const id = await KINDS[kind].create(strict, { owningTeams: [team], restricted: true });
      expect((await s.api('GET', `/owning-teams/${kind}/${id}`)).teams.map((t: { id: string }) => t.id)).toEqual([team]);
      expect(await code(vic('GET', KINDS[kind].view(id)))).not.toBe('ok');
      expect(((await vic('GET', KINDS[kind].list)) as { id: string }[]).some((x) => x.id === id)).toBe(false);
      const changed = await entries('access.owning_teams_changed', id);
      expect(changed).toHaveLength(1);
      expect(changed[0]!.details).toMatchObject({ before: [], after: ['Invented payments'] });
      expect(await entries('access.scope_changed', id)).toHaveLength(1);
    });

    it('shares widen: refused without the step-up and nothing is created; confirmed, the share reaches it', async () => {
      await strict('DELETE', '/auth/step-up');
      const before = await count(kind);
      const access = { owningTeams: [team], shares: [{ subject: 'user:sam', level: 'view' }] };
      expect(await code(KINDS[kind].create(strict, access))).toBe('STEP_UP_REQUIRED');
      expect(await count(kind)).toBe(before);
      const id = await KINDS[kind].create(admin, access);
      expect(await code(sam('GET', KINDS[kind].view(id)))).toBe('ok');
      expect(await code(vic('GET', KINDS[kind].view(id)))).not.toBe('ok');
      expect(await entries('access.share_added', id)).toHaveLength(1);
    });

    it('widening beyond the defaults asks for the step-up and creates nothing without it', async () => {
      await desi('DELETE', '/auth/step-up');
      const before = await count(kind);
      // none at all opens an item the defaults scope to the payments team
      expect(await code(KINDS[kind].create(desi, { owningTeams: [] }))).toBe('STEP_UP_REQUIRED');
      expect(await count(kind)).toBe(before);
      // a team of the person's own beside the defaults is a widening too; another team's is not theirs to name
      expect(await code(KINDS[kind].create(desi, { owningTeams: [team, other] }))).toBe('FORBIDDEN');
      expect(await count(kind)).toBe(before);
    });

    it('an unknown team is refused and nothing is created', async () => {
      const before = await count(kind);
      expect(await code(KINDS[kind].create(admin, { owningTeams: ['missing'] }))).toBe('TEAM_NOT_FOUND');
      expect(await count(kind)).toBe(before);
    });

    it('a non-administrator gets the same refusal for an unknown team and for another team (no probing)', async () => {
      const unknownRefusal = await KINDS[kind].create(desi, { owningTeams: ['missing'] }).then(
        () => null,
        (e: any) => ({ status: e.status, code: e.body?.code, body: JSON.stringify(e.body) }),
      );
      const otherRefusal = await KINDS[kind].create(desi, { owningTeams: [other] }).then(
        () => null,
        (e: any) => ({ status: e.status, code: e.body?.code, body: JSON.stringify(e.body) }),
      );
      expect(unknownRefusal).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(otherRefusal).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(JSON.parse(unknownRefusal!.body).context).toBe(JSON.parse(otherRefusal!.body).context);
      expect(unknownRefusal!.body).not.toContain('missing');
      expect(otherRefusal!.body).not.toContain(other);
    });

    it('narrowing the defaults (Restricted only) needs nothing', async () => {
      await desi('DELETE', '/auth/step-up');
      const id = await KINDS[kind].create(desi, { restricted: true });
      expect((await s.api('GET', `/owning-teams/${kind}/${id}`)).teams.map((t: { id: string }) => t.id)).toEqual([team]);
      expect(await entries('access.scope_changed', id)).toHaveLength(1);
    });
  });
}
