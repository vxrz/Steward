import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * "Owning teams only" asks every creator for an owning team (ADR 0042): a person without a team – an administrator
 * included – is refused (ACCESS_OWNING_TEAM_REQUIRED, nothing is created) unless they name one. Catalogue items
 * (device profiles, KPI definitions, machine blueprints, suppliers) and platform identities stay open. With "everyone"
 * nothing changes.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let admin: Client;
let desi: Client; // a designer without a team
let team = '';
let platform = '';
let n = 0;
const uniq = (p: string) => `${p}-${++n}`;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code ?? 'error',
  );
const count = async () => ((await admin('GET', '/services')) as unknown[]).length;
const teamsOf = async (kind: string, id: string) => ((await admin('GET', `/owning-teams/${kind}/${id}`)) as { teams: { id: string }[] }).teams.map((t) => t.id);
const setVisibility = (v: 'everyone' | 'owningTeams') => admin('PUT', '/settings/instance', { newItemVisibility: v });

const CONTRACT = (id: string) =>
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

beforeAll(async () => {
  s = await startTestServer();
  await setup(s, { newItemVisibility: 'owningTeams' });
  admin = s.api;
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'desi', roles: ['designer'], password: PW, mustChangePassword: false });
  desi = await s.as('desi', PW);
  team = (await admin('POST', '/teams', { name: 'Invented payments', members: ['desi'] })).id;
  await admin('PUT', '/settings/modules/dataProducts', { enabled: true });
  await admin('PUT', '/settings/modules/plant', { enabled: true });
  platform = (
    await admin('POST', '/platforms', { name: 'Invented host', kind: 'generic', baseUrl: s.base, config: { variables: {} }, access: { owningTeams: [team] } })
  ).id;
});

describe('owning teams only', () => {
  it('an administrator without a team is refused, then succeeds with a team', async () => {
    const before = await count();
    expect(await code(admin('POST', '/services', { name: 'Invented service A', owners: [] }))).toBe('ACCESS_OWNING_TEAM_REQUIRED');
    expect(await count()).toBe(before);
    const made = await admin('POST', '/services', { name: 'Invented service A', owners: [], access: { owningTeams: [team] } });
    expect(await teamsOf('service', made.id)).toEqual([team]);
    // an empty list is the same as naming none
    expect(await code(admin('POST', '/services', { name: 'Invented service B', owners: [], access: { owningTeams: [] } }))).toBe('ACCESS_OWNING_TEAM_REQUIRED');
    expect(await count()).toBe(before + 1);
  });

  it('a person without a team is refused too; their team ends the refusal', async () => {
    const solo = await s.as('desi', PW);
    await admin('PUT', `/teams/${team}`, { name: 'Invented payments', members: [] });
    expect(await code(solo('POST', '/services', { name: 'Invented service C', owners: [] }))).toBe('ACCESS_OWNING_TEAM_REQUIRED');
    await admin('PUT', `/teams/${team}`, { name: 'Invented payments', members: ['desi'] });
    expect(await code(desi('POST', '/services', { name: 'Invented service D', owners: [] }))).toBe('ok');
  });

  it('an import that names no team is refused', async () => {
    expect(await code(admin('POST', '/data-contracts', { yaml: CONTRACT(uniq('dc')) }))).toBe('ACCESS_OWNING_TEAM_REQUIRED');
    expect(await code(admin('POST', '/data-contracts', { yaml: CONTRACT(uniq('dc')), access: { owningTeams: [team] } }))).toBe('ok');
  });

  it('catalogue items and identities are created open', async () => {
    const blueprint = await admin('POST', '/plant/blueprints', { id: uniq('inv-bp'), name: 'Invented blueprint' });
    expect(await teamsOf('blueprint', blueprint.id)).toEqual([]);
    expect(await code(admin('POST', '/suppliers', { name: 'Invented Supplier AG', type: 'saas' }))).toBe('ok');
    expect(await code(admin('POST', `/platforms/${platform}/identities`, { name: uniq('reader') }))).toBe('ok');
  });
});

describe('everyone', () => {
  it('nothing changes: a teamless creator creates open items', async () => {
    await setVisibility('everyone');
    try {
      const made = await admin('POST', '/services', { name: 'Invented service E', owners: [] });
      expect(await teamsOf('service', made.id)).toEqual([]);
      expect(await code(admin('POST', '/data-contracts', { yaml: CONTRACT(uniq('dc')) }))).toBe('ok');
    } finally {
      await setVisibility('owningTeams');
    }
  });
});
