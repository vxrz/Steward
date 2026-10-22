import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionIcon, Alert, Anchor, Badge, Button, Center, Collapse, Group, Loader, Menu, Modal, Stack, Tabs, Text, TextInput, Textarea } from '@mantine/core';
import { IconApi, IconBook, IconDots, IconKey, IconLock, IconPlug, IconPlugConnected, IconSettings, IconTerminal2, IconTrash } from '@tabler/icons-react';
import type { AclEntry, Platform } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { AccessEditor } from '../components/AccessEditor';
import { useMe } from '../auth';
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
  const [saveType, setSaveType] = useState(false);
  const { isAdmin } = useMe();

  if (platform.isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (platform.error || !platform.data) return <Alert color="red">{(platform.error as Error)?.message ?? 'Not found'}</Alert>;
  const p = platform.data;
  const canManage = p.permissions.includes('manage');
  const canUse = p.permissions.includes('use');

  const saveAccess = async (acl: AclEntry[]) => {
    try {
      await put(`/platforms/${p.id}/access`, { acl });
      await qc.invalidateQueries({ queryKey: ['platform', id] });
      await qc.invalidateQueries({ queryKey: ['platforms'] });
      notifyOk('Access saved');
    } catch (e) {
      notifyError(e, 'Access not saved');
    }
  };

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
            <Badge component="span" color={KIND_COLORS[p.kind] ?? 'gray'} variant="light" size="sm">
              {p.kind}
            </Badge>
            {p.environment && (
              <Badge component="span" variant="outline" size="sm">
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
            {canUse && (
              <Button leftSection={<IconPlugConnected size={16} />} onClick={runTest} loading={testing} variant="light">
                Test connection
              </Button>
            )}
            {(canManage || isAdmin) && (
              <Menu position="bottom-end">
                <Menu.Target>
                  <ActionIcon variant="default" size="lg" aria-label="More">
                    <IconDots size={16} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {isAdmin && (
                    <Menu.Item leftSection={<IconPlug size={14} />} onClick={() => setSaveType(true)}>
                      Save as connector type
                    </Menu.Item>
                  )}
                  {canManage && (
                    <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => setDeleting(true)}>
                      Delete platform
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
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
      {!canManage && (
        <Alert color="gray" variant="light" mb="md" icon={<IconLock size={16} />}>
          {canUse
            ? 'You may use this platform in runs and send read-only requests. Changing its configuration, credentials or access requires the “manage” right.'
            : 'You may look at this platform but not use it in runs. Ask an administrator for access.'}
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
          {canUse && (
            <Tabs.Tab value="explorer" leftSection={<IconTerminal2 size={16} />}>
              Explorer
            </Tabs.Tab>
          )}
          <Tabs.Tab value="access" leftSection={<IconLock size={16} />}>
            Access
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="settings">
          <SettingsTab platform={p} readOnly={!canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="credentials">
          <CredentialsTab platform={p} readOnly={!canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="specs">
          <SpecsTab
            platform={p}
            readOnly={!canManage}
            onPickOperation={(op) => {
              if (!canUse) return;
              setExplorerPreset({ method: op.method, path: op.path, nonce: Date.now() });
              setTab('explorer');
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="docs">
          <DocsTab platform={p} readOnly={!canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="explorer">
          <ExplorerTab platform={p} preset={explorerPreset} canWrite={canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="access">
          <AccessEditor kind="platform" acl={p.acl} onSave={(acl) => saveAccess(acl)} readOnly={!canManage} />
        </Tabs.Panel>
      </Tabs>

      {saveType && <SaveTypeModal platform={p} onClose={() => setSaveType(false)} />}
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

function SaveTypeModal({ platform, onClose }: { platform: Platform; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState(platform.kind === 'generic' ? platform.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : platform.kind);
  const [label, setLabel] = useState(platform.name.replace(/\s*\((demo|prod|test|dev)\)\s*$/i, ''));
  const [description, setDescription] = useState(platform.description);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await post('/platform-types', { fromPlatformId: platform.id, kind, label, description });
      await qc.invalidateQueries({ queryKey: ['platform-presets'] });
      notifyOk(`Connector type "${label}" saved – it appears under Add platform and can be exported under Platforms → Connector types`);
      onClose();
    } catch (e) {
      notifyError(e, 'Not saved');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title="Save as connector type">
      <Stack>
        <Text size="sm" c="dimmed">
          Stores authentication, variables, HTTP options, the names of the required credentials, documentation links and all API
          specifications of “{platform.name}” as a reusable template. Credential values are never included.
        </Text>
        <TextInput
          label="Kind"
          description="Short identifier, e.g. servicenow or my-mes. Processes can require this kind for a connection."
          classNames={{ input: 'mono' }}
          value={kind}
          onChange={(e) => setKind(e.currentTarget.value)}
          required
        />
        <TextInput label="Label" value={label} onChange={(e) => setLabel(e.currentTarget.value)} required />
        <Textarea label="Description" autosize minRows={2} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!/^[a-z0-9][a-z0-9._-]*$/.test(kind) || !label.trim()}>
            Save connector type
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
