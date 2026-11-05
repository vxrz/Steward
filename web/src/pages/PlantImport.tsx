import { useState } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Button, FileButton, Group, Paper, Radio, SegmentedControl, Select, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconCheck, IconFileImport, IconFileText, IconTrash, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  PLANT_LIMITS,
  type PlantChange,
  type PlantChangeAction,
  type PlantChangeKind,
  type PlantImportMode,
  type PlantImportPreview,
  type PlantImportResult,
  type PlantImportSummary,
  type PlantMissing,
  type PlantRecordType,
} from '@sm/shared';
import { apiUrl, get, notifyError, notifyOk, post } from '../api';
import { EmptyState, PageHeader, QueryState } from '../components/common';
import { confirmDanger } from '../components/confirm';
import { fmtBytes, fmtDate } from '../format';
import { plantKeys } from '../queryKeys';
import { PreviewBadge, usePlantConfig, usePlantLabel } from '../components/plant/common';
import { ChecksList } from '../components/plant/data';

const KIND_TYPE: Partial<Record<PlantChangeKind, PlantRecordType>> = {
  site: 'site',
  area: 'area',
  work_center: 'workCenter',
  work_unit: 'workUnit',
  building: 'building',
  asset: 'asset',
};
/** Kinds of part 2 (#219) without an own display name */
type DataKind = 'profile' | 'kpi' | 'assignment';
const ACTION_COLOR: Record<PlantChangeAction, string> = { add: 'green', change: 'blue', remove: 'red', mark: 'orange', unchanged: 'gray', skip: 'gray' };
const ACTIONS: PlantChangeAction[] = ['add', 'change', 'remove', 'mark', 'unchanged', 'skip'];

interface Picked {
  name: string;
  content: string;
  bytes: number;
}

/**
 * YAML import of the plant registry (#218): choose files (one per site, assets apart, or a whole tree), the mode, see
 * what would be added, changed and removed – then import. Earlier imports are listed below, to replace one.
 */
export function PlantImportPage() {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const qc = useQueryClient();
  const cfg = usePlantConfig();
  const imports = useQuery({ queryKey: plantKeys.imports, queryFn: () => get<PlantImportSummary[]>('/plant/imports') });
  const [files, setFiles] = useState<Picked[]>([]);
  const [mode, setMode] = useState<PlantImportMode>('update');
  const [replaces, setReplaces] = useState<string | null>(null);
  const [missing, setMissing] = useState<PlantMissing>('mark');
  const [preview, setPreview] = useState<PlantImportPreview | null>(null);
  const [show, setShow] = useState<'changes' | 'all'>('changes');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlantImportResult | null>(null);
  const canImport = cfg.data?.canManageSome;
  const earlier = imports.data ?? [];
  const body = () => ({ files: files.map(({ name, content }) => ({ name, content })), mode, missing, replaces: mode === 'replace' ? replaces : null });
  const stale = () => {
    setPreview(null);
    setResult(null);
  };
  const pick = async (list: File[]) => {
    const read = await Promise.all(list.map(async (f) => ({ name: f.name, content: await f.text(), bytes: f.size })));
    const next = [...files.filter((x) => !read.some((r) => r.name === x.name)), ...read].slice(0, PLANT_LIMITS.importFiles);
    setFiles(next);
    // replacing: the last import of the same files is the likely one
    if (!replaces) {
      const same = earlier.find((i) => i.files.some((f) => next.some((n) => n.name === f.name)));
      if (same) setReplaces(same.id);
    }
    stale();
  };
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const tooLarge = total > PLANT_LIMITS.importBytes;
  const ready = files.length > 0 && !tooLarge && (mode !== 'replace' || !!replaces);
  const runPreview = async () => {
    setBusy(true);
    setResult(null);
    try {
      setPreview(await post<PlantImportPreview>('/plant/import/preview', body()));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview) return;
    if (preview.counts.remove > 0 && !(await confirmDanger({ action: 'remove', message: t('import.removeConfirm', { count: preview.counts.remove }) }))) return;
    setBusy(true);
    try {
      const r = await post<PlantImportResult>('/plant/import', body());
      setResult(r);
      setPreview(null);
      setFiles([]);
      notifyOk(t('import.done', { add: r.counts.add, change: r.counts.change, remove: r.counts.remove, mark: r.counts.mark }));
      void qc.invalidateQueries({ queryKey: plantKeys.all });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const changes = (preview?.changes ?? []).filter((c) => show === 'all' || (c.action !== 'unchanged' && c.action !== 'skip'));
  const kindLabel = (k: PlantChangeKind) => {
    const type = KIND_TYPE[k];
    return type ? label(type) : t(`import.kinds.${k as DataKind}`);
  };
  return (
    <>
      <PageHeader
        back="plantSites"
        title={
          <Group gap="sm" component="span">
            <span>{t('import.title')}</span>
            <PreviewBadge />
          </Group>
        }
        description={t('import.description')}
        actions={
          <Button
            size="xs"
            variant="default"
            component="a"
            href={apiUrl('/plant/schema')}
            target="_blank"
            rel="noopener"
            leftSection={<IconFileText size={14} />}
          >
            {t('import.schema')}
          </Button>
        }
      />
      {cfg.isSuccess && !canImport ? (
        <EmptyState icon={IconFileImport} title={t('import.notAllowedTitle')} whoCanAct={t('common:whoCanAct.plantSites')}>
          {t('import.notAllowedText')}
        </EmptyState>
      ) : (
        <Stack gap="lg" maw={980}>
          <Paper withBorder p="md">
            <Stack gap="sm">
              <Title order={2} fz="h4">
                {t('import.step1')}
              </Title>
              <Text size="sm" c="dimmed">
                {t('import.filesHelp')}
              </Text>
              <Group gap="xs">
                <FileButton onChange={(f) => void pick(f)} accept=".yaml,.yml,.json,application/yaml,application/json,text/yaml" multiple>
                  {(props) => (
                    <Button size="xs" leftSection={<IconUpload size={14} />} {...props} data-testid="import-choose">
                      {files.length ? t('import.addFiles') : t('import.chooseFiles')}
                    </Button>
                  )}
                </FileButton>
                {files.length > 0 && (
                  <Button size="xs" variant="subtle" color="gray" onClick={() => (setFiles([]), stale())}>
                    {t('import.clearFiles')}
                  </Button>
                )}
              </Group>
              {files.length > 0 && (
                <Stack gap={2} data-testid="import-files">
                  {files.map((f) => (
                    <Group key={f.name} gap="xs" wrap="nowrap">
                      <IconFileText size={14} aria-hidden />
                      <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                        {f.name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {fmtBytes(f.bytes)}
                      </Text>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        aria-label={t('import.removeFile', { name: f.name })}
                        onClick={() => (setFiles(files.filter((x) => x.name !== f.name)), stale())}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Group>
                  ))}
                  {tooLarge && (
                    <Text size="xs" c="red">
                      {t('import.tooLarge', { mb: PLANT_LIMITS.importBytes / 1024 / 1024 })}
                    </Text>
                  )}
                </Stack>
              )}
            </Stack>
          </Paper>

          <Paper withBorder p="md">
            <Stack gap="sm">
              <Title order={2} fz="h4">
                {t('import.step2')}
              </Title>
              <Radio.Group value={mode} onChange={(v) => (setMode(v as PlantImportMode), stale())} name="mode" aria-label={t('import.mode')}>
                <Stack gap="xs">
                  {(['add', 'update', 'replace'] as const).map((m) => (
                    <Radio.Card key={m} value={m} p="sm" radius="md" disabled={m === 'replace' && !earlier.length} data-testid={`mode-${m}`}>
                      <Group wrap="nowrap" align="flex-start" gap="sm">
                        <Radio.Indicator mt={2} />
                        <div>
                          <Text size="sm" fw={600}>
                            {t(`import.modes.${m}.title`)}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {m === 'replace' && !earlier.length ? t('import.modes.replace.none') : t(`import.modes.${m}.text`)}
                          </Text>
                        </div>
                      </Group>
                    </Radio.Card>
                  ))}
                </Stack>
              </Radio.Group>
              {mode === 'replace' && (
                <Stack gap="sm" pl={{ base: 0, sm: 'xl' }}>
                  <Select
                    label={t('import.replaces')}
                    description={t('import.replacesHelp')}
                    data={earlier.map((i) => ({
                      value: i.id,
                      label: t('import.earlierLabel', { date: fmtDate(i.createdAt), user: i.createdBy, files: i.files.map((f) => f.name).join(', ') }),
                    }))}
                    value={replaces}
                    onChange={(v) => (setReplaces(v), stale())}
                    allowDeselect={false}
                    required
                  />
                  <Radio.Group value={missing} onChange={(v) => (setMissing(v as PlantMissing), stale())} name="missing" label={t('import.missing')}>
                    <Group gap="lg" mt={4}>
                      <Radio value="mark" label={t('import.missingMark')} />
                      <Radio value="remove" label={t('import.missingRemove')} />
                    </Group>
                  </Radio.Group>
                </Stack>
              )}
              <Group>
                <Button onClick={() => void runPreview()} loading={busy && !preview} disabled={!ready} data-testid="import-preview">
                  {t('import.previewButton')}
                </Button>
              </Group>
            </Stack>
          </Paper>

          {preview && (
            <Paper withBorder p="md" data-testid="import-preview-result">
              <Stack gap="sm">
                <Title order={2} fz="h4">
                  {t('import.step3')}
                </Title>
                <Group gap="xs" data-testid="import-counts">
                  {ACTIONS.filter((a) => preview.counts[a] > 0).map((a) => (
                    <Badge key={a} color={ACTION_COLOR[a]} variant="light">
                      {t(`import.actions.${a}`)}: {preview.counts[a]}
                    </Badge>
                  ))}
                </Group>
                {preview.problems.length > 0 && (
                  <Alert
                    color="red"
                    icon={<IconAlertTriangle size={18} />}
                    title={t('import.problems', { count: preview.problems.length })}
                    data-testid="import-problems"
                  >
                    <Stack gap={4}>
                      {preview.problems.map((p, i) => (
                        <Text key={i} size="sm" style={{ overflowWrap: 'anywhere' }}>
                          <Text span fw={600}>
                            {p.file}
                          </Text>{' '}
                          <Text span className="mono" size="xs">
                            {p.path}
                          </Text>{' '}
                          – {p.message}
                        </Text>
                      ))}
                    </Stack>
                  </Alert>
                )}
                {preview.warnings.length > 0 && (
                  <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title={t('import.warnings')}>
                    <Stack gap={4}>
                      {preview.warnings.map((p, i) => (
                        <Text key={i} size="sm">
                          {p.message}
                        </Text>
                      ))}
                    </Stack>
                  </Alert>
                )}
                {preview.checks.length > 0 && (
                  <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title={t('import.checks', { count: preview.checks.length })}>
                    <Text size="xs" mb="xs">
                      {t('import.checksHelp')}
                    </Text>
                    <ChecksList checks={preview.checks} subjects testId="import-checks" />
                  </Alert>
                )}
                {preview.ok && (
                  <>
                    <SegmentedControl
                      size="xs"
                      w="fit-content"
                      value={show}
                      onChange={(v) => setShow(v as 'changes' | 'all')}
                      data={[
                        { value: 'changes', label: t('import.showChanges') },
                        { value: 'all', label: t('import.showAll') },
                      ]}
                      aria-label={t('import.show')}
                    />
                    {changes.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        {t('import.nothingChanges')}
                      </Text>
                    ) : (
                      <ChangeTable changes={changes} kindLabel={kindLabel} />
                    )}
                    <Group justify="flex-end">
                      <Button leftSection={<IconFileImport size={16} />} onClick={() => void apply()} loading={busy} data-testid="import-apply">
                        {t('import.apply')}
                      </Button>
                    </Group>
                  </>
                )}
              </Stack>
            </Paper>
          )}

          {result && (
            <Alert color="green" icon={<IconCheck size={18} />} title={t('import.resultTitle')} data-testid="import-result">
              <Text size="sm">
                {t('import.done', { add: result.counts.add, change: result.counts.change, remove: result.counts.remove, mark: result.counts.mark })}
              </Text>
              <Text size="xs" c="dimmed" className="mono code-wrap" mt={4}>
                SHA-256 {result.sha256}
              </Text>
              <Anchor component={Link} to="/plant/sites" size="sm">
                {t('import.toSites', { type: label('site', true, true) })}
              </Anchor>
            </Alert>
          )}

          <Stack gap="xs" data-testid="import-history">
            <Title order={2} fz="h4">
              {t('import.history')}
            </Title>
            <QueryState query={imports} rows={2} />
            {imports.isSuccess && earlier.length === 0 && (
              <Text size="sm" c="dimmed">
                {t('import.noHistory')}
              </Text>
            )}
            {earlier.length > 0 && (
              // focusable: it scrolls sideways on phones (keyboard access to the scroll region)
              <div className="table-scroll" tabIndex={0} role="region" aria-label={t('import.history')}>
                <Table fz="sm" aria-label={t('import.history')}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('import.when')}</Table.Th>
                      <Table.Th>{t('import.mode')}</Table.Th>
                      <Table.Th>{t('import.files')}</Table.Th>
                      <Table.Th>{t('import.result')}</Table.Th>
                      <Table.Th>{t('import.records')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {earlier.map((i) => (
                      <Table.Tr key={i.id}>
                        <Table.Td className="nowrap">
                          {fmtDate(i.createdAt)}
                          <Text size="xs" c="dimmed">
                            {i.createdBy}
                          </Text>
                        </Table.Td>
                        <Table.Td>{t(`import.modes.${i.mode}.title`)}</Table.Td>
                        <Table.Td style={{ overflowWrap: 'anywhere' }}>
                          {i.files.map((f) => f.name).join(', ')}
                          <Text size="xs" c="dimmed" className="mono">
                            {i.sha256.slice(0, 16)}…
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4}>
                            {(['add', 'change', 'remove', 'mark'] as const)
                              .filter((a) => i.counts[a] > 0)
                              .map((a) => (
                                <Badge key={a} size="xs" color={ACTION_COLOR[a]} variant="light">
                                  {t(`import.actions.${a}`)}: {i.counts[a]}
                                </Badge>
                              ))}
                          </Group>
                        </Table.Td>
                        <Table.Td>{i.records}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            )}
          </Stack>
        </Stack>
      )}
    </>
  );
}

function ChangeTable({ changes, kindLabel }: { changes: PlantChange[]; kindLabel: (k: PlantChangeKind) => string }) {
  const { t } = useTranslation('plant');
  const shown = changes.slice(0, 500);
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={t('import.changes')}>
      <Table fz="sm" aria-label={t('import.changes')} data-testid="import-changes">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('import.action')}</Table.Th>
            <Table.Th>{t('import.kind')}</Table.Th>
            <Table.Th>{t('form.name')}</Table.Th>
            <Table.Th>{t('import.what')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {shown.map((c) => (
            <Table.Tr key={`${c.kind}:${c.siteId}:${c.id}:${c.action}`}>
              <Table.Td>
                <Badge size="sm" color={ACTION_COLOR[c.action]} variant="light">
                  {t(`import.actions.${c.action}`)}
                </Badge>
              </Table.Td>
              <Table.Td className="nowrap">{kindLabel(c.kind)}</Table.Td>
              <Table.Td>
                <Text size="sm">{c.name}</Text>
                <Text size="xs" c="dimmed" className="mono">
                  {c.kind === 'site' || !c.siteId ? c.id : `${c.siteId} / ${c.id}`}
                </Text>
              </Table.Td>
              <Table.Td>
                {c.fields?.length ? (
                  <Group gap={4}>
                    {c.fields.map((f) => (
                      <Badge key={f} size="xs" variant="default">
                        {t(`import.fields.${f as 'name'}`, { defaultValue: f })}
                      </Badge>
                    ))}
                  </Group>
                ) : null}
                {c.note && (
                  <Text size="xs" c="dimmed">
                    {noteKey(c.note) === 'other' ? c.note : t(`import.notes.${noteKey(c.note) as Exclude<ReturnType<typeof noteKey>, 'other'>}`)}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {changes.length > shown.length && (
        <Text size="xs" c="dimmed" mt={4}>
          {t('import.more', { count: changes.length - shown.length })}
        </Text>
      )}
    </div>
  );
}

/** The server's notes, as keys of their translations. */
function noteKey(note: string): 'exists' | 'notInSource' | 'marked' | 'markedHolds' | 'namesRemoved' | 'other' {
  if (note.startsWith('exists')) return 'exists';
  if (note === 'not in source') return 'notInSource';
  if (note.startsWith('kept, marked "not in source" (')) return 'markedHolds';
  if (note.startsWith('kept, marked')) return 'marked';
  if (note.startsWith('names a')) return 'namesRemoved';
  return 'other';
}
