import { useMemo, useState } from 'react';
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  FileButton,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { IconAlertTriangle, IconArrowsMove, IconDatabaseImport, IconDownload, IconFileUpload, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  COLLECTION_FORMATS,
  COLLECTION_MODES,
  COLLECTOR_KINDS,
  PLANT_LIMITS,
  type CollectionFormat,
  type PlantAssetCollections,
  type PlantAssignmentView,
  type PlantCollectionImportResult,
  type PlantCollectionPoint,
  type PlantCollectionPreview,
  type PlantCollectionPreviewItem,
  type PlantCollectionView,
  type PlantCollector,
  type PlantItemDecision,
} from '@sm/shared';
import { ApiError, apiUrl, del, get, notifyError, post, put } from '../../api';
import { EmptyState, QueryState } from '../../components/common';
import { confirmDanger } from '../../components/confirm';
import { Breakable } from '../../components/plant/data';
import { ItemSelect } from '../../components/plant/network';
import { DescribedText, DescriptionModal } from '../../components/plant/describe';
import { CollectionFlowView, CollectionSourcesView } from '../../components/plant/CollectionFlow';
import { PlantDocumentsPanel } from '../../components/plant/DocumentsPanel';
import { draftSave } from '../../components/plant/changes/common';
import { MoveEntriesModal } from '../../components/plant/MoveEntries';
import { usePlantLabel } from '../../components/plant/common';

/**
 * The data collections of an asset (0.11.0, ADR 0019): what collectors read from it, mapped to its data points. The
 * list with the coverage, a collection's items (the data point first, the collector's name after it), its access
 * patterns – writing ones shown prominently – and the import of a collector's configuration with its preview.
 */

const COLLECTOR_LINK = { application: 'application', platform: 'platform', process: 'process' } as const;
const base = (assetId: string) => `/plant/assets/${encodeURIComponent(assetId)}/collections`;
const key = (assetId: string) => ['plant', 'collections', assetId];

function useCollectionText() {
  const { t, i18n } = useTranslation(['plantModel', 'plantNetwork', 'plantDocs', 'plant', 'common']);
  const nf = new Intl.NumberFormat(i18n.language);
  const how = (c: Pick<PlantCollectionView, 'mode' | 'intervalMs' | 'debounceMs'>) =>
    [
      t(`collections.modes.${c.mode}`),
      c.intervalMs ? t('collections.everyMs', { ms: nf.format(c.intervalMs) }) : '',
      c.debounceMs ? t('collections.debounceMs', { ms: nf.format(c.debounceMs) }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const collector = (c: { collector: PlantCollector; collectorRef?: PlantCollectionView['collectorRef'] }) =>
    `${t(`plantNetwork:collectorKinds.${c.collector.kind}`)} ${c.collectorRef?.label || c.collector.ref}`;
  return { t, how, collector };
}

/** The data point's conventional name first, the collector's name after it (muted). */
function PointName({ point, outputName, raw }: { point: PlantCollectionPoint | null; outputName: string; raw?: boolean }) {
  const { t } = useTranslation('plantModel');
  return (
    <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
      {point ? (
        <Text span fw={500}>
          {point.name}
        </Text>
      ) : (
        <Text span fw={500}>
          <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" aria-hidden style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
          {raw ? t('collections.raw') : t('collections.stale')}
        </Text>
      )}
      {outputName && (
        <Text span c="dimmed" size="xs">
          {' · '}
          {t('collections.as')} <span className="mono">{outputName}</span>
        </Text>
      )}
    </Text>
  );
}

export function AssetCollectionsView({ assetId }: { assetId: string }) {
  const { t, how, collector } = useCollectionText();
  const [search, setSearch] = useSearchParams();
  const q = useQuery({ queryKey: key(assetId), queryFn: () => get<PlantAssetCollections>(base(assetId)) });
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const v = q.data;
  if (!v) return <QueryState query={q} rows={3} />;
  const selected = search.get('collection');
  const open = (id: string | null) => {
    const next = new URLSearchParams(search);
    if (id) next.set('collection', id);
    else next.delete('collection');
    setSearch(next, { replace: true });
  };
  return (
    <Stack gap="md" data-testid="asset-collections">
      <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Title order={2} fz="h4">
            {t('collections.title')}
          </Title>
          <Text size="xs" c="dimmed">
            {t('collections.help')}
          </Text>
        </div>
        {(v.canManage || v.canPropose) && (
          <Group gap="xs">
            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="collections-new">
              {t('collections.new')}
            </Button>
            {/* a collector's files are imported by who manages the site (as operations of a change set: phase 2) */}
            {v.canManage && (
              <Button size="xs" leftSection={<IconDatabaseImport size={14} />} onClick={() => setImporting(true)} data-testid="collections-import">
                {t('collections.import.button')}
              </Button>
            )}
          </Group>
        )}
      </Group>
      <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="xs" data-testid="collections-totals">
        {(['mapped', 'raw', 'notCollected'] as const).map((k) => (
          <Paper key={k} withBorder p="sm">
            <Text size="xl" fw={600}>
              {v.totals[k]}
            </Text>
            <Text size="xs" c="dimmed">
              {t(`collections.totals.${k}`)}
            </Text>
          </Paper>
        ))}
      </SimpleGrid>
      {v.collections.length === 0 ? (
        <EmptyState compact icon={IconDatabaseImport} title={t('collections.emptyTitle')} whoCanAct={v.canManage ? undefined : t('collections.whoCanAct')}>
          {t('collections.emptyText')}
        </EmptyState>
      ) : (
        <Stack gap="xs" role="list" aria-label={t('collections.title')}>
          {v.collections.map((c) => (
            <Paper key={c.id} withBorder p="sm" role="listitem" data-testid={`collection-${c.id}`}>
              <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="wrap">
                    <Anchor component="button" type="button" fw={600} size="sm" onClick={() => open(c.id)}>
                      {c.name}
                    </Anchor>
                    {c.writes && (
                      <Badge size="xs" color="red" variant="filled" leftSection={<IconAlertTriangle size={10} />} tt="none">
                        {t('collections.writes')}
                      </Badge>
                    )}
                  </Group>
                  <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                    {[
                      collector(c),
                      how(c),
                      c.sinks.length > 0 && t('collections.toIs', { to: c.sinks.map((x, i) => c.sinkRefs[i]?.label || x.name).join(', ') }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </Stack>
                <Group gap={4} wrap="wrap" justify="flex-end">
                  <Badge size="sm" variant="light" color="green" tt="none">
                    {t('collections.mappedCount', { count: c.coverage.mapped })}
                  </Badge>
                  {c.coverage.raw > 0 && (
                    <Badge size="sm" variant="light" color="orange" tt="none">
                      {t('collections.rawCount', { count: c.coverage.raw })}
                    </Badge>
                  )}
                </Group>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
      {selected && v.collections.some((c) => c.id === selected) && <CollectionDetail assetId={assetId} id={selected} data={v} onClose={() => open(null)} />}
      {importing && <ImportModal assetId={assetId} data={v} onClose={() => setImporting(false)} />}
      {creating && <NewCollectionModal assetId={assetId} data={v} onClose={() => setCreating(false)} onCreated={(id) => open(id)} />}
    </Stack>
  );
}

/** A collection entered by hand: its name, collector, interface and how it reads; items are mapped afterwards. */
function NewCollectionModal({
  assetId,
  data,
  onClose,
  onCreated,
}: {
  assetId: string;
  data: PlantAssetCollections;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation(['plantModel', 'plantNetwork', 'common']);
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [collector, setCollector] = useState<PlantCollector>({ kind: 'job', ref: '', host: null });
  const [iface, setIface] = useState<string | null>(null);
  const [mode, setMode] = useState<(typeof COLLECTION_MODES)[number]>('interval');
  const [intervalMs, setIntervalMs] = useState<number | ''>('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const id =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+|-+$/g, '')
      .slice(0, 80) || 'collection';
  const taken = data.collections.some((c) => c.id === id);
  const submit = async () => {
    setBusy(true);
    try {
      // 0.13.0: who may only propose adds it to their draft
      await draftSave(data.canManage, () =>
        post(base(assetId), {
          id,
          name: name.trim(),
          collector: { ...collector, ref: collector.ref.trim() },
          interfaceId: iface,
          mode,
          intervalMs: intervalMs === '' ? null : intervalMs,
          description: description.trim(),
        }),
      );
      void qc.invalidateQueries({ queryKey: key(assetId) });
      onCreated(id);
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('collections.newTitle')}>
      <Stack gap="sm">
        <TextInput
          label={t('collections.name')}
          required
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          error={taken ? t('collections.nameTaken') : undefined}
          data-autofocus
        />
        <Select
          label={t('plantNetwork:path.collectorKind')}
          data={COLLECTOR_KINDS.map((x) => ({ value: x, label: t(`plantNetwork:collectorKinds.${x}`) }))}
          value={collector.kind}
          onChange={(x) => x && setCollector({ kind: x as PlantCollector['kind'], ref: '', host: null })}
          allowDeselect={false}
        />
        {collector.kind === 'job' ? (
          <TextInput
            label={t('plantNetwork:path.jobName')}
            required
            value={collector.ref}
            onChange={(e) => setCollector({ ...collector, ref: e.currentTarget.value })}
          />
        ) : (
          <ItemSelect
            kind={COLLECTOR_LINK[collector.kind]}
            label={t(`plantNetwork:collectorKinds.${collector.kind}`)}
            value={collector.ref || null}
            onChange={(x) => setCollector({ ...collector, ref: x ?? '' })}
            required
          />
        )}
        <Select
          label={t('collections.interface')}
          data={data.interfaces.map((i) => ({ value: i.id, label: i.name || i.id }))}
          value={iface}
          onChange={setIface}
          clearable
          placeholder={t('collections.unknownInterface')}
        />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label={t('collections.mode')}
            data={COLLECTION_MODES.map((m) => ({ value: m, label: t(`collections.modes.${m}`) }))}
            value={mode}
            onChange={(x) => x && setMode(x as typeof mode)}
            allowDeselect={false}
          />
          <NumberInput
            label={t('collections.intervalMs')}
            min={0}
            allowDecimal={false}
            value={intervalMs}
            onChange={(x) => setIntervalMs(typeof x === 'number' ? x : '')}
          />
        </SimpleGrid>
        <Textarea
          label={t('describe.label')}
          description={t('describe.plainText')}
          autosize
          minRows={2}
          maxRows={6}
          maxLength={PLANT_LIMITS.description}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button loading={busy} disabled={!name.trim() || !collector.ref.trim() || taken} onClick={() => void submit()}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------- one collection ----------

function CollectionDetail({ assetId, id, data, onClose }: { assetId: string; id: string; data: PlantAssetCollections; onClose: () => void }) {
  const { t, how, collector } = useCollectionText();
  const plantLabel = usePlantLabel();
  const qc = useQueryClient();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const q = useQuery({ queryKey: [...key(assetId), id], queryFn: () => get<PlantCollectionView>(`${base(assetId)}/${encodeURIComponent(id)}`) });
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  // the collection's description (-1) or an item's (its index)
  const [describing, setDescribing] = useState<number | null>(null);
  const [tab, setTab] = useState('items');
  // 0.16: the collection to another asset (its collector was reassigned)
  const [moving, setMoving] = useState(false);
  // 0.13.0: who may only propose edits here too – what they save goes into their draft
  const canEdit = data.canManage || !!data.canPropose;
  const c = q.data;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key(assetId) });
    void qc.invalidateQueries({ queryKey: ['plant', 'assignment'] });
  };
  if (!c)
    return (
      <Modal opened onClose={onClose} title={t('collections.detailTitle')} size="xl">
        <QueryState query={q} rows={4} />
      </Modal>
    );
  const save = async (items: PlantCollectionView['items'], description = c.description, sinks: PlantCollectionView['sinks'] = c.sinks) => {
    const {
      id: _i,
      assetId: _a,
      assetName: _n,
      siteId: _s,
      collectorRef: _c,
      collectorHost: _h,
      destinationRef: _d,
      sinkRefs: _r,
      points: _p,
      coverage: _v,
      writes: _w,
      importId: _m,
      notInSource: _x,
      updatedAt: _u,
      updatedBy: _b,
      ...body
    } = c;
    // the sinks are what is stored (0.12); the destination is their first one
    // 0.13.0: who may only propose saves into their draft
    await draftSave(data.canManage, () => put(`${base(assetId)}/${encodeURIComponent(id)}`, { ...body, destination: null, sinks, items, description }));
    refresh();
    void qc.invalidateQueries({ queryKey: [...key(assetId), id] });
  };
  const saveSinks = async (sinks: PlantCollectionView['sinks']) => {
    try {
      await save(c.items, c.description, sinks);
    } catch (e) {
      notifyError(e);
    }
  };
  const remove = async () => {
    if (!(await confirmDanger({ action: 'remove', message: t('collections.removeConfirm', { name: c.name }) }))) return;
    const url = `${base(assetId)}/${encodeURIComponent(id)}`;
    try {
      try {
        await draftSave(data.canManage, () => del(url));
      } catch (e) {
        // documents link to it (0.12): removed only with "also remove what belongs to it"
        if (!(e instanceof ApiError) || e.code !== 'PLANT_COLLECTION_LINKED') throw e;
        if (!(await confirmDanger({ action: 'remove', message: t('plantDocs:removeLinked', { name: c.name, count: Number(e.params?.count ?? 0) }) }))) return;
        await draftSave(data.canManage, () => del(`${url}?cascade=1`));
      }
      refresh();
      onClose();
    } catch (e) {
      notifyError(e);
    }
  };
  const dup = new Map(c.coverage.duplicates.flatMap((d) => d.items.map((i) => [i, d.items.filter((x) => x !== i)])));
  const unknown = new Set(c.coverage.unknown);
  const options = data.points.map((p) => ({ value: p.id, label: `${p.name} (${p.id})` }));
  const access = (['write', 'create', 'delete'] as const).filter((k) => c.access[k].length);
  return (
    <Modal opened onClose={onClose} title={c.name} size="xl" data-testid="collection-detail">
      {/* what the collection is: above the tabs, it holds for all of them */}
      <Stack gap="xs" mb="sm">
        <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
          {[collector(c), how(c)].join(' · ')}
        </Text>
        <DescribedText
          text={c.description}
          inheritedFrom={null}
          changedHere={false}
          editable={canEdit}
          onEdit={() => setDescribing(-1)}
          testId="collection-description"
        />
      </Stack>
      <Tabs value={tab} onChange={(x) => setTab(x ?? 'items')} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="items">{t('collections.items')}</Tabs.Tab>
          <Tabs.Tab value="flow" data-testid="collection-tab-flow">
            {t('plantDocs:tabs.flow')}
          </Tabs.Tab>
          <Tabs.Tab value="sources" data-testid="collection-tab-sources">
            {t('plantDocs:tabs.sources')}
          </Tabs.Tab>
          <Tabs.Tab value="documents" data-testid="collection-tab-documents">
            {t('plantDocs:tabs.documents')}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="flow">
          <CollectionFlowView assetId={assetId} collection={c} canManage={canEdit} onSaveSinks={saveSinks} />
        </Tabs.Panel>
        <Tabs.Panel value="sources">
          <CollectionSourcesView assetId={assetId} collectionId={c.id} />
        </Tabs.Panel>
        <Tabs.Panel value="documents">
          <PlantDocumentsPanel kind="data-collection" id={`${assetId}/${c.id}`} />
        </Tabs.Panel>
        <Tabs.Panel value="items">
          <Stack gap="md">
            {c.sinks.map((x, i) => (
              <Text key={x.id} size="sm" style={{ overflowWrap: 'anywhere' }}>
                {t('collections.destination')}:{' '}
                {c.sinkRefs[i]?.path ? (
                  <Anchor component={Link} to={c.sinkRefs[i]!.path!} size="sm">
                    {c.sinkRefs[i]!.label}
                  </Anchor>
                ) : (
                  c.sinkRefs[i]?.label || x.ref || x.name
                )}
                {x.object && (
                  <Text span className="mono" size="xs">
                    {' '}
                    {x.object}
                  </Text>
                )}
              </Text>
            ))}
            {access.length > 0 && (
              <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title={t('collections.writesTitle')} data-testid="collection-writes">
                <Stack gap={4}>
                  <Text size="sm">{t('collections.writesText')}</Text>
                  {access.map((k) => (
                    <Text key={k} size="sm" style={{ overflowWrap: 'anywhere' }}>
                      <Text span fw={600}>
                        {t(`collections.access.${k}`)}:
                      </Text>{' '}
                      <span className="mono">{c.access[k].join(', ')}</span>
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}
            {c.access.read.length > 0 && (
              <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                {t('collections.access.read')}: <span className="mono">{c.access.read.join(', ')}</span>
              </Text>
            )}
            {c.triggers.length > 0 && (
              <Stack gap={2}>
                <Text size="sm" fw={600}>
                  {t('collections.triggers')}
                </Text>
                {c.triggers.map((x, i) => (
                  <Text key={i} size="xs" style={{ overflowWrap: 'anywhere' }}>
                    {[x.name, x.condition, x.referencePoint && `${x.referencePoint}${x.referenceValue ? ` = ${x.referenceValue}` : ''}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                ))}
                {c.composition && (
                  <Text size="xs" c="dimmed">
                    {t('collections.composition', { text: c.composition })}
                  </Text>
                )}
              </Stack>
            )}
            <Group gap="xs" wrap="wrap">
              <Badge variant="light" color="green" tt="none">
                {t('collections.mappedCount', { count: c.coverage.mapped })}
              </Badge>
              <Badge variant="light" color="orange" tt="none">
                {t('collections.rawCount', { count: c.coverage.raw })}
              </Badge>
              <Badge variant="light" color="gray" tt="none">
                {t('collections.notCollectedCount', { count: c.coverage.notCollected.length })}
              </Badge>
              {c.coverage.duplicates.length > 0 && (
                <Badge variant="light" color="yellow" tt="none">
                  {t('collections.duplicatesCount', { count: c.coverage.duplicates.length })}
                </Badge>
              )}
            </Group>
            <Stack gap={4} role="list" aria-label={t('collections.items')} data-testid="collection-items">
              {c.items.map((it, i) => (
                <Paper key={i} withBorder p="xs" role="listitem">
                  <Group justify="space-between" wrap={narrow ? 'wrap' : 'nowrap'} gap="xs" align="flex-start">
                    <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                      <PointName point={c.points[i] ?? null} outputName={it.outputName} raw={!it.dataPoint} />
                      <Text size="xs" className="mono code-wrap">
                        <Breakable text={it.address || '–'} />
                      </Text>
                      {(it.outputType || it.transform.note) && (
                        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                          {[it.outputType, it.transform.note].filter(Boolean).join(' · ')}
                        </Text>
                      )}
                      {it.description && (
                        <Text size="xs" style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }} data-testid={`item-description-${i}`}>
                          {it.description}
                        </Text>
                      )}
                      {dup.has(i) && (
                        <Text size="xs" fw={500}>
                          {t('collections.duplicate', {
                            items: dup
                              .get(i)!
                              .map((x) => x + 1)
                              .join(', '),
                          })}
                        </Text>
                      )}
                      {unknown.has(i) && (
                        <Text size="xs" fw={500}>
                          {t('collections.unknownAddress')}
                        </Text>
                      )}
                    </Stack>
                    {canEdit && (
                      <Group gap={4} wrap="nowrap">
                        <Button size="compact-xs" variant="subtle" leftSection={<IconPencil size={12} />} onClick={() => setEditing(i)}>
                          {t('collections.map')}
                        </Button>
                        <Button size="compact-xs" variant="subtle" onClick={() => setDescribing(i)} data-testid={`describe-item-${i}`}>
                          {t('collections.describe')}
                        </Button>
                        {/* the data point goes into the asset's model first: for who manages the site */}
                        {!it.dataPoint && data.canManage && (
                          <Button size="compact-xs" variant="subtle" onClick={() => setAdding(i)} data-testid={`add-point-${i}`}>
                            {t('collections.addPoint')}
                          </Button>
                        )}
                      </Group>
                    )}
                  </Group>
                </Paper>
              ))}
            </Stack>
            {c.coverage.notCollected.length > 0 && (
              <Stack gap={2} data-testid="collection-not-collected">
                <Text size="sm" fw={600}>
                  {t('collections.notCollected')}
                </Text>
                <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
                  {c.coverage.notCollected.map((p) => p.name).join(', ')}
                </Text>
              </Stack>
            )}
            {c.settings.length > 0 && (
              <div className="table-scroll" tabIndex={0} role="region" aria-label={t('collections.settings')}>
                <Table fz="xs" aria-label={t('collections.settings')}>
                  <Table.Tbody>
                    {c.settings.map((x) => (
                      <Table.Tr key={x.key}>
                        <Table.Td className="mono">{x.key}</Table.Td>
                        <Table.Td style={{ overflowWrap: 'anywhere' }}>{x.value}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            )}
            <Group justify="space-between" wrap="wrap" gap="xs">
              <Group gap="xs">
                {(['csv', 'yaml'] as const).map((f) => (
                  <Button
                    key={f}
                    size="xs"
                    variant="default"
                    component="a"
                    href={apiUrl(`${base(assetId)}/${encodeURIComponent(id)}/mapping?format=${f}`)}
                    download
                    leftSection={<IconDownload size={14} />}
                  >
                    {t(`collections.mappingFile.${f}`)}
                  </Button>
                ))}
              </Group>
              {canEdit && (
                <Button size="xs" variant="default" leftSection={<IconArrowsMove size={14} />} onClick={() => setMoving(true)} data-testid="collection-move">
                  {t('plant:moveEntries.menu', { type: plantLabel('asset', false, true) })}
                </Button>
              )}
              {canEdit && (
                <Button size="xs" color="red" variant="subtle" leftSection={<IconTrash size={14} />} onClick={() => void remove()}>
                  {t('collections.remove')}
                </Button>
              )}
            </Group>
            {c.sourceFile && (
              <Text size="xs" c="dimmed">
                {t('collections.source', { format: c.format ? t(`collections.formats.${c.format}`) : '–', file: c.sourceFile })}
              </Text>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
      {moving && (
        <MoveEntriesModal
          kind="collection"
          items={[{ asset: assetId, id: c.id, name: c.name }]}
          siteId={data.asset.siteId}
          onClose={() => setMoving(false)}
          onDone={onClose}
        />
      )}
      {editing !== null && (
        <MapModal
          value={c.items[editing]!.dataPoint}
          options={options}
          onClose={() => setEditing(null)}
          onSave={(dataPoint) => save(c.items.map((x, i) => (i === editing ? { ...x, dataPoint } : x)))}
        />
      )}
      {describing !== null && (
        <DescriptionModal
          title={t('describe.itemTitle', { name: describing < 0 ? c.name : c.items[describing]!.outputName || c.items[describing]!.address })}
          value={describing < 0 ? c.description : c.items[describing]!.description}
          help={t('describe.plainText')}
          onClose={() => setDescribing(null)}
          onSave={(text) => (describing < 0 ? save(c.items, text) : save(c.items.map((x, i) => (i === describing ? { ...x, description: text } : x))))}
        />
      )}
      {adding !== null && (
        <AddPointModal
          assetId={assetId}
          data={data}
          address={c.items[adding]!.address}
          gatewayName={c.items[adding]!.outputName}
          interfaceId={c.interfaceId}
          onClose={() => setAdding(null)}
          onAdded={(dataPoint) => save(c.items.map((x, i) => (i === adding ? { ...x, dataPoint } : x)))}
        />
      )}
    </Modal>
  );
}

function MapModal({
  value,
  options,
  onClose,
  onSave,
}: {
  value: string | null;
  options: { value: string; label: string }[];
  onClose: () => void;
  onSave: (v: string | null) => Promise<void>;
}) {
  const { t } = useTranslation(['plantModel', 'common']);
  const [point, setPoint] = useState(value);
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened onClose={onClose} title={t('collections.mapTitle')}>
      <Stack gap="sm">
        <Select label={t('collections.dataPoint')} data={options} value={point} onChange={setPoint} searchable clearable data-autofocus />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            loading={busy}
            onClick={() => {
              setBusy(true);
              onSave(point).then(onClose, (e: unknown) => {
                notifyError(e);
                setBusy(false);
              });
            }}
          >
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** An unknown address as a data point of this asset (an addition); the gateway name becomes its known-as name. */
function AddPointModal({
  assetId,
  data,
  address,
  gatewayName,
  interfaceId,
  onClose,
  onAdded,
}: {
  assetId: string;
  data: PlantAssetCollections;
  address: string;
  gatewayName: string;
  interfaceId: string | null;
  onClose: () => void;
  onAdded: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation(['plantModel', 'common']);
  const [id, setId] = useState('');
  const [name, setName] = useState(gatewayName);
  const [iface, setIface] = useState<string | null>(interfaceId ?? data.interfaces[0]?.id ?? null);
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const taken = data.points.some((p) => p.id === id.trim());
  const error = !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/.test(id.trim()) ? t('collections.idHelp') : taken ? t('collections.idTaken') : undefined;
  const submit = async () => {
    const a = await get<PlantAssignmentView>(`/plant/assets/${encodeURIComponent(assetId)}/assignment`);
    const v = a.assignment;
    if (!v) throw new Error(t('collections.noAssignment'));
    await put(`/plant/assets/${encodeURIComponent(assetId)}/assignment`, {
      ...v,
      additions: {
        ...v.additions,
        dataPoints: [
          ...v.additions.dataPoints,
          {
            interface: iface,
            group,
            id: id.trim(),
            name: name.trim() || id.trim(),
            description: '',
            dataType: '',
            unit: '',
            address,
            access: 'read',
            updateRateMs: null,
            enumValues: [],
            aliases: gatewayName && gatewayName !== id.trim() ? [gatewayName] : [],
            notes: '',
            publications: [],
          },
        ],
      },
    });
    await onAdded(id.trim());
  };
  return (
    <Modal opened onClose={onClose} title={t('collections.addTitle')}>
      <Stack gap="sm">
        <Text size="sm">{t('collections.addHelp')}</Text>
        <Text size="xs" className="mono code-wrap">
          <Breakable text={address} />
        </Text>
        <TextInput
          label={t('collections.conventionalId')}
          description={t('collections.idHelp')}
          required
          value={id}
          onChange={(e) => setId(e.currentTarget.value)}
          error={id && error}
          data-autofocus
        />
        <TextInput label={t('collections.pointName')} value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Select
          label={t('collections.interface')}
          data={data.interfaces.map((i) => ({ value: i.id, label: i.name || i.id }))}
          value={iface}
          onChange={setIface}
          allowDeselect={false}
        />
        <TextInput label={t('collections.group')} value={group} onChange={(e) => setGroup(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            loading={busy}
            disabled={!!error || !iface}
            onClick={() => {
              setBusy(true);
              submit().then(onClose, (e: unknown) => {
                notifyError(e);
                setBusy(false);
              });
            }}
          >
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------- the import ----------

interface Choice {
  dataPoint: string | null;
  recordAddress: boolean;
  alias: 'none' | 'profile' | 'collector';
  add: { target: 'asset' | 'profile'; id: string } | null;
}

const exact = (it: PlantCollectionPreviewItem) => it.suggestion.accepted && it.suggestion.reason !== 'fuzzy' && it.suggestion.dataPoint !== null;

function ImportModal({ assetId, data, onClose }: { assetId: string; data: PlantAssetCollections; onClose: () => void }) {
  const { t } = useTranslation(['plantModel', 'plantNetwork', 'common']);
  const qc = useQueryClient();
  const [collector, setCollector] = useState<PlantCollector>({ kind: 'job', ref: '', host: null });
  const [format, setFormat] = useState<CollectionFormat | 'auto'>('auto');
  const [iface, setIface] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [mapping, setMapping] = useState<{ name: string; content: string } | null>(null);
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<PlantCollectionPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [threshold, setThreshold] = useState<number | ''>(0.7);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<PlantCollectionImportResult | null>(null);
  const read = (list: File[]) => Promise.all(list.map(async (f) => ({ name: f.name, content: await f.text() })));
  const body = () => ({
    collector: { ...collector, ref: collector.ref.trim() },
    format,
    files,
    mappingFile: mapping,
    interfaceId: iface,
    dataPathId: path,
    replace,
  });
  const k = (c: string, i: number) => `${c}\u0000${i}`;
  const run = async () => {
    setBusy(true);
    try {
      const p = await post<PlantCollectionPreview>(`${base(assetId)}/import/preview`, body());
      setPreview(p);
      setChoices(
        Object.fromEntries(
          p.collections.flatMap((c) =>
            c.items.map((it) => [
              k(c.id, it.index),
              { dataPoint: it.suggestion.accepted ? it.suggestion.dataPoint : null, recordAddress: false, alias: 'none', add: null } as Choice,
            ]),
          ),
        ),
      );
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const set = (c: string, i: number, x: Partial<Choice>) => setChoices((cur) => ({ ...cur, [k(c, i)]: { ...cur[k(c, i)]!, ...x } }));
  const all = useMemo(() => (preview?.collections ?? []).flatMap((c) => c.items.map((it) => ({ c: c.id, it }))), [preview]);
  const bulk = (pick: (it: PlantCollectionPreviewItem) => boolean) =>
    setChoices((cur) => {
      const next = { ...cur };
      for (const { c, it } of all)
        if (pick(it) && it.suggestion.dataPoint) next[k(c, it.index)] = { ...next[k(c, it.index)]!, dataPoint: it.suggestion.dataPoint };
      return next;
    });
  const decisions: PlantItemDecision[] = all.map(({ c, it }) => {
    const ch = choices[k(c, it.index)]!;
    return {
      collection: c,
      index: it.index,
      dataPoint: ch.add ? null : ch.dataPoint,
      ...(ch.recordAddress ? { recordAddress: true } : {}),
      ...(ch.alias !== 'none' ? { alias: ch.alias } : {}),
      ...(ch.add && ch.add.id.trim()
        ? {
            add: {
              target: ch.add.target,
              id: ch.add.id.trim(),
              name: it.outputName || ch.add.id.trim(),
              interface: iface ?? data.interfaces[0]?.id ?? '',
              group: '',
            },
          }
        : {}),
    };
  });
  const summary = {
    mapped: decisions.filter((d) => d.dataPoint || d.add).length,
    raw: decisions.filter((d) => !d.dataPoint && !d.add).length,
    addresses: decisions.filter((d) => d.recordAddress).length,
    aliases: decisions.filter((d) => d.alias).length,
    added: decisions.filter((d) => d.add).length,
  };
  const applyIt = async () => {
    setBusy(true);
    try {
      const r = await post<PlantCollectionImportResult>(`${base(assetId)}/import`, { ...body(), decisions });
      setDone(r);
      void qc.invalidateQueries({ queryKey: key(assetId) });
      void qc.invalidateQueries({ queryKey: ['plant'] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const pointOptions = (preview?.points ?? data.points).map((p) => ({ value: p.id, label: `${p.name} (${p.id})` }));
  const nameOfPoint = (id: string | null) => (preview?.points ?? data.points).find((p) => p.id === id)?.name ?? id ?? '';
  return (
    <Modal opened onClose={onClose} title={t('collections.import.title')} size="xl" data-testid="collections-import-dialog">
      {done ? (
        <Stack gap="sm" data-testid="collections-import-done">
          <Text size="sm">
            {t('collections.import.done', {
              added: done.collections.added,
              changed: done.collections.changed,
              removed: done.collections.removed,
              mapped: done.items.mapped,
              raw: done.items.raw,
            })}
          </Text>
          <Group justify="flex-end">
            <Button onClick={onClose}>{t('common:close')}</Button>
          </Group>
        </Stack>
      ) : !preview ? (
        <Stack gap="sm">
          <Text size="sm">{t('collections.import.help')}</Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('plantNetwork:path.collectorKind')}
              data={COLLECTOR_KINDS.map((x) => ({ value: x, label: t(`plantNetwork:collectorKinds.${x}`) }))}
              value={collector.kind}
              onChange={(x) => x && setCollector({ kind: x as PlantCollector['kind'], ref: '', host: null })}
              allowDeselect={false}
            />
            {collector.kind === 'job' ? (
              <TextInput
                label={t('plantNetwork:path.jobName')}
                required
                value={collector.ref}
                onChange={(e) => setCollector({ ...collector, ref: e.currentTarget.value })}
                data-testid="collector-ref"
              />
            ) : (
              <ItemSelect
                kind={COLLECTOR_LINK[collector.kind]}
                label={t(`plantNetwork:collectorKinds.${collector.kind}`)}
                value={collector.ref || null}
                onChange={(x) => setCollector({ ...collector, ref: x ?? '' })}
                required
              />
            )}
            <Select
              label={t('collections.import.format')}
              data={[
                { value: 'auto', label: t('collections.formats.auto') },
                ...COLLECTION_FORMATS.map((f) => ({ value: f, label: t(`collections.formats.${f}`) })),
              ]}
              value={format}
              onChange={(x) => x && setFormat(x as CollectionFormat | 'auto')}
              allowDeselect={false}
              data-testid="collections-format"
            />
            <Select
              label={t('collections.interface')}
              data={data.interfaces.map((i) => ({ value: i.id, label: i.name || i.id }))}
              value={iface}
              onChange={setIface}
              clearable
              placeholder={t('collections.unknownInterface')}
            />
            {data.dataPaths.length > 0 && (
              <Select
                label={t('collections.dataPath')}
                data={data.dataPaths.map((p) => ({ value: p.id, label: p.subject }))}
                value={path}
                onChange={setPath}
                clearable
              />
            )}
          </SimpleGrid>
          <Group gap="xs" wrap="wrap">
            <FileButton multiple onChange={(list) => void read(list).then(setFiles)} accept=".json,.yaml,.yml,.csv,.txt">
              {(props) => (
                <Button {...props} variant="default" size="xs" leftSection={<IconFileUpload size={14} />} data-testid="collections-files">
                  {t('collections.import.files')}
                </Button>
              )}
            </FileButton>
            <FileButton onChange={(f) => void (f ? read([f]).then((x) => setMapping(x[0]!)) : setMapping(null))} accept=".csv,.yaml,.yml,.txt">
              {(props) => (
                <Button {...props} variant="default" size="xs" leftSection={<IconFileUpload size={14} />}>
                  {t('collections.import.mappingFile')}
                </Button>
              )}
            </FileButton>
          </Group>
          {(files.length > 0 || mapping) && (
            <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {[...files.map((f) => f.name), ...(mapping ? [t('collections.import.mappingIs', { name: mapping.name })] : [])].join(', ')}
            </Text>
          )}
          <Checkbox label={t('collections.import.replace')} checked={replace} onChange={(e) => setReplace(e.currentTarget.checked)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button loading={busy} disabled={!files.length || !collector.ref.trim()} onClick={() => void run()} data-testid="collections-preview">
              {t('collections.import.preview')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm" data-testid="collections-preview-result">
          {preview.preview && (
            <Alert color="yellow" variant="light" title={t('collections.import.previewFormat')}>
              {t('collections.import.previewFormatText')}
            </Alert>
          )}
          {preview.problems.length > 0 && (
            <Alert color="red" variant="light" title={t('collections.import.problems', { count: preview.problems.length })}>
              <Stack gap={2}>
                {preview.problems.slice(0, 20).map((p, i) => (
                  <Text key={i} size="xs">
                    {p.file} · {p.path}: {p.message}
                  </Text>
                ))}
              </Stack>
            </Alert>
          )}
          <Group gap="xs" wrap="wrap" align="flex-end">
            <Button size="xs" variant="default" onClick={() => bulk(exact)} data-testid="accept-exact">
              {t('collections.import.acceptExact')}
            </Button>
            <NumberInput
              size="xs"
              w={110}
              label={t('collections.import.threshold')}
              min={0}
              max={1}
              step={0.05}
              decimalScale={2}
              value={threshold}
              onChange={(x) => setThreshold(typeof x === 'number' ? x : '')}
            />
            <Button size="xs" variant="default" onClick={() => bulk((it) => it.suggestion.confidence >= (threshold === '' ? 1 : threshold))}>
              {t('collections.import.acceptAbove')}
            </Button>
          </Group>
          <Accordion multiple defaultValue={preview.collections.slice(0, 1).map((c) => c.id)} variant="separated">
            {preview.collections.map((c) => (
              <Accordion.Item key={c.id} value={c.id}>
                <Accordion.Control>
                  <Group gap={6} wrap="wrap">
                    <Text size="sm" fw={600}>
                      {c.name}
                    </Text>
                    <Badge size="xs" variant="light" tt="none">
                      {t(`collections.import.actions.${c.action}`)}
                    </Badge>
                    <Text size="xs" c="dimmed">
                      {t('collections.itemsCount', { count: c.items.length })}
                    </Text>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap={6}>
                    {c.items.map((it) => {
                      const ch = choices[k(c.id, it.index)]!;
                      const point = (preview.points ?? []).find((p) => p.id === ch.dataPoint);
                      return (
                        <Paper key={it.index} withBorder p="xs" data-testid={`preview-item-${c.id}-${it.index}`}>
                          <Stack gap={4}>
                            <Group justify="space-between" wrap="wrap" gap="xs">
                              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                                <span className="mono">{it.outputName || '–'}</span>
                                <Text span size="xs" c="dimmed" className="mono">
                                  {' '}
                                  {it.address}
                                </Text>
                              </Text>
                              <Badge
                                size="xs"
                                variant="light"
                                color={it.suggestion.reason === 'fuzzy' ? 'yellow' : it.suggestion.reason === 'none' ? 'gray' : 'green'}
                                tt="none"
                              >
                                {t(`collections.reasons.${it.suggestion.reason}`)}
                                {it.suggestion.dataPoint ? ` · ${Math.round(it.suggestion.confidence * 100)} %` : ''}
                              </Badge>
                            </Group>
                            {it.suggestion.dataPoint && !ch.dataPoint && (
                              <Text size="xs" c="dimmed">
                                {t('collections.import.suggested', { name: nameOfPoint(it.suggestion.dataPoint) })}
                              </Text>
                            )}
                            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                              <Select
                                size="xs"
                                label={t('collections.dataPoint')}
                                data={pointOptions}
                                value={ch.add ? null : ch.dataPoint}
                                onChange={(x) => set(c.id, it.index, { dataPoint: x, add: null })}
                                searchable
                                clearable
                                disabled={!!ch.add}
                              />
                              <Select
                                size="xs"
                                label={t('collections.import.alias')}
                                data={[
                                  { value: 'none', label: t('collections.import.aliasNone') },
                                  ...(preview.canManageCatalogue || point?.added ? [{ value: 'profile', label: t('collections.import.aliasProfile') }] : []),
                                  { value: 'collector', label: t('collections.import.aliasCollector') },
                                ]}
                                value={ch.alias}
                                onChange={(x) => x && set(c.id, it.index, { alias: x as Choice['alias'] })}
                                allowDeselect={false}
                                disabled={!ch.dataPoint || !it.outputName}
                              />
                            </SimpleGrid>
                            {point && it.address && point.address !== it.address && (
                              <Checkbox
                                size="xs"
                                label={
                                  point.address ? t('collections.import.recordAddressOther', { address: point.address }) : t('collections.import.recordAddress')
                                }
                                checked={ch.recordAddress}
                                onChange={(e) => set(c.id, it.index, { recordAddress: e.currentTarget.checked })}
                              />
                            )}
                            {!ch.dataPoint && (
                              <Group gap="xs" wrap="wrap" align="flex-end">
                                <Checkbox
                                  size="xs"
                                  label={t('collections.import.addAsPoint')}
                                  checked={!!ch.add}
                                  onChange={(e) => set(c.id, it.index, { add: e.currentTarget.checked ? { target: 'asset', id: '' } : null })}
                                />
                                {ch.add && (
                                  <>
                                    <TextInput
                                      size="xs"
                                      label={t('collections.conventionalId')}
                                      value={ch.add.id}
                                      onChange={(e) => set(c.id, it.index, { add: { ...ch.add!, id: e.currentTarget.value } })}
                                    />
                                    <Select
                                      size="xs"
                                      label={t('collections.import.addTo')}
                                      data={[
                                        { value: 'asset', label: t('collections.import.addToAsset') },
                                        ...(preview.canManageCatalogue ? [{ value: 'profile', label: t('collections.import.addToProfile') }] : []),
                                      ]}
                                      value={ch.add.target}
                                      onChange={(x) => x && set(c.id, it.index, { add: { ...ch.add!, target: x as 'asset' | 'profile' } })}
                                      allowDeselect={false}
                                    />
                                  </>
                                )}
                              </Group>
                            )}
                          </Stack>
                        </Paper>
                      );
                    })}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
          <Text size="sm" data-testid="collections-summary">
            {t('collections.import.summary', summary)}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPreview(null)}>
              {t('collections.import.back')}
            </Button>
            <Button loading={busy} disabled={preview.problems.length > 0} onClick={() => void applyIt()} data-testid="collections-apply">
              {t('collections.import.apply')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
