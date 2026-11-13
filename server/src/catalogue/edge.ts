import { z } from 'zod';
import { IEM_DATASETS, IEM_ONLINE_DEFAULTS, iemOnline, type DatasetRow, type EdgeSuggestion, type EdgeSuggestions, type IemDeviceStatus } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { canCreateServices, canEditService, catalogueVisibleNow, forbid, me } from '../records/access.js';
import { getDataset } from '../dashboards/datasets.js';
import { builtinDatasetVisible } from '../dashboards/builtin.js';
import { permissionsFor } from '../processes/service.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { applicationInput, canEditApplication, createApplication } from './applications.js';
import { createSystem, getSystem, linkSystem, updateSystem, systemInput } from './systems.js';

/**
 * Industrial Edge devices in the catalogue (0.25.0, ADR 0037 part 3, docs/APPLICATIONS.md#industrial-edge-devices).
 *
 * - **Device status:** a system names its device in Industrial Edge Management (`iem_device_id`, an external
 *   reference). Its status – online within its report interval, firmware – is read from the dataset the Industrial
 *   Edge examples publish (`iem.devices`, else `iem.device-status`), as the reader may see it; the online rule is the
 *   examples': the last report is at most the report interval plus the grace old.
 * - **Suggestions:** the installations readout (`iem.installations`, examples/processes/55-iem-installations.yaml)
 *   is compared with the catalogue on read: a device without a system, a system that is the device by name but does
 *   not name it, an installed application that is not recorded as running on the system. Nothing is ever applied on
 *   its own: a person confirms each one with the right to change its target, and the confirmation is audited
 *   (`edge.suggestion_confirmed`, besides the change itself); a dismissed one stays away while the readout says the same.
 *   What is recorded in items the reader may not see is counted, never named.
 */

// ---------- the datasets as the reader may see them ----------

/** A dataset as the reader may see it (as GET /api/datasets/:key): null when missing or hidden – the two read the same. */
function readable(key: string): ReturnType<typeof getDataset> | null {
  try {
    const d = getDataset(key);
    return (builtinDatasetVisible(d.processId) ?? permissionsFor(d.processId).includes('view')) ? d : null;
  } catch {
    return null; // nothing published under this key, or nothing of it for this reader: the same answer
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The examples write "Last seen" as `YYYY-MM-DD HH:mm` in UTC ($fromMillis), or "–". */
function lastSeenOf(v: unknown): number | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/.exec(str(v));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(t) ? t : null;
}

function statusFrom(deviceId: string, row: DatasetRow, d: NonNullable<ReturnType<typeof readable>>, now: number): IemDeviceStatus {
  const intervalMinutes = num(row['Report interval (min)']) ?? IEM_ONLINE_DEFAULTS.intervalMinutes;
  const graceMinutes = num(d.metrics?.graceMinutes) ?? IEM_ONLINE_DEFAULTS.graceMinutes;
  const last = lastSeenOf(row['Last seen']);
  const onboarding = str(row.Onboarding).toUpperCase();
  const firmware = str(row.Firmware);
  return {
    deviceId,
    found: true,
    name: str(row.Device) || deviceId,
    // pending in IEM: not onboarded yet, never offline (the examples' rule)
    state: onboarding === 'PENDING' ? 'notOnboarded' : iemOnline(last, now, intervalMinutes, graceMinutes),
    firmware: firmware && firmware !== '–' ? firmware : null,
    lastSeen: last === null ? null : new Date(last).toISOString(),
    intervalMinutes,
    graceMinutes,
    dataset: d.key,
    readAt: d.updatedAt,
  };
}

/** The status of an IEM device as the reader may see it (`found: false` when no dataset they may see has it). */
export function iemDeviceStatus(deviceId: string, now = Date.now()): IemDeviceStatus {
  for (const key of [IEM_DATASETS.devices, IEM_DATASETS.status]) {
    const d = readable(key);
    const row = d?.rows.find((r) => r._key === deviceId);
    if (d && row) return statusFrom(deviceId, row, d, now);
  }
  return {
    deviceId,
    found: false,
    name: '',
    state: 'unknown',
    firmware: null,
    lastSeen: null,
    intervalMinutes: IEM_ONLINE_DEFAULTS.intervalMinutes,
    graceMinutes: IEM_ONLINE_DEFAULTS.graceMinutes,
    dataset: null,
    readAt: null,
  };
}

/** GET /api/systems/:id/iem: the device status of a system that names an IEM device (null: it names none). */
export function systemIemStatus(systemId: string): IemDeviceStatus | null {
  const s = getSystem(systemId); // 404 for who may not see it
  return s.iemDeviceId ? iemDeviceStatus(s.iemDeviceId) : null;
}

// ---------- the installations readout and its suggestions ----------

interface Installed {
  deviceId: string;
  deviceName: string;
  onboarding: string;
  apps: { title: string; version: string }[];
}

/** The devices of the readout with what is installed on them (rows of one device and application each). */
function devicesOf(rows: DatasetRow[]): Installed[] {
  const out = new Map<string, Installed>();
  for (const r of rows) {
    const id = str(r['Device id']);
    if (!id) continue;
    const onboarding = str(r.Onboarding).toUpperCase();
    if (onboarding === 'DELETED') continue;
    const d = out.get(id) ?? { deviceId: id, deviceName: str(r.Device) || id, onboarding, apps: [] };
    const title = str(r.Application);
    if (title && title !== '–' && !d.apps.some((a) => a.title.toLowerCase() === title.toLowerCase()))
      d.apps.push({ title, version: str(r.Version) === '–' ? '' : str(r.Version) });
    out.set(id, d);
  }
  return [...out.values()].sort((a, b) => a.deviceName.localeCompare(b.deviceName));
}

interface SystemRowLite {
  id: string;
  name: string;
  owners: string;
  iem_device_id: string | null;
}
interface AppRowLite {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

const norm = (s: string) => s.trim().toLowerCase();
/** A system is the device by name: the same name, or the device name as its first DNS label (`edge-01` and `edge-01.example`). */
const sameHost = (system: string, device: string) => norm(system) === norm(device) || norm(system).startsWith(`${norm(device)}.`);

const dismissedKeys = () =>
  new Set(
    db()
      .all<{ suggestion_key: string }>('SELECT suggestion_key FROM edge_suggestion_dismissals')
      .map((r) => r.suggestion_key),
  );

/** Everything the readout suggests, the dismissed ones included (marked), as the reader may see the catalogue. */
function compute(): { readout: EdgeSuggestions['readout']; list: (EdgeSuggestion & { dismissed: boolean })[]; hidden: number } {
  const d = readable(IEM_DATASETS.installations);
  if (!d) return { readout: null, list: [], hidden: 0 };
  const u = currentUser();
  const devices = devicesOf(d.rows);
  const systems = db().all<SystemRowLite>('SELECT id, name, owners, iem_device_id FROM systems ORDER BY name, id');
  const apps = db().all<AppRowLite>('SELECT id, name, owners, archived FROM applications ORDER BY name, id');
  const links = new Set(
    db()
      .all<{ a: string; s: string }>('SELECT application_id AS a, system_id AS s FROM application_systems')
      .map((l) => `${l.a}|${l.s}`),
  );
  const seeSystem = (s: SystemRowLite) => catalogueVisibleNow('system', s);
  const seeApp = (a: AppRowLite) => catalogueVisibleNow('application', a);
  const editSystem = (s: SystemRowLite) => canEditService(u, { kind: 'system', id: s.id, owners: parseJson<string[]>(s.owners, []) });
  const dismissed = dismissedKeys();
  const list: (EdgeSuggestion & { dismissed: boolean })[] = [];
  let hidden = 0;
  const base = (dev: Installed) => ({ deviceId: dev.deviceId, deviceName: dev.deviceName, appTitle: null, appVersion: null, application: null });
  const push = (x: EdgeSuggestion) => list.push({ ...x, dismissed: dismissed.has(x.key) });
  for (const dev of devices) {
    const byId = systems.find((s) => s.iem_device_id === dev.deviceId);
    let system: SystemRowLite | undefined = byId;
    if (byId && !seeSystem(byId)) {
      // its system is one the reader may not see: nothing is suggested for it, it is counted
      hidden++;
      continue;
    }
    if (!byId) {
      const named = systems.filter((s) => sameHost(s.name, dev.deviceName));
      const seen = named.filter(seeSystem);
      if (named.length > seen.length) hidden++;
      if (seen.length === 1) {
        system = seen[0]!;
        // the system that is the device by name, without its IEM device id
        push({
          ...base(dev),
          key: `linkSystem:${dev.deviceId}:${system.id}`,
          kind: 'linkSystem',
          system: { id: system.id, name: system.name },
          canConfirm: editSystem(system),
        });
      } else if (!named.length) {
        push({ ...base(dev), key: `createSystem:${dev.deviceId}`, kind: 'createSystem', system: null, canConfirm: canCreateServices(u) });
        continue;
      } else continue; // several systems by that name, or only one the reader may not see: nothing to suggest
    }
    if (!system) continue;
    for (const app of dev.apps) {
      const found = apps.filter((a) => norm(a.name) === norm(app.title));
      const seen = found.filter(seeApp);
      if (found.length > seen.length) {
        hidden++;
        continue;
      }
      const a = seen[0];
      if (a && links.has(`${a.id}|${system.id}`)) continue;
      push({
        ...base(dev),
        key: `addApplication:${dev.deviceId}:${norm(app.title)}`,
        kind: 'addApplication',
        system: { id: system.id, name: system.name },
        appTitle: app.title,
        appVersion: app.version || null,
        application: a ? { id: a.id, name: a.name } : null,
        canConfirm: a ? !a.archived && canEditApplication(u, a) : canCreateServices(u),
      });
    }
  }
  return {
    readout: {
      dataset: d.key,
      title: d.title,
      updatedAt: d.updatedAt,
      devices: devices.length,
      installations: devices.reduce((n, x) => n + x.apps.length, 0),
    },
    list,
    hidden,
  };
}

/** GET /api/systems/edge-suggestions: the open suggestions (dismissed ones counted). */
export function edgeSuggestions(): EdgeSuggestions {
  const { readout, list, hidden } = compute();
  return {
    readout,
    suggestions: list.filter((x) => !x.dismissed).map(({ dismissed: _d, ...x }) => x),
    dismissed: list.filter((x) => x.dismissed).length,
    hidden,
  };
}

export const edgeSuggestionInput = z.object({ key: z.string().trim().min(1).max(600) }).strict();

/** The suggestion with this key as the readout says it now – it must still be suggested and the reader may confirm it. */
function current(key: string, dismissedToo: boolean): EdgeSuggestion {
  const s = compute().list.find((x) => x.key === key && (dismissedToo || !x.dismissed));
  if (!s) throw new HttpError(404, 'The readout no longer suggests this', 'EDGE_SUGGESTION_GONE', { key });
  if (!s.canConfirm) forbid('confirm this suggestion', 'confirmEdgeSuggestion');
  const { dismissed: _d, ...rest } = s as EdgeSuggestion & { dismissed?: boolean };
  return rest;
}

/** POST /api/systems/edge-suggestions/confirm: does what it suggests, with the rights and audit of that change. */
export function confirmEdgeSuggestion(key: string): { suggestion: EdgeSuggestion; systemId: string | null; applicationId: string | null } {
  const s = current(key, true);
  let systemId = s.system?.id ?? null;
  let applicationId = s.application?.id ?? null;
  if (s.kind === 'createSystem') {
    systemId = createSystem(
      systemInput.parse({ name: s.deviceName, kind: 'appliance', note: 'Industrial Edge device (from the installations readout)', iemDeviceId: s.deviceId }),
    ).id;
  } else if (s.kind === 'linkSystem') {
    const cur = getSystem(s.system!.id);
    updateSystem(
      cur.id,
      systemInput.parse({
        name: cur.name,
        kind: cur.kind,
        vendor: cur.vendor,
        cmdbUrl: cur.cmdbUrl,
        owners: cur.owners,
        note: cur.note,
        iemDeviceId: s.deviceId,
      }),
    );
  } else {
    if (!applicationId) applicationId = createApplication(applicationInput.parse({ name: s.appTitle!, version: s.appVersion ?? '' })).id;
    linkSystem(
      applicationId,
      { systemId: systemId!, environment: '', note: s.appVersion ? `Version ${s.appVersion} (Industrial Edge readout)` : 'Industrial Edge readout' },
      canEditApplication,
    );
  }
  db().run('DELETE FROM edge_suggestion_dismissals WHERE suggestion_key = ?', key);
  audit({
    action: 'edge.suggestion_confirmed',
    entityType: s.kind === 'addApplication' ? 'application' : 'system',
    entityId: (s.kind === 'addApplication' ? applicationId : systemId) ?? '',
    summary: `Industrial Edge suggestion confirmed: ${summaryOf(s)}`,
    details: { key, kind: s.kind, deviceId: s.deviceId, deviceName: s.deviceName, systemId, applicationId, appTitle: s.appTitle, appVersion: s.appVersion },
  });
  return { suggestion: s, systemId, applicationId };
}

/** POST /api/systems/edge-suggestions/dismiss: keeps it away while the readout says the same (who may confirm it). */
export function dismissEdgeSuggestion(key: string): void {
  const s = current(key, false);
  const u = me();
  db().run(
    `INSERT INTO edge_suggestion_dismissals (suggestion_key, kind, label, dismissed_at, dismissed_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (suggestion_key) DO NOTHING`,
    key,
    s.kind,
    summaryOf(s).slice(0, 500),
    nowIso(),
    u.username,
  );
  audit({
    action: 'edge.suggestion_dismissed',
    entityType: s.kind === 'createSystem' ? 'iem_device' : 'system',
    entityId: s.kind === 'createSystem' ? s.deviceId : (s.system?.id ?? ''),
    summary: `Industrial Edge suggestion dismissed: ${summaryOf(s)}`,
    details: { key, kind: s.kind, deviceId: s.deviceId, deviceName: s.deviceName, systemId: s.system?.id ?? null, appTitle: s.appTitle },
  });
}

/** POST /api/systems/edge-suggestions/restore: the dismissed ones are suggested again (designers and administrators). */
export function restoreEdgeSuggestions(): { restored: number } {
  if (!canCreateServices(me())) forbid('restore dismissed suggestions', 'restoreEdgeSuggestions');
  const n = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM edge_suggestion_dismissals')?.n ?? 0;
  if (!n) return { restored: 0 };
  db().run('DELETE FROM edge_suggestion_dismissals');
  audit({
    action: 'edge.suggestions_restored',
    entityType: 'iem_device',
    entityId: '',
    summary: `${n} dismissed Industrial Edge suggestion(s) restored`,
    details: { count: n },
  });
  return { restored: n };
}

function summaryOf(s: EdgeSuggestion): string {
  if (s.kind === 'createSystem') return `device "${s.deviceName}" has no system – create it`;
  if (s.kind === 'linkSystem') return `device "${s.deviceName}" is system "${s.system?.name}" – record its IEM device id`;
  return `${s.appTitle}${s.appVersion ? ` ${s.appVersion}` : ''} runs on "${s.system?.name}" but is not recorded – add it`;
}
