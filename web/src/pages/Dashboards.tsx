import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ActionIcon, Anchor, Badge, Button, Card, Group, Modal, SimpleGrid, Stack, Table, Text, Textarea, Title, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconChartBar, IconFlask, IconPlus, IconTemplate, IconTrash, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { Dashboard, DashboardDefinition, DatasetMeta } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../api';
import { EmptyState, PageHeader, QueryState } from '../components/common';
import { fmtNumber, fmtRelative } from '../format';
import { useMe } from '../auth';
import { StatusCounts } from '../components/dashboard/status';
import { confirmDanger } from '../components/confirm';
import '../components/dashboard/viz.css';

interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  definition: DashboardDefinition;
}

export function DashboardsPage() {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { caps, isAdmin } = useMe();
  const dashboards = useQuery({ queryKey: ['dashboards'], queryFn: () => get<Dashboard[]>('/dashboards') });
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => get<DatasetMeta[]>('/datasets'), refetchInterval: 30000 });
  const [templatesOpen, templates] = useDisclosure();
  const [importOpen, importModal] = useDisclosure();

  const createBlank = async () => {
    try {
      const d = await post<Dashboard>('/dashboards', { definition: { name: t('list.newName'), widgets: [] } });
      qc.invalidateQueries({ queryKey: ['dashboards'] });
      navigate(`/dashboards/${d.id}`);
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={
          caps.createProcesses && (
            <>
              <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} onClick={importModal.open}>
                {t('list.importYaml')}
              </Button>
              <Button size="xs" variant="light" leftSection={<IconTemplate size={14} />} onClick={templates.open}>
                {t('list.fromTemplate')}
              </Button>
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={createBlank}>
                {t('list.new')}
              </Button>
            </>
          )
        }
      />
      <QueryState query={dashboards} rows={2} />
      {dashboards.data?.length === 0 && (
        <EmptyState
          icon={IconChartBar}
          title={t('list.emptyTitle')}
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
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} mb="xl">
        {dashboards.data?.map((d) => (
          <Card key={d.id} withBorder className="clickable" onClick={() => navigate(`/dashboards/${d.id}`)}>
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
        ))}
      </SimpleGrid>

      <Title order={4} mb={4}>
        {t('datasets.title')}
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        {t('datasets.hint', { node: t('editor:steps.publish.label') })}
      </Text>
      <div className="table-scroll">
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
                          qc.invalidateQueries({ queryKey: ['datasets'] });
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
      </div>

      <TemplatesModal opened={templatesOpen} onClose={templates.close} />
      <ImportModal opened={importOpen} onClose={importModal.close} />
    </>
  );
}

function TemplatesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation('dashboards');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['dashboard-templates'], queryFn: () => get<DashboardTemplate[]>('/dashboard-templates'), enabled: opened });
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
                    qc.invalidateQueries({ queryKey: ['dashboards'] });
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
                qc.invalidateQueries({ queryKey: ['dashboards'] });
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
