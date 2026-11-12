import { useMemo, useState } from 'react';
import { Select, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { LEVEL_RECORD_TYPE, type PlantAssetDetail, type PlantLevel, type PlantNode, type PlantSiteDetail } from '@sm/shared';
import { notifyError, put } from '../../api';
import { cleanRefs, useNameOf, usePlantLabel } from './common';
import { cleanFieldValues, flatNodes, FormButtons, nodePath, useHierarchy } from './forms';
import { FormModal as GuardedModal } from '../FormModal';

/**
 * "Move to…" (0.12, docs/PLANT.md#move-to): a node to another parent of the level above it (a work center to another
 * area, a work unit to another work center), an asset to another place of its site. A dialog with one searchable
 * choice – reachable by keyboard, no drag and drop. Saved through the node's and the asset's own PUT routes; the server
 * checks the levels (and so that nothing moves below itself).
 */

const PARENT: Record<PlantLevel, PlantLevel | null> = { area: null, work_center: 'area', work_unit: 'work_center' };

/** Whether `id` is `node` or below it. */
const within = (node: PlantNode, id: string): boolean => node.id === id || node.children.some((c) => within(c, id));

function MoveModal({
  title,
  help,
  label,
  data,
  value,
  busy,
  onChange,
  onSubmit,
  onClose,
}: {
  title: string;
  help: string;
  label: string;
  data: { value: string; label: string }[];
  value: string | null;
  busy: boolean;
  onChange: (v: string | null) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('plant');
  return (
    <GuardedModal onClose={onClose} title={title} size="md">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        data-testid="move-dialog"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {help}
          </Text>
          <Select
            label={label}
            data={data}
            value={value}
            onChange={onChange}
            searchable
            required
            allowDeselect={false}
            nothingFoundMessage={t('move.nothingFound')}
            data-autofocus
            comboboxProps={{ withinPortal: true }}
            data-testid="move-target"
          />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </GuardedModal>
  );
}

/** Move a work center or a work unit below another parent of its site. */
export function MoveNodeModal({
  site,
  node,
  onClose,
  onSaved,
}: {
  site: PlantSiteDetail;
  node: PlantNode;
  onClose: () => void;
  onSaved: (s: PlantSiteDetail) => void;
}) {
  const { t } = useTranslation('plant');
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const want = PARENT[node.level];
  const all = useMemo(() => flatNodes(site.areas), [site]);
  // the level above it; never itself or what is below it (the levels already rule that out)
  const data = all.filter((n) => n.level === want && !within(node, n.id)).map((n) => ({ value: n.id, label: nodePath(all, n, nameOf) }));
  const [target, setTarget] = useState<string | null>(node.parentId);
  const [busy, setBusy] = useState(false);
  const type = label(LEVEL_RECORD_TYPE[node.level], false, true);
  const submit = async () => {
    if (!target || target === node.parentId) return onClose();
    setBusy(true);
    try {
      onSaved(
        await put<PlantSiteDetail>(`/plant/sites/${encodeURIComponent(site.id)}/nodes/${encodeURIComponent(node.id)}`, {
          parentId: target,
          name: node.name,
          names: node.names,
          type: node.type,
          domain: node.domain,
          buildingId: node.buildingId,
          description: node.description,
          fields: cleanFieldValues(node.fields),
          revision: node.revision,
        }),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  if (!want) return null;
  return (
    <MoveModal
      title={t('move.nodeTitle', { type, name: nameOf(node) })}
      help={t('move.nodeHelp', { type, parent: label(LEVEL_RECORD_TYPE[want], false, true) })}
      label={t('move.newParent', { type: label(LEVEL_RECORD_TYPE[want]) })}
      data={data}
      value={target}
      busy={busy}
      onChange={setTarget}
      onSubmit={() => void submit()}
      onClose={onClose}
    />
  );
}

const SITE_ONLY = '__site__';

/** The body of PUT /plant/assets/:id: the asset as it is, at another place of its site. */
export function assetAt(a: PlantAssetDetail, node: PlantNode | null) {
  return {
    siteId: a.siteId,
    areaId: node?.level === 'area' ? node.id : null,
    workCenterId: node?.level === 'work_center' ? node.id : null,
    workUnitId: node?.level === 'work_unit' ? node.id : null,
    buildingId: a.location.buildingId,
    name: a.name,
    manufacturer: a.manufacturer,
    model: a.model,
    status: a.status,
    parentId: a.parentId,
    domain: a.domain,
    processArea: a.processArea,
    role: a.role,
    tags: a.tags,
    commissioned: a.commissioned,
    endOfSupport: a.endOfSupport,
    description: a.description,
    capabilities: a.capabilities,
    imageName: a.imageName,
    refs: cleanRefs(a.refs),
    fields: cleanFieldValues(a.fields),
    // 0.13.0: the revision it loaded (409 PLANT_ENTRY_CHANGED when someone else changed it since)
    revision: a.revision,
  };
}

/** Move an asset to another place (area, work center, work unit) of its site, or to the site itself. */
export function MoveAssetModal({ asset, onClose, onSaved }: { asset: PlantAssetDetail; onClose: () => void; onSaved: (a: PlantAssetDetail) => void }) {
  const { t } = useTranslation('plant');
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const tree = useHierarchy();
  const site = tree.data?.find((s) => s.id === asset.siteId);
  const all = useMemo(() => flatNodes(site?.areas ?? []), [site]);
  const current = asset.location.workUnit?.id ?? asset.location.workCenter?.id ?? asset.location.area?.id ?? null;
  const [target, setTarget] = useState<string | null>(current ?? SITE_ONLY);
  const [busy, setBusy] = useState(false);
  const data = [
    { value: SITE_ONLY, label: t('move.siteOnly', { site: site ? nameOf(site) : asset.siteId }) },
    ...all.map((n) => ({ value: n.id, label: `${nodePath(all, n, nameOf)} (${label(LEVEL_RECORD_TYPE[n.level])})` })),
  ];
  const submit = async () => {
    const next = target === SITE_ONLY ? null : target;
    if (next === current) return onClose();
    setBusy(true);
    try {
      onSaved(await put<PlantAssetDetail>(`/plant/assets/${encodeURIComponent(asset.id)}`, assetAt(asset, all.find((n) => n.id === next) ?? null)));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <MoveModal
      title={t('move.assetTitle', { name: asset.name })}
      help={t('move.assetHelp', { type: label('asset', false, true) })}
      label={t('move.newPlace')}
      data={data}
      value={target}
      busy={busy}
      onChange={setTarget}
      onSubmit={() => void submit()}
      onClose={onClose}
    />
  );
}
