import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Evidence packs (security review round 3): the offline check trusts only a key the auditor got
 * from the installation (GOV-7), manifest signatures are domain-separated from audit checkpoints,
 * the ZIP reader accepts only well-formed archives, and a pack built by someone who cannot see
 * everything says so instead of reporting gaps (GOV-12).
 */

let s: TestServer;
let olivia: Client, audrey: Client;
let hub: string;
let packFile: string;
let g1: any;
const PW = 'Demo-password-1';
const cookies: Record<string, string> = {};
const dayAgo = () => new Date(Date.now() - 86400000).toISOString();
const inAMinute = () => new Date(Date.now() + 60000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tsx = path.resolve(__dirname, '../../node_modules/.bin/tsx');
const cli = path.resolve(__dirname, '../src/cli/evidence-verify.ts');
const verifyCli = (...args: string[]) => spawnSync(tsx, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

async function ready(c: Client, id: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const p = await c('GET', `/compliance/evidence-packs/${id}`);
    if (p.status !== 'building') return p;
    await sleep(100);
  }
  throw new Error('pack not built');
}

async function buildPack(user: 'admin' | 'olivia', c: Client, controlIds: string[], file: string): Promise<string> {
  const p = await c('POST', '/compliance/evidence-packs', { scope: { controlIds }, from: dayAgo(), to: inAMinute() });
  expect((await ready(c, p.id)).status).toBe('ready');
  const res = await fetch(`${s.base}/api/compliance/evidence-packs/${p.id}/download`, { headers: { ...authHeaders(cookies[user]!), 'x-sm-client': '1' } });
  expect(res.status).toBe(200);
  const out = path.join(s.dataDir, file);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

/** Rewrites a pack entry by entry (change returns the new content, or null to drop the entry). */
async function rewrite(src: string, out: string, change: (name: string, data: Buffer) => Buffer | null): Promise<string> {
  const { ZipReader, ZipWriter } = await import('../src/compliance/zip.js');
  const zip = await ZipReader.open(src);
  const w = await ZipWriter.create(out);
  for (const e of zip.entries) {
    const data = change(e.name, await zip.read(e, 512 * 1024 * 1024));
    if (data) await w.add(e.name, data, { compress: e.method === 8 });
  }
  await w.finish();
  return out;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [olivia, audrey] = await Promise.all(['olivia', 'audrey'].map((u) => s.as(u, PW)));
  cookies.admin = await loginCookie(s.base, 'admin', 'Admin-password-1');
  cookies.olivia = await loginCookie(s.base, 'olivia', PW);
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
  // a process Olivia may not see, with a run in the period, mapped to a control of its own
  const proc = await s.api('POST', '/processes', { definition: { name: 'Restricted evidence', steps: [{ id: 'a', type: 'set', values: { x: 1 } }] } });
  await s.api('PUT', `/processes/${proc.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['view', 'run'] }] });
  await s.waitRun((await s.api('POST', '/runs', { processId: proc.id })).id, ['succeeded']);
  const cat = await s.api('POST', '/compliance/catalogues/import', {
    key: 'GOV',
    name: 'Governance',
    filename: 'gov.csv',
    content: 'ref,title\nG.1,Restricted work\n',
  });
  g1 = (await s.api('GET', `/compliance/controls?catalogue=${cat.catalogue.key}`))[0];
  await s.api('POST', `/compliance/controls/${g1.id}/tags`, { kind: 'process', targetId: proc.id });
  const iso = await s.api('GET', '/compliance/controls?catalogue=ISO27001');
  await olivia('POST', '/compliance/access-changes', {
    platformId: hub,
    subjectId: 'svc-reader',
    kind: 'grant',
    rightsAfter: ['mdsp:core:StandardUser'],
    reason: 'Technical user',
    performedBy: 'olivia',
    performedAt: new Date().toISOString(),
    document: true,
  });
  packFile = await buildPack('admin', s.api, [iso.find((c: any) => c.ref === '5.18').id], 'trust.zip');
}, 180_000);
afterAll(async () => {
  await s?.app.close();
});

describe('GOV-7: the offline check trusts only a key the auditor got from the installation', () => {
  it('shows the installation fingerprint to auditors and exits 3 for a pack checked only against its own key', async () => {
    const { verifyPack } = await import('../src/compliance/evidence-verify.js');
    const anchoring = await audrey('GET', '/audit/anchoring');
    const r = await verifyPack(packFile);
    expect(r).toMatchObject({ ok: true, signatureOk: true, trusted: false });
    expect(r.publicKey?.fingerprint).toBe(anchoring.fingerprint);
    const plain = verifyCli(packFile);
    expect(plain.status, plain.stderr).toBe(3);
    expect(plain.stdout + plain.stderr).toContain('UNTRUSTED');
    expect(plain.stdout + plain.stderr).toContain(anchoring.fingerprint);
    const quiet = verifyCli(packFile, '--quiet');
    expect(quiet.status).toBe(3);
    expect(quiet.stdout + quiet.stderr).toContain('UNTRUSTED');
    const json = verifyCli(packFile, '--json');
    expect(json.status).toBe(3);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, trusted: false });
    expect(verifyCli(packFile, '--trust-pack-key').status).toBe(0);
    expect(verifyCli(packFile, '--fingerprint', anchoring.fingerprint).status).toBe(0);
    expect(verifyCli(packFile, '--fingerprint', '0000:0000:0000:0000:0000:0000:0000:0000').status).toBe(1);
    const pemFile = path.join(s.dataDir, 'installation.pem');
    fs.writeFileSync(pemFile, anchoring.publicKeyPem);
    const trusted = verifyCli(packFile, '--public-key', pemFile);
    expect(trusted.status, trusted.stderr).toBe(0);
    expect(trusted.stdout).toContain('The evidence pack is intact.');
  }, 60_000);

  it('a pack forged with another key is valid only for that untrusted key', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const { MANIFEST_SIGNATURE_DOMAIN } = await import('../src/compliance/evidence-verify.js');
    let manifest: any;
    const forged = await rewrite(packFile, path.join(s.dataDir, 'forged-stage.zip'), (n, d) => {
      if (n.startsWith('audit/')) return null;
      if (n === 'access-changes/access-changes.csv') return Buffer.concat([d, Buffer.from('forged\r\n')]);
      if (n === 'manifest.json') manifest = JSON.parse(d.toString());
      return d;
    });
    // recompute the manifest over the forged files and sign it with the attacker's key
    const { ZipReader, ZipWriter } = await import('../src/compliance/zip.js');
    const zip = await ZipReader.open(forged);
    const files: any[] = [];
    const out = await ZipWriter.create(path.join(s.dataDir, 'forged.zip'));
    for (const e of zip.entries) {
      if (['manifest.json', 'manifest.sig', 'public-key.pem'].includes(e.name)) continue;
      const data = await zip.read(e, 512 * 1024 * 1024);
      files.push({ path: e.name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
      await out.add(e.name, data);
    }
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const { publicKeyFingerprint, publicKeyPem } = await import('../src/vault.js');
    const bytes = Buffer.from(JSON.stringify({ ...manifest, keyFingerprint: publicKeyFingerprint(spki), files }, null, 2) + '\n');
    await out.add('manifest.json', bytes);
    await out.add(
      'manifest.sig',
      Buffer.from(crypto.sign(null, Buffer.concat([Buffer.from(MANIFEST_SIGNATURE_DOMAIN), bytes]), privateKey).toString('base64')),
    );
    await out.add('public-key.pem', Buffer.from(publicKeyPem(spki)));
    await out.finish();
    const file = path.join(s.dataDir, 'forged.zip');
    const r = verifyCli(file);
    expect(r.status).toBe(3);
    expect(r.stdout + r.stderr).toContain('UNTRUSTED');
    const anchoring = await audrey('GET', '/audit/anchoring');
    const pemFile = path.join(s.dataDir, 'installation2.pem');
    fs.writeFileSync(pemFile, anchoring.publicKeyPem);
    expect(verifyCli(file, '--public-key', pemFile).status).toBe(1);
    expect(verifyCli(file, '--fingerprint', anchoring.fingerprint).status).toBe(1);
  }, 60_000);
});

describe('manifest signatures are domain-separated from audit checkpoints', () => {
  it('signs a prefix plus the manifest; packs signed before the prefix still verify', async () => {
    const { ZipReader } = await import('../src/compliance/zip.js');
    const { MANIFEST_SIGNATURE_DOMAIN, verifyPack } = await import('../src/compliance/evidence-verify.js');
    const { verifySignature, vault } = await import('../src/vault.js');
    const zip = await ZipReader.open(packFile);
    const bytes = await zip.read(zip.find('manifest.json')!);
    const sig = (await zip.read(zip.find('manifest.sig')!)).toString().trim();
    const pub = (await zip.read(zip.find('public-key.pem')!)).toString();
    expect(JSON.parse(bytes.toString()).version).toBe(2);
    expect(verifySignature(pub, bytes, sig)).toBe(false);
    expect(verifySignature(pub, Buffer.concat([Buffer.from(MANIFEST_SIGNATURE_DOMAIN), bytes]), sig)).toBe(true);
    // a version 1 pack (signed without the prefix, before this change) still verifies
    let legacy: Buffer | null = null;
    const old = await rewrite(packFile, path.join(s.dataDir, 'legacy.zip'), (n, d) => {
      if (n === 'manifest.json') {
        legacy = Buffer.from(d.toString().replace('"version": 2', '"version": 1'));
        return legacy;
      }
      if (n === 'manifest.sig') return Buffer.from(vault().sign(legacy!) + '\n');
      return d;
    });
    const r = await verifyPack(old, { publicKey: pub });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('the ZIP reader accepts only well-formed archives', () => {
  const variants: [string, (b: Buffer) => Buffer][] = [
    [
      'bytes between the entries and the central directory',
      (b) => {
        const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        const cd = b.readUInt32LE(eocd + 16);
        const out = Buffer.concat([b.subarray(0, cd), Buffer.from('hidden payload'), b.subarray(cd)]);
        out.writeUInt32LE(cd + 14, eocd + 14 + 16);
        return out;
      },
    ],
    ['data after the end of the archive', (b) => Buffer.concat([b, Buffer.from('trailing')])],
    [
      'a local header that names another file than the central directory',
      (b) => {
        const i = b.indexOf(Buffer.from('index.json'));
        const out = Buffer.from(b);
        out.write('indey.json', i);
        return out;
      },
    ],
    [
      'two central directory entries for the same data',
      (b) => {
        const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        const cd = b.readUInt32LE(eocd + 16);
        const first = 46 + b.readUInt16LE(cd + 28) + b.readUInt16LE(cd + 30) + b.readUInt16LE(cd + 32);
        const dup = Buffer.from(b.subarray(cd, cd + first));
        const out = Buffer.concat([b.subarray(0, eocd), dup, b.subarray(eocd)]);
        const e = eocd + first;
        out.writeUInt16LE(out.readUInt16LE(e + 8) + 1, e + 8);
        out.writeUInt16LE(out.readUInt16LE(e + 10) + 1, e + 10);
        out.writeUInt32LE(out.readUInt32LE(e + 12) + first, e + 12);
        return out;
      },
    ],
  ];
  for (const [name, change] of variants)
    it(`rejects ${name}`, async () => {
      const { verifyPack } = await import('../src/compliance/evidence-verify.js');
      const file = path.join(s.dataDir, `zip-${name.replace(/\W+/g, '-')}.zip`);
      fs.writeFileSync(file, change(fs.readFileSync(packFile)));
      const r = await verifyPack(file, { trustPackKey: true });
      expect(r.ok).toBe(false);
      expect(r.problems.join('\n')).toMatch(/ZIP/);
      expect(verifyCli(file, '--trust-pack-key').status).toBe(1);
    });
});

describe('GOV-12: a pack built with limited permissions says so', () => {
  it('marks controls whose evidence the creator may not see as not visible, with the number of hidden items', async () => {
    const { ZipReader } = await import('../src/compliance/zip.js');
    const file = await buildPack('olivia', olivia, [g1.id], 'olivia-gov.zip');
    const zip = await ZipReader.open(file);
    const index = JSON.parse((await zip.read(zip.find('index.json')!)).toString());
    expect(index.filtered).toMatchObject({ complete: false, permissionsOf: 'olivia' });
    expect(index.controls[0]).toMatchObject({ ref: 'G.1', status: 'notVisible', count: 0, hidden: 1 });
    const manifest = JSON.parse((await zip.read(zip.find('manifest.json')!)).toString());
    expect(manifest.pack.filtered).toBe(true);
    const full = await buildPack('admin', s.api, [g1.id], 'admin-gov.zip');
    const fz = await ZipReader.open(full);
    const fi = JSON.parse((await fz.read(fz.find('index.json')!)).toString());
    expect(fi.filtered).toMatchObject({ complete: true });
    expect(fi.controls[0]).toMatchObject({ status: 'covered', count: 1, hidden: 0 });
  }, 60_000);

  it('the Controls page and the API say the same as the pack: not visible, with the number of hidden items (#21)', async () => {
    const q = `catalogue=GOV&from=${encodeURIComponent(dayAgo())}&to=${encodeURIComponent(inAMinute())}`;
    const [mine] = await olivia('GET', `/compliance/coverage?${q}`);
    expect(mine).toMatchObject({ status: 'notVisible', hidden: 1, evidence: [], counts: {} });
    const [all] = await s.api('GET', `/compliance/coverage?${q}`);
    expect(all).toMatchObject({ status: 'covered', hidden: 0 });
    expect(all.evidence).toHaveLength(1);
    // the read API, with Olivia's token
    const token = (await olivia('POST', '/me/tokens', { name: 'coverage', scope: 'read' })).token;
    const res = await fetch(`${s.base}/api/v1/control-coverage?${q}`, { headers: { authorization: `Bearer ${token}` } });
    const page = await res.json();
    expect(page.items).toEqual([expect.objectContaining({ ref: 'G.1', status: 'notVisible', hidden: 1, counts: {} })]);
  });

  it('a control without evidence for anyone stays a gap; one without mapped items is not mapped', async () => {
    const { coverageStatus } = await import('../src/compliance/controls.js');
    expect(coverageStatus(0, 0, 0)).toBe('unmapped');
    expect(coverageStatus(2, 0, 0)).toBe('gap');
    expect(coverageStatus(2, 0, 3)).toBe('notVisible');
    expect(coverageStatus(2, 1, 3)).toBe('covered');
  });
});
