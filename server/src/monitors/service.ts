import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  HIDDEN_MONITOR_REF,
  type MonitorPlatformReference,
  MONITOR_KEY_RE,
  MONITOR_PERMISSIONS,
  RESERVED_MONITOR_KEYS,
  definitionIssues,
  issueLabel,
  findCycle,
  type AclEntry,
  type CheckDef,
  type CheckResultInfo,
  type CheckState,
  type MaintenanceWindow,
  type MonitorDefinition,
  type MonitorDetail,
  type MonitorHistoryEntry,
  type MonitorPermission,
  type MonitorSaveResult,
  type MonitorStatus,
  type MonitorSummary,
  type TemplateParam,
  isGitPlatformKind,
  validMqttFilter,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { config } from '../config.js';
import { errorParam, HttpError, newId, nowIso, parseJson, pathInside, sha256, slugify } from '../util.js';
import { parseYaml } from '../yaml-safe.js';

/** Largest monitor file (the import route accepts 512 KB). */
export const MONITOR_YAML_BYTES = 1024 * 1024;
import { currentUser } from '../auth/context.js';
import { cleanAcl } from '../auth/permissions.js';
import { getPlatform, listPlatforms } from '../platforms/service.js';
import { getProcess, permissionsFor } from '../processes/service.js';
import {
  canCreateMonitors,
  checkCritical,
  checkEnabled,
  checkKey,
  loadMonitor,
  monitorRow,
  parseCauses,
  permissionsOfRow,
  type CheckRow,
  type MonitorRow,
  type StateRow,
} from './model.js';
import { resolvePlatformRef } from './platforms.js';
import { checkUptimes, monitorUptime } from './stats.js';
import { coerceParams, renderTemplate } from './templates.js';
import { checkExpressions, parseDefinitionInput, validateTemplate } from './validation.js';
import * as engine from './engine.js';
import { checkMessage, monitorVisibility, redactCauses, redactDefinition, rootCauseMessage, type MonitorVisibility } from './redact.js';

/**
 * Monitor management: create, edit, delete, access, heartbeat secrets,
 * maintenance windows, acknowledgements, templates and YAML import/export.
 * Definitions are stored as they are now; every change is in the audit log.
 */

export const HEARTBEAT_SECRET_PREFIX = 'mhs_';
export const heartbeatPath = (hookId: string) => `/api/hooks/monitor/${hookId}`;
const MONITOR_ID_RE = /^mon_[A-Za-z0-9_-]{6,40}$/;

const me = () => {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
  return u;
};

// ---------- access ----------

/** The monitor if the current user may see it (404 otherwise) and has `perm` (403 otherwise). */
export function requireMonitor(idOrKey: string, perm: MonitorPermission = 'view', what = 'change this monitor'): MonitorRow {
  const r = monitorRow(idOrKey);
  if (!r || !permissionsOfRow(r).includes('view')) throw new HttpError(404, 'Monitor not found', 'MONITOR_NOT_FOUND');
  if (!permissionsOfRow(r).includes(perm)) throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN', { context: `right_${perm}` });
  return r;
}

export function requireCreate(): void {
  if (!canCreateMonitors(me())) throw new HttpError(403, 'Only designers and administrators can create monitors', 'FORBIDDEN', { context: 'createMonitors' });
}

/** 400 for a monitor definition with problems (the problems themselves stay English, like schema messages). */
/** Issues name the card (`Check "Name" (id) – field: …`); `issues` keeps the paths for editors (#141). */
function invalidMonitor(issues: { path: string; message: string }[], def?: unknown): HttpError {
  const details = issues.map((i) => `${def === undefined ? i.path : issueLabel(def, i.path)}: ${i.message}`).join('; ');
  return Object.assign(new HttpError(400, details, 'MONITOR_INVALID', { details }), { issues: issues.map((i) => ({ path: i.path, message: i.message })) });
}

// ---------- read ----------

interface Joined extends MonitorRow {
  status: MonitorStatus | null;
  since: string | null;
  root_causes: string | null;
  last_evaluated_at: string | null;
  ack_by: string | null;
  ack_at: string | null;
  ack_comment: string | null;
}

const SELECT = `SELECT m.*, s.status, s.since, s.root_causes, s.last_evaluated_at, s.ack_by, s.ack_at, s.ack_comment
  FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id`;

function maintenanceOf(mid: string, now = engine.monitorNow()): MaintenanceWindow | null {
  const w = engine.activeMaintenance(mid, now);
  if (!w) return null;
  const own = listMaintenanceRows(mid).find((x) => x.id === w.id);
  if (own) return own;
  // a maintenance window of the catalogue on one of the monitor's platforms (#108)
  const c = w as typeof w & { starts_at?: string };
  return { id: w.id, monitorId: mid, startsAt: c.starts_at ?? '', endsAt: w.ends_at, reason: w.reason, createdBy: '', createdAt: '', active: true };
}

function summary(r: Joined, counts: Partial<Record<MonitorStatus, number>> | undefined, canView: MonitorVisibility): MonitorSummary {
  const def = parseJson<Partial<MonitorDefinition>>(r.definition, {});
  const tVersion = r.template_id ? db().get<{ version: number }>('SELECT version FROM monitors WHERE id = ?', r.template_id)?.version : undefined;
  const status: MonitorStatus = r.is_template ? 'unknown' : !r.enabled ? 'unknown' : (r.status ?? 'unknown');
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: def.description ?? '',
    tags: def.tags ?? [],
    owner: r.owner,
    enabled: !!r.enabled,
    isTemplate: !!r.is_template,
    templateId: r.template_id,
    templateVersion: r.template_version,
    templateOutdated: !!r.template_id && tVersion !== undefined && tVersion !== r.template_version,
    version: r.version,
    status,
    since: r.since,
    rootCauses: r.enabled ? redactCauses(parseCauses(r.root_causes), canView) : [],
    counts: counts ?? {},
    checkCount: def.checks?.length ?? 0,
    uptime: r.is_template ? { h24: null, d7: null, d30: null } : monitorUptime(r.id, engine.monitorNow()),
    maintenance: r.is_template ? null : maintenanceOf(r.id),
    acknowledged: r.ack_by ? { by: r.ack_by, at: r.ack_at!, comment: r.ack_comment ?? '' } : null,
    permissions: permissionsOfRow(r),
    updatedAt: r.updated_at,
    lastEvaluatedAt: r.last_evaluated_at,
  };
}

export function listMonitors(opts: { templates?: boolean } = {}): MonitorSummary[] {
  const rows = db()
    .all<Joined>(`${SELECT} ORDER BY m.name`)
    .filter((r) => (opts.templates === undefined ? true : !!r.is_template === opts.templates))
    .filter((r) => permissionsOfRow(r).includes('view'));
  const counts = new Map<string, Partial<Record<MonitorStatus, number>>>();
  for (const c of db().all<{ monitor_id: string; status: MonitorStatus; n: number }>(
    'SELECT monitor_id, status, COUNT(*) AS n FROM monitor_checks GROUP BY monitor_id, status',
  )) {
    const x = counts.get(c.monitor_id) ?? {};
    x[c.status] = Number(c.n);
    counts.set(c.monitor_id, x);
  }
  const canView = monitorVisibility();
  return rows.map((r) => summary(r, counts.get(r.id), canView));
}

/**
 * Down and degraded monitors the current user may view, for the start page; null when they may neither
 * view a monitor nor create one (no tile). Same rules as the list, without its per-monitor details.
 */
export function monitorAttention(): { down: number; degraded: number } | null {
  const rows = db()
    .all<Joined>(`${SELECT} WHERE m.is_template = 0`)
    .filter((r) => permissionsOfRow(r).includes('view'));
  if (!rows.length && !canCreateMonitors(currentUser())) return null;
  const live = rows.filter((r) => r.enabled);
  return { down: live.filter((r) => r.status === 'down').length, degraded: live.filter((r) => r.status === 'degraded').length };
}

function checkStates(r: Joined, def: MonitorDefinition, canView: MonitorVisibility): CheckState[] {
  const rows = new Map(
    db()
      .all<CheckRow>('SELECT * FROM monitor_checks WHERE monitor_id = ?', r.id)
      .map((x) => [x.check_id, x]),
  );
  const uptimes = checkUptimes([r.id], engine.monitorNow());
  const inMaint = !!engine.activeMaintenance(r.id);
  return def.checks.map((c) => {
    const x = rows.get(c.id);
    const last = parseJson<CheckResultInfo | null>(x?.last_result, null);
    if (last) last.message = checkMessage(last.message ?? '', last.status, c.type === 'monitor' ? c.monitor : undefined, canView);
    const st: CheckState = {
      checkId: c.id,
      name: c.name,
      type: c.type,
      key: checkKey(r, c),
      critical: checkCritical(c),
      enabled: checkEnabled(c),
      status: !r.enabled || !checkEnabled(c) ? 'unknown' : inMaint ? 'maintenance' : (x?.status ?? 'unknown'),
      since: x?.since ?? null,
      last,
      lastOkAt: x?.last_ok_at ?? null,
      nextCheckAt: engine.nextCheckAt(r.id, c.id),
      consecutiveFailures: x?.consecutive_failures ?? 0,
      consecutiveSuccesses: x?.consecutive_successes ?? 0,
      causedBy: redactCauses(parseCauses(x?.caused_by), canView),
      note: x?.note ?? null,
      uptime: uptimes.get(`${r.id}/${c.id}`) ?? { h24: null, d7: null, d30: null },
    };
    if (c.type === 'heartbeat') {
      st.heartbeat = {
        path: x?.hook_id ? heartbeatPath(x.hook_id) : '',
        secretPrefix: x?.secret_prefix ?? null,
        authMode: c.authMode,
        lastPushAt: x?.last_push_at ?? null,
        lastPush: parseJson(x?.last_push, null),
      };
    }
    if (c.type === 'monitor') {
      const sub = db().get<{ id: string; key: string; name: string }>('SELECT id, key, name FROM monitors WHERE id = ?', c.monitor);
      st.monitorRef = !sub ? null : canView(sub.id) ? sub : { id: '', key: '', name: '', hidden: true };
    }
    return st;
  });
}

function usedBy(id: string): { id: string; key: string; name: string }[] {
  return db()
    .all<MonitorRow>('SELECT * FROM monitors')
    .filter((m) => parseJson<{ checks?: { type: string; monitor?: string }[] }>(m.definition, {}).checks?.some((c) => c.type === 'monitor' && c.monitor === id))
    .filter((m) => permissionsOfRow(m).includes('view'))
    .map((m) => ({ id: m.id, key: m.key, name: m.name }));
}

export function getMonitor(idOrKey: string): MonitorDetail {
  const base = requireMonitor(idOrKey);
  const r = db().get<Joined>(`${SELECT} WHERE m.id = ?`, base.id)!;
  const raw = parseJson<MonitorDefinition>(r.definition, {} as MonitorDefinition);
  // templates may hold placeholders where numbers are expected: shown as stored
  const def = r.is_template ? raw : loadMonitor(r).def;
  const canView = monitorVisibility();
  const counts: Partial<Record<MonitorStatus, number>> = {};
  const checks = r.is_template ? [] : checkStates(r, def, canView);
  for (const c of checks) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return {
    ...summary(r, counts, canView),
    definition: r.is_template ? def : redactDefinition(def, canView),
    acl: parseJson<AclEntry<MonitorPermission>[]>(r.acl, []),
    templateParams: parseJson(r.template_params, null),
    checks,
    usedBy: usedBy(r.id),
    createdAt: r.created_at,
  };
}

/** Sub-monitor checks of a monitor now: check id → referenced monitor id. */
function subMonitorRefs(r: MonitorRow): Map<string, string> {
  if (r.is_template) return new Map();
  return new Map(loadMonitor(r).def.checks.flatMap((c) => (c.type === 'monitor' ? [[c.id, c.monitor] as const] : [])));
}

export function listHistory(idOrKey: string, opts: { checkId?: string; limit?: number; beforeId?: number } = {}): MonitorHistoryEntry[] {
  const r = requireMonitor(idOrKey);
  const canView = monitorVisibility();
  const subs = subMonitorRefs(r);
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
  const where = ['monitor_id = ?'];
  const params: unknown[] = [r.id];
  if (opts.checkId !== undefined) {
    where.push('check_id = ?');
    params.push(opts.checkId);
  }
  if (opts.beforeId) {
    where.push('id < ?');
    params.push(opts.beforeId);
  }
  return db()
    .all<{ id: number; ts: string; check_id: string; status: MonitorStatus; previous: MonitorStatus | null; message: string; caused_by: string }>(
      `SELECT * FROM monitor_history WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      ...params,
      limit,
    )
    .map((h) => {
      const causedBy = redactCauses(parseCauses(h.caused_by), canView);
      return {
        id: Number(h.id),
        ts: h.ts,
        checkId: h.check_id || null,
        status: h.status,
        previous: h.previous,
        // monitor level: built from the causes; checks: their own message
        message: h.check_id ? checkMessage(h.message, h.status, subs.get(h.check_id), canView) : causedBy.length ? rootCauseMessage(causedBy, r.id) : h.message,
        causedBy,
      };
    });
}

export function listResults(idOrKey: string, checkId: string, limit = 50): CheckResultInfo[] {
  const r = requireMonitor(idOrKey);
  const canView = monitorVisibility();
  const sub = subMonitorRefs(r).get(checkId);
  return db()
    .all<{ ts: string; status: MonitorStatus; message: string; duration_ms: number | null; value: string | null }>(
      'SELECT ts, status, message, duration_ms, value FROM monitor_results WHERE monitor_id = ? AND check_id = ? ORDER BY id DESC LIMIT ?',
      r.id,
      checkId,
      Math.min(Math.max(1, limit), 200),
    )
    .map((x) => ({
      ts: x.ts,
      status: x.status,
      message: checkMessage(x.message, x.status, sub, canView),
      durationMs: x.duration_ms,
      value: parseJson(x.value, x.value),
    }));
}

// ---------- validation ----------

const PLATFORM_KIND: Partial<Record<string, string>> = {
  freshness: 'insights-hub',
  gatus: 'gatus',
  checkmk: 'checkmk',
  prometheus: 'prometheus',
  kubernetes: 'kubernetes',
  kafka: 'kafka',
  mqtt: 'mqtt',
  snowflake: 'snowflake',
  'dependency-track': 'dependency-track',
  zabbix: 'zabbix',
};

/** The platform kind a check or output needs (undefined: any platform). */
function expectedKind(item: Record<string, unknown>, isOutput: boolean): string | undefined {
  const type = String(item.type ?? '');
  if (!isOutput && type === 'freshness') return 'insights-hub';
  return PLATFORM_KIND[type];
}

export type PlatformReference = MonitorPlatformReference;

/** Platform references of a parsed monitor or template definition (raw, not yet validated). `{{ params.x }}` values are set per instance and left out. */
export function platformReferences(definition: Record<string, unknown>): PlatformReference[] {
  const found = new Map<string, { kinds: Set<string>; usedBy: PlatformReference['usedBy'] }>();
  const visit = (items: unknown, isOutput: boolean) => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const ref = item.platform;
      if (typeof ref !== 'string' || !ref.trim() || ref.includes('{{')) continue;
      const entry = found.get(ref) ?? { kinds: new Set<string>(), usedBy: [] };
      const kind = expectedKind(item, isOutput);
      if (kind) entry.kinds.add(kind);
      const id = String(item.id ?? '');
      entry.usedBy.push({ type: isOutput ? 'output' : 'check', id, name: String(item.name ?? id) });
      found.set(ref, entry);
    }
  };
  visit(definition.checks, false);
  visit(definition.outputs, true);
  if (!found.size) return [];
  const usable = listPlatforms().filter((p) => p.permissions.includes('use'));
  return [...found].map(([ref, e]) => {
    // one kind in practice; a reference used with two different kinds has no candidate
    const kinds = [...e.kinds];
    const candidates = usable.filter((p) => kinds.every((k) => p.kind === k)).map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
    let resolved: PlatformReference['resolved'] = null;
    try {
      const r = resolvePlatformRef(ref, kinds[0]);
      const c = candidates.find((x) => x.id === r.id);
      if (c) resolved = { id: c.id, name: c.name };
    } catch {
      /* not unique – the user chooses */
    }
    return { ref, kind: kinds[0] ?? null, usedBy: e.usedBy, resolved, candidates };
  });
}

/**
 * Replaces platform references by the platforms chosen for them (reference → platform id) before the
 * usual resolution. A chosen platform must exist, be of the kind its checks and outputs need and be
 * usable by the user.
 */
export function applyPlatformMap(definition: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  if (!Object.keys(map).length) return definition;
  const out = structuredClone(definition);
  const apply = (items: unknown, isOutput: boolean) => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.platform !== 'string' || !Object.hasOwn(map, item.platform)) continue;
      const ref = item.platform;
      const id = map[ref]!;
      let p;
      try {
        p = getPlatform(id);
      } catch {
        p = null;
      }
      // a platform the user may not see answers like a missing one (no name is revealed)
      if (!p || !p.permissions.length) throw new HttpError(400, `Platform ${id} chosen for "${ref}" does not exist`, 'PLATFORM_CHOICE_NOT_FOUND', { ref, id });
      if (!p.permissions.includes('use'))
        throw new HttpError(403, `You are not allowed to use platform "${p.name}"`, 'PLATFORM_USE_FORBIDDEN', { name: p.name });
      const kind = expectedKind(item, isOutput);
      if (kind && p.kind !== kind)
        throw new HttpError(400, `Platform "${p.name}" chosen for "${ref}" is of kind ${p.kind}, not ${kind}`, 'PLATFORM_CHOICE_KIND', {
          ref,
          name: p.name,
          kind,
        });
      item.platform = p.id;
    }
  };
  apply(out.checks, false);
  apply(out.outputs, true);
  return out;
}

function requirePlatformUse(id: string): void {
  const p = getPlatform(id);
  if (!p.permissions.includes('use')) throw new HttpError(403, `You are not allowed to use platform "${p.name}"`, 'PLATFORM_USE_FORBIDDEN', { name: p.name });
}

/** Resolves platform names and monitor keys to ids and checks the rights and rules that need the database. */
function resolveReferences(def: MonitorDefinition, selfId: string | null, selfKey: string, before: MonitorDefinition | null = null): MonitorDefinition {
  const out = structuredClone(def);
  for (const c of out.checks) {
    // a sub-monitor the editor may not view comes back as HIDDEN_MONITOR_REF: the stored reference stays
    if (c.type === 'monitor' && c.monitor === HIDDEN_MONITOR_REF) {
      const old = before?.checks.find((x) => x.id === c.id);
      if (old?.type !== 'monitor') throw new HttpError(400, `Check "${c.name}": choose the monitor to include`, 'SUBMONITOR_REQUIRED', { check: c.name });
      c.monitor = old.monitor;
      continue;
    }
    if ('platform' in c && c.platform) {
      const p = resolvePlatformRef(c.platform, c.type === 'freshness' && c.source === 'insightsHub' ? 'insights-hub' : PLATFORM_KIND[c.type]);
      if (c.type === 'mqtt' && !validMqttFilter(c.topic))
        throw new HttpError(400, `Check "${c.id}": "${c.topic}" is no MQTT topic or pattern (+ and # only as whole levels, # last)`, 'CHECK_MQTT_TOPIC', {
          check: c.id,
        });
      if (c.type === 'git' && !isGitPlatformKind(p.kind))
        throw new HttpError(400, `Check "${c.id}": "${p.name}" is not a GitHub, GitLab or Forgejo/Gitea platform`, 'CHECK_GIT_PLATFORM', {
          check: c.id,
          name: p.name,
        });
      c.platform = p.id;
      requirePlatformUse(p.id);
    }
    if (c.type === 'monitor') {
      const sub = monitorRow(c.monitor);
      if (!sub || !permissionsOfRow(sub).includes('view'))
        throw new HttpError(400, `Check "${c.name}": monitor "${c.monitor}" not found`, 'SUBMONITOR_NOT_FOUND', { check: c.name, monitor: c.monitor });
      if (sub.is_template)
        throw new HttpError(400, `Check "${c.name}": "${sub.name}" is a template`, 'SUBMONITOR_TEMPLATE', { check: c.name, monitor: sub.name });
      if (sub.id === selfId) throw new HttpError(400, `Check "${c.name}": a monitor cannot include itself`, 'SUBMONITOR_SELF', { check: c.name });
      c.monitor = sub.id;
    }
  }
  for (const o of out.outputs) {
    // a Teams Workflows URL carries its own signature: it lives encrypted in a "Microsoft Teams channel" platform,
    // never in the definition (exports, Git sync, audit diffs) – #130
    const teams = o.type === 'webhook' && o.format === 'teams';
    if (teams && (!o.platform || o.url || o.path))
      throw new HttpError(400, `Output "${o.id}": a Teams card goes to a "Microsoft Teams channel" platform, not to a URL`, 'OUTPUT_TEAMS_PLATFORM', {
        output: o.id,
      });
    if ('platform' in o && o.platform) {
      const p = resolvePlatformRef(o.platform, teams ? 'teams' : PLATFORM_KIND[o.type]);
      if (teams && p.kind !== 'teams')
        throw new HttpError(400, `Output "${o.id}": a Teams card goes to a "Microsoft Teams channel" platform, not to a URL`, 'OUTPUT_TEAMS_PLATFORM', {
          output: o.id,
        });
      o.platform = p.id;
      requirePlatformUse(p.id);
    }
    if (o.type === 'process') {
      const perms = permissionsFor(o.processId);
      if (!perms.includes('view'))
        throw new HttpError(400, `Output "${o.id}": process ${o.processId} not found`, 'OUTPUT_PROCESS_NOT_FOUND', { output: o.id, process: o.processId });
      if (!perms.includes('run'))
        throw new HttpError(403, `Output "${o.id}": you are not allowed to run process ${o.processId}`, 'OUTPUT_PROCESS_FORBIDDEN', {
          output: o.id,
          process: o.processId,
        });
      const proc = getProcess(o.processId);
      for (const pid of Object.values(o.bindings)) requirePlatformUse(pid);
      const names = new Set((proc.definition.inputs ?? []).map((i) => i.name));
      for (const k of Object.keys(o.inputs))
        if (!names.has(k)) throw new HttpError(400, `Output "${o.id}": the process has no input "${k}"`, 'OUTPUT_PROCESS_INPUT', { output: o.id, input: k });
    }
    if (o.type === 'notification') {
      for (const s of o.subscribers)
        if (!/^(user|team|role):.+/.test(s.trim()))
          throw new HttpError(400, `Output "${o.id}": subscriber "${s}" – use user:<name>, team:<name> or role:<role>`, 'OUTPUT_SUBSCRIBER_INVALID', {
            output: o.id,
            subscriber: s,
          });
      o.subscribers = o.subscribers.map((s) => s.trim().toLowerCase());
    }
  }
  // sub-monitor references must not form a cycle
  const edges: [string, string][] = [];
  const nodes = new Set<string>();
  for (const m of db().all<{ id: string; definition: string }>('SELECT id, definition FROM monitors')) {
    if (m.id === selfId) continue;
    nodes.add(m.id);
    for (const c of parseJson<{ checks?: { type: string; monitor?: string }[] }>(m.definition, {}).checks ?? [])
      if (c.type === 'monitor' && c.monitor) edges.push([m.id, c.monitor]);
  }
  const me = selfId ?? '(new)';
  nodes.add(me);
  for (const c of out.checks) if (c.type === 'monitor') edges.push([me, c.monitor]);
  const cycle = findCycle([...nodes], edges);
  if (cycle) {
    const names = new Map(
      db()
        .all<{ id: string; name: string }>('SELECT id, name FROM monitors')
        .map((r) => [r.id, r.name]),
    );
    const path = cycle.map((id) => (id === me ? out.name : (names.get(id) ?? id))).join(' → ');
    throw new HttpError(400, `Sub-monitors would form a cycle: ${path}`, 'SUBMONITOR_CYCLE', { path });
  }
  // heartbeat keys are global (gateway batch reports)
  const keys = new Map<string, string>();
  for (const m of db().all<{ id: string; key: string; name: string; definition: string; is_template: number }>(
    'SELECT id, key, name, definition, is_template FROM monitors',
  )) {
    if (m.id === selfId || m.is_template) continue;
    for (const c of parseJson<{ checks?: CheckDef[] }>(m.definition, {}).checks ?? [])
      if (c.type === 'heartbeat') keys.set(checkKey(m, c).toLowerCase(), m.name);
  }
  for (const c of out.checks) {
    if (c.type !== 'heartbeat') continue;
    const k = checkKey({ key: selfKey }, c).toLowerCase();
    if (keys.has(k))
      throw new HttpError(409, `Heartbeat key "${checkKey({ key: selfKey }, c)}" is already used by monitor "${keys.get(k)}"`, 'HEARTBEAT_KEY_USED', {
        key: checkKey({ key: selfKey }, c),
        monitor: keys.get(k) ?? '',
      });
  }
  return out;
}

function validateKey(key: string, selfId: string | null): string {
  const k = key.trim().toLowerCase();
  if (!MONITOR_KEY_RE.test(k))
    throw new HttpError(400, 'Key: lower-case letters, digits, "." "_" and "-" (max. 64), starting with a letter or digit', 'MONITOR_KEY_INVALID');
  if (RESERVED_MONITOR_KEYS.includes(k)) throw new HttpError(400, `"${k}" is reserved – choose another key`, 'MONITOR_KEY_RESERVED', { key: k });
  const other = db().get<{ id: string }>('SELECT id FROM monitors WHERE key = ?', k);
  if (other && other.id !== selfId) throw new HttpError(409, `The key "${k}" is already used by another monitor`, 'MONITOR_KEY_USED', { key: k });
  return k;
}

function uniqueKey(name: string): string {
  const base = slugify(name).slice(0, 56) || 'monitor';
  let k = RESERVED_MONITOR_KEYS.includes(base) ? `${base}-1` : base;
  for (let i = 2; db().get('SELECT 1 FROM monitors WHERE key = ?', k); i++) k = `${base}-${i}`;
  return k;
}

// ---------- write ----------

export interface MonitorInput {
  key?: string;
  enabled?: boolean;
  isTemplate?: boolean;
  definition: unknown;
}

function newSecret(): { secret: string; enc: string; hash: string; prefix: string } {
  const secret = HEARTBEAT_SECRET_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { secret, enc: vault().encrypt(secret), hash: sha256(secret), prefix: secret.slice(0, HEARTBEAT_SECRET_PREFIX.length + 4) };
}

/** Creates/removes check state rows to match the definition; returns secrets of new heartbeat checks. */
function syncCheckRows(mid: string, key: string, def: MonitorDefinition, before: MonitorDefinition | null): MonitorSaveResult['secrets'] {
  const secrets: MonitorSaveResult['secrets'] = [];
  const rows = new Map(
    db()
      .all<CheckRow>('SELECT * FROM monitor_checks WHERE monitor_id = ?', mid)
      .map((r) => [r.check_id, r]),
  );
  const ts = nowIso();
  const ids = new Set(def.checks.map((c) => c.id));
  for (const [cid] of rows) {
    if (ids.has(cid)) continue;
    for (const t of ['monitor_checks', 'monitor_results', 'monitor_samples']) db().run(`DELETE FROM ${t} WHERE monitor_id = ? AND check_id = ?`, mid, cid);
  }
  for (const c of def.checks) {
    const old = before?.checks.find((x) => x.id === c.id);
    let r = rows.get(c.id);
    if (r && old && old.type !== c.type) {
      db().run('DELETE FROM monitor_checks WHERE monitor_id = ? AND check_id = ?', mid, c.id);
      r = undefined;
    }
    if (!r) db().run('INSERT INTO monitor_checks (monitor_id, check_id, status, created_at) VALUES (?, ?, ?, ?)', mid, c.id, 'unknown', ts);
    if (c.type === 'heartbeat') {
      if (!r?.hook_id) {
        const s = newSecret();
        const hookId = newId('hb_');
        db().run(
          'UPDATE monitor_checks SET hook_id = ?, secret_enc = ?, secret_hash = ?, secret_prefix = ?, secret_rotated_at = ? WHERE monitor_id = ? AND check_id = ?',
          hookId,
          s.enc,
          s.hash,
          s.prefix,
          ts,
          mid,
          c.id,
        );
        secrets.push({ checkId: c.id, secret: s.secret, path: heartbeatPath(hookId) });
      }
      db().run('UPDATE monitor_checks SET heartbeat_key = ? WHERE monitor_id = ? AND check_id = ?', checkKey({ key }, c).toLowerCase(), mid, c.id);
    } else if (r?.hook_id) {
      db().run(
        'UPDATE monitor_checks SET hook_id = NULL, secret_enc = NULL, secret_hash = NULL, secret_prefix = NULL, heartbeat_key = NULL WHERE monitor_id = ? AND check_id = ?',
        mid,
        c.id,
      );
    }
  }
  return secrets;
}

function changeSummary(before: MonitorDefinition | null, after: MonitorDefinition): Record<string, unknown> {
  if (!before) return { checks: after.checks.map((c) => c.id), outputs: after.outputs.map((o) => o.id) };
  const ids = (l: { id: string }[]) => l.map((x) => x.id);
  const added = ids(after.checks).filter((x) => !ids(before.checks).includes(x));
  const removed = ids(before.checks).filter((x) => !ids(after.checks).includes(x));
  const changed = after.checks.filter((c) => {
    const b = before.checks.find((x) => x.id === c.id);
    return b && JSON.stringify(b) !== JSON.stringify(c);
  });
  const fields = (
    [
      'name',
      'description',
      'tags',
      'intervalSeconds',
      'timeoutSeconds',
      'failuresBeforeDown',
      'successesBeforeUp',
      'aggregate',
      'links',
      'outputs',
      'parameters',
    ] as const
  ).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return { checksAdded: added, checksRemoved: removed, checksChanged: changed.map((c) => c.id), fields };
}

export async function createMonitor(
  input: MonitorInput,
  extra: { templateId?: string; templateVersion?: number; templateParams?: Record<string, unknown> } = {},
): Promise<MonitorSaveResult> {
  const u = me();
  requireCreate();
  const id = newId('mon_');
  let stored: Record<string, unknown>;
  let def: MonitorDefinition | null = null;
  let name: string;
  if (input.isTemplate) {
    const t = await validateTemplate(input.definition);
    stored = t.def;
    name = String(t.def.name ?? 'Template');
  } else {
    def = parseDefinitionInput(input.definition);
    const issues = definitionIssues(def);
    if (issues.length) throw invalidMonitor(issues, def);
    checkExpressions(def);
    name = def.name;
  }
  const key = input.key ? validateKey(input.key, null) : uniqueKey(name);
  if (def) def = resolveReferences(def, null, key);
  stored ??= def as unknown as Record<string, unknown>;
  const ts = nowIso();
  let secrets: MonitorSaveResult['secrets'] = [];
  db().tx(() => {
    db().run(
      `INSERT INTO monitors (id, key, name, owner, acl, enabled, is_template, template_id, template_version, template_params, version, definition, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id,
      key,
      name,
      u.username,
      input.enabled === false ? 0 : 1,
      input.isTemplate ? 1 : 0,
      extra.templateId ?? null,
      extra.templateVersion ?? null,
      extra.templateParams ? JSON.stringify(extra.templateParams) : null,
      JSON.stringify(stored),
      ts,
      ts,
      u.username,
    );
    if (def) secrets = syncCheckRows(id, key, def, null);
    audit({
      action: input.isTemplate ? 'monitor.template_created' : 'monitor.created',
      entityType: 'monitor',
      entityId: id,
      summary: `${input.isTemplate ? 'Monitor template' : 'Monitor'} "${name}" (${key}) created${extra.templateId ? ` from template ${extra.templateId}` : ''}`,
      details: {
        key,
        ...(def ? changeSummary(null, def) : {}),
        templateId: extra.templateId ?? null,
        templateParams: extra.templateParams ?? null,
        heartbeatSecrets: secrets.map((s) => s.checkId),
      },
    });
  });
  engine.reloadMonitor(id);
  return { monitor: getMonitor(id), secrets };
}

export async function updateMonitor(idOrKey: string, input: MonitorInput & { version?: number }): Promise<MonitorSaveResult> {
  const r = requireMonitor(idOrKey, 'edit');
  if (input.version !== undefined && input.version !== r.version) {
    throw new HttpError(
      409,
      `The monitor was changed by ${r.updated_by} in the meantime (version ${r.version}) – reload and apply your changes again`,
      'VERSION_CONFLICT',
      {
        context: 'monitor',
        user: r.updated_by,
      },
    );
  }
  if (input.isTemplate !== undefined && !!input.isTemplate !== !!r.is_template)
    throw new HttpError(400, 'A monitor cannot be turned into a template or back', 'MONITOR_TEMPLATE_SWITCH');
  const key = input.key && input.key.toLowerCase() !== r.key ? validateKey(input.key, r.id) : r.key;
  if (key !== r.key && usedBy(r.id).length) {
    /* references use the id, so a new key is fine */
  }
  let stored: Record<string, unknown>;
  let def: MonitorDefinition | null = null;
  const before = r.is_template ? null : loadMonitor(r).def;
  if (r.is_template) stored = (await validateTemplate(input.definition)).def;
  else {
    def = parseDefinitionInput(input.definition);
    const issues = definitionIssues(def);
    if (issues.length) throw invalidMonitor(issues, def);
    checkExpressions(def);
    def = resolveReferences(def, r.id, key, before);
    // Outputs act on behalf of the owner (runbooks start as the owner, notifications/webhooks/Zabbix send in
    // the monitor's name) – changing them needs 'manage', not just 'edit'.
    if (before && JSON.stringify(before.outputs ?? []) !== JSON.stringify(def.outputs ?? []) && !permissionsOfRow(r).includes('manage')) {
      throw new HttpError(403, 'Changing the outputs of this monitor needs the manage right (owner, administrators or the access list)', 'FORBIDDEN', {
        context: 'monitorOutputs',
      });
    }
    stored = def as unknown as Record<string, unknown>;
  }
  const name = String(stored.name);
  const ts = nowIso();
  const enabled = input.enabled === undefined ? !!r.enabled : input.enabled;
  let secrets: MonitorSaveResult['secrets'] = [];
  db().tx(() => {
    db().run(
      'UPDATE monitors SET key = ?, name = ?, enabled = ?, version = version + 1, definition = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      key,
      name,
      enabled ? 1 : 0,
      JSON.stringify(stored),
      ts,
      me().username,
      r.id,
    );
    if (def) {
      secrets = syncCheckRows(r.id, key, def, before);
      if (key !== r.key) {
        db().run('DELETE FROM datasets WHERE key = ?', `monitor.${r.key}`);
        for (const c of def.checks) {
          if (c.type === 'heartbeat')
            db().run('UPDATE monitor_checks SET heartbeat_key = ? WHERE monitor_id = ? AND check_id = ?', checkKey({ key }, c).toLowerCase(), r.id, c.id);
        }
      }
    }
    audit({
      action: r.is_template ? 'monitor.template_updated' : 'monitor.updated',
      entityType: 'monitor',
      entityId: r.id,
      summary: `${r.is_template ? 'Monitor template' : 'Monitor'} "${name}" updated to version ${r.version + 1}${enabled !== !!r.enabled ? (enabled ? ', enabled' : ', disabled') : ''}`,
      details: {
        key,
        previousKey: key !== r.key ? r.key : undefined,
        enabled,
        ...(def ? changeSummary(before, def) : {}),
        heartbeatSecrets: secrets.map((s) => s.checkId),
      },
    });
  });
  engine.reloadMonitor(r.id);
  return { monitor: getMonitor(r.id), secrets };
}

export function setEnabled(idOrKey: string, enabled: boolean): MonitorDetail {
  const r = requireMonitor(idOrKey, 'edit');
  db().tx(() => {
    db().run('UPDATE monitors SET enabled = ?, updated_at = ?, updated_by = ? WHERE id = ?', enabled ? 1 : 0, nowIso(), me().username, r.id);
    audit({
      action: 'monitor.updated',
      entityType: 'monitor',
      entityId: r.id,
      summary: `Monitor "${r.name}" ${enabled ? 'enabled' : 'disabled'}`,
      details: { enabled },
    });
  });
  engine.reloadMonitor(r.id);
  return getMonitor(r.id);
}

export function deleteMonitor(idOrKey: string): void {
  const r = requireMonitor(idOrKey, 'manage', 'delete this monitor');
  const users = db()
    .all<MonitorRow>('SELECT * FROM monitors')
    .filter(
      (m) =>
        m.id !== r.id &&
        parseJson<{ checks?: { type: string; monitor?: string }[] }>(m.definition, {}).checks?.some((c) => c.type === 'monitor' && c.monitor === r.id),
    );
  if (users.length)
    throw new HttpError(
      409,
      `"${r.name}" is used as a sub-monitor by ${users.map((m) => `"${m.name}"`).join(', ')} – remove it there first`,
      'MONITOR_IN_USE',
      {
        name: r.name,
        users: users.map((m) => m.name),
      },
    );
  db().tx(() => {
    for (const t of [
      'monitor_checks',
      'monitor_results',
      'monitor_samples',
      'monitor_history',
      'monitor_maintenance',
      'monitor_output_state',
      'monitor_state',
    ]) {
      db().run(`DELETE FROM ${t} WHERE monitor_id = ?`, r.id);
    }
    db().run('DELETE FROM datasets WHERE process_id = ?', `monitor:${r.id}`);
    db().run('UPDATE monitors SET template_id = NULL WHERE template_id = ?', r.id);
    db().run('DELETE FROM monitors WHERE id = ?', r.id);
    audit({
      action: r.is_template ? 'monitor.template_deleted' : 'monitor.deleted',
      entityType: 'monitor',
      entityId: r.id,
      summary: `Monitor${r.is_template ? ' template' : ''} "${r.name}" (${r.key}) deleted`,
    });
  });
  engine.forgetMonitor(r.id);
}

export function setAccess(idOrKey: string, input: { acl: unknown; owner?: string }): MonitorDetail {
  const r = requireMonitor(idOrKey, 'manage', 'change the access of this monitor');
  const acl = cleanAcl(input.acl, MONITOR_PERMISSIONS);
  const owner = input.owner?.trim() || r.owner;
  db().tx(() => {
    db().run('UPDATE monitors SET acl = ?, owner = ?, updated_at = ? WHERE id = ?', JSON.stringify(acl), owner, nowIso(), r.id);
    audit({
      action: 'monitor.access_changed',
      entityType: 'monitor',
      entityId: r.id,
      summary: `Access to monitor "${r.name}" changed${owner !== r.owner ? ` (owner ${r.owner} → ${owner})` : ''}`,
      details: { acl, owner, previousOwner: r.owner },
    });
  });
  engine.reloadMonitor(r.id);
  return getMonitor(r.id);
}

export function rotateHeartbeatSecret(idOrKey: string, checkId: string): { secret: string; path: string } {
  const r = requireMonitor(idOrKey, 'edit');
  const row = db().get<CheckRow>('SELECT * FROM monitor_checks WHERE monitor_id = ? AND check_id = ?', r.id, checkId);
  if (!row?.hook_id) throw new HttpError(404, 'This check has no heartbeat endpoint', 'NO_HEARTBEAT');
  const s = newSecret();
  db().tx(() => {
    db().run(
      'UPDATE monitor_checks SET secret_enc = ?, secret_hash = ?, secret_prefix = ?, secret_rotated_at = ? WHERE monitor_id = ? AND check_id = ?',
      s.enc,
      s.hash,
      s.prefix,
      nowIso(),
      r.id,
      checkId,
    );
    audit({
      action: 'monitor.secret_rotated',
      entityType: 'monitor',
      entityId: r.id,
      summary: `Heartbeat secret of "${r.name}" › ${checkId} rotated (old secret ${row.secret_prefix}… is no longer accepted)`,
      details: { checkId, oldPrefix: row.secret_prefix, newPrefix: s.prefix },
    });
  });
  return { secret: s.secret, path: heartbeatPath(row.hook_id) };
}

// ---------- maintenance & acknowledgement ----------

function listMaintenanceRows(mid: string): MaintenanceWindow[] {
  const now = engine.monitorNow();
  return db()
    .all<{ id: string; monitor_id: string; starts_at: string; ends_at: string; reason: string; created_by: string; created_at: string }>(
      'SELECT * FROM monitor_maintenance WHERE monitor_id = ? ORDER BY starts_at DESC LIMIT 100',
      mid,
    )
    .map((w) => ({
      id: w.id,
      monitorId: w.monitor_id,
      startsAt: w.starts_at,
      endsAt: w.ends_at,
      reason: w.reason,
      createdBy: w.created_by,
      createdAt: w.created_at,
      active: Date.parse(w.starts_at) <= now && Date.parse(w.ends_at) > now,
    }));
}

export function listMaintenance(idOrKey: string): MaintenanceWindow[] {
  return listMaintenanceRows(requireMonitor(idOrKey).id);
}

export function addMaintenance(idOrKey: string, input: { startsAt?: string; endsAt: string; reason: string }): MaintenanceWindow {
  const r = requireMonitor(idOrKey, 'acknowledge', 'plan maintenance for this monitor');
  const start = input.startsAt ? Date.parse(input.startsAt) : engine.monitorNow();
  const end = Date.parse(input.endsAt);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new HttpError(400, 'Invalid start or end time', 'PERIOD_INVALID');
  if (end <= start) throw new HttpError(400, 'The end must be after the start', 'PERIOD_END_BEFORE_START');
  if (end - start > 31 * 86400000) throw new HttpError(400, 'A maintenance window can last at most 31 days', 'MAINTENANCE_TOO_LONG', { days: 31 });
  const id = newId('mw_');
  db().tx(() => {
    db().run(
      'INSERT INTO monitor_maintenance (id, monitor_id, starts_at, ends_at, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      r.id,
      new Date(start).toISOString(),
      new Date(end).toISOString(),
      input.reason.trim().slice(0, 500),
      me().username,
      nowIso(),
    );
    audit({
      action: 'monitor.maintenance_added',
      entityType: 'monitor',
      entityId: r.id,
      summary: `Maintenance for monitor "${r.name}" from ${new Date(start).toISOString()} to ${new Date(end).toISOString()}: ${input.reason.trim().slice(0, 200)}`,
      details: { windowId: id, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), reason: input.reason },
    });
  });
  engine.scheduleRecompute(r.id);
  return listMaintenanceRows(r.id).find((w) => w.id === id)!;
}

export function endMaintenance(idOrKey: string, windowId: string): void {
  const r = requireMonitor(idOrKey, 'acknowledge', 'change maintenance of this monitor');
  const w = db().get<{ starts_at: string; ends_at: string }>(
    'SELECT starts_at, ends_at FROM monitor_maintenance WHERE id = ? AND monitor_id = ?',
    windowId,
    r.id,
  );
  if (!w) throw new HttpError(404, 'Maintenance window not found', 'MAINTENANCE_NOT_FOUND');
  const now = engine.monitorNow();
  db().tx(() => {
    // a running window ends now (history stays); a future one is removed
    if (Date.parse(w.starts_at) <= now)
      db().run('UPDATE monitor_maintenance SET ends_at = ? WHERE id = ?', new Date(Math.min(now, Date.parse(w.ends_at))).toISOString(), windowId);
    else db().run('DELETE FROM monitor_maintenance WHERE id = ?', windowId);
    audit({
      action: 'monitor.maintenance_ended',
      entityType: 'monitor',
      entityId: r.id,
      summary: `Maintenance window of monitor "${r.name}" ended or removed`,
      details: { windowId },
    });
  });
  engine.scheduleRecompute(r.id);
}

export function acknowledge(idOrKey: string, comment: string): MonitorDetail {
  const r = requireMonitor(idOrKey, 'acknowledge', 'acknowledge problems of this monitor');
  const st = db().get<StateRow>('SELECT * FROM monitor_state WHERE monitor_id = ?', r.id);
  if (!st || st.status === 'up') throw new HttpError(409, 'There is no problem to acknowledge', 'NOTHING_TO_ACKNOWLEDGE');
  db().tx(() => {
    db().run(
      'UPDATE monitor_state SET ack_by = ?, ack_at = ?, ack_comment = ? WHERE monitor_id = ?',
      me().username,
      nowIso(),
      comment.trim().slice(0, 1000),
      r.id,
    );
    audit({
      action: 'monitor.acknowledged',
      entityType: 'monitor',
      entityId: r.id,
      summary: `Problem of monitor "${r.name}" (${st.status}) acknowledged${comment.trim() ? `: ${comment.trim().slice(0, 200)}` : ''}`,
      details: { status: st.status, rootCauses: parseCauses(st.root_causes), comment },
    });
  });
  return getMonitor(r.id);
}

export function unacknowledge(idOrKey: string): MonitorDetail {
  const r = requireMonitor(idOrKey, 'acknowledge', 'acknowledge problems of this monitor');
  db().tx(() => {
    db().run('UPDATE monitor_state SET ack_by = NULL, ack_at = NULL, ack_comment = NULL WHERE monitor_id = ?', r.id);
    audit({ action: 'monitor.unacknowledged', entityType: 'monitor', entityId: r.id, summary: `Acknowledgement of monitor "${r.name}" removed` });
  });
  engine.scheduleRecompute(r.id);
  return getMonitor(r.id);
}

// ---------- templates ----------

export async function instantiateTemplate(
  templateIdOrKey: string,
  rows: { params: Record<string, unknown>; name?: string; key?: string; enabled?: boolean }[],
): Promise<MonitorSaveResult[]> {
  const t = requireMonitor(templateIdOrKey, 'view');
  if (!t.is_template) throw new HttpError(400, `"${t.name}" is not a template`, 'NOT_A_TEMPLATE', { name: t.name });
  requireCreate();
  if (!rows.length) throw new HttpError(400, 'No instances given', 'NO_INSTANCES');
  if (rows.length > 500) throw new HttpError(400, 'At most 500 instances at once', 'TOO_MANY_INSTANCES', { max: 500 });
  const def = parseJson<Record<string, unknown>>(t.definition, {});
  const params = (def.parameters as TemplateParam[] | undefined) ?? [];
  // render and validate everything first, so a bad row creates nothing
  const prepared: { def: Record<string, unknown>; params: Record<string, unknown>; key?: string; enabled?: boolean }[] = [];
  for (const [i, row] of rows.entries()) {
    try {
      const p = coerceParams(params, row.params ?? {});
      const rendered = await renderTemplate(def, p);
      if (row.name?.trim()) rendered.name = row.name.trim();
      const d = parseDefinitionInput(rendered);
      const issues = definitionIssues(d);
      if (issues.length) throw invalidMonitor(issues, d);
      prepared.push({ def: d as unknown as Record<string, unknown>, params: p, key: row.key || undefined, enabled: row.enabled });
    } catch (e) {
      throw new HttpError((e as HttpError).statusCode ?? 400, `Row ${i + 1}: ${(e as Error).message}`, 'TEMPLATE_ROW', { row: i + 1, error: errorParam(e) });
    }
  }
  const out: MonitorSaveResult[] = [];
  for (const [i, p] of prepared.entries()) {
    try {
      out.push(
        await createMonitor({ key: p.key, enabled: p.enabled, definition: p.def }, { templateId: t.id, templateVersion: t.version, templateParams: p.params }),
      );
    } catch (e) {
      throw new HttpError(
        (e as HttpError).statusCode ?? 400,
        `Row ${i + 1}${out.length ? ` (${out.length} instance(s) were created before)` : ''}: ${(e as Error).message}`,
        'TEMPLATE_ROW',
        { row: i + 1, ...(out.length ? { context: 'partial', created: out.length } : {}), error: errorParam(e) },
      );
    }
  }
  return out;
}

/** Re-renders an instance from the current template version with its stored parameters. */
export async function resyncInstance(idOrKey: string): Promise<MonitorSaveResult> {
  const r = requireMonitor(idOrKey, 'edit');
  if (!r.template_id) throw new HttpError(400, 'This monitor was not created from a template', 'NOT_FROM_TEMPLATE');
  const t = monitorRow(r.template_id);
  if (!t) throw new HttpError(404, 'The template no longer exists', 'TEMPLATE_GONE');
  const def = parseJson<Record<string, unknown>>(t.definition, {});
  const params = coerceParams((def.parameters as TemplateParam[] | undefined) ?? [], parseJson(r.template_params, {}));
  const rendered = await renderTemplate(def, params);
  rendered.name = r.name;
  const res = await updateMonitor(r.id, { definition: rendered });
  db().run('UPDATE monitors SET template_version = ? WHERE id = ?', t.version, r.id);
  audit({
    action: 'monitor.resynced',
    entityType: 'monitor',
    entityId: r.id,
    summary: `Monitor "${r.name}" re-synced with template "${t.name}" version ${t.version}`,
  });
  return { ...res, monitor: getMonitor(r.id) };
}

// ---------- YAML import / export / examples ----------

export function exportMonitor(idOrKey: string): string {
  const r = requireMonitor(idOrKey);
  const def = parseJson<Record<string, unknown>>(r.definition, {});
  const platformNames = new Map(
    db()
      .all<{ id: string; name: string }>('SELECT id, name FROM platforms')
      .map((p) => [p.id, p.name]),
  );
  const canView = monitorVisibility();
  // sub-monitors the user may not view are exported as HIDDEN_MONITOR_REF
  const monitorKeys = new Map(
    db()
      .all<{ id: string; key: string }>('SELECT id, key FROM monitors')
      .map((m) => [m.id, canView(m.id) ? m.key : HIDDEN_MONITOR_REF]),
  );
  // portable references: platform names and monitor keys instead of ids
  const portable = JSON.parse(JSON.stringify(def), (k, v) => {
    if (k === 'platform' && typeof v === 'string') return platformNames.get(v) ?? v;
    if (k === 'monitor' && typeof v === 'string') return monitorKeys.get(v) ?? v;
    return v;
  });
  for (const c of (portable.checks ?? []) as Record<string, unknown>[])
    if (c.x !== undefined) ((c.x = Math.round(Number(c.x))), (c.y = Math.round(Number(c.y))));
  return YAML.stringify({ kind: r.is_template ? 'monitorTemplate' : 'monitor', key: r.key, ...portable }, { lineWidth: 0 });
}

function parseMonitorFile(text: string): { kind: unknown; key: unknown; enabled: unknown; definition: Record<string, unknown> } {
  let raw: unknown;
  try {
    raw = parseYaml(text, { maxBytes: MONITOR_YAML_BYTES });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `Invalid YAML: ${(e as Error).message}`, 'YAML_INVALID', { detail: (e as Error).message });
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (obj.kind !== 'monitor' && obj.kind !== 'monitorTemplate')
    throw new HttpError(400, 'Not a monitor file: "kind" must be monitor or monitorTemplate', 'MONITOR_FILE_KIND');
  const { kind, key, enabled, ...definition } = obj;
  return { kind, key, enabled, definition };
}

/** `platforms`: the platform chosen for each platform reference in the file (reference → platform id). */
export async function importMonitor(text: string, opts: { key?: string; platforms?: Record<string, string> } = {}): Promise<MonitorSaveResult> {
  const { kind, key, enabled, definition } = parseMonitorFile(text);
  return createMonitor({
    key: opts.key ?? (key as string | undefined),
    enabled: enabled as boolean | undefined,
    isTemplate: kind === 'monitorTemplate',
    definition: applyPlatformMap(definition, opts.platforms ?? {}),
  });
}

/** The platform references of a monitor file, to choose a platform for each before importing it. */
export function importReferences(text: string): PlatformReference[] {
  requireCreate();
  return platformReferences(parseMonitorFile(text).definition);
}

const examplesDir = () => path.join(process.env.SM_EXAMPLES_DIR ?? path.join(config.templatesDir, '..'), 'monitors');

export function listExamples(): { file: string; kind: string; key: string | null; name: string; description: string }[] {
  const dir = examplesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .flatMap((f) => {
      try {
        const o = parseYaml(fs.readFileSync(path.join(dir, f), 'utf8'), { maxBytes: MONITOR_YAML_BYTES }) as Record<string, unknown>;
        const key = typeof o.key === 'string' ? o.key : null;
        return [{ file: f, kind: String(o.kind), key, ...exampleLabel(o, key ?? f.replace(/^\d+-|\.ya?ml$/gi, '')) }];
      } catch {
        return [];
      }
    });
}

/**
 * Name and description of an example for the library list. A template's name is usually a parameter
 * ("{{ params.title }}"): it is listed by its key instead ("powermeter-machine" → "Powermeter machine"),
 * and parameters in the description show their label ("PowerMeter ‹PowerMeter IP address›").
 */
function exampleLabel(o: Record<string, unknown>, key: string): { name: string; description: string } {
  const labels = new Map<string, string>();
  if (Array.isArray(o.parameters))
    for (const p of o.parameters as Record<string, unknown>[])
      if (p && typeof p.name === 'string') labels.set(p.name, typeof p.label === 'string' && p.label.trim() ? p.label : p.name);
  const fill = (text: string) => text.replace(/\{\{\s*params\.([\w-]+)\s*\}\}/g, (_m, n: string) => `‹${labels.get(n) ?? n}›`);
  const rawName = String(o.name ?? key);
  const fromKey = key.replace(/[-_]+/g, ' ').trim();
  const name = rawName.includes('{{') ? fromKey.charAt(0).toUpperCase() + fromKey.slice(1) : rawName;
  return { name, description: fill(String(o.description ?? '')) };
}

function exampleText(file: string): string {
  if (!/^[\w.-]+\.ya?ml$/i.test(file)) throw new HttpError(400, 'Invalid example name', 'EXAMPLE_NOT_FOUND');
  const p = pathInside(examplesDir(), file);
  if (!fs.existsSync(p)) throw new HttpError(404, 'Example not found', 'EXAMPLE_NOT_FOUND');
  return fs.readFileSync(p, 'utf8');
}

export async function importExample(file: string, opts: { platforms?: Record<string, string> } = {}): Promise<MonitorSaveResult> {
  return importMonitor(exampleText(file), { platforms: opts.platforms });
}

export function exampleReferences(file: string): PlatformReference[] {
  return importReferences(exampleText(file));
}

export const isMonitorId = (s: string) => MONITOR_ID_RE.test(s);
