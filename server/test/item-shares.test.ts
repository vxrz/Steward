import { beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Shares on records, credentials, ticket references, dashboards and data contracts (0.23.0, ADR 0033 phase 2, #297):
 * a share gives an outsider View, Edit or Manage on a team's item; Restricted keeps instance roles out of an unowned
 * one; owners and responsibles imply a share; Manage by default (decision 13); a designer among the members edits a
 * team's dashboard (decision 11); a data contract's former `manage` is the action right `relax` (decision 12); lists
 * show what is shared, and read shares in bulk.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let db: typeof import('../src/db.js').db;
let users: typeof import('../src/auth/users.js');
let ctx: typeof import('../src/auth/context.js');
let policy: typeof import('../src/auth/policy.js');
let otto: Client; // operator, outside the team
let vic: Client; // viewer, outside the team
const counted = new Map<string, number>();
const at = '2026-11-01T00:00:00.000Z';
let team = '';
const ids: Record<'record' | 'credential' | 'ticket' | 'dashboard' | 'contract', { owned: string; open: string }> = {
  record: { owned: '', open: '' },
  credential: { owned: '', open: '' },
  ticket: { owned: '', open: '' },
  dashboard: { owned: '', open: '' },
  contract: { owned: '', open: '' },
};
const KINDS = Object.keys(ids) as (keyof typeof ids)[];

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code ?? 'error',
  );
const userOf = (name: string) => users.toAuthUser(users.findUserByName(name)!);
/** The rights of `name` on an item, as the Access tab decides them (with `manage`). */
async function rights(kind: keyof typeof ids, id: string, name: string): Promise<string[]> {
  const { shareKind } = await import('../src/auth/shares.js');
  return ctx.runAs(null, () => [...shareKind(kind)!.rights(userOf(name), id)]);
}
const share = (kind: string, id: string, list: unknown[]) => s.api('PUT', `/access/${kind}/${id}/shares`, { shares: list });

let n = 0;
function insert(kind: keyof typeof ids, owner: string | null): string {
  const id = `${kind.slice(0, 3)}_item_${n++}`;
  const d = db();
  if (kind === 'record') {
    const type = d.get<{ id: string }>("SELECT id FROM record_types WHERE key = 'CR'") ?? d.get<{ id: string }>('SELECT id FROM record_types LIMIT 1')!;
    d.run(
      'INSERT INTO records (id, type_id, number, title, status, owner, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      type.id,
      `T-${n}`,
      `Invented record ${n}`,
      'draft',
      owner ?? 'admin',
      at,
      'admin',
      at,
      'admin',
    );
  } else if (kind === 'credential')
    d.run(
      'INSERT INTO credentials (id, name, type, owner_subjects, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      `Invented credential ${n}`,
      'token',
      JSON.stringify(owner ? [`user:${owner}`] : []),
      at,
      'admin',
      at,
      'admin',
    );
  else if (kind === 'ticket')
    d.run(
      'INSERT INTO ticket_refs (id, source, external_number, title, status, responsible, opened_at, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      'vendor',
      `CS-${n}`,
      `Invented ticket ${n}`,
      'open',
      JSON.stringify(owner ? [`user:${owner}`] : []),
      at,
      at,
      'admin',
      at,
      'admin',
    );
  else if (kind === 'dashboard')
    d.run(
      'INSERT INTO dashboards (id, name, definition, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      `Invented board ${n}`,
      JSON.stringify({ name: `Invented board ${n}`, widgets: [] }),
      owner,
      at,
      at,
    );
  else
    d.run(
      'INSERT INTO data_contracts (id, contract_key, name, current_version, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
      id,
      `invented-${n}`,
      `Invented contract ${n}`,
      at,
      'admin',
      at,
      'admin',
    );
  return id;
}

beforeAll(async () => {
  s = await startTestServer({
    routes: (a) =>
      a.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        counted.set(req.url, requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  db = (await import('../src/db.js')).db;
  users = await import('../src/auth/users.js');
  ctx = await import('../src/auth/context.js');
  policy = await import('../src/auth/policy.js');
  for (const [username, roles] of [
    ['dana', ['viewer']], // team designer
    ['tom', ['viewer']], // team member, viewer
    ['otto', ['operator']],
    ['vic', ['viewer']],
    ['desi', ['designer']], // designer outside the team
    ['appr', ['approver']],
    ['aud', ['auditor']],
  ] as [string, Role[]][])
    users.createUser({ username, roles, password: PW, mustChangePassword: false });
  const t = await s.api('POST', '/teams', { name: 'Invented payments', members: ['dana', 'tom'] });
  team = t.id;
  db().run(`UPDATE team_members SET roles = '["designer"]' WHERE team_id = ? AND user_id = ?`, team, users.findUserByName('dana')!.id);
  (await import('../src/records/types.js')).ensureDefaultTypes();
  for (const kind of KINDS) {
    ids[kind].owned = insert(kind, kind === 'dashboard' ? 'tom' : null);
    ids[kind].open = insert(kind, kind === 'dashboard' ? 'desi' : null);
    await s.api('PUT', `/owning-teams/${kind}/${ids[kind].owned}`, { teamIds: [team] });
  }
  otto = await s.as('otto', PW);
  vic = await s.as('vic', PW);
});

describe('a share opens a team item to an outsider', () => {
  for (const kind of ['record', 'credential', 'ticket', 'dashboard', 'contract'] as const)
    it(`${kind}: View, then Edit, then Manage – and nothing without it`, async () => {
      const id = ids[kind].owned;
      expect(await rights(kind, id, 'otto')).toEqual([]);
      await share(kind, id, [{ subject: 'user:otto', level: 'view' }]);
      expect(await rights(kind, id, 'otto')).toEqual(['view']);
      await share(kind, id, [{ subject: 'user:otto', level: 'edit' }]);
      expect(await rights(kind, id, 'otto')).toEqual(expect.arrayContaining(['view', 'edit']));
      expect(await rights(kind, id, 'otto')).not.toContain('manage');
      await share(kind, id, [{ subject: 'user:otto', level: 'manage' }]);
      expect((await otto('GET', `/access/${kind}/${id}/shares`)).canManage).toBe(true);
      // Manage holders change the shares; nobody shares more than they hold
      await share(kind, id, [{ subject: 'user:otto', level: 'view' }]);
      expect((await otto('GET', `/access/${kind}/${id}/shares`)).canManage).toBe(false);
      expect(await code(otto('PUT', `/access/${kind}/${id}/shares`, { shares: [] }))).toBe('FORBIDDEN');
      await share(kind, id, []);
      expect(await code(otto('GET', `/access/${kind}/${id}/shares`))).not.toBe('ok');
    });
});

describe('Restricted keeps instance roles out of an unowned item', () => {
  for (const kind of ['record', 'credential', 'ticket', 'dashboard', 'contract'] as const)
    it(`${kind}: viewers lose it, auditors keep seeing it, its shares reach it`, async () => {
      const id = ids[kind].open;
      const before = await rights(kind, id, 'aud');
      expect(before).toContain('view');
      await s.api('PUT', `/access/${kind}/${id}/scope`, { restricted: true });
      try {
        expect(await rights(kind, id, 'aud')).toEqual(['view']);
        // an operator reads credentials, tickets, records and contracts by role: not any more
        expect(await rights(kind, id, 'otto')).toEqual([]);
        await share(kind, id, [{ subject: 'user:otto', level: 'view' }]);
        expect(await rights(kind, id, 'otto')).toEqual(['view']);
      } finally {
        await share(kind, id, []);
        await s.api('PUT', `/access/${kind}/${id}/scope`, { restricted: false });
      }
    });
});

describe('owners, Manage by default and the decisions', () => {
  it('owners and responsibles imply a share: Edit, a dashboard owner Manage', async () => {
    const rec = insert('record', 'vic');
    const cred = insert('credential', 'vic');
    const tick = insert('ticket', 'vic');
    for (const [kind, id] of [
      ['record', rec],
      ['credential', cred],
      ['ticket', tick],
    ] as const) {
      const v = await s.api('GET', `/access/${kind}/${id}/shares`);
      expect(v.implied, kind).toEqual([expect.objectContaining({ subject: 'user:vic', level: 'edit' })]);
      expect(await rights(kind, id, 'vic'), kind).toEqual(expect.arrayContaining(['view', 'edit']));
      expect(await rights(kind, id, 'vic'), kind).not.toContain('manage');
    }
    const board = ids.dashboard.owned; // owned by tom
    expect((await s.api('GET', `/access/dashboard/${board}/shares`)).implied).toEqual([expect.objectContaining({ subject: 'user:tom', level: 'manage' })]);
    expect(await rights('dashboard', board, 'tom')).toEqual(['view', 'edit', 'manage']);
  });

  it('Manage by default: editors by role of credentials and tickets, designers of records and contracts, a dashboard its owner', async () => {
    expect(await rights('credential', ids.credential.open, 'otto')).toContain('manage');
    expect(await rights('ticket', ids.ticket.open, 'otto')).toContain('manage');
    expect(await rights('record', ids.record.open, 'otto')).not.toContain('manage');
    expect(await rights('record', ids.record.open, 'desi')).toContain('manage');
    expect(await rights('contract', ids.contract.open, 'desi')).toContain('share');
    expect(await rights('contract', ids.contract.owned, 'desi')).toEqual([]);
    expect(await rights('contract', ids.contract.owned, 'dana')).toContain('share');
    // a dashboard of the whole instance: its owner manages it, designers only see it
    expect(await rights('dashboard', ids.dashboard.open, 'desi')).toEqual(['view', 'edit', 'manage']);
    expect(await rights('dashboard', ids.dashboard.open, 'otto')).toEqual(['view']);
  });

  it('decision 11: a designer among the members of its owning teams edits a team dashboard', async () => {
    const id = ids.dashboard.owned;
    expect(await rights('dashboard', id, 'dana')).toEqual(['view', 'edit']);
    expect(await rights('dashboard', id, 'tom')).toEqual(['view', 'edit', 'manage']); // its owner
    // a designer outside the team does not see it
    expect(await rights('dashboard', id, 'desi')).toEqual([]);
    const dana = await s.as('dana', PW);
    expect((await dana('GET', `/dashboards/${id}`)).canEdit).toBe(true);
  });

  it('decision 12: relaxing the breaking-change rule is an action right (relax, formerly manage)', async () => {
    const id = ids.contract.open;
    const appr = ctx.runAs(null, () => policy.contractAccess(userOf('appr'), { id }).permissions);
    expect(appr).toEqual(['view', 'relax', 'manage']);
    expect(ctx.runAs(null, () => policy.contractAccess(userOf('desi'), { id }).permissions)).toEqual(['view', 'test', 'edit']);
    // a share with relax beside the level
    const owned = ids.contract.owned;
    await share('contract', owned, [{ subject: 'user:vic', level: 'view', actions: ['relax'] }]);
    expect(ctx.runAs(null, () => policy.contractAccess(userOf('vic'), { id: owned }).permissions)).toEqual(['view', 'relax', 'manage']);
    await share('contract', owned, []);
    const v = await s.api('GET', `/access/contract/${owned}/shares`);
    expect(v.actions).toEqual(['test', 'relax']);
  });
});

describe('lists', () => {
  const LIST: Record<string, string> = {
    record: '/records',
    credential: '/credentials',
    ticket: '/ticket-references',
    dashboard: '/dashboards',
  };
  const idsOf = (x: unknown): string[] => {
    const arr = Array.isArray(x) ? x : ((x as { items?: unknown[]; entries?: unknown[] }).items ?? (x as { entries?: unknown[] }).entries ?? []);
    return (arr as { id: string }[]).map((y) => y.id);
  };
  async function statements(c: Client, url: string): Promise<number> {
    await c('GET', url);
    counted.delete(`/api${url}`);
    await c('GET', url);
    return counted.get(`/api${url}`) ?? -1;
  }

  it('list an item shared with the reader, and not without the share', async () => {
    for (const [kind, url] of Object.entries(LIST)) expect(idsOf(await vic('GET', url)), kind).not.toContain(ids[kind as keyof typeof ids].owned);
    for (const kind of Object.keys(LIST)) await share(kind, ids[kind as keyof typeof ids].owned, [{ subject: 'user:vic', level: 'view' }]);
    try {
      for (const [kind, url] of Object.entries(LIST)) expect(idsOf(await vic('GET', url)), kind).toContain(ids[kind as keyof typeof ids].owned);
    } finally {
      for (const kind of Object.keys(LIST)) await share(kind, ids[kind as keyof typeof ids].owned, []);
    }
  });

  it('read shares in bulk: the statements stay the same when the items a reader sees are shared and Restricted', async () => {
    // the same items, seen by role and then through a share on a Restricted item (operators read credentials)
    const reader = (kind: string) => (kind === 'credential' ? otto : vic);
    const subject = (kind: string) => (kind === 'credential' ? 'user:otto' : 'user:vic');
    const before: Record<string, number> = {};
    for (const [kind, url] of Object.entries(LIST)) before[kind] = await statements(reader(kind), url);
    for (const kind of Object.keys(LIST)) {
      const id = ids[kind as keyof typeof ids].open;
      await share(kind, id, [{ subject: subject(kind), level: 'view' }]);
      await s.api('PUT', `/access/${kind}/${id}/scope`, { restricted: true });
    }
    try {
      for (const [kind, url] of Object.entries(LIST)) {
        expect(idsOf(await reader(kind)('GET', url)), kind).toContain(ids[kind as keyof typeof ids].open);
        expect(await statements(reader(kind), url), kind).toBe(before[kind]);
      }
    } finally {
      for (const kind of Object.keys(LIST)) {
        const id = ids[kind as keyof typeof ids].open;
        await share(kind, id, []);
        await s.api('PUT', `/access/${kind}/${id}/scope`, { restricted: false });
      }
    }
  });
});
