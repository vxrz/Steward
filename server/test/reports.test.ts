import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, ADMIN, type Client, type TestServer } from './helpers.js';

let s: TestServer;
let hub: string;
let vera: Client;
let olivia: Client;
let reviewRun: any; // access review 1 (real run) with a decision and a comment
let dryRun: any;
const PW = 'Demo-password-1';
/** Set SM_REPORT_SAMPLES=/some/dir to keep copies of the generated PDFs (visual checks). */
const SAMPLES = process.env.SM_REPORT_SAMPLES;

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const hasTool = (bin: string) => spawnSync(bin, ['-v'], { stdio: 'ignore' }).error === undefined;

/** Signs in with fetch and returns a cookie, for binary downloads and multipart uploads. */
async function cookieFor(username: string, password: string): Promise<string> {
  return loginCookie(s.base, username, password);
}

let adminCookie: string;
async function download(url: string, cookie = adminCookie): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const res = await fetch(s.base + '/api' + url, { headers: { ...authHeaders(cookie), 'x-sm-client': '1' } });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

function keep(name: string, pdf: Buffer): void {
  if (!SAMPLES) return;
  fs.mkdirSync(SAMPLES, { recursive: true });
  fs.writeFileSync(path.join(SAMPLES, name), pdf);
}

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
const xmp = (pdf: Buffer) => {
  const t = pdf.toString('utf8');
  return t.slice(t.indexOf('<x:xmpmeta'), t.indexOf('</x:xmpmeta>') + 12);
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
  adminCookie = await cookieFor(ADMIN.username, ADMIN.password);
  [vera, olivia] = await Promise.all([s.as('vera', PW), s.as('olivia', PW)]);

  // A real access review with a selection decision and a comment.
  const { id } = await s.api('POST', '/runs', { processId: 'ih-access-review-1-flag', bindings: { hub }, inputs: {}, dryRun: false });
  const waiting = await s.waitRun(id);
  expect(waiting.status).toBe('waiting');
  const task = waiting.tasks[0];
  const adam = await s.as('adam', PW);
  await adam('POST', `/tasks/${task.id}/complete`, {
    approved: true,
    selectedKeys: task.items.slice(0, 2).map((i: any) => i.key),
    comment: 'Checked with HR – both left the company',
  });
  reviewRun = await s.waitRun(id, ['succeeded', 'failed']);

  const dry = await s.api('POST', '/runs', { processId: 'ih-access-review-1-flag', bindings: { hub }, inputs: {}, dryRun: true });
  const dw = await s.waitRun(dry.id);
  await s.api('POST', `/tasks/${dw.tasks[0].id}/complete`, { approved: true, selectedKeys: dw.tasks[0].items.map((i: any) => i.key) });
  dryRun = await s.waitRun(dry.id, ['succeeded', 'failed']);
});
afterAll(async () => {
  await s?.app.close();
});

describe('run report', () => {
  let rec: any;
  let pdf: Buffer;

  it('generates, stores and audits a PDF/A-2b run report', async () => {
    expect(reviewRun.status).toBe('succeeded');
    rec = await s.api('POST', `/runs/${reviewRun.id}/reports`, { lang: 'en', comment: 'Reviewed by internal audit, no findings.', timeZone: 'Europe/Berlin' });
    expect(rec).toMatchObject({
      kind: 'run',
      runId: reviewRun.id,
      version: 1,
      lang: 'en',
      interim: false,
      auto: false,
      createdBy: 'admin',
      comment: 'Reviewed by internal audit, no findings.',
      classification: 'Internal',
    });
    expect(rec.filename).toMatch(new RegExp(`^Steward-insights-hub-access-review-1.*-${reviewRun.id}-\\d{4}-\\d{2}-\\d{2}\\.pdf$`));

    const dl = await download(`/reports/${rec.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/pdf');
    expect(dl.headers.get('content-disposition')).toContain(rec.filename);
    pdf = dl.body;
    keep('run-report-en.pdf', pdf);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');
    expect(pdf.length).toBe(rec.size);
    expect(sha(pdf)).toBe(rec.sha256);
    expect(pageCount(pdf)).toBeGreaterThan(1);

    // metadata: PDF/A identification, run id, protocol hash, content hash
    const meta = xmp(pdf);
    expect(meta).toContain('<pdfaid:part>2</pdfaid:part>');
    expect(meta).toContain('<pdfaid:conformance>B</pdfaid:conformance>');
    expect(meta).toContain(`<stw:runId>${reviewRun.id}</stw:runId>`);
    expect(meta).toContain(`<stw:protocolHash>${rec.protocolHash}</stw:protocolHash>`);
    expect(meta).toContain(`<stw:contentHash>${rec.contentHash}</stw:contentHash>`);
    expect(meta).toContain('pdfaExtension:schemas');
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/\/runId \d+ 0 R/); // Info dictionary entry
    expect(raw).toContain(`(${reviewRun.id})`);
    expect(raw).toContain('/OutputIntents');
    expect(raw).toContain('/FT /Sig'); // empty digital signature fields
    expect(raw).not.toContain('/NeedAppearances');
    expect(raw).not.toMatch(/\/BaseFont \/(Helvetica|Times|Courier)/); // only embedded fonts

    // protocol hash is the sealed fingerprint recorded when the run finished
    const finished = (await s.api('GET', `/audit?runId=${reviewRun.id}&action=run.succeeded`))[0];
    expect(rec.protocolHash).toBe(finished.details.protocolHash);
  });

  it('records the file hash in the audit chain', async () => {
    const entries = await s.api('GET', `/audit?runId=${reviewRun.id}&action=report.generated`);
    expect(entries).toHaveLength(1);
    expect(entries[0].entityId).toBe(rec.id);
    expect(entries[0].details.sha256).toBe(rec.sha256);
    expect(entries[0].details.size).toBe(rec.size);
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
    const list = await s.api('GET', `/runs/${reviewRun.id}/reports`);
    expect(list.map((r: any) => r.id)).toEqual([rec.id]);
  });

  it('contains what was done, decisions, comments and the sign-off', async () => {
    const { generateRunReport } = await import('../src/reports/service.js');
    const r = await generateRunReport(reviewRun.id, { lang: 'en', comment: 'Second look', actor: 'admin', timeZone: 'UTC' });
    const text = r.texts.join('\n');
    for (const fact of [
      'Run report',
      'Insights Hub – Access review 1',
      reviewRun.id,
      'What was done',
      'Changes (write operations)',
      'Decisions and approvals',
      'Checked with HR – both left the company',
      'Adam',
      `2 of ${reviewRun.tasks[0].items.length} selected`,
      'Second look',
      'Prepared by',
      'Reviewed by',
      'Approved by',
      'Protocol hash',
      'Intact – unchanged since the run finished',
      rec.protocolHash,
    ]) {
      expect(text, fact).toContain(fact);
    }
    for (const w of reviewRun.steps.filter((x: any) => x.input?.write)) expect(text).toContain(w.input.method);
    // no secrets of the platform
    expect(text).not.toContain('demo-secret');
    expect(r.version).toBe(2);

    if (hasTool('pdftotext')) {
      const file = path.join(s.dataDir, 'reports', reviewRun.id, `${r.id}.pdf`);
      const out = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
      expect(out.stdout).toContain('Second look');
      expect(out.stdout).toContain(reviewRun.id);
      expect(out.stdout).toContain('Checked with HR');
    }
    if (hasTool('pdfinfo')) {
      const info = spawnSync('pdfinfo', [path.join(s.dataDir, 'reports', reviewRun.id, `${r.id}.pdf`)], { encoding: 'utf8' }).stdout;
      expect(info).toMatch(/Form:\s+AcroForm/);
      expect(info).toMatch(/Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
      expect(info).toMatch(/Creator:\s+Steward/);
    }
  });

  it('never overwrites: every generation is a new, immutable file and record', async () => {
    const before = fs.readFileSync(path.join(s.dataDir, 'reports', reviewRun.id, `${rec.id}.pdf`));
    const third = await s.api('POST', `/runs/${reviewRun.id}/reports`, { lang: 'de' });
    expect(third.id).not.toBe(rec.id);
    expect(third.version).toBe(3);
    expect(third.lang).toBe('de');
    const files = fs.readdirSync(path.join(s.dataDir, 'reports', reviewRun.id));
    expect(files).toHaveLength(3);
    expect(sha(fs.readFileSync(path.join(s.dataDir, 'reports', reviewRun.id, `${rec.id}.pdf`)))).toBe(sha(before));
    const de = await download(`/reports/${third.id}/download`);
    keep('run-report-de.pdf', de.body);
    expect(xmp(de.body)).toContain('Ausführungsbericht');
    const { db } = await import('../src/db.js');
    expect(() => db().run('UPDATE reports SET comment = ? WHERE id = ?', 'tampered', rec.id)).toThrow(/immutable/);
  });

  it('detects a report file modified on disk', async () => {
    const file = path.join(s.dataDir, 'reports', reviewRun.id, `${rec.id}.pdf`);
    const original = fs.readFileSync(file);
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n% tampered')]));
    expect((await download(`/reports/${rec.id}/download`)).status).toBe(409);
    fs.writeFileSync(file, original);
    expect((await download(`/reports/${rec.id}/download`)).status).toBe(200);
  });

  it('marks dry runs prominently and lists simulated writes', async () => {
    const { generateRunReport } = await import('../src/reports/service.js');
    const r = await generateRunReport(dryRun.id, { lang: 'en', actor: 'admin' });
    const text = r.texts.join('\n');
    expect(text).toContain('DRY RUN – nothing was changed');
    expect(text).toContain('Simulated – not executed');
    keep('run-report-dry-run-en.pdf', fs.readFileSync(path.join(s.dataDir, 'reports', dryRun.id, `${r.id}.pdf`)));
    const de = await generateRunReport(dryRun.id, { lang: 'de', actor: 'admin' });
    expect(de.texts.join('\n')).toContain('PROBELAUF (DRY RUN)');
  });

  it('allows interim reports for waiting runs and refuses running ones', async () => {
    const { id } = await s.api('POST', '/runs', { processId: 'ih-access-review-1-flag', bindings: { hub }, inputs: {}, dryRun: true });
    await s.waitRun(id);
    const r = await s.api('POST', `/runs/${id}/reports`, {});
    expect(r.interim).toBe(true);
    const { db } = await import('../src/db.js');
    db().run("UPDATE runs SET status = 'running' WHERE id = ?", id);
    expect(await status(s.api('POST', `/runs/${id}/reports`, {}))).toBe(409);
    db().run("UPDATE runs SET status = 'waiting' WHERE id = ?", id);
    await s.api('POST', `/runs/${id}/cancel`);
  });

  it('keeps the legacy GET /runs/:id/report.pdf link working (stored and audited too)', async () => {
    const dl = await download(`/runs/${reviewRun.id}/report.pdf?lang=de`);
    expect(dl.status).toBe(200);
    expect(dl.body.subarray(0, 5).toString()).toBe('%PDF-');
    const list = await s.api('GET', `/runs/${reviewRun.id}/reports`);
    expect(list.some((r: any) => r.sha256 === sha(dl.body))).toBe(true);
  });
});

describe('permissions', () => {
  it('requires view rights on the run’s process', async () => {
    // olivia (operator) may view → may generate
    const { id } = await olivia('POST', `/runs/${reviewRun.id}/reports`, {});
    expect(id).toMatch(/^rpt_/);
    await s.api('PUT', '/processes/ih-access-review-1-flag/access', { acl: [{ subject: 'team:Service Desk', permissions: ['view', 'run'] }] });
    try {
      expect(await status(vera('POST', `/runs/${reviewRun.id}/reports`, {}))).toBe(404);
      expect(await status(vera('GET', `/runs/${reviewRun.id}/reports`))).toBe(404);
      const veraCookie = await cookieFor('vera', PW);
      expect((await download(`/reports/${id}/download`, veraCookie)).status).toBe(404);
      expect((await download(`/runs/${reviewRun.id}/report.pdf`, veraCookie)).status).toBe(404);
      expect(
        await status(vera('POST', '/reports/summary', { processIds: ['ih-access-review-1-flag'], from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' })),
      ).toBe(404);
      // still allowed for olivia (team Service Desk)
      expect((await olivia('GET', `/runs/${reviewRun.id}/reports`)).length).toBeGreaterThan(0);
    } finally {
      await s.api('PUT', '/processes/ih-access-review-1-flag/access', { acl: [] });
    }
  });
  it('branding requires the manageSettings capability', async () => {
    expect(await status(olivia('GET', '/reports/branding'))).toBe(403);
    expect(await status(olivia('PUT', '/reports/branding', { companyName: 'x' }))).toBe(403);
    expect(await status(olivia('POST', '/reports/branding/preview', {}))).toBe(403);
  });
});

describe('summary report', () => {
  it('summarizes runs of several processes in a period', async () => {
    const from = new Date(Date.now() - 86400000).toISOString();
    const to = new Date(Date.now() + 86400000).toISOString();
    const rec = await s.api('POST', '/reports/summary', {
      processIds: ['ih-access-review-1-flag', 'ih-health-check'],
      from,
      to,
      lang: 'en',
      comment: 'Q3 access reviews',
      title: 'Access reviews Q3',
    });
    expect(rec).toMatchObject({ kind: 'summary', runId: null, processIds: ['ih-access-review-1-flag', 'ih-health-check'], title: 'Access reviews Q3' });
    const dl = await download(`/reports/${rec.id}/download`);
    expect(dl.status).toBe(200);
    expect(sha(dl.body)).toBe(rec.sha256);
    keep('summary-report-en.pdf', dl.body);
    expect(xmp(dl.body)).toContain('<stw:reportKind>summary</stw:reportKind>');
    expect((await s.api('GET', '/reports?kind=summary')).map((r: any) => r.id)).toContain(rec.id);
    expect((await s.api('GET', `/audit?action=report.generated`)).some((a: any) => a.entityId === rec.id && a.details.sha256 === rec.sha256)).toBe(true);

    const { generateSummaryReport } = await import('../src/reports/service.js');
    const r = await generateSummaryReport({ processIds: ['ih-access-review-1-flag'], from, to, lang: 'de', actor: 'admin' });
    const text = r.texts.join('\n');
    expect(text).toContain('Zusammenfassender Bericht');
    expect(text).toContain(reviewRun.id);
    expect(text).toContain(dryRun.id);
    keep('summary-report-de.pdf', fs.readFileSync(path.join(s.dataDir, 'reports', 'summary', `${r.id}.pdf`)));
  });
  it('validates the period', async () => {
    expect(await status(s.api('POST', '/reports/summary', { processIds: ['ih-health-check'], from: '2026-02-01', to: '2026-01-01' }))).toBe(400);
    expect(await status(s.api('POST', '/reports/summary', { processIds: [], from: '2026-01-01', to: '2026-02-01' }))).toBe(400);
  });
});

describe('branding', () => {
  it('stores settings, validates the colour and audits changes', async () => {
    const b = await s.api('PUT', '/reports/branding', {
      companyName: 'ACME Industrial GmbH',
      accentColor: '#c2410c',
      classification: 'Confidential',
      footerNote: 'Confidential – for internal use only',
    });
    expect(b).toMatchObject({ companyName: 'ACME Industrial GmbH', accentColor: '#c2410c', customLogo: false });
    expect(await status(s.api('PUT', '/reports/branding', { accentColor: 'orange' }))).toBe(400);
    expect((await s.api('GET', '/audit?action=report.branding_updated'))[0].details.companyName.to).toBe('ACME Industrial GmbH');
  });
  it('rejects logos that are not PNG/JPEG or too large', async () => {
    const txt = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    expect(await status(s.api('POST', '/reports/branding/logo', { contentBase64: txt }))).toBe(400);
    const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really a png')]);
    expect(await status(s.api('POST', '/reports/branding/logo', { contentBase64: fakePng.toString('base64') }))).toBe(400);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024)]);
    const form = new FormData();
    form.append('file', new Blob([big]), 'big.jpg');
    const res = await fetch(s.base + '/api/reports/branding/logo', {
      method: 'POST',
      headers: { ...authHeaders(adminCookie), 'x-sm-client': '1' },
      body: form,
    });
    expect(res.status).toBe(400);
    expect((await s.api('GET', '/reports/branding')).customLogo).toBe(false);
  });
  it('accepts a PNG logo (multipart) and uses it in new reports', async () => {
    const png = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/public/icon-192.png'));
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'text/plain' }), 'logo.png'); // declared type is ignored; magic bytes count
    const res = await fetch(s.base + '/api/reports/branding/logo', {
      method: 'POST',
      headers: { ...authHeaders(adminCookie), 'x-sm-client': '1' },
      body: form,
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b).toMatchObject({ customLogo: true, logoMime: 'image/png' });
    const logo = await download('/reports/branding/logo');
    expect(sha(logo.body)).toBe(sha(png));
    const rec = await s.api('POST', `/runs/${reviewRun.id}/reports`, { lang: 'en', comment: 'Branded copy' });
    const dl = await download(`/reports/${rec.id}/download`);
    keep('run-report-custom-branding-en.pdf', dl.body);
    expect(rec.classification).toBe('Confidential');
    const preview = await fetch(s.base + '/api/reports/branding/preview', {
      method: 'POST',
      headers: { ...authHeaders(adminCookie), 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ lang: 'de', accentColor: '#2f9e44' }),
    });
    expect(preview.status).toBe(200);
    const pv = Buffer.from(await preview.arrayBuffer());
    expect(pv.subarray(0, 5).toString()).toBe('%PDF-');
    keep('branding-preview-de.pdf', pv);
    // preview is neither stored nor audited as a report
    expect((await s.api('GET', '/audit?action=report.generated')).some((a: any) => a.entityId === 'rpt_SAMPLE')).toBe(false);
    await s.api('DELETE', '/reports/branding/logo');
    expect((await s.api('GET', '/reports/branding')).customLogo).toBe(false);
    await s.api('PUT', '/reports/branding', { companyName: '', accentColor: '#1c7ed6', classification: 'Internal', footerNote: '' });
  });
});

describe('verification of archived copies', () => {
  it('recognizes generated reports, signed copies and modified files', async () => {
    const rec = (await s.api('GET', `/runs/${dryRun.id}/reports`))[0];
    const pdf = (await download(`/reports/${rec.id}/download`)).body;
    const exact = await s.api('POST', '/reports/verify', { contentBase64: pdf.toString('base64') });
    expect(exact).toMatchObject({ match: 'exact', sha256: rec.sha256, report: { id: rec.id, runId: dryRun.id, stored: true }, auditChain: { ok: true } });
    // a signature is appended as an incremental update after the original %%EOF
    const signed = Buffer.concat([
      pdf,
      Buffer.from('\n99 0 obj\n<< /Type /Sig >>\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 100 >>\nstartxref\n0\n%%EOF\n'),
    ]);
    expect((await s.api('POST', '/reports/verify', { contentBase64: signed.toString('base64') })).match).toBe('signed-copy');
    const modified = Buffer.from(pdf);
    modified[modified.length - 200] ^= 1;
    expect((await s.api('POST', '/reports/verify', { contentBase64: modified.toString('base64') })).match).toBe('unknown');
    // users who may not see the run learn nothing about it
    await s.api('PUT', '/processes/ih-access-review-1-flag/access', { acl: [{ subject: 'team:Service Desk', permissions: ['view', 'run'] }] });
    try {
      expect(await status(vera('POST', '/reports/verify', { contentBase64: pdf.toString('base64') }))).toBe(404);
    } finally {
      await s.api('PUT', '/processes/ih-access-review-1-flag/access', { acl: [] });
    }
  });
  it('passes veraPDF (PDF/A-2b) when SM_VERAPDF is set', async () => {
    const cmd = process.env.SM_VERAPDF; // e.g. "java -cp '/opt/verapdf/lib/*' org.verapdf.apps.GreenfieldCliWrapper"
    if (!cmd) return;
    const files = fs.readdirSync(path.join(s.dataDir, 'reports', dryRun.id)).map((f) => path.join(s.dataDir, 'reports', dryRun.id, f));
    const out = spawnSync(`${cmd} --flavour 2b --format text ${files.map((f) => `'${f}'`).join(' ')}`, { shell: true, encoding: 'utf8' });
    expect(out.stdout).not.toContain('FAIL');
    expect(out.stdout.match(/^PASS /gm)?.length).toBe(files.length);
  });
});

describe('automatic reports and retention', () => {
  it('generates the report when a run of a process with report.auto finishes', async () => {
    const p = await s.api('POST', '/processes', {
      definition: {
        name: 'Nightly archive check',
        report: { auto: true, lang: 'de' },
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'ok', type: 'check', name: 'Always fine', condition: 'true', x: 200, y: 0 },
        ],
        wires: [{ from: 'start', port: 'out', to: 'ok' }],
      },
    });
    expect(p.definition.report).toEqual({ auto: true, lang: 'de' });
    const { id } = await s.api('POST', '/runs', { processId: p.id });
    await s.waitRun(id, ['succeeded']);
    let list: any[] = [];
    for (let i = 0; i < 50 && !list.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      list = await s.api('GET', `/runs/${id}/reports`);
    }
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ auto: true, lang: 'de', createdBy: 'system', interim: false });
    const entry = (await s.api('GET', `/audit?runId=${id}&action=report.generated`))[0];
    expect(entry.actor).toBe('system');
    expect(entry.details.sha256).toBe(list[0].sha256);
  });
  it('rejects unknown report options in the process definition', async () => {
    expect(
      await status(
        s
          .api('POST', '/processes/validate', { definition: { name: 'x', report: { auto: 'yes' }, nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } })
          .then((r: any) => (r.ok ? Promise.resolve() : Promise.reject({ status: 400 }))),
      ),
    ).toBe(400);
  });
  it('retention cleanup removes the run’s report files and records', async () => {
    const dir = path.join(s.dataDir, 'reports', reviewRun.id);
    expect(fs.readdirSync(dir).length).toBeGreaterThan(2);
    const keptCopy = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!));
    const { db } = await import('../src/db.js');
    db().run("UPDATE runs SET finished_at = '2001-01-01T00:00:00.000Z' WHERE id = ?", reviewRun.id);
    await s.api('PUT', '/settings', { retentionRunDays: 30 });
    await s.api('POST', '/maintenance/cleanup');
    expect(fs.existsSync(dir)).toBe(false);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM reports WHERE run_id = ?', reviewRun.id)!.n).toBe(0);
    // other runs' reports survive; the audit log keeps the history
    expect(fs.existsSync(path.join(s.dataDir, 'reports', dryRun.id))).toBe(true);
    expect((await s.api('GET', '/audit?action=report.generated')).filter((a: any) => a.runId === reviewRun.id).length).toBeGreaterThan(2);
    // an archived copy of a deleted run's report can still be verified against the audit log
    const v = await s.api('POST', '/reports/verify', { contentBase64: keptCopy.toString('base64') });
    expect(v).toMatchObject({ match: 'exact', report: { runId: reviewRun.id, stored: false } });
    await s.api('PUT', '/settings', { retentionRunDays: 0 });
  });
});
