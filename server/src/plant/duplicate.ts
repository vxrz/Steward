import { PLANT_ID_RE, type PlantAssetDetail } from '@sm/shared';
import { db } from '../db.js';
import type { Duplicator } from '../duplicate/common.js';
import { assetInput, createAsset, getAsset, visibleAsset } from './service.js';

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
    return {
      id: made.id,
      name: made.name,
      key: made.id,
      details: { siteId: a.siteId, externalRefs: 'not copied', image: 'not copied', links: 'not copied', children: 'not copied' },
    };
  },
  paths: (id) => ({ path: `/plant/assets/${encodeURIComponent(id)}`, editPath: `/plant/assets/${encodeURIComponent(id)}?edit=1` }),
};
