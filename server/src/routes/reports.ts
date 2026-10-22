import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { REPORT_LANGS, REPORT_LOGO_MAX_BYTES, type ReportRecord } from '@sm/shared';
import { audit, verifyAudit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { capabilities, require, requireCapability } from '../auth/permissions.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import { HttpError, sha256 } from '../util.js';
import * as branding from '../reports/branding.js';
import * as reports from '../reports/service.js';
import { initAutoReports } from '../reports/auto.js';

/**
 * Archived PDF reports (mounted under /api):
 *   POST /runs/:id/reports            generate a run report  {lang, comment, classification, timeZone}
 *   GET  /runs/:id/reports            reports of a run
 *   GET  /runs/:id/report.pdf         generate + download in one step (kept for links and scripts)
 *   POST /reports/summary             periodic summary       {processIds, from, to, lang, comment, …}
 *   GET  /reports?kind=summary        summary reports the user may see
 *   GET  /reports/:id(/download)      record / file
 *   POST /reports/verify              is this PDF (or a signed copy of it) a report generated here?
 *   /reports/branding…                branding settings, logo, preview (administrators)
 */

const params = (req: FastifyRequest) => req.params as Record<string, string>;

const me = (): AuthUser => {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in');
  return u;
};

function requireRunView(runId: string) {
  const r = store.runRow(runId);
  const perms = processes.permissionsFor(r.process_id);
  if (!perms.includes('view')) throw new HttpError(404, `Run ${runId} not found`);
  require(perms, 'view', 'view this run');
  return r;
}

/** Summary reports: the user must be able to view every process they cover. */
function canViewAll(processIds: string[]): boolean {
  return processIds.every((id) => processes.permissionsFor(id).includes('view'));
}

function requireReportAccess(rec: ReportRecord): void {
  if (rec.kind === 'run' && rec.runId) {
    requireRunView(rec.runId);
    return;
  }
  if (!canViewAll(rec.processIds)) {
    // processes that no longer exist: auditors/administrators may still open the archive
    if (!capabilities(me()).viewAudit) throw new HttpError(404, `Report ${rec.id} not found`);
  }
}

const langSchema = z.enum(REPORT_LANGS).optional();
const userLocale = (): string | undefined => (currentUser() as (AuthUser & { locale?: string }) | null)?.locale;

const runReportBody = z.object({
  lang: langSchema,
  comment: z.string().max(4000).optional(),
  classification: z.string().max(60).optional(),
  timeZone: z.string().max(64).optional(),
});

const summaryBody = runReportBody.extend({
  processIds: z.array(z.string().min(1)).min(1).max(100),
  from: z.string().min(1),
  to: z.string().min(1),
  title: z.string().max(200).optional(),
});

const brandingBody = z.object({
  companyName: z.string().max(120).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1c7ed6').optional(),
  classification: z.string().max(60).optional(),
  footerNote: z.string().max(200).optional(),
});

const strip = ({ texts: _t, ...rec }: ReportRecord & { texts?: string[] }): ReportRecord => rec;

function sendPdf(reply: FastifyReply, data: Buffer, filename: string, inline = false) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  reply.header('cache-control', 'no-store');
  return reply.type('application/pdf').send(data);
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  initAutoReports();

  // ---------- run reports ----------
  app.post('/runs/:id/reports', async (req) => {
    const id = params(req).id!;
    requireRunView(id);
    const b = runReportBody.parse(req.body ?? {});
    const rec = await reports.generateRunReport(id, { ...b, lang: reports.resolveLang(b.lang, userLocale()), actor: me().username });
    return strip(rec);
  });

  app.get('/runs/:id/reports', async (req) => {
    const id = params(req).id!;
    requireRunView(id);
    return reports.listRunReports(id);
  });

  app.get('/runs/:id/report.pdf', async (req, reply) => {
    const id = params(req).id!;
    requireRunView(id);
    const q = req.query as { lang?: string; timeZone?: string };
    const rec = await reports.generateRunReport(id, { lang: reports.resolveLang(q.lang, userLocale()), timeZone: q.timeZone, actor: me().username });
    const r = reports.getReport(rec.id);
    return sendPdf(reply, fs.readFileSync(r.file), r.filename);
  });

  // ---------- summary reports ----------
  app.post('/reports/summary', async (req) => {
    const b = summaryBody.parse(req.body ?? {});
    for (const pid of new Set(b.processIds)) {
      if (!processes.permissionsFor(pid).includes('view')) throw new HttpError(404, `Process ${pid} not found`);
    }
    const rec = await reports.generateSummaryReport({ ...b, lang: reports.resolveLang(b.lang, userLocale()), actor: me().username });
    return strip(rec);
  });

  app.get('/reports', async (req) => {
    const q = req.query as { kind?: string; limit?: string };
    if (q.kind && q.kind !== 'summary') throw new HttpError(400, 'Use /runs/:id/reports for run reports');
    const caps = capabilities(me());
    return reports
      .listSummaryReports(Math.min(Number(q.limit) || 200, 1000))
      .filter((r) => canViewAll(r.processIds) || (caps.viewAudit && r.processIds.some((p) => !processes.permissionsFor(p).length)));
  });

  // ---------- branding (administrators) ----------
  // Registered before /reports/:id so the static paths win.
  app.get('/reports/branding', async () => {
    requireCapability(me(), 'manageSettings', 'manage report branding');
    return branding.getBranding();
  });

  app.put('/reports/branding', async (req) => {
    requireCapability(me(), 'manageSettings', 'manage report branding');
    const b = brandingBody.parse(req.body ?? {});
    const before = branding.getBranding();
    const after = branding.updateBranding(b);
    const changed = Object.fromEntries(
      (Object.keys(b) as (keyof typeof b)[]).filter((k) => before[k] !== after[k]).map((k) => [k, { from: before[k], to: after[k] }]),
    );
    if (Object.keys(changed).length) {
      audit({ action: 'report.branding_updated', entityType: 'settings', entityId: 'report-branding', summary: `Report branding changed (${Object.keys(changed).join(', ')})`, details: changed });
    }
    return after;
  });

  app.get('/reports/branding/logo', async (_req, reply) => {
    requireCapability(me(), 'manageSettings', 'manage report branding');
    const l = branding.logo();
    reply.header('cache-control', 'no-store');
    return reply.type(l.mime).send(l.data);
  });

  app.post('/reports/branding/logo', async (req) => {
    requireCapability(me(), 'manageSettings', 'manage report branding');
    let data: Buffer;
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: REPORT_LOGO_MAX_BYTES + 1, files: 1 } });
      if (!file) throw new HttpError(400, 'No file');
      try {
        data = await file.toBuffer();
      } catch {
        throw new HttpError(400, `The logo is too large (max. ${REPORT_LOGO_MAX_BYTES / 1024 / 1024} MB)`);
      }
    } else {
      const b = z.object({ contentBase64: z.string().max(Math.ceil((REPORT_LOGO_MAX_BYTES * 4) / 3) + 16) }).safeParse(req.body ?? {});
      if (!b.success) throw new HttpError(400, `Upload a PNG or JPEG file (max. ${REPORT_LOGO_MAX_BYTES / 1024 / 1024} MB)`);
      data = Buffer.from(b.data.contentBase64, 'base64');
    }
    const after = branding.setLogo(data);
    audit({
      action: 'report.logo_uploaded',
      entityType: 'settings',
      entityId: 'report-branding',
      summary: `Report logo uploaded (${after.logoMime}, ${data.length} bytes)`,
      details: { sha256: sha256(data), size: data.length, mime: after.logoMime },
    });
    return after;
  });

  app.delete('/reports/branding/logo', async () => {
    requireCapability(me(), 'manageSettings', 'manage report branding');
    const after = branding.removeLogo();
    audit({ action: 'report.logo_removed', entityType: 'settings', entityId: 'report-branding', summary: 'Report logo reset to the default' });
    return after;
  });

  app.post('/reports/branding/preview', async (req, reply) => {
    requireCapability(me(), 'manageSettings', 'manage report branding');
    const b = brandingBody.extend({ lang: langSchema, timeZone: z.string().max(64).optional() }).parse(req.body ?? {});
    const { lang, timeZone, ...draft } = b;
    const res = await reports.previewReport({ lang: reports.resolveLang(lang, userLocale()), timeZone, actor: me().username, branding: draft });
    return sendPdf(reply, res.pdf, `report-preview-${lang ?? 'en'}.pdf`, true);
  });

  // ---------- verification of an archived (and possibly signed) copy ----------
  app.post('/reports/verify', async (req) => {
    const u = me();
    let data: Buffer;
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
      if (!file) throw new HttpError(400, 'No file');
      data = await file.toBuffer();
    } else {
      const b = z.object({ contentBase64: z.string().min(1) }).parse(req.body ?? {});
      data = Buffer.from(b.contentBase64, 'base64');
    }
    const found = reports.findGenerated(data);
    if (found) {
      // only reveal details of reports the user may see (deleted ones: auditors/administrators)
      const rec = (() => {
        try {
          return reports.getReport(found.entry.entity_id);
        } catch {
          return null;
        }
      })();
      if (rec) requireReportAccess(rec);
      else if (!capabilities(u).viewAudit) return reports.verificationOf(data, null);
    }
    const chain = verifyAudit();
    const result = reports.verificationOf(data, found, { ok: chain.ok, checked: chain.checked, message: chain.message });
    audit({
      action: 'report.verified',
      entityType: 'report',
      entityId: result.report?.id ?? null,
      runId: result.report?.runId ?? null,
      summary: result.report ? `PDF verified: ${result.match === 'exact' ? 'unchanged' : 'signed copy of'} report ${result.report.id}` : 'PDF verified: not a report generated here',
      details: { sha256: result.sha256, match: result.match, auditChainOk: chain.ok },
    });
    return result;
  });

  // ---------- single report ----------
  app.get('/reports/:id', async (req) => {
    const rec = reports.getReport(params(req).id!);
    requireReportAccess(rec);
    const { file: _f, ...out } = rec;
    return out;
  });

  app.get('/reports/:id/download', async (req, reply) => {
    const rec = reports.getReport(params(req).id!);
    requireReportAccess(rec);
    let data: Buffer;
    try {
      data = fs.readFileSync(rec.file);
    } catch {
      throw new HttpError(410, 'The report file is no longer available');
    }
    const actual = sha256(data);
    if (actual !== rec.sha256) throw new HttpError(409, `The stored report file does not match its recorded SHA-256 (${rec.sha256.slice(0, 16)}…) – it was modified on disk`);
    audit({
      action: 'report.downloaded',
      entityType: 'report',
      entityId: rec.id,
      runId: rec.runId ?? null,
      summary: `Report "${rec.filename}" downloaded`,
      details: { sha256: rec.sha256 },
    });
    return sendPdf(reply, data, rec.filename, (req.query as { inline?: string }).inline === '1');
  });
}
