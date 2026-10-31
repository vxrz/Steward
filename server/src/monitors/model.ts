import {
  MONITOR_PERMISSIONS,
  monitorDefinitionSchema,
  type AclEntry,
  type CauseRef,
  type CheckDef,
  type MonitorDefinition,
  type MonitorPermission,
  type MonitorStatus,
  type Role,
} from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { capabilities, isAdmin, matches } from '../auth/permissions.js';

/** Rows and small helpers shared by the monitor modules. */

/** Largest monitor file (YAML) to import, and CSV of template instances, in characters. */
export const MONITOR_IMPORT_LIMITS = { yamlChars: 512 * 1024, csvChars: 1024 * 1024 };

export interface MonitorRow {
  id: string;
  key: string;
  name: string;
  owner: string;
  acl: string;
  enabled: number;
  is_template: number;
  template_id: string | null;
  template_version: number | null;
  template_params: string | null;
  version: number;
  definition: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export interface CheckRow {
  monitor_id: string;
  check_id: string;
  status: MonitorStatus;
  since: string | null;
  consecutive_failures: number;
  consecutive_successes: number;
  last_checked_at: string | null;
  last_ok_at: string | null;
  last_result: string | null;
  caused_by: string;
  note: string | null;
  hook_id: string | null;
  heartbeat_key: string | null;
  secret_enc: string | null;
  secret_hash: string | null;
  secret_prefix: string | null;
  secret_rotated_at: string | null;
  last_push_at: string | null;
  last_push: string | null;
  created_at: string;
}

export interface StateRow {
  monitor_id: string;
  status: MonitorStatus;
  since: string | null;
  root_causes: string;
  last_evaluated_at: string | null;
  ack_by: string | null;
  ack_at: string | null;
  ack_comment: string | null;
}

export interface GatewayRow {
  id: string;
  name: string;
  description: string;
  owner: string;
  enabled: number;
  auth_mode: 'token' | 'hmac' | 'either';
  secret_enc: string;
  secret_hash: string;
  secret_prefix: string;
  secret_rotated_at: string;
  allowed_cidrs: string;
  allowed_keys: string;
  rate_limit_per_min: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  accepted_count: number;
  rejected_count: number;
}

/** A monitor as the engine sees it. */
export interface LoadedMonitor {
  id: string;
  key: string;
  name: string;
  owner: string;
  enabled: boolean;
  isTemplate: boolean;
  version: number;
  def: MonitorDefinition;
}

export function parseDefinition(text: string): MonitorDefinition {
  const raw = parseJson<unknown>(text, {});
  const r = monitorDefinitionSchema.safeParse(raw);
  return r.success ? r.data : monitorDefinitionSchema.parse({ name: (raw as { name?: string })?.name || 'Invalid monitor', checks: [] });
}

export function loadMonitor(r: MonitorRow): LoadedMonitor {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    owner: r.owner,
    enabled: !!r.enabled,
    isTemplate: !!r.is_template,
    version: r.version,
    def: parseDefinition(r.definition),
  };
}

export const monitorRow = (idOrKey: string): MonitorRow | undefined =>
  db().get<MonitorRow>('SELECT * FROM monitors WHERE id = ? OR key = ?', idOrKey, idOrKey.toLowerCase());

// ---------- effective check settings ----------

export const checkKey = (m: { key: string }, c: CheckDef): string => c.key ?? `${m.key}.${c.id}`;
export const checkEnabled = (c: CheckDef): boolean => c.enabled !== false;
export const checkCritical = (c: CheckDef): boolean => c.critical !== false;

export function intervalMs(m: LoadedMonitor, c: CheckDef): number {
  return (c.intervalSeconds ?? m.def.intervalSeconds) * 1000;
}
export function timeoutMs(m: LoadedMonitor, c: CheckDef): number {
  return (c.timeoutSeconds ?? m.def.timeoutSeconds) * 1000;
}
export function thresholds(m: LoadedMonitor, c: CheckDef): { failuresBeforeDown: number; successesBeforeUp: number } {
  // a sub-monitor already applied its own flapping control
  if (c.type === 'monitor') return { failuresBeforeDown: c.failuresBeforeDown ?? 1, successesBeforeUp: c.successesBeforeUp ?? 1 };
  return { failuresBeforeDown: c.failuresBeforeDown ?? m.def.failuresBeforeDown, successesBeforeUp: c.successesBeforeUp ?? m.def.successesBeforeUp };
}

// ---------- permissions ----------

export const MONITOR_DEFAULTS: Record<Role, MonitorPermission[]> = {
  admin: [...MONITOR_PERMISSIONS],
  designer: ['view', 'acknowledge', 'edit'],
  operator: ['view', 'acknowledge'],
  approver: ['view'],
  auditor: ['view'],
  viewer: ['view'],
  status: [],
};

/** Same model as processes: role defaults, or the access list when it has entries; admins and the owner keep everything. */
export function monitorPermissions(u: AuthUser | null, m: { owner: string; acl: AclEntry<MonitorPermission>[] }): MonitorPermission[] {
  if (!u) return [];
  if (isAdmin(u) || m.owner.toLowerCase() === u.username.toLowerCase()) return [...MONITOR_PERMISSIONS];
  const out = new Set<MonitorPermission>();
  if (u.roles.includes('auditor')) out.add('view');
  if (!m.acl.length) for (const r of u.roles) MONITOR_DEFAULTS[r]?.forEach((x) => out.add(x));
  else for (const e of m.acl) if (matches(u, e.subject)) e.permissions.forEach((x) => out.add(x));
  if (out.has('manage')) ['edit', 'acknowledge'].forEach((x) => out.add(x as MonitorPermission));
  if (out.size) out.add('view');
  return MONITOR_PERMISSIONS.filter((x) => out.has(x));
}

export const permissionsOfRow = (r: Pick<MonitorRow, 'owner' | 'acl'>, u: AuthUser | null = currentUser()): MonitorPermission[] =>
  monitorPermissions(u, { owner: r.owner, acl: parseJson(r.acl, []) });

/** Designers and administrators create monitors and gateways. */
export const canCreateMonitors = (u: AuthUser | null = currentUser()): boolean => capabilities(u).createMonitors;

export const parseCauses = (s: string | null | undefined): CauseRef[] => parseJson<CauseRef[]>(s, []);
