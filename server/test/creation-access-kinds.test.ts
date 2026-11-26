import { beforeAll, describe, expect, it } from 'vitest';
import { OWNED_KINDS, type CreationAccess, type OwnedKind } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Uniform access at creation (ADR 0042): every kind of OWNED_KINDS takes `access` on its create route and applies the
 * instance default `newItemVisibility` when nobody chose. The table below has one entry per kind and is typed
 * `Record<OwnedKind, …>`: a kind added to OWNED_KINDS fails the type check and the "every kind" test until its create
 * path is wired up (applyCreationAccess) and listed here.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let admin: Client;
let vic: Client; // viewer outside the team
let team = '';
let other = '';
let platform = '';
let n = 0;
const uniq = (p: string) => `${p}-${++n}`;
const inv = (what: string) => `Invented ${what} ${uniq('n')}`;

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code ?? 'error',
  );

interface KindCase {
  /** creates one item as the administrator (whose new items belong to the team they chose) and returns its id */
  create: (access?: CreationAccess) => Promise<string>;
  /** whether a new item gets the creator's team without an `access` (suppliers, plant catalogue, … do not) */
  defaultTeams: boolean;
  /** whether the kind has the Restricted scope (a registered share kind) */
  restrictable: boolean;
}

const body = (access?: CreationAccess) => (access ? { access } : {});
const post = (path: string, b: Record<string, unknown>, access?: CreationAccess) => admin('POST', path, { ...b, ...body(access) });

const yamlContract = (id: string) =>
  [
    'apiVersion: v3.0.2',
    'kind: DataContract',
    `id: ${id}`,
    `name: Contract ${id}`,
    'version: 1.0.0',
    'status: active',
    'schema:',
    '  - name: products',
    '    properties:',
    '      - { name: id, logicalType: integer, required: true }',
  ].join('\n');

const CALC = (id: string) => `kind: costCalculator
id: ${id}
name: Calculator ${id}
inputs:
  - { key: seats, label: Seats, type: integer, default: 3, range: false }
lines:
  - { key: seats, item: { provider: Invented Messaging AG, sku: seat }, quantity: inputs.seats, unit: '{seat}.mo' }
`;

const CASES: Record<OwnedKind, KindCase> = {
  process: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) =>
      (
        await post(
          '/processes',
          { definition: { name: inv('process'), connections: [], inputs: [], nodes: [{ id: 'start', type: 'start', name: 'Start', x: 0, y: 0 }], wires: [] } },
          access,
        )
      ).id,
  },
  platform: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/platforms', { name: inv('platform'), kind: 'generic', baseUrl: s.base, config: { variables: {} } }, access)).id,
  },
  service: { defaultTeams: true, restrictable: true, create: async (access) => (await post('/services', { name: inv('service'), owners: [] }, access)).id },
  application: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/applications', { name: inv('application'), owners: [] }, access)).id,
  },
  system: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/systems', { name: inv('system'), kind: 'server', owners: [] }, access)).id,
  },
  record: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/records', { type: 'DOC', title: inv('record') }, access)).id,
  },
  credential: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/credentials', { name: inv('credential'), type: 'technicalUser', rotationIntervalDays: 90 }, access)).id,
  },
  monitor: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) =>
      (
        await post(
          '/monitors',
          { definition: { name: inv('monitor'), checks: [{ id: 'alive', name: 'Alive', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 180 }] } },
          access,
        )
      ).monitor.id,
  },
  dashboard: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/dashboards', { definition: { name: inv('dashboard'), widgets: [] } }, access)).id,
  },
  ticket: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) =>
      (await post('/ticket-references', { source: 'vendor', externalNumber: uniq('CS'), title: inv('ticket'), vendor: 'Invented AG' }, access)).id,
  },
  site: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/plant/sites', { id: uniq('inv-site'), name: inv('site') }, access)).id,
  },
  contract: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/data-contracts', { yaml: yamlContract(uniq('inv-contract')) }, access)).id,
  },
  platform_identity: {
    defaultTeams: false,
    restrictable: true,
    create: async (access) => (await post(`/platforms/${platform}/identities`, { name: uniq('reader') }, access)).id,
  },
  supplier: {
    defaultTeams: false,
    restrictable: true,
    create: async (access) => (await post('/suppliers', { name: inv('Supplier AG'), type: 'saas' }, access)).id,
  },
  cost_price_book: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/costs/price-books', { name: inv('rates'), kind: 'list', provider: 'Invented', currency: 'EUR' }, access)).id,
  },
  cost_calculator: {
    defaultTeams: true,
    restrictable: false,
    create: async (access) => (await post('/costs/calculators', { definition: CALC(uniq('inv-calc')) }, access)).id,
  },
  device_profile: {
    defaultTeams: false,
    restrictable: true,
    create: async (access) => (await post('/plant/profiles', { id: uniq('inv-profile'), name: inv('profile') }, access)).id,
  },
  kpi_definition: {
    defaultTeams: false,
    restrictable: true,
    create: async (access) => (await post('/plant/kpis', { id: uniq('inv-kpi'), name: inv('kpi') }, access)).id,
  },
  blueprint: {
    defaultTeams: false,
    restrictable: true,
    create: async (access) => (await post('/plant/blueprints', { id: uniq('inv-blueprint'), name: inv('blueprint') }, access)).id,
  },
  data_product: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/data-products', { key: uniq('inv-product'), name: inv('product') }, access)).id,
  },
  data_object: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/data-objects', { key: uniq('inv-object'), name: inv('object') }, access)).id,
  },
  data_element: {
    defaultTeams: true,
    restrictable: false,
    create: async (access) =>
      (
        await post(
          '/data-elements',
          { kind: 'mqtt.topic', qualifiedName: `invented/${uniq('topic')}`, environment: 'prod', namespace: 'mqtt://broker.example:1883' },
          access,
        )
      ).id,
  },
  data_domain: {
    defaultTeams: true,
    restrictable: true,
    create: async (access) => (await post('/data-domains', { key: uniq('inv-domain'), name: inv('domain') }, access)).id,
  },
};

const teamsOf = async (kind: OwnedKind, id: string): Promise<string[]> => {
  const { db } = await import('../src/db.js');
  return db()
    .all<{ team_id: string }>('SELECT team_id FROM resource_teams WHERE kind = ? AND resource_id = ? ORDER BY team_id', kind, id)
    .map((r) => r.team_id);
};
const restricted = async (kind: OwnedKind, id: string): Promise<boolean> => {
  const { db } = await import('../src/db.js');
  return !!db().get('SELECT 1 FROM resource_restrictions WHERE kind = ? AND resource_id = ?', kind, id);
};
const setVisibility = (v: 'everyone' | 'owningTeams') => s.api('PUT', '/settings/instance', { newItemVisibility: v });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s, { newItemVisibility: 'owningTeams' });
  admin = s.api;
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'vic', roles: ['viewer'], password: PW, mustChangePassword: false });
  team = (await admin('POST', '/teams', { name: 'Invented payments', members: ['admin'] })).id;
  other = (await admin('POST', '/teams', { name: 'Invented logistics', members: [] })).id;
  await admin('PUT', '/me/new-resource-teams', { teamId: team });
  await admin('PUT', '/settings/modules/dataProducts', { enabled: true });
  await admin('PUT', '/settings/modules/plant', { enabled: true });
  platform = (await admin('POST', '/platforms', { name: inv('host'), kind: 'generic', baseUrl: s.base, config: { variables: {} } })).id;
  vic = await s.as('vic', PW);
});

describe('a table over every kind of OWNED_KINDS', () => {
  it('has a case for each kind and no other', () => {
    expect(Object.keys(CASES).sort()).toEqual([...OWNED_KINDS].sort());
  });

  describe.each(OWNED_KINDS)('%s', (kind) => {
    const c = CASES[kind];

    it('new installation: a new item starts with its creator’s team and, where there is one, Restricted (the default)', async () => {
      expect(((await admin('GET', '/settings/instance')) as { newItemVisibility: string }).newItemVisibility).toBe('owningTeams');
      const id = await c.create();
      expect(await teamsOf(kind, id)).toEqual(c.defaultTeams ? [team] : []);
      expect(await restricted(kind, id)).toBe(c.restrictable && c.defaultTeams);
      // team scope: a reader outside the team is told nothing about a restricted item
      if (c.restrictable && c.defaultTeams) expect(await code(vic('GET', `/owning-teams/${kind}/${id}`))).toMatch(/NOT_FOUND/);
    });

    it('"everyone": a new item stays open, as before', async () => {
      await setVisibility('everyone');
      try {
        const id = await c.create();
        expect(await teamsOf(kind, id)).toEqual(c.defaultTeams ? [team] : []);
        expect(await restricted(kind, id)).toBe(false);
      } finally {
        await setVisibility('owningTeams');
      }
    });

    it('takes owning teams and Restricted with the creation', async () => {
      const access: CreationAccess = { owningTeams: [other], restricted: true };
      if (!c.restrictable) {
        expect(await code(c.create(access))).toBe('ACCESS_NOT_RESTRICTABLE');
        const id = await c.create({ owningTeams: [other] });
        expect(await teamsOf(kind, id)).toEqual([other]);
        return;
      }
      const id = await c.create(access);
      expect(await teamsOf(kind, id)).toEqual([other]);
      expect(await restricted(kind, id)).toBe(true);
      expect(await code(vic('GET', `/owning-teams/${kind}/${id}`))).toMatch(/NOT_FOUND/);
    });

    it('an unknown team is refused', async () => {
      expect(await code(c.create({ owningTeams: ['missing'] }))).toBe('TEAM_NOT_FOUND');
    });

    it('opening it on purpose (restricted: false) is a widening and creates the item open', async () => {
      if (!c.restrictable || !c.defaultTeams) return;
      const id = await c.create({ restricted: false });
      expect(await restricted(kind, id)).toBe(false);
    });
  });
});

describe('team scope of a new item', () => {
  it('a member’s new item is the team’s alone: neither listed nor counted for others, found by the team', async () => {
    const users = await import('../src/auth/users.js');
    users.createUser({ username: 'desi', roles: ['designer'], password: PW, mustChangePassword: false });
    users.createUser({ username: 'mia', roles: ['designer'], password: PW, mustChangePassword: false });
    await admin('PUT', `/teams/${team}`, { name: 'Invented payments', members: ['admin', 'desi', 'mia'] });
    const desi = await s.as('desi', PW);
    const mia = await s.as('mia', PW);
    const sam = await s.as('vic', PW);
    const made = (await desi('POST', '/services', { name: 'Invented team-only service', owners: [] })) as { id: string };
    expect(await restricted('service', made.id)).toBe(true);
    const ids = async (c: Client) => ((await c('GET', '/services')) as { id: string }[]).map((x) => x.id);
    expect(await ids(desi)).toContain(made.id);
    expect(await ids(mia)).toContain(made.id);
    expect(await ids(sam)).not.toContain(made.id);
    expect(await code(sam('GET', `/services/${made.id}`))).toMatch(/NOT_FOUND/);
  });

  it('a person without a team has no team to narrow to: refused while only owning teams see new items, open otherwise', async () => {
    const users = await import('../src/auth/users.js');
    users.createUser({ username: 'solo', roles: ['designer'], password: PW, mustChangePassword: false });
    const solo = await s.as('solo', PW);
    expect(await code(solo('POST', '/services', { name: 'Invented solo service', owners: [] }))).toBe('ACCESS_OWNING_TEAM_REQUIRED');
    await setVisibility('everyone');
    try {
      const made = (await solo('POST', '/services', { name: 'Invented solo service', owners: [] })) as { id: string };
      expect(await teamsOf('service', made.id)).toEqual([]);
      expect(await restricted('service', made.id)).toBe(false);
    } finally {
      await setVisibility('owningTeams');
    }
  });

  it('asking for access on a kind without the Restricted scope is refused, naming the kind', async () => {
    await expect(
      admin('POST', '/data-elements', {
        kind: 'mqtt.topic',
        qualifiedName: 'invented/x',
        environment: 'prod',
        namespace: 'mqtt://broker.example:1883',
        access: { shares: [{ subject: 'user:vic', level: 'view' }] },
      }),
    ).rejects.toMatchObject({
      status: 400,
      body: { code: 'ACCESS_NOT_RESTRICTABLE' },
    });
  });
});
