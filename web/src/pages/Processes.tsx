import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  Modal,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  ActionIcon,
  Tooltip,
  Menu,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconPlayerPlay,
  IconPlus,
  IconSearch,
  IconTemplate,
  IconUpload,
  IconDots,
  IconArchive,
  IconFileExport,
  IconPackage,
  IconPackageExport,
  IconPackageImport,
  IconSitemap,
  IconChecklist,
} from '@tabler/icons-react';
import { BUNDLE_FORMATS, type ExportBundle, type ProcessDetail, type ProcessSummary, type ProcessTemplate } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, apiUrl } from '../api';
import { EmptyState, PageHeader, QueryState, StatusBadge } from '../components/common';
import { GitOriginBadge } from '../components/gitsync/GitOriginBadge';
import { RunDialog } from '../components/RunDialog';
import { fmtRelative } from '../format';
import { errorText } from '../i18n/errors';
import { BRAND } from '../../../shared/src/brand';
import { useMe } from '../auth';
import { confirmDanger } from '../components/confirm';

export function ProcessesPage() {
  const { t } = useTranslation(['processes', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const [filter, setFilter] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [templatesOpen, templates] = useDisclosure();
  const [importOpen, importModal] = useDisclosure();
  const [bundleOpen, bundleModal] = useDisclosure();
  const { caps } = useMe();

  const createBlank = async () => {
    try {
      const p = await post<ProcessDetail>('/processes', {
        definition: {
          name: t('newProcessName'),
          description: '',
          connections: [],
          inputs: [],
          nodes: [{ id: 'start', type: 'start', name: 'Start', x: 0, y: 0 }],
          wires: [],
        },
      });
      navigate(`/processes/${p.id}`);
    } catch (e) {
      notifyError(e);
    }
  };

  /** A process of manual steps only, ready to fill in (the "Manual procedure" template). */
  const createManual = async () => {
    const step = (id: string, x: number, title: string, extra: Record<string, unknown>) => ({
      id,
      type: 'userTask',
      mode: 'manual',
      name: title,
      title,
      instructions: t('manualTemplate.instructions'),
      x,
      y: 0,
      ...extra,
    });
    try {
      const p = await post<ProcessDetail>('/processes', {
        definition: {
          name: t('manualTemplate.name'),
          description: t('manualTemplate.description'),
          tags: ['manual'],
          connections: [],
          inputs: [],
          nodes: [
            { id: 'start', type: 'start', name: 'Start', x: 0, y: 0 },
            step('prepare', 260, t('manualTemplate.prepare'), { checklist: [t('manualTemplate.prepareItem1'), t('manualTemplate.prepareItem2')] }),
            step('carryOut', 520, t('manualTemplate.carryOut'), {
              checklist: [t('manualTemplate.carryOutItem1')],
              fields: [{ id: 'ticket', type: 'ticket', label: t('manualTemplate.ticket'), use: 'required' }],
              verification: { required: true },
            }),
            step('check', 780, t('manualTemplate.check'), { checklist: [t('manualTemplate.checkItem1')], checklistAllRequired: true }),
          ],
          wires: [
            { from: 'start', port: 'out', to: 'prepare' },
            { from: 'prepare', port: 'out', to: 'carryOut' },
            { from: 'carryOut', port: 'out', to: 'check' },
          ],
        },
      });
      navigate(`/processes/${p.id}`);
    } catch (e) {
      notifyError(e);
    }
  };

  const f = filter.toLowerCase();
  const list = (processes.data ?? []).filter((p) => !f || p.name.toLowerCase().includes(f) || p.tags.some((tag) => tag.includes(f)));

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Menu position="bottom-end">
              <Menu.Target>
                <Button size="xs" variant="default" leftSection={<IconPackage size={14} />}>
                  {t('bundle.button')}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
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
                <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} onClick={importModal.open}>
                  {t('importYaml')}
                </Button>
                <Button size="xs" variant="light" leftSection={<IconTemplate size={14} />} onClick={templates.open}>
                  {t('fromTemplate')}
                </Button>
                <Button size="xs" variant="default" leftSection={<IconChecklist size={14} />} onClick={createManual}>
                  {t('newManualProcedure')}
                </Button>
                <Button size="xs" leftSection={<IconPlus size={14} />} onClick={createBlank}>
                  {t('newProcess')}
                </Button>
              </>
            )}
          </>
        }
      />
      <TextInput
        mb="md"
        placeholder={t('search')}
        leftSection={<IconSearch size={14} />}
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
        maw={360}
      />
      <QueryState query={processes} />
      {processes.data?.length === 0 && (
        <EmptyState
          icon={IconSitemap}
          title={t('empty.title')}
          action={
            caps.createProcesses && (
              <Button onClick={templates.open} leftSection={<IconTemplate size={16} />}>
                {t('empty.browse')}
              </Button>
            )
          }
        >
          {t('empty.text')}
          {!caps.createProcesses && <div>{t('empty.askForAccess')}</div>}
        </EmptyState>
      )}
      <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>
        {list.map((p) => (
          <Card key={p.id} withBorder padding="md" className="clickable" onClick={() => navigate(`/processes/${p.id}`)}>
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
                    {p.permissions.includes('manage') && (
                      <Menu.Item
                        color="red"
                        leftSection={<IconArchive size={14} />}
                        onClick={async () => {
                          if (!(await confirmDanger({ action: 'archive', message: t('card.archiveConfirm', { name: p.name }) }))) return;
                          await del(`/processes/${p.id}`).catch(notifyError);
                          qc.invalidateQueries({ queryKey: ['processes'] });
                        }}
                      >
                        {t('card.archive')}
                      </Menu.Item>
                    )}
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </Group>
            <Text size="sm" c="dimmed" lineClamp={3} mt={4} style={{ whiteSpace: 'pre-line' }}>
              {p.description}
            </Text>
            <Group gap={4} mt="sm">
              <Badge size="xs" variant="outline">
                v{p.currentVersion}
              </Badge>
              <GitOriginBadge kind="process" id={p.id} size="xs" />
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
              {p.tags.map((tag) => (
                <Badge key={tag} size="xs" variant="light" color="gray">
                  {tag}
                </Badge>
              ))}
              {p.lastRun && (
                <>
                  <Text size="xs" c="dimmed" ml="auto">
                    {t('card.lastRun', { when: fmtRelative(p.lastRun.startedAt) })}
                  </Text>
                  <StatusBadge status={p.lastRun.status} size="xs" />
                </>
              )}
            </Group>
          </Card>
        ))}
      </SimpleGrid>
      <RunDialog processId={runId} opened={!!runId} onClose={() => setRunId(null)} />
      <TemplatesModal opened={templatesOpen} onClose={templates.close} />
      <ImportModal opened={importOpen} onClose={importModal.close} />
      <BundleImportModal opened={bundleOpen} onClose={bundleModal.close} />
    </>
  );
}

function TemplatesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation('processes');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => get<ProcessTemplate[]>('/templates'), enabled: opened });
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Modal opened={opened} onClose={onClose} title={t('templates.title')} size="xl">
      <Stack>
        {templates.data?.map((tpl) => (
          <Card key={tpl.id} withBorder padding="sm">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div style={{ minWidth: 0 }}>
                <Text fw={600}>{tpl.name}</Text>
                <Text size="sm" c="dimmed" lineClamp={4} style={{ whiteSpace: 'pre-line' }}>
                  {tpl.description}
                </Text>
                <Group gap={4} mt={6}>
                  {tpl.tags.map((tag) => (
                    <Badge key={tag} size="xs" variant="light" color="gray">
                      {tag}
                    </Badge>
                  ))}
                  <Badge size="xs" variant="outline">
                    {t('templates.steps', { count: (tpl.definition.nodes ?? []).filter((n) => n.type !== 'start' && n.type !== 'note').length })}
                  </Badge>
                </Group>
              </div>
              <Button
                size="xs"
                aria-label={t('templates.useNamed', { name: tpl.name })}
                loading={busy === tpl.id}
                onClick={async () => {
                  setBusy(tpl.id);
                  try {
                    const p = await post<ProcessDetail>('/processes', { templateId: tpl.id });
                    qc.invalidateQueries({ queryKey: ['processes'] });
                    notifyOk(t('templates.created', { name: p.name }));
                    onClose();
                    navigate(`/processes/${p.id}`);
                  } catch (e) {
                    notifyError(e);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {t('templates.use')}
              </Button>
            </Group>
          </Card>
        ))}
      </Stack>
    </Modal>
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
    qc.invalidateQueries({ queryKey: ['processes'] });
    const okCount = out.filter((r) => r.ok).length;
    if (okCount) notifyOk(t('import.imported', { count: okCount, total: out.length }));
  };
  return (
    <Modal opened={opened} onClose={onClose} title={t('import.title')} size="lg">
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
    </Modal>
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
                qc.invalidateQueries({ queryKey: ['processes'] });
                qc.invalidateQueries({ queryKey: ['dashboards'] });
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
