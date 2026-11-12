import { useEffect, useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  List,
  Menu,
  Modal,
  MultiSelect,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconPlayerPlay,
  IconPlus,
  IconTemplate,
  IconUpload,
  IconDots,
  IconArchive,
  IconFileExport,
  IconChevronDown,
  IconPackageExport,
  IconPackageImport,
  IconSitemap,
  IconChecklist,
} from '@tabler/icons-react';
import { BUNDLE_FORMATS, tagLabel, tagsMatch, type ExportBundle, type ProcessDetail, type ProcessSummary, type Schedule } from '@sm/shared';
import { TagBadges, TagFilterChip, useTagFilter } from '../components/tags';
import { del, get, notifyError, notifyOk, post, apiUrl } from '../api';
import { QueryState, StatusBadge } from '../components/common';
import { AutomateTabs } from '../components/page/LinkTabs';
import { GitOriginBadge } from '../components/gitsync/GitOriginBadge';
import { LibraryOriginBadge } from '../components/libraries/parts';
import { RunDialog } from '../components/RunDialog';
import { DescriptionText, descriptionPlain } from '../components/DescriptionText';
import { TemplateGallery } from '../components/TemplateGallery';
import { fmtDate, fmtRelative } from '../format';
import { errorText } from '../i18n/errors';
import { BRAND } from '../../../shared/src/brand';
import { useMe } from '../auth';
import { confirmDanger } from '../components/confirm';
import { ListPage, useStoredListView } from '../components/page/ListPage';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { NewProcessModal, type NewProcessStart } from '../components/processes/NewProcessModal';
import { dashboardKeys, processKeys, scheduleKeys } from '../queryKeys';
import { DuplicateMenuItem, useDuplicate } from '../components/duplicate/DuplicateButton';
import { FormModal } from '../components/FormModal';

type LastRunFilter = 'succeeded' | 'findings' | 'failed' | 'other' | 'never';
const LAST_RUN_FILTERS: LastRunFilter[] = ['succeeded', 'findings', 'failed', 'other', 'never'];
const lastRunOf = (p: ProcessSummary): LastRunFilter => {
  if (!p.lastRun) return 'never';
  const o = p.lastRun.outcome ?? p.lastRun.status;
  return o === 'succeeded' || o === 'findings' || o === 'failed' ? o : 'other';
};

export function ProcessesPage() {
  const { t } = useTranslation(['processes', 'common']);
  const qc = useQueryClient();
  const processes = useQuery({ queryKey: processKeys.all, queryFn: () => get<ProcessSummary[]>('/processes') });
  const schedules = useQuery({ queryKey: scheduleKeys.all, queryFn: () => get<Schedule[]>('/schedules') });
  const [runId, setRunId] = useState<string | null>(null);
  const [templatesOpen, templates] = useDisclosure();
  const [importOpen, importModal] = useDisclosure();
  const [bundleOpen, bundleModal] = useDisclosure();
  const [newStart, setNewStart] = useState<NewProcessStart | null>(null);
  const { caps } = useMe();
  // ?templates=<kind> or ?bundle=<id> (a platform's "Get started", v0.4.0): the gallery opens filtered, or on the bundle
  const [params, setParams] = useSearchParams();
  const galleryKind = params.get('templates');
  const galleryBundle = params.get('bundle');
  useEffect(() => {
    if (galleryKind !== null || galleryBundle) templates.open();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per link
  }, [galleryKind, galleryBundle]);
  const duplicate = useDuplicate();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const view = useStoredListView('processes', narrow);

  // the filters live in the address (?q=, ?tag=, ?last=, ?scheduled=), so a filtered list can be shared
  const filter = params.get('q') ?? '';
  const last = params.getAll('last').filter((x): x is LastRunFilter => (LAST_RUN_FILTERS as string[]).includes(x));
  const scheduled = params.get('scheduled');
  const set = (k: string, v: string | string[] | null) => {
    const next = new URLSearchParams(params);
    next.delete(k);
    for (const x of Array.isArray(v) ? v : v ? [v] : []) next.append(k, x);
    setParams(next, { replace: true });
  };
  const [tag, setTag] = useTagFilter();
  // the next run of each process: its earliest enabled schedule
  const nextRun = new Map<string, string>();
  for (const sc of schedules.data ?? []) {
    if (!sc.enabled || !sc.nextRunAt) continue;
    const cur = nextRun.get(sc.processId);
    if (!cur || sc.nextRunAt < cur) nextRun.set(sc.processId, sc.nextRunAt);
  }
  const f = filter.trim().toLowerCase();
  const list = (processes.data ?? []).filter(
    (p) =>
      (!f ||
        p.name.toLowerCase().includes(f) ||
        p.id.includes(f) ||
        p.tags.some((x) => tagLabel(x).toLowerCase().includes(f)) ||
        descriptionPlain(p.description ?? '')
          .toLowerCase()
          .includes(f)) &&
      tagsMatch(p.tags, tag) &&
      (!last.length || last.includes(lastRunOf(p))) &&
      (!scheduled || (scheduled === 'yes') === nextRun.has(p.id)),
  );
  const active = last.length + (scheduled ? 1 : 0);
  const archive = async (p: ProcessSummary) => {
    if (!(await confirmDanger({ action: 'archive', message: t('card.archiveConfirm', { name: p.name }) }))) return;
    await del(`/processes/${p.id}`).catch(notifyError);
    void qc.invalidateQueries({ queryKey: processKeys.all });
  };
  const actionsOf = (p: ProcessSummary) => (
    <Group gap={4} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
      {p.permissions.includes('run') && (
        <Tooltip label={t('card.run')}>
          <ActionIcon variant="light" onClick={() => setRunId(p.id)} aria-label={t('card.runNamed', { name: p.name })}>
            <IconPlayerPlay size={16} />
          </ActionIcon>
        </Tooltip>
      )}
      <Menu position="bottom-end">
        <Menu.Target>
          <ActionIcon variant="subtle" aria-label={t('card.moreFor', { name: p.name })}>
            <IconDots size={16} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconFileExport size={14} />} component="a" href={apiUrl(`/processes/${p.id}/export`)}>
            {t('card.exportYaml')}
          </Menu.Item>
          {caps.createProcesses && <DuplicateMenuItem onClick={() => duplicate.open('process', p.id)} />}
          {p.permissions.includes('manage') && (
            <Menu.Item color="red" leftSection={<IconArchive size={14} />} onClick={() => void archive(p)}>
              {t('card.archive')}
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
  const badgesOf = (p: ProcessSummary) => (
    <>
      <GitOriginBadge kind="process" id={p.id} size="xs" />
      <LibraryOriginBadge kind="process" id={p.id} size="xs" />
      {p.acl.length > 0 && (
        <Badge size="xs" variant="light" color="orange" title={t('card.restrictedHint')}>
          {t('card.restricted')}
        </Badge>
      )}
      {!p.permissions.includes('edit') && (
        <Badge size="xs" variant="light" color="gray">
          {t('card.readOnly')}
        </Badge>
      )}
    </>
  );
  const columns: DataColumn<ProcessSummary>[] = [
    {
      key: 'name',
      header: t('list.name'),
      sortValue: (p) => p.name,
      // compact: name, badges and tags on one line, the description in one line below (54 demo processes fit a few screens)
      cell: (p) => (
        <Stack gap={0} maw={600}>
          <Group gap={6} wrap="wrap" align="center">
            <Anchor component={Link} to={`/processes/${p.id}`} fw={600} size="sm" onClick={(e) => e.stopPropagation()}>
              {p.name}
            </Anchor>
            {badgesOf(p)}
            <TagBadges tags={p.tags} onTag={setTag} />
          </Group>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {descriptionPlain(p.description ?? '')}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'lastRun',
      header: t('list.lastRun'),
      sortValue: (p) => p.lastRun?.startedAt,
      nowrap: true,
      cell: (p) =>
        p.lastRun ? (
          <Stack gap={2} align="flex-start">
            <StatusBadge status={p.lastRun.outcome ?? p.lastRun.status} size="xs" />
            <Anchor
              component={Link}
              to={`/runs/${p.lastRun.id}`}
              size="xs"
              c="dimmed"
              title={fmtDate(p.lastRun.startedAt)}
              onClick={(e) => e.stopPropagation()}
            >
              {fmtRelative(p.lastRun.startedAt)}
            </Anchor>
          </Stack>
        ) : (
          <Text size="xs" c="dimmed">
            {t('list.never')}
          </Text>
        ),
    },
    {
      key: 'nextRun',
      header: t('list.nextRun'),
      sortValue: (p) => nextRun.get(p.id),
      nowrap: true,
      cell: (p) => {
        const at = nextRun.get(p.id);
        return at ? (
          <Text size="xs" title={fmtDate(at)}>
            {fmtRelative(at)}
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            {t('list.notScheduled')}
          </Text>
        );
      },
    },
    { key: 'owner', header: t('list.owner'), sortValue: (p) => p.owner ?? '', cell: (p) => <Text size="xs">{p.owner ?? '–'}</Text> },
    {
      key: 'version',
      header: t('list.version'),
      sortValue: (p) => p.updatedAt,
      nowrap: true,
      cell: (p) => (
        <Text size="xs" title={fmtDate(p.updatedAt)}>
          {t('list.versionLine', { version: p.currentVersion, when: fmtRelative(p.updatedAt) })}
        </Text>
      ),
    },
    { key: 'actions', header: <VisuallyHidden>{t('list.actions')}</VisuallyHidden>, label: t('list.actions'), cell: actionsOf },
  ];

  return (
    <ListPage
      tabs={<AutomateTabs active="/processes" />}
      title={t('title')}
      description={t('description')}
      view="processes"
      viewState={view}
      actions={
        <>
          {/* the secondary actions in one menu: a manual procedure, YAML import, bundles (several processes and dashboards in one file) */}
          <Menu position="bottom-end" width={300}>
            <Menu.Target>
              <Button size="xs" variant="default" rightSection={<IconChevronDown size={14} />} data-testid="processes-more">
                {t('more')}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {caps.createProcesses && (
                <>
                  <Menu.Item leftSection={<IconChecklist size={14} />} onClick={() => setNewStart('manual')}>
                    {t('newManualProcedure')}
                    <Text size="xs" c="dimmed">
                      {t('newManualProcedureHint')}
                    </Text>
                  </Menu.Item>
                  <Menu.Item leftSection={<IconUpload size={14} />} onClick={importModal.open}>
                    {t('importYaml')}
                  </Menu.Item>
                  <Menu.Divider />
                </>
              )}
              <Menu.Label>{t('bundle.label')}</Menu.Label>
              <Menu.Item leftSection={<IconPackageExport size={14} />} component="a" href={apiUrl('/bundle/export')}>
                {t('bundle.exportAll')}
              </Menu.Item>
              {caps.createProcesses && (
                <Menu.Item leftSection={<IconPackageImport size={14} />} onClick={bundleModal.open}>
                  {t('bundle.importMenu')}
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
          {caps.createProcesses && (
            <>
              <Button size="xs" variant="light" leftSection={<IconTemplate size={14} />} onClick={templates.open}>
                {t('fromTemplate')}
              </Button>
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setNewStart('blank')}>
                {t('newProcess')}
              </Button>
            </>
          )}
        </>
      }
      search={{ value: filter, onChange: (v) => set('q', v || null), placeholder: t('search') }}
      activeFilters={active}
      filters={
        processes.data?.length ? (
          <Group gap="sm" mb="md" align="flex-end" wrap="wrap" data-testid="process-filters">
            <MultiSelect
              size="xs"
              label={t('list.lastRun')}
              data={LAST_RUN_FILTERS.map((x) => ({ value: x, label: t(`list.lastRunFilter.${x}`) }))}
              value={last}
              onChange={(v) => set('last', v)}
              clearable
              w={{ base: '100%', xs: 240 }}
            />
            <Select
              size="xs"
              label={t('list.schedule')}
              data={[
                { value: 'yes', label: t('list.scheduledYes') },
                { value: 'no', label: t('list.scheduledNo') },
              ]}
              value={scheduled}
              onChange={(v) => set('scheduled', v)}
              clearable
              w={{ base: '100%', xs: 200 }}
            />
          </Group>
        ) : undefined
      }
      empty={{
        show: processes.data?.length === 0,
        icon: IconSitemap,
        title: t('empty.title'),
        text: (
          <>
            {t('empty.text')}
            {!caps.createProcesses && <div>{t('empty.askForAccess')}</div>}
          </>
        ),
        whoCanAct: t('common:whoCanAct.processes'),
        action: caps.createProcesses && (
          <Button onClick={templates.open} leftSection={<IconTemplate size={16} />}>
            {t('empty.browse')}
          </Button>
        ),
      }}
    >
      <Box mb={tag ? 'md' : 0}>
        <TagFilterChip tag={tag} onChange={setTag} />
      </Box>
      <QueryState query={processes} />
      {!!processes.data?.length && list.length === 0 && (
        <Text c="dimmed" size="sm">
          {t('list.noMatch')}
        </Text>
      )}
      {list.length > 0 &&
        (view.cards && !narrow ? (
          // the card view on wide screens: the grid of before (descriptions in full)
          <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} role="list" aria-label={t('title')} data-testid="process-list">
            {list.map((p) => (
              <div role="listitem" key={p.id}>
                <ProcessCard p={p} actions={actionsOf(p)} badges={badgesOf(p)} onTag={setTag} />
              </div>
            ))}
          </SimpleGrid>
        ) : (
          <DataTable
            rows={list}
            columns={columns}
            rowKey={(p) => p.id}
            ariaLabel={t('title')}
            rowHref={(p) => `/processes/${p.id}`}
            testId="process-list"
            verticalSpacing={6}
            rememberSort="processes"
            defaultSort={{ key: 'name', dir: 'asc' }}
            footer={<ListFooter shown={list.length} total={processes.data?.length} />}
            card={(p) => <ProcessCard p={p} actions={actionsOf(p)} badges={badgesOf(p)} onTag={setTag} />}
          />
        ))}
      <RunDialog processId={runId} opened={!!runId} onClose={() => setRunId(null)} />
      <TemplateGallery opened={templatesOpen} onClose={templates.close} initialKind={galleryKind || null} initialBundle={galleryBundle} />
      <NewProcessModal opened={newStart !== null} initialStart={newStart ?? 'blank'} onClose={() => setNewStart(null)} />
      <ImportModal opened={importOpen} onClose={importModal.close} />
      <BundleImportModal opened={bundleOpen} onClose={bundleModal.close} />
      {duplicate.dialog}
    </ListPage>
  );
}

/** A process as a card: the phone list and the card view. */
function ProcessCard({ p, actions, badges, onTag }: { p: ProcessSummary; actions: ReactNode; badges: ReactNode; onTag: (tag: string) => void }) {
  const { t } = useTranslation('processes');
  const navigate = useNavigate();
  return (
    <Card withBorder padding="md" className="clickable" onClick={() => navigate(`/processes/${p.id}`)} h="100%">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Anchor
          component={Link}
          to={`/processes/${p.id}`}
          fw={600}
          c="var(--mantine-color-text)"
          underline="hover"
          style={{ minWidth: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          {p.name}
        </Anchor>
        {actions}
      </Group>
      <DescriptionText text={p.description} size="sm" c="dimmed" lineClamp={3} mt={4} />
      <Group gap={4} mt="sm">
        <Badge size="xs" variant="outline">
          v{p.currentVersion}
        </Badge>
        {badges}
        <TagBadges tags={p.tags} onTag={onTag} />
        {p.lastRun && (
          <>
            <Text size="xs" c="dimmed" ml="auto">
              {t('card.lastRun', { when: fmtRelative(p.lastRun.startedAt) })}
            </Text>
            <StatusBadge status={p.lastRun.outcome ?? p.lastRun.status} size="xs" />
          </>
        )}
      </Group>
    </Card>
  );
}

function ImportModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation('processes');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ file: string; ok: boolean; message: string }[] | null>(null);

  const importFiles = async (files: File[]) => {
    if (files.length === 1) {
      setText(await files[0]!.text());
      return;
    }
    setBusy(true);
    const out: { file: string; ok: boolean; message: string }[] = [];
    for (const f of files) {
      try {
        const p = await post<ProcessDetail>('/processes', { text: await f.text() });
        out.push({ file: f.name, ok: true, message: t('import.created', { name: p.name }) });
      } catch (e) {
        out.push({ file: f.name, ok: false, message: errorText(e) });
      }
    }
    setResults(out);
    setBusy(false);
    qc.invalidateQueries({ queryKey: processKeys.all });
    const okCount = out.filter((r) => r.ok).length;
    if (okCount) notifyOk(t('import.imported', { count: okCount, total: out.length }));
  };
  // FormModal is mounted while open: it asks before Esc or Cancel discard what was entered
  if (!opened) return null;
  return (
    <FormModal onClose={onClose} title={t('import.title')} size="lg">
      <Stack>
        <Text size="xs" c="dimmed">
          {t('import.hint')}
        </Text>
        <Textarea
          classNames={{ input: 'mono' }}
          autosize
          minRows={10}
          maxRows={24}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder="name: My process&#10;steps: []"
        />
        {results && (
          <Alert color={results.every((r) => r.ok) ? 'green' : 'orange'} title={t('import.result')} withCloseButton onClose={() => setResults(null)}>
            <List size="sm" spacing={2}>
              {results.map((r) => (
                <List.Item key={r.file}>
                  <b>{r.file}</b>: {r.ok ? r.message : t('import.failedItem', { message: r.message })}
                </List.Item>
              ))}
            </List>
          </Alert>
        )}
        <Group justify="space-between">
          <Button variant="default" size="xs" component="label" leftSection={<IconUpload size={14} />}>
            {t('import.loadFiles')}
            <input
              type="file"
              accept=".yaml,.yml,.json"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.currentTarget.files ?? []);
                e.currentTarget.value = '';
                if (files.length) importFiles(files);
              }}
            />
          </Button>
          <Button
            loading={busy}
            disabled={!text.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const p = await post<ProcessDetail>('/processes', { text });
                onClose();
                navigate(`/processes/${p.id}`);
              } catch (e) {
                notifyError(e, t('import.failed'));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('import.submit')}
          </Button>
        </Group>
      </Stack>
    </FormModal>
  );
}

function BundleImportModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation('processes');
  const qc = useQueryClient();
  const [bundle, setBundle] = useState<ExportBundle | null>(null);
  const [fileName, setFileName] = useState('');
  const [onConflict, setOnConflict] = useState<'newVersion' | 'skip' | 'copy'>('newVersion');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: string[]; updated: string[]; skipped: { id: string; reason: string }[] } | null>(null);
  const reset = () => {
    setBundle(null);
    setFileName('');
    setResult(null);
  };
  return (
    <Modal
      opened={opened}
      onClose={() => {
        reset();
        onClose();
      }}
      title={t('bundle.importTitle')}
      size="lg"
    >
      <Stack>
        <Text size="sm" c="dimmed">
          {t('bundle.hint')}
        </Text>
        <Group>
          <Button variant="default" size="xs" component="label" leftSection={<IconUpload size={14} />}>
            {t('bundle.choose')}
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={async (e) => {
                const f = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (!f) return;
                try {
                  const parsed = JSON.parse(await f.text()) as ExportBundle;
                  if (!(BUNDLE_FORMATS as readonly string[]).includes(parsed.format)) throw new Error(t('bundle.notABundle', { brand: BRAND.name }));
                  setBundle(parsed);
                  setFileName(f.name);
                  setResult(null);
                } catch (err) {
                  notifyError(err, t('bundle.cannotRead'));
                }
              }}
            />
          </Button>
          {fileName && <Text size="sm">{fileName}</Text>}
        </Group>
        {bundle && (
          <>
            <Text size="sm">
              {t('bundle.summary', {
                processes: t('bundle.processes', { count: bundle.processes.length }),
                dashboards: t('bundle.dashboards', { count: bundle.dashboards.length }),
                when: fmtRelative(bundle.exportedAt),
              })}
            </Text>
            <div>
              <Text size="sm" fw={500} mb={4}>
                {t('bundle.conflict')}
              </Text>
              <SegmentedControl
                size="xs"
                value={onConflict}
                onChange={(v) => setOnConflict(v as typeof onConflict)}
                data={[
                  { value: 'newVersion', label: t('bundle.newVersion') },
                  { value: 'skip', label: t('bundle.skip') },
                  { value: 'copy', label: t('bundle.copy') },
                ]}
              />
            </div>
          </>
        )}
        {result && (
          <Alert color={result.skipped.length ? 'orange' : 'green'} title={t('import.result')}>
            <Text size="sm">{t('bundle.result', { created: result.created.length, updated: result.updated.length, skipped: result.skipped.length })}</Text>
            {result.skipped.length > 0 && (
              <List size="sm" mt={4}>
                {result.skipped.map((x) => (
                  <List.Item key={x.id}>
                    {x.id}: {x.reason}
                  </List.Item>
                ))}
              </List>
            )}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button
            disabled={!bundle}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post<{ created: string[]; updated: string[]; skipped: { id: string; reason: string }[] }>('/bundle/import', {
                  bundle,
                  onConflict,
                });
                setResult(r);
                qc.invalidateQueries({ queryKey: processKeys.all });
                qc.invalidateQueries({ queryKey: dashboardKeys.all });
              } catch (e) {
                notifyError(e, t('import.failed'));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('import.submit')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
