import { useState } from 'react';
import { Badge, Button, Card, Group, Modal, SimpleGrid, Stack, Text, TextInput, Textarea, ActionIcon, Tooltip, Menu } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { IconPlayerPlay, IconPlus, IconSearch, IconTemplate, IconUpload, IconDots, IconArchive, IconFileExport } from '@tabler/icons-react';
import type { ProcessDetail, ProcessSummary, ProcessTemplate } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../api';
import { PageHeader, StatusBadge } from '../components/common';
import { RunDialog } from '../components/RunDialog';
import { fmtRelative } from '../format';

export function ProcessesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const [filter, setFilter] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [templatesOpen, templates] = useDisclosure();
  const [importOpen, importModal] = useDisclosure();

  const createBlank = async () => {
    try {
      const p = await post<ProcessDetail>('/processes', {
        definition: { name: 'New process', description: '', connections: [], inputs: [], steps: [] },
      });
      navigate(`/processes/${p.id}`);
    } catch (e) {
      notifyError(e);
    }
  };

  const f = filter.toLowerCase();
  const list = (processes.data ?? []).filter((p) => !f || p.name.toLowerCase().includes(f) || p.tags.some((t) => t.includes(f)));

  return (
    <>
      <PageHeader
        title="Processes"
        description="Reusable procedures: API calls, loops, decisions, approvals, checks and browser steps. Every save creates a new version."
        actions={
          <>
            <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} onClick={importModal.open}>
              Import YAML
            </Button>
            <Button size="xs" variant="light" leftSection={<IconTemplate size={14} />} onClick={templates.open}>
              From template
            </Button>
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={createBlank}>
              New process
            </Button>
          </>
        }
      />
      <TextInput mb="md" placeholder="Search by name or tag" leftSection={<IconSearch size={14} />} value={filter} onChange={(e) => setFilter(e.currentTarget.value)} maw={360} />
      {processes.data?.length === 0 && (
        <Card withBorder p="lg">
          <Text fw={600}>No processes yet</Text>
          <Text size="sm" c="dimmed" mb="sm">
            Start from a template – user onboarding, access reviews, attribute optimization, health checks – or build your own.
          </Text>
          <Group>
            <Button onClick={templates.open} leftSection={<IconTemplate size={16} />}>
              Browse templates
            </Button>
          </Group>
        </Card>
      )}
      <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>
        {list.map((p) => (
          <Card key={p.id} withBorder padding="md" className="clickable" onClick={() => navigate(`/processes/${p.id}`)}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Text fw={600} style={{ minWidth: 0 }}>
                {p.name}
              </Text>
              <Group gap={4} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                <Tooltip label="Run">
                  <ActionIcon variant="light" onClick={() => setRunId(p.id)} aria-label="Run">
                    <IconPlayerPlay size={16} />
                  </ActionIcon>
                </Tooltip>
                <Menu position="bottom-end">
                  <Menu.Target>
                    <ActionIcon variant="subtle" aria-label="More">
                      <IconDots size={16} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item leftSection={<IconFileExport size={14} />} component="a" href={`/api/processes/${p.id}/export`}>
                      Export YAML
                    </Menu.Item>
                    <Menu.Item
                      color="red"
                      leftSection={<IconArchive size={14} />}
                      onClick={async () => {
                        if (!confirm(`Archive "${p.name}"? Its schedules are disabled; runs and versions are kept.`)) return;
                        await del(`/processes/${p.id}`).catch(notifyError);
                        qc.invalidateQueries({ queryKey: ['processes'] });
                      }}
                    >
                      Archive
                    </Menu.Item>
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
              {p.tags.map((t) => (
                <Badge key={t} size="xs" variant="light" color="gray">
                  {t}
                </Badge>
              ))}
              {p.lastRun && (
                <>
                  <Text size="xs" c="dimmed" ml="auto">
                    last run {fmtRelative(p.lastRun.startedAt)}
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
    </>
  );
}

function TemplatesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => get<ProcessTemplate[]>('/templates'), enabled: opened });
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Modal opened={opened} onClose={onClose} title="Start from a template" size="xl">
      <Stack>
        {templates.data?.map((t) => (
          <Card key={t.id} withBorder padding="sm">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div style={{ minWidth: 0 }}>
                <Text fw={600}>{t.name}</Text>
                <Text size="sm" c="dimmed" lineClamp={4} style={{ whiteSpace: 'pre-line' }}>
                  {t.description}
                </Text>
                <Group gap={4} mt={6}>
                  {t.tags.map((tag) => (
                    <Badge key={tag} size="xs" variant="light" color="gray">
                      {tag}
                    </Badge>
                  ))}
                  <Badge size="xs" variant="outline">
                    {t.definition.steps.length} steps
                  </Badge>
                </Group>
              </div>
              <Button
                size="xs"
                loading={busy === t.id}
                onClick={async () => {
                  setBusy(t.id);
                  try {
                    const p = await post<ProcessDetail>('/processes', { templateId: t.id });
                    qc.invalidateQueries({ queryKey: ['processes'] });
                    notifyOk(`Created "${p.name}"`);
                    onClose();
                    navigate(`/processes/${p.id}`);
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
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened={opened} onClose={onClose} title="Import process (YAML or JSON)" size="lg">
      <Stack>
        <Textarea classNames={{ input: 'mono' }} autosize minRows={10} maxRows={24} value={text} onChange={(e) => setText(e.currentTarget.value)} placeholder="name: My process&#10;steps: []" />
        <Group justify="space-between">
          <Button
            variant="default"
            size="xs"
            component="label"
            leftSection={<IconUpload size={14} />}
          >
            Load file
            <input type="file" accept=".yaml,.yml,.json" hidden onChange={(e) => e.currentTarget.files?.[0]?.text().then(setText)} />
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
