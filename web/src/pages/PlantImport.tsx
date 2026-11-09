import { useState } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Button, FileButton, Group, Paper, Radio, SegmentedControl, Select, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconCheck, IconFileImport, IconFileText, IconGitPullRequest, IconTrash, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  PLANT_LIMITS,
  type PlantChangeAction,
  type PlantImportMode,
  type PlantImportPreview,
  type PlantImportResult,
  type PlantImportSummary,
  type PlantMissing,
  type PlantChangeSetDetail,
  type PlantChangeSetSummary,
} from '@sm/shared';
import { apiUrl, get, notifyError, notifyOk, post } from '../api';
import { EmptyState, PageHeader, QueryState } from '../components/common';
import { confirmDanger } from '../components/confirm';
import { fmtBytes, fmtDate } from '../format';
import { plantKeys } from '../queryKeys';
import { PreviewBadge, usePlantConfig, usePlantLabel } from '../components/plant/common';
import { ChecksList } from '../components/plant/data';
import { IdMappingStep, ImportIdsPreview, idOptionsBody, NO_ID_OPTIONS, type IdOptions } from '../components/plant/importIds';
import { ACTION_COLOR, ChangeTable, useKindLabel } from '../components/plant/changes';
import { useChangeSetConfig } from '../components/plant/changes/common';

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
  const { t } = useTranslation(['plant', 'plantIds', 'common']);
  const { t: tc } = useTranslation('plantChanges');
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
  // 0.11.0: the id mapping and the removals
  const [ids, setIds] = useState<IdOptions>(NO_ID_OPTIONS);
  // 0.13.0: who may only propose previews the files and adds them to their draft (a change set applies them)
  const cs = useChangeSetConfig();
  const canApply = !!cfg.data?.canManageSome;
  const canDraft = !!cs?.canPropose;
  const canImport = canApply || canDraft;
  const [drafted, setDrafted] = useState<PlantChangeSetSummary | null>(null);
  const [proposed, setProposed] = useState<PlantChangeSetSummary | null>(null);
  const earlier = imports.data ?? [];
  const body = () => ({
    files: files.map(({ name, content }) => ({ name, content })),
    mode,
    missing,
    replaces: mode === 'replace' ? replaces : null,
    ...idOptionsBody(ids),
  });
  const stale = () => {
    setPreview(null);
    setResult(null);
    setDrafted(null);
    setProposed(null);
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
    setDrafted(null);
    setProposed(null);
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
    const removing = preview.removals?.items.filter((i) => !i.refused).length ?? 0;
    if (removing > 0 && !(await confirmDanger({ action: 'remove', message: t('plantIds:preview.confirmRemove', { count: removing }) }))) return;
    setBusy(true);
    try {
      const r = await post<PlantImportResult | (PlantImportPreview & { changeSet: PlantChangeSetSummary })>('/plant/import', body());
      setPreview(null);
      setFiles([]);
      setIds(NO_ID_OPTIONS);
      if ('changeSet' in r && r.changeSet) {
        // changes here need a second person: the import became a proposed change set of its own
        setProposed(r.changeSet);
        void qc.invalidateQueries({ queryKey: ['plant', 'change-sets'] });
        return;
      }
      const done = r as PlantImportResult;
      setResult(done);
      notifyOk(t('import.done', { add: done.counts.add, change: done.counts.change, remove: done.counts.remove, mark: done.counts.mark }));
      void qc.invalidateQueries({ queryKey: plantKeys.all });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  /** Add to draft (0.13.0): the files and options as one change of the person's current draft – nothing is imported yet. */
  const addToDraft = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const d = await post<PlantChangeSetDetail>('/plant/change-sets/current/operations', { op: 'import', value: body() });
      setPreview(null);
      setFiles([]);
      setIds(NO_ID_OPTIONS);
      setDrafted(d);
      notifyOk(tc('form.addedToDraft', { title: d.title }));
      void qc.invalidateQueries({ queryKey: plantKeys.config });
      void qc.invalidateQueries({ queryKey: ['plant', 'change-sets'] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const changes = (preview?.changes ?? []).filter((c) => show === 'all' || (c.action !== 'unchanged' && c.action !== 'skip'));
  const kindLabel = useKindLabel();
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
          {!canApply && (
            <Alert color="blue" variant="light" icon={<IconGitPullRequest size={18} />} data-testid="import-propose-only">
              <Text size="sm">{tc('form.importProposeOnly')}</Text>
            </Alert>
          )}
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

          <IdMappingStep value={ids} onChange={(v) => (setIds(v), stale())} />

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
                <ImportIdsPreview preview={preview} />
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
                    {canDraft && (
                      <Text size="xs" c="dimmed">
                        {tc('form.addToDraftHint')}
                      </Text>
                    )}
                    <Group justify="flex-end" gap="xs">
                      {canDraft && (
                        <Button
                          variant={canApply ? 'default' : 'filled'}
                          leftSection={<IconGitPullRequest size={16} aria-hidden />}
                          onClick={() => void addToDraft()}
                          loading={busy}
                          data-testid="import-add-to-draft"
                        >
                          {tc('form.addToDraft')}
                        </Button>
                      )}
                      {canApply && (
                        <Button leftSection={<IconFileImport size={16} />} onClick={() => void apply()} loading={busy} data-testid="import-apply">
                          {t('import.apply')}
                        </Button>
                      )}
                    </Group>
                  </>
                )}
              </Stack>
            </Paper>
          )}

          {drafted && (
            <Alert color="blue" icon={<IconGitPullRequest size={18} />} title={tc('form.addedToDraft', { title: drafted.title })} data-testid="import-drafted">
              <Anchor component={Link} to={`/plant/changes/${encodeURIComponent(drafted.id)}`} size="sm">
                {tc('form.openDraft')}
              </Anchor>
            </Alert>
          )}
          {proposed && (
            <Alert
              color="blue"
              icon={<IconGitPullRequest size={18} />}
              title={tc('form.proposedForReview', { title: proposed.title })}
              data-testid="import-proposed"
            >
              <Anchor component={Link} to={`/plant/changes/${encodeURIComponent(proposed.id)}`} size="sm">
                {tc('form.openChangeSet')}
              </Anchor>
            </Alert>
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
