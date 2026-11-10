import {
  IMPACT_GROUPS,
  IMPACT_LIMITS,
  MAINTENANCE_LIMITS,
  MAINTENANCE_TARGET_KINDS,
  MAINTENANCE_TARGET_RE,
  type DashboardDefinition,
  type ImpactContact,
  type ImpactDowntimeResult,
  type ImpactNotifyResult,
  type ImpactExpectation,
  type ImpactGroup,
  type ImpactGroupKind,
  type ImpactItem,
  type ImpactMonitor,
  type ImpactVia,
  type MaintenanceImpact,
  type MaintenanceKind,
  type MaintenanceTarget,
  type MaintenanceTargetKind,
} from '@sm/shared';
import { db } from '../db.js';
import { forbid, me } from '../records/access.js';
import { HttpError, parseJson } from '../util.js';
import { owningTeams } from '../auth/policy.js';
import { resolveTarget } from '../records/links.js';
import { permissionsOfRow } from '../monitors/model.js';
import { dashboardVisible, datasetsOf } from '../dashboards/service.js';
import { readableDataset } from '../plant/live.js';
import { plantEnabled } from '../plant/settings.js';
import { plantImpact, type ImpactFound, type ImpactSink } from '../plant/impact.js';
import {
  announceImpact,
  canPlan,
  createMaintenance,
  inputOfWindow,
  maintenanceInput,
  monitorsOn,
  nameOf,
  ownersOf,
  reachOf,
  targetsOf,
  updateMaintenance,
  visibleRow,
  type TargetRef,
} from './maintenance.js';

/**
 * Impact before maintenance (0.14, docs/APPLICATIONS.md "Impact before maintenance"): what a window affects – before it
 * is saved (GET /api/maintenance-windows/impact?targets=kind:id,…) and on its page (GET …/:id/impact). The catalogue's
 * reach (maintenance.ts reachOf) and the plant's walk (plant/impact.ts), grouped and counted, each item linked, with the
 * monitors' expectations (a monitor with an Off state goes Off, not down) and the owners and contacts to tell.
 *
 * Read-only and bounded (IMPACT_LIMITS). Every item is named only for readers who may see it; the others are counted.
 */

type Entry = ImpactFound & { monitor?: Omit<ImpactMonitor, keyof ImpactItem> };

class Builder implements ImpactSink {
  groups = Object.fromEntries(IMPACT_GROUPS.map((g) => [g, new Map<string, Entry>()])) as Record<ImpactGroupKind, Map<string, Entry>>;
  nodes = 0;
  truncated = false;
  add(group: ImpactGroupKind, key: string, item: Entry): boolean {
    const g = this.groups[group];
    if (g.has(key)) return false;
    if (this.nodes >= IMPACT_LIMITS.nodes) {
      this.truncated = true;
      return false;
    }
    g.set(key, item);
    this.nodes++;
    return true;
  }
  cut(): void {
    this.truncated = true;
  }
}

/** `kind:id,kind:id` of the query (at most IMPACT_LIMITS.targets). */
export function parseTargets(q: string | undefined): TargetRef[] {
  const list = (q ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (list.length > IMPACT_LIMITS.targets)
    throw new HttpError(400, `At most ${IMPACT_LIMITS.targets} targets`, 'MAINTENANCE_IMPACT_TARGETS', { max: IMPACT_LIMITS.targets });
  return list.map((x) => {
    if (!MAINTENANCE_TARGET_RE.test(x))
      throw new HttpError(400, `"${x.slice(0, 120)}" is not kind:id`, 'MAINTENANCE_IMPACT_TARGETS', { target: x.slice(0, 120) });
    const i = x.indexOf(':');
    const kind = x.slice(0, i) as MaintenanceTargetKind;
    if (!MAINTENANCE_TARGET_KINDS.includes(kind)) throw new HttpError(400, `Unknown kind ${kind}`, 'MAINTENANCE_IMPACT_TARGETS', { target: x });
    return { kind, id: x.slice(i + 1) };
  });
}

type MonitorRow = { id: string; key: string | null; name: string; owner: string; acl: string; enabled: number; definition: string; status: string | null };
const MONITOR_SELECT =
  'SELECT m.id, m.key, m.name, m.owner, m.acl, m.enabled, m.definition, s.status FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id';

const hasOffState = (definition: string) =>
  (parseJson<{ states?: { cases?: { status?: string }[] } }>(definition, {}).states?.cases ?? []).some((c) => c?.status === 'off');

/**
 * The impact of these targets for the reader. `kind` and `quietMonitors` are the window's: a maintenance window that
 * keeps monitors quiet covers the monitors it lists and those on an affected platform; planned downtime covers them as
 * Off where they have an Off state.
 */
export function impactOf(targets: TargetRef[], w: { kind: MaintenanceKind; quietMonitors: boolean }): MaintenanceImpact {
  const u = me();
  const b = new Builder();
  const reach = reachOf(targets);
  const named = new Set(targets.map((t) => `${t.kind}:${t.id}`));

  // ---------- catalogue: what it lists and reaches ----------
  const catalogue = (
    group: 'platforms' | 'systems' | 'applications' | 'services',
    kind: 'platform' | 'system' | 'application' | 'service',
    id: string,
    via: ImpactVia,
    from: string | null,
  ) => {
    const r = resolveTarget(kind, id);
    b.add(group, id, { name: r?.label ?? '', path: r?.path ?? null, detail: '', via: named.has(`${kind}:${id}`) ? 'target' : via, from, visible: !!r });
  };
  for (const id of reach.platforms) catalogue('platforms', 'platform', id, 'reach', null);
  for (const id of reach.systems) catalogue('systems', 'system', id, 'reach', null);
  for (const id of reach.applications) catalogue('applications', 'application', id, 'reach', null);
  for (const id of reach.services) catalogue('services', 'service', id, 'reach', null);

  // ---------- the plant registry ----------
  const plant = plantImpact(targets, reach, b);
  const nameOfItem = (kind: 'application' | 'platform' | 'system', id: string) => resolveTarget(kind, id)?.label ?? null;
  for (const x of plant.applications) catalogue('applications', 'application', x.id, x.via, x.from);
  for (const x of plant.platforms) catalogue('platforms', 'platform', x.id, x.via, x.from);
  for (const x of plant.systems) catalogue('systems', 'system', x.id, x.via, x.from);
  // the services of applications the data passes through
  for (const x of plant.applications)
    for (const s of db().all<{ service_id: string }>('SELECT service_id FROM service_applications WHERE application_id = ?', x.id))
      catalogue('services', 'service', s.service_id, 'reach', nameOfItem('application', x.id));

  // ---------- datasets and dashboards ----------
  // a dataset is named by its key where the plant names it (who sees the asset reads it there); its page only for who may read it
  for (const [key, x] of plant.datasets)
    b.add('datasets', key, {
      name: key,
      path: x.visible && readableDataset(key) ? '/dashboards' : null,
      detail: '',
      via: x.via,
      from: x.from,
      visible: x.visible,
    });
  const dashRows = db().all<{ id: string; name: string; owner: string | null; definition: string }>(
    'SELECT id, name, owner, definition FROM dashboards ORDER BY name, id',
  );
  for (const [id, x] of plant.dashboards) {
    const d = dashRows.find((r) => r.id === id);
    const visible = !!d && dashboardVisible({ id: d.id, owner: d.owner ?? '' });
    b.add('dashboards', id, { name: d?.name ?? '', path: visible ? `/dashboards/${id}` : null, detail: '', via: x.via, from: x.from, visible });
  }
  if (plant.datasets.size)
    for (const d of dashRows) {
      const def = parseJson<DashboardDefinition | null>(d.definition, null);
      if (!def || !Array.isArray(def.widgets)) continue;
      const reads = datasetsOf(def).find((k) => plant.datasets.has(k));
      if (!reads) continue;
      const visible = dashboardVisible({ id: d.id, owner: d.owner ?? '' });
      b.add('dashboards', d.id, { name: d.name, path: visible ? `/dashboards/${d.id}` : null, detail: '', via: 'sink', from: reads, visible });
    }

  // ---------- monitors ----------
  const monitorVia = new Map<string, { via: ImpactVia; from: string | null }>();
  for (const id of reach.monitors) monitorVia.set(id, { via: 'target', from: null });
  for (const id of monitorsOn(reach.platforms)) if (!monitorVia.has(id)) monitorVia.set(id, { via: 'platform', from: null });
  const rows = new Map(
    db()
      .all<MonitorRow>(`${MONITOR_SELECT} WHERE m.is_template = 0`)
      .map((m) => [m.id, m]),
  );
  const byKey = new Map([...rows.values()].filter((m) => m.key).map((m) => [m.key!.toLowerCase(), m.id]));
  for (const x of plant.monitors) {
    const id = rows.has(x.ref) ? x.ref : byKey.get(x.ref.toLowerCase());
    if (id && !monitorVia.has(id)) monitorVia.set(id, { via: x.via, from: x.from });
  }
  // the platforms a monitor checks: a quiet maintenance window keeps those on an affected platform quiet
  const onPlatform = new Set(monitorsOn(reach.platforms));
  for (const [id, x] of monitorVia) {
    const m = rows.get(id);
    if (!m) continue;
    const perms = permissionsOfRow(m, u);
    const listed = reach.monitors.has(id);
    const offState = hasOffState(m.definition);
    const covered = listed || onPlatform.has(id);
    const expect: ImpactExpectation =
      w.kind === 'maintenance' && w.quietMonitors && covered
        ? 'maintenance'
        : w.kind === 'downtime' && covered && offState
          ? 'downtime'
          : offState
            ? 'off'
            : 'down';
    b.add('monitors', id, {
      name: m.name,
      path: `/monitors/${id}`,
      detail: '',
      via: x.via,
      from: x.from,
      visible: perms.includes('view'),
      monitor: {
        status: m.enabled ? (m.status ?? null) : null,
        enabled: !!m.enabled,
        offState,
        expect,
        listed,
        canAdd: !listed && perms.includes('acknowledge'),
      },
    });
  }

  // ---------- the groups, as the reader may see them ----------
  const group = (g: ImpactGroupKind): ImpactGroup => {
    const all = [...b.groups[g].entries()];
    const visible = all.filter(([, x]) => x.visible);
    visible.sort(([ka, a], [kb, z]) => a.name.localeCompare(z.name) || (ka < kb ? -1 : ka > kb ? 1 : 0));
    return {
      total: visible.length,
      hidden: all.length - visible.length,
      items: visible.slice(0, IMPACT_LIMITS.items).map(([id, x]) => ({
        id,
        name: x.name,
        path: x.path,
        detail: x.detail,
        via: x.via,
        from: x.from,
        ...(x.monitor ?? {}),
      })),
    };
  };
  const groups = Object.fromEntries(IMPACT_GROUPS.map((g) => [g, group(g)])) as MaintenanceImpact['groups'];

  // ---------- who to tell: owners of what the reader sees, the sites' teams and contacts ----------
  const contacts = new Map<string, ImpactContact>();
  const users = db().all<{ username: string; display_name: string; email: string | null; active: number }>(
    'SELECT username, display_name, email, active FROM users',
  );
  const teams = new Map(
    db()
      .all<{ name: string }>('SELECT name FROM teams')
      .map((t) => [t.name.toLowerCase(), t.name]),
  );
  const contact = (subject: string, of: string) => {
    const s = subject.trim();
    const i = s.indexOf(':');
    if (i < 1) return;
    const kind = s.slice(0, i).toLowerCase();
    const name = s.slice(i + 1);
    const k = `${kind}:${name.toLowerCase()}`;
    let c = contacts.get(k);
    if (!c) {
      const user = kind === 'user' ? users.find((x) => x.username.toLowerCase() === name.toLowerCase()) : undefined;
      const team = kind === 'team' ? teams.get(name.toLowerCase()) : undefined;
      c = {
        subject: k,
        label: user ? user.display_name || user.username : (team ?? name),
        of: [],
        notifiable: (!!user && !!user.active) || !!team,
      };
      contacts.set(k, c);
    }
    if (of && !c.of.includes(of) && c.of.length < 5) c.of.push(of);
  };
  for (const g of ['services', 'applications', 'systems'] as const) {
    const kind = g === 'services' ? 'service' : g === 'applications' ? 'application' : 'system';
    for (const [id, x] of b.groups[g]) if (x.visible) for (const s of ownersOf(kind, id) ?? []) contact(s, x.name);
  }
  for (const [id, x] of b.groups.platforms) if (x.visible) for (const t of owningTeams('platform', id)) contact(`team:${t.name}`, x.name);
  for (const [id, x] of b.groups.monitors) if (x.visible && rows.get(id)?.owner) contact(`user:${rows.get(id)!.owner}`, x.name);
  for (const siteId of plant.sites) {
    const s = db().get<{ name: string; contacts: string }>('SELECT name, contacts FROM plant_sites WHERE id = ?', siteId);
    if (!s) continue;
    for (const t of owningTeams('site', siteId)) contact(`team:${t.name}`, s.name);
    for (const c of parseJson<{ name: string; email?: string }[]>(s.contacts, [])) {
      const user = c.email ? users.find((x) => x.active && x.email && x.email.toLowerCase() === c.email!.toLowerCase()) : undefined;
      contact(user ? `user:${user.username}` : `contact:${c.name}`, s.name);
    }
  }

  const monitors = groups.monitors.items as ImpactMonitor[];
  return {
    targets: targets.flatMap((t): MaintenanceTarget[] => {
      const name = nameOf(t, u);
      return name === null ? [] : [{ ...t, name }];
    }),
    kind: w.kind,
    groups,
    contacts: [...contacts.values()].sort((a, z) => Number(z.notifiable) - Number(a.notifiable) || a.label.localeCompare(z.label)),
    truncated: b.truncated,
    addableMonitors: monitors.filter((m) => m.canAdd).length,
    plant: plantEnabled(),
  };
}

/** GET /api/maintenance-windows/impact: before saving – the targets of the form, the kind and quiet flag it has. */
export function previewImpact(q: { targets?: string; kind?: MaintenanceKind; quietMonitors?: boolean }): MaintenanceImpact {
  const targets = parseTargets(q.targets);
  return impactOf(targets, { kind: q.kind ?? 'maintenance', quietMonitors: q.quietMonitors ?? true });
}

/** GET /api/maintenance-windows/:id/impact: a window the reader may see. */
export function windowImpact(id: string): MaintenanceImpact {
  const r = visibleRow(id, me());
  return impactOf(targetsOf(id), { kind: r.kind === 'downtime' ? 'downtime' : 'maintenance', quietMonitors: !!r.quiet_monitors });
}

/**
 * POST /api/maintenance-windows/:id/impact/downtime – the one click for the affected monitors the planner may list:
 * `downtime` plans planned downtime for them at the window's times (a new window of kind downtime that lists them, so
 * monitors with states show Off and still alert contradictions); `include` lists them in this window (a quiet
 * maintenance window then keeps them quiet). Monitors the window covers already, and those the planner may not list,
 * are left out (counted).
 */
export function downtimeForMonitors(id: string, mode: 'downtime' | 'include'): ImpactDowntimeResult {
  const impact = windowImpact(id);
  if (!canPlan(me(), targetsOf(id))) forbid('plan maintenance for these items', 'planMaintenance');
  const all = impact.groups.monitors.items as ImpactMonitor[];
  const wanted = all.filter((m) => m.canAdd && m.expect !== 'maintenance' && (mode === 'include' || m.expect !== 'downtime'));
  const skipped = all.filter((m) => !m.listed && !m.canAdd).length + impact.groups.monitors.hidden;
  if (!wanted.length) throw new HttpError(400, 'No affected monitor to add', 'MAINTENANCE_IMPACT_NO_MONITORS');
  const input = inputOfWindow(id);
  const monitors = wanted.map((m) => ({ kind: 'monitor' as const, id: m.id }));
  if (mode === 'include') {
    const next = maintenanceInput.parse({ ...input, targets: [...input.targets, ...monitors] });
    return { window: updateMaintenance(id, next), added: wanted.length, skipped };
  }
  const next = maintenanceInput.parse({
    ...input,
    kind: 'downtime',
    targets: monitors,
    // planned downtime announces nothing by default (ADR 0021); the window itself announces the work
    reminderHours: 0,
    note: `Planned downtime for the monitors affected by "${input.title}".${input.note ? `\n\n${input.note}` : ''}`.slice(0, MAINTENANCE_LIMITS.note),
  });
  return { window: createMaintenance(next, { from: id }), added: wanted.length, skipped };
}

/** POST /api/maintenance-windows/:id/impact/notify – the owners and contacts the impact names are told (once per version). */
export async function notifyImpact(id: string): Promise<ImpactNotifyResult> {
  const impact = windowImpact(id);
  if (!canPlan(me(), targetsOf(id))) forbid('tell the owners about this maintenance window', 'planMaintenance');
  const n = await announceImpact(
    id,
    impact.contacts.filter((c) => c.notifiable).map((c) => ({ subject: c.subject, of: c.of })),
  );
  return { recipients: n ?? 0, already: n === null };
}
