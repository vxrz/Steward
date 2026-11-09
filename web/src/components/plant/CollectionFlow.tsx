import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  List,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconArrowDown, IconArrowRight, IconArrowUp, IconDownload, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  COLLECTION_DESTINATION_KINDS,
  SINK_TRANSFORM_KINDS,
  type PlantCollectionFlow,
  type PlantCollectionSink,
  type PlantCollectionSources,
  type PlantCollectionView,
  type PlantSinkTransform,
  type PlantSourceDiff,
} from '@sm/shared';
import { apiUrl, get } from '../../api';
import { QueryState, useFieldErrors } from '../common';
import { fmtDate } from '../../format';

/**
 * A data collection's sinks and where its data goes (0.12, docs/PLANT.md "Sinks and transformations"): the flow
 * items → transformation steps → sinks → downstream, the editor of a sink, and the kept files of its imports with their
 * versions, download and comparison. Everything is documentation: Steward runs no step and no code.
 */

const base = (assetId: string) => `/plant/assets/${encodeURIComponent(assetId)}`;
const ITEM_KINDS = new Set(['system', 'platform', 'application']);

/** items → steps → sinks, with each sink's steps, its items' target names and what reads its data next. */
export function CollectionFlowView({
  assetId,
  collection,
  canManage,
  onSaveSinks,
}: {
  assetId: string;
  collection: PlantCollectionView;
  canManage: boolean;
  onSaveSinks: (sinks: PlantCollectionSink[]) => Promise<void>;
}) {
  const { t } = useTranslation(['plantDocs', 'common']);
  const q = useQuery({
    queryKey: ['plant', 'collections', assetId, collection.id, 'flow', collection.updatedAt],
    queryFn: () => get<PlantCollectionFlow>(`${base(assetId)}/collections/${encodeURIComponent(collection.id)}/flow`),
  });
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const f = q.data;
  if (!f) return <QueryState query={q} rows={3} />;
  const steps = f.sinks.reduce((n, s) => n + s.transforms.length, 0);
  const mapped = f.items.filter((i) => i.dataPoint).length;
  const remove = (i: number) => void onSaveSinks(collection.sinks.filter((_, k) => k !== i));
  const move = (i: number, by: -1 | 1) => {
    const list = [...collection.sinks];
    const [x] = list.splice(i, 1);
    list.splice(i + by, 0, x!);
    void onSaveSinks(list);
  };
  return (
    <Stack gap="md" data-testid="collection-flow">
      <Text size="xs" c="dimmed">
        {t('flow.help')}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs" data-testid="collection-flow-summary">
        <FlowBox title={t('flow.items', { count: f.items.length })} detail={t('flow.mapped', { count: mapped })} />
        <FlowBox title={t('flow.steps', { count: steps })} detail={t('flow.stepsHelp')} arrow />
        <FlowBox title={t('flow.sinks', { count: f.sinks.length })} detail={f.sinks.map((s) => s.name).join(', ') || '–'} arrow />
      </SimpleGrid>
      {f.sinks.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('flow.noSinks')}
        </Text>
      )}
      {f.sinks.map((s, i) => (
        <Paper key={s.id} withBorder p="sm" data-testid={`sink-${s.id}`}>
          <Stack gap="xs">
            <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
              <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                <Group gap={6} wrap="wrap">
                  <Title order={3} fz="h5">
                    {s.name}
                  </Title>
                  <Badge size="xs" variant="light" tt="none">
                    {t(`sinkKinds.${s.kind}`)}
                  </Badge>
                  {s.imported && (
                    <Badge size="xs" variant="outline" color="gray" tt="none">
                      {t('flow.imported')}
                    </Badge>
                  )}
                </Group>
                <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                  {s.targetRef ? (
                    s.targetRef.path ? (
                      <Anchor component={Link} to={s.targetRef.path} size="sm">
                        {s.targetRef.label}
                      </Anchor>
                    ) : (
                      s.targetRef.label || t('flow.hiddenTarget')
                    )
                  ) : (
                    s.ref || '–'
                  )}
                  {s.object && (
                    <Text span className="mono" size="xs">
                      {' '}
                      {s.object}
                    </Text>
                  )}
                </Text>
                {[
                  s.format && t('flow.format', { value: s.format }),
                  s.schedule && t('flow.schedule', { value: s.schedule }),
                  s.owner && t('flow.owner', { value: s.owner }),
                ]
                  .filter(Boolean)
                  .map((x) => (
                    <Text key={x as string} size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                      {x}
                    </Text>
                  ))}
                {s.description && (
                  <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                    {s.description}
                  </Text>
                )}
              </Stack>
              {canManage && (
                <Group gap={4} wrap="nowrap">
                  <ActionIcon variant="subtle" aria-label={t('flow.up', { name: s.name })} disabled={i === 0} onClick={() => move(i, -1)}>
                    <IconArrowUp size={14} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" aria-label={t('flow.down', { name: s.name })} disabled={i === f.sinks.length - 1} onClick={() => move(i, 1)}>
                    <IconArrowDown size={14} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" aria-label={t('flow.edit', { name: s.name })} onClick={() => setEditing(i)} data-testid={`sink-edit-${s.id}`}>
                    <IconPencil size={14} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="red" aria-label={t('flow.remove', { name: s.name })} onClick={() => remove(i)}>
                    <IconTrash size={14} />
                  </ActionIcon>
                </Group>
              )}
            </Group>
            {s.transforms.length > 0 && (
              <Stack gap={4}>
                <Text size="sm" fw={600}>
                  {t('flow.stepsTitle')}
                </Text>
                <List type="ordered" size="sm" spacing={4}>
                  {s.transforms.map((x, k) => (
                    <List.Item key={k}>
                      <Badge size="xs" variant="light" color="grape" tt="none" mr={6}>
                        {t(`transformKinds.${x.kind}`)}
                      </Badge>
                      {[x.field, x.window, x.function, x.description].filter(Boolean).join(' · ')}
                      {x.expression && (
                        <Code block mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 160, overflow: 'auto' }}>
                          {x.expression}
                        </Code>
                      )}
                    </List.Item>
                  ))}
                </List>
              </Stack>
            )}
            <div className="table-scroll" tabIndex={0} role="region" aria-label={t('flow.itemsOf', { name: s.name })}>
              <Table fz="xs" aria-label={t('flow.itemsOf', { name: s.name })}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('flow.item')}</Table.Th>
                    <Table.Th>{t('flow.target')}</Table.Th>
                    <Table.Th>{t('flow.itemTransform')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {f.items.map((it) => {
                    const m = it.sinks.find((x) => x.sink === s.id);
                    return (
                      <Table.Tr key={it.index}>
                        <Table.Td style={{ overflowWrap: 'anywhere' }}>
                          {it.dataPoint ? (
                            it.dataPoint.name
                          ) : (
                            <Text span c="dimmed" size="xs">
                              {t('flow.raw')}
                            </Text>
                          )}{' '}
                          <Text span c="dimmed" size="xs" className="mono">
                            {it.outputName || it.address}
                          </Text>
                        </Table.Td>
                        <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                          {m?.target || '–'}
                        </Table.Td>
                        <Table.Td style={{ overflowWrap: 'anywhere' }}>{m?.transform || '–'}</Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </div>
            <Downstream sink={s} />
          </Stack>
        </Paper>
      ))}
      {canManage && (
        <Group>
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')} data-testid="sink-add">
            {t('flow.add')}
          </Button>
        </Group>
      )}
      {editing !== null && (
        <SinkModal
          sink={editing === 'new' ? null : collection.sinks[editing]!}
          taken={collection.sinks.filter((_, k) => k !== editing).map((x) => x.id)}
          items={collection.items.map((x) => x.outputName || x.address).filter(Boolean)}
          onClose={() => setEditing(null)}
          onSave={async (s) => {
            await onSaveSinks(editing === 'new' ? [...collection.sinks, s] : collection.sinks.map((x, k) => (k === editing ? s : x)));
            setEditing(null);
          }}
        />
      )}
    </Stack>
  );
}

function FlowBox({ title, detail, arrow }: { title: string; detail: string; arrow?: boolean }) {
  return (
    <Paper withBorder p="xs">
      <Group gap={6} wrap="nowrap" align="flex-start">
        {arrow && <IconArrowRight size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />}
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text size="sm" fw={600}>
            {title}
          </Text>
          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
            {detail}
          </Text>
        </Stack>
      </Group>
    </Paper>
  );
}

function Downstream({ sink }: { sink: PlantCollectionFlow['sinks'][number] }) {
  const { t } = useTranslation('plantDocs');
  const d = sink.downstream;
  if (!d.paths.length && !d.dashboards.length && !d.hidden && !d.hiddenDashboards) return null;
  return (
    <Stack gap={2} data-testid={`sink-downstream-${sink.id}`}>
      <Text size="sm" fw={600}>
        {t('flow.next')}
      </Text>
      {d.paths.map((p) => (
        <Anchor key={`${p.assetId}/${p.pathId}`} component={Link} to={`/plant/assets/${encodeURIComponent(p.assetId)}/flow`} size="xs">
          {p.assetName} · {p.subject}
        </Anchor>
      ))}
      {d.dashboards.map((x) => (
        <Anchor key={x.id} component={Link} to={x.path} size="xs">
          {x.name}
        </Anchor>
      ))}
      {d.more > 0 && <Text size="xs">{t('flow.more', { count: d.more })}</Text>}
      {d.hidden + d.hiddenDashboards > 0 && (
        <Text size="xs" c="dimmed">
          {t('flow.hiddenNext', { count: d.hidden + d.hiddenDashboards })}
        </Text>
      )}
    </Stack>
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 80) || 'sink';

const emptyStep = (): PlantSinkTransform => ({ kind: 'rename', field: '', expression: '', window: '', function: '', description: '' });

/** A sink: its target, steps and item mapping (documentation only). */
function SinkModal({
  sink,
  taken,
  items,
  onClose,
  onSave,
}: {
  sink: PlantCollectionSink | null;
  taken: string[];
  items: string[];
  onClose: () => void;
  onSave: (s: PlantCollectionSink) => Promise<void>;
}) {
  const { t } = useTranslation(['plantDocs', 'common']);
  const [v, setV] = useState<PlantCollectionSink>(
    sink ?? {
      id: '',
      name: '',
      kind: 'other',
      ref: '',
      object: '',
      format: '',
      schedule: '',
      owner: '',
      description: '',
      transforms: [],
      mappings: [],
      imported: false,
    },
  );
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof PlantCollectionSink>(k: K, x: PlantCollectionSink[K]) => setV((o) => ({ ...o, [k]: x }));
  const errors = useFieldErrors({
    name: !v.name.trim() && t('common:validation.required'),
    ref: ITEM_KINDS.has(v.kind) && !v.ref.trim() && t('common:validation.required'),
  });
  const target = (item: string) => v.mappings.find((m) => m.item === item);
  const setMapping = (item: string, k: 'target' | 'transform', x: string) =>
    setV((o) => {
      const cur = o.mappings.find((m) => m.item === item) ?? { item, target: '', transform: '' };
      const next = { ...cur, [k]: x };
      const rest = o.mappings.filter((m) => m.item !== item);
      return { ...o, mappings: next.target || next.transform ? [...rest, next] : rest };
    });
  const submit = async () => {
    if (!errors.validate()) return;
    let id = v.id || slug(v.name);
    for (let n = 2; taken.includes(id); n++) id = `${slug(v.name)}-${n}`;
    setBusy(true);
    try {
      await onSave({ ...v, id, name: v.name.trim() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={sink ? t('flow.editTitle', { name: sink.name }) : t('flow.addTitle')} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('sink.name')}
            value={v.name}
            onChange={(e) => set('name', e.currentTarget.value)}
            required
            maxLength={200}
            error={errors.error('name')}
            data-autofocus
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <Select
              label={t('sink.kind')}
              data={COLLECTION_DESTINATION_KINDS.map((k) => ({ value: k, label: t(`sinkKinds.${k}`) }))}
              value={v.kind}
              onChange={(x) => x && set('kind', x as PlantCollectionSink['kind'])}
              allowDeselect={false}
            />
            <TextInput
              label={t('sink.ref')}
              description={ITEM_KINDS.has(v.kind) ? t('sink.refItemHelp') : v.kind === 'dataset' ? t('sink.refDatasetHelp') : t('sink.refTextHelp')}
              value={v.ref}
              onChange={(e) => set('ref', e.currentTarget.value)}
              maxLength={200}
              required={ITEM_KINDS.has(v.kind)}
              error={errors.error('ref')}
            />
          </SimpleGrid>
          <TextInput
            label={t('sink.object')}
            description={t('sink.objectHelp')}
            value={v.object}
            onChange={(e) => set('object', e.currentTarget.value)}
            maxLength={500}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput label={t('sink.format')} value={v.format} onChange={(e) => set('format', e.currentTarget.value)} maxLength={200} />
            <TextInput label={t('sink.owner')} value={v.owner} onChange={(e) => set('owner', e.currentTarget.value)} maxLength={200} />
          </SimpleGrid>
          <TextInput
            label={t('sink.schedule')}
            description={t('sink.scheduleHelp')}
            value={v.schedule}
            onChange={(e) => set('schedule', e.currentTarget.value)}
            maxLength={2000}
          />
          <Textarea
            label={t('sink.description')}
            value={v.description}
            onChange={(e) => set('description', e.currentTarget.value)}
            autosize
            minRows={2}
            maxLength={8000}
          />
          <Stack gap="xs">
            <Group justify="space-between">
              <Text size="sm" fw={600}>
                {t('flow.stepsTitle')}
              </Text>
              <Button
                size="compact-xs"
                variant="default"
                leftSection={<IconPlus size={12} />}
                onClick={() => set('transforms', [...v.transforms, emptyStep()])}
              >
                {t('sink.addStep')}
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              {t('sink.stepsHelp')}
            </Text>
            {v.transforms.map((x, k) => {
              const put = (patch: Partial<PlantSinkTransform>) =>
                set(
                  'transforms',
                  v.transforms.map((y, j) => (j === k ? { ...y, ...patch } : y)),
                );
              return (
                <Paper key={k} withBorder p="xs">
                  <Stack gap={6}>
                    <Group gap="xs" wrap="wrap" align="flex-end">
                      <Select
                        label={t('sink.stepKind', { n: k + 1 })}
                        data={SINK_TRANSFORM_KINDS.map((s) => ({ value: s, label: t(`transformKinds.${s}`) }))}
                        value={x.kind}
                        onChange={(s) => s && put({ kind: s as PlantSinkTransform['kind'] })}
                        allowDeselect={false}
                        w={180}
                      />
                      <TextInput
                        label={t('sink.field')}
                        value={x.field}
                        onChange={(e) => put({ field: e.currentTarget.value })}
                        maxLength={200}
                        style={{ flex: 1, minWidth: 120 }}
                      />
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={t('sink.removeStep', { n: k + 1 })}
                        onClick={() =>
                          set(
                            'transforms',
                            v.transforms.filter((_, j) => j !== k),
                          )
                        }
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Group>
                    <Textarea
                      label={t('sink.expression')}
                      description={t('sink.expressionHelp')}
                      value={x.expression}
                      onChange={(e) => put({ expression: e.currentTarget.value })}
                      autosize
                      minRows={1}
                      maxLength={8000}
                      styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                    />
                    {x.kind === 'aggregate' && (
                      <Group gap="xs" grow>
                        <TextInput label={t('sink.window')} value={x.window} onChange={(e) => put({ window: e.currentTarget.value })} maxLength={200} />
                        <TextInput label={t('sink.function')} value={x.function} onChange={(e) => put({ function: e.currentTarget.value })} maxLength={200} />
                      </Group>
                    )}
                    <TextInput
                      label={t('sink.stepDescription')}
                      value={x.description}
                      onChange={(e) => put({ description: e.currentTarget.value })}
                      maxLength={2000}
                    />
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
          {items.length > 0 && (
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                {t('sink.mapping')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('sink.mappingHelp')}
              </Text>
              <div className="table-scroll" tabIndex={0} role="region" aria-label={t('sink.mapping')}>
                <Table fz="xs" aria-label={t('sink.mapping')}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('flow.item')}</Table.Th>
                      <Table.Th>{t('flow.target')}</Table.Th>
                      <Table.Th>{t('flow.itemTransform')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {[...new Set(items)].slice(0, 500).map((item) => (
                      <Table.Tr key={item}>
                        <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                          {item}
                        </Table.Td>
                        <Table.Td>
                          <TextInput
                            size="xs"
                            aria-label={t('sink.targetOf', { item })}
                            value={target(item)?.target ?? ''}
                            onChange={(e) => setMapping(item, 'target', e.currentTarget.value)}
                            maxLength={500}
                          />
                        </Table.Td>
                        <Table.Td>
                          <TextInput
                            size="xs"
                            aria-label={t('sink.transformOf', { item })}
                            value={target(item)?.transform ?? ''}
                            onChange={(e) => setMapping(item, 'transform', e.currentTarget.value)}
                            maxLength={2000}
                          />
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            </Stack>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} data-testid="sink-save">
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ---------- the kept files of imports ----------

/** The versions of the collector's configuration that wrote this collection: download, and two compared. */
export function CollectionSourcesView({ assetId, collectionId }: { assetId: string; collectionId: string }) {
  const { t } = useTranslation(['plantDocs', 'common']);
  const q = useQuery({
    queryKey: ['plant', 'collection-sources', assetId, collectionId],
    queryFn: () => get<PlantCollectionSources>(`${base(assetId)}/collection-sources?collection=${encodeURIComponent(collectionId)}`),
  });
  const list = useMemo(() => q.data?.sources ?? [], [q.data]);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  // the two newest versions, compared by default
  useEffect(() => {
    if (list.length >= 2 && !from && !to) {
      setTo(list[0]!.id);
      setFrom(list[1]!.id);
    }
  }, [list, from, to]);
  const diff = useQuery({
    queryKey: ['plant', 'collection-sources', assetId, 'diff', from, to],
    queryFn: () => get<PlantSourceDiff>(`${base(assetId)}/collection-sources/diff?from=${encodeURIComponent(from!)}&to=${encodeURIComponent(to!)}`),
    enabled: !!from && !!to && from !== to,
  });
  if (!q.data) return <QueryState query={q} rows={2} />;
  const options = list.map((s) => ({ value: s.id, label: t('sources.versionLabel', { version: s.version, file: s.fileName, date: fmtDate(s.importedAt) }) }));
  return (
    <Stack gap="md" data-testid="collection-sources">
      <Text size="xs" c="dimmed">
        {t('sources.help')}
      </Text>
      {!list.length ? (
        <Text size="sm" c="dimmed">
          {t('sources.empty')}
        </Text>
      ) : (
        <Stack gap="xs" role="list" aria-label={t('sources.title')}>
          {list.map((s) => (
            <Paper key={s.id} withBorder p="xs" role="listitem" data-testid={`source-v${s.version}`}>
              <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
                <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                  <Group gap={6} wrap="wrap">
                    <Badge size="sm" variant="light" tt="none">
                      {t('sources.versionShort', { version: s.version })}
                    </Badge>
                    <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
                      {s.fileName}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {t('sources.importedBy', { date: fmtDate(s.importedAt), user: s.importedBy })}
                  </Text>
                  <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
                    {t('sources.sha', { sha: s.sha256.slice(0, 12) })}
                  </Text>
                  <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
                    {t('sources.removed')}:{' '}
                    {s.redactedPaths.length ? (
                      <>
                        {t('sources.removedCount', { count: s.redactedPaths.length })}
                        <Text span c="dimmed" className="mono" size="xs">
                          {' '}
                          ({s.redactedPaths.slice(0, 5).join(', ')}
                          {s.redactedPaths.length > 5 ? ' …' : ''})
                        </Text>
                      </>
                    ) : (
                      '–'
                    )}
                  </Text>
                </Stack>
                <Button
                  size="compact-xs"
                  variant="default"
                  component="a"
                  href={apiUrl(`${base(assetId)}/collection-sources/${encodeURIComponent(s.id)}/file`)}
                  download
                  leftSection={<IconDownload size={12} />}
                  aria-label={t('sources.downloadVersion', { version: s.version, file: s.fileName })}
                  data-testid={`source-download-${s.version}`}
                >
                  {t('sources.download')}
                </Button>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
      {list.length >= 2 && (
        <Stack gap="xs" data-testid="source-diff">
          <Title order={3} fz="h5">
            {t('sources.compare')}
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            <Select label={t('sources.from')} data={options} value={from} onChange={setFrom} allowDeselect={false} />
            <Select label={t('sources.to')} data={options} value={to} onChange={setTo} allowDeselect={false} />
          </SimpleGrid>
          {from === to ? (
            <Text size="sm" c="dimmed">
              {t('sources.same')}
            </Text>
          ) : diff.data ? (
            <DiffView diff={diff.data} />
          ) : (
            <QueryState query={diff} rows={2} />
          )}
        </Stack>
      )}
    </Stack>
  );
}

function DiffView({ diff }: { diff: PlantSourceDiff }) {
  const { t } = useTranslation('plantDocs');
  const color = { added: 'green', removed: 'red', changed: 'yellow' } as const;
  return (
    <Stack gap="xs">
      {diff.kind === 'structure' && (
        <>
          <Text size="sm">{diff.changes.length ? t('sources.changes', { count: diff.changes.length }) : t('sources.noChanges')}</Text>
          {diff.changes.length > 0 && (
            <div className="table-scroll" tabIndex={0} role="region" aria-label={t('sources.byPath')}>
              <Table fz="xs" aria-label={t('sources.byPath')} data-testid="source-diff-changes">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('sources.change')}</Table.Th>
                    <Table.Th>{t('sources.path')}</Table.Th>
                    <Table.Th>{t('sources.before')}</Table.Th>
                    <Table.Th>{t('sources.after')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {diff.changes.map((c) => (
                    <Table.Tr key={`${c.op}:${c.path}`}>
                      <Table.Td>
                        <Badge size="xs" variant="light" color={color[c.op]} tt="none">
                          {t(`sources.ops.${c.op}`)}
                        </Badge>
                      </Table.Td>
                      <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {c.path}
                      </Table.Td>
                      <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {c.before ?? '–'}
                      </Table.Td>
                      <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {c.after ?? '–'}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </>
      )}
      <Text size="sm" fw={600}>
        {t('sources.lines')}
      </Text>
      <pre
        className="code-wrap"
        style={{ margin: 0, maxHeight: 360, overflow: 'auto', fontSize: 12 }}
        tabIndex={0}
        aria-label={t('sources.lines')}
        data-testid="source-diff-lines"
      >
        {diff.lines.map((l, i) =>
          l.op === 'gap' ? (
            <div key={i} style={{ color: 'var(--mantine-color-dimmed)' }}>
              …
            </div>
          ) : (
            <div
              key={i}
              style={{
                background: l.op === 'added' ? 'var(--mantine-color-green-light)' : l.op === 'removed' ? 'var(--mantine-color-red-light)' : undefined,
              }}
            >
              <span aria-hidden>{l.op === 'added' ? '+ ' : l.op === 'removed' ? '- ' : '  '}</span>
              {l.op !== 'same' && <VisuallyHidden>{t(`sources.ops.${l.op}`)} </VisuallyHidden>}
              {l.text}
            </div>
          ),
        )}
      </pre>
      {diff.truncated && (
        <Text size="xs" c="dimmed">
          {t('sources.truncated')}
        </Text>
      )}
    </Stack>
  );
}
