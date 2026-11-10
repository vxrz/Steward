import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, List, Menu, Modal, Paper, Radio, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { IconAlertTriangle, IconArrowsMove, IconCopy, IconGitPullRequest, IconShieldLock } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type {
  PlantAssetNetwork,
  PlantAssetSummary,
  PlantChangeSetDetail,
  PlantChangeSetSummary,
  PlantMoveCollections,
  PlantMoveInput,
  PlantMoveKind,
  PlantMovePreview,
  PlantMovedKind,
} from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { plantKeys } from '../../queryKeys';
import { useNameOf, usePlantConfig, usePlantLabel } from './common';
import { useChangeSetConfig, saveOrDraft } from './changes/common';
import { FieldDiffs } from './changes';
import { useHierarchy } from './forms';
import { useCountsText } from './ids';

/**
 * Moving devices and data collections to another asset, and duplicating a device (0.16, docs/PLANT.md "Moving devices
 * and data collections"). Keyboard first, no drag and drop (0.12): a dialog with a searchable choice of the target
 * asset – the assets of the same site, others on request –, a preview of everything that moves along (data paths,
 * collections) and of what changes field by field, a new id where the target has the id already, and Move (who manages
 * both) or Add to draft (who may propose). Where review is required, Move makes a proposed change set and leads to it.
 */

export interface MoveItem {
  asset: string;
  id: string;
  name: string;
}

/** The assets the entries may go to: of their site first, all the reader sees on request (grouped by site). */
function useTargets(siteId: string | null, exclude: string[], allSites: boolean) {
  const nameOf = useNameOf();
  const assets = useQuery({ queryKey: plantKeys.assets(''), queryFn: () => get<PlantAssetSummary[]>('/plant/assets') });
  const tree = useHierarchy();
  return useMemo(() => {
    const sites = new Map((tree.data ?? []).map((s) => [s.id, nameOf(s)]));
    const groups = new Map<string, { value: string; label: string }[]>();
    for (const a of assets.data ?? []) {
      if (exclude.includes(a.id) || (!allSites && siteId && a.siteId !== siteId)) continue;
      const g = sites.get(a.siteId) ?? a.siteId;
      groups.set(g, [...(groups.get(g) ?? []), { value: a.id, label: `${a.name} (${a.id})` }]);
    }
    return [...groups].map(([group, items]) => ({ group, items }));
  }, [assets.data, tree.data, exclude, allSites, siteId, nameOf]);
}

const KIND_KEY: Record<PlantMovedKind, 'device' | 'dataPath' | 'collection'> = { device: 'device', data_path: 'dataPath', collection: 'collection' };

/** Move one or several devices (with their data paths) or a data collection to another asset. */
export function MoveEntriesModal({
  kind,
  items,
  siteId,
  onClose,
  onDone,
}: {
  kind: PlantMoveKind;
  items: MoveItem[];
  /** The site of the entries: its assets are offered first */
  siteId: string | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation(['plant', 'plantChanges', 'common']);
  const label = usePlantLabel();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cfg = usePlantConfig();
  const cs = useChangeSetConfig();
  const countsText = useCountsText();
  const canApply = !!cfg.data?.canManageSome;
  const canDraft = !!cs?.canPropose;
  const [allSites, setAllSites] = useState(false);
  const [toAsset, setToAsset] = useState<string | null>(null);
  const [collections, setCollections] = useState<PlantMoveCollections>('leave');
  const [ids, setIds] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PlantMovePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const sources = useMemo(() => [...new Set(items.map((i) => i.asset))], [items]);
  const targets = useTargets(siteId, sources, allSites);
  const keyOf = (k: PlantMovedKind, asset: string, id: string) => `${k}\u0000${asset}\u0000${id}`;
  const body: PlantMoveInput | null = toAsset
    ? {
        kind,
        items: items.map((i) => ({ asset: i.asset, id: i.id })),
        toAsset,
        collections,
        ids: Object.entries(ids)
          .filter(([, v]) => v.trim())
          .map(([k, newId]) => {
            const [kk, asset, id] = k.split('\u0000') as [PlantMovedKind, string, string];
            return { kind: kk, asset, id, newId: newId.trim() };
          }),
      }
    : null;
  const text = JSON.stringify(body);
  // the preview follows every choice (debounced while a new id is typed)
  useEffect(() => {
    if (!body) return setPreview(null);
    let live = true;
    const h = setTimeout(() => {
      post<PlantMovePreview>('/plant/move/preview', body).then(
        (p) => live && setPreview(p),
        (e) => {
          if (live) {
            setPreview(null);
            notifyError(e);
          }
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(h);
    };
    // body is compared by its text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const done = () => {
    void qc.invalidateQueries({ queryKey: plantKeys.all });
    onDone?.();
    onClose();
  };
  const apply = async () => {
    if (!body || !preview) return;
    setBusy(true);
    try {
      const r = await post<PlantMovePreview & { changeSet?: PlantChangeSetSummary }>('/plant/move', { ...body, fingerprint: preview.fingerprint });
      if (r.changeSet) {
        notifyOk(t('plantChanges:form.proposedForReview', { title: r.changeSet.title }));
        done();
        navigate(`/plant/changes/${encodeURIComponent(r.changeSet.id)}`);
      } else {
        notifyOk(t('moveEntries.done', { count: r.entries.length, asset: r.toAsset.name }));
        done();
      }
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  const addToDraft = async () => {
    if (!body) return;
    setBusy(true);
    try {
      const d = await post<PlantChangeSetDetail>('/plant/change-sets/current/operations', { op: 'move', value: body });
      notifyOk(t('plantChanges:form.addedToDraft', { title: d.title }));
      void qc.invalidateQueries({ queryKey: plantKeys.config });
      void qc.invalidateQueries({ queryKey: ['plant', 'change-sets'] });
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  const title =
    kind === 'device'
      ? t('moveEntries.devicesTitle', { count: items.length, name: items[0]?.name ?? '' })
      : t('moveEntries.collectionTitle', { name: items[0]?.name ?? '' });
  const ok = !!preview?.ok;
  return (
    <Modal opened onClose={onClose} title={title} size="xl">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && canApply) void apply();
        }}
        data-testid="move-entries-dialog"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {kind === 'device'
              ? t('moveEntries.devicesHelp', { type: label('asset', false, true) })
              : t('moveEntries.collectionHelp', { type: label('asset', false, true) })}
          </Text>
          <Select
            label={t('moveEntries.target', { type: label('asset') })}
            data={targets}
            value={toAsset}
            onChange={(v) => {
              setToAsset(v);
              setIds({});
            }}
            searchable
            required
            nothingFoundMessage={t('move.nothingFound')}
            data-autofocus
            comboboxProps={{ withinPortal: true }}
            data-testid="move-entries-target"
          />
          <Checkbox
            size="sm"
            label={t('moveEntries.otherSites')}
            description={t('moveEntries.otherSitesHelp')}
            checked={allSites}
            onChange={(e) => setAllSites(e.currentTarget.checked)}
            data-testid="move-entries-all-sites"
          />
          {kind === 'device' && (
            <Radio.Group
              label={t('moveEntries.collections')}
              description={t('moveEntries.collectionsHelp')}
              value={collections}
              onChange={(v) => setCollections(v as PlantMoveCollections)}
            >
              <Stack gap={4} mt={4}>
                <Radio value="leave" label={t('moveEntries.collectionsLeave')} data-testid="move-collections-leave" />
                <Radio value="move" label={t('moveEntries.collectionsMove')} data-testid="move-collections-move" />
              </Stack>
            </Radio.Group>
          )}
          {preview && (
            <Stack gap="xs" data-testid="move-entries-preview" aria-live="polite">
              {preview.crossSite && (
                <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} p="xs">
                  <Text size="sm">{kind === 'device' ? t('moveEntries.crossSite') : t('moveEntries.crossSiteCollection')}</Text>
                </Alert>
              )}
              {preview.problems.length > 0 && (
                <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} p="xs" title={t('moveEntries.problems')}>
                  <List size="sm" spacing={2}>
                    {preview.problems.map((p) => (
                      <List.Item key={`${p.code}:${p.kind ?? ''}:${p.asset ?? ''}:${p.id ?? ''}`}>{p.message}</List.Item>
                    ))}
                  </List>
                </Alert>
              )}
              <div className="table-scroll" tabIndex={0} role="region" aria-label={t('moveEntries.what')}>
                <Table fz="sm" aria-label={t('moveEntries.what')} verticalSpacing={6}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('moveEntries.what')}</Table.Th>
                      <Table.Th>{t('moveEntries.newId')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {preview.entries.map((e) => {
                      const k = keyOf(e.kind, e.asset, e.id);
                      return (
                        <Table.Tr key={k} data-testid={`move-entry-${e.kind}-${e.id}`}>
                          <Table.Td>
                            <Group gap={6} wrap="wrap">
                              <Badge size="xs" variant="light" color={e.why === 'chosen' ? 'blue' : 'grape'}>
                                {t(`moveEntries.kinds.${KIND_KEY[e.kind]}`)}
                              </Badge>
                              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                                {e.name}
                              </Text>
                            </Group>
                            <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
                              {e.asset} / {e.id}
                            </Text>
                            {e.why === 'follows' && (
                              <Text size="xs" c="dimmed">
                                {t(e.kind === 'data_path' ? 'moveEntries.followsPath' : 'moveEntries.followsCollection')}
                              </Text>
                            )}
                            {e.leavesVlan && (
                              <Text size="xs" c="orange.8">
                                {t('moveEntries.leavesVlan', { vlan: e.leavesVlan })}
                              </Text>
                            )}
                            {e.leavesDataPath && (
                              <Text size="xs" c="orange.8">
                                {t('moveEntries.leavesDataPath', { path: e.leavesDataPath })}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td style={{ minWidth: 180 }}>
                            {e.taken || ids[k] !== undefined ? (
                              <TextInput
                                size="xs"
                                aria-label={t('moveEntries.newIdOf', { name: e.name })}
                                value={ids[k] ?? e.suggested ?? ''}
                                onChange={(ev) => {
                                  const v = ev.currentTarget.value;
                                  setIds((cur) => ({ ...cur, [k]: v }));
                                }}
                                error={e.taken ? t('moveEntries.taken') : undefined}
                                className="mono"
                                data-testid={`move-new-id-${e.id}`}
                              />
                            ) : (
                              <Text size="sm" className="mono">
                                {e.newId}
                              </Text>
                            )}
                            {e.taken && e.suggested && ids[k] === undefined && (
                              <Button
                                size="compact-xs"
                                variant="subtle"
                                mt={4}
                                onClick={() => setIds((cur) => ({ ...cur, [k]: e.suggested! }))}
                                data-testid={`move-use-suggested-${e.id}`}
                              >
                                {t('moveEntries.useSuggested', { id: e.suggested })}
                              </Button>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </div>
              {preview.unlinked.length > 0 && (
                <Paper withBorder p="xs" data-testid="move-entries-unlinked">
                  <Text size="sm" fw={500}>
                    {t('moveEntries.unlinked', { count: preview.unlinked.length })}
                  </Text>
                  <List size="sm" spacing={2}>
                    {preview.unlinked.map((c) => (
                      <List.Item key={`${c.asset}/${c.id}`}>{t('moveEntries.unlinkedItem', { name: c.name, path: c.dataPath })}</List.Item>
                    ))}
                  </List>
                </Paper>
              )}
              {preview.references.length > 0 && (
                <Text size="xs" c="dimmed">
                  {t('moveEntries.references', { list: countsText(preview.references) })}
                </Text>
              )}
              {preview.changes.length > 0 && (
                <Stack gap={4} data-testid="move-entries-changes">
                  <Text size="sm" fw={500}>
                    {t('moveEntries.fieldByField', { count: preview.changes.length })}
                  </Text>
                  {preview.changes.map((c) => (
                    <Paper key={`${c.kind}:${c.scope}:${c.id}`} withBorder p={6}>
                      <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {t(`plantChanges:actions.${c.action}`)} · {c.fromScope ? `${c.fromScope} / ${c.from ?? c.id} → ` : ''}
                        {c.scope} / {c.id}
                      </Text>
                      <FieldDiffs diff={c.diff} />
                    </Paper>
                  ))}
                </Stack>
              )}
              {preview.stepUp && ok && (
                <Alert color="blue" variant="light" icon={<IconShieldLock size={16} />} p="xs">
                  <Text size="sm">{t('moveEntries.stepUp')}</Text>
                </Alert>
              )}
            </Stack>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            {canDraft && (
              <Button
                variant={canApply ? 'default' : 'filled'}
                leftSection={<IconGitPullRequest size={14} aria-hidden />}
                onClick={() => void addToDraft()}
                disabled={!ok}
                loading={busy}
                data-testid="move-entries-draft"
              >
                {t('plantChanges:form.addToDraft')}
              </Button>
            )}
            {canApply && (
              <Button type="submit" disabled={!ok} loading={busy} data-testid="move-entries-apply">
                {t('moveEntries.apply')}
              </Button>
            )}
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * Duplicate a device on its asset or another: its fields, not what identifies the original (host name, address, MAC
 * address, serial number, port, outlet) or watches it (checks, monitoring). Saved like an added device – into the
 * person's draft for who may only propose.
 */
export function DuplicateDeviceModal({
  assetId,
  siteId,
  device,
  onClose,
  onSaved,
}: {
  assetId: string;
  siteId: string;
  device: { id: string; name: string };
  onClose: () => void;
  onSaved?: (n: PlantAssetNetwork) => void;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const qc = useQueryClient();
  const [allSites, setAllSites] = useState(false);
  const [toAsset, setToAsset] = useState<string>(assetId);
  const [id, setId] = useState(`${device.id.slice(0, 76)}-2`);
  const [busy, setBusy] = useState(false);
  const targets = useTargets(siteId, [], allSites);
  const target = useQuery({
    queryKey: plantKeys.assetNetwork(toAsset),
    queryFn: () => get<PlantAssetNetwork>(`/plant/assets/${encodeURIComponent(toAsset)}/network`),
  });
  const taken = !!target.data?.devices.some((d) => d.id === id.trim());
  const submit = async () => {
    if (!id.trim() || taken) return;
    setBusy(true);
    try {
      await saveOrDraft(
        !!target.data?.canManage,
        () =>
          post<PlantAssetNetwork>(`/plant/assets/${encodeURIComponent(assetId)}/devices/${encodeURIComponent(device.id)}/duplicate`, {
            toAsset,
            id: id.trim(),
          }),
        (n) => {
          qc.setQueryData(plantKeys.assetNetwork(n.asset.id), n);
          onSaved?.(n);
          notifyOk(t('duplicateDevice.done', { id: id.trim() }));
        },
      );
      void qc.invalidateQueries({ queryKey: ['plant', 'network'] });
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('duplicateDevice.title', { name: device.name })} size="md">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        data-testid="duplicate-device-dialog"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('duplicateDevice.help')}
          </Text>
          <Select
            label={t('moveEntries.target', { type: label('asset') })}
            data={targets}
            value={toAsset}
            onChange={(v) => v && setToAsset(v)}
            searchable
            allowDeselect={false}
            nothingFoundMessage={t('move.nothingFound')}
            comboboxProps={{ withinPortal: true }}
            data-testid="duplicate-device-target"
          />
          <Checkbox size="sm" label={t('moveEntries.otherSites')} checked={allSites} onChange={(e) => setAllSites(e.currentTarget.checked)} />
          <TextInput
            label={t('duplicateDevice.id')}
            value={id}
            onChange={(e) => setId(e.currentTarget.value)}
            required
            data-autofocus
            className="mono"
            error={taken ? t('moveEntries.taken') : undefined}
            data-testid="duplicate-device-id"
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!id.trim() || taken} data-testid="duplicate-device-save">
              {t('duplicateDevice.save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** 0.16: a device's own menu items besides Edit and Remove – Move to asset… and Duplicate…. */
export function DeviceMenuItems({ onMove, onDuplicate }: { onMove: () => void; onDuplicate: () => void }) {
  const { t } = useTranslation('plant');
  return (
    <>
      <Menu.Item leftSection={<IconArrowsMove size={14} />} onClick={onMove} data-testid="device-move">
        {t('moveEntries.menu')}
      </Menu.Item>
      <Menu.Item leftSection={<IconCopy size={14} />} onClick={onDuplicate} data-testid="device-duplicate">
        {t('duplicateDevice.menu')}
      </Menu.Item>
    </>
  );
}
