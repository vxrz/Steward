import { beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Findings of the security review of 0.21.0 (#296) – each test fails on the code before its fix:
 * - a team that takes the name of a deleted team does not inherit the deleted team's shares and module grants;
 * - a Restricted service is published on a status page and planned for maintenance only by who may change it;
 * - a price book names only a supplier the reader may see, and accepts only one its author may see.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let vic: Client; // viewer, outside every team
let dana: Client; // designer, outside every team

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code ?? 'error',
  );
const ids = (x: { id: string }[]) => x.map((y) => y.id);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const users = await import('../src/auth/users.js');
  for (const [username, roles] of [
    ['vic', ['viewer']],
    ['dana', ['designer']],
  ] as [string, Role[]][])
    users.createUser({ username, roles, password: PW, mustChangePassword: false });
  [vic, dana] = await Promise.all(['vic', 'dana'].map((u) => s.as(u, PW)));
});

describe('a team that takes the name of a deleted team', () => {
  it('inherits none of its shares or module grants – created or renamed to it', async () => {
    const svc = (await s.api('POST', '/services', { name: 'Invented payroll ledger', owners: [] })).id as string;
    await s.api('PUT', `/access/service/${svc}/scope`, { restricted: true });
    const old = await s.api('POST', '/teams', { name: 'Invented treasury', members: [] });
    await s.api('PUT', `/access/service/${svc}/shares`, { shares: [{ subject: 'team:invented treasury', level: 'edit' }] });
    await s.api('PUT', '/settings/modules/costs/access', { mode: 'selected', grants: [{ subject: 'team:invented treasury' }] });
    try {
      await s.api('DELETE', `/teams/${old.id}`);
      // the deleted team's entries stay and match nobody (ADR 0033, 0034)
      expect((await s.api('GET', `/access/service/${svc}/shares`)).shares).toEqual([
        expect.objectContaining({ subject: 'team:invented treasury', known: false }),
      ]);
      // a new team of that name, with Vic: he gains nothing that nobody granted him
      const fresh = await s.api('POST', '/teams', { name: 'Invented Treasury', members: ['vic'] });
      expect(await code(vic('GET', `/services/${svc}`))).toBe('SERVICE_NOT_FOUND');
      expect(ids(await vic('GET', '/services'))).not.toContain(svc);
      expect(await code(vic('GET', '/costs/price-books'))).toBe('MODULE_NO_ACCESS');
      expect((await s.api('GET', `/access/service/${svc}/shares`)).shares).toEqual([]);
      expect((await s.api('GET', '/settings/modules/costs/access')).grants).toEqual([]);
      const audit = (await s.api('GET', '/audit?action=access.share_removed')) as { entityId: string; details: { reason?: string } }[];
      expect(audit.some((e) => e.entityId === svc && e.details.reason === 'teamNameReused')).toBe(true);

      // renamed to the name of a deleted team: the same
      await s.api('PUT', `/access/service/${svc}/shares`, { shares: [{ subject: 'team:invented treasury', level: 'view' }] });
      await s.api('PUT', '/settings/modules/costs/access', { mode: 'selected', grants: [{ subject: 'team:invented treasury' }] });
      expect((await vic('GET', `/services/${svc}`)).id).toBe(svc);
      await s.api('DELETE', `/teams/${fresh.id}`);
      const other = await s.api('POST', '/teams', { name: 'Invented audit office', members: ['vic'] });
      await s.api('PUT', `/teams/${other.id}`, { name: 'Invented treasury', members: ['vic'] });
      expect(await code(vic('GET', `/services/${svc}`))).toBe('SERVICE_NOT_FOUND');
      expect(await code(vic('GET', '/costs/price-books'))).toBe('MODULE_NO_ACCESS');
      await s.api('DELETE', `/teams/${other.id}`);
    } finally {
      await s.api('PUT', '/settings/modules/costs/access', { mode: 'everyone', grants: [] });
    }
  });

  it('keeps the entries while a team of that name exists (they are not stale)', async () => {
    const t = await s.api('POST', '/teams', { name: 'Invented logistics', members: ['vic'] });
    const svc = (await s.api('POST', '/services', { name: 'Invented freight desk', owners: [] })).id as string;
    await s.api('PUT', `/access/service/${svc}/scope`, { restricted: true });
    await s.api('PUT', `/access/service/${svc}/shares`, { shares: [{ subject: 'team:invented logistics', level: 'view' }] });
    // saving the team under its own name changes nothing
    await s.api('PUT', `/teams/${t.id}`, { name: 'Invented Logistics', members: ['vic'] });
    expect((await vic('GET', `/services/${svc}`)).id).toBe(svc);
    expect((await s.api('GET', `/access/service/${svc}/shares`)).shares).toHaveLength(1);
  });
});

describe('a Restricted service', () => {
  let svc = '';
  beforeAll(async () => {
    svc = (await s.api('POST', '/services', { name: 'Invented board reporting', owners: [] })).id;
    await s.api('PUT', `/access/service/${svc}/scope`, { restricted: true });
  });

  it('is published on a status page only by who may change it', async () => {
    // Dana (a designer outside it) may set up status pages, but not publish what she may not see
    expect(await code(dana('POST', '/status-pages', { title: 'Invented page', serviceIds: [svc] }))).toBe('SERVICE_NOT_FOUND');
    // a View share lets her see it, not publish it
    await s.api('PUT', `/access/service/${svc}/shares`, { shares: [{ subject: 'user:dana', level: 'view' }] });
    expect(await code(dana('POST', '/status-pages', { title: 'Invented page', serviceIds: [svc] }))).toBe('SERVICE_NOT_FOUND');
    await s.api('PUT', `/access/service/${svc}/shares`, { shares: [{ subject: 'user:dana', level: 'edit' }] });
    expect(await code(dana('POST', '/status-pages', { title: 'Invented page', serviceIds: [svc] }))).toBe('ok');
  });

  it('gets maintenance windows only from who may change it', async () => {
    await s.api('PUT', `/access/service/${svc}/shares`, { shares: [{ subject: 'user:dana', level: 'view' }] });
    const now = Date.now();
    const window = {
      title: 'Invented patch night',
      startsAt: new Date(now + 3_600_000).toISOString(),
      endsAt: new Date(now + 7_200_000).toISOString(),
      targets: [{ kind: 'service', id: svc }],
    };
    expect(await code(dana('POST', '/maintenance-windows', window))).toBe('FORBIDDEN');
    await s.api('PUT', `/access/service/${svc}/shares`, { shares: [{ subject: 'user:dana', level: 'edit' }] });
    expect(await code(dana('POST', '/maintenance-windows', window))).toBe('ok');
  });
});

describe('a price book that names a supplier', () => {
  it('names it only to who may see the supplier, and takes only one its author may see', async () => {
    const sup = (await s.api('POST', '/suppliers', { name: 'Invented Clearing AG', type: 'saas' })).id as string;
    await s.api('PUT', `/access/supplier/${sup}/scope`, { restricted: true });
    // Dana (a costs manager) may not probe for it or name it
    expect(await code(dana('POST', '/costs/price-books', { name: 'Invented rates', kind: 'list', provider: 'Invented', currency: 'EUR', supplierId: sup }))).toBe(
      'SUPPLIER_NOT_FOUND',
    );
    const book = await s.api('POST', '/costs/price-books', { name: 'Invented clearing rates', kind: 'list', provider: 'Invented', currency: 'EUR', supplierId: sup });
    expect(book.supplier).toEqual({ id: sup, name: 'Invented Clearing AG' });
    // a list book: every reader of the Costs module sees it – not the supplier it names
    for (const c of [vic, dana]) {
      const listed = ((await c('GET', '/costs/price-books')) as { id: string; supplier: unknown }[]).find((b) => b.id === book.id);
      expect(listed?.supplier).toBeNull();
      expect((await c('GET', `/costs/price-books/${book.id}`)).supplier).toBeNull();
    }
    // Dana edits the book (the form sends no supplier): the supplier she may not see stays
    await dana('PUT', `/costs/price-books/${book.id}`, { name: 'Invented clearing rates 2027', kind: 'list', provider: 'Invented', currency: 'EUR' });
    expect((await s.api('GET', `/costs/price-books/${book.id}`)).supplier).toEqual({ id: sup, name: 'Invented Clearing AG' });
  });
});

describe('changing who uses a module', () => {
  it('asks for the step-up in the service too, not only in the route (a path without the route rule never widens)', async () => {
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const { setModuleAccess } = await import('../src/modules/access-change.js');
    const admin = toAuthUser(findUserByName('admin')!);
    runAs(admin, () => setModuleAccess('costs', { mode: 'selected', grants: [] }));
    try {
      // opening it again, without a confirmation in this request
      expect(() => runAs(admin, () => setModuleAccess('costs', { mode: 'everyone', grants: [] }))).toThrow(/confirm|step|session/i);
      expect((await s.api('GET', '/settings/modules/costs/access')).mode).toBe('selected');
    } finally {
      await s.api('PUT', '/settings/modules/costs/access', { mode: 'everyone', grants: [] });
    }
  });
});
