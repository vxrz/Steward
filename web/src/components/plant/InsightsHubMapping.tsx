import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconActivityHeartbeat, IconAlertTriangle, IconCheck, IconDownload, IconPencil, IconPlus, IconSearch } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  PLANT_IH_VERIFIED,
  type PlantIhItemStatus,
  type PlantIhMapping,
  type PlantIhMappingItem,
  type PlantIhMonitorCoverage,
  type PlantIhTargetBrief,
  type PlantIhWatcher,
} from '@sm/shared';
import { apiUrl, get, notifyError, notifyOk, post, put } from '../../api';
import { QueryState } from '../common';
import { CollapsibleSection } from '../page/CollapsibleSection';
import { fmtDate } from '../../format';

/**
 * Insights Hub as a mapped sink (0.14, docs/PLANT.md "Insights Hub mapping"): per item the asset, aspect and variable
 * it goes to, the last check against the tenant, and per asset and aspect the monitor checks that already watch it –
 * monitors first: "Create monitor" only for what nobody watches, as a disabled draft. The hierarchy in Insights Hub
 * is not compared with the plant's.
 */

const sinkUrl = (assetId: string, collectionId: string, sinkId: string) =>
  `/plant/assets/${encodeURIComponent(assetId)}/collections/${encodeURIComponent(collectionId)}/sinks/${encodeURIComponent(sinkId)}/insights-hub`;

const STATUS_COLOR: Record<PlantIhItemStatus, string> = {
  ok: 'green',
  unit_differs: 'yellow',
  type_differs: 'yellow',
  asset_missing: 'red',
  aspect_missing: 'red',
  variable_missing: 'red',
  not_checked: 'gray',
  failed: 'orange',
};

export function IhStatusBadge({ status }: { status: PlantIhItemStatus | null }) {
  const { t } = useTranslation('plantDocs');
  if (!status)
    return (
      <Badge size="xs" variant="outline" color="gray" tt="none">
        {t('ih.status.none')}
      </Badge>
    );
  const ok = PLANT_IH_VERIFIED.includes(status);
  return (
    <Badge
      size="xs"
      variant="light"
      color={STATUS_COLOR[status]}
      tt="none"
      leftSection={ok ? <IconCheck size={10} aria-hidden /> : <IconAlertTriangle size={10} aria-hidden />}
    >
      {t(`ih.status.${status}`)}
    </Badge>
  );
}

const targetText = (t: { assetName: string; assetId: string; aspect: string; variable: string }) => `${t.assetName || t.assetId} / ${t.aspect} / ${t.variable}`;

/** The panel on an Insights Hub sink: counts, the last check, the items, the monitors per asset and aspect, the gaps. */
export function InsightsHubPanel({ assetId, collectionId, sinkId, stamp }: { assetId: string; collectionId: string; sinkId: string; stamp: string }) {
  const { t } = useTranslation(['plantDocs', 'common']);
  const qc = useQueryClient();
  const url = sinkUrl(assetId, collectionId, sinkId);
  const q = useQuery({ queryKey: ['plant', 'collections', assetId, collectionId, 'ih', sinkId, stamp], queryFn: () => get<PlantIhMapping>(url) });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'check' | 'monitor' | null>(null);
  const m = q.data;
  if (!m) return <QueryState query={q} rows={2} />;
  if (!m.isIh) return null;
  const refresh = (x?: PlantIhMapping) => {
    if (x) qc.setQueryData(['plant', 'collections', assetId, collectionId, 'ih', sinkId, stamp], x);
    void qc.invalidateQueries({ queryKey: ['plant', 'collections', assetId] });
  };
  const check = async () => {
    setBusy('check');
    try {
      refresh(await post<PlantIhMapping>(`${url}/check`));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const createMonitor = async () => {
    setBusy('monitor');
    try {
      const r = await post<{ monitor: { id: string; name: string }; mapping: PlantIhMapping }>(`${url}/monitor`, {});
      refresh(r.mapping);
      notifyOk(t('ih.created', { name: r.monitor.name }));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const run = m.lastRun;
  const unwatched = m.groups.reduce((n, g) => n + g.unwatched.length, 0);
  const gaps = m.counts.gaps;
  const itemLabel = (i: number) => {
    const it = m.items[i];
    return it ? it.dataPoint?.name || it.item : String(i);
  };
  return (
    <Paper withBorder p="sm" data-testid={`ih-${sinkId}`}>
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
            <Title order={4} fz="h6">
              {t('ih.title')}
            </Title>
            <Text size="xs" c="dimmed">
              {t('ih.help')}
            </Text>
          </Stack>
          <Group gap="xs" wrap="wrap">
            {m.canManage && (
              <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)} data-testid="ih-edit">
                {t('ih.edit')}
              </Button>
            )}
            <Button
              size="xs"
              variant="default"
              component="a"
              href={apiUrl(`${url}/mapping.csv`)}
              download
              leftSection={<IconDownload size={14} />}
              aria-label={t('ih.csvDownload')}
            >
              CSV
            </Button>
            {m.canManage && (
              <Button
                size="xs"
                leftSection={<IconSearch size={14} />}
                onClick={() => void check()}
                loading={busy === 'check'}
                disabled={!m.canCheck || m.counts.mapped === 0}
                title={m.checkProblem ?? undefined}
                data-testid="ih-check"
              >
                {t('ih.check')}
              </Button>
            )}
          </Group>
        </Group>
        <Group gap="xs" wrap="wrap" data-testid="ih-counts">
          <Badge variant="light" tt="none">
            {t('ih.mapped', { count: m.counts.mapped, of: m.counts.items })}
          </Badge>
          <Badge variant="light" color={m.counts.verified === m.counts.mapped && m.counts.mapped ? 'green' : 'gray'} tt="none">
            {t('ih.verified', { count: m.counts.verified })}
          </Badge>
          <Badge variant="light" color={m.counts.watched === m.counts.mapped && m.counts.mapped ? 'green' : 'gray'} tt="none">
            {t('ih.watched', { count: m.counts.watched })}
          </Badge>
          {m.platform && (
            <Text size="xs" c="dimmed">
              {m.platform.path ? (
                <Anchor component={Link} to={m.platform.path} size="xs">
                  {m.platform.name}
                </Anchor>
              ) : (
                t('flow.hiddenTarget')
              )}
              {m.default && ` · ${t('ih.defaultIs', { target: `${m.default.assetName || m.default.assetId} / ${m.default.aspect}` })}`}
            </Text>
          )}
        </Group>
        <Text size="xs" c="dimmed" data-testid="ih-last-run">
          {run ? t('ih.lastRun', { date: fmtDate(run.checkedAt), by: run.checkedBy, identity: run.identity || '–', assets: run.assets }) : t('ih.neverChecked')}
        </Text>
        {m.checkProblem && m.canManage && (
          <Text size="xs" c="orange">
            {t('ih.cannotCheck', { reason: m.checkProblem })}
          </Text>
        )}
        {run?.error && (
          <Alert color="orange" variant="light" title={t(`ih.error.${run.error.code}`)} data-testid="ih-error">
            <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
              {run.error.message}
            </Text>
          </Alert>
        )}
        {run?.capped && (
          <Text size="xs" c="orange">
            {t('ih.capped')}
          </Text>
        )}
        <div className="table-scroll" tabIndex={0} role="region" aria-label={t('ih.itemsLabel')}>
          <Table fz="xs" aria-label={t('ih.itemsLabel')} data-testid="ih-items">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('flow.item')}</Table.Th>
                <Table.Th>{t('ih.goesTo')}</Table.Th>
                <Table.Th>{t('ih.checkCol')}</Table.Th>
                <Table.Th>{t('ih.watchedBy')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {m.items.map((it) => (
                <ItemRow key={it.index} it={it} />
              ))}
            </Table.Tbody>
          </Table>
        </div>
        {m.groups.length > 0 && (
          <CollapsibleSection
            id={`ih-monitors-${collectionId}-${sinkId}`}
            order={4}
            size="h6"
            title={t('ih.monitorsTitle')}
            count={m.groups.length}
            tone={unwatched ? 'warning' : undefined}
            description={t('ih.monitorsHelp')}
            testId="ih-monitors"
          >
            <Stack gap="xs">
              {m.groups.map((g) => (
                <Paper key={`${g.assetId}/${g.aspect}`} withBorder p="xs" data-testid={`ih-group-${g.aspect}`}>
                  <Stack gap={4}>
                    <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
                      {g.assetName || g.assetId} / {g.aspect}
                    </Text>
                    {g.monitors.map((w) => (
                      <WatcherLine key={`${w.monitorId}/${w.checkId}`} w={w} />
                    ))}
                    {g.hiddenMonitors > 0 && (
                      <Text size="xs" c="dimmed">
                        {t('ih.hiddenWatchers', { count: g.hiddenMonitors })}
                      </Text>
                    )}
                    <Text size="xs" c={g.unwatched.length ? 'orange' : 'dimmed'} style={{ overflowWrap: 'anywhere' }}>
                      {g.unwatched.length ? t('ih.unwatched', { list: g.unwatched.join(', ') }) : t('ih.allWatched')}
                    </Text>
                  </Stack>
                </Paper>
              ))}
              {m.canCreateMonitor && unwatched > 0 && (
                <Stack gap={4}>
                  <Group>
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconPlus size={14} />}
                      onClick={() => void createMonitor()}
                      loading={busy === 'monitor'}
                      data-testid="ih-create-monitor"
                    >
                      {t('ih.createMonitor')}
                    </Button>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {m.leader ? t('ih.createHelpLeader', { name: m.leader.name }) : t('ih.createHelp')}
                  </Text>
                </Stack>
              )}
            </Stack>
          </CollapsibleSection>
        )}
        {gaps.unmapped.length + gaps.unverified.length + gaps.unwatched.length > 0 && (
          <CollapsibleSection
            id={`ih-gaps-${collectionId}-${sinkId}`}
            order={4}
            size="h6"
            title={t('ih.gapsTitle')}
            count={gaps.unmapped.length + gaps.unverified.length + gaps.unwatched.length}
            defaultOpen={false}
            testId="ih-gaps"
          >
            <GapList gaps={gaps} label={itemLabel} />
          </CollapsibleSection>
        )}
      </Stack>
      {editing && (
        <IhMappingModal
          url={url}
          mapping={m}
          onClose={() => setEditing(false)}
          onSaved={(x) => {
            refresh(x);
            setEditing(false);
          }}
        />
      )}
    </Paper>
  );
}

function ItemRow({ it }: { it: PlantIhMappingItem }) {
  const { t } = useTranslation('plantDocs');
  const c = it.check;
  return (
    <Table.Tr data-testid={`ih-item-${it.item}`}>
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
      <Table.Td style={{ overflowWrap: 'anywhere' }}>
        {it.target ? (
          <>
            <Text span size="xs" className="mono">
              {targetText(it.target)}
            </Text>
            {(it.fromDefault || it.placeholder) && (
              <Text span size="xs" c="dimmed">
                {' '}
                {[it.fromDefault && t('ih.fromDefault'), it.placeholder && t('ih.fromPlaceholder', { placeholder: it.placeholder })]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            )}
          </>
        ) : (
          <Text span size="xs" c="dimmed">
            {it.placeholder ? t('ih.placeholderMissing', { placeholder: it.placeholder }) : t('ih.notMapped')}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {it.target ? <IhStatusBadge status={c?.status ?? null} /> : '–'}
        {c?.unit && (
          <Text size="xs" c="dimmed">
            {t('ih.unitHint', { point: c.unit.point, ih: c.unit.ih })}
          </Text>
        )}
        {c?.type && (
          <Text size="xs" c="dimmed">
            {t('ih.typeHint', { point: c.type.point, ih: c.type.ih })}
          </Text>
        )}
      </Table.Td>
      <Table.Td style={{ overflowWrap: 'anywhere' }}>
        {it.watchedBy.map((w) => (
          <WatcherLine key={`${w.monitorId}/${w.checkId}`} w={w} />
        ))}
        {it.hiddenWatchers > 0 && (
          <Text size="xs" c="dimmed">
            {t('ih.hiddenWatchers', { count: it.hiddenWatchers })}
          </Text>
        )}
        {it.target && !it.watchedBy.length && !it.hiddenWatchers && (
          <Text size="xs" c="orange">
            {t('ih.nobody')}
          </Text>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

function WatcherLine({ w }: { w: PlantIhWatcher }) {
  const { t } = useTranslation('plantDocs');
  const label = `${w.monitorName} · ${w.checkName}`;
  return (
    <Group gap={4} wrap="wrap">
      <IconActivityHeartbeat size={12} aria-hidden />
      {w.path ? (
        <Anchor component={Link} to={w.path} size="xs">
          {label}
        </Anchor>
      ) : (
        <Text span size="xs">
          {label}
        </Text>
      )}
      {!w.enabled && (
        <Badge size="xs" variant="outline" color="gray" tt="none">
          {t('ih.disabled')}
        </Badge>
      )}
    </Group>
  );
}

export function GapList({ gaps, label }: { gaps: PlantIhMapping['counts']['gaps']; label: (i: number) => string }) {
  const { t } = useTranslation('plantDocs');
  return (
    <Stack gap={4}>
      {(['unmapped', 'unverified', 'unwatched'] as const)
        .filter((k) => gaps[k].length)
        .map((k) => (
          <Text key={k} size="xs" style={{ overflowWrap: 'anywhere' }}>
            <Text span fw={600} size="xs">
              {t(`ih.gaps.${k}`, { count: gaps[k].length })}
            </Text>{' '}
            {gaps[k].slice(0, 30).map(label).join(', ')}
            {gaps[k].length > 30 && ` ${t('flow.more', { count: gaps[k].length - 30 })}`}
          </Text>
        ))}
    </Stack>
  );
}

// ---------- editing: the default, one asset for many items, CSV, per item ----------

function IhMappingModal({
  url,
  mapping,
  onClose,
  onSaved,
}: {
  url: string;
  mapping: PlantIhMapping;
  onClose: () => void;
  onSaved: (m: PlantIhMapping) => void;
}) {
  const { t } = useTranslation(['plantDocs', 'common']);
  const [mode, setMode] = useState<'bulk' | 'items' | 'csv'>('bulk');
  const [busy, setBusy] = useState(false);
  const [def, setDef] = useState({
    assetId: mapping.default?.assetId ?? '',
    assetName: mapping.default?.assetName ?? '',
    aspect: mapping.default?.aspect ?? '',
  });
  const [bulk, setBulk] = useState({ assetId: '', assetName: '', aspect: '', items: 'data_points', names: 'output', overwrite: false });
  const [csv, setCsv] = useState({ text: '', mode: 'merge' });
  const [rows, setRows] = useState(() =>
    mapping.items.map((it) => ({
      item: it.item,
      label: it.dataPoint?.name ? `${it.dataPoint.name} · ${it.item}` : it.item,
      // as written: a placeholder stays a placeholder, the default is not copied into the item
      assetId: it.own.assetId,
      assetName: it.own.assetName,
      aspect: it.own.aspect,
      variable: it.target?.variable ?? '',
      changed: false,
    })),
  );
  const send = async (fn: () => Promise<PlantIhMapping>) => {
    setBusy(true);
    try {
      onSaved(await fn());
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('ih.editTitle', { name: mapping.sinkName })} size="xl" data-testid="ih-modal">
      <Stack gap="md">
        <Text size="xs" c="dimmed">
          {t('ih.editHelp')}
        </Text>
        <SegmentedControl
          value={mode}
          onChange={(x) => setMode(x as typeof mode)}
          data={[
            { value: 'bulk', label: t('ih.modeBulk') },
            { value: 'items', label: t('ih.modeItems') },
            { value: 'csv', label: t('ih.modeCsv') },
          ]}
          aria-label={t('ih.editTitle', { name: mapping.sinkName })}
        />
        {mode === 'bulk' && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!bulk.assetId.trim() || !bulk.aspect.trim()) return;
              void send(() =>
                post<PlantIhMapping>(`${url}/bulk`, {
                  assetId: bulk.assetId,
                  assetName: bulk.assetName,
                  aspect: bulk.aspect,
                  items: bulk.items,
                  names: bulk.names,
                  overwrite: bulk.overwrite,
                }),
              );
            }}
          >
            <Stack gap="sm">
              <Text size="xs" c="dimmed">
                {t('ih.bulkHelp')}
              </Text>
              <AssetFields value={bulk} onChange={(x) => setBulk((o) => ({ ...o, ...x }))} required />
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <Select
                  label={t('ih.bulkItems')}
                  data={[
                    { value: 'data_points', label: t('ih.bulkItemsPoints') },
                    { value: 'all', label: t('ih.bulkItemsAll') },
                  ]}
                  value={bulk.items}
                  onChange={(x) => x && setBulk((o) => ({ ...o, items: x }))}
                  allowDeselect={false}
                />
                <Select
                  label={t('ih.bulkNames')}
                  data={[
                    { value: 'output', label: t('ih.namesOutput') },
                    { value: 'data_point', label: t('ih.namesPoint') },
                    { value: 'keep', label: t('ih.namesKeep') },
                  ]}
                  value={bulk.names}
                  onChange={(x) => x && setBulk((o) => ({ ...o, names: x }))}
                  allowDeselect={false}
                />
              </SimpleGrid>
              <Checkbox label={t('ih.overwrite')} checked={bulk.overwrite} onChange={(e) => setBulk((o) => ({ ...o, overwrite: e.currentTarget.checked }))} />
              <Group justify="flex-end">
                <Button type="submit" loading={busy} disabled={!bulk.assetId.trim() || !bulk.aspect.trim()} data-testid="ih-bulk-apply">
                  {t('ih.bulkApply')}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
        {mode === 'items' && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void send(() =>
                put<PlantIhMapping>(`${url}/mapping`, {
                  default: def.assetId || def.aspect ? def : null,
                  items: rows
                    .filter((r) => r.changed)
                    .map(({ item, assetId, assetName, aspect, variable }) => ({ item, assetId, assetName, aspect, variable })),
                }),
              );
            }}
          >
            <Stack gap="sm">
              <Text size="sm" fw={600}>
                {t('ih.defaultTitle')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('ih.defaultHelp')}
              </Text>
              <AssetFields value={def} onChange={(x) => setDef((o) => ({ ...o, ...x }))} />
              <div className="table-scroll" tabIndex={0} role="region" aria-label={t('ih.itemsLabel')}>
                <Table fz="xs" aria-label={t('ih.itemsLabel')}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('flow.item')}</Table.Th>
                      <Table.Th>{t('ih.assetId')}</Table.Th>
                      <Table.Th>{t('ih.aspect')}</Table.Th>
                      <Table.Th>{t('ih.variable')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rows.map((r, i) => {
                      const set = (k: 'assetId' | 'aspect' | 'variable', x: string) =>
                        setRows((o) => o.map((y, j) => (j === i ? { ...y, [k]: x, changed: true, ...(k === 'assetId' ? { assetName: '' } : {}) } : y)));
                      return (
                        <Table.Tr key={r.item}>
                          <Table.Td style={{ overflowWrap: 'anywhere', minWidth: 140 }}>{r.label}</Table.Td>
                          <Table.Td>
                            <TextInput
                              size="xs"
                              value={r.assetId}
                              placeholder={def.assetId || undefined}
                              onChange={(e) => set('assetId', e.currentTarget.value)}
                              aria-label={t('ih.assetIdOf', { item: r.item })}
                              maxLength={200}
                              miw={140}
                            />
                          </Table.Td>
                          <Table.Td>
                            <TextInput
                              size="xs"
                              value={r.aspect}
                              placeholder={def.aspect || undefined}
                              onChange={(e) => set('aspect', e.currentTarget.value)}
                              aria-label={t('ih.aspectOf', { item: r.item })}
                              maxLength={200}
                              miw={100}
                            />
                          </Table.Td>
                          <Table.Td>
                            <TextInput
                              size="xs"
                              value={r.variable}
                              onChange={(e) => set('variable', e.currentTarget.value)}
                              aria-label={t('ih.variableOf', { item: r.item })}
                              maxLength={500}
                              miw={100}
                              data-testid={`ih-variable-${r.item}`}
                            />
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </div>
              <Group justify="flex-end">
                <Button type="submit" loading={busy} data-testid="ih-items-save">
                  {t('common:save')}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
        {mode === 'csv' && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!csv.text.trim()) return;
              void send(() => post<PlantIhMapping>(`${url}/csv`, { csv: csv.text, mode: csv.mode }));
            }}
          >
            <Stack gap="sm">
              <Textarea
                label={t('ih.csvLabel')}
                description={t('ih.csvHelp')}
                value={csv.text}
                onChange={(e) => setCsv((o) => ({ ...o, text: e.currentTarget.value }))}
                autosize
                minRows={4}
                maxRows={14}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                data-testid="ih-csv"
              />
              <Select
                label={t('ih.csvMode')}
                data={[
                  { value: 'merge', label: t('ih.csvMerge') },
                  { value: 'replace', label: t('ih.csvReplace') },
                ]}
                value={csv.mode}
                onChange={(x) => x && setCsv((o) => ({ ...o, mode: x }))}
                allowDeselect={false}
              />
              <Group justify="flex-end">
                <Button type="submit" loading={busy} disabled={!csv.text.trim()} data-testid="ih-csv-apply">
                  {t('ih.csvApply')}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Stack>
    </Modal>
  );
}

function AssetFields({
  value,
  onChange,
  required,
}: {
  value: { assetId: string; assetName: string; aspect: string };
  onChange: (x: Partial<{ assetId: string; assetName: string; aspect: string }>) => void;
  required?: boolean;
}) {
  const { t } = useTranslation('plantDocs');
  return (
    <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
      <TextInput
        label={t('ih.assetId')}
        description={t('ih.assetIdHelp')}
        value={value.assetId}
        onChange={(e) => onChange({ assetId: e.currentTarget.value })}
        maxLength={200}
        required={required}
        data-testid="ih-asset-id"
      />
      <TextInput
        label={t('ih.assetName')}
        description={t('ih.assetNameHelp')}
        value={value.assetName}
        onChange={(e) => onChange({ assetName: e.currentTarget.value })}
        maxLength={200}
      />
      <TextInput
        label={t('ih.aspect')}
        value={value.aspect}
        onChange={(e) => onChange({ aspect: e.currentTarget.value })}
        maxLength={200}
        required={required}
        data-testid="ih-aspect"
      />
    </SimpleGrid>
  );
}

/** The data point page: "Insights Hub: asset / aspect / variable – checked ok on …". */
export function IhGoesTo({ ih }: { ih: PlantIhTargetBrief }) {
  const { t } = useTranslation('plantDocs');
  return (
    <Group gap={4} wrap="wrap" data-testid="ih-goes-to">
      <Text span size="xs">
        {t('ih.goesToLine', { target: targetText(ih) })}
      </Text>
      <IhStatusBadge status={ih.status} />
      {ih.checkedAt && (
        <Text span size="xs" c="dimmed">
          {t('ih.checkedOn', { date: fmtDate(ih.checkedAt) })}
        </Text>
      )}
    </Group>
  );
}

/** The monitor's page (0.14): the mapped items of plant collections its checks cover – stored links, both ways. */
export function MonitorIhCoverage({ monitorId }: { monitorId: string }) {
  const { t } = useTranslation('plantDocs');
  const q = useQuery({
    queryKey: ['plant', 'monitors', monitorId, 'insights-hub'],
    queryFn: () => get<PlantIhMonitorCoverage>(`/plant/monitors/${encodeURIComponent(monitorId)}/insights-hub`),
  });
  const c = q.data;
  if (!c || (!c.entries.length && !c.hidden)) return null;
  return (
    <Paper withBorder p="sm" mt="sm" data-testid="monitor-ih-coverage">
      <Stack gap={4}>
        <Title order={3} fz="h6">
          {t('ih.monitorCoverageTitle')}
        </Title>
        {c.entries.map((e) => (
          <Text key={`${e.assetId}/${e.collectionId}/${e.sinkId}`} size="sm" style={{ overflowWrap: 'anywhere' }}>
            {t('ih.covers', { count: e.items })}{' '}
            <Anchor
              component={Link}
              to={`/plant/assets/${encodeURIComponent(e.assetId)}/collections?collection=${encodeURIComponent(e.collectionId)}`}
              size="sm"
            >
              {e.assetName} · {e.collectionName}
            </Anchor>{' '}
            <Text span size="xs" c="dimmed">
              {t('ih.coversChecks', { sink: e.sinkName, checks: e.checks.join(', ') })}
            </Text>
          </Text>
        ))}
        {c.hidden > 0 && (
          <Text size="xs" c="dimmed">
            {t('ih.coversHidden', { count: c.hidden })}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
