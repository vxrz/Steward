import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Center, Collapse, Group, Loader, Modal, Stack, Tabs, Text, TextInput } from '@mantine/core';
import { IconApi, IconBook, IconKey, IconPlugConnected, IconSettings, IconTerminal2, IconTrash } from '@tabler/icons-react';
import type { Platform } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../api';
import { JsonView, PageHeader } from '../components/common';
import { KIND_COLORS } from './Platforms';
import { SettingsTab } from '../components/platform/SettingsTab';
import { CredentialsTab } from '../components/platform/CredentialsTab';
import { SpecsTab } from '../components/platform/SpecsTab';
import { DocsTab } from '../components/platform/DocsTab';
import { ExplorerTab, type ExplorerPreset } from '../components/platform/ExplorerTab';

interface TestResult {
  ok: boolean;
  status: number;
  durationMs: number;
  message: string;
  body?: unknown;
}

export function PlatformDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const platform = useQuery({ queryKey: ['platform', id], queryFn: () => get<Platform>(`/platforms/${id}`), enabled: !!id });
  const [tab, setTab] = useState<string | null>('settings');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [explorerPreset, setExplorerPreset] = useState<ExplorerPreset | null>(null);

  if (platform.isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (platform.error || !platform.data) return <Alert color="red">{(platform.error as Error)?.message ?? 'Not found'}</Alert>;
  const p = platform.data;

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await post<TestResult>(`/platforms/${p.id}/test`));
    } catch (e) {
      notifyError(e, 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    try {
      await del(`/platforms/${p.id}`);
      await qc.invalidateQueries({ queryKey: ['platforms'] });
      notifyOk(`Platform "${p.name}" deleted`);
      navigate('/platforms');
    } catch (e) {
      notifyError(e, 'Not deleted');
    }
  };

  return (
    <>
      <Anchor size="sm" onClick={() => navigate('/platforms')}>
        ← Platforms
      </Anchor>
      <PageHeader
        title={p.name}
        description={
          <Group gap={6} component="span">
            <Badge color={KIND_COLORS[p.kind] ?? 'gray'} variant="light" size="sm">
              {p.kind}
            </Badge>
            {p.environment && (
              <Badge variant="outline" size="sm">
                {p.environment}
              </Badge>
            )}
            <Text span size="xs" className="mono" style={{ wordBreak: 'break-all' }}>
              {p.baseUrl}
            </Text>
          </Group>
        }
        actions={
          <>
            <Button leftSection={<IconPlugConnected size={16} />} onClick={runTest} loading={testing} variant="light">
              Test connection
            </Button>
            <Button color="red" variant="subtle" leftSection={<IconTrash size={16} />} onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </>
        }
      />
      {test && (
        <Alert
          color={test.ok ? 'green' : 'red'}
          title={test.ok ? 'Connection works' : 'Connection failed'}
          mb="md"
          withCloseButton
          onClose={() => setTest(null)}
        >
          <Text size="sm">
            {test.status ? `HTTP ${test.status} · ${test.durationMs} ms · ` : ''}
            {test.message}
          </Text>
          {test.body !== undefined && (
            <>
              <Anchor size="xs" onClick={() => setShowBody((s) => !s)}>
                {showBody ? 'Hide response' : 'Show response'}
              </Anchor>
              <Collapse in={showBody}>
                <JsonView value={test.body} maxHeight={240} />
              </Collapse>
            </>
          )}
        </Alert>
      )}
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md" style={{ flexWrap: 'wrap' }}>
          <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
            Settings
          </Tabs.Tab>
          <Tabs.Tab value="credentials" leftSection={<IconKey size={16} />}>
            Credentials
          </Tabs.Tab>
          <Tabs.Tab value="specs" leftSection={<IconApi size={16} />}>
            API specs
          </Tabs.Tab>
          <Tabs.Tab value="docs" leftSection={<IconBook size={16} />}>
            Docs
          </Tabs.Tab>
          <Tabs.Tab value="explorer" leftSection={<IconTerminal2 size={16} />}>
            Explorer
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="settings">
          <SettingsTab platform={p} />
        </Tabs.Panel>
        <Tabs.Panel value="credentials">
          <CredentialsTab platform={p} />
        </Tabs.Panel>
        <Tabs.Panel value="specs">
          <SpecsTab
            platform={p}
            onPickOperation={(op) => {
              setExplorerPreset({ method: op.method, path: op.path, nonce: Date.now() });
              setTab('explorer');
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="docs">
          <DocsTab platform={p} />
        </Tabs.Panel>
        <Tabs.Panel value="explorer">
          <ExplorerTab platform={p} preset={explorerPreset} />
        </Tabs.Panel>
      </Tabs>

      <Modal opened={deleting} onClose={() => setDeleting(false)} title="Delete platform">
        <Stack>
          <Text size="sm">
            This deletes <strong>{p.name}</strong> including its stored credentials, API specs and documents. Processes and
            schedules that use it will fail until another platform is selected. The audit log is kept.
          </Text>
          <TextInput label={`Type "${p.name}" to confirm`} value={confirmName} onChange={(e) => setConfirmName(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button color="red" disabled={confirmName !== p.name} onClick={remove}>
              Delete platform
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
