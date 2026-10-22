import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, List, Modal, SegmentedControl, SimpleGrid, Stack, Text, TextInput, Textarea, ActionIcon, Tooltip, Menu } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { IconPlayerPlay, IconPlus, IconSearch, IconTemplate, IconUpload, IconDots, IconArchive, IconFileExport, IconPackage, IconPackageExport, IconPackageImport } from '@tabler/icons-react';
import { BUNDLE_FORMATS, type ExportBundle, type ProcessDetail, type ProcessSummary, type ProcessTemplate } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../api';
import { PageHeader, StatusBadge } from '../components/common';
import { RunDialog } from '../components/RunDialog';
import { fmtRelative } from '../format';
import { useMe } from '../auth';

export function ProcessesPage() {
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
        definition: { name: 'New process', description: '', connections: [], inputs: [], nodes: [{ id: 'start', type: 'start', name: 'Start', x: 0, y: 0 }], wires: [] },
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
            <Menu position="bottom-end">
              <Menu.Target>
                <Button size="xs" variant="default" leftSection={<IconPackage size={14} />}>
                  Bundle
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconPackageExport size={14} />} component="a" href="/api/bundle/export">
                  Export all processes &amp; dashboards
                </Menu.Item>
                {caps.createProcesses && (
                  <Menu.Item leftSection={<IconPackageImport size={14} />} onClick={bundleModal.open}>
                    Import bundle…
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
            {caps.createProcesses && (
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
            )}
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
          {caps.createProcesses ? (
            <Group>
              <Button onClick={templates.open} leftSection={<IconTemplate size={16} />}>
                Browse templates
              </Button>
            </Group>
          ) : (
            <Text size="sm" c="dimmed">
              Ask a designer or administrator to create processes or to give you access.
            </Text>
          )}
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
                {p.permissions.includes('run') && (
                  <Tooltip label="Run">
                    <ActionIcon variant="light" onClick={() => setRunId(p.id)} aria-label="Run">
                      <IconPlayerPlay size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
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
                    {p.permissions.includes('manage') && <Menu.Item
                      color="red"
                      leftSection={<IconArchive size={14} />}
                      onClick={async () => {
                        if (!confirm(`Archive "${p.name}"? Its schedules are disabled; runs and versions are kept.`)) return;
                        await del(`/processes/${p.id}`).catch(notifyError);
                        qc.invalidateQueries({ queryKey: ['processes'] });
                      }}
                    >
                      Archive
                    </Menu.Item>}
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
              {p.acl.length > 0 && (
                <Badge size="xs" variant="light" color="orange" title="Access restricted by an access list">
                  restricted
                </Badge>
              )}
              {!p.permissions.includes('edit') && (
                <Badge size="xs" variant="light" color="gray">
                  read-only
                </Badge>
              )}
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
      <BundleImportModal opened={bundleOpen} onClose={bundleModal.close} />
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
                    {(t.definition.nodes ?? []).filter((n) => n.type !== 'start' && n.type !== 'note').length} steps
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
        out.push({ file: f.name, ok: true, message: `created "${p.name}"` });
      } catch (e) {
        out.push({ file: f.name, ok: false, message: (e as Error).message });
      }
    }
    setResults(out);
    setBusy(false);
    qc.invalidateQueries({ queryKey: ['processes'] });
    const okCount = out.filter((r) => r.ok).length;
    if (okCount) notifyOk(`Imported ${okCount} of ${out.length} file(s)`);
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Import process (YAML or JSON)" size="lg">
      <Stack>
        <Text size="xs" c="dimmed">
          Paste a definition or load one file to review it first. Selecting several files imports each of them directly (e.g. the files in the repository's examples/processes folder).
        </Text>
        <Textarea classNames={{ input: 'mono' }} autosize minRows={10} maxRows={24} value={text} onChange={(e) => setText(e.currentTarget.value)} placeholder="name: My process&#10;steps: []" />
        {results && (
          <Alert color={results.every((r) => r.ok) ? 'green' : 'orange'} title="Import result" withCloseButton onClose={() => setResults(null)}>
            <List size="sm" spacing={2}>
              {results.map((r) => (
                <List.Item key={r.file}>
                  <b>{r.file}</b>: {r.ok ? r.message : `failed – ${r.message}`}
                </List.Item>
              ))}
            </List>
          </Alert>
        )}
        <Group justify="space-between">
          <Button
            variant="default"
            size="xs"
            component="label"
            leftSection={<IconUpload size={14} />}
          >
            Load file(s)
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

function BundleImportModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
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
      title="Import bundle"
      size="lg"
    >
      <Stack>
        <Text size="sm" c="dimmed">
          A bundle (JSON, created with "Export all processes &amp; dashboards") contains several processes and dashboards. Credentials and platforms are never part of a bundle.
        </Text>
        <Group>
          <Button variant="default" size="xs" component="label" leftSection={<IconUpload size={14} />}>
            Choose bundle file
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
                  if (!(BUNDLE_FORMATS as readonly string[]).includes(parsed.format)) throw new Error('Not a Steward bundle');
                  setBundle(parsed);
                  setFileName(f.name);
                  setResult(null);
                } catch (err) {
                  notifyError(err, 'Cannot read bundle');
                }
              }}
            />
          </Button>
          {fileName && <Text size="sm">{fileName}</Text>}
        </Group>
        {bundle && (
          <>
            <Text size="sm">
              {bundle.processes.length} process(es), {bundle.dashboards.length} dashboard(s), exported {fmtRelative(bundle.exportedAt)}.
            </Text>
            <div>
              <Text size="sm" fw={500} mb={4}>
                When an item with the same id already exists
              </Text>
              <SegmentedControl
                size="xs"
                value={onConflict}
                onChange={(v) => setOnConflict(v as typeof onConflict)}
                data={[
                  { value: 'newVersion', label: 'Save as new version' },
                  { value: 'skip', label: 'Skip' },
                  { value: 'copy', label: 'Import as copy' },
                ]}
              />
            </div>
          </>
        )}
        {result && (
          <Alert color={result.skipped.length ? 'orange' : 'green'} title="Import result">
            <Text size="sm">
              {result.created.length} created, {result.updated.length} updated, {result.skipped.length} skipped
            </Text>
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
                const r = await post<{ created: string[]; updated: string[]; skipped: { id: string; reason: string }[] }>('/bundle/import', { bundle, onConflict });
                setResult(r);
                qc.invalidateQueries({ queryKey: ['processes'] });
                qc.invalidateQueries({ queryKey: ['dashboards'] });
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
