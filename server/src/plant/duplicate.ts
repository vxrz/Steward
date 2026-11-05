import { PLANT_ID_RE, type PlantAssetDetail, type PlantKpiDetail, type PlantProfileDetail } from '@sm/shared';
import { db } from '../db.js';
import { me } from '../auth/access.js';
import type { Duplicator } from '../duplicate/common.js';
import { nowIso } from '../util.js';
import { assetInput, createAsset, getAsset, visibleAsset } from './service.js';
import { canManageCatalogue } from './access.js';
import { createKpi, createProfile, getKpi, getProfile, kpiInput, profileInput } from './catalogue.js';
import { assignmentRowOf, assignmentValuesOf, upsertAssignment } from './data-model.js';

/**
 * Duplicating an asset (0.4.0 duplicate module): the same kind of machine in another place. The copy takes the
 * attributes, location, taxonomy, tags and own fields – not the external references (their ids are the original's),
 * the image, the links or the child equipment. Rights follow the site, so there are no access settings to copy.
 */
export const assetDuplicator: Duplicator<PlantAssetDetail> = {
  kind: 'asset',
  entityType: 'asset',
  label: 'Asset',
  accessApplies: false,
  view(id) {
    const a = getAsset(id);
    return { id: a.id, name: a.name, key: a.id, mayManage: a.canManage, data: a };
  },
  mayCreate: (src) => visibleAsset(src.id).perms.includes('manage'),
  nameTaken: () => false,
  keyTaken: (k) => !PLANT_ID_RE.test(k) || !!db().get('SELECT 1 FROM plant_assets WHERE id = ?', k),
  keyMax: 80,
  copy(src, input) {
    const a = src.data;
    const made = createAsset(
      assetInput.parse({
        id: input.key!,
        siteId: a.siteId,
        areaId: a.location.area?.id ?? null,
        workCenterId: a.location.workCenter?.id ?? null,
        workUnitId: a.location.workUnit?.id ?? null,
        buildingId: a.location.buildingId,
        name: input.name,
        manufacturer: a.manufacturer,
        model: a.model,
        status: a.status,
        parentId: a.parent?.visible ? a.parent.id : null,
        domain: a.domain,
        processArea: a.processArea,
        role: a.role,
        tags: a.tags,
        commissioned: a.commissioned,
        endOfSupport: a.endOfSupport,
        description: a.description,
        capabilities: a.capabilities,
        fields: a.fields,
      }),
    );
    // the same kind of machine has the same device profile (#219): the assignment without what belongs to the
    // original alone – its endpoints, publications and KPI instances
    const r = assignmentRowOf(a.id);
    if (r) {
      const x = assignmentValuesOf(r);
      upsertAssignment(
        made.id,
        { ...x, interfaces: x.interfaces.map((i) => ({ ...i, endpoint: '' })), publications: [], kpis: [] },
        { at: nowIso(), by: me().username },
      );
    }
    return {
      id: made.id,
      name: made.name,
      key: made.id,
      details: {
        siteId: a.siteId,
        externalRefs: 'not copied',
        image: 'not copied',
        links: 'not copied',
        children: 'not copied',
        ...(r ? { profile: r.profile_id, endpoints: 'not copied', publications: 'not copied', kpiInstances: 'not copied' } : {}),
      },
    };
  },
  paths: (id) => ({ path: `/plant/assets/${encodeURIComponent(id)}`, editPath: `/plant/assets/${encodeURIComponent(id)}?edit=1` }),
};

/** Duplicating a device profile (#219): the next firmware generation or a variant of a device, to adapt. */
export const profileDuplicator: Duplicator<PlantProfileDetail> = {
  kind: 'device-profile',
  entityType: 'device_profile',
  label: 'Device profile',
  accessApplies: false,
  view(id) {
    const p = getProfile(id);
    return { id: p.id, name: p.name, key: p.id, mayManage: p.canManage, data: p };
  },
  mayCreate: () => canManageCatalogue(),
  nameTaken: () => false,
  keyTaken: (k) => !PLANT_ID_RE.test(k) || !!db().get('SELECT 1 FROM plant_profiles WHERE id = ?', k),
  keyMax: 80,
  copy(src, input) {
    const p = src.data;
    const made = createProfile(
      profileInput.parse({
        id: input.key!,
        name: input.name,
        manufacturer: p.manufacturer,
        model: p.model,
        version: p.version,
        category: p.category,
        description: p.description,
        notes: p.notes,
        interfaces: p.interfaces,
      }),
    );
    return {
      id: made.id,
      name: made.name,
      key: made.id,
      details: { interfaces: made.interfaceCount, dataPoints: made.dataPointCount, assignments: 'not copied' },
    };
  },
  paths: (id) => ({ path: `/plant/profiles/${encodeURIComponent(id)}`, editPath: `/plant/profiles/${encodeURIComponent(id)}?edit=1` }),
};

/** Duplicating a KPI definition (#219): a new version (v2) or a variant for other inputs. */
export const kpiDuplicator: Duplicator<PlantKpiDetail> = {
  kind: 'kpi-definition',
  entityType: 'kpi_definition',
  label: 'KPI definition',
  accessApplies: false,
  view(id) {
    const k = getKpi(id);
    return { id: k.id, name: k.name, key: k.id, mayManage: k.canManage, data: k };
  },
  mayCreate: () => canManageCatalogue(),
  nameTaken: () => false,
  keyTaken: (k) => !PLANT_ID_RE.test(k) || !!db().get('SELECT 1 FROM plant_kpis WHERE id = ?', k),
  keyMax: 80,
  copy(src, input) {
    const k = src.data;
    const made = createKpi(
      kpiInput.parse({
        id: input.key!,
        name: input.name,
        names: {},
        category: k.category,
        type: k.type,
        description: k.description,
        formula: k.formula,
        unit: k.unit,
        rangeMin: k.rangeMin,
        rangeMax: k.rangeMax,
        trend: k.trend,
        timing: k.timing,
        audience: k.audience,
        methodology: k.methodology,
        strategy: k.strategy,
        implementation: k.implementation,
        dynamicColumns: k.dynamicColumns,
        inputs: k.inputs,
        parameters: k.parameters,
        columns: k.columns,
        computation: k.computation,
        notes: k.notes,
      }),
    );
    return { id: made.id, name: made.name, key: made.id, details: { translations: 'not copied', instances: 'not copied' } };
  },
  paths: (id) => ({ path: `/plant/kpis/${encodeURIComponent(id)}`, editPath: `/plant/kpis/${encodeURIComponent(id)}?edit=1` }),
};
