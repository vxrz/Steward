import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { bundleFileSchema, type BundleFile } from './bundleSchema.js';
import {
  SYNC_MIN_VERSION_RE,
  boundedRecord,
  type ProcessTemplate,
  type TemplateBundle,
  type TemplateBundleExisting,
  type TemplateBundleSetupItem,
  type TemplateBundleSetupRequest,
  type TemplateBundleSetupResult,
} from '@sm/shared';
import { config, env } from '../config.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { HttpError, slugify } from '../util.js';
import { parseYaml } from '../yaml-safe.js';
import { capabilities } from '../auth/permissions.js';
import { currentActor, currentUser } from '../auth/context.js';
import { authorizeStart, startProblem } from '../engine/commands.js';
import { me } from '../auth/access.js';
import { getPlatform } from '../platforms/service.js';
import { createProcess, getProcess, listTemplates, permissionsFor, saveProcess } from '../processes/service.js';
import { createDashboard, getDashboard, listDashboardTemplates, saveDashboard } from '../dashboards/service.js';

/**
 * Template bundles (v0.4.0): a set of templates that belong together – the processes that feed a dashboard, their
 * recommended schedules and optional monitors – declared in examples/bundles/*.yaml and set up in one go. Everything
 * the setup creates is the ordinary object (a process from its template, a dashboard, a schedule, a monitor); the
 * schedules and monitors start switched off, and the result's "turn on" step switches them on. Re-running a setup
 * finds what exists (by the ids a template setup gives them) and updates or skips it.
 *
 * Not to be confused with the export bundle of Processes (steward-bundle JSON: a backup-like package of processes and
 * dashboards) – in the web UI that one is the "export package".
 */

const bundlesDir = () => path.join(env.SM_EXAMPLES_DIR ?? path.join(config.templatesDir, '..'), 'bundles');

function minVersionOf(text: string): string | null {
  for (const line of text.split(/\r?\n/, 30)) {
    const l = line.trim();
    if (l === '' || l === '---') continue;
    if (!l.startsWith('#')) break;
    const m = SYNC_MIN_VERSION_RE.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

interface LoadedBundle {
  id: string;
  file: BundleFile;
  minVersion: string | null;
}

/** The bundle files, parsed and checked; an invalid file is left out (and logged). */
function loadBundles(): LoadedBundle[] {
  const dir = bundlesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^[\w.-]+\.ya?ml$/i.test(f))
    .sort()
    .flatMap((f) => {
      try {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const r = bundleFileSchema.safeParse(parseYaml(text, { maxBytes: 256 * 1024 }));
        if (!r.success) {
          logger.warn({ bundle: f, issues: r.error.issues.slice(0, 5) }, 'invalid template bundle');
          return [];
        }
        return [{ id: f.replace(/\.ya?ml$/i, ''), file: r.data, minVersion: minVersionOf(text) }];
      } catch (e) {
        logger.warn({ bundle: f, err: (e as Error).message }, 'template bundle not readable');
        return [];
      }
    });
}

/** The id a template setup gives its process or dashboard (createFromTemplate, POST /dashboards with templateId). */
export const templateObjectId = (templateId: string) => slugify(templateId.replace(/^\d+-/, ''));

/**
 * The process a template setup made: the template's id (ih-inventory-snapshot), or – when that id was taken, e.g. by an
 * archived process – a numbered one (ih-inventory-snapshot-2) whose first version was created from the template.
 */
function existingProcess(templateId: string): TemplateBundleExisting | null {
  const id = templateObjectId(templateId);
  const rows = db().all<{ id: string; name: string; comment: string }>(
    `SELECT p.id, p.name, v.comment FROM processes p LEFT JOIN process_versions v ON v.process_id = p.id AND v.version = 1
     WHERE p.archived = 0 AND (p.id = ? OR lower(p.id) LIKE lower(?)) ORDER BY p.created_at, p.id`,
    id,
    `${id}-%`,
  );
  const fromTemplate = (c: string) => c === `Created from template ${templateId}` || c.startsWith(`Created from template ${templateId} `);
  const r = rows.find((x) => x.id === id) ?? rows.find((x) => /^\d+$/.test(x.id.slice(id.length + 1)) && fromTemplate(x.comment ?? ''));
  return r && permissionsFor(r.id).includes('view') ? { id: r.id, name: r.name } : null;
}

function existingSchedule(processId: string | undefined): TemplateBundleExisting | null {
  if (!processId) return null;
  const r = db().get<{ id: string; name: string }>('SELECT id, name FROM schedules WHERE process_id = ? ORDER BY created_at LIMIT 1', processId);
  return r ? { id: r.id, name: r.name } : null;
}

function existingDashboard(templateId: string): TemplateBundleExisting | null {
  try {
    const d = getDashboard(templateObjectId(templateId));
    return { id: d.id, name: d.name };
  } catch {
    return null;
  }
}

function existingMonitor(key: string | null): TemplateBundleExisting | null {
  if (!key) return null;
  const r = db().get<{ id: string; name: string }>('SELECT id, name FROM monitors WHERE key = ?', key);
  return r ? { id: r.id, name: r.name } : null;
}

/** The bundle platform a connection slot is bound to: named in the bundle, else the first whose kinds fit the slot. */
function slotBindings(b: BundleFile, p: BundleFile['processes'][number], t: ProcessTemplate | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of t?.connections ?? []) {
    const named = p.connections?.[c.slot];
    const fit =
      named ??
      b.platforms.find((x) => !c.kinds.length || c.kinds.some((k) => x.kinds.includes(k)))?.key ??
      (b.platforms.length === 1 ? b.platforms[0]!.key : undefined);
    if (fit) out[c.slot] = fit;
  }
  return out;
}

function scheduleOf(p: BundleFile['processes'][number], t: ProcessTemplate | undefined): { cron: string; text: string } | null {
  if (p.schedule === 'none') return null;
  const cron = p.schedule ?? t?.recommendedSchedule?.cron ?? null;
  return cron ? { cron, text: t?.recommendedSchedule?.text ?? '' } : null;
}

function describe(b: LoadedBundle, templates: ProcessTemplate[], monitorExamples: { file: string; key: string | null; name: string }[]): TemplateBundle {
  const problems: string[] = [];
  const dashTemplates = listDashboardTemplates();
  const processes = b.file.processes.map((p) => {
    const t = templates.find((x) => x.id === p.template);
    if (!t) problems.push(`The process template "${p.template}" is missing`);
    const existing = t ? existingProcess(t.id) : null;
    return {
      template: p.template,
      name: t?.name ?? p.template,
      schedule: scheduleOf(p, t),
      connections: slotBindings(b.file, p, t),
      existing,
      existingSchedule: existingSchedule(existing?.id),
    };
  });
  const dashboards = b.file.dashboards.map((d) => {
    const t = dashTemplates.find((x) => x.id === d);
    if (!t) problems.push(`The dashboard template "${d}" is missing`);
    return { template: d, name: t?.name ?? d, existing: t ? existingDashboard(d) : null };
  });
  const monitors = b.file.monitors.map((m) => {
    const ex = monitorExamples.find((x) => x.file === m.file);
    if (!ex) problems.push(`The monitor example "${m.file}" is missing`);
    return { file: m.file, name: ex?.name ?? m.file, key: ex?.key ?? null, optional: m.optional, existing: existingMonitor(ex?.key ?? null) };
  });
  return {
    id: b.id,
    name: b.file.name,
    description: b.file.description.trim(),
    tags: b.file.tags,
    platforms: b.file.platforms,
    kinds: [...new Set(b.file.platforms.flatMap((p) => p.kinds))].sort(),
    processes,
    dashboards,
    monitors,
    minVersion: b.minVersion,
    problems,
  };
}

async function monitorExamples(): Promise<{ file: string; key: string | null; name: string }[]> {
  const { listExamples } = await import('../monitors/service.js');
  return listExamples().map((e) => ({ file: e.file, key: e.key, name: e.name }));
}

export async function listBundles(): Promise<TemplateBundle[]> {
  const templates = listTemplates();
  const examples = await monitorExamples();
  return loadBundles().map((b) => describe(b, templates, examples));
}

export async function getBundle(id: string): Promise<TemplateBundle> {
  const b = loadBundles().find((x) => x.id === id);
  if (!b) throw new HttpError(404, `Template bundle ${id} not found`, 'BUNDLE_NOT_FOUND', { id: id.slice(0, 100) });
  return describe(b, listTemplates(), await monitorExamples());
}

export const setupInput = z
  .object({
    bindings: boundedRecord(z.string().min(1).max(200), 10).default({}),
    existing: z.enum(['update', 'skip']).default('skip'),
    monitors: z.boolean().default(true),
    dryRuns: z.boolean().default(true),
  })
  .strict();

/** The platform bound to each bundle platform: it exists, fits the kinds and the user may use it. */
function checkBindings(b: LoadedBundle, bindings: Record<string, string>): Map<string, { id: string; name: string; kind: string }> {
  const out = new Map<string, { id: string; name: string; kind: string }>();
  for (const bp of b.file.platforms) {
    const id = bindings[bp.key];
    if (!id) throw new HttpError(400, `Choose the platform for "${bp.label}"`, 'BUNDLE_BINDING_MISSING', { label: bp.label });
    let p;
    try {
      p = getPlatform(id);
    } catch {
      p = null;
    }
    // a platform the user may not see answers like a missing one
    if (!p || !p.permissions.length) throw new HttpError(400, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id: id.slice(0, 100) });
    if (!p.permissions.includes('use'))
      throw new HttpError(403, `You are not allowed to use the platform "${p.name}"`, 'PLATFORM_USE_FORBIDDEN', { name: p.name });
    if (!bp.kinds.includes(p.kind))
      throw new HttpError(400, `"${p.name}" is a ${p.kind} platform – "${bp.label}" needs ${bp.kinds.join(', ')}`, 'BUNDLE_BINDING_KIND', {
        name: p.name,
        label: bp.label,
        kinds: bp.kinds,
      });
    out.set(bp.key, { id: p.id, name: p.name, kind: p.kind });
  }
  return out;
}

const msg = (e: unknown) => ((e as Error).message ?? String(e)).slice(0, 300);

/**
 * Sets a bundle up: processes from their templates, dashboards, schedules (off), monitors (off) and one dry run per
 * process. Items that exist are updated (processes, dashboards; `existing: update`) or skipped; schedules and monitors
 * that exist are kept – they hold the user's own settings. Every item is audited by the service that makes it, the
 * setup itself once more (template_bundle.setup).
 */
export async function setupBundle(id: string, req: TemplateBundleSetupRequest): Promise<TemplateBundleSetupResult> {
  const u = me();
  const caps = capabilities(u);
  if (!caps.createProcesses) throw new HttpError(403, 'You are not allowed to set up template bundles', 'FORBIDDEN', { context: 'setupBundle' });
  const b = loadBundles().find((x) => x.id === id);
  if (!b) throw new HttpError(404, `Template bundle ${id} not found`, 'BUNDLE_NOT_FOUND', { id: id.slice(0, 100) });
  const bound = checkBindings(b, req.bindings);
  const templates = listTemplates();
  const items: TemplateBundleSetupItem[] = [];
  const turnOn = { schedules: [] as string[], monitors: [] as string[] };
  const existingMode = req.existing ?? 'skip';
  const toRun: { processId: string; name: string; bindings: Record<string, string>; inputs: Record<string, unknown> }[] = [];

  const { saveSchedule } = await import('../scheduler.js');
  for (const p of b.file.processes) {
    const t = templates.find((x) => x.id === p.template);
    if (!t) {
      items.push({ type: 'process', source: p.template, name: p.template, action: 'failed', id: null, link: null, message: 'The template is missing' });
      continue;
    }
    const bindings = Object.fromEntries(Object.entries(slotBindings(b.file, p, t)).map(([slot, key]) => [slot, bound.get(key)!.id]));
    let processId: string;
    const existing = existingProcess(t.id);
    try {
      if (existing && existingMode === 'skip') {
        processId = existing.id;
        items.push({ type: 'process', source: t.id, name: existing.name, action: 'skipped', id: existing.id, link: `/processes/${existing.id}` });
      } else if (existing) {
        if (!permissionsFor(existing.id).includes('edit')) throw new HttpError(403, 'You may not edit this process', 'FORBIDDEN', { context: 'editProcess' });
        const before = getProcess(existing.id).currentVersion;
        const saved = saveProcess(existing.id, t.definition, `Updated from the template bundle "${b.file.name}"`);
        processId = saved.id;
        items.push({
          type: 'process',
          source: t.id,
          name: saved.name,
          action: saved.currentVersion > before ? 'updated' : 'skipped',
          id: saved.id,
          link: `/processes/${saved.id}`,
          ...(saved.currentVersion > before ? {} : { message: 'Already the template version' }),
        });
      } else {
        const created = createProcess(t.definition, { id: templateObjectId(t.id), comment: `Created from template ${t.id} (bundle "${b.file.name}")` });
        processId = created.id;
        items.push({ type: 'process', source: t.id, name: created.name, action: 'created', id: created.id, link: `/processes/${created.id}` });
      }
    } catch (e) {
      items.push({ type: 'process', source: t.id, name: t.name, action: 'failed', id: null, link: null, message: msg(e) });
      continue;
    }
    // the schedule: off until the "turn on" step; a schedule of the process that exists is kept
    const sched = scheduleOf(p, t);
    if (sched) {
      const has = existingSchedule(processId);
      if (has) items.push({ type: 'schedule', source: t.id, name: has.name, action: 'kept', id: has.id, link: '/schedules' });
      else
        try {
          // a process set up before by someone else: only who may run it schedules it (as POST /schedules)
          if (!permissionsFor(processId).includes('run')) throw new HttpError(403, 'You may not run this process', 'FORBIDDEN', { context: 'runProcess' });
          const s = saveSchedule({
            name: t.name,
            processId,
            cron: sched.cron,
            inputs: p.inputs ?? {},
            bindings,
            dryRun: false,
            enabled: false,
            allowOverlap: false,
          } as Parameters<typeof saveSchedule>[0]);
          turnOn.schedules.push(s.id);
          items.push({ type: 'schedule', source: t.id, name: `${s.name} (${sched.cron})`, action: 'created', id: s.id, link: '/schedules' });
        } catch (e) {
          items.push({ type: 'schedule', source: t.id, name: t.name, action: 'failed', id: null, link: null, message: msg(e) });
        }
    }
    if (p.dryRun && req.dryRuns !== false) toRun.push({ processId, name: t.name, bindings, inputs: p.inputs ?? {} });
  }

  const dashTemplates = listDashboardTemplates();
  for (const d of b.file.dashboards) {
    const t = dashTemplates.find((x) => x.id === d);
    if (!t) {
      items.push({ type: 'dashboard', source: d, name: d, action: 'failed', id: null, link: null, message: 'The template is missing' });
      continue;
    }
    const existing = existingDashboard(d);
    try {
      if (existing && existingMode === 'skip')
        items.push({ type: 'dashboard', source: d, name: existing.name, action: 'skipped', id: existing.id, link: `/dashboards/${existing.id}` });
      else if (existing) {
        const saved = saveDashboard(existing.id, t.definition);
        items.push({ type: 'dashboard', source: d, name: saved.name, action: 'updated', id: saved.id, link: `/dashboards/${saved.id}` });
      } else {
        const created = createDashboard(t.definition, { id: templateObjectId(d) });
        items.push({ type: 'dashboard', source: d, name: created.name, action: 'created', id: created.id, link: `/dashboards/${created.id}` });
      }
    } catch (e) {
      items.push({ type: 'dashboard', source: d, name: t.name, action: 'failed', id: null, link: null, message: msg(e) });
    }
  }

  const mon = await import('../monitors/service.js');
  const examples = mon.listExamples();
  for (const m of b.file.monitors) {
    if (m.optional && req.monitors === false) continue;
    const ex = examples.find((x) => x.file === m.file);
    if (!ex) {
      items.push({ type: 'monitor', source: m.file, name: m.file, action: 'failed', id: null, link: null, message: 'The example is missing' });
      continue;
    }
    const has = existingMonitor(ex.key);
    if (has) {
      items.push({ type: 'monitor', source: m.file, name: has.name, action: 'kept', id: has.id, link: `/monitors/${has.id}` });
      continue;
    }
    try {
      if (!caps.createMonitors) throw new HttpError(403, 'You are not allowed to create monitors', 'FORBIDDEN', { context: 'createMonitors' });
      // every platform reference of the example goes to the bound platform of its kind (or the only one)
      const map: Record<string, string> = {};
      for (const ref of mon.exampleReferences(m.file)) {
        const fit = [...bound.values()].find((x) => !ref.kind || x.kind === ref.kind) ?? (bound.size === 1 ? [...bound.values()][0] : undefined);
        if (fit) map[ref.ref] = fit.id;
      }
      const r = await mon.importExample(m.file, { platforms: map, enabled: false });
      turnOn.monitors.push(r.monitor.id);
      items.push({ type: 'monitor', source: m.file, name: r.monitor.name, action: 'created', id: r.monitor.id, link: `/monitors/${r.monitor.id}` });
    } catch (e) {
      items.push({ type: 'monitor', source: m.file, name: ex.name, action: 'failed', id: null, link: null, message: msg(e) });
    }
  }

  // one dry run per process: it simulates every change and writes the full protocol
  if (toRun.length) {
    const { engine } = await import('../engine/index.js');
    for (const r of toRun) {
      try {
        // the command layer's start check (ADR 0011): run, and use on the bound platforms
        if (startProblem(undefined, { processId: r.processId, bindings: r.bindings }))
          throw new HttpError(403, 'You may not run this process', 'FORBIDDEN', { context: 'runProcess' });
        const { runId } = await engine().start({
          processId: r.processId,
          inputs: r.inputs ?? {},
          bindings: r.bindings ?? {},
          mode: 'dry',
          actor: currentActor(),
          origin: { trigger: 'manual' },
        });
        items.push({ type: 'dryRun', source: r.processId, name: r.name, action: 'started', id: runId, link: `/runs/${runId}` });
      } catch (e) {
        items.push({ type: 'dryRun', source: r.processId, name: r.name, action: 'failed', id: null, link: `/processes/${r.processId}`, message: msg(e) });
      }
    }
  }

  const count = (a: TemplateBundleSetupItem['action']) => items.filter((i) => i.action === a && i.type !== 'dryRun').length;
  audit({
    action: 'template_bundle.setup',
    entityType: 'template_bundle',
    entityId: b.id,
    summary: `Template bundle "${b.file.name}" set up on ${[...bound.values()].map((p) => `"${p.name}"`).join(', ')}: ${count('created')} created, ${count('updated')} updated, ${count('skipped') + count('kept')} kept, ${count('failed')} failed${toRun.length ? `, ${items.filter((i) => i.type === 'dryRun' && i.action === 'started').length} dry run(s)` : ''}`,
    details: {
      bindings: Object.fromEntries([...bound].map(([k, p]) => [k, p.id])),
      existing: existingMode,
      items: items.map((i) => ({ type: i.type, source: i.source, action: i.action, id: i.id })),
    },
  });
  return { bundle: { id: b.id, name: b.file.name }, items, turnOn };
}

export const turnOnInput = z
  .object({ schedules: z.array(z.string().min(1).max(100)).max(50).default([]), monitors: z.array(z.string().min(1).max(100)).max(50).default([]) })
  .strict();

/** The "turn on" step after a setup: switches the bundle's schedules and monitors on (each with its own rights check). */
export async function turnOnBundle(id: string, input: z.infer<typeof turnOnInput>): Promise<{ items: TemplateBundleSetupItem[] }> {
  if (!capabilities(me()).createProcesses) throw new HttpError(403, 'You are not allowed to set up template bundles', 'FORBIDDEN', { context: 'setupBundle' });
  const b = loadBundles().find((x) => x.id === id);
  if (!b) throw new HttpError(404, `Template bundle ${id} not found`, 'BUNDLE_NOT_FOUND', { id: id.slice(0, 100) });
  const scheduler = await import('../scheduler.js');
  const mon = await import('../monitors/service.js');
  const items: TemplateBundleSetupItem[] = [];
  for (const sid of input.schedules) {
    try {
      scheduler.requireScheduleEdit(sid);
      const s = scheduler.getSchedule(sid);
      if (startProblem(undefined, { processId: s.processId })) throw new HttpError(403, 'You may not run this process', 'FORBIDDEN', { context: 'runProcess' });
      authorizeStart(undefined, { processId: s.processId, bindings: s.bindings });
      const { id: _id, createdAt: _c, processName: _p, lastRunAt: _l, lastRunId: _r, lastRunStatus: _s, nextRunAt: _n, ...rest } = s;
      const saved = scheduler.saveSchedule({ ...rest, enabled: true }, sid);
      items.push({ type: 'schedule', source: saved.processId, name: saved.name, action: 'updated', id: saved.id, link: '/schedules', message: 'on' });
    } catch (e) {
      items.push({ type: 'schedule', source: sid, name: sid, action: 'failed', id: sid, link: '/schedules', message: msg(e) });
    }
  }
  for (const mid of input.monitors) {
    try {
      const m = mon.setEnabled(mid, true);
      items.push({ type: 'monitor', source: m.key, name: m.name, action: 'updated', id: m.id, link: `/monitors/${m.id}`, message: 'on' });
    } catch (e) {
      items.push({ type: 'monitor', source: mid, name: mid, action: 'failed', id: mid, link: null, message: msg(e) });
    }
  }
  audit({
    action: 'template_bundle.turned_on',
    entityType: 'template_bundle',
    entityId: b.id,
    summary: `Template bundle "${b.file.name}": ${items.filter((i) => i.action === 'updated').length} schedule(s) and monitor(s) turned on${items.some((i) => i.action === 'failed') ? `, ${items.filter((i) => i.action === 'failed').length} failed` : ''}`,
    details: { items: items.map((i) => ({ type: i.type, id: i.id, action: i.action })) },
  });
  return { items };
}

/** Whether the current user may set up bundles (the gallery shows the button). */
export const canSetUpBundles = () => capabilities(currentUser()).createProcesses;
