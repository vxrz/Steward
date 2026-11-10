import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlantDocHealth, PlantDocItem, PlantDocuments } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Documentation still current (0.14, docs/PLANT.md "Documentation still current"): "Still current" on a document and
 * on an asset's documentation as a whole (who and when, audited, not a change set), review intervals per site (its
 * settings) and per document type (the plant settings) that turn into gentle hints, the documentation health view of a
 * site (real gaps and hints, each linked), the rights, and the public API.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const example = (name: string) => ({ name, content: fs.readFileSync(path.resolve(__dirname, '../../examples/plant', name), 'utf8') });
const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };
const panel = (c: Client, kind: string, id: string) => c('GET', `/plant/documents?kind=${kind}&id=${encodeURIComponent(id)}`) as Promise<PlantDocuments>;
const docOf = (p: PlantDocuments, id: string): PlantDocItem => [p.own, ...p.inherited].flatMap((g) => g.documents).find((d) => d.id === id)!;
const YEAR = 365.25 * 86400000;
const ago = (years: number) => new Date(Date.now() - years * YEAR).toISOString();

let manual: { id: string; number: string };

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['olivia', 'operator'],
    ['vera', 'viewer'],
    ['pia', 'plant'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
  await s.api('PUT', '/settings/plant', SETTINGS);
  await s.api('POST', '/plant/import', {
    files: [example('brightwater.plant.yaml'), example('brightwater-data-points.plant.yaml'), example('brightwater-ot-network.plant.yaml')],
    mode: 'add',
  });
  manual = await s.api('POST', '/records', { type: 'DOC', title: 'Mill 1 operating manual', links: [{ kind: 'asset', id: 'rvs-mill-01', note: '' }] });
});

describe('still current', () => {
  it('confirms a document and the asset documentation as a whole: who and when, audited, no change set', async () => {
    let p = await panel(s.api, 'asset', 'rvs-mill-01');
    expect(p.canConfirm).toBe(true);
    expect(docOf(p, manual.id)).toMatchObject({ confirmation: null, review: null });
    expect(p.documentation).toEqual({ confirmation: null, review: null });
    const before = await s.api('GET', '/plant/assets/rvs-mill-01');
    const changeSets = (await s.api('GET', '/plant/change-sets')).length ?? 0;

    p = await users.olivia!('POST', '/plant/documents/confirm', { kind: 'record', id: manual.id, entry: { kind: 'asset', id: 'rvs-mill-01' } });
    expect(docOf(p, manual.id).confirmation).toEqual({ at: expect.any(String), by: 'olivia' });
    p = await users.olivia!('POST', '/plant/documents/confirm', { kind: 'asset', id: 'rvs-mill-01' });
    expect(p.documentation!.confirmation).toMatchObject({ by: 'olivia' });

    // a note, not a change of the entry: its revision stays, no change set
    expect((await s.api('GET', '/plant/assets/rvs-mill-01')).revision).toBe(before.revision);
    expect((await s.api('GET', '/plant/change-sets')).length ?? 0).toBe(changeSets);
    const audit = (await s.api('GET', '/audit?limit=20')) as { action: string; summary: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['plant.document_confirmed', 'plant.documentation_confirmed']));
    expect(audit.find((a) => a.action === 'plant.document_confirmed')!.summary).toContain(
      `Document ${manual.number} "Mill 1 operating manual" confirmed as still current`,
    );
  });

  it('who may propose on the site confirms; a viewer may not; a document not on the page is refused', async () => {
    expect(await status(users.vera!('POST', '/plant/documents/confirm', { kind: 'asset', id: 'rvs-mill-01' }))).toMatchObject({ status: 403 });
    expect((await panel(users.vera!, 'asset', 'rvs-mill-01')).canConfirm).toBe(false);
    // the plant viewer confirms the asset's documentation, but reads no records
    expect(await status(users.pia!('POST', '/plant/documents/confirm', { kind: 'asset', id: 'rvs-mill-01' }))).toEqual({ status: 200 });
    expect(
      await status(users.pia!('POST', '/plant/documents/confirm', { kind: 'record', id: manual.id, entry: { kind: 'asset', id: 'rvs-mill-01' } })),
    ).toEqual({ status: 404, code: 'PLANT_DOC_NOT_LISTED' });
    expect(await status(s.api('POST', '/plant/documents/confirm', { kind: 'record', id: manual.id, entry: { kind: 'asset', id: 'rvs-mill-02' } }))).toEqual({
      status: 404,
      code: 'PLANT_DOC_NOT_LISTED',
    });
    expect(await status(s.api('POST', '/plant/documents/confirm', { kind: 'record', id: manual.id }))).toEqual({ status: 400, code: 'PLANT_DOC_ENTRY' });
    // a hidden site reads like a missing one
    await s.api('PUT', '/plant/sites/riverside/access', { acl: [{ subject: 'user:dana', permissions: ['view', 'manage'] }] });
    try {
      expect(await status(users.olivia!('POST', '/plant/documents/confirm', { kind: 'asset', id: 'rvs-mill-01' }))).toMatchObject({ status: 404 });
    } finally {
      await s.api('PUT', '/plant/sites/riverside/access', { acl: [] });
    }
  });
});

describe('review intervals and hints', () => {
  it('the site’s interval (its settings) and the document type’s (plant settings) turn into a hint once due', async () => {
    expect(await status(users.olivia!('PUT', '/plant/sites/riverside/doc-review', { months: 36 }))).toMatchObject({ status: 403 });
    const site = await users.dana!('PUT', '/plant/sites/riverside/doc-review', { months: 36 });
    expect(site.docReviewMonths).toBe(36);
    let p = await panel(s.api, 'asset', 'rvs-mill-01');
    expect(docOf(p, manual.id).review).toMatchObject({ months: 36, due: false });
    expect(p.documentation!.review).toMatchObject({ months: 36, due: false });

    // confirmed four years ago: due (a hint)
    const { db } = await import('../src/db.js');
    db().run("UPDATE plant_doc_confirmations SET confirmed_at = ? WHERE target_id IN (?, 'rvs-mill-01')", ago(4), manual.id);
    p = await panel(s.api, 'asset', 'rvs-mill-01');
    expect(docOf(p, manual.id).review).toMatchObject({ months: 36, due: true });
    expect(p.documentation!.review!.due).toBe(true);
    // the type's interval wins over the site's; settings saved without it keep it
    await s.api('PUT', '/settings/plant', { ...SETTINGS, documentReview: { DOC: 120 } });
    await s.api('PUT', '/settings/plant', SETTINGS);
    expect((await s.api('GET', '/settings/plant')).documentReview).toEqual({ DOC: 120 });
    p = await panel(s.api, 'asset', 'rvs-mill-01');
    expect(docOf(p, manual.id).review).toMatchObject({ months: 120, due: false });
    expect(p.documentation!.review).toMatchObject({ months: 36, due: true });
    // confirming again clears the hint
    p = await s.api('POST', '/plant/documents/confirm', { kind: 'asset', id: 'rvs-mill-01' });
    expect(p.documentation!.review!.due).toBe(false);
    expect(await status(s.api('PUT', '/settings/plant', { ...SETTINGS, documentReview: { 'not a key': 3 } }))).toEqual({ status: 400, code: 'PLANT_DOC_TYPE' });
    const audit = JSON.stringify(await s.api('GET', '/audit?limit=50'));
    expect(audit).toContain('site.doc_review_changed');
  });
});

describe('documentation health of a site', () => {
  it('lists the real gaps and the confirmations that are due, each linked to where to fix it', async () => {
    // gaps: a device without a VLAN, a data path and a collection without a sink, a collection without items, a KPI the
    // machine could have but nobody collects
    await s.api('POST', '/plant/assets/rvs-mill-01/devices', { id: 'rvs-mill-01-hmi', hostname: 'rvs-mill-01-hmi' });
    await s.api('POST', '/plant/assets/rvs-mill-01/paths', { id: 'nowhere', subject: 'Alarms to nowhere', devices: ['rvs-mill-01-hmi'] });
    await s.api('POST', '/plant/assets/rvs-mill-01/collections', {
      id: 'empty',
      name: 'Empty collection',
      collector: { kind: 'job', ref: 'nobody' },
      items: [],
    });
    await s.api('PUT', '/plant/assets/rvs-mill-03/assignment', {
      profileId: 'example-controls-c80',
      interfaces: [{ interface: 'opc-ua', active: true, endpoint: 'opc.tcp://rvs-mill-03:4840' }],
    });
    const { db } = await import('../src/db.js');
    db().run("UPDATE plant_assets SET created_at = ? WHERE id = 'rvs-press-01'", ago(5));
    db().run("UPDATE plant_doc_confirmations SET confirmed_at = ? WHERE kind = 'record' AND target_id = ?", ago(11), manual.id);
    const h = (await s.api('GET', '/plant/sites/riverside/documentation')) as PlantDocHealth;
    const gap = (k: string) => h.gaps.find((g) => g.kind === k)!;
    const hint = (k: string) => h.hints.find((g) => g.kind === k)!;
    expect(h).toMatchObject({ siteId: 'riverside', reviewMonths: 36, typeMonths: { DOC: 120 }, canManage: true });
    expect(gap('assetNoProfile').items.map((x) => x.id)).toContain('rvs-press-01');
    expect(gap('assetNoProfile').items.map((x) => x.id)).not.toContain('rvs-mill-01');
    expect(gap('deviceNoVlan').items).toEqual([
      { id: 'rvs-mill-01/rvs-mill-01-hmi', name: 'rvs-mill-01-hmi', detail: expect.any(String), path: '/plant/sites/riverside/network/devices' },
    ]);
    expect(gap('pathNoSink').items.map((x) => x.id)).toEqual(['rvs-mill-01/nowhere']);
    expect(gap('collectionNoItems').items.map((x) => x.id)).toEqual(['rvs-mill-01/empty']);
    expect(gap('collectionNoSink').items.map((x) => x.id)).toEqual(['rvs-mill-01/empty']);
    expect(gap('collectionNoSink').items[0]!.path).toBe('/plant/assets/rvs-mill-01/collections?collection=empty');
    expect(gap('kpiNotCollected').items.map((x) => x.id)).toContain('rvs-mill-03/machine-state-time');
    // hints: an asset not confirmed for longer than the site's 3 years, the manual for longer than the DOC type's 10
    expect(hint('assetNotConfirmed').items.map((x) => x.id)).toContain('rvs-press-01');
    expect(hint('assetNotConfirmed').items.map((x) => x.id)).not.toContain('rvs-mill-01');
    expect(hint('documentNotConfirmed').items).toEqual([
      expect.objectContaining({ id: manual.id, path: '/plant/assets/rvs-mill-01#documents', confirmation: expect.objectContaining({ by: 'olivia' }) }),
    ]);
    expect(h.confirmed).toBe(1);
    // the plant viewer sees the gaps, not the documents; a hidden site is 404
    const pia = (await users.pia!('GET', '/plant/sites/riverside/documentation')) as PlantDocHealth;
    expect(pia.hints.find((g) => g.kind === 'documentNotConfirmed')!.total).toBe(0);
    expect(pia.canManage).toBe(false);
    await s.api('PUT', '/plant/sites/riverside/access', { acl: [{ subject: 'user:dana', permissions: ['view', 'manage'] }] });
    try {
      expect(await status(users.olivia!('GET', '/plant/sites/riverside/documentation'))).toMatchObject({ status: 404 });
    } finally {
      await s.api('PUT', '/plant/sites/riverside/access', { acl: [] });
    }
  });

  it('follows a renamed asset; a removed asset takes its confirmation along', async () => {
    await s.api('POST', '/plant/ids/rename', { kind: 'asset', scope: '', id: 'rvs-mill-01', newId: 'rvs-mill-1' });
    expect((await panel(s.api, 'asset', 'rvs-mill-1')).documentation!.confirmation).toMatchObject({ by: 'admin' });
    await s.api('POST', '/plant/documents/confirm', { kind: 'asset', id: 'rvs-test-bench-01' });
    await s.api('DELETE', '/plant/assets/rvs-test-bench-01');
    const { db } = await import('../src/db.js');
    expect(db().get("SELECT 1 FROM plant_doc_confirmations WHERE kind = 'asset' AND target_id = 'rvs-test-bench-01'")).toBeUndefined();
  });

  it('is in the public API, read-only', async () => {
    const t = await s.api('POST', '/me/tokens', { name: 'docs', scope: 'read' });
    const res = await fetch(`${s.base}/api/v1/plant/assets/rvs-mill-1/documentation`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ assetId: 'rvs-mill-1', confirmation: { by: 'admin' }, review: { months: 36, due: false }, hidden: 0 });
    expect(body.documents).toEqual([
      expect.objectContaining({
        id: manual.id,
        typeKey: 'DOC',
        inheritedFrom: null,
        confirmation: expect.objectContaining({ by: 'olivia' }),
        review: expect.objectContaining({ months: 120, due: true }),
      }),
    ]);
    const site = await (await fetch(`${s.base}/api/v1/plant/sites/riverside`, { headers: { authorization: `Bearer ${t.token}` } })).json();
    expect(site.docReviewMonths).toBe(36);
  });
});
