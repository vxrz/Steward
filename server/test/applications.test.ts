import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Applications in the service catalogue (#84): CRUD and permissions, integrations (a platform belongs to at most one
 * application), services → applications, the CIA rating with the default and custom scales (scale changes map or
 * flag ratings, never lose them), the derived protection need (maximum principle) and its override, document scope,
 * links both ways, the audit trail, the public API and evidence packs.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, adam: Client, vera: Client;
let platforms: { id: string; name: string; kind: string }[];
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const body = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { body: unknown }) => (typeof e.body === 'string' ? JSON.parse(e.body) : e.body),
  );
const audit = (type: string, id: string) => s.api('GET', `/audit?entityType=${type}&entityId=${id}&limit=50`);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, vera] = await Promise.all(['dana', 'olivia', 'adam', 'vera'].map((u) => s.as(u, PW)));
  platforms = await s.api('GET', '/platforms');
});
afterAll(async () => {
  await s?.app.close();
});

const APP = {
  name: 'Insights Hub',
  description: '## Purpose\n\nIndustrial IoT platform.',
  vendor: 'Siemens',
  version: '2026.1',
  url: 'https://insights.example.com',
  owners: ['user:Olivia'],
  criticality: 'high',
  cmdb: { system: 'ServiceNow', id: 'CI-IH', url: '' },
  tags: ['IoT', 'cloud'],
};

describe('applications', () => {
  let app: any;
  it('designers and administrators create applications; everyone reads them; owners edit', async () => {
    for (const c of [olivia, adam, vera]) expect(await status(c('POST', '/applications', APP))).toBe(403);
    app = await dana('POST', '/applications', APP);
    expect(app).toMatchObject({
      name: 'Insights Hub',
      vendor: 'Siemens',
      version: '2026.1',
      url: 'https://insights.example.com',
      owners: ['user:olivia'],
      criticality: 'high',
      tags: ['cloud', 'iot'],
      cmdb: { system: 'ServiceNow', id: 'CI-IH', url: '' },
      archived: false,
      canEdit: true,
      services: [],
      integrations: [],
      rating: { confidentiality: null, integrity: null, availability: null },
    });
    expect((await vera('GET', '/applications')).map((a: any) => a.id)).toContain(app.id);
    expect((await vera('GET', `/applications/${app.id}`)).canEdit).toBe(false);
    // olivia is an owner: she may edit (but not create)
    const changed = await olivia('PUT', `/applications/${app.id}`, { ...APP, version: '2026.2' });
    expect(changed.version).toBe('2026.2');
    expect(await status(vera('PUT', `/applications/${app.id}`, APP))).toBe(403);
    expect(await status(dana('POST', '/applications', APP))).toBe(409);
    expect((await body(dana('POST', '/applications', APP))).code).toBe('APPLICATION_EXISTS');
    expect(await status(vera('GET', '/applications/app_missing'))).toBe(404);
    const actions = (await audit('application', app.id)).map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['application.created', 'application.updated']));
  });

  it('validates input', async () => {
    const bad = [
      { ...APP, name: '' },
      { ...APP, url: 'javascript:alert(1)' },
      { ...APP, owners: ['dana'] },
      { ...APP, criticality: 'extreme' },
      { ...APP, tags: Array.from({ length: 31 }, (_, i) => `t${i}`) },
      { ...APP, extra: 1 },
    ];
    for (const b of bad) expect(await status(dana('POST', '/applications', { ...b, name: b.name === '' ? '' : `${b.name} ${Math.random()}` }))).toBe(400);
  });

  it('archives and restores', async () => {
    const a = await dana('POST', '/applications', { name: 'Old historian' });
    expect((await dana('POST', `/applications/${a.id}/archive`, { archived: true })).archived).toBe(true);
    expect((await vera('GET', '/applications')).map((x: any) => x.id)).not.toContain(a.id);
    expect((await vera('GET', '/applications?archived=1')).map((x: any) => x.id)).toContain(a.id);
    expect((await dana('POST', `/applications/${a.id}/archive`, { archived: false })).archived).toBe(false);
    expect((await audit('application', a.id)).map((e: any) => e.action)).toEqual(expect.arrayContaining(['application.archived', 'application.restored']));
  });

  it('maps platforms as integrations; a platform belongs to at most one application', async () => {
    const [p1, p2] = platforms.filter((p) => p.kind !== 'gatus');
    const ih = app.id;
    const edge = await dana('POST', '/applications', { name: 'Industrial Edge' });
    // dana manages both platforms, olivia (an owner of the application) only uses them
    for (const p of [p1!, p2!])
      await s.api('PUT', `/platforms/${p.id}/access`, {
        acl: [
          { subject: 'user:dana', permissions: ['manage'] },
          { subject: 'user:olivia', permissions: ['use'] },
        ],
      });
    let a = await dana('POST', `/applications/${ih}/platforms`, { platformId: p1!.id });
    expect(a.integrations).toEqual([
      expect.objectContaining({ visible: true, platformId: p1!.id, name: p1!.name, path: `/platforms/${p1!.id}`, canManage: true }),
    ]);
    expect(a.integrationCount).toBe(1);
    // the same platform for another application: refused, naming where it belongs
    const taken = await body(dana('POST', `/applications/${edge.id}/platforms`, { platformId: p1!.id }));
    expect(taken.code).toBe('PLATFORM_MAPPED');
    expect(taken.params).toMatchObject({ application: 'Insights Hub' });
    // mapping it again to the same application changes nothing
    expect((await dana('POST', `/applications/${ih}/platforms`, { platformId: p1!.id })).integrations).toHaveLength(1);
    a = await dana('POST', `/applications/${ih}/platforms`, { platformId: p2!.id });
    expect(a.integrations.map((i: any) => i.platformId).sort()).toEqual([p1!.id, p2!.id].sort());
    expect(await status(vera('POST', `/applications/${ih}/platforms`, { platformId: p2!.id }))).toBe(403);
    expect(await status(dana('POST', `/applications/${ih}/platforms`, { platformId: 'plt_missing' }))).toBe(404);
    // the platform page names its application
    expect((await dana('GET', `/platforms/${p1!.id}/application`)).application).toEqual({ id: ih, name: 'Insights Hub', archived: false });
    expect((await dana('GET', `/platforms/${platforms.find((p) => p.kind === 'gatus')!.id}/application`)).application).toBeNull();
    // olivia may edit the application but not manage the platforms: she cannot remove them …
    expect((await olivia('GET', `/applications/${ih}`)).integrations.every((i: any) => i.canManage === false)).toBe(true);
    const unmap = await body(olivia('DELETE', `/applications/${ih}/platforms/${p2!.id}`));
    expect(unmap).toMatchObject({ code: 'FORBIDDEN', params: { context: 'mapPlatform' } });
    // remove it here, then it can move
    await dana('DELETE', `/applications/${ih}/platforms/${p2!.id}`);
    expect(await status(dana('DELETE', `/applications/${ih}/platforms/${p2!.id}`))).toBe(404);
    // … nor claim a platform for her own application (#84 M1: it would block the real application and its evidence)
    const own = await s.api('POST', '/applications', { name: 'Olivia’s app', owners: ['user:olivia'] });
    const claim = await body(olivia('POST', `/applications/${own.id}/platforms`, { platformId: p2!.id }));
    expect(claim).toMatchObject({ code: 'FORBIDDEN', params: { context: 'mapPlatform' } });
    expect((await s.api('GET', `/platforms/${p2!.id}/application`)).application).toBeNull();
    expect((await dana('POST', `/applications/${edge.id}/platforms`, { platformId: p2!.id })).integrations).toHaveLength(1);
    const actions = (await audit('application', ih)).map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['application.platform_added', 'application.platform_removed']));
  });

  it('shows platforms the reader may not see only as not visible, and does not map them', async () => {
    const hidden = platforms.filter((p) => p.kind !== 'gatus')[2]!;
    await s.api('PUT', `/platforms/${hidden.id}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage'] }] });
    const priv = await dana('POST', '/applications', { name: 'Private app' });
    expect(await status(dana('POST', `/applications/${priv.id}/platforms`, { platformId: hidden.id }))).toBe(404);
    await s.api('POST', `/applications/${priv.id}/platforms`, { platformId: hidden.id });
    const seen = await dana('GET', `/applications/${priv.id}`);
    expect(seen.integrations).toEqual([expect.objectContaining({ visible: false, platformId: null, name: '', path: null })]);
    expect(await status(dana('GET', `/platforms/${hidden.id}/application`))).toBe(404);
    // a platform that is deleted leaves its application
    await s.api('DELETE', `/platforms/${hidden.id}`);
    expect((await s.api('GET', `/applications/${priv.id}`)).integrations).toEqual([]);
  });
});

describe('services, ratings and protection needs', () => {
  let svc: any, ih: any, edge: any, mes: any;
  beforeAll(async () => {
    svc = await dana('POST', '/services', { name: 'Plant monitoring', owners: ['user:olivia'] });
    ih = (await dana('GET', '/applications')).find((a: any) => a.name === 'Insights Hub');
    edge = (await dana('GET', '/applications')).find((a: any) => a.name === 'Industrial Edge');
    mes = await dana('POST', '/applications', { name: 'MES connector' });
  });

  it('maps applications to services with a role; the service shows them with their integrations', async () => {
    expect(await status(vera('PUT', `/services/${svc.id}/applications/${ih.id}`, { role: 'primary' }))).toBe(403);
    // olivia owns the service
    expect((await olivia('PUT', `/services/${svc.id}/applications/${ih.id}`, { role: 'primary' })).applications).toHaveLength(1);
    await dana('PUT', `/services/${svc.id}/applications/${edge.id}`, { role: 'dependency' });
    expect((await body(dana('PUT', `/services/${svc.id}/applications/${mes.id}`, { role: 'other' }))).code).toBe('APPLICATION_ROLE_TEXT');
    let d = await dana('PUT', `/services/${svc.id}/applications/${mes.id}`, { role: 'other', roleText: 'data source' });
    expect(d.applications.map((a: any) => [a.name, a.role, a.roleText])).toEqual([
      ['Industrial Edge', 'dependency', ''],
      ['Insights Hub', 'primary', ''],
      ['MES connector', 'other', 'data source'],
    ]);
    expect(d.applications.find((a: any) => a.id === ih.id).integrations).toHaveLength(1);
    expect(d.applicationCount).toBe(3);
    // the role changes in place
    d = await dana('PUT', `/services/${svc.id}/applications/${mes.id}`, { role: 'dependency' });
    expect(d.applications.find((a: any) => a.id === mes.id)).toMatchObject({ role: 'dependency', roleText: '' });
    expect(await status(dana('PUT', `/services/${svc.id}/applications/app_missing`, {}))).toBe(404);
    // the application lists its services
    expect((await vera('GET', `/applications/${ih.id}`)).services).toEqual([
      { id: svc.id, name: 'Plant monitoring', archived: false, role: 'primary', roleText: '' },
    ]);
    const actions = (await audit('service', svc.id)).map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['service.application_added', 'service.application_changed']));
    // an archived application cannot be added
    const old = await dana('POST', '/applications', { name: 'Retired SCADA' });
    await dana('POST', `/applications/${old.id}/archive`, { archived: true });
    expect((await body(dana('PUT', `/services/${svc.id}/applications/${old.id}`, {}))).code).toBe('APPLICATION_ARCHIVED');
  });

  it('rates applications with the BSI default scale; the service derives its protection need (maximum principle)', async () => {
    const scale = await vera('GET', '/catalogue/cia-scale');
    expect(scale.mode).toBe('default');
    expect(scale.levels.confidentiality.map((l: any) => l.key)).toEqual(['normal', 'high', 'very_high']);
    expect(scale.canEdit).toBe(false);
    expect(await status(vera('PUT', `/applications/${ih.id}/rating`, { confidentiality: { level: 'high', justification: 'x' } }))).toBe(403);
    expect((await body(dana('PUT', `/applications/${ih.id}/rating`, { confidentiality: { level: 'extreme', justification: 'x' } }))).code).toBe(
      'CIA_LEVEL_UNKNOWN',
    );
    expect(await status(dana('PUT', `/applications/${ih.id}/rating`, { confidentiality: { level: 'high', justification: '' } }))).toBe(400);
    const r = await olivia('PUT', `/applications/${ih.id}/rating`, {
      confidentiality: { level: 'high', justification: 'Production data of customers' },
      integrity: { level: 'normal', justification: 'Values are checked downstream' },
      availability: { level: 'high', justification: 'Plant reporting stops' },
    });
    expect(r.rating.confidentiality).toMatchObject({
      level: 'high',
      justification: 'Production data of customers',
      ratedBy: 'olivia',
      needsRerating: false,
      previousLabel: null,
    });
    await dana('PUT', `/applications/${edge.id}/rating`, {
      confidentiality: { level: 'normal', justification: 'No personal data' },
      integrity: { level: 'very_high', justification: 'Controls machines' },
    });
    let d = await vera('GET', `/services/${svc.id}`);
    expect(d.protectionNeed.confidentiality).toMatchObject({ derived: 'high', derivedFrom: [ih.id], rated: 2, total: 3, effective: 'high', override: null });
    expect(d.protectionNeed.integrity).toMatchObject({ derived: 'very_high', derivedFrom: [edge.id], effective: 'very_high' });
    expect(d.protectionNeed.availability).toMatchObject({ derived: 'high', rated: 1, total: 3 });
    // the list carries it too
    expect((await vera('GET', '/services')).find((x: any) => x.id === svc.id).protectionNeed.integrity.effective).toBe('very_high');
    // an archived application does not count
    await dana('POST', `/applications/${edge.id}/archive`, { archived: true });
    d = await vera('GET', `/services/${svc.id}`);
    expect(d.protectionNeed.integrity).toMatchObject({ derived: 'normal', total: 2 });
    await dana('POST', `/applications/${edge.id}/archive`, { archived: false });
    // removing a rating
    await dana('PUT', `/applications/${ih.id}/rating`, { availability: null });
    expect((await vera('GET', `/applications/${ih.id}`)).rating.availability).toBeNull();
    expect((await vera('GET', `/services/${svc.id}`)).protectionNeed.availability.derived).toBeNull();
    await dana('PUT', `/applications/${ih.id}/rating`, { availability: { level: 'high', justification: 'Plant reporting stops' } });
    const entries = await audit('application', ih.id);
    const rated = entries.find((e: any) => e.action === 'application.rated' && e.actor === 'olivia');
    expect(rated.summary).toContain('confidentiality none → High');
    expect(rated.details.changes).toEqual(
      expect.arrayContaining([{ dimension: 'integrity', from: null, to: 'normal', justification: 'Values are checked downstream' }]),
    );
  });

  it('overrides the derived protection need with a reason, audited', async () => {
    expect(await status(vera('PUT', `/services/${svc.id}/protection-need`, { availability: { level: 'very_high', reason: 'x' } }))).toBe(403);
    expect(await status(dana('PUT', `/services/${svc.id}/protection-need`, { availability: { level: 'very_high', reason: '' } }))).toBe(400);
    let d = await olivia('PUT', `/services/${svc.id}/protection-need`, {
      availability: { level: 'very_high', reason: 'Cumulation: three plants depend on it at once' },
    });
    expect(d.protectionNeed.availability).toMatchObject({
      derived: 'high',
      effective: 'very_high',
      override: { level: 'very_high', reason: 'Cumulation: three plants depend on it at once', setBy: 'olivia', needsRerating: false },
    });
    // lower is possible too (distribution effect)
    d = await dana('PUT', `/services/${svc.id}/protection-need`, {
      confidentiality: { level: 'normal', reason: 'Distribution: only aggregated data leaves the plant' },
    });
    expect(d.protectionNeed.confidentiality).toMatchObject({ derived: 'high', effective: 'normal' });
    d = await dana('PUT', `/services/${svc.id}/protection-need`, { confidentiality: null });
    expect(d.protectionNeed.confidentiality).toMatchObject({ effective: 'high', override: null });
    const e = (await audit('service', svc.id)).filter((x: any) => x.action === 'service.protection_need_overridden');
    expect(e.length).toBe(3);
    expect(e.find((x: any) => x.actor === 'olivia').details.changes[0]).toMatchObject({
      dimension: 'availability',
      from: null,
      to: 'very_high',
      derived: 'high',
    });
  });

  it('custom scales: only administrators; removed levels are mapped or flagged, never lost', async () => {
    const shared = [
      { key: 'low', label: 'Low', color: 'gray' },
      { key: 'normal', label: 'Normal', color: 'green' },
      { key: 'high', label: 'High', color: 'orange' },
      { key: 'critical', label: 'Critical', description: 'Existential', color: 'red' },
    ];
    expect(await status(dana('PUT', '/catalogue/cia-scale', { mode: 'shared', levels: shared }))).toBe(403);
    // validation: unknown colour, duplicate key, one level only, mapping to an unknown level or of a level that stays
    for (const b of [
      { mode: 'shared', levels: [{ key: 'a', label: 'A', color: '#f00' }, shared[1]] },
      { mode: 'shared', levels: [shared[0], shared[0]] },
      { mode: 'shared', levels: [shared[0]] },
      { mode: 'shared' },
    ])
      expect(await status(s.api('PUT', '/catalogue/cia-scale', b))).toBe(400);
    expect((await body(s.api('PUT', '/catalogue/cia-scale', { mode: 'shared', levels: shared, mapping: { all: { very_high: 'extreme' } } }))).code).toBe(
      'CIA_MAPPING_TARGET_UNKNOWN',
    );
    expect((await body(s.api('PUT', '/catalogue/cia-scale', { mode: 'shared', levels: shared, mapping: { all: { high: 'critical' } } }))).code).toBe(
      'CIA_MAPPING_LEVEL_KEPT',
    );
    const before = await s.api('GET', '/catalogue/cia-scale');
    expect(before.usage.integrity).toMatchObject({ normal: 1, very_high: 1 });
    expect(before.usage.availability).toMatchObject({ high: 1, very_high: 1 });
    // one scale for all three: very high becomes critical
    const sc = await s.api('PUT', '/catalogue/cia-scale', { mode: 'shared', levels: shared, mapping: { all: { very_high: 'critical' } } });
    expect(sc).toMatchObject({ mode: 'shared', updatedBy: 'admin' });
    expect(sc.levels.integrity.map((l: any) => l.key)).toEqual(['low', 'normal', 'high', 'critical']);
    expect((await vera('GET', `/applications/${edge.id}`)).rating.integrity).toMatchObject({
      level: 'critical',
      justification: 'Controls machines',
      needsRerating: false,
      previousLabel: 'Very high',
    });
    let d = await vera('GET', `/services/${svc.id}`);
    expect(d.protectionNeed.integrity).toMatchObject({ derived: 'critical', effective: 'critical' });
    expect(d.protectionNeed.availability).toMatchObject({ effective: 'critical', override: { level: 'critical', previousLabel: 'Very high' } });
    const entry = (await s.api('GET', '/audit?action=catalogue.cia_scale_changed&limit=1'))[0];
    expect(entry.details.effects.integrity).toEqual({ mapped: 1, flagged: 0, reordered: 0 });
    expect(entry.details.previousMode).toBe('default');

    // a scale per dimension: availability without "high" and no mapping → flagged for re-rating
    const availability = [
      { key: 'basic', label: 'Basic', color: 'gray' },
      { key: 'critical', label: 'Critical', color: 'red' },
    ];
    await s.api('PUT', '/catalogue/cia-scale', { mode: 'perDimension', dimensions: { confidentiality: shared, integrity: shared, availability } });
    const a = await vera('GET', `/applications/${ih.id}`);
    expect(a.rating.availability).toMatchObject({ level: 'high', justification: 'Plant reporting stops', needsRerating: true, previousLabel: 'High' });
    expect(a.rating.confidentiality).toMatchObject({ level: 'high', needsRerating: false });
    d = await vera('GET', `/services/${svc.id}`);
    // the flagged rating does not count; the override (critical) stays valid
    expect(d.protectionNeed.availability).toMatchObject({ derived: null, rated: 0, needsRerating: 1, effective: 'critical' });
    expect((await s.api('GET', '/catalogue/cia-scale')).usage.availability).toMatchObject({ high: 1, critical: 1 });
    // re-rating clears the flag
    const re = await dana('PUT', `/applications/${ih.id}/rating`, { availability: { level: 'basic', justification: 'Can wait a day' } });
    expect(re.rating.availability).toMatchObject({ level: 'basic', needsRerating: false, previousLabel: null });
    expect((await vera('GET', `/services/${svc.id}`)).protectionNeed.availability).toMatchObject({ derived: 'basic', rated: 1 });
    // back to the BSI default: low, basic and critical are gone – flagged (or mapped)
    await s.api('PUT', '/catalogue/cia-scale', { mode: 'default', mapping: { all: { critical: 'very_high' }, availability: { basic: 'normal' } } });
    const back = await vera('GET', `/applications/${edge.id}`);
    expect(back.rating.integrity).toMatchObject({ level: 'very_high', previousLabel: 'Critical', needsRerating: false });
    expect((await vera('GET', `/applications/${ih.id}`)).rating.availability).toMatchObject({ level: 'normal', previousLabel: 'Basic' });
    expect((await vera('GET', '/catalogue/cia-scale')).mode).toBe('default');
  });

  it('links applications both ways and finds them in the link picker', async () => {
    await dana('POST', `/services/${svc.id}/links`, { kind: 'application', id: mes.id, note: 'feeds' });
    const a = await vera('GET', `/applications/${mes.id}`);
    expect(a.backlinks).toEqual([expect.objectContaining({ kind: 'service', id: svc.id, label: 'Plant monitoring' })]);
    await dana('POST', `/applications/${mes.id}/links`, { url: 'https://wiki.example.com/mes', label: 'Wiki', linkType: 'documentation' });
    expect(await status(vera('POST', `/applications/${mes.id}/links`, { url: 'https://wiki.example.com/x', label: 'x' }))).toBe(403);
    const withLink = await dana('GET', `/applications/${mes.id}`);
    expect(withLink.links.map((l: any) => l.label)).toEqual(['Wiki']);
    await dana('PATCH', `/applications/${mes.id}/links/${withLink.links[0].id}`, { note: 'start here' });
    expect((await vera('GET', '/link-targets?kind=application&q=mes')).map((t: any) => t.id)).toEqual([mes.id]);
    expect((await vera('GET', `/services/${svc.id}`)).links).toEqual([
      expect.objectContaining({ kind: 'application', label: 'MES connector', path: `/applications/${mes.id}` }),
    ]);
    await dana('DELETE', `/applications/${mes.id}/links/${withLink.links[0].id}`);
    expect((await audit('application', mes.id)).map((e: any) => e.action)).toEqual(
      expect.arrayContaining(['application.link_added', 'application.link_removed']),
    );
  });

  it('scopes living documents to applications; the service groups them, the application lists them', async () => {
    const doc = await dana('POST', '/records', { type: 'DOC', title: 'ICAM concept', links: [{ kind: 'service', id: svc.id, note: '' }] });
    expect(doc.document.appliesTo).toEqual([]);
    expect(doc.document.permissions.scope).toBe(true);
    expect(await status(vera('PUT', `/records/${doc.id}/applications`, { applicationIds: [ih.id] }))).toBe(403);
    const r = await olivia('PUT', `/records/${doc.id}/applications`, { applicationIds: [ih.id, mes.id] });
    expect(r.appliesTo.map((a: any) => a.name)).toEqual(['Insights Hub', 'MES connector']);
    expect((await vera('GET', `/records/${doc.id}`)).document.appliesTo.map((a: any) => a.id)).toEqual([ih.id, mes.id]);
    const sd = (await vera('GET', `/services/${svc.id}`)).documents.find((d: any) => d.id === doc.id);
    expect(sd.applications.map((a: any) => a.name)).toEqual(['Insights Hub', 'MES connector']);
    const ad = await vera('GET', `/applications/${ih.id}`);
    expect(ad.documents).toEqual([expect.objectContaining({ id: doc.id, title: 'ICAM concept', reviewStatus: 'none', edition: null })]);
    expect(ad.documentCount).toBe(1);
    expect((await vera('GET', '/applications')).find((a: any) => a.id === ih.id).documentCount).toBe(1);
    // narrower scope
    await dana('PUT', `/records/${doc.id}/applications`, { applicationIds: [ih.id] });
    expect((await vera('GET', `/applications/${mes.id}`)).documents).toEqual([]);
    // only living documents; only applications that exist and are not archived
    const cr = await dana('POST', '/records', { type: 'CR', title: 'A change', fields: { reason: 'r', risk: 'low', rollbackPlan: 'p' } });
    expect((await body(dana('PUT', `/records/${cr.id}/applications`, { applicationIds: [ih.id] }))).code).toBe('RECORD_NOT_DOCUMENT');
    expect(await status(dana('PUT', `/records/${doc.id}/applications`, { applicationIds: ['app_missing'] }))).toBe(404);
    const old = (await dana('GET', '/applications?archived=1')).find((a: any) => a.name === 'Retired SCADA');
    expect((await body(dana('PUT', `/records/${doc.id}/applications`, { applicationIds: [old.id] }))).code).toBe('APPLICATION_ARCHIVED');
    expect(await status(dana('PUT', `/records/${doc.id}/applications`, { applicationIds: Array.from({ length: 51 }, (_, i) => `app_${i}`) }))).toBe(400);
    const e = (await audit('record', doc.id)).find((x: any) => x.action === 'record.scope_changed' && x.actor === 'olivia');
    expect(e.summary).toContain('applies to: "Insights Hub", "MES connector"');
  });

  it('the public API reads applications, ratings, protection needs and the scale', async () => {
    const token = (await vera('POST', '/me/tokens', { name: 'apps', scope: 'read' })).token;
    const v1 = async (url: string) => {
      const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json() };
    };
    const list = await v1('/applications?limit=200');
    expect(list.status).toBe(200);
    const ihEntry = list.body.items.find((a: any) => a.id === ih.id);
    expect(ihEntry).toMatchObject({ name: 'Insights Hub', vendor: 'Siemens', integrationCount: 1, documentCount: 1 });
    expect(ihEntry.rating.confidentiality).toMatchObject({ level: 'high', levelLabel: 'High', ratedBy: 'olivia' });
    expect(ihEntry.services).toEqual([{ id: svc.id, name: 'Plant monitoring', archived: false, role: 'primary', roleText: '' }]);
    const one = await v1(`/applications/${ih.id}`);
    expect(one.body.integrations).toHaveLength(1);
    expect(one.body.integrations[0]).not.toHaveProperty('path');
    expect((await v1('/applications/app_missing')).status).toBe(404);
    const docs = await v1(`/applications/${ih.id}/documents`);
    expect(docs.body.items.map((d: any) => d.title)).toEqual(['ICAM concept']);
    const scale = await v1('/cia-scale');
    expect(scale.body).toMatchObject({ mode: 'default' });
    expect(scale.body.levels.availability.map((l: any) => l.key)).toEqual(['normal', 'high', 'very_high']);
    const service = await v1(`/services/${svc.id}`);
    expect(service.body.applications.map((a: any) => a.name)).toEqual(['Industrial Edge', 'Insights Hub', 'MES connector']);
    expect(service.body.protectionNeed.integrity).toMatchObject({ derived: 'very_high', derivedLabel: 'Very high', effective: 'very_high' });
    expect(service.body.protectionNeed.availability.override).toMatchObject({ level: 'very_high', levelLabel: 'Very high' });
    const services = await v1('/services?limit=200');
    expect(services.body.items.find((x: any) => x.id === svc.id).applications).toHaveLength(3);
    const sdocs = await v1(`/services/${svc.id}/documents`);
    expect(sdocs.body.items.find((d: any) => d.title === 'ICAM concept').applications.map((a: any) => a.name)).toEqual(['Insights Hub']);
  });

  it('evidence packs of a service carry its protection need and the ratings of its applications', async () => {
    const from = new Date(Date.now() - 86400000).toISOString();
    const to = new Date(Date.now() + 60000).toISOString();
    let p = await s.api('POST', '/compliance/evidence-packs', { scope: { serviceId: svc.id }, from, to });
    for (let i = 0; i < 600 && p.status === 'building'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      p = await s.api('GET', `/compliance/evidence-packs/${p.id}`);
    }
    expect(p.status, p.error).toBe('ready');
    const cookie = await loginCookie(s.base, 'admin', 'Admin-password-1');
    const res = await fetch(`${s.base}/api/compliance/evidence-packs/${p.id}/download`, { headers: { ...authHeaders(cookie), 'x-sm-client': '1' } });
    const file = path.join(s.dataDir, 'apps-pack.zip');
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const { ZipReader } = await import('../src/compliance/zip.js');
    const zip = await ZipReader.open(file);
    const index = JSON.parse((await zip.read(zip.find('index.json')!)).toString());
    expect(index.catalogue.service.name).toBe('Plant monitoring');
    expect(index.catalogue.service.protectionNeed.availability).toMatchObject({
      effective: 'very_high',
      derived: 'normal',
      override: { level: 'very_high', reason: 'Cumulation: three plants depend on it at once' },
    });
    expect(index.catalogue.service.applications.find((a: any) => a.id === ih.id).rating.confidentiality).toMatchObject({
      level: 'high',
      label: 'High',
      justification: 'Production data of customers',
    });
    fs.rmSync(file, { force: true });
  });
});

describe('after the security review (#84)', () => {
  const needAudit = async (serviceId: string) => (await audit('service', serviceId)).filter((e: any) => e.action === 'service.protection_need_changed');

  it('L1: a service shows the applications it does not count, and its history says when an application change moved its need', async () => {
    const svc = await dana('POST', '/services', { name: 'Review service', owners: ['user:dana'] });
    const a = await s.api('POST', '/applications', { name: 'Review app A', owners: ['user:olivia'] });
    const b = await s.api('POST', '/applications', { name: 'Review app B', owners: ['user:olivia'] });
    await s.api('PUT', `/applications/${a.id}/rating`, { confidentiality: { level: 'very_high', justification: 'Secrets' } });
    await s.api('PUT', `/applications/${b.id}/rating`, { confidentiality: { level: 'normal', justification: 'Public' } });
    // adding a member is audited with the need it moves
    await dana('PUT', `/services/${svc.id}/applications/${b.id}`, {});
    await dana('PUT', `/services/${svc.id}/applications/${a.id}`, {});
    let e = await needAudit(svc.id);
    expect(e[0]).toMatchObject({
      details: { cause: 'membership', applicationId: a.id, changes: [{ dimension: 'confidentiality', from: 'normal', to: 'very_high' }] },
    });
    expect((await vera('GET', `/services/${svc.id}`)).protectionNeed.confidentiality).toMatchObject({ effective: 'very_high', total: 2, archived: 0 });
    // the owner of A (not of the service) archives it: the service says it is not counted, and its history why the need fell
    await olivia('POST', `/applications/${a.id}/archive`, { archived: true });
    expect((await vera('GET', `/services/${svc.id}`)).protectionNeed.confidentiality).toMatchObject({ effective: 'normal', total: 1, archived: 1, rated: 1 });
    e = await needAudit(svc.id);
    expect(e[0]).toMatchObject({ actor: 'olivia', details: { cause: 'application', applicationId: a.id, changes: [{ from: 'very_high', to: 'normal' }] } });
    expect(e[0].summary).toContain('archiving application "Review app A"');
    expect(e[0].summary).toContain('confidentiality Very high → Normal');
    await olivia('POST', `/applications/${a.id}/archive`, { archived: false });
    // lowering a rating
    await olivia('PUT', `/applications/${a.id}/rating`, { confidentiality: { level: 'high', justification: 'Less secret' } });
    e = await needAudit(svc.id);
    expect(e.map((x: any) => x.details.cause).slice(0, 2)).toEqual(['application', 'application']);
    expect(e[0].details.changes).toEqual([{ dimension: 'confidentiality', from: 'very_high', to: 'high' }]);
    // a change that does not move the need writes nothing on the service
    const n = e.length;
    await olivia('PUT', `/applications/${b.id}/rating`, { integrity: null, confidentiality: { level: 'normal', justification: 'Public data only' } });
    expect((await needAudit(svc.id)).length).toBe(n);
    // removing a member
    await dana('DELETE', `/services/${svc.id}/applications/${a.id}`);
    expect((await needAudit(svc.id))[0].details).toMatchObject({ cause: 'membership', changes: [{ from: 'high', to: 'normal' }] });
    // the public API and the evidence carry the archived count too
    await dana('PUT', `/services/${svc.id}/applications/${a.id}`, {});
    await olivia('POST', `/applications/${a.id}/archive`, { archived: true });
    const token = (await vera('POST', '/me/tokens', { name: 'review', scope: 'read' })).token;
    const res = await fetch(`${s.base}/api/v1/services/${svc.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await res.json()).protectionNeed.confidentiality).toMatchObject({ archived: 1, total: 1 });
  });

  it('L2: levels that stay but change their order need a confirmation and flag their ratings', async () => {
    const app = await s.api('POST', '/applications', { name: 'Reorder app' });
    await s.api('PUT', `/applications/${app.id}/rating`, {
      confidentiality: { level: 'high', justification: 'h' },
      integrity: { level: 'normal', justification: 'n' },
    });
    const swapped = [
      { key: 'normal', label: 'Normal', color: 'green' },
      { key: 'very_high', label: 'Very high', color: 'red' },
      { key: 'high', label: 'High', color: 'orange' },
    ];
    const refused = await body(s.api('PUT', '/catalogue/cia-scale', { mode: 'shared', levels: swapped }));
    expect(refused).toMatchObject({ code: 'CIA_REORDER_CONFIRM', params: { dimension: 'confidentiality' } });
    expect(refused.params.levels).toContain('high');
    expect((await s.api('GET', '/catalogue/cia-scale')).mode).toBe('default');
    await s.api('PUT', '/catalogue/cia-scale', { mode: 'shared', levels: swapped, confirmReorder: true });
    const r = (await vera('GET', `/applications/${app.id}`)).rating;
    expect(r.confidentiality).toMatchObject({ level: 'high', needsRerating: true, previousLabel: 'High' });
    // a level that kept its place keeps its ratings
    expect(r.integrity).toMatchObject({ level: 'normal', needsRerating: false });
    const entry = (await s.api('GET', '/audit?action=catalogue.cia_scale_changed&limit=1'))[0];
    // only levels in use count (no rating uses very_high in confidentiality)
    expect(entry.details.reordered.confidentiality).toContain('high');
    expect(entry.details.effects.confidentiality.reordered).toBeGreaterThan(0);
    // relabelling alone is recorded, nothing is flagged
    await s.api('PUT', `/applications/${app.id}/rating`, { integrity: { level: 'normal', justification: 'n2' } });
    await s.api('PUT', '/catalogue/cia-scale', { mode: 'shared', levels: swapped.map((l) => (l.key === 'normal' ? { ...l, label: 'Basic' } : l)) });
    expect((await vera('GET', `/applications/${app.id}`)).rating.integrity.needsRerating).toBe(false);
    expect((await s.api('GET', '/audit?action=catalogue.cia_scale_changed&limit=1'))[0].details.relabeled).toEqual(
      expect.arrayContaining([{ dimension: 'integrity', key: 'normal', from: 'Normal', to: 'Basic' }]),
    );
    await s.api('PUT', '/catalogue/cia-scale', { mode: 'default', confirmReorder: true });
    expect((await s.api('GET', '/catalogue/cia-scale')).mode).toBe('default');
  });

  it('L3: a stored scale that does not validate is not used (BSI default instead), and a package with one is refused', async () => {
    const { checkScaleRows } = await import('../src/catalogue/cia.js');
    const good = JSON.stringify([
      { key: 'low', label: 'Low', description: '', color: 'gray' },
      { key: 'high', label: 'High', description: '', color: 'red' },
    ]);
    expect(checkScaleRows([{ dimension: 'all', levels: good }])).toEqual([]);
    expect(checkScaleRows([{ dimension: 'all', levels: JSON.stringify([{ key: 'X Y', label: '', color: 'javascript:' }]) }]).length).toBeGreaterThan(0);
    expect(checkScaleRows([{ dimension: 'all', levels: '{not json' }])).toHaveLength(1);
    expect(checkScaleRows([{ dimension: 'secrecy', levels: good }])[0]).toContain('unknown dimension');
    expect(checkScaleRows([{ dimension: 'confidentiality', levels: good }])[0]).toContain('some dimensions only');
    expect(
      checkScaleRows([
        { dimension: 'all', levels: good },
        { dimension: 'integrity', levels: good },
      ]).join(),
    ).toContain('both a shared scale');
    const { db } = await import('../src/db.js');
    db().run('DELETE FROM cia_scales');
    db().run(
      'INSERT INTO cia_scales (dimension, levels, updated_at, updated_by) VALUES (?, ?, ?, ?)',
      'all',
      JSON.stringify([{ key: 'a', label: '<b>x</b>'.repeat(200), color: 'url(evil)' }, { key: 'b' }]),
      new Date().toISOString(),
      'import',
    );
    const scale = await vera('GET', '/catalogue/cia-scale');
    expect(scale).toMatchObject({ mode: 'default', storedInvalid: true });
    expect(scale.levels.confidentiality.map((l: any) => l.key)).toEqual(['normal', 'high', 'very_high']);
    // ratings and services keep working on the default
    expect((await vera('GET', '/services')).length).toBeGreaterThan(0);
    // an administrator saving a scale replaces it
    await s.api('PUT', '/catalogue/cia-scale', { mode: 'default' });
    expect(await s.api('GET', '/catalogue/cia-scale')).not.toHaveProperty('storedInvalid');
  });

  it('L4: attaching a document to an application is recorded on the application too', async () => {
    const svc = await dana('POST', '/services', { name: 'Scope review service', owners: [] });
    const app = await s.api('POST', '/applications', { name: 'Scoped by others', owners: ['user:olivia'] });
    const doc = await dana('POST', '/records', { type: 'DOC', title: 'Foreign concept', links: [{ kind: 'service', id: svc.id, note: '' }] });
    await dana('PUT', `/records/${doc.id}/applications`, { applicationIds: [app.id] });
    let e = (await audit('application', app.id)).find((x: any) => x.action === 'application.document_added');
    expect(e).toMatchObject({ actor: 'dana', details: { recordId: doc.id } });
    expect(e.summary).toContain('"Foreign concept" now applies to application "Scoped by others"');
    await dana('PUT', `/records/${doc.id}/applications`, { applicationIds: [] });
    e = (await audit('application', app.id)).find((x: any) => x.action === 'application.document_removed');
    expect(e.summary).toContain('no longer applies to application "Scoped by others"');
  });
});
