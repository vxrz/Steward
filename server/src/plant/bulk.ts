import {
  PLANT_BULK,
  PLANT_BULK_FIELDS,
  type PlantBulkInput,
  type PlantBulkItem,
  type PlantBulkKind,
  type PlantBulkResult,
  type PlantBulkSet,
  type PlantLevel,
  type PlantPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { currentUser } from '../auth/context.js';
import { HttpError, nowIso, sha256 } from '../util.js';
import { allSiteRights, entryOf, entryPermissions } from './ids.js';
import { canManageCatalogue, plantManagesSome } from './access.js';
import { planRemoval, type Target } from './removal.js';
import { requirePlant } from './settings.js';
import { catalogueEntryAccess, seesEntry } from './catalogue-access.js';
import {
  assetRowOf,
  assetValuesOf,
  changedKeys,
  cleanTags,
  loadIndex,
  refsOfOne,
  resolveLocation,
  upsertAsset,
  type AssetValues,
  type SiteIndex,
} from './model.js';
import {
  assignmentRowOf,
  assignmentValuesOf,
  kpiRowOf,
  kpiValuesOf,
  profileRowOf,
  profileValuesOf,
  templateMessage,
  upsertAssignment,
  upsertKpi,
  upsertProfile,
} from './data-model.js';
import { ASSIGNMENT_DEFAULTS } from './import-data.js';
import { deviceValuesOf, upsertDevice, upsertVlan, vlanValuesOf, type DeviceRow, type VlanRow } from './network-model.js';

/**
 * Changing or removing many entries at once from the lists (0.11.0, docs/PLANT.md#changing-many-entries-at-once):
 * a preview first (what changes, what is skipped – no right – and what is refused, with the reason), then the change
 * in one transaction, audited as one entry with the entries in its details. Entries are changed through the same
 * rules as an edit; removing goes through the removal core (removal.ts).
 */

/** Whether applying it asks for a step-up (control point plant.bulkChange): removing more than one, editing many. */
export function bulkNeedsStepUp(b: Pick<PlantBulkInput, 'action' | 'items'>): boolean {
  return b.action === 'remove' ? b.items.length > 1 : b.items.length > PLANT_BULK.editStepUp;
}

interface Edited {
  item: PlantBulkItem;
  write?: () => void;
}

const reason = (code: string, message: string) => ({ code, message });

function editAsset(id: string, set: PlantBulkSet, rights: Map<string, PlantPermission[]>, indexes: Map<string, SiteIndex>, at: string, by: string): Edited {
  const row = assetRowOf(id);
  const perms = row ? (rights.get(row.site_id) ?? []) : [];
  if (!row || !perms.includes('view'))
    return { item: { scope: '', id, name: id, outcome: 'refused', reason: reason('PLANT_ENTRY_NOT_FOUND', `There is no asset "${id}"`) } };
  const base = { scope: '', id, name: row.name };
  if (!perms.includes('manage')) return { item: { ...base, outcome: 'skipped', reason: reason('FORBIDDEN', `You may not change asset "${id}"`) } };
  const before = assetValuesOf(row, refsOfOne('asset', id));
  const v: AssetValues = { ...before, tags: [...before.tags] };
  if (set.status) v.status = set.status;
  if (set.addTags || set.removeTags) {
    const drop = new Set(set.removeTags ?? []);
    v.tags = cleanTags([...v.tags.filter((t) => !drop.has(t)), ...(set.addTags ?? [])]);
  }
  for (const k of ['domain', 'processArea', 'role', 'manufacturer', 'model'] as const) if (set[k] !== undefined) v[k] = set[k]!;
  if (set.endOfSupport !== undefined) v.endOfSupport = set.endOfSupport;
  let index = indexes.get(row.site_id);
  if (!index) indexes.set(row.site_id, (index = loadIndex(row.site_id)));
  if (set.nodeId !== undefined || set.buildingId !== undefined) {
    const loc = { areaId: v.areaId, workCenterId: v.workCenterId, workUnitId: v.workUnitId, buildingId: v.buildingId };
    if (set.nodeId !== undefined) {
      const n = set.nodeId ? index.nodes.get(set.nodeId) : null;
      if (set.nodeId && !n)
        return { item: { ...base, outcome: 'refused', reason: reason('PLANT_LOCATION_UNKNOWN', `Site "${row.site_id}" has no place "${set.nodeId}"`) } };
      const level: PlantLevel | null = n?.level ?? null;
      loc.areaId = level === 'area' ? n!.id : null;
      loc.workCenterId = level === 'work_center' ? n!.id : null;
      loc.workUnitId = level === 'work_unit' ? n!.id : null;
    }
    if (set.buildingId !== undefined) loc.buildingId = set.buildingId;
    const r = resolveLocation(index, loc);
    if ('problem' in r) return { item: { ...base, outcome: 'refused', reason: reason(r.code, r.problem) } };
    Object.assign(v, r.value);
  }
  const changes = changedKeys(before, v);
  // the device profile is the assignment's
  let assignmentWrite: (() => void) | undefined;
  if (set.profileId !== undefined) {
    const cur = assignmentRowOf(id);
    const a = cur ? assignmentValuesOf(cur) : ASSIGNMENT_DEFAULTS();
    if (a.profileId !== set.profileId) {
      // 0.21.0 (#293): a profile the caller may not see reads like one that does not exist
      const target = set.profileId && seesEntry(currentUser(), 'device_profile', set.profileId) ? profileRowOf(set.profileId) : undefined;
      if (set.profileId && !target)
        return { item: { ...base, outcome: 'refused', reason: reason('PLANT_PROFILE_NOT_FOUND', `There is no device profile "${set.profileId}"`) } };
      // 0.12.0: a template is only for other profiles to extend
      if (target && Number(target.template))
        return { item: { ...base, outcome: 'refused', reason: reason('PLANT_PROFILE_TEMPLATE', templateMessage(target.name)) } };
      // interfaces, differences and publications name the old profile's interfaces and data points
      if (a.profileId && (a.interfaces.length || a.overrides.length || a.publications.length))
        return {
          item: {
            ...base,
            outcome: 'refused',
            reason: reason(
              'PLANT_ASSIGNMENT_HAS_SETTINGS',
              `Asset "${id}" has interface settings for ${seesEntry(currentUser(), 'device_profile', a.profileId) ? `profile "${a.profileId}"` : 'its device profile'} – change its profile on its page`,
            ),
          },
        };
      changes.push('profileId');
      assignmentWrite = () =>
        upsertAssignment(
          id,
          { ...a, profileId: set.profileId ?? null },
          { importId: cur?.import_id ?? null, notInSource: !!cur?.not_in_source, at, by },
          { keepSource: true },
        );
    }
  }
  if (!changes.length) return { item: { ...base, outcome: 'unchanged' } };
  return {
    item: { ...base, outcome: 'changed', fields: changes },
    write: () => {
      if (changes.some((c) => c !== 'profileId')) upsertAsset(v, { at, by }, { keepSource: true });
      assignmentWrite?.();
    },
  };
}

function editCatalogue(kind: 'profile' | 'kpi', id: string, set: PlantBulkSet, at: string, by: string): Edited {
  const row = kind === 'profile' ? profileRowOf(id) : kpiRowOf(id);
  // 0.21.0 (#293): its own rights – one the caller may not see reads like one that does not exist, Edit changes it
  const rights = row ? catalogueEntryAccess(currentUser(), kind === 'profile' ? 'device_profile' : 'kpi_definition', id).permissions : [];
  if (!row || !rights.includes('view'))
    return { item: { scope: '', id, name: id, outcome: 'refused', reason: reason('PLANT_ENTRY_NOT_FOUND', `There is no ${kind} "${id}"`) } };
  const base = { scope: '', id, name: row.name };
  if (!rights.includes('edit'))
    return { item: { ...base, outcome: 'skipped', reason: reason('FORBIDDEN', `You may not change ${kind} "${id}"`) } };
  if (kind === 'profile') {
    const before = profileValuesOf(row as Parameters<typeof profileValuesOf>[0]);
    const v = {
      ...before,
      ...(set.category !== undefined ? { category: set.category } : {}),
      ...(set.manufacturer !== undefined ? { manufacturer: set.manufacturer } : {}),
    };
    const changes = changedKeys(before, v);
    if (!changes.length) return { item: { ...base, outcome: 'unchanged' } };
    return { item: { ...base, outcome: 'changed', fields: changes }, write: () => upsertProfile(v, { at, by }, { keepSource: true }) };
  }
  const before = kpiValuesOf(row as Parameters<typeof kpiValuesOf>[0]);
  const v = { ...before, ...(set.category !== undefined ? { category: set.category } : {}) };
  const changes = changedKeys(before, v);
  if (!changes.length) return { item: { ...base, outcome: 'unchanged' } };
  return { item: { ...base, outcome: 'changed', fields: changes }, write: () => upsertKpi(v, { at, by }, { keepSource: true }) };
}

function editNetwork(
  kind: 'vlan' | 'device',
  scope: string,
  id: string,
  set: PlantBulkSet,
  rights: Map<string, PlantPermission[]>,
  at: string,
  by: string,
): Edited {
  const e = entryOf(kind, scope, id);
  const perms = e ? entryPermissions(e, rights) : [];
  if (!e || !perms.includes('view'))
    return { item: { scope, id, name: id, outcome: 'refused', reason: reason('PLANT_ENTRY_NOT_FOUND', `There is no ${kind} "${id}"`) } };
  const base = { scope, id, name: e.name };
  if (!perms.includes('manage')) return { item: { ...base, outcome: 'skipped', reason: reason('FORBIDDEN', `You may not change ${kind} "${id}"`) } };
  if (kind === 'vlan') {
    const row = db().get<VlanRow>('SELECT * FROM plant_vlans WHERE site_id = ? AND id = ?', scope, id)!;
    const before = vlanValuesOf(row);
    const v = { ...before, sites: [...before.sites] };
    if (set.type !== undefined) v.type = set.type;
    if (set.managedBy !== undefined) v.managedBy = set.managedBy;
    if (set.restricted !== undefined) v.restricted = set.restricted;
    if (set.owner !== undefined) v.owner = set.owner;
    const changes = changedKeys(before, v);
    if (!changes.length) return { item: { ...base, outcome: 'unchanged' } };
    return {
      item: { ...base, outcome: 'changed', fields: changes },
      write: () => upsertVlan(scope, v, row.position, { importId: row.import_id, notInSource: !!row.not_in_source, at, by }, { keepSource: true }),
    };
  }
  const row = db().get<DeviceRow>('SELECT * FROM plant_devices WHERE asset_id = ? AND id = ?', scope, id)!;
  const before = deviceValuesOf(row);
  const v = { ...before, flags: [...before.flags] };
  if (set.state) v.state = set.state;
  if (set.confidence !== undefined) v.confidence = set.confidence;
  if (set.owner !== undefined) v.owner = set.owner;
  if (set.addFlags || set.removeFlags) {
    const drop = new Set(set.removeFlags ?? []);
    v.flags = [...new Set([...v.flags.filter((f) => !drop.has(f)), ...(set.addFlags ?? [])])].sort();
  }
  const changes = changedKeys(before, v);
  if (!changes.length) return { item: { ...base, outcome: 'unchanged' } };
  return {
    item: { ...base, outcome: 'changed', fields: changes },
    write: () => upsertDevice(scope, v, row.position, { importId: row.import_id, notInSource: !!row.not_in_source, at, by }, { keepSource: true }),
  };
}

function checkFields(kind: PlantBulkKind, set: PlantBulkSet, action: PlantBulkInput['action']): void {
  if (action !== 'edit') return;
  const given = (Object.keys(set) as (keyof PlantBulkSet)[]).filter((k) => set[k] !== undefined);
  const wrong = given.find((k) => !PLANT_BULK_FIELDS[kind].includes(k));
  if (wrong) throw new HttpError(400, `${wrong} cannot be set on many ${kind} entries at once`, 'PLANT_BULK_FIELD', { field: wrong, kind });
  if (!given.length) throw new HttpError(400, 'Choose what to change', 'PLANT_BULK_NOTHING');
}

const scopeOf = (kind: PlantBulkKind, scope: string) => (kind === 'vlan' || kind === 'device' ? scope : '');

function compute(b: PlantBulkInput): { result: Omit<PlantBulkResult, 'applied'>; apply: () => void } {
  requirePlant();
  const u = me();
  const catalogue = b.kind === 'profile' || b.kind === 'kpi';
  if (catalogue ? !canManageCatalogue(u) : !plantManagesSome(u))
    throw new HttpError(403, 'You are not allowed to change entries of the plant registry', 'FORBIDDEN', {
      context: catalogue ? 'managePlantCatalogue' : 'managePlant',
    });
  checkFields(b.kind, b.set, b.action);
  const rights = allSiteRights();
  const at = nowIso();
  const by = u.username;
  const seen = new Set<string>();
  const items = b.items.filter((i) => {
    const k = `${scopeOf(b.kind, i.scope)}|${i.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let list: PlantBulkItem[];
  let apply: () => void;
  if (b.action === 'remove') {
    const targets: Target[] = items.map((i) => ({ kind: b.kind, scope: scopeOf(b.kind, i.scope), id: i.id }));
    const plan = planRemoval(targets, { cascade: b.cascade, rights });
    list = plan.plan.items.map((x) => ({
      scope: x.scope,
      id: x.id,
      name: x.name,
      outcome: !x.refused ? 'removed' : x.refused.code === 'FORBIDDEN' ? 'skipped' : 'refused',
      with: x.with,
      ...(x.refused ? { reason: x.refused } : {}),
    }));
    apply = plan.apply;
  } else {
    const indexes = new Map<string, SiteIndex>();
    const edited = items.map((i) =>
      b.kind === 'asset'
        ? editAsset(i.id, b.set, rights, indexes, at, by)
        : b.kind === 'profile' || b.kind === 'kpi'
          ? editCatalogue(b.kind, i.id, b.set, at, by)
          : b.kind === 'vlan' || b.kind === 'device'
            ? editNetwork(b.kind, i.scope, i.id, b.set, rights, at, by)
            : {
                item: { scope: '', id: i.id, name: i.id, outcome: 'refused' as const, reason: reason('PLANT_BULK_FIELD', 'Nothing of a site can be set here') },
              },
    );
    list = edited.map((e) => e.item);
    apply = () => edited.forEach((e) => e.write?.());
  }
  const counts: PlantBulkResult['counts'] = { changed: 0, unchanged: 0, removed: 0, skipped: 0, refused: 0 };
  for (const i of list) counts[i.outcome]++;
  return { result: { kind: b.kind, action: b.action, items: list, counts, stepUp: bulkNeedsStepUp({ action: b.action, items }) }, apply };
}

/** POST /api/plant/bulk/preview */
export function previewBulk(b: PlantBulkInput): PlantBulkResult {
  return { ...compute(b).result, applied: false };
}

/** POST /api/plant/bulk: applies what the preview shows; entries skipped or refused stay as they are. */
export function applyBulk(b: PlantBulkInput): PlantBulkResult {
  return db().tx(() => {
    const { result, apply } = compute(b);
    const done = result.items.filter((i) => i.outcome === 'changed' || i.outcome === 'removed');
    if (!done.length) return { ...result, applied: false };
    apply();
    const list = done.map((i) => ({ scope: i.scope || undefined, id: i.id, name: i.name, fields: i.fields, with: i.with }));
    const verb = b.action === 'remove' ? 'removed' : 'changed';
    audit({
      action: b.action === 'remove' ? 'plant.bulk_removed' : 'plant.bulk_changed',
      entityType: 'plant',
      entityId: b.kind,
      summary: `${done.length} ${b.kind} entries ${verb} at once${b.action === 'edit' ? ` (${Object.keys(b.set).join(', ')})` : b.cascade ? ' with what belongs to them' : ''}; ${result.counts.skipped} skipped, ${result.counts.refused} refused`,
      details: {
        kind: b.kind,
        action: b.action,
        ...(b.action === 'edit' ? { set: b.set } : { cascade: b.cascade }),
        counts: result.counts,
        sha256: sha256(JSON.stringify(list)),
        entries: list.slice(0, 150),
        notDone: result.items
          .filter((i) => i.reason)
          .slice(0, 50)
          .map((i) => ({ id: i.id, code: i.reason!.code })),
      },
    });
    return { ...result, applied: true };
  });
}
