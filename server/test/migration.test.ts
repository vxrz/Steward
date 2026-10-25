import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, authHeaders, loginCookie, quiesce, setup, startTestServer, startedUrl, type Client, type TestServer } from './helpers.js';
import { PG_TEST_URL } from './pg-env.js';

/**
 * Moving an instance (#51): export on an in-process source with the demo data, then import into fresh
 * targets started as child processes – SQLite through the web API (dry run, mapping, confirmation) and
 * PostgreSQL through the command line. Checks: the mapping is applied, the target's audit chain and the
 * imported history verify, credentials decrypt with the target's vault, stored files are intact, and
 * tampered or mismatching packages are refused.
 */
// The source is the desktop case – SQLite – also when the suite runs on PostgreSQL (each target chooses its database),
// so the PostgreSQL run covers SQLite → PostgreSQL.
delete process.env.SM_DATABASE_URL;
delete process.env.SM_DATABASE_SCHEMA;

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const SOURCE_PASS = 'correct horse battery';
const TARGET_PASS = 'target master passphrase';
const TRANSFER = 'transfer passphrase 2026';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-move-'));
const pkgFile = path.join(work, 'source.smig');
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

let s: TestServer;
let adminCookie = '';
/** What the source holds, to compare with the target */
const source = {
  secrets: new Map<string, unknown>(),
  files: new Map<string, string>(),
  fingerprint: '',
  auditEntries: 0,
  processOwner: { id: '', owner: '' },
  recordId: '',
  runId: '',
  waitingRunId: '',
};

async function rawExport(body: unknown, cookie = adminCookie): Promise<Response> {
  return fetch(`${s.base}/api/migration/export`, {
    method: 'POST',
    headers: { ...authHeaders(cookie), 'x-sm-client': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function filesBelow(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of ['artifacts', 'docs', 'reports', 'records', 'evidence-packs', 'branding']) {
    const walk = (p: string, rel: string) => {
      if (!fs.existsSync(p)) return;
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(p, e.name), `${rel}/${e.name}`);
        else if (e.isFile()) out.set(`${rel}/${e.name}`, sha(fs.readFileSync(path.join(p, e.name))));
      }
    };
    walk(path.join(dir, d), d);
  }
  return out;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  await quiesce();
  adminCookie = await loginCookie(s.base, ADMIN.username, ADMIN.password);
  // a stored file (record attachment) and an owner who is not the administrator
  const dana = await s.as('dana', 'Demo-password-1');
  const rec = await dana('POST', '/records', {
    type: 'CR',
    title: 'Moved record',
    fields: { reason: 'Move', risk: 'low', rollbackPlan: 'none' },
    body: 'Text',
  });
  source.recordId = rec.id;
  const danaCookie = await loginCookie(s.base, 'dana', 'Demo-password-1');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n'))]), 'offer.pdf');
  const up = await fetch(`${s.base}/api/records/${rec.id}/attachments`, {
    method: 'POST',
    headers: { ...authHeaders(danaCookie), 'x-sm-client': '1' },
    body: form,
  });
  expect(up.status).toBe(200);
  const procs = await s.api('GET', '/processes');
  const p = procs[0];
  await s.api('PUT', `/processes/${p.id}/access`, {
    owner: 'dana',
    acl: [
      { subject: 'user:olivia', permissions: ['view', 'run'] },
      { subject: 'team:service desk', permissions: ['view'] },
    ],
  });
  source.processOwner = { id: p.id, owner: 'dana' };
  // what is encrypted on the source, decrypted (to compare with the target)
  const { db } = await import('../src/db.js');
  const { vault } = await import('../src/vault.js');
  for (const r of db().all<{ id: string; secrets: string | null }>('SELECT id, secrets FROM platforms WHERE secrets IS NOT NULL'))
    source.secrets.set(r.id, vault().decrypt(r.secrets!));
  source.fingerprint = (await s.api('GET', '/audit/anchoring')).fingerprint;
  source.runId = (await s.api('GET', '/runs?status=succeeded&limit=1'))[0].id;
  // a run that waits for a decision: it must not carry on by itself on the target
  const hub = (await s.api('GET', '/platforms')).find((x: { kind: string }) => x.kind === 'insights-hub').id;
  const waiting = await s.waitRun((await s.api('POST', '/runs', { processId: 'ih-access-review-1-flag', bindings: { hub } })).id, ['waiting', 'failed']);
  expect(waiting.status).toBe('waiting');
  source.waitingRunId = waiting.id;
}, 180_000);

afterAll(async () => {
  await s?.app.close().catch(() => undefined);
  fs.rmSync(work, { recursive: true, force: true });
});

describe('export (source)', () => {
  it('is for administrators with the master passphrase, in a session', async () => {
    const vera = await loginCookie(s.base, 'vera', 'Demo-password-1');
    expect((await rawExport({ passphrase: SOURCE_PASS, transferPassphrase: TRANSFER }, vera)).status).toBe(403);
    const wrong = await rawExport({ passphrase: 'not the passphrase', transferPassphrase: TRANSFER });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe('WRONG_PASSPHRASE');
    const short = await rawExport({ passphrase: SOURCE_PASS, transferPassphrase: 'short' });
    expect((await short.json()).code).toBe('TRANSFER_PASSPHRASE_TOO_SHORT');
    const { createToken } = await import('../src/auth/tokens.js');
    const { findUserByName } = await import('../src/auth/users.js');
    const t = createToken(findUserByName(ADMIN.username)!.id, { name: 'x', scope: 'full' });
    const viaToken = await fetch(`${s.base}/api/migration/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: SOURCE_PASS, transferPassphrase: TRANSFER }),
    });
    expect(viaToken.status).toBe(403);
  });

  it('writes a signed, encrypted package once, audited', async () => {
    const res = await rawExport({ passphrase: SOURCE_PASS, transferPassphrase: TRANSFER });
    const r = await res.json();
    expect(res.status, JSON.stringify(r)).toBe(200);
    expect(r.fingerprint).toBe(source.fingerprint);
    const dl = await fetch(`${s.base}/api/migration/exports/${r.downloadId}/download`, { headers: authHeaders(adminCookie) });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="steward-.*\.smig"$/);
    const bytes = Buffer.from(await dl.arrayBuffer());
    expect(sha(bytes)).toBe(r.sha256);
    expect(bytes.subarray(0, 20).toString()).toBe('STEWARD-MIGRATION 1\n');
    // nothing readable in clear: no user names, no secrets
    expect(bytes.includes(Buffer.from('dana'))).toBe(false);
    fs.writeFileSync(pkgFile, bytes);
    expect((await fetch(`${s.base}/api/migration/exports/${r.downloadId}/download`, { headers: authHeaders(adminCookie) })).status).toBe(404);
    const [entry] = await s.api('GET', '/audit?action=instance.exported&limit=1');
    expect(entry.details.packageId).toBe(r.packageId);
    source.auditEntries = r.auditEntries;
    source.files = filesBelow(s.dataDir);
    expect([...source.files.keys()].some((f) => f.startsWith('records/'))).toBe(true);
  });

  it('refuses a wrong transfer passphrase, a changed package and content the manifest does not list', async () => {
    const { readPackage } = await import('../src/migration/import.js');
    const { openPackage, sealPackage } = await import('../src/migration/format.js');
    const { ZipReader, ZipWriter } = await import('../src/compliance/zip.js');
    await expect(readPackage(pkgFile, 'wrong transfer passphrase')).rejects.toMatchObject({ code: 'MIGRATION_PACKAGE_UNREADABLE' });
    const flipped = path.join(work, 'flipped.smig');
    const b = fs.readFileSync(pkgFile);
    b[b.length - 100] ^= 1;
    fs.writeFileSync(flipped, b);
    await expect(readPackage(flipped, TRANSFER)).rejects.toMatchObject({ code: 'MIGRATION_PACKAGE_UNREADABLE' });
    // re-packed by someone who knows the transfer passphrase but not the source's key
    const zip = path.join(work, 'plain.zip');
    await openPackage(pkgFile, TRANSFER, zip);
    const reader = await ZipReader.open(zip);
    const repack = async (name: string, change: (entry: string, data: Buffer) => Buffer | null, extra?: [string, Buffer]) => {
      const z = path.join(work, `${name}.zip`);
      const w = await ZipWriter.create(z);
      for (const e of reader.entries) {
        const data = change(e.name, await reader.read(e, 512 * 1024 * 1024));
        if (data) await w.add(e.name, data);
      }
      if (extra) await w.add(extra[0], extra[1]);
      await w.finish();
      const out = path.join(work, `${name}.smig`);
      await sealPackage(z, out, TRANSFER);
      return out;
    };
    const forged = await repack('forged', (n, d) =>
      n === 'manifest.json' ? Buffer.from(d.toString().replace('"productVersion": "', '"productVersion": "9')) : d,
    );
    await expect(readPackage(forged, TRANSFER)).rejects.toMatchObject({ code: 'MIGRATION_SIGNATURE_INVALID' });
    // the signature covers the purpose line too: a valid signature of the bare manifest (any other use of the key) is refused
    const { MANIFEST_SIGNATURE_PURPOSE, manifestSigningInput } = await import('../src/migration/format.js');
    const { publicKeyFingerprint } = await import('../src/vault.js');
    const k = crypto.generateKeyPairSync('ed25519');
    const pem = k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    let rekeyed = Buffer.alloc(0);
    const resign = (name: string, sign: (m: Buffer) => Buffer) =>
      repack(name, (n, d) => {
        if (n === 'manifest.json') {
          const m = JSON.parse(d.toString());
          m.source.publicKey = pem;
          m.source.fingerprint = publicKeyFingerprint(pem);
          return (rekeyed = Buffer.from(JSON.stringify(m, null, 1)));
        }
        if (n === 'signature.json')
          return Buffer.from(JSON.stringify({ alg: 'ed25519', publicKey: pem, signature: crypto.sign(null, sign(rekeyed), k.privateKey).toString('base64') }));
        return d;
      });
    await expect(readPackage(await resign('bare', (m) => m), TRANSFER)).rejects.toMatchObject({ code: 'MIGRATION_SIGNATURE_INVALID' });
    const prefixed = await readPackage(await resign('prefixed', manifestSigningInput), TRANSFER).catch((e: { code?: string }) => e);
    expect(prefixed).not.toMatchObject({ code: 'MIGRATION_SIGNATURE_INVALID' });
    if ('close' in prefixed) prefixed.close();
    expect(manifestSigningInput(Buffer.from('{}')).toString()).toBe(`${MANIFEST_SIGNATURE_PURPOSE}\n{}`);
    const smuggled = await repack('smuggled', (_n, d) => d, ['files/docs/extra.txt', Buffer.from('not listed')]);
    await expect(readPackage(smuggled, TRANSFER)).rejects.toMatchObject({ code: 'MIGRATION_PACKAGE_INVALID' });
    const changed = await repack('changed', (n, d) => (n.startsWith('files/records/') ? Buffer.concat([d, Buffer.from(' ')]) : d));
    await expect(readPackage(changed, TRANSFER)).rejects.toMatchObject({ code: 'MIGRATION_PACKAGE_INVALID' });
    // what a package unpacks to has an absolute ceiling
    process.env.SM_MIGRATION_MAX_UNPACKED_MB = '0.01';
    try {
      await expect(readPackage(pkgFile, TRANSFER)).rejects.toMatchObject({ code: 'MIGRATION_UNPACKED_TOO_LARGE' });
    } finally {
      delete process.env.SM_MIGRATION_MAX_UNPACKED_MB;
    }
    const ok = await readPackage(pkgFile, TRANSFER);
    try {
      expect(ok.history.ok).toBe(true);
      expect(ok.manifest.users.map((u) => u.username)).toEqual(expect.arrayContaining(['admin', 'dana', 'olivia']));
      expect(JSON.stringify(ok.manifest)).not.toContain('scrypt$'); // no password hashes
    } finally {
      ok.close();
    }
  });

  it('stops the source', async () => {
    await s.app.close();
    const { db } = await import('../src/db.js');
    db().close();
  });
});

// ---------- targets in their own processes ----------

interface Child {
  base: string;
  proc: ChildProcess;
  stop: () => Promise<void>;
}

function startChild(env: Record<string, string>): Promise<Child> {
  return new Promise((resolve, reject) => {
    const e: Record<string, string | undefined> = { ...process.env, SM_LOG_LEVEL: 'info', SM_PORT: '0', SM_DEMO: '1', ...env };
    if (!env.SM_DATABASE_URL) delete e.SM_DATABASE_URL;
    delete e.SM_DATABASE_SCHEMA;
    if (env.SM_DATABASE_SCHEMA) e.SM_DATABASE_SCHEMA = env.SM_DATABASE_SCHEMA;
    const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: path.join(ROOT, 'server'), env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const url = startedUrl(out);
      if (url) {
        resolve({
          base: url,
          proc,
          stop: () =>
            new Promise((r) => {
              proc.once('exit', () => r());
              proc.kill('SIGTERM');
            }),
        });
      }
    });
    proc.stderr!.on('data', (d) => (out += d.toString()));
    proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${out.slice(-3000)}`)));
    setTimeout(() => reject(new Error('server start timeout: ' + out.slice(-3000))), 60000);
  });
}

function client(base: string, cookie = '', key = ''): Client & { cookie: () => string; key: () => string } {
  let c = cookie;
  let k = key;
  const call = (async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + '/api' + url, {
      method,
      headers: {
        'x-sm-client': '1',
        ...(c ? { cookie: c } : {}),
        ...(k ? { 'x-sm-session': k } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) c = set.split(';')[0]!;
    const nk = res.headers.get('x-sm-session-key');
    if (nk) k = nk;
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`${method} ${url} → ${res.status}: ${text}`), { status: res.status, body: text });
    return text ? JSON.parse(text) : null;
  }) as Client & { cookie: () => string; key: () => string };
  call.cookie = () => c;
  call.key = () => k;
  return call;
}

/** Signs in through the mock identity provider of the child server (walking the redirects). */
async function ssoClient(base: string, providerId: string, login: string) {
  const start = await fetch(`${base}/api/auth/oidc/${providerId}/start`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location')!);
  authorize.pathname = authorize.pathname.replace(/\/authorize$/, '/authorize/approve');
  authorize.searchParams.set('login', login);
  const approve = await fetch(authorize, { redirect: 'manual' });
  const res = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual' });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const key = /localStorage\.setItem\("sm\.sessionKey","([^"]+)"\)/.exec(await res.text())![1]!;
  return client(base, cookie, key);
}

/** A new instance: vault, first administrator and the (mock) single sign-on provider, as in production. */
async function prepareTarget(c: Child): Promise<{ admin: ReturnType<typeof client>; providerId: string }> {
  const admin = client(c.base);
  await admin('POST', '/auth/setup', { passphrase: TARGET_PASS, username: 'admin', password: 'Target-admin-pw-1' });
  const { DEMO_OIDC } = await import('../src/mock/mockOidc.js');
  const p = await admin('POST', '/sso/providers', {
    displayName: 'Entra ID',
    type: 'entra',
    issuer: `${c.base}/mock/oidc`,
    clientId: DEMO_OIDC.clientId,
    clientSecret: DEMO_OIDC.clientSecret,
    clientAuth: 'client_secret_post',
    mappings: [{ claimValue: 'SM.Admins', roles: ['admin'], teams: [] }],
    autoProvision: true,
    syncRoles: true,
    enabled: true,
  });
  return { admin, providerId: p.id };
}

/** Decrypts the target's platform credentials with its own vault (the child is stopped). */
async function targetSecrets(dataDir: string, target: import('../src/db.js').DatabaseTarget): Promise<Map<string, unknown>> {
  const { Db } = await import('../src/db.js');
  const { Vault } = await import('../src/vault.js');
  const d = new Db(target, { migrate: false });
  try {
    const v = new Vault(path.join(dataDir, 'vault.json'));
    await v.unlock(TARGET_PASS);
    return new Map(
      d.all<{ id: string; secrets: string }>('SELECT id, secrets FROM platforms WHERE secrets IS NOT NULL').map((r) => [r.id, v.decrypt(r.secrets)]),
    );
  } finally {
    d.close();
  }
}

describe('import into SQLite through the web API', () => {
  const dataDir = path.join(work, 'target-sqlite');
  let child: Child;
  let max: ReturnType<typeof client>;
  let plan: any;
  let importId = '';

  beforeAll(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    child = await startChild({ SM_DATA_DIR: dataDir, SM_MASTER_PASSPHRASE: TARGET_PASS });
    const t = await prepareTarget(child);
    max = await ssoClient(child.base, t.providerId, 'a1f3'); // Max Admin signs in with single sign-on
  }, 120_000);
  afterAll(async () => {
    await child?.stop();
  });

  const upload = async (c: ReturnType<typeof client>, file: string, passphrase: string) => {
    const form = new FormData();
    form.append('transferPassphrase', passphrase);
    form.append('file', new Blob([new Uint8Array(fs.readFileSync(file))]), 'source.smig');
    const res = await fetch(`${child.base}/api/migration/imports/upload`, {
      method: 'POST',
      headers: { cookie: c.cookie(), 'x-sm-session': c.key(), 'x-sm-client': '1' },
      body: form,
    });
    return { status: res.status, body: await res.json() };
  };

  it('checks the package (dry run) and suggests a mapping', async () => {
    const wrong = await upload(max, pkgFile, 'wrong transfer passphrase');
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('MIGRATION_PACKAGE_UNREADABLE');
    const r = await upload(max, pkgFile, TRANSFER);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    plan = r.body;
    expect(plan.blocking).toEqual([]);
    // the target does not show the fingerprint to echo: the importer reads it on the source
    expect(plan.source).not.toHaveProperty('fingerprint');
    expect(plan.history.ok).toBe(true);
    expect(plan.history.entries).toBe(source.auditEntries);
    const admin = plan.users.find((u: any) => u.username === 'admin');
    // a local "admin" exists here as well: the source's "admin" can only become that account
    expect(admin.clash).toEqual({ username: 'admin', admin: true });
    expect(admin.suggestion).toMatchObject({ action: 'map', to: 'admin', confirm: false });
    expect(plan.paused.map((p: any) => p.label)).toEqual(expect.arrayContaining(['schedules']));
  });

  it('refuses an incomplete mapping, unconfirmed administrators and a wrong fingerprint', async () => {
    const apply = (body: unknown) => max('POST', `/migration/imports/staged/${plan.id}/apply`, body).catch((e) => e);
    const partial = await apply({ mapping: { users: {}, teams: {} }, confirmFingerprint: source.fingerprint });
    expect(partial.status).toBe(400);
    expect(partial.body).toContain('MIGRATION_MAPPING_INVALID');
    const users = Object.fromEntries(plan.users.map((u: any) => [u.username, u.suggestion]));
    const teams = Object.fromEntries(plan.teams.map((t: any) => [t.name, t.suggestion]));
    const unconfirmed = await apply({ mapping: { users, teams }, confirmFingerprint: source.fingerprint });
    expect(unconfirmed.body).toContain('confirm the decision');
    // the name "admin" is an account here: it cannot become an alias of another account (not even of an administrator)
    const shadow = await apply({
      mapping: { users: { ...users, admin: { action: 'map', to: 'max@contoso.example', confirm: true } }, teams },
      confirmFingerprint: source.fingerprint,
    });
    expect(shadow.body).toContain('is the name of an account here');
    const fp = await apply({ mapping: { users, teams }, confirmFingerprint: '0000:1111:2222:3333:4444:5555:6666:7777' });
    expect(fp.body).toContain('MIGRATION_FINGERPRINT_MISMATCH');
    // all 32 hex digits, read on the source
    const digits = source.fingerprint.replace(/:/g, '');
    const short = await apply({ mapping: { users, teams }, confirmFingerprint: digits.slice(0, 31) });
    expect(short.body).toContain('MIGRATION_FINGERPRINT_SHORT');
    const last = digits[31] === '0' ? '1' : '0';
    const off = await apply({ mapping: { users, teams }, confirmFingerprint: digits.slice(0, 31) + last });
    expect(off.body).toContain('MIGRATION_FINGERPRINT_MISMATCH');
    // still staged after refused attempts
    expect((await max('GET', `/migration/imports/staged/${plan.id}`)).packageId).toBe(plan.packageId);
  });

  it('imports with the mapping, audited, with the history verifiable', async () => {
    const users: Record<string, unknown> = {};
    for (const u of plan.users) users[u.username] = { action: 'create-sso', username: `${u.username}@contoso.example` };
    users.admin = { action: 'map', to: 'admin', confirm: true };
    users.olivia = { action: 'create-local' };
    users.adam = { action: 'archive' };
    const teams = Object.fromEntries(plan.teams.map((t: any) => [t.name, { action: 'create' }]));
    // as typed, with spaces and in capitals
    const typed = source.fingerprint.split(':').join(' : ').toUpperCase();
    const r = await max('POST', `/migration/imports/staged/${plan.id}/apply`, { mapping: { users, teams }, confirmFingerprint: typed });
    importId = r.importId;
    expect(r.historyEntries).toBe(source.auditEntries);
    expect(r.files).toBe(source.files.size);
    expect(r.temporaryPasswords.map((t: any) => t.username)).toEqual(['olivia']);
    // ownership and access follow the mapping; history keeps the source's names
    const p = await max('GET', `/processes/${source.processOwner.id}`);
    expect(p.owner).toBe('dana@contoso.example');
    expect(p.acl.map((e: any) => e.subject)).toEqual(['user:olivia', 'team:service desk']);
    const rec = await max('GET', `/records/${source.recordId}`);
    expect(rec.owner).toBe('dana@contoso.example');
    expect(rec.createdBy).toBe('dana');
    const list = await max('GET', '/users');
    const byName = (n: string) => list.find((u: any) => u.username === n);
    expect(byName('dana@contoso.example')).toMatchObject({ active: true, mustChangePassword: false, roles: ['designer'] });
    // a new single sign-on account belongs to the (only) provider here – no other provider can claim it
    expect(byName('dana@contoso.example').authSource).toBe((await max('GET', '/sso/providers'))[0].id);
    expect(byName('olivia')).toMatchObject({ active: true, mustChangePassword: true });
    expect(byName('adam')).toMatchObject({ active: false, roles: [] });
    expect(byName('max@contoso.example').roles).toEqual(['admin']);
    // automation starts paused; unfinished runs arrive cancelled (and are listed with it)
    expect((await max('GET', '/schedules')).every((x: any) => !x.enabled)).toBe(true);
    const waitingRun = await max('GET', `/runs/${source.waitingRunId}`);
    expect(waitingRun.status).toBe('cancelled');
    expect(waitingRun.error).toContain('not resumed here');
    expect(r.paused.map((p: any) => p.label)).toEqual(expect.arrayContaining([expect.stringMatching(/^unfinished runs/)]));
    // the audit chain of this instance, and the import entry
    const verify = await max('GET', '/audit/verify');
    expect(verify.ok, JSON.stringify(verify)).toBe(true);
    const [entry] = await max('GET', '/audit?action=instance.imported&limit=1');
    expect(entry.actor).toBe('max@contoso.example');
    expect(entry.details.packageSha256).toBe(sha(fs.readFileSync(pkgFile)));
    expect(entry.details.mapping).toEqual(
      expect.arrayContaining(['user admin → map admin', 'user dana → create-sso dana@contoso.example', 'user adam → archive adam']),
    );
    // the import record and the imported history verify
    const imp = await max('GET', `/migration/imports/${importId}`);
    expect(imp.verification.ok, JSON.stringify(imp.verification)).toBe(true);
    expect(imp.mapping.find((m: any) => m.source === 'dana')).toMatchObject({ action: 'create-sso', target: 'dana@contoso.example', sourceKind: 'local' });
    const history = await max('GET', `/migration/imports/${importId}/history?limit=500`);
    const fromDana = history.find((h: any) => h.actor === 'dana');
    expect(fromDana.actorNow).toBe('dana@contoso.example');
    // evidence that moved stays verifiable: the run protocol's seal is in the imported history
    const token = await max('POST', '/me/tokens', { name: 'check', scope: 'read' });
    const run = await (await fetch(`${child.base}/api/v1/runs/${source.runId}`, { headers: { authorization: `Bearer ${token.token}` } })).json();
    expect(run.protocol.recordedHash).toBeTruthy();
    expect(run.protocol.intact).toBe(true);
    // … and answers that rest on imported history say so
    expect(run.protocol.importedHistory).toEqual({ importId, sourceFingerprint: source.fingerprint });
    expect((await max('GET', `/records/${source.recordId}`)).importedHistory).toEqual({ importId, sourceFingerprint: source.fingerprint });
    // a second import is refused
    const again = await upload(max, pkgFile, TRANSFER);
    expect(again.body.blocking?.length ?? 0).toBeGreaterThan(0);
    await max('DELETE', `/migration/imports/staged/${again.body.id}`);
  });

  it('treats a former name as the same person (four-eyes) and keeps it from new accounts', async () => {
    const e = await max('POST', '/users', { username: 'dana', roles: ['viewer'] }).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.body).toContain('USERNAME_IS_ALIAS');
  });

  it('has the files and credentials of the source', async () => {
    await child.stop();
    const moved = filesBelow(dataDir);
    for (const [f, h] of source.files) expect(moved.get(f), f).toBe(h);
    const secrets = await targetSecrets(dataDir, { kind: 'sqlite', file: path.join(dataDir, 'service-manager.db') });
    expect(secrets.size).toBe(source.secrets.size);
    for (const [id, v] of source.secrets) expect(secrets.get(id)).toEqual(v);
    child = await startChild({ SM_DATA_DIR: dataDir, SM_MASTER_PASSPHRASE: TARGET_PASS });
  });

  it('does not resume imported runs after a restart', async () => {
    // the vault unlocks from SM_MASTER_PASSPHRASE after the start (recoverRuns runs then)
    for (let i = 0; i < 100 && (await fetch(`${child.base}/api/ready`)).status !== 200; i++) await new Promise((r) => setTimeout(r, 200));
    const admin = client(child.base); // a new port after the restart
    await admin('POST', '/auth/login', { username: 'admin', password: 'Target-admin-pw-1' });
    const run = await admin('GET', `/runs/${source.waitingRunId}`);
    expect(run.status).toBe('cancelled');
    const entries = await admin('GET', `/audit?runId=${source.waitingRunId}&limit=50`);
    expect(entries.filter((e: any) => /run\.(resumed|interrupted)/.test(e.action))).toEqual([]);
  });
});

describe.skipIf(!PG_TEST_URL)('import into PostgreSQL on the command line', () => {
  const dataDir = path.join(work, 'target-pg');
  const schema = `${process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc'}_move${process.pid}`;
  const pg = { SM_DATABASE_URL: PG_TEST_URL!, SM_DATABASE_SCHEMA: schema };
  const cli = (args: string[], input?: string) =>
    spawnSync(TSX, [path.join(ROOT, 'server/src/cli/migrate.ts'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      timeout: 300_000,
      env: { ...process.env, ...pg, SM_DATA_DIR: dataDir, NO_COLOR: '1', SM_MASTER_PASSPHRASE: '', SM_MASTER_PASSPHRASE_FILE: '' },
    });
  afterAll(async () => {
    const { Db } = await import('../src/db.js');
    const d = new Db({ kind: 'postgres', url: PG_TEST_URL!, schema }, { migrate: false });
    try {
      d.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      d.close();
    }
  });

  it('inspects, imports with a mapping file and verifies after the start', async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    let child = await startChild({ SM_DATA_DIR: dataDir, SM_MASTER_PASSPHRASE: TARGET_PASS, ...pg });
    await prepareTarget(child);
    await child.stop();
    const passFile = path.join(work, 'transfer.txt');
    fs.writeFileSync(passFile, TRANSFER + '\n');
    const template = path.join(work, 'mapping.json');
    const inspect = cli(
      ['inspect', pkgFile, '--mapping-template', template, '--transfer-passphrase-file', passFile, '--passphrase-stdin', '--json'],
      TARGET_PASS,
    );
    expect(inspect.status, inspect.stderr + inspect.stdout).toBe(0);
    const plan = JSON.parse(inspect.stdout).plan;
    expect(plan.source.fingerprint).toBeUndefined();
    expect(inspect.stdout).not.toContain(source.fingerprint);
    const mapping = JSON.parse(fs.readFileSync(template, 'utf8'));
    // without the confirmation of the administrators, the import is refused
    const refused = cli(
      ['import', pkgFile, '--mapping', template, '--fingerprint', source.fingerprint, '--transfer-passphrase-file', passFile, '--passphrase-stdin'],
      TARGET_PASS,
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('confirm');
    mapping.users.admin = { action: 'map', to: 'admin', confirm: true };
    fs.writeFileSync(template, JSON.stringify(mapping));
    const r = cli(
      [
        'import',
        pkgFile,
        '--mapping',
        template,
        '--fingerprint',
        source.fingerprint.toUpperCase(), // case does not matter
        '--transfer-passphrase-file',
        passFile,
        '--passphrase-stdin',
        '--json',
      ],
      TARGET_PASS,
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.historyEntries).toBe(source.auditEntries);
    const secrets = await targetSecrets(dataDir, { kind: 'postgres', url: PG_TEST_URL!, schema });
    for (const [id, v] of source.secrets) expect(secrets.get(id)).toEqual(v);
    child = await startChild({ SM_DATA_DIR: dataDir, SM_MASTER_PASSPHRASE: TARGET_PASS, ...pg });
    try {
      const admin = client(child.base);
      await admin('POST', '/auth/login', { username: 'admin', password: 'Target-admin-pw-1' });
      const verify = await admin('GET', '/audit/verify');
      expect(verify.ok, JSON.stringify(verify)).toBe(true);
      const [entry] = await admin('GET', '/audit?action=instance.imported&limit=1');
      expect(entry.actor).toMatch(/^cli:/);
      const imp = await admin('GET', `/migration/imports/${out.importId}`);
      expect(imp.verification.ok, JSON.stringify(imp.verification)).toBe(true);
      const p = await admin('GET', `/processes/${source.processOwner.id}`);
      expect(p.owner).toBe(mapping.users.dana.username ?? mapping.users.dana.to);
    } finally {
      await child.stop();
    }
    const moved = filesBelow(dataDir);
    for (const [f, h] of source.files) expect(moved.get(f), f).toBe(h);
  }, 600_000);
});
