import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Modal,
  MultiSelect,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconChartBar, IconFlask, IconPlus, IconTemplate, IconTrash, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { Dashboard, DashboardDefinition, DatasetMeta, NewResourceTeams, Team } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { EmptyState, QueryState } from '../components/common';
import { fmtDate, fmtNumber, fmtRelative } from '../format';
import { useMe } from '../auth';
import { StatusCounts } from '../components/dashboard/status';
import { confirmDanger } from '../components/confirm';
import '../components/dashboard/viz.css';
import { ListPage, useStoredListView } from '../components/page/ListPage';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { dashboardKeys, datasetKeys } from '../queryKeys';
import { RestrictedEmpty, useHiddenByPermissions } from '../components/modules/RestrictedEmpty';
import { TableScroll } from '../components/TableScroll';

interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  definition: DashboardDefinition;
}

export function DashboardsPage() {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const qc = useQueryClient();
  const { caps, isAdmin } = useMe();
  const dashboards = useQuery({ queryKey: dashboardKeys.all, queryFn: () => get<Dashboard[]>('/dashboards') });
  // entries the person may not see (U3): "nothing you may see" instead of "nothing yet"
  const hidden = useHiddenByPermissions('dashboards');
  const datasets = useQuery({ queryKey: datasetKeys.all, queryFn: () => get<DatasetMeta[]>('/datasets'), refetchInterval: 30000 });
  const [templatesOpen, templates] = useDisclosure();
  const [importOpen, importModal] = useDisclosure();
  const [newOpen, newModal] = useDisclosure();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const view = useStoredListView('dashboards', narrow);
  // the search lives in the address (?q=), so a filtered list can be shared
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const needle = q.trim().toLowerCase();
  const shown = (dashboards.data ?? []).filter((d) => !needle || [d.name, d.description, d.owner ?? '', d.id].some((x) => x.toLowerCase().includes(needle)));
  const columns: DataColumn<Dashboard>[] = [
    {
      key: 'name',
      header: t('list.name'),
      sortValue: (d) => d.name,
      cell: (d) => (
        <Stack gap={2} maw={560}>
          <Anchor component={Link} to={`/dashboards/${d.id}`} fw={600} size="sm" onClick={(e) => e.stopPropagation()}>
            {d.name}
          </Anchor>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {d.description}
          </Text>
        </Stack>
      ),
    },
    { key: 'widgets', header: t('list.widgetsColumn'), sortValue: (d) => d.definition.widgets.length, nowrap: true, cell: (d) => d.definition.widgets.length },
    { key: 'owner', header: t('list.owner'), sortValue: (d) => d.owner ?? '', cell: (d) => d.owner ?? '–' },
    {
      key: 'updated',
      header: t('list.updatedColumn'),
      sortValue: (d) => d.updatedAt,
      nowrap: true,
      cell: (d) => (
        <Text size="xs" title={fmtDate(d.updatedAt)}>
          {fmtRelative(d.updatedAt)}
        </Text>
      ),
    },
  ];

  return (
    <ListPage
      title={t('list.title')}
      description={t('list.description')}
      view="dashboards"
      viewState={view}
      search={
        dashboards.data?.length
          ? {
              value: q,
              onChange: (v) => setParams(v ? { q: v } : {}, { replace: true }),
              placeholder: t('list.search'),
            }
          : undefined
      }
      actions={
        caps.createProcesses && (
          <>
            <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} onClick={importModal.open}>
              {t('list.importYaml')}
            </Button>
            <Button size="xs" variant="light" leftSection={<IconTemplate size={14} />} onClick={templates.open}>
              {t('list.fromTemplate')}
            </Button>
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={newModal.open}>
              {t('list.new')}
            </Button>
          </>
        )
      }
    >
      <QueryState query={dashboards} rows={2} />
      {dashboards.data?.length === 0 && hidden && <RestrictedEmpty />}
      {dashboards.data?.length === 0 && !hidden && (
        <EmptyState
          icon={IconChartBar}
          title={t('list.emptyTitle')}
          whoCanAct={t('common:whoCanAct.dashboards')}
          action={
            caps.createProcesses && (
              <Button leftSection={<IconTemplate size={16} />} onClick={templates.open}>
                {t('list.emptyAction')}
              </Button>
            )
          }
        >
          {t('list.emptyText')}
        </EmptyState>
      )}
      {!!dashboards.data?.length && shown.length === 0 && (
        <Text c="dimmed" size="sm" mb="xl">
          {t('list.noMatch')}
        </Text>
      )}
      {shown.length > 0 && (
        <Box mb="xl">
          {view.cards && !narrow ? (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} role="list" aria-label={t('list.title')} data-testid="dashboard-list">
              {shown.map((d) => (
                <div role="listitem" key={d.id}>
                  <DashboardCard d={d} />
                </div>
              ))}
            </SimpleGrid>
          ) : (
            <DataTable
              rows={shown}
              columns={columns}
              rowKey={(d) => d.id}
              ariaLabel={t('list.title')}
              rowHref={(d) => `/dashboards/${d.id}`}
              testId="dashboard-list"
              rememberSort="dashboards"
              defaultSort={{ key: 'name', dir: 'asc' }}
              footer={<ListFooter shown={shown.length} total={dashboards.data?.length} />}
              card={(d) => <DashboardCard d={d} />}
            />
          )}
        </Box>
      )}

      <Title order={4} mb={4}>
        {t('datasets.title')}
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        {t('datasets.hint', { node: t('editor:steps.publish.label') })}
      </Text>
      <TableScroll>
        <Table fz="sm" highlightOnHover className="viz-root">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('datasets.dataset')}</Table.Th>
              <Table.Th>{t('datasets.source')}</Table.Th>
              <Table.Th>{t('datasets.updated')}</Table.Th>
              <Table.Th ta="right">{t('datasets.rows')}</Table.Th>
              <Table.Th>{t('datasets.status')}</Table.Th>
              {isAdmin && <Table.Th />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {datasets.data?.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={6}>
                  <Text size="sm" c="dimmed">
                    {t('datasets.none', { node: t('editor:steps.publish.label') })}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {datasets.data?.map((m) => (
              <Table.Tr key={m.key}>
                <Table.Td>
                  <Text size="sm">{m.title}</Text>
                  <Text size="xs" c="dimmed" className="mono">
                    {m.key}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Anchor component={Link} to={`/processes/${m.processId}`} size="sm">
                    {m.processName}
                  </Anchor>
                </Table.Td>
                <Table.Td className="nowrap">
                  <Anchor component={Link} to={`/runs/${m.runId}`} size="sm" c="inherit">
                    {fmtRelative(m.updatedAt)}
                  </Anchor>
                  <Group gap={4} mt={2}>
                    {m.stale && (
                      <Badge size="xs" color="yellow" variant="light" leftSection={<IconAlertTriangle size={10} />}>
                        {t('datasets.stale')}
                      </Badge>
                    )}
                    {m.dryRun && (
                      <Badge size="xs" color="gray" variant="light" leftSection={<IconFlask size={10} />}>
                        {t('common:status.dryrun')}
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td ta="right" className="viz-num">
                  {fmtNumber(m.rowCount)}
                </Table.Td>
                <Table.Td>
                  <StatusCounts counts={m.statusCounts} />
                </Table.Td>
                {isAdmin && (
                  <Table.Td>
                    <Tooltip label={t('datasets.deleteHint')}>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={t('datasets.delete')}
                        onClick={async () => {
                          if (!(await confirmDanger({ action: 'delete', message: t('datasets.deleteConfirm', { key: m.key, process: m.processName }) })))
                            return;
                          await del(`/datasets/${encodeURIComponent(m.key)}`).catch(notifyError);
                          qc.invalidateQueries({ queryKey: datasetKeys.all });
                        }}
                      >
                        <IconTrash size={15} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </TableScroll>

      <TemplatesModal opened={templatesOpen} onClose={templates.close} />
      <ImportModal opened={importOpen} onClose={importModal.close} />
      <NewDashboardModal opened={newOpen} onClose={newModal.close} />
    </ListPage>
  );
}

/**
 * "New dashboard": a name, the owning teams (administrators choose; for others the teams their new resources get) and
 * a start – blank or a copy of a template – then the dashboard opens in edit mode.
 */
/** A dashboard as a card: the phone list and the card view. */
function DashboardCard({ d }: { d: Dashboard }) {
  const { t } = useTranslation('dashboards');
  const navigate = useNavigate();
  return (
    <Card withBorder className="clickable" onClick={() => navigate(`/dashboards/${d.id}`)}>
      <Anchor component={Link} to={`/dashboards/${d.id}`} fw={600} c="var(--mantine-color-text)" underline="hover" onClick={(e) => e.stopPropagation()}>
        {d.name}
      </Anchor>
      <Text size="sm" c="dimmed" lineClamp={3}>
        {d.description || ' '}
      </Text>
      <Group gap={6} mt="sm">
        <Badge size="xs" variant="outline">
          {t('list.widgets', { count: d.definition.widgets.length })}
        </Badge>
        {d.owner && (
          <Text size="xs" c="dimmed">
            {t('list.by', { owner: d.owner })}
          </Text>
        )}
        <Text size="xs" c="dimmed" ml="auto">
          {t('list.updated', { when: fmtRelative(d.updatedAt) })}
        </Text>
      </Group>
    </Card>
  );
}

function NewDashboardModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation(['dashboards', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { isAdmin } = useMe();
  const [name, setName] = useState('');
  const [start, setStart] = useState<'blank' | 'template'>('blank');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const list = useQuery({ queryKey: dashboardKeys.templates, queryFn: () => get<DashboardTemplate[]>('/dashboard-templates'), enabled: opened });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => get<Team[]>('/teams'), enabled: opened && isAdmin });
  const mine = useQuery({ queryKey: ['new-resource-teams'], queryFn: () => get<NewResourceTeams>('/me/new-resource-teams'), enabled: opened && !isAdmin });
  const tpl = list.data?.find((x) => x.id === templateId);
  const nameError = tried && !name.trim() ? t('common:validation.required') : undefined;
  const templateError = tried && start === 'template' && !tpl ? t('common:validation.required') : undefined;
  const close = () => {
    setName('');
    setStart('blank');
    setTemplateId(null);
    setTeamIds([]);
    setTried(false);
    onClose();
  };
  const create = async () => {
    setTried(true);
    if (!name.trim() || (start === 'template' && !tpl)) return;
    setBusy(true);
    try {
      const definition = start === 'template' && tpl ? { ...structuredClone(tpl.definition), name: name.trim() } : { name: name.trim(), widgets: [] };
      const d = await post<Dashboard>('/dashboards', { definition });
      if (isAdmin && teamIds.length) await put(`/owning-teams/dashboard/${d.id}`, { teamIds }).catch(notifyError);
      qc.invalidateQueries({ queryKey: dashboardKeys.all });
      close();
      // straight into edit mode
      navigate(`/dashboards/${d.id}?edit=1`);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={close} title={t('create.title')} size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Stack>
          <TextInput data-autofocus label={t('create.name')} withAsterisk value={name} onChange={(e) => setName(e.currentTarget.value)} error={nameError} />
          {isAdmin ? (
            <MultiSelect
              label={t('create.teams')}
              description={t('create.teamsHint')}
              placeholder={teamIds.length ? undefined : t('create.wholeInstance')}
              data={(teams.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
              value={teamIds}
              onChange={setTeamIds}
              searchable
              clearable
            />
          ) : (
            <div>
              <Text size="sm" fw={500}>
                {t('create.teams')}
              </Text>
              <Text size="sm" c="dimmed">
                {mine.data?.teams.length ? t('create.yourTeams', { teams: mine.data.teams.map((x) => x.name).join(', ') }) : t('create.wholeInstanceText')}
              </Text>
            </div>
          )}
          <div>
            <Text size="sm" fw={500} mb={4}>
              {t('create.start')}
            </Text>
            <SegmentedControl
              value={start}
              onChange={(v) => setStart(v as typeof start)}
              data={[
                { value: 'blank', label: t('create.blank') },
                { value: 'template', label: t('create.fromTemplate') },
              ]}
            />
          </div>
          {start === 'template' && (
            <Select
              label={t('create.template')}
              withAsterisk
              searchable
              data={(list.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
              value={templateId}
              onChange={(v) => {
                setTemplateId(v);
                const found = list.data?.find((x) => x.id === v);
                if (found && !name.trim()) setName(found.name);
              }}
              error={templateError}
              description={tpl ? `${tpl.description} · ${t('list.widgets', { count: tpl.definition.widgets.length })}` : undefined}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} leftSection={<IconPlus size={14} />}>
              {t('create.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function TemplatesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation('dashboards');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: dashboardKeys.templates, queryFn: () => get<DashboardTemplate[]>('/dashboard-templates'), enabled: opened });
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Modal opened={opened} onClose={onClose} title={t('templates.title')} size="lg">
      <Stack>
        {list.data?.length === 0 && <Text c="dimmed">{t('templates.none')}</Text>}
        {list.data?.map((tpl) => (
          <Card key={tpl.id} withBorder padding="sm">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div style={{ minWidth: 0 }}>
                <Text fw={600}>{tpl.name}</Text>
                <Text size="sm" c="dimmed" lineClamp={3}>
                  {tpl.description}
                </Text>
                <Badge size="xs" variant="outline" mt={6}>
                  {t('list.widgets', { count: tpl.definition.widgets.length })}
                </Badge>
              </div>
              <Button
                size="xs"
                loading={busy === tpl.id}
                onClick={async () => {
                  setBusy(tpl.id);
                  try {
                    const d = await post<Dashboard>('/dashboards', { templateId: tpl.id });
                    qc.invalidateQueries({ queryKey: dashboardKeys.all });
                    notifyOk(t('templates.created', { name: d.name }));
                    onClose();
                    navigate(`/dashboards/${d.id}`);
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
  const { t } = useTranslation('dashboards');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened={opened} onClose={onClose} title={t('import.title')} size="lg">
      <Stack>
        <Textarea
          classNames={{ input: 'mono' }}
          autosize
          minRows={10}
          maxRows={24}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder={'name: My dashboard\nwidgets:\n  - { id: w1, type: kpi, dataset: iem.devices }'}
        />
        <Group justify="space-between">
          <Button variant="default" size="xs" component="label" leftSection={<IconUpload size={14} />}>
            {t('import.loadFile')}
            <input type="file" accept=".yaml,.yml,.json" hidden onChange={(e) => e.currentTarget.files?.[0]?.text().then(setText)} />
          </Button>
          <Button
            loading={busy}
            disabled={!text.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const d = await post<Dashboard>('/dashboards', { text });
                qc.invalidateQueries({ queryKey: dashboardKeys.all });
                onClose();
                navigate(`/dashboards/${d.id}`);
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
