import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Free-text vendors become suppliers (0.17.0, ADR 0029): each distinct normalised text (letters and digits, legal
 * forms left out) of applications, systems, ticket references, page watches and cost plan lines becomes one supplier
 * waiting for confirmation, with the spellings as aliases; the rows are linked and the text is kept; each text is
 * handled once (supplier_text_migrations). People then confirm, merge or mark "not a supplier" – a text marked so is not
 * made a supplier again. The v0.16.0 upgrade fixture is covered in upgrade.test.ts.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client;
const refused = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status: number; body: any }) => ({ status: e.status, code: (typeof e.body === 'string' ? JSON.parse(e.body) : e.body)?.code }),
  );

const ids: Record<string, string> = {};
let migrate: () => number;
let db: () => import('../src/db.js').Db;

const supplierOf = (table: string, where: string, ...args: unknown[]) =>
  db().get<{ supplier_id: string | null; vendor: string }>(`SELECT supplier_id, vendor FROM ${table} WHERE ${where}`, ...args)!;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia] = await Promise.all(['dana', 'olivia'].map((u) => s.as(u, PW)));
  ({ migrateVendorTexts: migrate } = await import('../src/suppliers/migrate.js'));
  ({ db } = await import('../src/db.js'));
  // a confirmed supplier exists already: the text "Paylumen AG" links to it
  ids.paylumen = (await dana('POST', '/suppliers', { name: 'Paylumen', type: 'saas' })).id;
  // free texts as before 0.17: the API still takes them (no supplierId)
  ids.app1 = (await dana('POST', '/applications', { name: 'Mig app 1', vendor: 'Zentrova Cloud GmbH' })).id;
  ids.app2 = (await dana('POST', '/applications', { name: 'Mig app 2', vendor: 'zentrova  cloud' })).id;
  ids.app3 = (await dana('POST', '/applications', { name: 'Mig app 3', vendor: 'GmbH' })).id;
  ids.sys1 = (await dana('POST', '/systems', { name: 'mig-host-1', kind: 'vm', vendor: 'On-premises' })).id;
  ids.sys2 = (await dana('POST', '/systems', { name: 'mig-host-2', kind: 'vm', vendor: 'Zentrova-Cloud' })).id;
  ids.ticket = (await dana('POST', '/ticket-references', { source: 'vendor', externalNumber: 'MIG-1', title: 'x', vendor: 'Mailbrook Ltd.' })).id;
  ids.ticket2 = (await dana('POST', '/ticket-references', { source: 'vendor', externalNumber: 'MIG-2', title: 'y', vendor: 'Paylumen AG' })).id;
  const service = (await dana('POST', '/services', { name: 'Mig service', owners: [] })).id;
  const y = await dana('POST', `/costs/plans/${service}/lines`, {
    fiscalYear: new Date().getFullYear(),
    title: 'Mail',
    category: 'licence',
    amount: '100',
    currency: 'EUR',
    cadence: 'yearly',
    vendor: 'Mailbrook',
  });
  ids.line = y.lines.find((l: any) => l.title === 'Mail').id;
  // a page watch of a changedetection.io platform, as the watches are read
  db().run(
    `INSERT INTO cd_watches (platform_id, uuid, title, url, seen_at, vendor) VALUES ('pf_mig', '00000000-0000-4000-8000-000000000001', 'Pricing', 'https://zentrova.example/pricing', 'now', 'ZENTROVA CLOUD')`,
  );
});

describe('migrateVendorTexts', () => {
  it('makes one unconfirmed supplier per normalised text with the spellings, links the rows and keeps the text', () => {
    const made = migrate();
    // Zentrova Cloud, On-premises, Mailbrook (the demo's page watches name two of them too) – Paylumen exists already,
    // "GmbH" names nobody
    expect(made).toBe(3);
    const byNorm = (norm: string) =>
      db().get<{ id: string; name: string; status: string; aliases: string }>('SELECT id, name, status, aliases FROM suppliers WHERE norm_name = ?', norm)!;
    const zentrova = byNorm('zentrovacloud');
    expect(zentrova).toMatchObject({ name: 'Zentrova Cloud', status: 'unconfirmed' });
    // the most frequent spelling is the name (the demo's two watches), the others are aliases
    expect(JSON.parse(zentrova.aliases).sort()).toEqual(['ZENTROVA CLOUD', 'Zentrova Cloud GmbH', 'Zentrova-Cloud', 'zentrova cloud']);
    expect(byNorm('onpremises')).toMatchObject({ name: 'On-premises', status: 'unconfirmed' });
    expect(byNorm('mailbrook')).toMatchObject({ status: 'unconfirmed' });
    ids.zentrova = zentrova.id;
    ids.onprem = byNorm('onpremises').id;
    ids.mailbrook = byNorm('mailbrook').id;
    expect(supplierOf('applications', 'id = ?', ids.app1)).toEqual({ supplier_id: ids.zentrova, vendor: 'Zentrova Cloud GmbH' });
    expect(supplierOf('applications', 'id = ?', ids.app2).supplier_id).toBe(ids.zentrova);
    expect(supplierOf('systems', 'id = ?', ids.sys2).supplier_id).toBe(ids.zentrova);
    expect(supplierOf('cd_watches', "platform_id = 'pf_mig'").supplier_id).toBe(ids.zentrova);
    expect(supplierOf('ticket_refs', 'id = ?', ids.ticket).supplier_id).toBe(ids.mailbrook);
    expect(supplierOf('cost_plan_lines', 'id = ?', ids.line).supplier_id).toBe(ids.mailbrook);
    // an existing supplier: linked, the spelling joins its aliases, it stays confirmed
    expect(supplierOf('ticket_refs', 'id = ?', ids.ticket2).supplier_id).toBe(ids.paylumen);
    expect(db().get<{ status: string; aliases: string }>('SELECT status, aliases FROM suppliers WHERE id = ?', ids.paylumen)).toEqual({
      status: 'active',
      aliases: JSON.stringify(['Paylumen AG']),
    });
    // a text without letters or digits besides legal forms stays text
    expect(supplierOf('applications', 'id = ?', ids.app3)).toEqual({ supplier_id: null, vendor: 'GmbH' });
    // every text is recorded per table with its outcome
    const handled = db().all<{ table_name: string; norm_text: string; outcome: string; rows_linked: number }>(
      'SELECT table_name, norm_text, outcome, rows_linked FROM supplier_text_migrations ORDER BY table_name, norm_text',
    );
    expect(handled.map((h) => ({ ...h, rows_linked: Number(h.rows_linked) }))).toEqual(
      expect.arrayContaining([
        { table_name: 'applications', norm_text: '', outcome: 'ignored', rows_linked: 0 },
        { table_name: 'applications', norm_text: 'zentrovacloud', outcome: 'linked', rows_linked: 2 },
        // two watches of the demo and one of this test
        { table_name: 'cd_watches', norm_text: 'zentrovacloud', outcome: 'linked', rows_linked: 3 },
        { table_name: 'systems', norm_text: 'onpremises', outcome: 'linked', rows_linked: 1 },
        { table_name: 'ticket_refs', norm_text: 'paylumen', outcome: 'linked', rows_linked: 1 },
        { table_name: 'cost_plan_lines', norm_text: 'mailbrook', outcome: 'linked', rows_linked: 1 },
      ]),
    );
  });

  it('handles a text once: a second run changes nothing', async () => {
    const before = (await s.api('GET', '/audit?action=supplier.migrated&limit=100')).length;
    expect(before).toBeGreaterThanOrEqual(7);
    expect(migrate()).toBe(0);
    expect((await s.api('GET', '/audit?action=supplier.migrated&limit=100')).length).toBe(before);
    // a system with a text handled before (cleared by hand) is left alone: the text was handled once
    db().run('UPDATE systems SET supplier_id = NULL WHERE id = ?', ids.sys2);
    expect(migrate()).toBe(0);
    expect(supplierOf('systems', 'id = ?', ids.sys2).supplier_id).toBeNull();
  });

  it('lists the unconfirmed suppliers to confirm', async () => {
    const list = await olivia('GET', '/suppliers?status=unconfirmed');
    expect(list.map((x: any) => x.id)).toEqual(expect.arrayContaining([ids.mailbrook, ids.onprem, ids.zentrova]));
    const z = list.find((x: any) => x.id === ids.zentrova);
    expect(z.usage).toMatchObject({ application: 2 });
    const d = await olivia('GET', `/suppliers/${ids.zentrova}`);
    expect(d.migratedFrom).toEqual(
      expect.arrayContaining([
        { table: 'applications', spellings: ['Zentrova Cloud GmbH', 'zentrova cloud'] },
        { table: 'cd_watches', spellings: ['ZENTROVA CLOUD', 'Zentrova Cloud'] },
      ]),
    );
    expect(d.canManage).toBe(false);
  });

  it('confirms a supplier (designers and administrators, in a session)', async () => {
    expect((await refused(olivia('POST', `/suppliers/${ids.zentrova}/confirm`)))?.status).toBe(403);
    expect(await dana('POST', `/suppliers/${ids.zentrova}/confirm`)).toMatchObject({ status: 'active' });
    expect(await refused(dana('POST', `/suppliers/${ids.zentrova}/confirm`))).toEqual({ status: 409, code: 'SUPPLIER_NOT_UNCONFIRMED' });
    // an API token may not take the decision
    const token = (await dana('POST', '/me/tokens', { name: 'mig', scope: 'full' })).token;
    const res = await fetch(`${s.base}/api/suppliers/${ids.mailbrook}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-sm-client': '1' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect((await dana('GET', `/suppliers/${ids.mailbrook}`)).status).toBe('unconfirmed');
  });

  it('merges a supplier into another: the links and spellings move', async () => {
    expect(await refused(dana('POST', `/suppliers/${ids.mailbrook}/merge`, { into: ids.mailbrook }))).toEqual({ status: 400, code: 'SUPPLIER_MERGE_SELF' });
    const merged = await dana('POST', `/suppliers/${ids.mailbrook}/merge`, { into: ids.paylumen });
    expect(merged.id).toBe(ids.paylumen);
    expect(merged.aliases).toEqual(expect.arrayContaining(['Mailbrook Ltd.', 'Paylumen AG']));
    expect(supplierOf('ticket_refs', 'id = ?', ids.ticket).supplier_id).toBe(ids.paylumen);
    expect(supplierOf('cost_plan_lines', 'id = ?', ids.line).supplier_id).toBe(ids.paylumen);
    expect(db().get('SELECT 1 FROM suppliers WHERE id = ?', ids.mailbrook)).toBeUndefined();
    expect(
      db().get<{ supplier_id: string }>("SELECT supplier_id FROM supplier_text_migrations WHERE table_name = 'cost_plan_lines' AND norm_text = 'mailbrook'")!
        .supplier_id,
    ).toBe(ids.paylumen);
    const audit = await s.api('GET', `/audit?action=supplier.merged&entityId=${ids.paylumen}&limit=5`);
    expect(audit[0].details).toMatchObject({ from: { id: ids.mailbrook }, links: { ticket_refs: 1, cost_plan_lines: 1 } });
  });

  it('marks a text as not a supplier: the links go, the text stays, and it is not made a supplier again', async () => {
    const r = await dana('POST', `/suppliers/${ids.onprem}/not-a-supplier`);
    expect(r).toEqual({ ok: true, unlinked: { systems: 1 } });
    expect(supplierOf('systems', 'id = ?', ids.sys1)).toEqual({ supplier_id: null, vendor: 'On-premises' });
    expect(db().get('SELECT 1 FROM suppliers WHERE id = ?', ids.onprem)).toBeUndefined();
    expect(
      db().get<{ outcome: string }>("SELECT outcome FROM supplier_text_migrations WHERE table_name = 'systems' AND norm_text = 'onpremises'")!.outcome,
    ).toBe('notSupplier');
    // the same text in another table later: still not a supplier
    await dana('POST', '/applications', { name: 'Mig app 4', vendor: 'on premises' });
    expect(migrate()).toBe(0);
    expect(
      db().get<{ outcome: string }>("SELECT outcome FROM supplier_text_migrations WHERE table_name = 'applications' AND norm_text = 'onpremises'")!.outcome,
    ).toBe('notSupplier');
    // only an unconfirmed supplier can be dismissed
    expect(await refused(dana('POST', `/suppliers/${ids.paylumen}/not-a-supplier`))).toEqual({ status: 409, code: 'SUPPLIER_NOT_UNCONFIRMED' });
    expect((await s.api('GET', '/audit?action=supplier.dismissed&limit=5'))[0]).toMatchObject({ entityId: ids.onprem });
  });

  it('a new text after the update becomes a supplier to confirm at the next run', async () => {
    await dana('POST', '/applications', { name: 'Mig app 5', vendor: 'Brightfield Industrial Software' });
    expect(migrate()).toBe(1);
    expect((await dana('GET', '/suppliers?status=unconfirmed')).map((x: any) => x.name)).toContain('Brightfield Industrial Software');
  });
});
