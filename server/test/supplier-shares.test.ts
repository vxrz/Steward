import { beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@sm/shared';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Shares on suppliers (ADR 0033 phase 1, #292): a share opens the company record of a supplier – read-only or to
 * change it – but its team-owned contracts and scoped contacts keep their own rules (ADR 0031): a share on the
 * supplier does not open them. Owners are an implied Edit share; the merge preview names the shares of the result
 * that would show a source to someone who did not see it, and such a merge asks for the step-up.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let vic: Client; // viewer outside every team
let otto: Client; // operator outside every team
let dana: Client; // designer in Orders
let pat: Client; // viewer in Payments
let orders = '';
let sup = '';
let teamContract = '';
let openContract = '';
const counted = new Map<string, number>();

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string; params?: { context?: string } } }) => [e.body?.code, e.body?.params?.context].filter(Boolean).join(':') || 'error',
  );
const ids = (x: { id: string }[]) => x.map((y) => y.id);
const shares = (id: string, list: unknown[]) => s.api('PUT', `/access/supplier/${id}/shares`, { shares: list });
type Detail = { id: string; canEdit: boolean; contracts: { id: string }[]; contacts: { name: string }[] };

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
  const users = await import('../src/auth/users.js');
  for (const [username, roles] of [
    ['vic', ['viewer']],
    ['otto', ['operator']],
    ['dana', ['designer']],
    ['pat', ['viewer']],
  ] as [string, Role[]][])
    users.createUser({ username, roles, password: PW, mustChangePassword: false });
  orders = (await s.api('POST', '/teams', { name: 'Orders', members: ['dana'] })).id;
  await s.api('POST', '/teams', { name: 'Payments', members: ['pat'] });
  sup = (await s.api('POST', '/suppliers', { name: 'Invented Hosting AG', type: 'saas' })).id;
  // a team-owned contract and one without a team among its owners (read by the supplier's readers, ADR 0031)
  const withTeam = (await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'Invented team contract', owners: ['team:orders'] })) as {
    contracts: { id: string; title: string }[];
  };
  teamContract = withTeam.contracts.find((c) => c.title === 'Invented team contract')!.id;
  const open = (await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'Invented open contract', owners: ['user:admin'] })) as {
    contracts: { id: string; title: string }[];
  };
  openContract = open.contracts.find((c) => c.title === 'Invented open contract')!.id;
  await s.api('POST', `/suppliers/${sup}/contacts`, { name: 'Invented desk', email: 'desk@hosting.example' });
  await s.api('POST', `/suppliers/${sup}/contacts`, { name: 'Invented account manager', scope: [{ kind: 'contract', id: teamContract }] });
  await s.api('PUT', `/owning-teams/supplier/${sup}`, { teamIds: [orders] });
  [vic, otto, dana, pat] = await Promise.all(['vic', 'otto', 'dana', 'pat'].map((u) => s.as(u, PW)));
});

describe('a share of a supplier', () => {
  it('opens the company record read-only, on the list, the page, the public API and MCP', async () => {
    expect(await status(vic('GET', `/suppliers/${sup}`))).toBe(404);
    await shares(sup, [{ subject: 'user:vic', level: 'view' }]);
    const d = (await vic('GET', `/suppliers/${sup}`)) as Detail;
    expect(d.canEdit).toBe(false);
    expect(ids(await vic('GET', '/suppliers'))).toContain(sup);
    expect(await code(vic('PUT', `/suppliers/${sup}`, { name: 'Changed', type: 'saas' }))).toBe('FORBIDDEN:changeSupplier');
    const why = await vic('GET', `/access/explain?kind=supplier&id=${sup}`);
    expect(why.reasons).toEqual([expect.objectContaining({ source: 'share', subject: 'user:vic', level: 'view' })]);
    const token = (await vic('POST', '/me/tokens', { name: 'Invented vic token', scope: 'read' })).token as string;
    const v1 = await fetch(`${s.base}/api/v1/suppliers/${sup}`, { headers: { authorization: `Bearer ${token}` } });
    expect(v1.status).toBe(200);
  });

  it('does not open its team-owned contracts or the contacts scoped to them (ADR 0031)', async () => {
    const d = (await vic('GET', `/suppliers/${sup}`)) as Detail;
    expect(ids(d.contracts)).toEqual([openContract]);
    expect(await status(vic('GET', `/suppliers/${sup}/contracts/${teamContract}`))).toBe(404);
    expect(d.contacts.map((c) => c.name)).toEqual(['Invented desk']);
    // an Edit share changes the company record – still not the team's contract
    await shares(sup, [
      { subject: 'user:vic', level: 'view' },
      { subject: 'user:otto', level: 'edit' },
    ]);
    const o = (await otto('GET', `/suppliers/${sup}`)) as Detail;
    expect(o.canEdit).toBe(true);
    expect(ids(o.contracts)).toEqual([openContract]);
    expect(await status(otto('GET', `/suppliers/${sup}/contracts/${teamContract}`))).toBe(404);
    // the team's members still read it
    expect(ids(((await dana('GET', `/suppliers/${sup}`)) as Detail).contracts).sort()).toEqual([openContract, teamContract].sort());
  });

  it('owners are an implied Edit share; naming one from outside needs Manage and asks for the step-up', async () => {
    expect(await code(otto('PUT', `/suppliers/${sup}`, { name: 'Invented Hosting AG', type: 'saas', owners: ['user:pat'] }))).toBe('FORBIDDEN:nameOutside');
    const unconfirmed = await s.as('dana', PW, { autoStepUp: false });
    await unconfirmed('DELETE', '/auth/step-up');
    expect(await code(unconfirmed('PUT', `/suppliers/${sup}`, { name: 'Invented Hosting AG', type: 'saas', owners: ['user:pat'] }))).toBe(
      'STEP_UP_REQUIRED:password',
    );
    await dana('PUT', `/suppliers/${sup}`, { name: 'Invented Hosting AG', type: 'saas', owners: ['user:pat'] });
    expect((await s.api('GET', `/access/supplier/${sup}/shares`)).implied).toEqual([{ subject: 'user:pat', level: 'edit', as: 'owner', outside: true }]);
    expect(((await pat('GET', `/suppliers/${sup}`)) as Detail).canEdit).toBe(true);
    await dana('PUT', `/suppliers/${sup}`, { name: 'Invented Hosting AG', type: 'saas', owners: [] });
    expect(await status(pat('GET', `/suppliers/${sup}`))).toBe(404);
  });
});

describe('merging suppliers', () => {
  let a = '';
  let b = '';
  let aContract = '';
  beforeAll(async () => {
    a = (await s.api('POST', '/suppliers', { name: 'Invented Mail GmbH', type: 'saas' })).id;
    b = (await s.api('POST', '/suppliers', { name: 'Invented Mail AG', type: 'saas' })).id;
    const made = (await s.api('POST', `/suppliers/${a}/contracts`, { title: 'Invented mail contract', owners: ['user:dana'] })) as {
      contracts: { id: string; title: string }[];
    };
    aContract = made.contracts.find((c) => c.title === 'Invented mail contract')!.id;
    for (const id of [a, b]) await s.api('PUT', `/owning-teams/supplier/${id}`, { teamIds: [orders] });
    // the result is shared with Payments: merging A into it shows A to Pat
    await shares(b, [{ subject: 'team:payments', level: 'view' }]);
  });

  it('the preview names the shares that widen who sees a source, and its contracts keep the source’s team', async () => {
    const p = await s.api('POST', '/suppliers/merge/preview', { intoId: b, ids: [a] });
    expect(p.widens).toBe(true);
    expect(p.gainers).toContain('pat');
    expect(p.shares).toEqual([{ subject: 'team:payments', level: 'view', supplierIds: [a] }]);
    // a contract without a team owner gets the source's teams: the share does not open it
    expect(p.contracts.find((c: { id: string }) => c.id === aContract).ownersAfter).toEqual(['user:dana', 'team:orders']);
  });

  it('is for administrators and asks for the step-up', async () => {
    expect(await code(dana('POST', '/suppliers/merge', { intoId: b, ids: [a] }))).toBe('FORBIDDEN:mergeWidening');
    const admin = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    await admin('DELETE', '/auth/step-up');
    expect(await code(admin('POST', '/suppliers/merge', { intoId: b, ids: [a] }))).toBe('STEP_UP_REQUIRED:password');
    await s.api('POST', '/suppliers/merge', { intoId: b, ids: [a] });
    const seen = (await pat('GET', `/suppliers/${b}`)) as Detail;
    expect(ids(seen.contracts)).not.toContain(aContract);
    // the source's shares and scope go with it
    expect(await status(s.api('GET', `/access/supplier/${a}/shares`))).toBe(404);
  });
});

describe('the supplier list reads shares in bulk', () => {
  it('its statements stay the same when the suppliers it shows are shared and Restricted', async () => {
    const statements = async () => {
      await vic('GET', '/suppliers');
      counted.delete('/api/suppliers');
      await vic('GET', '/suppliers');
      return counted.get('/api/suppliers') ?? -1;
    };
    const made: string[] = [];
    for (let i = 0; i < 6; i++) made.push((await s.api('POST', '/suppliers', { name: `Invented counted supplier ${i}`, type: 'saas' })).id);
    const open = await statements();
    for (const [i, id] of made.entries()) {
      await shares(id, [{ subject: 'user:vic', level: 'view' }]);
      if (i % 2) await s.api('PUT', `/access/supplier/${id}/scope`, { restricted: true });
    }
    expect(await statements()).toBe(open);
    expect(ids(await vic('GET', '/suppliers'))).toEqual(expect.arrayContaining(made));
  });
});
