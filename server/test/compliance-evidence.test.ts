import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/** Control catalogues, evidence coverage and audit evidence packs (contents, signature, tamper detection, limits). */

let s: TestServer;
let dana: Client, olivia: Client, audrey: Client, vera: Client;
let hub: string;
let check: any;
let c518: any, c82: any, c815: any;
const PW = 'Demo-password-1';
const cookies: Record<string, string> = {};
const now = () => new Date().toISOString();
const dayAgo = () => new Date(Date.now() - 86400000).toISOString();
const inAMinute = () => new Date(Date.now() + 60000).toISOString();

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ready(c: Client, id: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const p = await c('GET', `/compliance/evidence-packs/${id}`);
    if (p.status !== 'building') return p;
    await sleep(100);
  }
  throw new Error('pack not built');
}

async function download(user: string, url: string): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const res = await fetch(s.base + '/api' + url, { headers: { ...authHeaders(cookies[user]!), 'x-sm-client': '1' } });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, audrey, vera] = await Promise.all(['dana', 'olivia', 'audrey', 'vera'].map((u) => s.as(u, PW)));
  cookies.admin = await loginCookie(s.base, 'admin', 'Admin-password-1');
  for (const u of ['olivia', 'audrey']) cookies[u] = await loginCookie(s.base, u, PW);
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
  check = (await s.api('GET', '/compliance/access-checks')).find((c: any) => c.platformId === hub);
  // evidence: an undocumented admin grant documented after the fact, and a manual entry
  const r = await s.api('POST', '/compliance/demo/simulate-change', { accessCheckId: check.id });
  await olivia('POST', `/compliance/findings/${r.result.findings[0].id}/document`, { reason: 'Emergency access', performedBy: 'tenant admin' });
  await olivia('POST', '/compliance/access-changes', {
    platformId: hub,
    subjectId: 'svc-reader',
    kind: 'grant',
    rightsAfter: ['mdsp:core:StandardUser'],
    reason: 'Technical user for the historian',
    performedBy: 'olivia',
    performedAt: now(),
    document: true,
  });
}, 120_000);
afterAll(async () => {
  await s?.app.close();
});

describe('control catalogues', () => {
  it('ship ISO/IEC 27001, IEC 62443-2-1 and NIS2 with identifiers and short topic names only', async () => {
    const cats = await vera('GET', '/compliance/catalogues');
    expect(cats.map((c: any) => c.key)).toEqual(['IEC62443-2-1', 'ISO27001', 'NIS2']);
    expect(cats.find((c: any) => c.key === 'ISO27001').controlCount).toBe(93);
    const iso = await vera('GET', '/compliance/controls?catalogue=ISO27001');
    c518 = iso.find((c: any) => c.ref === '5.18');
    c82 = iso.find((c: any) => c.ref === '8.2');
    c815 = iso.find((c: any) => c.ref === '8.15');
    expect(c518.title).toBe('access rights');
    expect(c518.description).toBe('');
    // access change entries and the demo check are mapped to the access controls out of the box
    expect(c518.tags.map((t: any) => t.kind).sort()).toEqual(['accessCheck', 'recordType']);
  });

  it('only administrators manage catalogues; JSON, YAML and CSV imports', async () => {
    expect(await status(dana('POST', '/compliance/catalogues', { key: 'OWN', name: 'Own' }))).toBe(403);
    const csv = 'ref,title,description\n"A.1","Access reviews","Quarterly, by the owner"\nA.2,Logging,\n';
    expect(await status(dana('POST', '/compliance/catalogues/import', { key: 'OWN', name: 'Own', filename: 'own.csv', content: csv }))).toBe(403);
    const imp = await s.api('POST', '/compliance/catalogues/import', { key: 'OWN', name: 'Own controls', filename: 'own.csv', content: csv });
    expect(imp).toMatchObject({ added: 2, updated: 0, catalogue: { key: 'OWN', controlCount: 2, builtin: false } });
    const own = await s.api('GET', '/compliance/controls?catalogue=OWN');
    expect(own.find((c: any) => c.ref === 'A.1').description).toBe('Quarterly, by the owner');
    // licensed wording for a built-in control (YAML), merged by ref
    const yaml = 'controls:\n  - ref: "5.18"\n  - title: x\n';
    expect(await status(s.api('POST', '/compliance/catalogues/import', { catalogueId: c518.catalogueId, filename: 'x.yaml', content: yaml }))).toBe(400);
    const y = await s.api('POST', '/compliance/catalogues/import', {
      catalogueId: c518.catalogueId,
      filename: 'iso.yaml',
      content: 'controls:\n  - ref: "5.18"\n    title: access rights\n    description: Our licensed text\n',
    });
    expect(y).toMatchObject({ added: 0, updated: 1 });
    const j = await s.api('POST', '/compliance/catalogues/import', {
      filename: 'nis.json',
      content: JSON.stringify({ key: 'JS', name: 'From JSON', controls: [{ ref: '1', title: 'one' }] }),
    });
    expect(j.catalogue.key).toBe('JS');
    expect(await status(s.api('POST', '/compliance/catalogues/import', { key: 'BAD', filename: 'x.yaml', content: 'a: !!js/function "x"' }))).toBe(400);
    expect(await status(s.api('DELETE', `/compliance/catalogues/${c518.catalogueId}`))).toBe(409);
    expect(await status(s.api('DELETE', `/compliance/catalogues/${j.catalogue.id}`))).toBe(200);
  });

  it('designers and administrators map items to controls; everyone sees the coverage per period', async () => {
    const procs = await dana('GET', '/compliance/tag-targets?kind=process&q=privileged');
    expect(procs.length).toBe(1);
    expect(await status(olivia('POST', `/compliance/controls/${c82.id}/tags`, { kind: 'process', targetId: procs[0].id }))).toBe(403);
    expect(await status(dana('POST', `/compliance/controls/${c82.id}/tags`, { kind: 'process', targetId: 'prc_none' }))).toBe(404);
    const tagged = await dana('POST', `/compliance/controls/${c82.id}/tags`, { kind: 'process', targetId: procs[0].id });
    expect(tagged.tags.map((t: any) => t.label)).toContain(procs[0].label);
    const period = `from=${encodeURIComponent(dayAgo())}&to=${encodeURIComponent(inAMinute())}&catalogue=ISO27001`;
    const cov = await dana('GET', `/compliance/coverage?${period}`);
    const by = Object.fromEntries(cov.map((c: any) => [c.control.ref, c]));
    expect(by['5.18'].status).toBe('covered');
    expect(by['5.18'].counts.accessChange).toBeGreaterThanOrEqual(2);
    // the viewer may neither see the reconciliation check nor the access change entries: no evidence for them
    const viewer = Object.fromEntries((await vera('GET', `/compliance/coverage?${period}`)).map((c: any) => [c.control.ref, c]));
    expect(viewer['5.18'].counts.snapshot).toBeUndefined();
    expect(viewer['5.18'].counts.accessChange).toBeUndefined();
    const auditorCov = await audrey(
      'GET',
      `/compliance/coverage?from=${encodeURIComponent(dayAgo())}&to=${encodeURIComponent(inAMinute())}&catalogue=ISO27001`,
    );
    expect(auditorCov.find((c: any) => c.control.ref === '5.18').counts.snapshot).toBeGreaterThanOrEqual(2);
    expect(by['8.2'].status).toBe('covered'); // the access change type is mapped to 8.2 as well
    expect(by['8.15'].status).toBe('unmapped');
    // a control whose only item has no evidence in the period is a gap
    await dana('POST', `/compliance/controls/${c815.id}/tags`, { kind: 'process', targetId: procs[0].id });
    const gaps = await vera('GET', `/compliance/coverage?from=${encodeURIComponent(dayAgo())}&to=${encodeURIComponent(inAMinute())}&catalogue=ISO27001`);
    expect(gaps.find((c: any) => c.control.ref === '8.15').status).toBe('gap');
    expect((await dana('POST', `/compliance/controls/${c815.id}/tags/remove`, { kind: 'process', targetId: procs[0].id })).tags).toEqual([]);
    expect(await status(vera('GET', '/compliance/coverage?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z'))).toBe(400);
  });

  it('controls and their coverage are in the public API', async () => {
    const token = (await audrey('POST', '/me/tokens', { name: 'c', scope: 'read' })).token;
    const get = async (url: string) => (await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect((await get('/control-catalogues')).length).toBeGreaterThanOrEqual(3);
    const ctl = await get('/controls?catalogue=ISO27001&limit=200');
    expect(ctl.items).toHaveLength(93);
    const cov = await get(`/control-coverage?catalogue=ISO27001&limit=200&from=${encodeURIComponent(dayAgo())}&to=${encodeURIComponent(inAMinute())}`);
    expect(cov.items.find((c: any) => c.ref === '5.18').status).toBe('covered');
  });
});

describe('evidence packs', () => {
  let packFile: string;

  it('contain the evidence, an audit excerpt and a signed manifest that verifies offline', async () => {
    expect(await status(vera('POST', '/compliance/evidence-packs', { scope: { controlIds: [c518.id] }, from: dayAgo(), to: now() }))).toBe(403);
    expect(await status(s.api('POST', '/compliance/evidence-packs', { scope: { controlIds: [c518.id], platformId: hub }, from: dayAgo(), to: now() }))).toBe(
      400,
    );
    const p = await s.api('POST', '/compliance/evidence-packs', {
      title: 'Q4 access review evidence',
      scope: { controlIds: [c518.id, c82.id] },
      from: dayAgo(),
      to: inAMinute(),
    });
    expect(p.status).toBe('building');
    const done = await ready(s.api, p.id);
    expect(done).toMatchObject({ status: 'ready', canDownload: true, error: null });
    const dl = await download('admin', `/compliance/evidence-packs/${p.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/zip');
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment/);
    packFile = path.join(s.dataDir, 'pack-test.zip');
    fs.writeFileSync(packFile, dl.body);

    const { ZipReader } = await import('../src/compliance/zip.js');
    const { verifyPack } = await import('../src/compliance/evidence-verify.js');
    const zip = await ZipReader.open(packFile);
    const names = zip.entries.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'index.json',
        'index.pdf',
        'manifest.json',
        'manifest.sig',
        'public-key.pem',
        'audit/audit-log-excerpt.json',
        'audit/checkpoint.json',
      ]),
    );
    expect(names.some((n) => /^records\/AC-\d{4}-\d{4}\/AC-\d{4}-\d{4}\.pdf$/.test(n))).toBe(true);
    expect(names.some((n) => n.startsWith('reconciliation/') && n.endsWith('/findings.json'))).toBe(true);
    expect(names.some((n) => /reconciliation\/.*\/snapshot-\d+\.json$/.test(n))).toBe(true);
    expect(names).toContain('access-changes/access-changes.csv');
    const index = JSON.parse((await zip.read(zip.find('index.json')!)).toString());
    expect(index.controls.map((c: any) => `${c.catalogue} ${c.ref}`)).toEqual(['ISO27001 5.18', 'ISO27001 8.2']);
    expect(index.items.some((i: any) => i.kind === 'accessChange' && i.detail === 'afterTheFact')).toBe(true);
    expect((await zip.read(zip.find('index.pdf')!)).subarray(0, 5).toString()).toBe('%PDF-');
    const r = await verifyPack(packFile);
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ ok: true, signatureOk: true, audit: { present: true, ok: true } });
    expect(r.files.ok).toBe(r.files.listed);
    // the pack is signed with the key of the audit checkpoints
    const info = await s.api('GET', '/vault/info');
    expect(r.publicKey?.fingerprint).toBe(info.fingerprint);
    const audit = await s.api('GET', `/audit?entityType=evidence_pack&entityId=${p.id}`);
    expect(audit.map((e: any) => e.action)).toEqual(expect.arrayContaining(['evidence_pack.requested', 'evidence_pack.created', 'evidence_pack.downloaded']));
  });

  it('detects a changed, added or removed file and a changed manifest', async () => {
    const { ZipReader, ZipWriter } = await import('../src/compliance/zip.js');
    const { verifyPack } = await import('../src/compliance/evidence-verify.js');
    const rewrite = async (out: string, change: (name: string, data: Buffer) => Buffer | null, extra?: [string, Buffer]) => {
      const zip = await ZipReader.open(packFile);
      const w = await ZipWriter.create(out);
      for (const e of zip.entries) {
        const data = change(e.name, await zip.read(e, 512 * 1024 * 1024));
        if (data) await w.add(e.name, data, { compress: e.method === 8 });
      }
      if (extra) await w.add(extra[0], extra[1]);
      await w.finish();
      return verifyPack(out);
    };
    const t1 = path.join(s.dataDir, 't1.zip');
    const changed = await rewrite(t1, (n, d) => (n === 'access-changes/access-changes.csv' ? Buffer.concat([d, Buffer.from('forged\r\n')]) : d));
    expect(changed.ok).toBe(false);
    expect(changed.problems.join('\n')).toContain('access-changes/access-changes.csv was changed');
    const added = await rewrite(path.join(s.dataDir, 't2.zip'), (_n, d) => d, ['extra.txt', Buffer.from('x')]);
    expect(added.problems.join('\n')).toContain('extra.txt is in the pack but not in the signed manifest');
    const removed = await rewrite(path.join(s.dataDir, 't3.zip'), (n, d) => (n === 'index.pdf' ? null : d));
    expect(removed.problems.join('\n')).toContain('index.pdf is listed in the manifest but missing');
    const manifest = await rewrite(path.join(s.dataDir, 't4.zip'), (n, d) =>
      n === 'manifest.json' ? Buffer.from(d.toString().replace('"Q4 access review evidence"', '"Other"')) : d,
    );
    expect(manifest.signatureOk).toBe(false);
    // the command line check: exit 0 for the pack, 1 for the tampered copy
    const tsx = path.resolve(__dirname, '../../node_modules/.bin/tsx');
    const cli = path.resolve(__dirname, '../src/cli/evidence-verify.ts');
    const ok = spawnSync(tsx, [cli, packFile], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('The evidence pack is intact.');
    const bad = spawnSync(tsx, [cli, t1, '--json'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).ok).toBe(false);
    expect(spawnSync(tsx, [cli], { encoding: 'utf8' }).status).toBe(2);
  }, 60_000);

  it('hold only what the requester may see, and are theirs to download', async () => {
    const p = await olivia('POST', '/compliance/evidence-packs', { scope: { controlIds: [c518.id] }, from: dayAgo(), to: inAMinute() });
    const done = await ready(olivia, p.id);
    expect(done.status).toBe('ready');
    const dl = await download('olivia', `/compliance/evidence-packs/${p.id}/download`);
    const file = path.join(s.dataDir, 'olivia.zip');
    fs.writeFileSync(file, dl.body);
    const { ZipReader } = await import('../src/compliance/zip.js');
    const zip = await ZipReader.open(file);
    const index = JSON.parse((await zip.read(zip.find('index.json')!)).toString());
    expect(zip.find('audit/audit-log-excerpt.json')).toBeUndefined();
    expect(index.omitted.join('\n')).toContain('only auditors and administrators');
    // the auditor sees every pack, the viewer none; others cannot download someone else's pack
    expect((await audrey('GET', '/compliance/evidence-packs')).map((x: any) => x.id)).toContain(p.id);
    expect(await vera('GET', '/compliance/evidence-packs')).toEqual([]);
    expect((await download('audrey', `/compliance/evidence-packs/${p.id}/download`)).status).toBe(200);
    const admins = (await s.api('GET', '/compliance/evidence-packs')).find((x: any) => x.createdBy === 'admin');
    expect(await status(olivia('GET', `/compliance/evidence-packs/${admins.id}`))).toBe(404);
    expect((await download('olivia', `/compliance/evidence-packs/${admins.id}/download`)).status).toBe(404);
    expect(await status(audrey('DELETE', `/compliance/evidence-packs/${p.id}`))).toBe(403);
    expect(await status(olivia('DELETE', `/compliance/evidence-packs/${p.id}`))).toBe(200);
  });

  it('are size-limited, refuse long periods and expire', async () => {
    expect(await status(s.api('POST', '/compliance/evidence-packs', { scope: { platformId: hub }, from: '2020-01-01T00:00:00Z', to: now() }))).toBe(400);
    const mod = await import('../src/compliance/evidence-pack.js');
    const max = mod.PACK_LIMITS.maxBytes;
    mod.PACK_LIMITS.maxBytes = 50_000;
    try {
      const p = await s.api('POST', '/compliance/evidence-packs', { scope: { platformId: hub }, from: dayAgo(), to: inAMinute() });
      const done = await ready(s.api, p.id);
      expect(done.status).toBe('failed');
      expect(done.error).toMatch(/limit|exceed/);
      expect(fs.existsSync(path.join(mod.packsDir(), `${p.id}.zip`))).toBe(false);
    } finally {
      mod.PACK_LIMITS.maxBytes = max;
    }
    const p = await s.api('POST', '/compliance/evidence-packs', { scope: { platformId: hub }, from: dayAgo(), to: inAMinute() });
    expect((await ready(s.api, p.id)).status).toBe('ready');
    const { db } = await import('../src/db.js');
    db().run("UPDATE evidence_packs SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", p.id);
    mod.cleanupExpired(true);
    expect((await s.api('GET', `/compliance/evidence-packs/${p.id}`)).status).toBe('expired');
    expect(fs.existsSync(path.join(mod.packsDir(), `${p.id}.zip`))).toBe(false);
    expect((await download('admin', `/compliance/evidence-packs/${p.id}/download`)).status).toBe(409);
  });
});
