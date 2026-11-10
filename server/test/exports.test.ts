import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPORT_PART_IDS } from '@sm/shared';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Scheduled exports to S3 (0.16.0, docs/EXPORTS.md, ADR 0027): the registry of parts, each part's files (and no secret
 * in any of them), module switches, permissions and the step-up, the run against the mock S3 with its manifest,
 * encryption with the backup key, the retention rule, the schedule, failures and the audit log.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

let s: TestServer;
let mockBase: string;
let storageId = '';
let service = '';
let olivia: Client;
const BUCKET = 'steward-exports';
const PASSPHRASE = 'an export passphrase of some length';
const MASTER = 'correct horse battery';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-export-test-'));
/** Secret values the installation holds – none may appear in an exported file. */
const secrets: string[] = ['demoSecretKey', PASSPHRASE, MASTER, ADMIN.password, 'Olivia-password-123', 'Olivia-own-password-456'];

const refused = (c: Client, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> =>
  c(method, url, body).then(
    () => {
      throw new Error(`${method} ${url} was not refused`);
    },
    (e: { status: number; body: any }) => e,
  );

const objects = async () => (await import('../src/mock/mockS3.js')).mockS3Objects(BUCKET);

async function idle(): Promise<void> {
  const { exportsIdle } = await import('../src/export/jobs.js');
  await exportsIdle();
}

const ALL_PARTS = [
  { id: 'costPlans', format: 'csv', fiscalYear: 'current' },
  { id: 'plant', format: 'yaml' },
  { id: 'services', format: 'csv' },
  { id: 'applications', format: 'csv' },
  { id: 'systems', format: 'csv' },
  { id: 'monitors', format: 'yaml' },
  { id: 'auditLog', format: 'csv', days: 2 },
];
const job = (extra: Record<string, unknown> = {}) => ({
  name: 'nightly-share',
  enabled: false,
  platformId: storageId,
  prefix: 'exports/',
  cron: '30 3 * * 1',
  timezone: 'Europe/Berlin',
  parts: ALL_PARTS,
  encrypt: false,
  keepRuns: 10,
  ...extra,
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  mockBase = `${s.base.replace(/\/$/, '')}/mock`;
  const p = await s.api('POST', '/platforms', {
    name: 'Export bucket',
    kind: 'generic',
    baseUrl: `${mockBase}/s3/${BUCKET}`,
    config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3' } }, variables: {}, http: { proxy: 'none' } },
    secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
  });
  storageId = p.id;
  await s.api('POST', '/users', { username: 'olivia', roles: ['operator'], password: 'Olivia-password-123' });
  // her own password (an administrator's first one must be changed before she can act)
  await (
    await s.as('olivia', 'Olivia-password-123')
  )('POST', '/auth/password', { current: 'Olivia-password-123', next: 'Olivia-own-password-456' });
  olivia = await s.as('olivia', 'Olivia-own-password-456');
  // the plant registry on (the demo loads its invented example enterprise)
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  // a service with a cost plan line and an entry in the current fiscal year
  service = (await s.api('POST', '/services', { name: 'Invented Billing Service', owners: [] })).id;
  const year = (await s.api('GET', `/costs/plans/${service}`)).fiscalYear as number;
  await s.api('POST', `/costs/plans/${service}/lines`, {
    title: 'Historian licence',
    category: 'licence',
    amount: '1200',
    currency: 'EUR',
    cadence: 'yearly',
    fiscalYear: year,
    vendor: 'Invented Historian GmbH',
  });
  await s.api('POST', `/costs/plans/${service}/entries`, {
    date: new Date().toISOString().slice(0, 10),
    amount: '300',
    currency: 'EUR',
    reference: 'INV-4711',
  });
  // a monitor with a heartbeat check: its secret must not be exported
  const m = await s.api('POST', '/monitors', {
    definition: {
      name: 'Nightly import',
      checks: [{ id: 'hb', name: 'Heartbeat', type: 'heartbeat', key: 'export.nightly', mode: 'maxAge', maxAgeSeconds: 600 }],
    },
  });
  for (const x of m.secrets ?? []) secrets.push(x.secret);
  // a monitor with credentials typed into it: an HTTP check's headers and URL, webhook outputs with keys in the URL
  await s.api('POST', '/monitors', {
    definition: {
      name: 'Historian API',
      checks: [
        {
          id: 'api',
          name: 'API',
          type: 'http',
          url: 'https://invented-user:invented-url-password@historian.example.invalid/health?site=north&access_token=invented-query-token-4711',
          headers: { Authorization: 'Basic aW52ZW50ZWQtYmFzaWMtY3JlZA==', 'X-Plant-Token': 'invented-header-token-0815', Accept: 'application/json' },
        },
      ],
      outputs: [
        { id: 'fn', type: 'webhook', url: 'https://invented-functions.example.invalid/api/notify?code=invented-function-key-2342&team=ops' },
        { id: 'slack', type: 'webhook', url: 'https://hooks.slack.com/services/T0INVENT/B0INVENT/invented-slack-path-secret' },
      ],
    },
  });
  secrets.push(
    'invented-url-password',
    'invented-query-token-4711',
    'aW52ZW50ZWQtYmFzaWMtY3JlZA==',
    'invented-header-token-0815',
    'invented-function-key-2342',
    'invented-slack-path-secret',
  );
  // an API token and a credential with a secret value
  secrets.push((await s.api('POST', '/me/tokens', { name: 'export-test', scope: 'read' })).token);
});
afterAll(async () => {
  (await import('../src/export/jobs.js')).stopExportJobs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the registry of exportable parts', () => {
  it('has every part once, with formats and a module where it belongs to one', async () => {
    const { EXPORT_PARTS, objectsCsv } = await import('../src/export/parts.js');
    expect(EXPORT_PARTS.map((p) => p.id)).toEqual([...EXPORT_PART_IDS]);
    for (const p of EXPORT_PARTS) expect(p.formats.length, p.id).toBeGreaterThan(0);
    expect(Object.fromEntries(EXPORT_PARTS.filter((p) => p.module).map((p) => [p.id, p.module]))).toEqual({ costPlans: 'costs', plant: 'plant' });
    // one column per key; formulas defused, lists joined
    expect(objectsCsv([{ a: '=1+1', b: ['x', 'y'] }, { c: { d: 1 } }])).toBe('\uFEFFa,b,c\r\n\'=1+1,"x; y",\r\n,,"{""d"":1}"\r\n');
  });
});

describe('redacting credentials typed into monitors', () => {
  it('redacts sensitive headers, user information, secret query values and webhook paths, and nothing else', async () => {
    const { redactCredentials, redactUrl } = await import('../src/export/redact.js');
    expect(redactUrl('https://a:b@host.example.invalid:8443/x?Signature=1&sig=2&page=3#top').text).toBe(
      'https://<redacted>@host.example.invalid:8443/x?Signature=<redacted>&sig=<redacted>&page=3#top',
    );
    expect(redactUrl('https://host.example.invalid/x?API_KEY=1&apikey=2&key=3&password=4&secret=5&client_secret=6&code=').text).toBe(
      'https://host.example.invalid/x?API_KEY=<redacted>&apikey=<redacted>&key=<redacted>&password=<redacted>&secret=<redacted>&client_secret=<redacted>&code=',
    );
    expect(redactUrl('https://discord.com/api/webhooks/1/invented').text).toBe('https://discord.com/<redacted>');
    expect(redactUrl('https://host.example.invalid/plain?site=north')).toEqual({ text: 'https://host.example.invalid/plain?site=north', hit: false });
    const r = redactCredentials({
      checks: [{ headers: { cookie: 'a=b', 'proxy-authorization': 'x', 'x-api-key': 'y', 'X-Auth-Password': 'z', 'Content-Type': 'text/plain' } }],
      outputs: [{ path: '/hook?token=t' }],
      name: 'A monitor with https://u:p@host.example.invalid in its description',
    });
    expect(r.value).toEqual({
      checks: [
        {
          headers: {
            cookie: '<redacted>',
            'proxy-authorization': '<redacted>',
            'x-api-key': '<redacted>',
            'X-Auth-Password': '<redacted>',
            'Content-Type': 'text/plain',
          },
        },
      ],
      outputs: [{ path: '/hook?token=<redacted>' }],
      name: 'A monitor with https://u:p@host.example.invalid in its description',
    });
    expect(r.paths).toEqual([
      'checks[0].headers.cookie',
      'checks[0].headers["proxy-authorization"]',
      'checks[0].headers["x-api-key"]',
      'checks[0].headers["X-Auth-Password"]',
      'outputs[0].path',
    ]);
  });
});

describe('the audit log part', () => {
  /** Runs a part on its own and returns its files and notes. */
  async function write(choice: Record<string, unknown>): Promise<{ files: Map<string, string>; notes: Record<string, unknown> }> {
    const { exportPart } = await import('../src/export/parts.js');
    const { runAs } = await import('../src/auth/context.js');
    const { EXPORT_USER } = await import('../src/export/jobs.js');
    const files = new Map<string, string>();
    const notes: Record<string, unknown> = {};
    let pauses = 0;
    await runAs(EXPORT_USER, () =>
      exportPart(String(choice.id))!.write(choice as never, {
        now: new Date(Date.now() + 1000),
        file: (name) => {
          files.set(name, '');
          return { write: async (text) => void files.set(name, files.get(name)! + text) };
        },
        pause: async () => void pauses++,
        note: (x) => void Object.assign(notes, x),
      }),
    );
    return { files, notes };
  }

  it('keeps the newest entries of the period when there are more than it may hold, and says so', async () => {
    const { partLimits } = await import('../src/export/parts.js');
    const { queryAudit } = await import('../src/audit.js');
    const all = queryAudit({ from: new Date(Date.now() - 2 * 86_400_000).toISOString(), sort: { key: 'time', dir: 'asc' }, limit: 5000 });
    expect(all.length).toBeGreaterThan(5);
    const whole = await write({ id: 'auditLog', format: 'jsonl', days: 2 });
    expect(whole.notes).toEqual({});
    const before = partLimits.auditEntries;
    partLimits.auditEntries = 3;
    try {
      const cut = await write({ id: 'auditLog', format: 'jsonl', days: 2 });
      const seqs = cut.files
        .get('audit-log.jsonl')!
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).seq);
      // the newest three, oldest first
      expect(seqs).toEqual(all.slice(-3).map((e) => e.seq));
      expect(cut.notes).toMatchObject({ truncated: true, entries: 3, firstEntryAt: all[all.length - 3]!.ts });
      const csv = await write({ id: 'auditLog', format: 'csv', days: 2 });
      expect(csv.files.get('audit-log.csv')!.split('\r\n').filter(Boolean)).toHaveLength(4);
    } finally {
      partLimits.auditEntries = before;
    }
  });
});

describe('defining an export', () => {
  it('is for administrators only, and asks for a step-up', async () => {
    expect((await refused(olivia, 'GET', '/exports')).status).toBe(403);
    expect((await refused(olivia, 'POST', '/exports', job())).status).toBe(403);
    const fresh = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    // the sign-in counts as a confirmation: end it, as a session some minutes old would have
    await fresh('DELETE', '/auth/step-up');
    const r = await refused(fresh, 'POST', '/exports', job());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('STEP_UP_REQUIRED');
    expect(r.body.stepUp.action).toBe('changeExports');
    expect(await refused(fresh, 'PUT', '/exports/exp_none', job())).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect(await refused(fresh, 'DELETE', '/exports/exp_none')).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect((await s.api('GET', '/exports')).jobs).toEqual([]);
  });

  it('checks the target, the parts and their formats, the name and the schedule', async () => {
    const plain = await s.api('POST', '/platforms', {
      name: 'Not S3 for exports',
      kind: 'generic',
      baseUrl: `${mockBase}/test`,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
    });
    const code = async (body: unknown) => (await refused(s.api, 'POST', '/exports', body)).body.code;
    expect(await code(job({ platformId: null }))).toBe('EXPORT_NO_STORAGE');
    expect(await code(job({ platformId: plain.id }))).toBe('BACKUP_NOT_S3');
    expect(await code(job({ parts: [{ id: 'plant', format: 'csv' }] }))).toBe('EXPORT_FORMAT_UNSUPPORTED');
    expect(await code(job({ parts: [ALL_PARTS[2], ALL_PARTS[2]] }))).toBe('EXPORT_PART_TWICE');
    expect(await code(job({ encrypt: true }))).toBe('EXPORT_NO_KEY');
    expect(await code(job({ name: 'audit-archives' }))).toBe('EXPORT_NAME_RESERVED');
    expect(await code(job({ cron: '0 0 3 * * 1' }))).toBe('CRON_FIVE_FIELDS');
    expect((await refused(s.api, 'POST', '/exports', job({ name: '../escape' }))).status).toBe(400);
    expect((await refused(s.api, 'POST', '/exports', job({ parts: [] }))).status).toBe(400);
    expect((await refused(s.api, 'POST', '/exports', job({ parts: [{ id: 'vault', format: 'yaml' }] }))).status).toBe(400);
  });
});

describe('an export run', () => {
  let id = '';
  const run = async (): Promise<any> => {
    const started = await s.api('POST', `/exports/${id}/run`, {});
    expect(started).toMatchObject({ status: 'running', trigger: 'manual', triggeredBy: 'admin' });
    await idle();
    return (await s.api('GET', `/exports/${id}/runs?limit=1`))[0];
  };

  it('writes readable files of every part with a manifest, and no secret', async () => {
    const created = await s.api('POST', '/exports', job());
    id = created.id;
    expect(created).toMatchObject({ name: 'nightly-share', running: false, lastRun: null, nextRunAt: null });
    const status = await s.api('GET', '/exports');
    expect(status.parts.map((p: any) => [p.id, p.available])).toEqual(EXPORT_PART_IDS.map((p) => [p, true]));
    expect(status.encryptionAvailable).toBe(false);

    const r = await run();
    expect(r.status, r.message).toBe('succeeded');
    expect(r.message).toBeNull();
    expect(r.folder).toMatch(/^exports\/nightly-share\/\d{8}T\d{6}Z\/$/);
    const objs = await objects();
    const names = r.files.map((f: any) => f.name).sort();
    const fy = names.find((n: string) => n.startsWith('cost-plan-lines-'))!.slice('cost-plan-lines-'.length);
    expect(names).toEqual(
      [
        'applications.csv',
        'audit-log.csv',
        `cost-entries-${fy}`,
        `cost-plan-lines-${fy}`,
        'manifest.json',
        'monitors.yaml',
        'plant-registry.yaml',
        'services.csv',
        'systems.csv',
      ].sort(),
    );
    const text = (name: string) => objs.get(`${r.folder}${name}`)!.body.toString('utf8');
    // each file with its content type (S3 consoles, presigned downloads and data tools read it)
    expect(objs.get(`${r.folder}services.csv`)!.contentType).toBe('text/csv; charset=utf-8');
    expect(objs.get(`${r.folder}manifest.json`)!.contentType).toBe('application/json');
    expect(objs.get(`${r.folder}monitors.yaml`)!.contentType).toBe('application/yaml');
    // the manifest names every other file with its size and SHA-256
    const manifest = JSON.parse(text('manifest.json'));
    expect(manifest).toMatchObject({ format: 'steward-export', v: 1, name: 'nightly-share', encrypted: false, skipped: [] });
    expect(manifest.parts.map((p: any) => p.id)).toEqual(ALL_PARTS.map((p) => p.id));
    expect(manifest.files).toHaveLength(names.length - 1);
    for (const f of manifest.files) {
      const body = objs.get(`${r.folder}${f.name}`)!.body;
      expect(crypto.createHash('sha256').update(body).digest('hex'), f.name).toBe(f.sha256);
      expect(body.length).toBe(f.bytes);
    }
    // what each part wrote
    const lines = text(`cost-plan-lines-${fy}`);
    expect(lines.startsWith('\uFEFFService id,Service,Fiscal year,Title')).toBe(true);
    expect(lines).toContain(`${service},Invented Billing Service,`);
    expect(lines).toContain('Historian licence');
    expect(lines).toContain('Invented Historian GmbH');
    expect(text(`cost-entries-${fy}`)).toContain('INV-4711');
    expect(text('plant-registry.yaml')).toMatch(/^# yaml-language-server: \$schema=/);
    expect(text('plant-registry.yaml')).toContain('Brightwater');
    expect(text('services.csv')).toContain('Invented Billing Service');
    expect(text('monitors.yaml')).toContain('key: export.nightly');
    // credentials typed into a monitor are redacted (the rest of it stays), and the manifest says where
    const monitors = text('monitors.yaml');
    expect(monitors).toContain('Authorization: <redacted>');
    expect(monitors).toContain('X-Plant-Token: <redacted>');
    expect(monitors).toContain('Accept: application/json');
    expect(monitors).toContain('https://<redacted>@historian.example.invalid/health?site=north&access_token=<redacted>');
    expect(monitors).toContain('https://invented-functions.example.invalid/api/notify?code=<redacted>&team=ops');
    expect(monitors).toContain('https://hooks.slack.com/<redacted>');
    const monitorsPart = manifest.parts.find((p: any) => p.id === 'monitors');
    expect(monitorsPart.notes.redactedCount).toBe(5);
    expect(monitorsPart.notes.redacted).toEqual(
      expect.arrayContaining([expect.stringMatching(/: checks\[0\]\.headers\.Authorization$/), expect.stringMatching(/: outputs\[1\]\.url$/)]),
    );
    expect(text('audit-log.csv')).toContain('export.job_created');
    // no secret in any file
    for (const [key, o] of objs) {
      const body = o.body.toString('utf8');
      for (const secret of secrets) expect(body.includes(secret), `${key} holds a secret`).toBe(false);
      // stored encrypted values never leave (the audit log names which secrets a platform has, never their values)
      expect(body).not.toMatch(/secret_enc|v1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:/);
    }
  });

  it('leaves out a part whose module is switched off, and says so', async () => {
    await s.api('PUT', '/settings/plant', { enabled: false, enterprise: 'Brightwater Components', labels: {}, fields: {} });
    await s.api('PUT', '/settings/modules/costs', { enabled: false });
    try {
      const st = await s.api('GET', '/exports');
      expect(st.parts.filter((p: any) => !p.available).map((p: any) => p.id)).toEqual(['costPlans', 'plant']);
      const r = await run();
      expect(r.status).toBe('succeeded');
      expect(r.message).toMatch(/Not exported: costPlans \(the module costs is switched off\), plant \(the module plant is switched off\)/);
      expect(r.files.some((f: any) => /^(cost-|plant-)/.test(f.name))).toBe(false);
      const manifest = JSON.parse((await objects()).get(`${r.folder}manifest.json`)!.body.toString('utf8'));
      expect(manifest.skipped.map((x: any) => x.part)).toEqual(['costPlans', 'plant']);
    } finally {
      await s.api('PUT', '/settings/modules/costs', { enabled: true });
      await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
    }
  });

  it('encrypts every file with the backup key when asked to', async () => {
    await s.api('PUT', '/backups/passphrase', { passphrase: PASSPHRASE });
    expect((await s.api('GET', '/exports')).encryptionAvailable).toBe(true);
    await s.api('PUT', `/exports/${id}`, job({ encrypt: true, parts: [ALL_PARTS[2], ALL_PARTS[0]] }));
    const r = await run();
    expect(r.status, r.message).toBe('succeeded');
    expect(r.files.every((f: any) => f.name.endsWith('.smbackup'))).toBe(true);
    const objs = await objects();
    const { decryptFile, deriveBackupKey, readHeader } = await import('../src/backup/crypto.js');
    const file = path.join(tmp, 'services.smbackup');
    fs.writeFileSync(file, objs.get(`${r.folder}services.csv.smbackup`)!.body);
    expect(objs.get(`${r.folder}services.csv.smbackup`)!.body.includes(Buffer.from('Invented Billing Service'))).toBe(false);
    expect(objs.get(`${r.folder}services.csv.smbackup`)!.contentType).toBe('application/octet-stream');
    const { header } = await readHeader(file);
    expect(header.info).toMatchObject({ content: 'export', file: 'services.csv' });
    const key = await deriveBackupKey(PASSPHRASE, header.kdf);
    await decryptFile(file, path.join(tmp, 'services.csv'), key);
    const plain = fs.readFileSync(path.join(tmp, 'services.csv'));
    expect(plain.toString('utf8')).toContain('Invented Billing Service');
    // the SHA-256 in the run (and the manifest) is the one of the content
    expect(crypto.createHash('sha256').update(plain).digest('hex')).toBe(r.files.find((f: any) => f.name === 'services.csv.smbackup').sha256);
    // the offline tool reads it too
    const { runBackupCli } = await import('../src/cli/backup.js');
    const pf = path.join(tmp, 'pass.txt');
    fs.writeFileSync(pf, `${PASSPHRASE}\n`);
    fs.writeFileSync(path.join(tmp, 'manifest.smbackup'), objs.get(`${r.folder}manifest.json.smbackup`)!.body);
    expect(
      await runBackupCli(['decrypt', path.join(tmp, 'manifest.smbackup'), '--out', path.join(tmp, 'manifest.json'), '--passphrase-file', pf], 'backup'),
    ).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ encrypted: true, keyId: header.keyId });
    expect(manifest.files.map((f: any) => f.name).sort()).toEqual(
      r.files
        .filter((f: any) => f.part !== 'manifest')
        .map((f: any) => f.name)
        .sort(),
    );
  });

  it('keeps the newest runs and removes only the files of older runs', async () => {
    const objs = await objects();
    objs.set('exports/nightly-share/notes.txt', { body: Buffer.from('not an export'), meta: {}, lastModified: new Date() });
    await s.api('PUT', `/exports/${id}`, job({ keepRuns: 2, parts: [ALL_PARTS[2]] }));
    const before = (await s.api('GET', `/exports/${id}/runs`)).filter((x: any) => x.status === 'succeeded');
    const r = await run();
    expect(r.status).toBe('succeeded');
    const runs = (await s.api('GET', `/exports/${id}/runs`)).filter((x: any) => x.status === 'succeeded');
    expect(runs.slice(0, 2).every((x: any) => !x.pruned)).toBe(true);
    expect(runs.slice(2).every((x: any) => x.pruned)).toBe(true);
    for (const old of runs.slice(2)) for (const f of old.files) expect(objs.has(f.key), f.key).toBe(false);
    for (const kept of runs.slice(0, 2)) for (const f of kept.files) expect(objs.has(f.key), f.key).toBe(true);
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(objs.has('exports/nightly-share/notes.txt')).toBe(true);
  });

  it('runs on its schedule', async () => {
    const jobs = await import('../src/export/jobs.js');
    await s.api('PUT', `/exports/${id}`, job({ enabled: true, keepRuns: 2, parts: [ALL_PARTS[4]] }));
    jobs.startExportJobs();
    const j = await s.api('GET', `/exports/${id}`);
    expect(j.nextRunAt).toEqual(expect.any(String));
    const scheduled = jobs.scheduledExports();
    expect(scheduled.map((x) => x.jobId)).toEqual([id]);
    scheduled[0]!.cron.trigger();
    await new Promise((r) => setTimeout(r, 50));
    await idle();
    const last = (await s.api('GET', `/exports/${id}/runs?limit=1`))[0];
    expect(last).toMatchObject({ trigger: 'schedule', triggeredBy: null, status: 'succeeded' });
    await s.api('PUT', `/exports/${id}`, job({ enabled: false, keepRuns: 2, parts: [ALL_PARTS[4]] }));
    expect(jobs.scheduledExports()).toEqual([]);
  });

  it('fails when whoever manages its platform redirected the target, until an administrator confirms it again', async () => {
    // a platform whose management is delegated to a non-administrator (key rotation by a storage team)
    const delegated = await s.api('POST', '/platforms', {
      name: 'Export bucket, delegated',
      kind: 'generic',
      baseUrl: `${mockBase}/s3/${BUCKET}`,
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3' } }, variables: {}, http: { proxy: 'none' } },
      secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
    });
    await s.api('PUT', `/platforms/${delegated.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['view', 'use', 'manage'] }] });
    await s.api('PUT', `/exports/${id}`, job({ platformId: delegated.id, parts: [ALL_PARTS[2]] }));
    expect((await s.api('GET', `/exports/${id}`)).targetChanged).toBe(false);
    expect((await run()).status).toBe('succeeded');

    // a new access key id alone counts (the secret itself is never part of the fingerprint) …
    await olivia('PUT', `/platforms/${delegated.id}/secrets`, { accessKeyId: 'AKIAINVENTEDOTHER', secretAccessKey: 'another-secret-value' });
    expect((await s.api('GET', `/exports/${id}`)).targetChanged).toBe(true);
    // … and setting the confirmed key again restores the target
    await olivia('PUT', `/platforms/${delegated.id}/secrets`, { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' });
    expect((await s.api('GET', `/exports/${id}`)).targetChanged).toBe(false);

    // the platform now names another bucket: the run fails before it writes or lists anything
    await olivia('PUT', `/platforms/${delegated.id}`, { baseUrl: `${mockBase}/s3/invented-other-bucket` });
    expect((await s.api('GET', `/exports/${id}`)).targetChanged).toBe(true);
    const r = await run();
    expect(r).toMatchObject({ status: 'failed', files: [], folder: null });
    expect(r.message).toMatch(/S3 target of the export changed/);
    expect((await import('../src/mock/mockS3.js')).mockS3Objects('invented-other-bucket').size).toBe(0);
    const [failed] = await s.api('GET', '/audit?action=export.failed&limit=1');
    expect(failed.details).toMatchObject({ runId: r.id, code: 'EXPORT_TARGET_CHANGED' });
    let notes: any[] = [];
    for (let i = 0; i < 50 && !notes.some((n) => n.event === 'export.failed' && n.body.includes('S3 target')); i++) {
      notes = (await s.api('GET', '/notifications')).items;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(notes.some((n) => n.event === 'export.failed' && n.body.includes('S3 target'))).toBe(true);

    // confirming it again: administrators only, with a step-up
    expect((await refused(olivia, 'POST', `/exports/${id}/confirm-target`)).status).toBe(403);
    const fresh = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    await fresh('DELETE', '/auth/step-up');
    expect(await refused(fresh, 'POST', `/exports/${id}/confirm-target`)).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect(await s.api('POST', `/exports/${id}/confirm-target`)).toMatchObject({ targetChanged: false });
    const [confirmed] = await s.api('GET', '/audit?action=export.target_confirmed&limit=1');
    expect(confirmed).toMatchObject({ actor: 'admin', details: { platformId: delegated.id, baseUrl: `${mockBase}/s3/invented-other-bucket`, changed: true } });
    await s.api('PUT', `/exports/${id}`, job({ parts: [ALL_PARTS[2]] }));
  });

  it('records the files of a run as they are uploaded, and removes what an interrupted run left after the next start', async () => {
    const jobs = await import('../src/export/jobs.js');
    const { db } = await import('../src/db.js');
    const objs = await objects();
    const folder = 'exports/nightly-share/20200101T000000Z/';
    objs.set(`${folder}services.csv`, { body: Buffer.from('left behind'), meta: {}, lastModified: new Date() });
    // the row as a run that was cut off left it: running, with the file it had uploaded recorded
    db().run(
      "INSERT INTO export_runs (id, job_id, status, trigger_kind, started_at, platform_id, folder, files) VALUES (?, ?, 'running', 'schedule', ?, ?, ?, ?)",
      'xrun_interrupted',
      id,
      '2020-01-01T00:00:00.000Z',
      storageId,
      folder,
      JSON.stringify([{ part: 'services', name: 'services.csv', key: `${folder}services.csv`, bytes: 11, sha256: 'x' }]),
    );
    jobs.startExportJobs();
    const row = async () => (await s.api('GET', `/exports/${id}/runs?limit=200`)).find((x: any) => x.id === 'xrun_interrupted');
    expect(await row()).toMatchObject({ status: 'failed', message: 'Interrupted (the server stopped)', pruned: false, files: [{ name: 'services.csv' }] });
    const [audited] = await s.api('GET', '/audit?action=export.failed&limit=1');
    expect(audited.details).toMatchObject({ runId: 'xrun_interrupted', code: 'EXPORT_INTERRUPTED' });
    expect(objs.has(`${folder}services.csv`)).toBe(true);
    // once the vault is unlocked (bootstrap), what it left is removed – only the recorded keys
    await jobs.cleanUpExportRuns();
    expect(await row()).toMatchObject({ status: 'failed', pruned: true, files: [] });
    expect(objs.has(`${folder}services.csv`)).toBe(false);
    expect(objs.has('exports/nightly-share/notes.txt')).toBe(true);
  });

  it('stops at its next file when the server stops', async () => {
    const jobs = await import('../src/export/jobs.js');
    await s.api('PUT', `/exports/${id}`, job({ parts: [ALL_PARTS[2], ALL_PARTS[4]] }));
    const started = jobs.startExportRun(id, 'schedule');
    jobs.stopExportJobs();
    expect(await jobs.exportsIdle(10_000)).toBe(true);
    jobs.startExportJobs();
    const [r] = await s.api('GET', `/exports/${id}/runs?limit=1`);
    expect(r).toMatchObject({ id: started.id, status: 'failed', message: 'Interrupted (the server stopped)', files: [] });
    expect([...(await objects()).keys()].some((k) => k.startsWith(r.folder))).toBe(false);
  });

  it('keeps the files a failed run could not remove recorded – and the run in the history – until they are gone', async () => {
    const lockedBucket = `${BUCKET}-locked`;
    const locked = await s.api('POST', '/platforms', {
      name: 'Export bucket with Object Lock',
      kind: 'generic',
      baseUrl: `${mockBase}/s3/${lockedBucket}`,
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3' } }, variables: {}, http: { proxy: 'none' } },
      secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
    });
    await s.api('PUT', `/exports/${id}`, job({ platformId: locked.id, parts: [ALL_PARTS[2], ALL_PARTS[4]] }));
    // the second part fails after the first was uploaded; the bucket refuses to delete it
    const { exportPart } = await import('../src/export/parts.js');
    const systems = exportPart('systems')!;
    const write = systems.write;
    systems.write = async () => {
      throw new Error('An invented failure of a part');
    };
    let r: any;
    try {
      r = await run();
    } finally {
      systems.write = write;
    }
    expect(r).toMatchObject({ status: 'failed', message: 'An invented failure of a part' });
    expect(r.files.map((f: any) => f.name)).toEqual(['services.csv']);
    const lockedObjects = (await import('../src/mock/mockS3.js')).mockS3Objects(lockedBucket);
    expect(lockedObjects.has(r.files[0].key)).toBe(true);

    // the history keeps it while its file is in the bucket, however many runs come after
    const { db } = await import('../src/db.js');
    const base = Date.now() - 60_000;
    for (let i = 0; i < 205; i++)
      db().run(
        "INSERT INTO export_runs (id, job_id, status, trigger_kind, started_at, finished_at, message) VALUES (?, ?, 'failed', 'schedule', ?, ?, 'invented')",
        `xrun_filler_${i}`,
        id,
        new Date(base + i).toISOString(),
        new Date(base + i).toISOString(),
      );
    db().run('UPDATE export_runs SET started_at = ? WHERE id = ?', new Date(base - 1000).toISOString(), r.id);
    await s.api('PUT', `/exports/${id}`, job({ platformId: locked.id, parts: [ALL_PARTS[2]] }));
    expect((await run()).status).toBe('succeeded');
    expect(db().get('SELECT id FROM export_runs WHERE id = ?', r.id)).toBeTruthy();
    expect(Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM export_runs WHERE job_id = ?', id)!.n)).toBe(201);
    expect(lockedObjects.has(r.files[0].key)).toBe(true);

    // a platform whose bucket still holds recorded files, or that an export writes to, is not deleted
    expect(await refused(s.api, 'DELETE', `/platforms/${locked.id}`)).toMatchObject({ status: 409, body: { code: 'PLATFORM_EXPORT_TARGET' } });
    await s.api('PUT', `/exports/${id}`, job({ parts: [ALL_PARTS[2]] }));
    expect(await refused(s.api, 'DELETE', `/platforms/${locked.id}`)).toMatchObject({ status: 409, body: { code: 'PLATFORM_EXPORT_FILES' } });
  });

  it('records a failure without secrets and tells the administrators', async () => {
    const bad = await s.api('POST', '/platforms', {
      name: 'Export bucket, wrong key',
      kind: 'generic',
      baseUrl: `${mockBase}/s3/${BUCKET}`,
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3' } }, variables: {}, http: { proxy: 'none' } },
      secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'a-wrong-secret-value' },
    });
    await s.api('PUT', `/exports/${id}`, job({ platformId: bad.id, parts: [ALL_PARTS[2]] }));
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/HTTP 403/);
    expect(r.message).not.toContain('a-wrong-secret-value');
    expect(r.files).toEqual([]);
    let notes: any[] = [];
    for (let i = 0; i < 50 && !notes.some((n) => n.event === 'export.failed'); i++) {
      notes = (await s.api('GET', '/notifications')).items;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(notes.find((n) => n.event === 'export.failed')).toMatchObject({ title: expect.stringContaining('nightly-share'), link: '/settings/exports' });
  });

  it('is audited, and removing it keeps the files in the bucket', async () => {
    const keys = [...(await objects()).keys()].filter((k) => k.startsWith('exports/nightly-share/'));
    await s.api('DELETE', `/exports/${id}`);
    expect((await refused(s.api, 'GET', `/exports/${id}`)).status).toBe(404);
    expect([...(await objects()).keys()].filter((k) => k.startsWith('exports/nightly-share/'))).toEqual(keys);
    const actions = (await s.api('GET', '/audit?entityType=export&limit=200')).map((e: any) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['export.job_created', 'export.job_changed', 'export.completed', 'export.failed', 'export.pruned', 'export.job_removed']),
    );
    const [created] = await s.api('GET', '/audit?action=export.job_created&limit=1');
    expect(created.actor).toBe('admin');
    expect(created.summary).toContain('nightly-share');
  });
});
