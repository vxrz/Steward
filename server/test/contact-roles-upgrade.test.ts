import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The upgrade to the role catalogue (0.26.0, ADR 0039 parts 1 and 8): the newest upgrade fixture gets plant sites
 * with free-text contact roles in the shape the released version stored – a site of the whole instance and one of a
 * team, roles that differ only in letter case, a long role, a contact without a role. The server upgrades it (0.25.1:
 * the contacts join the directory; 0.26.0: each distinct text becomes an own role of the catalogue). Then, for every
 * user:
 *  - each site shows exactly the role texts it stored, through the plant registry's page, /api/v1 and its YAML export
 *    (variants that differ only in letter case show as the most used one);
 *  - the role catalogue names a role made from a site's text only to who may see a site that names it – a user who
 *    could not see a site's texts before does not learn them now;
 *  - the existing links of every other kind keep their roles (the built-in keys are unchanged).
 * The conversion runs once. SQLite only (the fixture's database); contact-roles.test.ts converts on PostgreSQL too.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PG = !!process.env.SM_TEST_DATABASE_URL;
const FIXTURE = path.join(__dirname, 'fixtures', 'upgrade', 'v0.25.0');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8')) as {
  passphrase: string;
  admin: { username: string; password: string };
  demoPassword: string;
};
const AT = '2026-11-14T10:00:00.000Z';
const USERS = ['admin', 'dana', 'olivia', 'adam', 'audrey', 'vera'] as const;
type User = (typeof USERS)[number];
/** Who may see the team's site: administrators, auditors and the members of the fixture's Service Desk */
const SEES_TEAM_SITE: readonly User[] = ['admin', 'olivia', 'adam', 'audrey'];

const LONG = 'Backup (nights and weekends, call the gate first if the line is busy)';
/** Stored before 0.25.1 */
const SITES = {
  'upg-roles-open': [
    { name: 'Ann Invented', role: 'Shift lead', email: 'ann@invented.example', phone: '+49 30 3', url: '' },
    { name: 'Bo Invented', role: 'Shift lead', email: 'bo@invented.example', phone: '', url: '' },
    { name: 'Cy Invented', role: '', email: 'cy@invented.example', phone: '', url: '' },
  ],
  'upg-roles-team': [
    { name: 'Pat Plant', role: 'SHIFT LEAD', email: '', phone: '', url: 'https://pat.invented.example' },
    { name: 'Pat Plant', role: LONG, email: '', phone: '', url: 'https://pat.invented.example' },
    { name: 'Pia Secret', role: 'Energy officer (secret)', email: 'pia.secret@invented.example', phone: '+49 30 8', url: '' },
  ],
} as const;
const shownAs = (role: string) => (role.toLowerCase() === 'shift lead' ? 'Shift lead' : role);

let s: TestServer;
const as: Partial<Record<User, Client>> = {};
const tokens: Partial<Record<User, string>> = {};
let serviceRolesBefore: string[] = [];

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-roles-upg-'));
  fs.cpSync(path.join(FIXTURE, 'datadir'), dataDir, { recursive: true });
  const file = new DatabaseSync(path.join(dataDir, 'service-manager.db'));
  const run = (sql: string, ...args: (string | number | null)[]) => file.prepare(sql).run(...args);
  try {
    const team = (file.prepare("SELECT id FROM teams WHERE name = 'Service Desk'").get() as { id: string }).id;
    for (const [id, contacts] of Object.entries(SITES))
      run(
        `INSERT INTO plant_sites (id, name, contacts, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, 'admin', ?, 'admin')`,
        id,
        `Invented site ${id}`,
        JSON.stringify(contacts),
        AT,
        AT,
      );
    run('INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES (?, ?, ?, ?)', 'site', 'upg-roles-team', team, AT);
    // the roles services had (in the released shape)
    serviceRolesBefore = (file.prepare("SELECT contacts FROM services WHERE contacts <> '[]'").all() as { contacts: string }[])
      .flatMap((r) => (JSON.parse(r.contacts) as { role: string }[]).map((c) => c.role))
      .sort();
  } finally {
    file.close();
  }
  s = await startTestServer({ dataDir });
  const admin = s.client();
  await admin('POST', '/auth/login', manifest.admin);
  await admin('POST', '/vault/unlock', { passphrase: manifest.passphrase });
  as.admin = admin;
  await admin('PUT', '/settings/modules/plant', { enabled: true });
  for (const u of USERS.filter((x) => x !== 'admin')) as[u] = await s.as(u, manifest.demoPassword);
  for (const u of USERS) tokens[u] = (await as[u]!('POST', '/me/tokens', { name: `Invented ${u} token`, scope: 'read' })).token;
}, 240_000);

describe.skipIf(PG)('the upgrade to the role catalogue', () => {
  it('made one own role per distinct text, letter case aside, and the links name them', async () => {
    const db = (await import('../src/db.js')).db();
    const roles = (await as.admin!('GET', '/contact-roles')).filter((r: { kinds: string[] }) => r.kinds.includes('plant_site'));
    expect(roles.map((r: { labels: { en: string } }) => r.labels.en).sort()).toEqual(['Energy officer (secret)', LONG, 'Shift lead'].sort());
    expect(roles.every((r: { fromSiteText?: boolean; builtIn: boolean }) => r.fromSiteText && !r.builtIn)).toBe(true);
    const texts = db.all<{ role: string }>("SELECT DISTINCT role FROM contact_links WHERE kind = 'plant_site' ORDER BY role").map((r) => r.role);
    expect(texts.sort()).toEqual(['', ...roles.map((r: { key: string }) => r.key)].sort());
    const entry = (await as.admin!('GET', '/audit?action=contact.role_created&limit=5')).find(
      (e: { details: { upgrade?: string } }) => e.details.upgrade === '0.26.0',
    );
    expect(entry).toMatchObject({ actor: 'system', details: { kind: 'plant_site', links: 5 } });
  });

  it('shows every site with the role texts it stored, to everyone who sees it', async () => {
    for (const u of USERS) {
      const c = as[u]!;
      for (const [site, stored] of Object.entries(SITES)) {
        const sees = site === 'upg-roles-open' || SEES_TEAM_SITE.includes(u);
        if (!sees) {
          expect(await status(c('GET', `/plant/sites/${site}`)), `${u} ${site}`).toBe(404);
          continue;
        }
        const want = stored.map((x) => shownAs(x.role));
        expect(
          (await c('GET', `/plant/sites/${site}`)).contacts.map((x: { role: string }) => x.role),
          `${u} ${site}`,
        ).toEqual(want);
        expect(
          (await v1(u, `/plant/sites/${site}`)).contacts.map((x: { role: string }) => x.role),
          `${u} ${site} v1`,
        ).toEqual(want);
      }
    }
    const yaml = await as.admin!('GET', '/plant/export?site=upg-roles-team&format=yaml');
    const text = typeof yaml === 'string' ? yaml : JSON.stringify(yaml);
    expect(text).toContain(LONG);
    expect(text).toContain('Energy officer (secret)');
  });

  it('tells nobody a role made from a site they may not see', async () => {
    for (const u of USERS) {
      const labels = ((await as[u]!('GET', '/contact-roles')) as { labels: { en: string } }[]).map((r) => r.labels.en);
      expect(labels.includes('Shift lead'), `${u} Shift lead`).toBe(true);
      expect(labels.includes('Energy officer (secret)'), `${u} secret`).toBe(SEES_TEAM_SITE.includes(u));
      expect(labels.includes(LONG), `${u} long`).toBe(SEES_TEAM_SITE.includes(u));
    }
    // once an administrator saved it, it is a role like any other
    const key = ((await as.admin!('GET', '/contact-roles')) as { key: string; labels: { en: string } }[]).find((r) => r.labels.en === LONG)!.key;
    await as.admin!('PUT', `/contact-roles/${key}`, { labels: { en: 'Backup', de: 'Vertretung' }, kinds: ['plant_site'] });
    expect(((await as.vera!('GET', '/contact-roles')) as { key: string }[]).some((r) => r.key === key)).toBe(true);
  });

  it('keeps the roles of every other kind', async () => {
    const db = (await import('../src/db.js')).db();
    const service = db.all<{ role: string }>("SELECT role FROM contact_links WHERE kind = 'service'").map((r) => r.role);
    expect(service.sort()).toEqual(serviceRolesBefore);
    const catalogue = ((await as.admin!('GET', '/contact-roles')) as { key: string }[]).map((r) => r.key);
    for (const r of db.all<{ role: string; kind: string }>("SELECT DISTINCT role, kind FROM contact_links WHERE kind <> 'plant_site'"))
      expect(catalogue, `${r.kind} ${r.role}`).toContain(r.role);
  });

  it('runs once', async () => {
    const { convertPlantSiteRoles } = await import('../src/contacts/upgrade.js');
    const { runAs } = await import('../src/auth/context.js');
    expect(runAs(null, () => convertPlantSiteRoles())).toEqual({ roles: 0, links: 0 });
  });
});
