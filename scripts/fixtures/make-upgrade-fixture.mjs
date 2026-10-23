#!/usr/bin/env node
// Creates an upgrade test fixture: a data folder written by a released version of Steward.
//
//   git worktree add --detach ../steward-v0.1.0 v0.1.0
//   (cd ../steward-v0.1.0 && npm ci --ignore-scripts)
//   node scripts/fixtures/make-upgrade-fixture.mjs --app ../steward-v0.1.0 --out server/test/fixtures/upgrade/v0.1.0
//
// It starts the server of the checkout given with --app (in demo mode, on a fresh data folder,
// SQLite), sets it up with the test-only master passphrase below, loads the demo data and creates
// realistic content through the API: finished and waiting runs, a schedule, records with an
// attachment and an approval, a service, a credentials register entry, monitors with history, a
// dashboard, a ticket reference, an access change, an evidence pack, a PDF report and a long
// audit log with signed checkpoints. Then it stops the server cleanly and copies the parts of the
// data folder the upgrade test needs to --out, plus manifest.json (what the test expects).
// server/test/upgrade.test.ts starts the current version on every fixture. See docs/TESTING.md.
//
// TEST DATA ONLY: everything is protected by a passphrase that is published here.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const FIXTURE_PASSPHRASE = 'steward-upgrade-fixture';
export const FIXTURE_ADMIN = { username: 'admin', password: 'Fixture-admin-password-1' };
const DEMO_PASSWORD = 'Demo-password-1';

const HELP = `Create an upgrade test fixture from a released version of Steward.

  node scripts/fixtures/make-upgrade-fixture.mjs --app <checkout> --out <folder> [--keep-data]

  --app        a checkout of the release (dependencies installed: npm ci --ignore-scripts)
  --out        the fixture folder to write, e.g. server/test/fixtures/upgrade/v0.2.0 (replaced)
  --keep-data  keep the temporary data folder (its path is printed)`;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}
const app = arg('--app');
const out = arg('--out');
if (!app || !out) {
  console.error('error: --app and --out are required\n\n' + HELP);
  process.exit(2);
}
const appDir = path.resolve(app);
const outDir = path.resolve(out);
const version = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fixture-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`• ${msg}`);

// ---------- server ----------

let base = '';
function startServer() {
  const env = { ...process.env, SM_DATA_DIR: dataDir, SM_PORT: '0', SM_HOST: '127.0.0.1', SM_DEMO: '1', SM_LOG_LEVEL: 'info' };
  for (const k of Object.keys(env)) if (/^SM_(DATABASE_|MASTER_PASSPHRASE|AUDIT_ANCHOR)/.test(k)) delete env[k];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: path.join(appDir, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server start timeout:\n' + buf.slice(-4000))), 60000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.includes('"service manager started"')) continue;
        base = JSON.parse(line).url;
        clearTimeout(timer);
        resolve(child);
      }
      if (buf.length > 1e6) buf = buf.slice(-1e5);
    });
    child.stderr.on('data', (d) => (buf += d.toString()));
    child.on('exit', (code) => reject(new Error(`server exited with ${code}:\n${buf.slice(-4000)}`)));
  });
}

/** An API client with its own session (cookie + session key, as the web app sends them). */
function client() {
  let cookie = '';
  let sessionKey = '';
  const headers = () => ({ 'x-sm-client': '1', ...(cookie ? { cookie } : {}), ...(sessionKey ? { 'x-sm-session': sessionKey } : {}) });
  const keep = (res) => {
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const key = res.headers.get('x-sm-session-key');
    if (key !== null) sessionKey = key;
  };
  const call = async (method, url, body) => {
    const res = await fetch(base + '/api' + url, {
      method,
      headers: { ...headers(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    keep(res);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 500)}`);
    return text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  };
  call.upload = async (url, filename, data) => {
    const form = new FormData();
    form.append('file', new Blob([data]), filename);
    const res = await fetch(base + '/api' + url, { method: 'POST', headers: headers(), body: form });
    keep(res);
    const text = await res.text();
    if (!res.ok) throw new Error(`upload ${url} → ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  };
  return call;
}

async function signIn(username, password) {
  const c = client();
  await c('POST', '/auth/login', { username, password });
  return c;
}

async function waitRun(api, id, statuses = ['succeeded', 'failed', 'cancelled', 'waiting']) {
  for (let i = 0; i < 600; i++) {
    const r = await api('GET', `/runs/${id}`);
    if (statuses.includes(r.status)) return r;
    await sleep(100);
  }
  throw new Error(`run ${id} did not reach ${statuses.join('/')}`);
}

async function idle(api) {
  for (let i = 0; i < 1200; i++) {
    const runs = await api('GET', '/runs?limit=1000');
    if (!runs.some((r) => ['running', 'queued'].includes(r.status))) return;
    await sleep(100);
  }
  throw new Error('runs still active after two minutes');
}

// ---------- content ----------

const iso = (ms) => new Date(ms).toISOString();

async function create() {
  const api = client();
  await api('POST', '/auth/setup', {
    passphrase: FIXTURE_PASSPHRASE,
    username: FIXTURE_ADMIN.username,
    displayName: 'Fixture Admin',
    password: FIXTURE_ADMIN.password,
  });
  log('vault and first administrator set up');
  const demo = await api('POST', '/demo/setup', {});
  log(`demo data loaded (${demo.platforms} platforms, ${demo.processes} processes, ${demo.monitors} monitors)`);
  await idle(api);
  const [dana, olivia, adam] = await Promise.all(['dana', 'olivia', 'adam'].map((u) => signIn(u, DEMO_PASSWORD)));
  const hub = (await api('GET', '/platforms')).find((p) => p.kind === 'insights-hub').id;

  // --- processes and runs ---
  const gate = await api('POST', '/processes', {
    definition: {
      name: 'Upgrade fixture: approval gate',
      description: 'Waits for an approver, then writes a log line. Created by the upgrade fixture generator.',
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'ok', type: 'userTask', mode: 'approve', title: 'Approve the maintenance window', assignees: ['role:approver'], x: 1, y: 0 },
        { id: 'done', type: 'log', level: 'info', message: 'Approved – maintenance window confirmed', x: 2, y: 0 },
      ],
      wires: [
        { from: 'start', port: 'out', to: 'ok' },
        { from: 'ok', port: 'approved', to: 'done' },
      ],
    },
  });
  const failing = await api('POST', '/processes', {
    definition: {
      name: 'Upgrade fixture: always fails',
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'stop', type: 'fail', message: 'Planned failure for the upgrade fixture', x: 1, y: 0 },
      ],
      wires: [{ from: 'start', port: 'out', to: 'stop' }],
    },
  });

  // an approved run (succeeded), a failed run, and a run left waiting for its approval task
  const approved = await api('POST', '/runs', { processId: gate.id, inputs: {}, dryRun: false });
  const aw = await waitRun(api, approved.id);
  await adam('POST', `/tasks/${aw.tasks[0].id}/complete`, { approved: true, comment: 'Fine by me' });
  await waitRun(api, approved.id, ['succeeded', 'failed']);
  const failed = await api('POST', '/runs', { processId: failing.id, inputs: {}, dryRun: false });
  await waitRun(api, failed.id, ['failed']);

  // an access review on the demo hub: selection decision, PDF report
  const review = await api('POST', '/runs', { processId: 'ih-access-review-1-flag', bindings: { hub }, inputs: {}, dryRun: false });
  const rw = await waitRun(api, review.id);
  await adam('POST', `/tasks/${rw.tasks[0].id}/complete`, {
    approved: true,
    selectedKeys: rw.tasks[0].items.slice(0, 2).map((i) => i.key),
    comment: 'Checked with HR – both left the company',
  });
  const reviewDone = await waitRun(api, review.id, ['succeeded', 'failed']);
  const report = await api('POST', `/runs/${review.id}/reports`, { lang: 'en', comment: 'Reviewed for the upgrade fixture', timeZone: 'Europe/Berlin' });
  log(`runs: approved ${approved.id}, failed ${failed.id}, review ${review.id} (${reviewDone.status}), report ${report.id}`);

  const waiting = await api('POST', '/runs', { processId: gate.id, inputs: {}, dryRun: false });
  const ww = await waitRun(api, waiting.id, ['waiting']);
  const waitingTask = ww.tasks[0].id;
  log(`run ${waiting.id} waits for task ${waitingTask}`);

  // --- schedule (disabled, so it never fires on its own) ---
  const schedule = await api('POST', '/schedules', {
    name: 'Upgrade fixture: nightly health check',
    processId: 'ih-health-check',
    cron: '0 3 * * *',
    bindings: { hub },
    enabled: false,
  });

  // --- records: a change request with attachments, submitted and approved (four-eyes) ---
  const cr = await dana('POST', '/records', {
    type: 'CR',
    title: 'Renew the gateway TLS certificate',
    fields: {
      reason: 'Certificate expires',
      risk: 'low',
      rollbackPlan: 'Restore the old certificate',
      plannedStart: '2026-11-03T18:00',
      plannedEnd: '2026-11-03T19:00',
    },
    body: '## Description\n\nReplace the **certificate** on the gateway.\n',
  });
  const note = Buffer.from('Implementation plan\n\n1. Upload the new certificate\n2. Restart the agent\n');
  const attachment = await dana.upload(`/records/${cr.id}/attachments`, 'plan.txt', note);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
  await dana.upload(`/records/${cr.id}/attachments`, 'offer.pdf', pdf);
  await dana('POST', `/records/${cr.id}/transition`, { action: 'submit', comment: 'Ready for approval' });
  await adam('POST', `/records/${cr.id}/transition`, { action: 'approve', comment: 'Approved' });
  const adr = await dana('POST', '/records', {
    type: 'ADR',
    title: 'Keep audit checkpoints outside the database',
    body: '## Decision\n\nWe e-mail checkpoints.\n',
  });
  log(`records: ${cr.number} (approved), ${adr.number} (draft)`);

  // --- service, credentials register, ticket reference ---
  const service = await dana('POST', '/services', {
    name: 'Plant data platform',
    description: '## Purpose\n\nCollects machine data.',
    contacts: [{ role: 'business', email: 'erika@example.com', name: 'Erika' }],
    owners: ['team:Service Desk'],
    criticality: 'high',
    tags: ['plant'],
  });
  await api('PUT', '/settings/notifications', { ...(await api('GET', '/settings/notifications')), allowedEmailDomains: ['example.com'] });
  const credential = await dana('POST', '/credentials', {
    name: 'Agent certificate IoT2050 #17',
    type: 'agentCertificate',
    platformText: 'Insights Hub',
    environment: 'production',
    description: 'Agent certificate of the MindConnect IoT2050 in hall 3',
    usedBy: { text: 'Agent on IoT2050 #17', links: [] },
    owners: [{ email: 'it-ops@example.com', role: 'IT operations' }],
    location: { text: 'KeePass: IT-Ops.kdbx → Insights Hub/Agents/IoT2050-17', url: 'keepass://IT-Ops.kdbx' },
    expiresAt: iso(Date.now() + 200 * 86400000),
  });
  const ticket = await olivia('POST', '/ticket-references', {
    source: 'vendor',
    externalNumber: 'CS-0042',
    externalUrl: 'https://support.vendor.example/cases/42',
    title: 'Agent upload stalls on tenant plantprod',
    note: 'Opened with vendor support.',
    vendor: 'Siemens',
    responsible: ['user:olivia'],
    links: [{ kind: 'service', id: service.id }],
  });

  // --- monitors with history ---
  const monitors = await api('GET', '/monitors');
  for (let round = 0; round < 3; round++) {
    for (const m of monitors) await api('POST', `/monitors/${m.id}/run`, {}).catch(() => undefined);
    await sleep(1500);
  }
  log(`${monitors.length} monitors checked three times`);

  // --- dashboard ---
  const datasets = await api('GET', '/datasets');
  const ds = datasets[0]?.key;
  const dashboard = await api('POST', '/dashboards', {
    text: `name: Upgrade fixture board\nwidgets:\n  - { id: t1, type: table, dataset: ${ds}, width: 12 }\n`,
  });

  // --- access governance: a documented after-the-fact change and a manual entry ---
  const check = (await api('GET', '/compliance/access-checks')).find((c) => c.platformId === hub);
  const sim = await api('POST', '/compliance/demo/simulate-change', { accessCheckId: check.id });
  await olivia('POST', `/compliance/findings/${sim.result.findings[0].id}/document`, { reason: 'Emergency access', performedBy: 'tenant admin' });
  const accessChange = await olivia('POST', '/compliance/access-changes', {
    platformId: hub,
    subjectId: 'svc-reader',
    kind: 'grant',
    rightsAfter: ['mdsp:core:StandardUser'],
    reason: 'Technical user for the historian',
    performedBy: 'olivia',
    performedAt: iso(Date.now() - 60000),
    document: true,
  });

  // --- a longer audit log (sign-ins, draft edits) with a signed checkpoint in the middle ---
  for (let i = 0; i < 120; i++) {
    await signIn(['dana', 'olivia', 'adam', 'vera'][i % 4], DEMO_PASSWORD);
    if (i === 60) await api('POST', '/audit/checkpoint', {});
  }

  // --- evidence pack (signed with the instance key) ---
  const iso27001 = await api('GET', '/compliance/controls?catalogue=ISO27001');
  const controls = iso27001.filter((c) => ['5.18', '8.2'].includes(c.ref)).map((c) => c.id);
  let pack = await api('POST', '/compliance/evidence-packs', {
    title: 'Upgrade fixture evidence',
    scope: { controlIds: controls },
    from: iso(Date.now() - 86400000),
    to: iso(Date.now() + 60000),
  });
  for (let i = 0; i < 600 && pack.status === 'building'; i++) {
    await sleep(100);
    pack = await api('GET', `/compliance/evidence-packs/${pack.id}`);
  }
  if (pack.status !== 'ready') throw new Error(`evidence pack ${pack.status}: ${pack.error}`);

  await idle(api);
  const checkpoint = await api('POST', '/audit/checkpoint', {});
  const verify = await api('GET', '/audit/verify');
  if (!verify.ok) throw new Error('audit log does not verify: ' + JSON.stringify(verify));

  // --- what the upgrade test expects ---
  const runs = await api('GET', '/runs?limit=1000');
  const records = await api('GET', '/records');
  const recordItems = Array.isArray(records) ? records : records.items;
  const audit = await api('GET', '/audit?limit=1');
  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    generator: 'scripts/fixtures/make-upgrade-fixture.mjs',
    passphrase: FIXTURE_PASSPHRASE,
    admin: FIXTURE_ADMIN,
    demoPassword: DEMO_PASSWORD,
    approver: 'adam',
    counts: {
      runs: runs.length,
      processes: (await api('GET', '/processes')).length,
      platforms: (await api('GET', '/platforms')).length,
      records: recordItems.length,
      monitors: monitors.length,
      dashboards: (await api('GET', '/dashboards')).length,
      schedules: (await api('GET', '/schedules')).length,
      auditEntries: audit[0].seq,
    },
    ids: {
      hub,
      approvedRun: approved.id,
      failedRun: failed.id,
      reviewRun: review.id,
      waitingRun: waiting.id,
      waitingTask,
      schedule: schedule.id,
      record: cr.id,
      recordNumber: cr.number,
      attachment: attachment.id,
      attachmentSha256: crypto.createHash('sha256').update(note).digest('hex'),
      draftRecord: adr.id,
      service: service.id,
      credential: credential.id,
      ticket: ticket.id,
      monitor: monitors[0]?.id,
      dashboard: dashboard.id,
      acRecord: accessChange.recordId, // the record of the access change ("AC-…")
      acNumber: accessChange.number,
      evidencePack: pack.id,
      report: report.id,
    },
    checkpoint: { seq: checkpoint.seq, hash: checkpoint.hash },
  };
  log(`audit log: ${manifest.counts.auditEntries} entries, last checkpoint at #${checkpoint.seq}`);
  return manifest;
}

// ---------- copy the data folder ----------

/** Only what an installation keeps: no logs, no instance file (runtime), no WAL (the copy is compacted). */
const COPY_DIRS = ['artifacts', 'branding', 'docs', 'evidence-packs', 'records', 'reports'];
const COPY_FILES = ['vault.json', 'audit-anchor.json'];

function copyData(manifest) {
  fs.rmSync(outDir, { recursive: true, force: true });
  const data = path.join(outDir, 'datadir');
  fs.mkdirSync(data, { recursive: true });
  const src = new DatabaseSync(path.join(dataDir, 'service-manager.db'));
  src.exec(`VACUUM INTO '${path.join(data, 'service-manager.db').replace(/'/g, "''")}'`);
  src.close();
  for (const f of COPY_FILES) if (fs.existsSync(path.join(dataDir, f))) fs.copyFileSync(path.join(dataDir, f), path.join(data, f));
  for (const d of COPY_DIRS) if (fs.existsSync(path.join(dataDir, d))) fs.cpSync(path.join(dataDir, d), path.join(data, d), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(outDir);
  log(`fixture written to ${outDir} (${(total / 1024 / 1024).toFixed(2)} MB)`);
}

// ---------- main ----------

let child;
try {
  log(`starting Steward ${version} from ${appDir} on ${dataDir}`);
  child = await startServer();
  const manifest = await create();
  log('stopping the server');
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  child = undefined;
  copyData(manifest);
} catch (e) {
  console.error(`error: ${e.message}`);
  child?.kill('SIGKILL');
  process.exitCode = 1;
} finally {
  if (process.argv.includes('--keep-data')) log(`data folder kept: ${dataDir}`);
  else fs.rmSync(dataDir, { recursive: true, force: true });
}
