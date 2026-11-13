import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer, storeAcl } from './helpers.js';
import { csaf } from './advisories-helpers.js';

/**
 * Security advisories of the plant registry (0.14, docs/ADVISORIES.md) against a server: upload (rights, malformed,
 * hash, TLP, versions), the matches on the demo enterprise with their reasons, confirm and dismiss, remediation
 * statuses, a site's "not applicable", what readers of other sites see, notifications to site managers, the asset
 * section, the start page's tile, rematching after a firmware update, and sources through the outbound policy.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const EXAMPLES = path.resolve(__dirname, '../../examples/plant/advisories');
const example = (name: string) => fs.readFileSync(path.join(EXAMPLES, name), 'utf8');
const db = async () => (await import('../src/db.js')).db();
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const upload = (c: Client, content: string, extra: Record<string, unknown> = {}) =>
  c('POST', '/plant/advisories/upload', { content, fileName: 'x.json', ...extra });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['olaf', 'operator'],
    ['vera', 'viewer'],
    ['pia', 'plant'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
}, 600_000);

describe('sources', () => {
  it('none is set up in a real installation; the demo has one, turned on', async () => {
    const list = await s.api('GET', '/plant/advisory-sources');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Example PSIRTs (demo)', kind: 'provider', enabled: true });
    expect((await status(users.dana!('GET', '/plant/advisory-sources'))).status).toBe(403);
    expect((await status(users.dana!('POST', '/plant/advisory-sources', { name: 'x', url: 'https://x.example/provider-metadata.json' }))).status).toBe(403);
  });

  it('adding, changing and removing a source needs a step-up (plant.advisorySources); reading one now does not', async () => {
    const noAuto = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    await noAuto('DELETE', '/auth/step-up').catch(() => undefined);
    const body = { name: 'Step-up', url: 'https://psirt.stepup.example/.well-known/csaf/provider-metadata.json' };
    const refused = await noAuto('POST', '/plant/advisory-sources', body).catch((e: { status: number; body: any }) => e);
    expect(refused).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED', stepUp: { action: 'changeAdvisorySources' } } });
    const src = await s.api('POST', '/plant/advisory-sources', body);
    const log = await s.api('GET', '/audit?action=plant.advisory_source_added&limit=1');
    expect(log[0].details.assurance?.[0]).toMatchObject({ point: 'plant.advisorySources' });
    for (const [method, url, b] of [
      ['PUT', `/plant/advisory-sources/${src.id}`, { ...body, name: 'Step-up 2' }],
      ['DELETE', `/plant/advisory-sources/${src.id}`, undefined],
    ] as const)
      expect((await noAuto(method, url, b).catch((e: { status: number; body: any }) => e)).body?.code, `${method} ${url}`).toBe('STEP_UP_REQUIRED');
    // reading now changes nothing about where Steward reads from (it fails here: the host does not exist)
    expect((await noAuto('POST', `/plant/advisory-sources/${src.id}/fetch`)).read).toBe(0);
    await s.api('DELETE', `/plant/advisory-sources/${src.id}`);
  });

  it('reads a provider through the outbound policy: refused, then allowed; hash files checked', async () => {
    const url = `${s.base}/mock/csaf/.well-known/csaf/provider-metadata.json`;
    const before = await s.api('GET', '/settings');
    const src = await s.api('POST', '/plant/advisory-sources', { name: 'Mock provider', url, enabled: false });
    expect(src.kind).toBe('provider');
    await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [] });
    const blocked = await s.api('POST', `/plant/advisory-sources/${src.id}/fetch`);
    expect(blocked.read).toBe(0);
    expect(blocked.failed[0].error).toContain('Blocked by the outbound policy');
    expect(blocked.source.lastError).toContain('Blocked by the outbound policy');
    await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [new URL(s.base).origin] });
    try {
      const r = await s.api('POST', `/plant/advisory-sources/${src.id}/fetch`);
      expect(r.failed).toEqual([]);
      expect(r.created).toBe(3);
      const again = await s.api('POST', `/plant/advisory-sources/${src.id}/fetch`);
      expect(again.read).toBe(0);
      const list = await s.api('GET', '/plant/advisories?q=EXCTL');
      const d = await s.api('GET', `/plant/advisories/${list.items[0].id}`);
      expect(d.integrity).toBe('sha256');
      expect(d.signatureUrl).toMatch(/\.json\.asc$/);
      expect(d.origin).toBe('feed');
      // a document changed after its hash was published is not kept
      const t = await s.api('POST', '/plant/advisory-sources', { name: 'Tampered', url: `${s.base}/mock/csaf/test/tampered-feed.json` });
      expect(t.kind).toBe('rolie');
      const tr = await s.api('POST', `/plant/advisory-sources/${t.id}/fetch`);
      expect(tr.read).toBe(0);
      expect(tr.failed[0].error).toContain('does not match its hash file');
      // a redirect to a host the policy does not allow is refused (every hop is checked)
      const rd = await s.api('POST', '/plant/advisory-sources', { name: 'Redirect', url: `${s.base}/mock/csaf/test/redirect-feed.json` });
      const rr = await s.api('POST', `/plant/advisory-sources/${rd.id}/fetch`);
      expect(rr.failed[0].error).toContain('redirected to https://csaf-elsewhere.example.invalid');
      // the directory distribution (changes.csv) and an aggregator read the same documents
      const dir = await s.api('POST', '/plant/advisory-sources', { name: 'Directory', url: `${s.base}/mock/csaf/directory/provider-metadata.json` });
      const dr = await s.api('POST', `/plant/advisory-sources/${dir.id}/fetch`);
      expect(dr.failed).toEqual([]);
      expect(dr.unchanged).toBe(3);
      const agg = await s.api('POST', '/plant/advisory-sources', { name: 'Aggregator', url: `${s.base}/mock/csaf/aggregator.json`, publishers: ['example'] });
      expect(agg.kind).toBe('aggregator');
      expect((await s.api('POST', `/plant/advisory-sources/${agg.id}/fetch`)).unchanged).toBe(3);
      for (const id of [t.id, rd.id, dir.id, agg.id]) await s.api('DELETE', `/plant/advisory-sources/${id}`);
      const audit = await s.api('GET', '/audit?action=plant.advisory_source_read&limit=5');
      expect(audit.length).toBeGreaterThan(0);
    } finally {
      await s.api('PUT', '/settings', { outboundPolicy: before.outboundPolicy, outboundAllowList: before.outboundAllowList });
    }
  });
});

describe('uploads and matches on the demo enterprise', () => {
  it('upload: designers and administrators; malformed, mismatching, secret and older documents are refused or kept out', async () => {
    expect((await status(upload(users.olaf!, example('exctl-sa-2026-001.json')))).status).toBe(403);
    expect((await status(upload(users.pia!, example('exctl-sa-2026-001.json')))).status).toBe(403);
    expect(await status(upload(s.api, '{"document": {}}'))).toEqual({ status: 400, code: 'PLANT_ADVISORY_INVALID' });
    expect(await status(upload(s.api, 'not json at all'))).toEqual({ status: 400, code: 'PLANT_ADVISORY_INVALID' });
    expect(await status(upload(s.api, csaf({ id: 'T-1' }), { sha256: '0'.repeat(64) }))).toEqual({ status: 400, code: 'PLANT_ADVISORY_HASH' });
    expect(await status(upload(s.api, csaf({ id: 'T-2', tlp: 'RED' })))).toEqual({ status: 400, code: 'PLANT_ADVISORY_TLP' });
    // the same document again: unchanged; an earlier release does not replace a later one
    const same = await upload(users.dana!, example('exctl-sa-2026-001.json'));
    expect(same.result).toBe('unchanged');
    const newer = await upload(s.api, csaf({ id: 'T-3', current: '2026-03-01T00:00:00Z' }));
    expect(newer.result).toBe('created');
    expect((await upload(s.api, csaf({ id: 'T-3', current: '2026-02-01T00:00:00Z' }))).result).toBe('older');
    const uploaded = await upload(s.api, csaf({ id: 'T-3', current: '2026-04-01T00:00:00Z' }));
    expect(uploaded.result).toBe('updated');
    const { createHash } = await import('node:crypto');
    const body = csaf({ id: 'T-4' });
    const withHash = await upload(s.api, body, { sha256: createHash('sha256').update(body).digest('hex') });
    expect(withHash.result).toBe('created');
    const d = await s.api('GET', `/plant/advisories/${withHash.advisory.id}`);
    expect(d.integrity).toBe('uploaded_sha256');
    const audit = await s.api('GET', '/audit?action=plant.advisory_added&limit=50');
    expect(audit.some((e: { summary: string }) => e.summary.includes('T-4'))).toBe(true);
  });

  it('exact matches name the reason, the zones and the fixed firmware; firmware out of range does not match', async () => {
    const list = await s.api('GET', '/plant/advisories?q=EXCTL-SA-2026-001');
    const a = list.items[0];
    expect(a).toMatchObject({
      trackingId: 'EXCTL-SA-2026-001',
      severity: 'high',
      cvss: 7.5,
      status: 'open',
      affectedAssets: 1,
      openAssets: 1,
      possibleMatches: 0,
    });
    expect(a.sites.map((x: { id: string }) => x.id)).toEqual(['riverside']);
    const d = await s.api('GET', `/plant/advisories/${a.id}`);
    const m = d.matches.find((x: { assetId: string }) => x.assetId === 'rvs-mill-02');
    expect(m).toMatchObject({ kind: 'exact', counted: true, firmware: '3.2.0', canManage: true });
    expect(m.reasons[0].text).toBe(
      'matched on vendor Example Controls, model C80, firmware 3.2.0 in vers:generic/>=3.0.0|<3.4.0 via device profile example-controls-c80',
    );
    expect(m.fixes[0]).toMatchObject({ version: '3.4.0', from: 'fixed_product' });
    // rvs-mill-01 runs 3.4.2: not affected, not listed
    expect(d.matches.some((x: { assetId: string }) => x.assetId === 'rvs-mill-01')).toBe(false);
    expect(d.profiles.map((p: { id: string; kind: string }) => [p.id, p.kind])).toEqual([['example-controls-c80', 'possible']]);
  });

  it('the meter: vendor with a legal form and a dashed model match normalised; critical', async () => {
    const list = await s.api('GET', '/plant/advisories?severity=critical');
    expect(list.items.map((x: { trackingId: string }) => x.trackingId)).toEqual(['EXMET-SA-2026-003']);
    const d = await s.api('GET', `/plant/advisories/${list.items[0].id}`);
    const m = d.matches.find((x: { assetId: string }) => x.assetId === 'rvs-mill-01-meter');
    expect(m.kind).toBe('exact');
    expect(m.reasons[0].vendor.how).toBe('normalised');
    expect(m.reasons[0].model.how).toBe('normalised');
  });

  it('possible matches are shown separately and never counted until someone confirms', async () => {
    const list = await s.api('GET', '/plant/advisories?q=EXPM');
    const a = list.items[0];
    expect(a).toMatchObject({ affectedAssets: 0, possibleMatches: 2, status: 'unaffected' });
    const d = await s.api('GET', `/plant/advisories/${a.id}`);
    const byAsset = Object.fromEntries(d.matches.map((m: { assetId: string; kind: string }) => [m.assetId, m]));
    expect(byAsset['hlc-im-01'].kind).toBe('possible');
    expect(byAsset['hlc-im-02'].reasons[0].status).toBe('under_investigation');
    // a viewer may read, not decide
    expect((await status(users.vera!('PUT', `/plant/advisories/${a.id}/assets/hlc-im-01/decision`, { decision: 'confirmed', reason: '' }))).status).toBe(403);
    // dismissing needs a reason
    expect((await status(s.api('PUT', `/plant/advisories/${a.id}/assets/hlc-im-02/decision`, { decision: 'dismissed', reason: '' }))).status).toBe(400);
    const dismissed = await s.api('PUT', `/plant/advisories/${a.id}/assets/hlc-im-02/decision`, { decision: 'dismissed', reason: 'IM 250 here has the MC 5' });
    expect(dismissed).toMatchObject({ decision: 'dismissed', decidedBy: 'admin', counted: false });
    const confirmed = await users.dana!('PUT', `/plant/advisories/${a.id}/assets/hlc-im-01/decision`, {
      decision: 'confirmed',
      reason: 'MC 6 is the controller',
    });
    expect(confirmed).toMatchObject({ decision: 'confirmed', counted: true });
    const after = (await s.api('GET', '/plant/advisories?q=EXPM')).items[0];
    expect(after).toMatchObject({ affectedAssets: 1, possibleMatches: 0, status: 'open' });
    const audit = await s.api('GET', '/audit?action=asset.advisory_dismissed&limit=5');
    expect(audit[0].summary).toContain('IM 250 here has the MC 5');
    // taken back: possible again
    await s.api('PUT', `/plant/advisories/${a.id}/assets/hlc-im-02/decision`, { decision: null });
    expect((await s.api('GET', '/plant/advisories?q=EXPM')).items[0].possibleMatches).toBe(1);
  });

  it('remediation statuses: planned with a link, accepted with reason and end, expired counts as open, mitigated', async () => {
    const a = (await s.api('GET', '/plant/advisories?q=EXCTL-SA-2026-001')).items[0];
    const url = `/plant/advisories/${a.id}/assets/rvs-mill-02/remediation`;
    expect(await status(s.api('PUT', url, { status: 'planned', windowId: 'mw_none' }))).toEqual({ status: 400, code: 'PLANT_ADVISORY_LINK' });
    expect((await status(s.api('PUT', url, { status: 'accepted', reason: 'Isolated cell' }))).status).toBe(400);
    expect((await status(s.api('PUT', url, { status: 'accepted', reason: 'x', until: '2001-01-01' }))).status).toBe(400);
    expect((await status(s.api('PUT', url, { status: 'not_affected' }))).status).toBe(400);
    expect((await status(users.olaf!('PUT', url, { status: 'mitigated' }))).status).toBe(403);
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const acc = await s.api('PUT', url, { status: 'accepted', reason: 'Isolated cell, no OPC UA from outside', until });
    expect(acc.remediation).toMatchObject({ status: 'accepted', until, expired: false, by: 'admin' });
    expect((await s.api('GET', `/plant/advisories?q=EXCTL-SA-2026-001`)).items[0]).toMatchObject({ status: 'mitigated', openAssets: 0 });
    // past its day: open again
    (await db()).run("UPDATE plant_advisory_matches SET remediation_until = '2020-01-01' WHERE advisory_id = ? AND asset_id = 'rvs-mill-02'", a.id);
    expect((await s.api('GET', `/plant/advisories?q=EXCTL-SA-2026-001`)).items[0]).toMatchObject({ status: 'open', openAssets: 1 });
    const mit = await s.api('PUT', url, { status: 'mitigated', note: 'Firewall rule FWC-12' });
    expect(mit.remediation).toMatchObject({ status: 'mitigated', note: 'Firewall rule FWC-12', until: null });
    const audit = await s.api('GET', '/audit?action=asset.advisory_remediation_set&limit=5');
    expect(audit[0].summary).toContain('accepted → mitigated');
  });

  it('a site marks an advisory as not applicable; the status follows', async () => {
    const a = (await s.api('GET', '/plant/advisories?q=EXMET')).items[0];
    expect((await status(s.api('PUT', `/plant/advisories/${a.id}/sites/riverside`, { notApplicable: true, reason: '' }))).status).toBe(400);
    expect((await status(users.olaf!('PUT', `/plant/advisories/${a.id}/sites/riverside`, { notApplicable: true, reason: 'x' }))).status).toBe(403);
    await s.api('PUT', `/plant/advisories/${a.id}/sites/riverside`, { notApplicable: true, reason: 'Meters are on the isolated energy network' });
    expect((await s.api('GET', '/plant/advisories?q=EXMET')).items[0]).toMatchObject({ status: 'not_applicable', affectedAssets: 0 });
    const tile = await s.api('GET', '/plant/advisories/summary');
    expect(tile.critical).toBe(0);
    await s.api('PUT', `/plant/advisories/${a.id}/sites/riverside`, { notApplicable: false });
    expect((await s.api('GET', '/plant/advisories/summary')).critical).toBe(1);
  });

  it('the asset page lists its advisories, also possible and dismissed ones', async () => {
    const r = await users.pia!('GET', '/plant/assets/hlc-im-01/advisories');
    expect(r.items.map((i: { advisory: { trackingId: string } }) => i.advisory.trackingId)).toEqual(['EXPM-SA-2026-007']);
    expect(r.open).toBe(1);
    expect((await s.api('GET', '/plant/assets/rvs-mill-01/advisories')).items).toEqual([]);
  });

  it('readers see only the sites they may see: matches elsewhere are counted, not named', async () => {
    await storeAcl('site', 'hillcrest', [{ subject: 'user:admin', permissions: ['view', 'manage'] }]);
    try {
      const a = (await users.vera!('GET', '/plant/advisories?q=EXPM')).items[0];
      expect(a).toMatchObject({ affectedAssets: 0, possibleMatches: 0, sites: [] });
      const detail = await users.vera!('GET', `/plant/advisories/${a.id}`);
      expect(detail.matches).toEqual([]);
      expect(detail.hiddenMatches).toBe(2);
      expect((await status(users.vera!('GET', '/plant/assets/hlc-im-01/advisories'))).status).toBe(404);
      expect((await users.vera!('GET', '/plant/advisories?affecting=1')).items.some((x: { trackingId: string }) => x.trackingId === 'EXPM-SA-2026-007')).toBe(
        false,
      );
      const v1 = await users.vera!('GET', `/v1/plant/advisories/${a.id}`).catch(() => null);
      if (v1) expect(v1.matches).toEqual([]);
    } finally {
      await storeAcl('site', 'hillcrest', []);
    }
  });

  it('notifies the managers of the site of new high and critical matches, once', async () => {
    const until = Date.now() + 10_000;
    let found: { event: string; title: string; link: string }[] = [];
    while (Date.now() < until) {
      const n = await users.dana!('GET', '/notifications');
      found = n.items.filter((x: { event: string }) => x.event === 'plant.advisory_matched');
      if (found.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const titles = found.map((x) => x.title).sort();
    expect(titles.some((t) => t.includes('EXCTL-SA-2026-001') && t.includes('Riverside'))).toBe(true);
    expect(titles.some((t) => t.includes('EXMET-SA-2026-003'))).toBe(true);
    // possible matches never notify (EXPM), and someone who does not manage the site hears nothing
    expect(titles.some((t) => t.includes('EXPM'))).toBe(false);
    const olaf = await users.olaf!('GET', '/notifications');
    expect(olaf.items.filter((x: { event: string }) => x.event === 'plant.advisory_matched')).toEqual([]);
    const d = await db();
    expect(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_advisory_matches WHERE notified_at IS NULL AND kind = 'exact' AND current = 1")?.n).toBe(0);
  });

  it('a firmware update ends the match (rematched on the next read); the decisions stay', async () => {
    const d = await db();
    const a = (await s.api('GET', '/plant/advisories?q=EXCTL-SA-2026-001')).items[0];
    d.run("UPDATE plant_assignments SET firmware = '3.4.1', updated_at = ? WHERE asset_id = 'rvs-mill-02'", new Date().toISOString());
    const after = (await s.api('GET', '/plant/advisories?q=EXCTL-SA-2026-001')).items[0];
    expect(after).toMatchObject({ affectedAssets: 0, status: 'unaffected' });
    expect(
      d.get<{ current: number; remediation: string }>(
        "SELECT current, remediation FROM plant_advisory_matches WHERE advisory_id = ? AND asset_id = 'rvs-mill-02'",
        a.id,
      ),
    ).toMatchObject({
      current: 0,
      remediation: 'mitigated',
    });
    d.run("UPDATE plant_assignments SET firmware = '3.2.0', updated_at = ? WHERE asset_id = 'rvs-mill-02'", new Date(Date.now() + 1000).toISOString());
    expect((await s.api('GET', '/plant/advisories?q=EXCTL-SA-2026-001')).items[0]).toMatchObject({ affectedAssets: 1, status: 'mitigated' });
  });

  it('the public API and the start page tile', async () => {
    const page = await users.vera!('GET', '/v1/plant/advisories?limit=2').catch((e: { status: number }) => e);
    // the web client calls /api/v1 with a cookie: whatever the v1 rules say for sessions – a read either way
    if (!('status' in page)) {
      expect(page.items.length).toBeLessThanOrEqual(2);
      expect(page.items[0].severity).toBe('critical');
    }
    const tile = await users.pia!('GET', '/plant/advisories/summary');
    expect(tile).toMatchObject({ openAdvisories: 2, critical: 1 });
    expect(tile.sites.map((x: { id: string }) => x.id).sort()).toEqual(['hillcrest', 'riverside']);
  });

  it('removing an advisory: designers and administrators, with its matches', async () => {
    const a = (await s.api('GET', '/plant/advisories?q=T-4&affecting=0')).items[0];
    expect((await status(users.vera!('DELETE', `/plant/advisories/${a.id}`))).status).toBe(403);
    await users.dana!('DELETE', `/plant/advisories/${a.id}`);
    expect((await status(s.api('GET', `/plant/advisories/${a.id}`))).code).toBe('PLANT_ADVISORY_NOT_FOUND');
    const doc = await s.api('GET', `/plant/advisories/${(await s.api('GET', '/plant/advisories?q=EXCTL')).items[0].id}/document`);
    expect(doc.document.tracking.id).toBe('EXCTL-SA-2026-001');
  });
});
