import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Collapse, Group, Menu, Modal, Stack, Tabs, Text, TextInput, Textarea } from '@mantine/core';
import {
  IconApi,
  IconBook,
  IconChartLine,
  IconDots,
  IconKey,
  IconLock,
  IconFileExport,
  IconPlug,
  IconPlugConnected,
  IconPlayerRecord,
  IconRefresh,
  IconRobot,
  IconRocket,
  IconTicket,
  IconSettings,
  IconSparkles,
  IconTerminal2,
  IconTrash,
  IconGauge,
  IconId,
  IconDatabase,
  IconSchema,
  IconArrowsExchange,
  IconFileDiff,
} from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import { CHANGEDETECTION_KIND, DATABASE_KIND, KAFKA_CONNECT_KIND, LLM_GATEWAY_KIND, type AclEntry, type Platform } from '@sm/shared';
import { apiUrl, del, get, notifyError, notifyOk, post, put } from '../api';
import { AccessEditor } from '../components/AccessEditor';
import { OwningTeams } from '../components/OwningTeams';
import { useMe } from '../auth';
import { DetailState, JsonView } from '../components/common';
import { PlatformIntegrityAlert } from '../components/security/PlatformIntegrityAlert';
import { fmtNumber, fmtRelative } from '../format';
import { KIND_COLORS } from './Platforms';
import { SettingsTab } from '../components/platform/SettingsTab';
import { CredentialsTab } from '../components/platform/CredentialsTab';
import { IdentitiesTab } from '../components/platform/IdentitiesTab';
import { SpecsTab } from '../components/platform/SpecsTab';
import { DocsTab } from '../components/platform/DocsTab';
import { ExplorerTab, type ExplorerPreset } from '../components/platform/ExplorerTab';
import { GatusMetricsTab } from '../components/platform/GatusMetricsTab';
import { WatchesTab } from '../components/platform/WatchesTab';
import { RecordingsTab } from '../components/platform/RecordingsTab';
import { AiModelsTab } from '../components/platform/AiModelsTab';
import { AiUsageTab } from '../components/platform/AiUsageTab';
import { DatabaseTab } from '../components/platform/DatabaseTab';
import { KafkaConnectTab } from '../components/platform/KafkaConnectTab';
import { SchemaView } from '../components/dbschema/SchemaView';
import { McpGatewayTab } from '../components/mcp/McpGatewayTab';
import { TicketsPanel } from '../components/tickets/TicketsPanel';
import { MaintenancePanel } from '../components/catalogue/maintenance';
import { DetailHeader } from '../components/page/DetailPage';
import { CostsButton } from '../components/costs/CostsButton';
import { platformKeys } from '../queryKeys';
import { GetStartedPanel, PlatformHealthPanel, TestHints } from '../components/platform/onboarding';
import { moduleOn } from '../modules';
import { KindMaturityBadge } from '../components/modules/MaturityBadge';

interface TokenInfo {
  fetchedAt: string;
  expiresAt: string;
}

interface TestResult {
  ok: boolean;
  status: number;
  durationMs: number;
  message: string;
  body?: unknown;
  /** Who answered: content type, server, proxy, sign-in challenge, redirect target */
  headers?: Record<string, string>;
  /** Origin and path of the final answer (after redirects) */
  url?: string;
  /** Per part of a connector (AWS): what works and what is missing */
  checks?: { name: string; ok: boolean; message: string }[];
  /** The cached access token the test used (OAuth2 or custom login) */
  token?: TokenInfo | null;
}

export function PlatformDetailPage() {
  const { t } = useTranslation(['platforms', 'tickets', 'common', 'applications']);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const platform = useQuery({ queryKey: platformKeys.detail(id), queryFn: () => get<Platform>(`/platforms/${id}`), enabled: !!id });
  // the application of the service catalogue the platform belongs to (#84)
  const application = useQuery({
    queryKey: platformKeys.application(id),
    queryFn: () => get<{ application: { id: string; name: string; archived: boolean } | null }>(`/platforms/${id}/application`),
    enabled: !!id,
  });
  // ?tab=recordings etc. opens a tab directly (links from the run dialog)
  const [params] = useSearchParams();
  const [tab, setTab] = useState<string | null>(params.get('tab'));
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [explorerPreset, setExplorerPreset] = useState<ExplorerPreset | null>(null);
  const [saveType, setSaveType] = useState(false);
  const { isAdmin, caps } = useMe();

  if (platform.isLoading || platform.error) return <DetailState query={platform} back="platforms" />;
  if (!platform.data) return <Alert color="red">{t('detail.notFound')}</Alert>;
  const p = platform.data;
  // a database platform (0.7.0) opens on its connection; it has no API specification, explorer or HTTP sign-in
  const isDatabase = p.kind === DATABASE_KIND;
  // a Kafka Connect platform (0.9.0) opens on its connectors
  const isConnect = p.kind === KAFKA_CONNECT_KIND;
  // changedetection.io (#242) opens on its watches, the components of the platform
  const isChangedetection = p.kind === CHANGEDETECTION_KIND && moduleOn(caps, 'changedetection');
  // an LLM gateway's models and usage belong to the AI models module (ADR 0016)
  const isAi = p.kind === LLM_GATEWAY_KIND && moduleOn(caps, 'ai');
  const activeTab = tab ?? (isDatabase ? 'database' : isConnect ? 'connectors' : isChangedetection ? 'watches' : 'settings');
  const canManage = p.permissions.includes('manage');
  const canUse = p.permissions.includes('use');
  // who sees the platform may export it for Postman (#204): its settings without the secrets
  const canExport = p.permissions.length > 0;
  const tokenLogin =
    p.config.auth?.type === 'oauth2_client_credentials' ||
    p.config.auth?.type === 'token_request' ||
    p.config.auth?.type === 'jwt' ||
    (p.config.auth?.type === 'aws_sigv4' && !!p.config.auth.aws?.roleArn);

  const saveAccess = async (acl: AclEntry[]) => {
    try {
      await put(`/platforms/${p.id}/access`, { acl });
      await qc.invalidateQueries({ queryKey: platformKeys.detail(id) });
      await qc.invalidateQueries({ queryKey: platformKeys.all });
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
      // the health panel and the list's "last test" show the new result
      qc.invalidateQueries({ queryKey: ['platform', id, 'health'] });
      qc.invalidateQueries({ queryKey: ['platforms'] });
    }
  };

  // roles granted to the platform's technical user only appear in a new token
  const renewToken = async () => {
    try {
      const r = await post<{ ok: boolean; message?: string; token: TokenInfo | null }>(`/platforms/${p.id}/token/renew`);
      if (r.ok && r.token) notifyOk(t('detail.tokenRenewed', { expires: fmtRelative(r.token.expiresAt) }));
      else notifyError(new Error(r.message ?? ''), t('detail.tokenNotRenewed'));
    } catch (e) {
      notifyError(e, t('detail.tokenNotRenewed'));
    }
  };

  const remove = async () => {
    try {
      await del(`/platforms/${p.id}`);
      await qc.invalidateQueries({ queryKey: platformKeys.all });
      notifyOk(t('detail.deleted', { name: p.name }));
      navigate('/platforms');
    } catch (e) {
      notifyError(e, t('detail.notDeleted'));
    }
  };

  return (
    <>
      <DetailHeader
        recent={{ label: p.name, kind: 'platform' }}
        back="platforms"
        title={p.name}
        description={
          <Group gap={6} component="span">
            <Badge component="span" color={KIND_COLORS[p.kind] ?? 'gray'} variant="light" size="sm">
              {p.kind}
            </Badge>
            <KindMaturityBadge kind={p.kind} />
            {p.environment && (
              <Badge component="span" variant="outline" size="sm">
                {p.environment}
              </Badge>
            )}
            <Text span size="xs" className="mono" style={{ wordBreak: 'break-all' }}>
              {p.baseUrl}
            </Text>
            {application.data?.application && (
              <Text span size="xs" data-testid="platform-application">
                {t('applications:integrations.belongsTo')}{' '}
                <Anchor component={Link} to={`/applications/${application.data.application.id}`} size="xs">
                  {application.data.application.name}
                </Anchor>
              </Text>
            )}
          </Group>
        }
        actions={
          <>
            <CostsButton scope="platform" id={p.id} />
            {canUse && (
              <Button size="xs" leftSection={<IconPlugConnected size={14} />} onClick={runTest} loading={testing} variant="light">
                {t('detail.test')}
              </Button>
            )}
            {(canManage || isAdmin || canExport) && (
              <Menu position="bottom-end">
                <Menu.Target>
                  <Button size="xs" variant="default" aria-label={t('detail.more')} px={8}>
                    <IconDots size={14} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  {canManage && tokenLogin && (
                    <Menu.Item leftSection={<IconRefresh size={14} />} onClick={renewToken}>
                      {t('detail.renewToken')}
                    </Menu.Item>
                  )}
                  {isAdmin && (
                    <Menu.Item leftSection={<IconPlug size={14} />} onClick={() => setSaveType(true)}>
                      {t('detail.saveAsType')}
                    </Menu.Item>
                  )}
                  <Menu.Item
                    component="a"
                    href={apiUrl(`/platforms/${p.id}/export/postman`)}
                    leftSection={<IconFileExport size={14} />}
                    data-testid="export-postman"
                  >
                    <Text size="sm">{t('detail.exportPostman')}</Text>
                    <Text size="xs" c="dimmed">
                      {t('detail.exportPostmanHint')}
                    </Text>
                  </Menu.Item>
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
          closeButtonLabel={t('common:close')}
          onClose={() => setTest(null)}
        >
          <Text size="sm">
            {test.status ? `HTTP ${test.status} · ${fmtNumber(test.durationMs)} ms · ` : ''}
            {test.message}
          </Text>
          {test.token && (
            <Text size="xs" c="dimmed" data-testid="platform-token-age">
              {t('detail.tokenAge', { fetched: fmtRelative(test.token.fetchedAt), expires: fmtRelative(test.token.expiresAt) })}
              {canManage && (
                <>
                  {' · '}
                  <Anchor size="xs" onClick={renewToken}>
                    {t('detail.renewToken')}
                  </Anchor>
                </>
              )}
            </Text>
          )}
          {!test.ok && <TestHints result={test} />}
          {!!test.checks?.length && (
            <Stack gap={2} mt={4} data-testid="platform-test-checks">
              {test.checks.map((c) => (
                <Text key={c.name} size="xs" c={c.ok ? undefined : 'orange.8'}>
                  {c.ok ? '✓' : '✗'} {c.name}: {c.message}
                </Text>
              ))}
            </Stack>
          )}
          {test.body !== undefined && (test.body !== null || !!test.headers) && (
            <>
              <Anchor size="xs" onClick={() => setShowBody((s) => !s)}>
                {showBody ? t('detail.hideResponse') : t('detail.showResponse')}
              </Anchor>
              <Collapse expanded={showBody}>
                {test.url && (
                  <Text size="xs" className="mono" mb={4}>
                    {test.url}
                  </Text>
                )}
                {test.headers && Object.keys(test.headers).length > 0 && (
                  <Text size="xs" className="mono" mb={4} style={{ wordBreak: 'break-all' }} data-testid="platform-test-headers">
                    {Object.entries(test.headers).map(([k, v]) => (
                      <span key={k} style={{ display: 'block' }}>
                        {k}: {v}
                      </span>
                    ))}
                  </Text>
                )}
                {test.body === null || test.body === '' ? (
                  <Text size="xs" c="dimmed" fs="italic">
                    {t('detail.emptyResponse')}
                  </Text>
                ) : (
                  <JsonView value={test.body} maxHeight={240} />
                )}
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
      {/* the last connection test and the periodic test (v0.4.0) */}
      <PlatformHealthPanel platform={p} canManage={canManage} />
      <div style={{ marginBottom: 'var(--mantine-spacing-md)' }}>
        <MaintenancePanel kind="platform" id={p.id} canPlan={canManage} />
      </div>
      <Tabs value={activeTab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md" style={{ flexWrap: 'wrap' }}>
          {isDatabase && (
            <Tabs.Tab value="database" leftSection={<IconDatabase size={16} />}>
              {t('detail.tabs.database')}
            </Tabs.Tab>
          )}
          {isDatabase && (
            <Tabs.Tab value="schema" leftSection={<IconSchema size={16} />} data-testid="platform-tab-schema">
              {t('detail.tabs.schema')}
            </Tabs.Tab>
          )}
          {isConnect && (
            <Tabs.Tab value="connectors" leftSection={<IconArrowsExchange size={16} />} data-testid="platform-tab-connectors">
              {t('detail.tabs.connectors')}
            </Tabs.Tab>
          )}
          {isChangedetection && (
            <Tabs.Tab value="watches" leftSection={<IconFileDiff size={16} />} data-testid="platform-tab-watches">
              {t('detail.tabs.watches')}
            </Tabs.Tab>
          )}
          <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
            {t('detail.tabs.settings')}
          </Tabs.Tab>
          <Tabs.Tab value="credentials" leftSection={<IconKey size={16} />}>
            {t('detail.tabs.credentials')}
          </Tabs.Tab>
          <Tabs.Tab value="identities" leftSection={<IconId size={16} />} data-testid="platform-tab-identities">
            {t('detail.tabs.identities')}
          </Tabs.Tab>
          {!isDatabase && (
            <Tabs.Tab value="specs" leftSection={<IconApi size={16} />}>
              {t('detail.tabs.specs')}
            </Tabs.Tab>
          )}
          <Tabs.Tab value="docs" leftSection={<IconBook size={16} />}>
            {t('detail.tabs.docs')}
          </Tabs.Tab>
          {canUse && !isDatabase && (
            <Tabs.Tab value="explorer" leftSection={<IconTerminal2 size={16} />}>
              {t('detail.tabs.explorer')}
            </Tabs.Tab>
          )}
          {canUse && (
            <Tabs.Tab value="recordings" leftSection={<IconPlayerRecord size={16} />}>
              {t('detail.tabs.recordings')}
            </Tabs.Tab>
          )}
          {p.kind === 'gatus' && (
            <Tabs.Tab value="metrics" leftSection={<IconChartLine size={16} />}>
              {t('detail.tabs.metrics')}
            </Tabs.Tab>
          )}
          {isAi && (
            <Tabs.Tab value="ai" leftSection={<IconSparkles size={16} />}>
              {t('detail.tabs.ai')}
            </Tabs.Tab>
          )}
          {isAi && canUse && (
            <Tabs.Tab value="ai-usage" leftSection={<IconGauge size={16} />}>
              {t('detail.tabs.aiUsage')}
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
          <Tabs.Tab value="start" leftSection={<IconRocket size={16} />}>
            {t('start.tab')}
          </Tabs.Tab>
        </Tabs.List>
        {isDatabase && (
          <Tabs.Panel value="database">
            <DatabaseTab platform={p} readOnly={!canManage} />
          </Tabs.Panel>
        )}
        {isDatabase && (
          <Tabs.Panel value="schema">
            <SchemaView subject={{ kind: 'platform', id: p.id, name: p.name }} />
          </Tabs.Panel>
        )}
        {isConnect && (
          <Tabs.Panel value="connectors">
            <KafkaConnectTab platform={p} />
          </Tabs.Panel>
        )}
        <Tabs.Panel value="settings">
          <SettingsTab platform={p} readOnly={!canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="credentials">
          <CredentialsTab platform={p} readOnly={!canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="identities">
          <IdentitiesTab platform={p} onOpenTab={setTab} />
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
        <Tabs.Panel value="recordings">
          <RecordingsTab platform={p} readOnly={!canManage} />
        </Tabs.Panel>
        {isChangedetection && (
          <Tabs.Panel value="watches">
            <WatchesTab platform={p} />
          </Tabs.Panel>
        )}
        {p.kind === 'gatus' && (
          <Tabs.Panel value="metrics">
            <GatusMetricsTab platform={p} />
          </Tabs.Panel>
        )}
        {isAi && (
          <Tabs.Panel value="ai">
            <AiModelsTab platform={p} readOnly={!canManage} />
          </Tabs.Panel>
        )}
        {isAi && canUse && (
          <Tabs.Panel value="ai-usage">
            <AiUsageTab platform={p} />
          </Tabs.Panel>
        )}
        <Tabs.Panel value="access">
          <OwningTeams kind="platform" id={p.id} />
          <AccessEditor kind="platform" acl={p.acl} onSave={(acl) => saveAccess(acl)} readOnly={!canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="mcp">
          <McpGatewayTab platform={p} readOnly={!canManage} />
        </Tabs.Panel>
        <Tabs.Panel value="tickets">
          <TicketsPanel kind="platform" id={p.id} label={p.name} />
        </Tabs.Panel>
        <Tabs.Panel value="start">
          <GetStartedPanel platform={p} />
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
      await qc.invalidateQueries({ queryKey: platformKeys.presets });
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
