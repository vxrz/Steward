import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The upgrade to the contacts directory (0.25.1, ADR 0038 part 1): the contacts services, suppliers and plant sites
 * kept themselves (the shape of 0.25.0 and before) become directory contacts and links when the vault is opened.
 *
 * The newest upgrade fixture (server/test/fixtures/upgrade/v0.24.0) gets contacts of every kind written into its
 * database in the old shape – a service of a team and one of the whole instance, a supplier with company-wide and
 * scoped contacts and one of a team, a site with free-text roles, empty roles and contacts without an e-mail address,
 * and one of a team. Then the server upgrades it, and for every user:
 * - each service, supplier and plant site shows exactly the contacts it stored, through its read paths (the web app's
 *   API, /api/v1, the plant registry's YAML export);
 * - nobody sees a contact they could not see before: every directory contact a user may see is a person they saw on
 *   an item before, with the same details, and the contacts of items they could not see are unknown to them (404).
 * The conversion runs once: unlocking again (a restart) changes nothing. SQLite only (the fixture's database);
 * contacts.test.ts converts stored contacts on PostgreSQL too.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

/** The fixture is a SQLite database: on PostgreSQL, contacts.test.ts converts stored contacts on the running server */
const PG = !!process.env.SM_TEST_DATABASE_URL;
const FIXTURE = path.join(__dirname, 'fixtures', 'upgrade', 'v0.24.0');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8')) as {
  passphrase: string;
  admin: { username: string; password: string };
  demoPassword: string;
  ids: { service: string };
};
const AT = '2026-11-01T10:00:00.000Z';
const USERS = ['admin', 'dana', 'olivia', 'adam', 'audrey', 'vera'] as const;
type User = (typeof USERS)[number];

/** Stored before 0.25.1 */
const SERVICES = {
  svc_upg_team: [
    { role: 'business', email: 'ann@invented.example', name: 'Ann Invented' },
    { role: 'it', email: 'ops@invented.example' },
  ],
  svc_upg_open: [
    { role: 'it', email: 'ann@invented.example', name: 'Ann Invented' },
    { role: 'business', email: 'ANN@invented.example', name: 'Ann Other' },
  ],
} as const;
interface SupplierEntry {
  id: string;
  supplier: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  note: string;
  scope?: { kind: string; id: string };
}
const SUPPLIER_CONTACTS: SupplierEntry[] = [
  { id: 'spc_upg_sam', supplier: 'sup_upg_open', name: 'Sam Invented', role: 'accountManager', email: 'sam@invented.example', phone: '+49 30 1', note: '' },
  {
    id: 'spc_upg_sue',
    supplier: 'sup_upg_open',
    name: 'Sue Invented',
    role: 'support',
    email: 'sue@invented.example',
    phone: '+49 30 2',
    note: 'For the team app',
    scope: { kind: 'application', id: 'app_upg_team' },
  },
  { id: 'spc_upg_desk', supplier: 'sup_upg_open', name: 'Invented desk', role: 'other', email: '', phone: '', note: 'Front desk' },
  { id: 'spc_upg_sam2', supplier: 'sup_upg_team', name: 'Sam Invented', role: 'support', email: 'sam@invented.example', phone: '+49 30 1', note: '' },
  { id: 'spc_upg_tom', supplier: 'sup_upg_team', name: 'Tom Secret', role: 'security', email: 'tom@invented.example', phone: '+49 30 9', note: '' },
];
const SITES = {
  'upg-open': [{ name: 'Ann Invented', role: 'Shift lead', email: 'ann@invented.example', phone: '+49 30 3', url: '' }],
  'upg-team': [
    { name: 'Pat Plant', role: '', email: '', phone: '', url: 'https://pat.invented.example' },
    {
      name: 'Pat Plant',
      role: 'Backup (nights and weekends, call the gate first if the line is busy)',
      email: '',
      phone: '',
      url: 'https://pat.invented.example',
    },
    { name: 'Pia Secret', role: 'Energy', email: 'pia.secret@invented.example', phone: '+49 30 8', url: '' },
  ],
} as const;

let s: TestServer;
const as: Partial<Record<User, Client>> = {};
const tokens: Partial<Record<User, string>> = {};

/** What a user saw of contacts before, as persons: name, e-mail (lower case), phone, URL ('' where the kind had none). */
const seen = new Map<User, Set<string>>();
const person = (name: string, email: string, phone = '', url = '') => [name, email.toLowerCase(), phone, url].join('|');

async function v1(u: User, url: string): Promise<any> {
  const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${tokens[u]}` } });
  if (!res.ok) throw Object.assign(new Error(`${url}: ${res.status}`), { status: res.status });
  return res.json();
}
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );

beforeAll(async () => {
  if (PG) return;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-contacts-upg-'));
  fs.cpSync(path.join(FIXTURE, 'datadir'), dataDir, { recursive: true });
  // the old database as the released version left it (node:sqlite: the server's configuration is not loaded yet)
  const file = new DatabaseSync(path.join(dataDir, 'service-manager.db'));
  const old = { run: (sql: string, ...args: (string | number | null)[]) => file.prepare(sql).run(...args) };
  try {
    const team = (file.prepare("SELECT id FROM teams WHERE name = 'Service Desk'").get() as { id: string }).id;
    const own = (kind: string, id: string) =>
      old.run('INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES (?, ?, ?, ?)', kind, id, team, AT);
    for (const [id, contacts] of Object.entries(SERVICES))
      old.run(
        `INSERT INTO services (id, name, description, contacts, owners, created_at, created_by, updated_at, updated_by) VALUES (?, ?, '', ?, '[]', ?, 'admin', ?, 'admin')`,
        id,
        `Invented ${id}`,
        JSON.stringify(contacts),
        AT,
        AT,
      );
    own('service', 'svc_upg_team');
    old.run(
      `INSERT INTO applications (id, name, owners, created_at, created_by, updated_at, updated_by) VALUES ('app_upg_team', 'Invented team app', '[]', ?, 'admin', ?, 'admin')`,
      AT,
      AT,
    );
    own('application', 'app_upg_team');
    for (const [id, name] of [
      ['sup_upg_open', 'Invented Open AG'],
      ['sup_upg_team', 'Invented Team GmbH'],
    ])
      old.run(
        `INSERT INTO suppliers (id, name, norm_name, owners, status, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, '[]', 'active', ?, 'admin', ?, 'admin')`,
        id,
        name,
        name.toLowerCase().replace(/[^a-z0-9]/g, ''),
        AT,
        AT,
      );
    own('supplier', 'sup_upg_team');
    for (const c of SUPPLIER_CONTACTS) {
      old.run(
        'INSERT INTO supplier_contacts (id, supplier_id, name, role, email, phone, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        c.id,
        c.supplier,
        c.name,
        c.role,
        c.email,
        c.phone,
        c.note,
        AT,
      );
      if (c.scope) old.run('INSERT INTO supplier_contact_scopes (contact_id, kind, item_id) VALUES (?, ?, ?)', c.id, c.scope.kind, c.scope.id);
    }
    for (const [id, contacts] of Object.entries(SITES))
      old.run(
        `INSERT INTO plant_sites (id, name, contacts, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, 'admin', ?, 'admin')`,
        id,
        `Invented site ${id}`,
        JSON.stringify(contacts),
        AT,
        AT,
      );
    own('site', 'upg-team');
  } finally {
    file.close();
  }
  s = await startTestServer({ dataDir });
  const admin = s.client();
  await admin('POST', '/auth/login', manifest.admin).catch((e) => {
    throw new Error(`login admin: ${e}`);
  });
  await admin('POST', '/vault/unlock', { passphrase: manifest.passphrase });
  as.admin = admin;
  await admin('PUT', '/settings/modules/plant', { enabled: true });
  for (const u of USERS.filter((x) => x !== 'admin'))
    as[u] = await s.as(u, manifest.demoPassword).catch((e) => {
      throw new Error(`login ${u}: ${e}`);
    });
  for (const u of USERS) tokens[u] = (await as[u]!('POST', '/me/tokens', { name: `Invented ${u} token`, scope: 'read' })).token;
}, 240_000);

describe.skipIf(PG)('the upgrade to the contacts directory', () => {
  it('made directory contacts – the same person once per kind, never merged across kinds or details', async () => {
    const db = (await import('../src/db.js')).db();
    // stored lists are emptied, the persons are in the directory
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM services WHERE contacts <> '[]'")!.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_sites WHERE contacts <> '[]'")!.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM supplier_contacts WHERE name <> '' OR email <> '' OR phone <> ''")!.n).toBe(0);
    const names = (kind: string) =>
      db
        .all<{ name: string }>(
          'SELECT DISTINCT c.id, c.name FROM contacts c JOIN contact_links l ON l.contact_id = c.id WHERE l.kind = ? ORDER BY c.name',
          kind,
        )
        .map((r) => r.name);
    // services: Ann (business of the team's, IT of the other) once; "Ann Other" with the same address apart; the fixture's Erika
    expect(names('service')).toEqual(['Ann Invented', 'Ann Other', 'Erika', 'ops@invented.example']);
    // suppliers: Sam once across both suppliers (same address, name and phone)
    expect(names('supplier')).toEqual(['Invented desk', 'Sam Invented', 'Sue Invented', 'Tom Secret']);
    // plant sites: Pat once within the site (no address: same name), Ann not merged with the services' Ann (her phone)
    expect(names('plant_site')).toEqual(['Ann Invented', 'Pat Plant', 'Pia Secret']);
    const entry = (await as.admin!('GET', '/audit?action=contact.created&limit=20')).filter((e: { actor: string }) => e.actor === 'system');
    expect(entry.map((e: { details: { kind: string } }) => e.details.kind).sort()).toEqual(['plant_site', 'service', 'supplier']);
  });

  it('shows every service, supplier and site with the contacts it stored, to everyone who sees it', async () => {
    for (const u of USERS) {
      const mine = new Set<string>();
      seen.set(u, mine);
      const c = as[u]!;
      // services: the list, the page, /api/v1
      const list = await c('GET', '/services');
      const v1list = (await v1(u, '/services')).items ?? (await v1(u, '/services'));
      for (const [id, stored] of Object.entries(SERVICES)) {
        const row = list.find((x: { id: string }) => x.id === id);
        expect(!!row, `${u} sees ${id}`).toBe(u !== 'dana' && u !== 'vera' ? true : id !== 'svc_upg_team');
        if (!row) {
          expect(await status(c('GET', `/services/${id}`))).toBe(404);
          continue;
        }
        expect(row.contacts, `${u} ${id}`).toEqual(stored);
        expect((await c('GET', `/services/${id}`)).contacts).toEqual(stored);
        expect(v1list.find((x: { id: string }) => x.id === id).contacts).toEqual(
          stored.map((x) => ({ role: x.role, email: x.email, name: 'name' in x ? x.name : null })),
        );
        for (const x of stored) mine.add(person('name' in x ? x.name : x.email, x.email));
      }
      const fixtureService = list.find((x: { id: string }) => x.id === manifest.ids.service);
      if (fixtureService) {
        expect(fixtureService.contacts).toEqual([{ role: 'business', email: 'erika@example.com', name: 'Erika' }]);
        mine.add(person('Erika', 'erika@example.com'));
      }
      // suppliers: the page (e-mail and phone), /api/v1 (name, role and note only)
      for (const sup of ['sup_upg_open', 'sup_upg_team']) {
        const sees = sup === 'sup_upg_open' || ['admin', 'olivia', 'adam', 'audrey'].includes(u);
        if (!sees) {
          expect(await status(c('GET', `/suppliers/${sup}`)), `${u} ${sup}`).toBe(404);
          continue;
        }
        const d = await c('GET', `/suppliers/${sup}`);
        const want = SUPPLIER_CONTACTS.filter((x) => x.supplier === sup && (!x.scope || ['admin', 'olivia', 'adam', 'audrey'].includes(u)));
        expect(
          d.contacts
            .map((x: SupplierEntry) => ({ id: x.id, name: x.name, role: x.role, email: x.email, phone: x.phone, note: x.note }))
            .sort((a: SupplierEntry, b: SupplierEntry) => a.id.localeCompare(b.id)),
          `${u} ${sup}`,
        ).toEqual(want.map(({ supplier: _s, scope: _c, ...x }) => x).sort((a, b) => a.id.localeCompare(b.id)));
        const pub = await v1(u, `/suppliers/${sup}`);
        for (const x of pub.contacts) expect(Object.keys(x).sort()).toEqual(['id', 'name', 'note', 'role', 'scope']);
        for (const x of want) mine.add(person(x.name, x.email, x.phone));
      }
      // plant sites: the page and the YAML export
      for (const [site, stored] of Object.entries(SITES)) {
        const sees = site === 'upg-open' || ['admin', 'olivia', 'adam', 'audrey'].includes(u);
        if (!sees) {
          expect(await status(c('GET', `/plant/sites/${site}`)), `${u} ${site}`).toBe(404);
          continue;
        }
        expect((await c('GET', `/plant/sites/${site}`)).contacts, `${u} ${site}`).toEqual(stored);
        for (const x of stored) mine.add(person(x.name, x.email, x.phone, x.url));
      }
      if (u === 'admin') {
        const yaml = await c('GET', '/plant/export?site=upg-team&format=yaml');
        const text = typeof yaml === 'string' ? yaml : JSON.stringify(yaml);
        expect(text).toContain('Backup (nights and weekends, call the gate first if the line is busy)');
        expect(text).toContain('https://pat.invented.example');
      }
    }
  });

  it('shows nobody a contact they could not see before', async () => {
    const db = (await import('../src/db.js')).db();
    const all = db.all<{ id: string; name: string; email: string; phone: string; url: string }>('SELECT id, name, email, phone, url FROM contacts');
    for (const u of USERS) {
      const c = as[u]!;
      const mine = seen.get(u)!;
      const listed = (await c('GET', '/contacts?status=all&limit=200')).items as { id: string; name: string; email: string; phone: string; url: string }[];
      for (const x of listed) expect(mine.has(person(x.name, x.email, x.phone, x.url)), `${u} sees ${x.name}`).toBe(true);
      for (const x of all) {
        const could = mine.has(person(x.name, x.email, x.phone, x.url));
        expect(await status(c('GET', `/contacts/${x.id}`)), `${u} ${x.name}`).toBe(could ? 200 : 404);
      }
    }
    // the check above is not vacuous: administrators see every contact, vera saw Sam and Ann, never Tom
    expect((await as.admin!('GET', '/contacts?status=all&limit=200')).items).toHaveLength(all.length);
    expect(seen.get('vera')!.has(person('Sam Invented', 'sam@invented.example', '+49 30 1'))).toBe(true);
    expect(seen.get('vera')!.has(person('Tom Secret', 'tom@invented.example', '+49 30 9'))).toBe(false);
    expect((await as.vera!('GET', '/contacts?status=all&limit=200')).items.length).toBeGreaterThan(3);
    // vera (a viewer of no team) never learns of Tom, Sue or Pia
    const vera = (await as.vera!('GET', '/contacts?status=all&q=secret')).items;
    expect(vera).toEqual([]);
  });

  it('runs once', async () => {
    const { convertItemContacts } = await import('../src/contacts/upgrade.js');
    const db = (await import('../src/db.js')).db();
    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_links')!.n;
    expect(convertItemContacts()).toEqual({ services: 0, suppliers: 0, sites: 0 });
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_links')!.n).toBe(before);
  });
});

describe.skipIf(PG)('after the upgrade', () => {
  it('erasing a contact removes its supplier entries; a supplier contact edited by name keeps its person', async () => {
    const db = (await import('../src/db.js')).db();
    const tom = db.get<{ id: string }>("SELECT id FROM contacts WHERE name = 'Tom Secret'")!.id;
    await as.admin!('DELETE', `/contacts/${tom}`);
    expect(db.get('SELECT 1 FROM supplier_contacts WHERE id = ?', 'spc_upg_tom')).toBeUndefined();
    expect((await as.olivia!('GET', '/suppliers/sup_upg_team')).contacts.map((c: { name: string }) => c.name)).toEqual(['Sam Invented']);
    // the old API shape: a corrected phone number changes the person wherever it is named (one entry per person)
    await as.admin!('PUT', '/suppliers/sup_upg_open/contacts/spc_upg_sam', {
      name: 'Sam Invented',
      role: 'accountManager',
      email: 'sam@invented.example',
      phone: '+49 30 11',
      note: '',
    });
    for (const [sup, entry] of [
      ['sup_upg_open', 'spc_upg_sam'],
      ['sup_upg_team', 'spc_upg_sam2'],
    ])
      expect((await as.admin!('GET', `/suppliers/${sup}`)).contacts.find((c: { id: string }) => c.id === entry)).toMatchObject({ phone: '+49 30 11' });
  });
});
