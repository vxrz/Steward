import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionIcon, Alert, Anchor, Badge, Button, Center, Collapse, Group, Loader, Menu, Modal, Stack, Tabs, Text, TextInput, Textarea } from '@mantine/core';
import {
  IconApi,
  IconBook,
  IconChartLine,
  IconDots,
  IconKey,
  IconLock,
  IconPlug,
  IconPlugConnected,
  IconRobot,
  IconTicket,
  IconSettings,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { AclEntry, Platform } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { AccessEditor } from '../components/AccessEditor';
import { useMe } from '../auth';
import { JsonView, PageHeader } from '../components/common';
import { PlatformIntegrityAlert } from '../components/security/PlatformIntegrityAlert';
import { errorText } from '../i18n/errors';
import { fmtNumber } from '../format';
import { KIND_COLORS } from './Platforms';
import { SettingsTab } from '../components/platform/SettingsTab';
import { CredentialsTab } from '../components/platform/CredentialsTab';
import { SpecsTab } from '../components/platform/SpecsTab';
import { DocsTab } from '../components/platform/DocsTab';
import { ExplorerTab, type ExplorerPreset } from '../components/platform/ExplorerTab';
import { GatusMetricsTab } from '../components/platform/GatusMetricsTab';
import { McpGatewayTab } from '../components/mcp/McpGatewayTab';
import { TicketsPanel } from '../components/tickets/TicketsPanel';

interface TestResult {
  ok: boolean;
  status: number;
  durationMs: number;
  message: string;
  body?: unknown;
}

export function PlatformDetailPage() {
  const { t } = useTranslation(['platforms', 'tickets', 'common']);
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
  if (platform.error || !platform.data) return <Alert color="red">{platform.error ? errorText(platform.error) : t('detail.notFound')}</Alert>;
  const p = platform.data;
  const canManage = p.permissions.includes('manage');
  const canUse = p.permissions.includes('use');

  const saveAccess = async (acl: AclEntry[]) => {
    try {
      await put(`/platforms/${p.id}/access`, { acl });
      await qc.invalidateQueries({ queryKey: ['platform', id] });
      await qc.invalidateQueries({ queryKey: ['platforms'] });
      notifyOk(t('detail.accessSaved'));
    } catch (e) {
      notifyError(e, t('detail.accessNotSaved'));
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await post<TestResult>(`/platforms/${p.id}/test`));
    } catch (e) {
      notifyError(e, t('detail.testFailed'));
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    try {
      await del(`/platforms/${p.id}`);
      await qc.invalidateQueries({ queryKey: ['platforms'] });
      notifyOk(t('detail.deleted', { name: p.name }));
      navigate('/platforms');
    } catch (e) {
      notifyError(e, t('detail.notDeleted'));
    }
  };

  return (
    <>
      <PageHeader
        back="platforms"
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
                {t('detail.test')}
              </Button>
            )}
            {(canManage || isAdmin) && (
              <Menu position="bottom-end">
                <Menu.Target>
                  <ActionIcon variant="default" size="lg" aria-label={t('detail.more')}>
                    <IconDots size={16} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {isAdmin && (
                    <Menu.Item leftSection={<IconPlug size={14} />} onClick={() => setSaveType(true)}>
                      {t('detail.saveAsType')}
                    </Menu.Item>
                  )}
                  {canManage && (
                    <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => setDeleting(true)}>
                      {t('detail.delete')}
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
          </>
        }
      />
      <PlatformIntegrityAlert platform={p} canConfirm={isAdmin && canManage} />
      {test && (
        <Alert
          color={test.ok ? 'green' : 'red'}
          title={test.ok ? t('detail.testOk') : t('detail.testNotOk')}
          mb="md"
          withCloseButton
          onClose={() => setTest(null)}
        >
          <Text size="sm">
            {test.status ? `HTTP ${test.status} · ${fmtNumber(test.durationMs)} ms · ` : ''}
            {test.message}
          </Text>
          {test.body !== undefined && (
            <>
              <Anchor size="xs" onClick={() => setShowBody((s) => !s)}>
                {showBody ? t('detail.hideResponse') : t('detail.showResponse')}
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
          {canUse ? t('detail.useOnly') : t('detail.viewOnly')}
        </Alert>
      )}
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md" style={{ flexWrap: 'wrap' }}>
          <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
            {t('detail.tabs.settings')}
          </Tabs.Tab>
          <Tabs.Tab value="credentials" leftSection={<IconKey size={16} />}>
            {t('detail.tabs.credentials')}
          </Tabs.Tab>
          <Tabs.Tab value="specs" leftSection={<IconApi size={16} />}>
            {t('detail.tabs.specs')}
          </Tabs.Tab>
          <Tabs.Tab value="docs" leftSection={<IconBook size={16} />}>
            {t('detail.tabs.docs')}
          </Tabs.Tab>
          {canUse && (
            <Tabs.Tab value="explorer" leftSection={<IconTerminal2 size={16} />}>
              {t('detail.tabs.explorer')}
            </Tabs.Tab>
          )}
          {p.kind === 'gatus' && (
            <Tabs.Tab value="metrics" leftSection={<IconChartLine size={16} />}>
              {t('detail.tabs.metrics')}
            </Tabs.Tab>
          )}
          <Tabs.Tab value="access" leftSection={<IconLock size={16} />}>
            {t('detail.tabs.access')}
          </Tabs.Tab>
          <Tabs.Tab value="mcp" leftSection={<IconRobot size={16} />}>
            {t('detail.tabs.mcp')}
          </Tabs.Tab>
          <Tabs.Tab value="tickets" leftSection={<IconTicket size={16} />}>
            {t('tickets:panel.title')}
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
        {p.kind === 'gatus' && (
          <Tabs.Panel value="metrics">
            <GatusMetricsTab platform={p} />
          </Tabs.Panel>
        )}
        <Tabs.Panel value="access">
          <AccessEditor kind="platform" acl={p.acl} onSave={(acl) => saveAccess(acl)} readOnly={!canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="mcp">
          <McpGatewayTab platform={p} readOnly={!canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="tickets">
          <TicketsPanel kind="platform" id={p.id} label={p.name} />
        </Tabs.Panel>
      </Tabs>

      {saveType && <SaveTypeModal platform={p} onClose={() => setSaveType(false)} />}
      <Modal opened={deleting} onClose={() => setDeleting(false)} title={t('detail.delete')}>
        <Stack>
          <Text size="sm">
            <Trans t={t} i18nKey="detail.deleteText" values={{ name: p.name }} components={{ b: <strong /> }} />
          </Text>
          <TextInput label={t('detail.typeToConfirm', { name: p.name })} value={confirmName} onChange={(e) => setConfirmName(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleting(false)}>
              {t('common:cancel')}
            </Button>
            <Button color="red" disabled={confirmName !== p.name} onClick={remove}>
              {t('detail.delete')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function SaveTypeModal({ platform, onClose }: { platform: Platform; onClose: () => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const [kind, setKind] = useState(
    platform.kind === 'generic'
      ? platform.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
      : platform.kind,
  );
  const [label, setLabel] = useState(platform.name.replace(/\s*\((demo|prod|test|dev)\)\s*$/i, ''));
  const [description, setDescription] = useState(platform.description);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await post('/platform-types', { fromPlatformId: platform.id, kind, label, description });
      await qc.invalidateQueries({ queryKey: ['platform-presets'] });
      notifyOk(t('saveType.saved', { name: label }));
      onClose();
    } catch (e) {
      notifyError(e, t('saveType.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('detail.saveAsType')}>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('saveType.hint', { name: platform.name })}
        </Text>
        <TextInput
          label={t('saveType.kind')}
          description={t('saveType.kindHint')}
          classNames={{ input: 'mono' }}
          value={kind}
          onChange={(e) => setKind(e.currentTarget.value)}
          required
        />
        <TextInput label={t('saveType.label')} value={label} onChange={(e) => setLabel(e.currentTarget.value)} required />
        <Textarea label={t('saveType.description')} autosize minRows={2} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={!/^[a-z0-9][a-z0-9._-]*$/.test(kind) || !label.trim()}>
            {t('saveType.submit')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
