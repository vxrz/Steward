import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ActionIcon, Anchor, Badge, Button, Card, Group, Modal, SimpleGrid, Stack, Table, Text, Textarea, Title, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconFlask, IconPlus, IconTemplate, IconTrash, IconUpload } from '@tabler/icons-react';
import type { Dashboard, DashboardDefinition, DatasetMeta } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../api';
import { PageHeader } from '../components/common';
import { fmtRelative } from '../format';
import { useMe } from '../auth';
import { StatusCounts } from '../components/dashboard/status';
import '../components/dashboard/viz.css';

interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  definition: DashboardDefinition;
}

export function DashboardsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { caps, isAdmin } = useMe();
  const dashboards = useQuery({ queryKey: ['dashboards'], queryFn: () => get<Dashboard[]>('/dashboards') });
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => get<DatasetMeta[]>('/datasets'), refetchInterval: 30000 });
  const [templatesOpen, templates] = useDisclosure();
  const [importOpen, importModal] = useDisclosure();

  const createBlank = async () => {
    try {
      const d = await post<Dashboard>('/dashboards', { definition: { name: 'New dashboard', widgets: [] } });
      qc.invalidateQueries({ queryKey: ['dashboards'] });
      navigate(`/dashboards/${d.id}`);
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <PageHeader
        title="Dashboards"
        description="Status overviews built from data that your processes publish (once, on demand or on a schedule). Dashboards only read stored data – they never call the platforms themselves."
        actions={
          caps.createProcesses && (
            <>
              <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} onClick={importModal.open}>
                Import YAML
              </Button>
              <Button size="xs" variant="light" leftSection={<IconTemplate size={14} />} onClick={templates.open}>
                From template
              </Button>
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={createBlank}>
                New dashboard
              </Button>
            </>
          )
        }
      />
      {dashboards.data?.length === 0 && (
        <Card withBorder p="lg" mb="md">
          <Text fw={600}>No dashboards yet</Text>
          <Text size="sm" c="dimmed">
            Start from a template (e.g. platform operations), then run the inventory processes that feed it – or schedule them so the data stays fresh.
          </Text>
        </Card>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} mb="xl">
        {dashboards.data?.map((d) => (
          <Card key={d.id} withBorder className="clickable" onClick={() => navigate(`/dashboards/${d.id}`)}>
            <Text fw={600}>{d.name}</Text>
            <Text size="sm" c="dimmed" lineClamp={3}>
              {d.description || ' '}
            </Text>
            <Group gap={6} mt="sm">
              <Badge size="xs" variant="outline">
                {d.definition.widgets.length} widgets
              </Badge>
              {d.owner && (
                <Text size="xs" c="dimmed">
                  by {d.owner}
                </Text>
              )}
              <Text size="xs" c="dimmed" ml="auto">
                updated {fmtRelative(d.updatedAt)}
              </Text>
            </Group>
          </Card>
        ))}
      </SimpleGrid>

      <Title order={4} mb={4}>
        Datasets
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        Published by “Publish to dashboard” nodes. Each run replaces the rows and adds metric values to the history used by trend charts. You see the datasets of
        processes you may view.
      </Text>
      <div className="table-scroll">
        <Table fz="sm" highlightOnHover className="viz-root">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Dataset</Table.Th>
              <Table.Th>Source</Table.Th>
              <Table.Th>Updated</Table.Th>
              <Table.Th ta="right">Rows</Table.Th>
              <Table.Th>Status</Table.Th>
              {isAdmin && <Table.Th />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {datasets.data?.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={6}>
                  <Text size="sm" c="dimmed">
                    No datasets yet – run a process that contains a “Publish to dashboard” node.
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
                        stale
                      </Badge>
                    )}
                    {m.dryRun && (
                      <Badge size="xs" color="gray" variant="light" leftSection={<IconFlask size={10} />}>
                        dry run
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td ta="right" className="viz-num">
                  {m.rowCount}
                </Table.Td>
                <Table.Td>
                  <StatusCounts counts={m.statusCounts} />
                </Table.Td>
                {isAdmin && (
                  <Table.Td>
                    <Tooltip label="Delete dataset and its history">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label="Delete dataset"
                        onClick={async () => {
                          if (!confirm(`Delete dataset "${m.key}" and its metric history? It is recreated by the next run of ${m.processName}.`)) return;
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
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['dashboard-templates'], queryFn: () => get<DashboardTemplate[]>('/dashboard-templates'), enabled: opened });
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Modal opened={opened} onClose={onClose} title="Dashboard templates" size="lg">
      <Stack>
        {list.data?.length === 0 && <Text c="dimmed">No templates found in examples/dashboards.</Text>}
        {list.data?.map((t) => (
          <Card key={t.id} withBorder padding="sm">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div style={{ minWidth: 0 }}>
                <Text fw={600}>{t.name}</Text>
                <Text size="sm" c="dimmed" lineClamp={3}>
                  {t.description}
                </Text>
                <Badge size="xs" variant="outline" mt={6}>
                  {t.definition.widgets.length} widgets
                </Badge>
              </div>
              <Button
                size="xs"
                loading={busy === t.id}
                onClick={async () => {
                  setBusy(t.id);
                  try {
                    const d = await post<Dashboard>('/dashboards', { templateId: t.id });
                    qc.invalidateQueries({ queryKey: ['dashboards'] });
                    notifyOk(`Created "${d.name}"`);
                    onClose();
                    navigate(`/dashboards/${d.id}`);
                  } catch (e) {
                    notifyError(e);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Use
              </Button>
            </Group>
          </Card>
        ))}
      </Stack>
    </Modal>
  );
}

function ImportModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened={opened} onClose={onClose} title="Import dashboard (YAML or JSON)" size="lg">
      <Stack>
        <Textarea classNames={{ input: 'mono' }} autosize minRows={10} maxRows={24} value={text} onChange={(e) => setText(e.currentTarget.value)} placeholder={'name: My dashboard\nwidgets:\n  - { id: w1, type: kpi, dataset: iem.devices }'} />
        <Group justify="space-between">
          <Button variant="default" size="xs" component="label" leftSection={<IconUpload size={14} />}>
            Load file
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
                notifyError(e, 'Import failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            Import
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
