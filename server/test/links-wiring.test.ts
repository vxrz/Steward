import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowEmailDomains, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Wiring between the service catalogue, the credentials register and records:
 * credential "used by" links to services, record/service links to credentials
 * (with backlinks both ways), and the records section of scheduled reports.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
const DAY = 86400000;
let dana: Client, olivia: Client, adam: Client, audrey: Client, vera: Client;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );

const credential = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  type: 'technicalUser',
  platformText: 'Historian',
  usedBy: { text: '', links: [] },
  owners: [{ email: 'it-ops@example.com', role: 'IT operations' }],
  location: { text: 'KeePass: IT-Ops.kdbx → Historian' },
  ...over,
});
const CR_FIELDS = { reason: 'Maintenance', risk: 'low', rollbackPlan: 'Restore the snapshot' };
const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + 'Z';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await allowEmailDomains(s, ['example.com']);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, audrey, vera] = await Promise.all(['dana', 'olivia', 'adam', 'audrey', 'vera'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

describe('services, credentials and records', () => {
  let svc: any, shared: any, veraOwn: any, rec: any;

  it('a credential links to a catalogue service; the service shows it as a backlink', async () => {
    svc = await dana('POST', '/services', { name: 'Historian service', owners: [] });
    shared = await dana('POST', '/credentials', credential('Historian technical user', { usedBy: { text: '', links: [{ kind: 'service', id: svc.id }] } }));
    veraOwn = await dana(
      'POST',
      '/credentials',
      credential('Vera historian token', { ownerSubjects: ['user:vera'], usedBy: { text: '', links: [{ kind: 'service', id: svc.id }] } }),
    );
    expect(shared.usedBy.links).toEqual([{ kind: 'service', id: svc.id, label: 'Historian service' }]);
    // a link to a service that does not exist has no label
    const ghost = await dana('POST', '/credentials', credential('Ghost user', { usedBy: { text: '', links: [{ kind: 'service', id: 'svc_missing' }] } }));
    expect(ghost.usedBy.links[0].label).toBeNull();

    const detail = await olivia('GET', `/services/${svc.id}`);
    expect(detail.backlinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'credential', id: shared.id, label: 'Historian technical user', path: `/credentials?open=${shared.id}` }),
        expect.objectContaining({ kind: 'credential', id: veraOwn.id, label: 'Vera historian token' }),
      ]),
    );
    expect((await audrey('GET', `/backlinks?kind=service&id=${svc.id}`)).map((b: any) => b.id)).toEqual(expect.arrayContaining([shared.id, veraOwn.id]));
  });

  it('viewers only see backlinks from credentials they own', async () => {
    const detail = await vera('GET', `/services/${svc.id}`);
    expect(detail.backlinks.filter((b: any) => b.kind === 'credential').map((b: any) => b.id)).toEqual([veraOwn.id]);
    expect(JSON.stringify(detail)).not.toContain('Historian technical user');
    expect((await vera('GET', `/backlinks?kind=service&id=${svc.id}`)).map((b: any) => b.id)).toEqual([veraOwn.id]);
    // vera sees her own entry with the service's name
    expect((await vera('GET', `/credentials/${veraOwn.id}`)).usedBy.links[0].label).toBe('Historian service');
  });

  it('records link to credentials; the link picker and labels follow the register’s read rules', async () => {
    rec = await dana('POST', '/records', { type: 'CR', title: 'Rotate the historian user', fields: CR_FIELDS });
    const link = await dana('POST', `/records/${rec.id}/links`, { kind: 'credential', id: shared.id, note: 'rotated' });
    expect(link).toMatchObject({
      kind: 'credential',
      targetId: shared.id,
      label: 'Historian technical user',
      visible: true,
      path: `/credentials?open=${shared.id}`,
    });

    // a viewer reads the record, but not the credential's name
    const asVera = await vera('GET', `/records/${rec.id}`);
    expect(asVera.links).toEqual([expect.objectContaining({ kind: 'credential', targetId: null, label: '', visible: false, path: null })]);
    expect(JSON.stringify(asVera)).not.toContain('Historian technical user');
    expect(JSON.stringify(asVera)).not.toContain(shared.id); // no id of an entry the reader may not see

    // link-targets: only entries the user may see
    const forDana = (await dana('GET', '/link-targets?kind=credential&q=historian')).map((x: any) => x.id);
    expect(forDana).toEqual(expect.arrayContaining([shared.id, veraOwn.id]));
    expect((await vera('GET', '/link-targets?kind=credential&q=historian')).map((x: any) => x.id)).toEqual([veraOwn.id]);

    // backlinks of a credential: records and services that link to it, nothing for those who may not see it
    await dana('POST', `/services/${svc.id}/links`, { kind: 'credential', id: shared.id, note: 'service account' });
    const back = await adam('GET', `/backlinks?kind=credential&id=${shared.id}`);
    expect(back).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'record', id: rec.id, note: 'rotated', path: `/records/${rec.id}` }),
        expect.objectContaining({ kind: 'service', id: svc.id, label: 'Historian service', note: 'service account' }),
      ]),
    );
    await expect(dana('GET', `/backlinks?kind=credential&id=cred_missing`)).rejects.toMatchObject({ status: 404 });
  });

  it('only visible credentials can be linked (no probing for ids)', async () => {
    const own = await dana('POST', '/records', { type: 'CR', title: 'Vera’s change', fields: CR_FIELDS });
    await dana('PUT', `/records/${own.id}`, { owner: 'vera' });
    // vera may edit the record she owns, but cannot link a credential she may not see
    expect(await status(vera('POST', `/records/${own.id}/links`, { kind: 'credential', id: shared.id, note: '' }))).toBe(404);
    expect(await status(vera('POST', `/records/${own.id}/links`, { kind: 'credential', id: 'cred_missing', note: '' }))).toBe(404);
    expect((await vera('POST', `/records/${own.id}/links`, { kind: 'credential', id: veraOwn.id, note: '' })).label).toBe('Vera historian token');
    // the audit entry names the target only because vera could see it
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${own.id}&action=record.link_added`);
    expect(audit[0].summary).toContain('Vera historian token');
  });
});

describe('records section of scheduled reports', () => {
  const ids: Record<string, any> = {};

  beforeAll(async () => {
    const now = Date.now();
    const cr = (title: string, fields: Record<string, string> = {}) => dana('POST', '/records', { type: 'CR', title, fields: { ...CR_FIELDS, ...fields } });
    const go = (id: string, c: Client, action: string, comment = '') => c('POST', `/records/${id}/transition`, { action, comment });
    // approved and implemented in the period
    ids.done = await cr('Report: patch the historian');
    await go(ids.done.id, dana, 'submit');
    await go(ids.done.id, adam, 'approve', 'ok');
    await go(ids.done.id, dana, 'implement');
    // submitted, with a change window in 3 days
    ids.soon = await cr('Report: replace the switch', { plannedStart: iso(now + 3 * DAY), plannedEnd: iso(now + 3 * DAY + 3600000) });
    await go(ids.soon.id, dana, 'submit');
    // windows outside the horizon, in the past, or of a cancelled change are left out
    ids.far = await cr('Report: far away', { plannedStart: iso(now + 100 * DAY) });
    ids.past = await cr('Report: long ago', { plannedStart: iso(now - 20 * DAY), plannedEnd: iso(now - 19 * DAY) });
    ids.cancelled = await cr('Report: cancelled', { plannedStart: iso(now + 2 * DAY) });
    await go(ids.cancelled.id, dana, 'cancel');
    // a decision record changed in the period
    ids.adr = await dana('POST', '/records', { type: 'ADR', title: 'Report: use PostgreSQL' });
    await dana('PUT', `/records/${ids.adr.id}`, { title: 'Report: use PostgreSQL 17' });
    // an old change request: created before the period, still open
    ids.old = await cr('Report: old draft');
    const { db } = await import('../src/db.js');
    const old = new Date(now - 10 * DAY).toISOString();
    db().run('UPDATE records SET created_at = ? WHERE id = ?', old, ids.old.id);
    db().run('UPDATE record_versions SET created_at = ? WHERE record_id = ?', old, ids.old.id);
    db().run('UPDATE record_events SET created_at = ? WHERE record_id = ?', old, ids.old.id);
  });

  const build = async (config: Record<string, unknown>, ctx: { from: number; to: number; now: number }, user = 'dana') => {
    const { reportSection } = await import('../src/reports/sections.js');
    await import('../src/reports/schedules.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const def = reportSection('records')!;
    return runAs(toAuthUser(findUserByName(user)!), () => def.build(def.schema.parse(config), { ...ctx, lang: 'en' })) as any;
  };

  it('collects activity, open change requests by status and planned change windows', async () => {
    const now = Date.now();
    const d = await build({}, { from: now - DAY, to: now + 60000, now });
    const what = (id: string) => d.activity.find((a: any) => a.id === id)?.what;
    expect(what(ids.done.id)).toEqual(['created', 'approved', 'implemented']);
    expect(what(ids.soon.id)).toEqual(['created']);
    expect(what(ids.adr.id)).toEqual(['created', 'changed']);
    expect(what(ids.old.id)).toBeUndefined();
    expect(d.counts.approved).toBeGreaterThanOrEqual(1);
    expect(d.counts.implemented).toBeGreaterThanOrEqual(1);
    expect(d.counts.changed).toBeGreaterThanOrEqual(1);

    const open = d.open.map((r: any) => r.id);
    expect(open).toEqual(expect.arrayContaining([ids.done.id, ids.soon.id, ids.old.id]));
    expect(open).not.toContain(ids.cancelled.id);
    expect(open).not.toContain(ids.adr.id); // decision records are not change requests
    const byStatus = Object.fromEntries(d.openByStatus.map((x: any) => [x.status, x.count]));
    expect(byStatus.implemented).toBeGreaterThanOrEqual(1);
    expect(byStatus.submitted).toBeGreaterThanOrEqual(1);
    expect(byStatus.draft).toBeGreaterThanOrEqual(1);
    expect(byStatus.cancelled).toBeUndefined();

    expect(d.windows.map((w: any) => w.id)).toEqual([ids.soon.id]);
    expect(d.windows[0]).toMatchObject({ status: 'submitted', risk: 'low' });
    // a wider horizon includes the far window
    expect((await build({ windowDays: 120 }, { from: now - DAY, to: now + 60000, now })).windows.map((w: any) => w.id)).toEqual([ids.soon.id, ids.far.id]);
    // type filter
    const adrOnly = await build({ types: ['ADR'] }, { from: now - DAY, to: now + 60000, now });
    expect(adrOnly.activity.every((a: any) => a.number.startsWith('ADR-'))).toBe(true);
    expect(adrOnly.open).toEqual([]);
  });

  it('statuses are those at the end of the period', async () => {
    const now = Date.now();
    // a period that ended 5 days ago: only the old draft existed, as a draft
    const d = await build({}, { from: now - 12 * DAY, to: now - 5 * DAY, now });
    expect(d.activity.map((a: any) => a.id)).toEqual([ids.old.id]);
    expect(d.open.find((r: any) => r.id === ids.old.id)).toMatchObject({ status: 'draft' });
    expect(d.open.map((r: any) => r.id)).not.toContain(ids.done.id);
  });

  it('a schedule with the records section renders it; unknown record types are refused', async () => {
    const body = (sections: Record<string, unknown>) => ({
      name: `Records report ${Math.random().toString(36).slice(2, 8)}`,
      preset: 'custom',
      cron: '0 6 * * 1',
      timezone: 'Europe/Berlin',
      periodDays: 1,
      lang: 'en',
      sections,
      recipients: { users: [], teams: [], emails: [] },
    });
    expect(await status(dana('POST', '/report-schedules', body({ records: { types: ['NOPE'] } })))).toBe(400);
    expect(await status(dana('POST', '/report-schedules', body({ records: { windowDays: 9999 } })))).toBe(400);
    expect((await dana('GET', '/report-schedules')).sections).toContain('records');
    const sch = await dana('POST', '/report-schedules', body({ records: { types: null, windowDays: 30 } }));
    const schedules = await import('../src/reports/schedules.js');
    const rep = await schedules.runReportSchedule(sch.id, { actor: 'dana', at: Date.now() + 60000 });
    const text = rep.texts.join('\n');
    for (const x of ['Records and change requests', 'Activity in the period', 'Open change requests by status', 'Planned change windows'])
      expect(text).toContain(x);
    expect(text).toContain(ids.soon.number);
    expect(text).toContain('Report: patch the historian');
    // German
    const de = await dana('POST', '/report-schedules', { ...body({ records: {} }), lang: 'de' });
    const repDe = await schedules.runReportSchedule(de.id, { actor: 'dana', at: Date.now() + 60000 });
    expect(repDe.texts.join('\n')).toContain('Geplante Änderungsfenster');
    expect(repDe.texts.join('\n')).toContain('Eingereicht');
  });
});
