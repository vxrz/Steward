import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Box,
  Button,
  FileButton,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconEdit, IconEye, IconExternalLink, IconFileImport, IconKey, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  AWS_KIND,
  AWS_LIMITS,
  COMPONENT_TYPES,
  GIT_PLATFORM_KINDS,
  type AwsAccessKey,
  type AwsIamUser,
  type ApplicationComponent,
  type RepositoryKey,
  type PeekedMessage,
  type ApplicationDetail,
  type ComponentType,
  type SbomChange,
  type SbomPreview,
  type StackEntry,
  type StackProduct,
} from '@sm/shared';
import { del, get, notifyError, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { confirmDanger } from '../confirm';
import { fmtDate, fmtNumber } from '../../format';
import { LifecycleBadge } from './lifecycle';
import { EnvironmentBadge, EnvironmentInput, sortByEnvironment, useEnvironmentList } from './environments';
import { CredentialEditor, type CredentialDraft } from '../credentials/CredentialEditor';

export const formatLabel = (f: string) => (f === 'cyclonedx' ? 'CycloneDX' : 'SPDX');

export function useStackProducts() {
  return useQuery({
    queryKey: ['stack-products'],
    queryFn: () => get<{ source: string; products: StackProduct[] }>('/catalogue/stack-products'),
    staleTime: Infinity,
  });
}

/** What the application consists of, with the tech stack of each component; editors add, change and remove them. */
export function ComponentsPanel({ app, onSaved }: { app: ApplicationDetail; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const [editing, setEditing] = useState<ApplicationComponent | 'new' | null>(null);
  const [importing, setImporting] = useState<ApplicationComponent | null>(null);
  const [env, setEnv] = useState<string | null>(null);
  const envList = useEnvironmentList();
  const editable = app.canEdit && !app.archived;
  const envs = sortByEnvironment(envList, [...new Set(app.components.map((c) => c.environment))], (x) => x);
  const withEnv = envs.some((e) => e !== '');
  // the components of all environments ('') show in every environment
  const shown = env === null ? app.components : app.components.filter((c) => c.environment === env || c.environment === '');
  const readCluster = async (c: ApplicationComponent) => {
    try {
      onSaved(await post<ApplicationDetail>(`/applications/${app.id}/components/${c.id}/cluster`, {}));
      notifications.show({ color: 'green', message: t('components.cluster.done', { name: c.name }) });
    } catch (e) {
      notifyError(e);
    }
  };
  const readRepository = async (c: ApplicationComponent) => {
    try {
      onSaved(await post<ApplicationDetail>(`/applications/${app.id}/components/${c.id}/repository`, {}));
      notifications.show({ color: 'green', message: t('components.repository.done', { name: c.name }) });
    } catch (e) {
      notifyError(e);
    }
  };
  const readAws = async (c: ApplicationComponent) => {
    try {
      onSaved(await post<ApplicationDetail>(`/applications/${app.id}/components/${c.id}/aws`, {}));
      notifications.show({ color: 'green', message: t('components.aws.done', { name: c.name }) });
    } catch (e) {
      notifyError(e);
    }
  };
  const [drafting, setDrafting] = useState<CredentialDraft | null>(null);
  const [peeking, setPeeking] = useState<ApplicationComponent | null>(null);
  const readTopic = async (c: ApplicationComponent) => {
    try {
      onSaved(await post<ApplicationDetail>(`/applications/${app.id}/components/${c.id}/topic`, {}));
      notifications.show({ color: 'green', message: t('components.topic.done', { name: c.name }) });
    } catch (e) {
      notifyError(e);
    }
  };
  const remove = async (c: ApplicationComponent) => {
    if (!(await confirmDanger({ action: 'remove', message: t('components.removeConfirm', { name: c.name }) }))) return;
    try {
      onSaved(await del<ApplicationDetail>(`/applications/${app.id}/components/${c.id}`));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap="xs" data-testid="application-components">
      <Group justify="space-between">
        <Text fw={600} id="components-title">
          {t('components.title')}
        </Text>
        {editable && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            {t('components.add')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('components.help')}
      </Text>
      {withEnv && (
        <SegmentedControl
          size="xs"
          style={{ alignSelf: 'flex-start' }}
          aria-label={t('environments.filter')}
          data-testid="components-environment-filter"
          value={env ?? '*'}
          onChange={(v) => setEnv(v === '*' ? null : v)}
          data={[{ value: '*', label: t('environments.any') }, ...envs.filter((e) => e).map((e) => ({ value: e, label: e }))]}
        />
      )}
      {app.components.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('components.empty')}
        </Text>
      ) : (
        <div className="table-scroll">
          <Table fz="sm" aria-labelledby="components-title">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('components.type')}</Table.Th>
                <Table.Th>{t('components.name')}</Table.Th>
                {withEnv && <Table.Th>{t('environments.label')}</Table.Th>}
                <Table.Th>{t('components.stack')}</Table.Th>
                {editable && <Table.Th aria-label={t('components.actions')} />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td className="nowrap">
                    <Badge size="sm" variant="default">
                      {t(`components.types.${c.type}`)}
                    </Badge>
                  </Table.Td>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    {c.url ? (
                      <Anchor href={c.url} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                        {c.name} <IconExternalLink size={12} aria-hidden />
                      </Anchor>
                    ) : (
                      <Text span size="sm">
                        {c.name}
                      </Text>
                    )}
                    {c.note && (
                      <Text size="xs" c="dimmed">
                        {c.note}
                      </Text>
                    )}
                    {c.sbom && <SbomLine sbom={c.sbom} />}
                    {c.type === 'kubernetes-namespace' && <ClusterLine component={c} />}
                    {c.type === 'repository' && c.platformId && <RepositoryLine component={c} onRegister={editable ? setDrafting : undefined} />}
                    {c.type === 'kafka-topic' && c.platformId && <TopicLine component={c} />}
                    {c.type === 'cloud-account' && c.platformId && <AwsLine component={c} onRegister={editable ? setDrafting : undefined} />}
                  </Table.Td>
                  {withEnv && (
                    <Table.Td className="nowrap">
                      <EnvironmentBadge value={c.environment} />
                    </Table.Td>
                  )}
                  <Table.Td>
                    <StackBadges stack={c.stack} />
                  </Table.Td>
                  {editable && (
                    <Table.Td className="nowrap">
                      <Group gap={0} wrap="nowrap">
                        <ActionIcon variant="subtle" aria-label={t('components.edit', { name: c.name })} onClick={() => setEditing(c)}>
                          <IconEdit size={16} />
                        </ActionIcon>
                        {c.type === 'kubernetes-namespace' && c.platformId ? (
                          <ActionIcon variant="subtle" aria-label={t('components.cluster.readNow', { name: c.name })} onClick={() => void readCluster(c)}>
                            <IconRefresh size={16} />
                          </ActionIcon>
                        ) : c.type === 'kafka-topic' && c.platformId ? (
                          <>
                            <ActionIcon variant="subtle" aria-label={t('components.topic.readNow', { name: c.name })} onClick={() => void readTopic(c)}>
                              <IconRefresh size={16} />
                            </ActionIcon>
                            <ActionIcon variant="subtle" aria-label={t('components.topic.peek', { name: c.name })} onClick={() => setPeeking(c)}>
                              <IconEye size={16} />
                            </ActionIcon>
                          </>
                        ) : c.type === 'cloud-account' && c.platformId ? (
                          <ActionIcon variant="subtle" aria-label={t('components.aws.readNow', { name: c.name })} onClick={() => void readAws(c)}>
                            <IconRefresh size={16} />
                          </ActionIcon>
                        ) : c.type === 'repository' && c.platformId ? (
                          <ActionIcon variant="subtle" aria-label={t('components.repository.readNow', { name: c.name })} onClick={() => void readRepository(c)}>
                            <IconRefresh size={16} />
                          </ActionIcon>
                        ) : (
                          <ActionIcon variant="subtle" aria-label={t('components.sbom.import', { name: c.name })} onClick={() => setImporting(c)}>
                            <IconFileImport size={16} />
                          </ActionIcon>
                        )}
                        <ActionIcon variant="subtle" color="red" aria-label={t('components.remove', { name: c.name })} onClick={() => void remove(c)}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {app.stack.length > 0 && <StackRollup app={app} />}
      {editing && <ComponentFormModal app={app} component={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
      {peeking && <PeekModal component={peeking} onClose={() => setPeeking(null)} />}
      {drafting && <CredentialEditor initial={null} draft={drafting} onClose={() => setDrafting(null)} onSaved={() => setDrafting(null)} />}
      {importing && (
        <SbomImportModal
          title={t('components.sbom.title', { name: importing.name })}
          base={`/applications/${app.id}/components/${importing.id}/sbom`}
          onClose={() => setImporting(null)}
          onApplied={(r: { preview: SbomPreview; application: ApplicationDetail }) => onSaved(r.application)}
        />
      )}
    </Stack>
  );
}

/** "CycloneDX "orders" imported by … on …" */
/** What Steward last read from a namespace (#111): deployments, unwell pods, certificates, images it could not map. */
function ClusterLine({ component: c }: { component: ApplicationComponent }) {
  const { t } = useTranslation('applications');
  const r = c.cluster;
  if (!c.platformId)
    return (
      <Text size="xs" c="dimmed">
        {t('components.cluster.noCluster')}
      </Text>
    );
  if (!r)
    return (
      <Text size="xs" c="dimmed">
        {t('components.cluster.notRead')}
      </Text>
    );
  const soon = (r.certificates ?? []).filter((x) => x.notAfter && Date.parse(x.notAfter) - Date.now() < 30 * 86_400_000);
  return (
    <Stack gap={0} data-testid="cluster-readout">
      {r.error && (
        <Text size="xs" c="red.8">
          {t('components.cluster.error', { error: r.error })}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {t('components.cluster.read', { date: fmtDate(r.readAt) })} ·{' '}
        {r.deployments.map((d) => `${d.name} ${d.ready}/${d.desired}`).join(', ') || t('components.cluster.noDeployments')}
      </Text>
      {r.unhealthyPods.length > 0 && (
        <Text size="xs" c="orange.8">
          {t('components.cluster.unhealthy', { pods: r.unhealthyPods.map((p) => `${p.name} (${p.reason})`).join(', ') })}
        </Text>
      )}
      {soon.length > 0 && (
        <Text size="xs" c="orange.8">
          {t('components.cluster.certs', { certs: soon.map((x) => `${x.name} ${fmtDate(x.notAfter!)}`).join(', ') })}
        </Text>
      )}
      {r.certificates === null && (
        <Text size="xs" c="dimmed">
          {t('components.cluster.noCertManager')}
        </Text>
      )}
      {r.unmapped.length > 0 && (
        <Text size="xs" c="dimmed">
          {t('components.cluster.unmapped', { images: r.unmapped.join(', ') })}
        </Text>
      )}
    </Stack>
  );
}

/** What Steward last read from a repository (#107): pipeline, release, alerts, packages, keys, files the stack came from. */
function RepositoryLine({ component: c, onRegister }: { component: ApplicationComponent; onRegister?: (d: CredentialDraft) => void }) {
  const { t } = useTranslation('applications');
  const r = c.repository;
  if (!r)
    return (
      <Text size="xs" c="dimmed">
        {t('components.repository.notRead')}
      </Text>
    );
  const color = r.pipeline.state === 'failed' ? 'red.8' : r.pipeline.state === 'success' ? 'green.8' : 'dimmed';
  const alerts = r.alerts ? r.alerts.critical + r.alerts.high + r.alerts.medium + r.alerts.low : 0;
  const draftOf = (k: RepositoryKey): CredentialDraft => ({
    name: `${c.name}: ${k.title}`,
    type: k.kind === 'deploy-key' ? 'sshKey' : 'token',
    belongsTo: { kind: 'component', id: c.id },
    platformId: c.platformId ?? null,
    description: t(`components.repository.keyKinds.${k.kind}`),
    roles: [{ role: k.write ? 'write' : 'read', scope: c.name, grantedAt: k.createdAt, note: k.scopes.join(', ') }],
    issuedAt: k.createdAt,
    expiresAt: k.expiresAt,
  });
  return (
    <Stack gap={0} data-testid="repository-readout">
      {r.error && (
        <Text size="xs" c="red.8">
          {t('components.cluster.error', { error: r.error })}
        </Text>
      )}
      <Text size="xs" c={color}>
        {t('components.cluster.read', { date: fmtDate(r.readAt) })} · {r.defaultBranch ?? '–'}: {t(`components.repository.pipeline.${r.pipeline.state}`)}
        {r.pipeline.runs
          .filter((x) => x.state === 'failed')
          .slice(0, 3)
          .map((x) => ` · ${x.name}`)
          .join('')}
      </Text>
      <Text size="xs" c="dimmed">
        {[
          r.release
            ? t('components.repository.release', { tag: r.release.tag, date: r.release.at ? fmtDate(r.release.at) : '–' })
            : t('components.repository.noRelease'),
          r.packages?.length ? t('components.repository.packages', { names: r.packages.map((x) => x.name).join(', ') }) : null,
          r.stackFiles.length ? t('components.repository.files', { files: r.stackFiles.join(', ') }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {r.alerts && alerts > 0 && (
        <Text size="xs" c={r.alerts.critical + r.alerts.high > 0 ? 'orange.8' : 'dimmed'}>
          {r.alerts.url ? (
            <Anchor size="xs" href={r.alerts.url} target="_blank" rel="noreferrer">
              {t('components.repository.alerts', r.alerts)}
            </Anchor>
          ) : (
            t('components.repository.alerts', r.alerts)
          )}
        </Text>
      )}
      {(r.keys ?? []).map((k) => (
        <Group key={`${k.kind}-${k.id}`} gap={4} wrap="nowrap">
          <Text size="xs" c={k.write ? 'orange.8' : 'dimmed'}>
            {t('components.repository.key', {
              kind: t(`components.repository.keyKinds.${k.kind}`),
              title: k.title,
              access: k.write ? t('components.repository.write') : t('components.repository.readOnly'),
            })}
            {k.expiresAt ? ` · ${t('components.repository.expires', { date: fmtDate(k.expiresAt) })}` : ''}
          </Text>
          {onRegister && (
            <Tooltip label={t('components.repository.register')}>
              <ActionIcon
                size="xs"
                variant="subtle"
                aria-label={t('components.repository.registerKey', { title: k.title })}
                onClick={() => onRegister(draftOf(k))}
              >
                <IconKey size={12} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      ))}
      {r.unmapped.length > 0 && (
        <Text size="xs" c="dimmed">
          {t('components.cluster.unmapped', { images: r.unmapped.join(', ') })}
        </Text>
      )}
    </Stack>
  );
}

const DAY = 86_400_000;

/** What Steward last read from an AWS account for the application tag (#116): resources, costs, IAM users and their keys. */
function AwsLine({ component: c, onRegister }: { component: ApplicationComponent; onRegister?: (d: CredentialDraft) => void }) {
  const { t } = useTranslation('applications');
  const r = c.aws;
  if (!r)
    return (
      <Text size="xs" c="dimmed">
        {t('components.aws.notRead')}
      </Text>
    );
  const months = r.costs.months;
  const last = months.length > 1 ? months[months.length - 2] : null;
  const current = months.length ? months[months.length - 1] : null;
  const money = (n: number, cur: string) => fmtNumber(n, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 });
  const draftOf = (u: AwsIamUser, k: AwsAccessKey): CredentialDraft => ({
    name: `${c.name}: ${u.userName} (${k.accessKeyId})`,
    type: 'apiClient',
    belongsTo: { kind: 'component', id: c.id },
    platformId: c.platformId ?? null,
    description: t('components.aws.keyDescription', { user: u.userName, account: r.account ?? '' }),
    roles: [{ role: 'iam-user', scope: u.arn, grantedAt: k.createdAt, note: k.status }],
    issuedAt: k.createdAt,
    expiresAt: null,
  });
  return (
    <Stack gap={0} data-testid="aws-readout">
      {r.error && (
        <Text size="xs" c="red.8">
          {t('components.cluster.error', { error: r.error })}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {t('components.cluster.read', { date: fmtDate(r.readAt) })} ·{' '}
        {t('components.aws.account', { account: r.account ?? '–', tag: `${r.tagKey}=${r.tagValue}` })} ·{' '}
        {r.resources.length
          ? t('components.aws.resources', {
              count: r.resources.length,
              services: Object.entries(r.services)
                .map(([k, v]) => `${k} ${v}`)
                .join(', '),
            })
          : t('components.aws.noResources')}
      </Text>
      {current && (
        <Text size="xs" c="dimmed">
          {t('components.aws.costs', {
            current: money(current.amount, current.currency),
            last: last ? money(last.amount, last.currency) : '–',
          })}
        </Text>
      )}
      {r.costs.error && (
        <Text size="xs" c="orange.8">
          {t('components.aws.costsError', { error: r.costs.error })}
        </Text>
      )}
      {r.users.flatMap((u) =>
        u.keys.map((k) => {
          const age = Math.floor((Date.now() - Date.parse(k.createdAt)) / DAY);
          const old = k.status === 'Active' && age > AWS_LIMITS.keyAgeDays;
          return (
            <Group key={k.accessKeyId} gap={4} wrap="nowrap">
              <Text size="xs" c={old ? 'orange.8' : 'dimmed'}>
                {t('components.aws.key', {
                  user: u.userName,
                  id: k.accessKeyId,
                  status: k.status === 'Active' ? t('components.aws.active') : t('components.aws.inactive'),
                  age,
                  used: k.lastUsedAt ? t('components.aws.used', { date: fmtDate(k.lastUsedAt), service: k.lastService ?? '–' }) : t('components.aws.neverUsed'),
                })}
              </Text>
              {onRegister && (
                <Tooltip label={t('components.repository.register')}>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    aria-label={t('components.aws.registerKey', { id: k.accessKeyId })}
                    onClick={() => onRegister(draftOf(u, k))}
                  >
                    <IconKey size={12} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          );
        }),
      )}
      {r.warnings.map((w) => (
        <Text key={w} size="xs" c="orange.8">
          {w}
        </Text>
      ))}
    </Stack>
  );
}

/** What Steward last read from a Kafka topic (#112): newest message, partitions, settings, consumer lag, schema. */
function TopicLine({ component: c }: { component: ApplicationComponent }) {
  const { t } = useTranslation('applications');
  const r = c.topic;
  if (!r)
    return (
      <Text size="xs" c="dimmed">
        {t('components.topic.notRead')}
      </Text>
    );
  const retention = r.configs['retention.ms'];
  const days = retention && Number(retention) > 0 ? Math.round(Number(retention) / 86_400_000) : null;
  return (
    <Stack gap={0} data-testid="topic-readout">
      {r.error && (
        <Text size="xs" c="red.8">
          {t('components.cluster.error', { error: r.error })}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {t('components.cluster.read', { date: fmtDate(r.readAt) })} ·{' '}
        {[
          r.lastMessageAt ? t('components.topic.newest', { date: fmtDate(r.lastMessageAt) }) : null,
          t('components.topic.partitions', { count: r.partitions, replicas: r.replicationFactor ?? '–' }),
          r.configs['cleanup.policy'] ? `cleanup.policy=${r.configs['cleanup.policy']}` : null,
          days !== null ? t('components.topic.retention', { days }) : retention === '-1' ? t('components.topic.retentionForever') : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {r.groups.length > 0 && (
        <Text size="xs" c="dimmed">
          {t('components.topic.groups', { groups: r.groups.map((g) => `${g.group} ${g.lag}`).join(', ') })}
        </Text>
      )}
      {r.schema && (
        <Text size="xs" c="dimmed">
          {t('components.topic.schema', { subject: r.schema.subject, version: r.schema.version, type: r.schema.type })}
        </Text>
      )}
    </Stack>
  );
}

/** The newest messages of a topic (#112) – only where the platform allows it and for its managers; sensitive fields hidden. */
function PeekModal({ component: c, onClose }: { component: ApplicationComponent; onClose: () => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const [messages, setMessages] = useState<PeekedMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = async () => {
    setBusy(true);
    try {
      setMessages((await post<{ messages: PeekedMessage[] }>(`/platforms/${c.platformId}/kafka/peek`, { topic: c.name, count: 5 })).messages);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} size="xl" title={t('components.topic.peekTitle', { name: c.name })}>
      <Stack gap="sm">
        <Alert color="yellow">{t('components.topic.peekNote')}</Alert>
        {error && <Alert color="red">{error}</Alert>}
        {messages?.length === 0 && <Text c="dimmed">{t('components.topic.peekEmpty')}</Text>}
        {messages?.map((m) => (
          <Box key={`${m.partition}:${m.offset}`}>
            <Text size="xs" c="dimmed">
              {t('components.topic.peekLine', { partition: m.partition, offset: m.offset, date: m.timestamp ? fmtDate(m.timestamp) : '–', key: m.key ?? '–' })}
              {m.truncated ? ` · ${t('components.topic.truncated')}` : ''}
            </Text>
            <Box component="pre" className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>
              {m.value}
            </Box>
          </Box>
        ))}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:close')}
          </Button>
          <Button onClick={() => void read()} loading={busy}>
            {messages ? t('components.topic.peekAgain') : t('components.topic.peekRead')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function SbomLine({ sbom }: { sbom: NonNullable<ApplicationComponent['sbom']> }) {
  const { t } = useTranslation('applications');
  return (
    <Text size="xs" c="dimmed">
      {t(sbom.name ? 'components.sbom.last' : 'components.sbom.lastNoName', {
        format: formatLabel(sbom.format),
        name: sbom.name,
        user: sbom.importedBy,
        date: fmtDate(sbom.importedAt),
      })}
    </Text>
  );
}

/** The stack of a component or system as end-of-life badges. */
export function StackBadges({ stack }: { stack: StackEntry[] }) {
  const { t } = useTranslation('applications');
  if (stack.length === 0)
    return (
      <Text span size="sm" c="dimmed">
        {t('components.noStack')}
      </Text>
    );
  return (
    <Group gap={4}>
      {stack.map((s) => (
        <LifecycleBadge
          key={s.product}
          text={[s.label, s.version].filter(Boolean).join(' ')}
          lifecycle={s.lifecycle}
          variant={s.source === 'manual' ? 'outline' : 'light'}
          extra={
            s.source === 'sbom'
              ? `${t('components.stackEditor.fromSbom')}: ${s.sbomRef}`
              : s.source === 'cluster'
                ? `${t('components.cluster.fromCluster')}: ${s.sbomRef}`
                : s.source === 'repository'
                  ? `${t('components.repository.fromFiles')}: ${s.sbomRef}`
                  : t('components.stackEditor.manual')
          }
        />
      ))}
    </Group>
  );
}

/** The tech stack of all components and systems together. */
function StackRollup({ app }: { app: ApplicationDetail }) {
  const { t } = useTranslation('applications');
  const named = (x: { name: string; environment: string }) => (x.environment ? `${x.name} (${x.environment})` : x.name);
  return (
    <Stack gap={4} mt="xs" data-testid="application-stack">
      <Text fw={600} size="sm" id="stack-title">
        {t('components.rollup.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('components.rollup.help')}
      </Text>
      <Group gap={6} role="list" aria-labelledby="stack-title">
        {app.stack.map((s) => (
          <LifecycleBadge
            key={`${s.product} ${s.version}`}
            role="listitem"
            text={`${[s.label, s.version].filter(Boolean).join(' ')} · ${t('components.rollup.used', { count: s.components.length + s.systems.length })}`}
            lifecycle={s.lifecycle}
            extra={[...s.components.map(named), ...s.systems.map(named)].join(', ')}
          />
        ))}
      </Group>
    </Stack>
  );
}

export type StackRow = { product: string | null; version: string; source?: StackEntry['source']; was?: string };

export const stackRowsOf = (stack: StackEntry[]): StackRow[] =>
  stack.map((s) => ({ product: s.product, version: s.version, source: s.source, was: s.version }));
export const stackBody = (rows: StackRow[]) => rows.filter((r) => r.product).map((r) => ({ product: r.product!, version: r.version.trim() }));

/** The stack editor: endoflife.date products with the version in use. */
export function StackFields({ stack, onChange }: { stack: StackRow[]; onChange: (rows: StackRow[]) => void }) {
  const { t } = useTranslation('applications');
  const products = useStackProducts();
  const byId = useMemo(() => new Map((products.data?.products ?? []).map((p) => [p.id, p])), [products.data]);
  const productData = useMemo(() => (products.data?.products ?? []).map((p) => ({ value: p.id, label: p.label })), [products.data]);
  const patchRow = (i: number, p: Partial<StackRow>) => onChange(stack.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const chosen = new Set(stack.map((r) => r.product));
  return (
    <Stack gap={6}>
      <Text fw={500} size="sm">
        {t('components.stack')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('components.stackEditor.help')}
      </Text>
      {stack.map((r, i) => {
        const p = r.product ? byId.get(r.product) : undefined;
        const fromSbom = (r.source === 'sbom' || r.source === 'cluster' || r.source === 'repository') && r.version === r.was;
        return (
          <Group key={i} gap="xs" wrap="nowrap" align="flex-end">
            <Select
              style={{ flex: 2 }}
              size="xs"
              label={i === 0 ? t('components.stackEditor.product') : undefined}
              aria-label={t('components.stackEditor.product')}
              placeholder={t('components.stackEditor.productSearch')}
              data={productData.filter((d) => d.value === r.product || !chosen.has(d.value))}
              value={r.product}
              onChange={(x) => patchRow(i, { product: x, source: undefined })}
              searchable
              limit={50}
            />
            <Autocomplete
              style={{ flex: 1 }}
              size="xs"
              label={i === 0 ? t('components.stackEditor.version') : undefined}
              aria-label={t('components.stackEditor.version')}
              data={p?.cycles ?? []}
              value={r.version}
              onChange={(x) => patchRow(i, { version: x })}
            />
            <Box w={90}>
              <Text size="xs" c="dimmed">
                {fromSbom ? t('components.stackEditor.fromSbom') : ''}
              </Text>
            </Box>
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={t('components.stackEditor.remove', { product: p?.label ?? r.product ?? '' })}
              onClick={() => onChange(stack.filter((_, j) => j !== i))}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        );
      })}
      <Group>
        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => onChange([...stack, { product: null, version: '' }])}>
          {t('components.stackEditor.add')}
        </Button>
      </Group>
    </Stack>
  );
}

function ComponentFormModal({
  app,
  component,
  onClose,
  onSaved,
}: {
  app: ApplicationDetail;
  component: ApplicationComponent | null;
  onClose: () => void;
  onSaved: (a: ApplicationDetail) => void;
}) {
  const { t } = useTranslation(['applications', 'common']);
  const [type, setType] = useState<ComponentType>(component?.type ?? 'repository');
  const [name, setName] = useState(component?.name ?? '');
  const [url, setUrl] = useState(component?.url ?? '');
  const [note, setNote] = useState(component?.note ?? '');
  const [environment, setEnvironment] = useState(component?.environment ?? '');
  const [platformId, setPlatformId] = useState<string | null>(component?.platformId ?? null);
  const clusters = useQuery({
    queryKey: ['platforms', 'kubernetes'],
    queryFn: async () => (await get<{ id: string; name: string; kind: string }[]>('/platforms')).filter((p) => p.kind === 'kubernetes'),
    enabled: type === 'kubernetes-namespace',
  });
  const kafkaPlatforms = useQuery({
    queryKey: ['platforms', 'kafka'],
    queryFn: async () => (await get<{ id: string; name: string; kind: string }[]>('/platforms')).filter((p) => p.kind === 'kafka'),
    enabled: type === 'kafka-topic',
  });
  const awsPlatforms = useQuery({
    queryKey: ['platforms', 'aws'],
    queryFn: async () => (await get<{ id: string; name: string; kind: string }[]>('/platforms')).filter((p) => p.kind === AWS_KIND),
    enabled: type === 'cloud-account',
  });
  const gitPlatforms = useQuery({
    queryKey: ['platforms', 'git'],
    queryFn: async () =>
      (await get<{ id: string; name: string; kind: string }[]>('/platforms')).filter((p) => (GIT_PLATFORM_KINDS as readonly string[]).includes(p.kind)),
    enabled: type === 'repository',
  });
  const [stack, setStack] = useState<StackRow[]>(stackRowsOf(component?.stack ?? []));
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    url: !!url.trim() && !/^https?:\/\/\S+$/i.test(url.trim()) && t('common:validation.invalid'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = {
      type,
      name: name.trim(),
      url: url.trim(),
      note,
      environment: environment.trim(),
      ...(type === 'kubernetes-namespace' || type === 'repository' || type === 'kafka-topic' || type === 'cloud-account' ? { platformId } : {}),
      stack: stackBody(stack),
    };
    try {
      onSaved(
        component
          ? await put<ApplicationDetail>(`/applications/${app.id}/components/${component.id}`, body)
          : await post<ApplicationDetail>(`/applications/${app.id}/components`, body),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      opened
      onClose={onClose}
      size="lg"
      title={component ? t('components.editTitle', { name: component.name }) : t('components.addTitle', { name: app.name })}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Group grow align="flex-start">
            <Select
              label={t('components.type')}
              data={COMPONENT_TYPES.map((x) => ({ value: x, label: t(`components.types.${x}`) }))}
              value={type}
              allowDeselect={false}
              onChange={(x) => x && setType(x as ComponentType)}
            />
            <TextInput
              label={t('components.name')}
              description={t('components.nameHint')}
              required
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              error={v.error('name')}
              data-autofocus
            />
          </Group>
          <EnvironmentInput value={environment} onChange={setEnvironment} allowAll description={t('environments.componentHint')} />
          {type === 'kubernetes-namespace' && (
            <Select
              label={t('components.cluster.platform')}
              description={t('components.cluster.platformHint')}
              data={(clusters.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
              value={platformId}
              onChange={setPlatformId}
              clearable
              nothingFoundMessage={t('components.cluster.noPlatforms')}
            />
          )}
          {type === 'kafka-topic' && (
            <Select
              label={t('components.topic.platform')}
              description={t('components.topic.platformHint')}
              data={(kafkaPlatforms.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
              value={platformId}
              onChange={setPlatformId}
              clearable
              nothingFoundMessage={t('components.topic.noPlatforms')}
            />
          )}
          {type === 'cloud-account' && (
            <Select
              label={t('components.aws.platform')}
              description={t('components.aws.platformHint')}
              data={(awsPlatforms.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
              value={platformId}
              onChange={setPlatformId}
              clearable
              nothingFoundMessage={t('components.aws.noPlatforms')}
            />
          )}
          {type === 'repository' && (
            <Select
              label={t('components.repository.platform')}
              description={t('components.repository.platformHint')}
              data={(gitPlatforms.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
              value={platformId}
              onChange={setPlatformId}
              clearable
              nothingFoundMessage={t('components.repository.noPlatforms')}
            />
          )}
          <TextInput label={t('components.url')} placeholder="https://" value={url} onChange={(e) => setUrl(e.currentTarget.value)} error={v.error('url')} />
          <Textarea label={t('components.note')} autosize minRows={1} maxRows={4} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          <StackFields stack={stack} onChange={setStack} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

const ACTION_COLORS: Record<SbomChange['action'], string> = { add: 'green', update: 'blue', remove: 'red', keep: 'gray', manual: 'yellow' };

/** Upload or fetch an SBOM, show what it changes, then import it (into a component or a system: `base`). */
export function SbomImportModal<R extends { preview: SbomPreview }>({
  title,
  base,
  onClose,
  onApplied,
}: {
  title: string;
  base: string;
  onClose: () => void;
  onApplied: (r: R) => void;
}) {
  const { t } = useTranslation(['applications', 'common']);
  const [mode, setMode] = useState<'file' | 'url'>('file');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<SbomPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const body = mode === 'file' ? (file ? { sbom: file.text } : null) : url.trim() ? { url: url.trim() } : null;
  const show = async () => {
    if (!body) return;
    setBusy(true);
    try {
      setPreview(await post<SbomPreview>(`${base}/preview`, body));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!body) return;
    setBusy(true);
    try {
      const r = await post<R>(base, body);
      const n = (a: SbomChange['action']) => r.preview.changes.filter((c) => c.action === a).length;
      notifications.show({ color: 'green', message: t('components.sbom.done', { added: n('add'), updated: n('update'), removed: n('remove') }) });
      onApplied(r);
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  const reset = () => setPreview(null);
  const changing = preview?.changes.filter((c) => c.action !== 'keep') ?? [];
  return (
    <Modal opened onClose={onClose} size="lg" title={title}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('components.sbom.help')}
        </Text>
        <SegmentedControl
          value={mode}
          onChange={(x) => {
            setMode(x as 'file' | 'url');
            reset();
          }}
          data={[
            { value: 'file', label: t('components.sbom.file') },
            { value: 'url', label: t('components.sbom.url') },
          ]}
        />
        {mode === 'file' ? (
          <Group>
            <FileButton
              accept=".json,application/json,application/vnd.cyclonedx+json,application/spdx+json"
              onChange={(f) => {
                if (!f) return;
                void f.text().then((text) => {
                  setFile({ name: f.name, text });
                  reset();
                });
              }}
            >
              {(props) => (
                <Button {...props} variant="default" leftSection={<IconFileImport size={14} />}>
                  {t('components.sbom.chooseFile')}
                </Button>
              )}
            </FileButton>
            {file && (
              <Text size="sm" c="dimmed">
                {t('components.sbom.fileChosen', { name: file.name, size: Math.ceil(file.text.length / 1024) })}
              </Text>
            )}
          </Group>
        ) : (
          <TextInput
            label={t('components.sbom.urlLabel')}
            description={t('components.sbom.urlHint')}
            placeholder="https://"
            value={url}
            onChange={(e) => {
              setUrl(e.currentTarget.value);
              reset();
            }}
          />
        )}
        {preview && (
          <Stack gap="xs" data-testid="sbom-preview">
            <Text size="sm">
              {t(preview.name ? 'components.sbom.summary' : 'components.sbom.summaryNoName', {
                format: formatLabel(preview.format),
                name: preview.name,
                matched: preview.matched,
                total: preview.total,
              })}
            </Text>
            {changing.length === 0 ? (
              <Alert color="gray">{t('components.sbom.nothing')}</Alert>
            ) : (
              <div className="table-scroll">
                <Table fz="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('components.sbom.change')}</Table.Th>
                      <Table.Th>{t('components.stackEditor.product')}</Table.Th>
                      <Table.Th>{t('components.stackEditor.version')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {changing.map((c) => (
                      <Table.Tr key={c.product}>
                        <Table.Td className="nowrap">
                          <Badge size="sm" variant="light" color={ACTION_COLORS[c.action]}>
                            {t(`components.sbom.actions.${c.action}`)}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Tooltip label={c.sbomRef} disabled={!c.sbomRef}>
                            <span>{c.label}</span>
                          </Tooltip>
                        </Table.Td>
                        <Table.Td>
                          {c.action === 'update'
                            ? t('components.sbom.versionChange', { from: c.other || '–', to: c.version || '–' })
                            : c.action === 'manual'
                              ? `${c.version || '–'} (${t('components.sbom.manualKept', { version: c.other || '–' })})`
                              : c.version || '–'}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            )}
          </Stack>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          {preview ? (
            <Button onClick={() => void apply()} loading={busy} disabled={!body}>
              {t('components.sbom.apply')}
            </Button>
          ) : (
            <Button onClick={() => void show()} loading={busy} disabled={!body}>
              {t('components.sbom.preview')}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
