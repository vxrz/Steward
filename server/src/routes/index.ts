import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DashboardData, StartRunRequest, TaskDecision } from '@sm/shared';
import { config } from '../config.js';
import { vault } from '../vault.js';
import { audit, queryAudit, verifyAudit, allAuditAscending } from '../audit.js';
import { getSettings, updateSettings, operator } from '../settings.js';
import { HttpError } from '../util.js';
import { db } from '../db.js';
import * as platforms from '../platforms/service.js';
import { PRESETS } from '../platforms/presets.js';
import { platformRequest, secretValues } from '../platforms/http.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import { startRun, cancelRun, resumeRun, completeTask, recoverRuns } from '../engine/runner.js';
import { browserAvailable } from '../engine/browser.js';
import * as scheduler from '../scheduler.js';
import { runReportHtml, runReportPdf } from '../reports.js';
import { setupDemo } from './demo.js';
import { validateProcess } from '@sm/shared';
import fs from 'node:fs';

let started = false;
/** Things that need the decrypted vault: scheduler, recovery of waiting runs. */
async function onUnlocked(): Promise<void> {
  if (started) return;
  started = true;
  await recoverRuns();
  scheduler.startScheduler();
}

export async function unlockFromEnv(): Promise<void> {
  if (config.masterPassphrase && vault().initialized && !vault().unlocked) {
    vault().unlock(config.masterPassphrase);
    audit({ actor: 'system', action: 'vault.unlocked', entityType: 'vault', summary: 'Vault unlocked from SM_MASTER_PASSPHRASE at startup' });
    await onUnlocked();
  }
}

const platformBody = z.object({
  name: z.string().min(1),
  kind: z.string().optional(),
  description: z.string().optional(),
  baseUrl: z.string().optional(),
  environment: z.string().optional(),
  config: z.any().optional(),
  secrets: z.record(z.string()).optional(),
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ---------- health & vault ----------
  app.get('/health', async () => ({ ok: true, version: config.version }));

  app.get('/vault/status', async () => ({
    initialized: vault().initialized,
    unlocked: vault().unlocked,
    operator: vault().unlocked ? operator() : undefined,
    demo: config.demo,
    version: config.version,
    browserAvailable: await browserAvailable(),
  }));

  app.post('/vault/setup', async (req) => {
    const b = z.object({ passphrase: z.string().min(8), operator: z.string().min(1) }).parse(req.body);
    vault().setup(b.passphrase);
    updateSettings({ operator: b.operator });
    audit({ action: 'vault.initialized', entityType: 'vault', summary: `Vault initialized by ${b.operator}` });
    await onUnlocked();
    return { ok: true };
  });

  app.post('/vault/unlock', async (req) => {
    const b = z.object({ passphrase: z.string(), operator: z.string().optional() }).parse(req.body);
    vault().unlock(b.passphrase);
    if (b.operator) updateSettings({ operator: b.operator });
    audit({ action: 'vault.unlocked', entityType: 'vault', summary: `Vault unlocked by ${operator()}` });
    await onUnlocked();
    return { ok: true };
  });

  app.post('/vault/lock', async () => {
    if (vault().unlocked) {
      audit({ action: 'vault.locked', entityType: 'vault', summary: `Vault locked by ${operator()}` });
      scheduler.stopScheduler();
      started = false;
      vault().lock();
    }
    return { ok: true };
  });

  // ---------- settings ----------
  app.get('/settings', async () => getSettings());
  app.put('/settings', async (req) => {
    const b = z
      .object({ operator: z.string().min(1).optional(), browserHeadless: z.boolean().optional(), browserTimeoutMs: z.number().int().min(1000).optional() })
      .parse(req.body);
    const s = updateSettings(b);
    audit({ action: 'settings.updated', entityType: 'settings', summary: 'Settings updated', details: b });
    return s;
  });

  // ---------- platforms ----------
  app.get('/platform-presets', async () => PRESETS);
  app.get('/platforms', async () => platforms.listPlatforms());
  app.post('/platforms', async (req) => platforms.createPlatform(platformBody.parse(req.body)));
  app.get('/platforms/:id', async (req) => platforms.getPlatform((req.params as { id: string }).id));
  app.put('/platforms/:id', async (req) => platforms.updatePlatform((req.params as { id: string }).id, platformBody.partial().parse(req.body)));
  app.delete('/platforms/:id', async (req) => {
    platforms.deletePlatform((req.params as { id: string }).id);
    return { ok: true };
  });
  app.put('/platforms/:id/secrets', async (req) =>
    platforms.setSecrets((req.params as { id: string }).id, z.record(z.string().nullable()).parse(req.body)),
  );

  app.post('/platforms/:id/test', async (req) => {
    const id = (req.params as { id: string }).id;
    const p = platforms.getPlatform(id);
    const secrets = platforms.getSecrets(id);
    const testPath = p.config.testPath || '/';
    try {
      const res = await platformRequest(p, secrets, { method: 'GET', url: testPath });
      const ok = res.status >= 200 && res.status < 400;
      audit({
        action: 'platform.tested',
        entityType: 'platform',
        entityId: id,
        summary: `Connection test "${p.name}": GET ${testPath} → HTTP ${res.status} (${res.durationMs} ms)`,
      });
      return { ok, status: res.status, durationMs: res.durationMs, message: ok ? 'Connection works' : `HTTP ${res.status}`, body: redact(res.body, secrets) };
    } catch (e) {
      const message = redact((e as Error).message, secrets) as string;
      audit({ action: 'platform.tested', entityType: 'platform', entityId: id, summary: `Connection test "${p.name}" failed: ${message.slice(0, 200)}` });
      return { ok: false, status: 0, durationMs: 0, message };
    }
  });

  app.post('/platforms/:id/request', async (req) => {
    const id = (req.params as { id: string }).id;
    const b = z
      .object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
        path: z.string().min(1),
        query: z.record(z.string()).optional(),
        headers: z.record(z.string()).optional(),
        body: z.any().optional(),
      })
      .parse(req.body);
    const p = platforms.getPlatform(id);
    const secrets = platforms.getSecrets(id);
    const res = await platformRequest(p, secrets, { method: b.method, url: b.path, query: b.query, headers: b.headers, body: b.body });
    audit({
      action: b.method === 'GET' || b.method === 'HEAD' ? 'api.adhoc_read' : 'api.adhoc_write',
      entityType: 'platform',
      entityId: id,
      summary: `Ad-hoc ${b.method} ${b.path} on "${p.name}" → HTTP ${res.status}`,
      details: { query: b.query, body: b.method === 'GET' ? undefined : redact(b.body, secrets) },
    });
    return redact(res, secrets);
  });

  app.get('/platforms/:id/specs', async (req) => platforms.listSpecs((req.params as { id: string }).id));
  app.post('/platforms/:id/specs', async (req) => {
    const b = z.object({ name: z.string().optional(), content: z.string().min(2) }).parse(req.body);
    return platforms.addSpec((req.params as { id: string }).id, b.name ?? '', b.content);
  });
  app.delete('/platforms/:id/specs/:specId', async (req) => {
    const { id, specId } = req.params as { id: string; specId: string };
    platforms.deleteSpec(id, specId);
    return { ok: true };
  });
  app.get('/specs/:specId/content', async (req, reply) => {
    const c = platforms.getSpecContent((req.params as { specId: string }).specId);
    return reply.type(c.trim().startsWith('{') ? 'application/json' : 'text/yaml').send(c);
  });
  app.get('/platforms/:id/operations', async (req) => platforms.listOperations((req.params as { id: string }).id));

  app.get('/platforms/:id/docs', async (req) => platforms.listDocs((req.params as { id: string }).id));
  app.post('/platforms/:id/docs', async (req) => {
    const id = (req.params as { id: string }).id;
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new HttpError(400, 'No file');
      const data = await file.toBuffer();
      const title = (file.fields.title as { value?: string } | undefined)?.value ?? file.filename;
      return platforms.addDoc(id, { title, kind: 'file', filename: file.filename, mime: file.mimetype, data });
    }
    const b = z.object({ title: z.string(), kind: z.enum(['note', 'link']), content: z.string().optional(), url: z.string().url().optional() }).parse(req.body);
    return platforms.addDoc(id, b);
  });
  app.delete('/platforms/:id/docs/:docId', async (req) => {
    const { id, docId } = req.params as { id: string; docId: string };
    platforms.deleteDoc(id, docId);
    return { ok: true };
  });
  app.get('/docs/:docId/file', async (req, reply) => {
    const d = platforms.getDoc((req.params as { docId: string }).docId);
    if (d.kind !== 'file' || !d.filename) throw new HttpError(404, 'No file');
    reply.header('content-disposition', `inline; filename="${d.filename.replace(/"/g, '')}"`);
    return reply.type(d.mime || 'application/octet-stream').send(fs.readFileSync(platforms.docPath(d.id, d.filename)));
  });

  // ---------- processes ----------
  app.get('/templates', async () => processes.listTemplates());
  app.get('/processes', async () => processes.listProcesses());
  app.post('/processes', async (req) => {
    const b = z.object({ definition: z.any().optional(), templateId: z.string().optional(), text: z.string().optional(), comment: z.string().optional() }).parse(req.body);
    if (b.templateId) return processes.createFromTemplate(b.templateId);
    const def = b.text ? processes.parseDefinitionText(b.text) : b.definition;
    return processes.createProcess(def, { comment: b.comment ?? (b.text ? 'Imported' : 'Created') });
  });
  app.post('/processes/validate', async (req) => {
    const b = z.object({ definition: z.any().optional(), text: z.string().optional() }).parse(req.body);
    try {
      const def = b.text !== undefined ? processes.parseDefinitionText(b.text) : b.definition;
      const r = validateProcess(def);
      return { ok: r.ok, issues: r.issues, definition: r.definition };
    } catch (e) {
      return { ok: false, issues: [{ path: '', message: (e as Error).message }] };
    }
  });
  app.post('/processes/to-yaml', async (req) => {
    const b = z.object({ definition: z.any() }).parse(req.body);
    return { text: processes.toYaml(b.definition) };
  });
  app.get('/processes/:id', async (req) => {
    const q = req.query as { version?: string };
    return processes.getProcess((req.params as { id: string }).id, q.version ? Number(q.version) : undefined);
  });
  app.put('/processes/:id', async (req) => {
    const b = z.object({ definition: z.any(), comment: z.string().optional() }).parse(req.body);
    return processes.saveProcess((req.params as { id: string }).id, b.definition, b.comment ?? '');
  });
  app.delete('/processes/:id', async (req) => {
    processes.archiveProcess((req.params as { id: string }).id);
    return { ok: true };
  });
  app.get('/processes/:id/versions', async (req) => processes.listVersions((req.params as { id: string }).id));
  app.get('/processes/:id/export', async (req, reply) => {
    const q = req.query as { version?: string };
    const p = processes.getProcess((req.params as { id: string }).id, q.version ? Number(q.version) : undefined);
    reply.header('content-disposition', `attachment; filename="${p.id}.yaml"`);
    return reply.type('text/yaml').send(processes.toYaml(p.definition));
  });

  // ---------- runs ----------
  app.post('/runs', async (req) => {
    const b = z
      .object({
        processId: z.string(),
        version: z.number().int().optional(),
        inputs: z.record(z.unknown()).optional(),
        bindings: z.record(z.string()).optional(),
        dryRun: z.boolean().optional(),
      })
      .parse(req.body) as StartRunRequest;
    return { id: await startRun(b) };
  });
  app.get('/runs', async (req) => {
    const q = req.query as { processId?: string; status?: string; scheduleId?: string; limit?: string; before?: string };
    return store.listRuns({ ...q, limit: q.limit ? Number(q.limit) : undefined });
  });
  app.get('/runs/:id', async (req) => store.getRunDetail((req.params as { id: string }).id));
  app.get('/runs/:id/steps/:stepId', async (req) => {
    const { id, stepId } = req.params as { id: string; stepId: string };
    return store.getStepFull(id, Number(stepId));
  });
  app.post('/runs/:id/cancel', async (req) => {
    await cancelRun((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/runs/:id/resume', async (req) => {
    await resumeRun((req.params as { id: string }).id);
    return { ok: true };
  });
  app.get('/runs/:id/report.html', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { download?: string };
    if (q.download) reply.header('content-disposition', `attachment; filename="protocol-${id}.html"`);
    return reply.type('text/html').send(runReportHtml(id));
  });
  app.get('/runs/:id/report.pdf', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const pdf = await runReportPdf(id);
    audit({ action: 'run.report_exported', entityType: 'run', entityId: id, runId: id, summary: 'Run protocol exported as PDF' });
    reply.header('content-disposition', `attachment; filename="protocol-${id}.pdf"`);
    return reply.type('application/pdf').send(pdf);
  });
  app.get('/runs/:id/report.json', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const detail = store.getRunDetail(id);
    const steps = detail.steps.map((s) => store.getStepFull(id, s.id));
    reply.header('content-disposition', `attachment; filename="protocol-${id}.json"`);
    return { ...detail, steps, audit: allAuditAscending(id), protocolHash: store.protocolHash(id) };
  });
  app.get('/artifacts/:id', async (req, reply) => {
    const a = store.artifactFile((req.params as { id: string }).id);
    return reply.type(a.mime).send(fs.readFileSync(a.path));
  });

  // ---------- tasks ----------
  app.get('/tasks', async (req) => store.listTasks({ status: (req.query as { status?: string }).status }));
  app.get('/tasks/:id', async (req) => store.getTask((req.params as { id: string }).id));
  app.post('/tasks/:id/complete', async (req) => {
    const b = z
      .object({ approved: z.boolean(), selectedKeys: z.array(z.string()).default([]), comment: z.string().optional() })
      .parse(req.body) as TaskDecision;
    await completeTask((req.params as { id: string }).id, b);
    return { ok: true };
  });

  // ---------- schedules ----------
  const scheduleBody = z.object({
    name: z.string().min(1),
    processId: z.string(),
    cron: z.string().min(1),
    timezone: z.string().optional(),
    inputs: z.record(z.unknown()).default({}),
    bindings: z.record(z.string()).default({}),
    dryRun: z.boolean().default(false),
    enabled: z.boolean().default(true),
    allowOverlap: z.boolean().default(false),
  });
  app.get('/schedules', async () => scheduler.listSchedules());
  app.post('/schedules', async (req) => scheduler.saveSchedule(scheduleBody.parse(req.body)));
  app.put('/schedules/:id', async (req) => scheduler.saveSchedule(scheduleBody.parse(req.body), (req.params as { id: string }).id));
  app.delete('/schedules/:id', async (req) => {
    scheduler.deleteSchedule((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/schedules/:id/run', async (req) => {
    const id = await scheduler.fire((req.params as { id: string }).id, true);
    if (!id) throw new HttpError(409, 'Run was not started – see audit log');
    return { id };
  });
  app.post('/cron/preview', async (req) => {
    const b = z.object({ cron: z.string(), timezone: z.string().optional() }).parse(req.body);
    return { next: scheduler.validateCron(b.cron, b.timezone) };
  });

  // ---------- audit ----------
  app.get('/audit', async (req) => {
    const q = req.query as Record<string, string>;
    return queryAudit({ ...q, beforeSeq: q.beforeSeq ? Number(q.beforeSeq) : undefined, limit: q.limit ? Number(q.limit) : undefined });
  });
  app.get('/audit/verify', async () => {
    const r = verifyAudit();
    audit({ action: 'audit.verified', entityType: 'audit', summary: `Audit chain verified: ${r.message}`, details: r });
    return r;
  });
  app.get('/audit/export', async (req, reply) => {
    const format = (req.query as { format?: string }).format ?? 'jsonl';
    const all = allAuditAscending();
    audit({ action: 'audit.exported', entityType: 'audit', summary: `Audit log exported (${all.length} entries, ${format})` });
    if (format === 'csv') {
      const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['seq,ts,actor,action,entityType,entityId,runId,summary,hash'].concat(
        all.map((a) => [a.seq, a.ts, a.actor, a.action, a.entityType, a.entityId, a.runId, a.summary, a.hash].map(cell).join(',')),
      );
      reply.header('content-disposition', 'attachment; filename="audit-log.csv"');
      return reply.type('text/csv').send(lines.join('\n'));
    }
    reply.header('content-disposition', 'attachment; filename="audit-log.jsonl"');
    return reply.type('application/x-ndjson').send(all.map((a) => JSON.stringify(a)).join('\n'));
  });

  // ---------- dashboard ----------
  app.get('/dashboard', async (): Promise<DashboardData> => {
    const since = new Date(Date.now() - 86400000).toISOString();
    const failedChecks = db()
      .all<{ run_id: string; process_name: string; name: string; output: string; finished_at: string }>(
        `SELECT s.run_id, r.process_name, s.name, s.output, s.finished_at FROM run_steps s JOIN runs r ON r.id = s.run_id
         WHERE s.type = 'check' AND s.status = 'failed' AND s.finished_at > ? ORDER BY s.finished_at DESC LIMIT 20`,
        new Date(Date.now() - 7 * 86400000).toISOString(),
      )
      .map((r) => {
        const o = JSON.parse(r.output ?? '{}') as { message?: string; severity?: string };
        return { runId: r.run_id, processName: r.process_name, name: r.name, message: o.message ?? '', severity: o.severity ?? 'error', ts: r.finished_at };
      });
    const n = (sql: string, ...p: unknown[]) => db().get<{ n: number }>(sql, ...p)!.n;
    return {
      openTasks: store.listTasks({ status: 'open' }),
      activeRuns: store.listRuns({ status: 'running,waiting,interrupted', limit: 20 }),
      recentRuns: store.listRuns({ limit: 12 }),
      failedChecks,
      upcoming: scheduler.upcoming(),
      counts: {
        platforms: n('SELECT COUNT(*) AS n FROM platforms'),
        processes: n('SELECT COUNT(*) AS n FROM processes WHERE archived = 0'),
        schedules: n('SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1'),
        runs24h: n('SELECT COUNT(*) AS n FROM runs WHERE started_at > ?', since),
        failed24h: n("SELECT COUNT(*) AS n FROM runs WHERE started_at > ? AND status = 'failed'", since),
      },
    };
  });

  // ---------- demo ----------
  app.post('/demo/setup', async () => {
    if (!config.demo) throw new HttpError(404, 'Demo mode is not enabled (start with npm run demo)');
    return setupDemo();
  });
}

function redact<T>(v: T, secrets: Record<string, string>): T {
  const vals = secretValues(secrets);
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return vals.reduce((s, sec) => (sec && s.includes(sec) ? s.split(sec).join('***') : s), x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  return walk(v) as T;
}
