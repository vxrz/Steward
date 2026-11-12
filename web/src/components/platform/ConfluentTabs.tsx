import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ActionIcon, Alert, Anchor, Badge, Button, Code, Collapse, Group, Paper, Stack, Table, Text, Title, Tooltip, VisuallyHidden } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconArrowsExchange, IconKey, IconRefresh, IconSchema, IconServer2 } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ConfluentApiKeyView, ConfluentConnectorView, ConfluentView, Platform } from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { useMe } from '../../auth';
import { EmptyState, Hint, QueryState } from '../common';
import { fmtDate, fmtRelative } from '../../format';
import { platformKeys } from '../../queryKeys';
import { CredentialEditor, type CredentialDraft } from '../credentials/CredentialEditor';

/**
 * A Confluent Cloud platform's tabs (0.14.0, #123, docs/CONFLUENT.md): what Steward last read from the Cloud API –
 * clusters and environments, the Schema Registry's subjects, the managed connectors, service accounts and API keys –
 * with "Read now". Read-only: nothing here changes Confluent Cloud. API keys are shown as metadata (never a secret) and
 * can be taken into the credentials register, reviewed before they are saved.
 */

const PHASE_COLORS: Record<string, string> = { PROVISIONED: 'green', PROVISIONING: 'blue', FAILED: 'red' };
const STATE_COLORS: Record<string, string> = {
  RUNNING: 'green',
  PAUSED: 'yellow',
  PROVISIONING: 'blue',
  DEGRADED: 'orange',
  FAILED: 'red',
  UNASSIGNED: 'orange',
  NONE: 'gray',
  DELETED: 'gray',
};
const HINT_COLORS: Record<ConfluentApiKeyView['hint'], string> = { expired: 'red', expiring: 'orange', rotate: 'yellow', ok: 'gray' };

function useConfluent(platformId: string) {
  return useQuery({ queryKey: platformKeys.confluent(platformId), queryFn: () => get<ConfluentView>(`/platforms/${platformId}/confluent`) });
}

/** The head of every tab: the title and help, when it was read, Read now, and why a read or a part of it failed. */
function Head({ platform, v, title, help }: { platform: Platform; v: ConfluentView; title: string; help: string }) {
  const { t } = useTranslation('platforms');
  const qc = useQueryClient();
  const [reading, setReading] = useState(false);
  const readNow = async () => {
    setReading(true);
    try {
      qc.setQueryData(platformKeys.confluent(platform.id), await post<ConfluentView>(`/platforms/${platform.id}/confluent/read`));
    } catch (e) {
      notifyError(e, t('confluent.readFailed'));
    } finally {
      setReading(false);
    }
  };
  return (
    <>
      <Paper withBorder p="md">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <div style={{ flex: 1, minWidth: 220 }}>
            <Title order={5}>{title}</Title>
            <Hint>{help}</Hint>
          </div>
          {v.canRead && (
            <Button size="xs" leftSection={<IconRefresh size={14} />} loading={reading} onClick={() => void readNow()} data-testid="confluent-read">
              {t('confluent.readNow')}
            </Button>
          )}
        </Group>
        {v.readAt && (
          <Text size="xs" c="dimmed" mt="xs" title={fmtDate(v.readAt)} data-testid="confluent-read-at">
            {t('confluent.read', { when: fmtRelative(v.readAt) })}
          </Text>
        )}
      </Paper>
      {v.error && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title={t('confluent.readError')} data-testid="confluent-read-error">
          <Text size="sm" style={{ wordBreak: 'break-word' }}>
            {v.error}
          </Text>
        </Alert>
      )}
      {v.partErrors.length > 0 && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} title={t('confluent.partErrors')} data-testid="confluent-part-errors">
          <Stack gap={2}>
            {v.partErrors.map((x) => (
              <Text key={x.part} size="sm" style={{ wordBreak: 'break-word' }}>
                {t(`confluent.parts.${x.part}`)}: {x.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
    </>
  );
}

/** One tab: loads the view (shared by the tabs), shows the head and the body. */
function TabShell({ platform, title, help, children }: { platform: Platform; title: string; help: string; children: (v: ConfluentView) => ReactNode }) {
  const q = useConfluent(platform.id);
  if (!q.data) return <QueryState query={q} rows={3} />;
  return (
    <Stack gap="sm">
      <Head platform={platform} v={q.data} title={title} help={help} />
      {children(q.data)}
    </Stack>
  );
}

function Phase({ phase }: { phase: string }) {
  return (
    <Badge size="sm" variant="light" color={PHASE_COLORS[phase] ?? 'gray'}>
      {phase || '–'}
    </Badge>
  );
}

// ---------- clusters ----------

export function ConfluentClustersTab({ platform }: { platform: Platform }) {
  const { t } = useTranslation('platforms');
  return (
    <TabShell platform={platform} title={t('confluent.clustersTitle')} help={t('confluent.clustersHelp')}>
      {(v) =>
        !v.clusters.length ? (
          <EmptyState icon={IconServer2} title={v.readAt ? t('confluent.noClusters') : t('confluent.notRead')} testId="confluent-clusters-empty">
            {v.readAt ? t('confluent.noClustersHint') : t('confluent.notReadHint')}
          </EmptyState>
        ) : (
          <>
            <Text size="sm" data-testid="confluent-summary">
              {t('confluent.summary', { environments: v.environments.length, clusters: v.clusters.length, connectors: v.connectors.length })}
            </Text>
            <div className="table-scroll" tabIndex={0} role="region" aria-label={t('confluent.parts.clusters')}>
              <Table fz="sm" data-testid="confluent-clusters">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('confluent.cluster')}</Table.Th>
                    <Table.Th>{t('confluent.environment')}</Table.Th>
                    <Table.Th>{t('confluent.type')}</Table.Th>
                    <Table.Th>{t('confluent.location')}</Table.Th>
                    <Table.Th>{t('confluent.status')}</Table.Th>
                    <Table.Th>{t('confluent.kafkaPlatform')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {v.clusters.map((c) => (
                    <Table.Tr key={c.id} data-testid="confluent-cluster" data-id={c.id}>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {c.name}
                        </Text>
                        <Text size="xs" c="dimmed" className="mono">
                          {c.id}
                        </Text>
                      </Table.Td>
                      <Table.Td>{c.environmentName}</Table.Td>
                      <Table.Td>
                        {c.type || '–'}
                        {c.cku ? ` · ${t('confluent.cku', { count: c.cku })}` : ''}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{[c.cloud, c.region].filter(Boolean).join(' · ') || '–'}</Text>
                        <Text size="xs" c="dimmed">
                          {c.availability
                            ? t(`confluent.availability.${c.availability === 'MULTI_ZONE' || c.availability === 'HIGH' ? 'multi' : 'single'}`)
                            : ''}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Phase phase={c.phase} />
                      </Table.Td>
                      <Table.Td>
                        {c.kafkaPlatform ? (
                          <Anchor component={Link} to={`/platforms/${c.kafkaPlatform.id}`} size="sm">
                            {c.kafkaPlatform.name}
                          </Anchor>
                        ) : (
                          <Text size="xs" c="dimmed">
                            {t('confluent.noKafkaPlatform')}
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            <Hint>{t('confluent.kafkaPlatformHint')}</Hint>
            {v.environments.some((e) => !v.clusters.some((c) => c.environmentId === e.id)) && (
              <Text size="xs" c="dimmed">
                {t('confluent.emptyEnvironments', {
                  names: v.environments
                    .filter((e) => !v.clusters.some((c) => c.environmentId === e.id))
                    .map((e) => e.name)
                    .join(', '),
                })}
              </Text>
            )}
          </>
        )
      }
    </TabShell>
  );
}

// ---------- schemas ----------

export function ConfluentSchemasTab({ platform }: { platform: Platform }) {
  const { t } = useTranslation('platforms');
  return (
    <TabShell platform={platform} title={t('confluent.schemasTitle')} help={t('confluent.schemasHelp')}>
      {(v) => (
        <>
          {v.schemaRegistries.length > 0 && (
            <div className="table-scroll" tabIndex={0} role="region" aria-label={t('confluent.parts.schemaRegistries')}>
              <Table fz="sm" data-testid="confluent-registries">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('confluent.registry')}</Table.Th>
                    <Table.Th>{t('confluent.environment')}</Table.Th>
                    <Table.Th>{t('confluent.package')}</Table.Th>
                    <Table.Th>{t('confluent.endpoint')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {v.schemaRegistries.map((r) => (
                    <Table.Tr key={r.id}>
                      <Table.Td className="mono">{r.id}</Table.Td>
                      <Table.Td>{v.environments.find((e) => e.id === r.environmentId)?.name ?? r.environmentId}</Table.Td>
                      <Table.Td>{r.package || '–'}</Table.Td>
                      <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {r.endpoint || '–'}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
          {!v.registry ? (
            <EmptyState icon={IconSchema} title={t('confluent.noRegistry')} testId="confluent-subjects-empty">
              {t('confluent.noRegistryHint')}
            </EmptyState>
          ) : (
            <>
              <Text size="sm" data-testid="confluent-registry">
                {t('confluent.registryRead', { url: v.registry.url, count: v.registry.subjects.length, level: v.registry.compatibility ?? '–' })}
              </Text>
              {v.registry.truncated && <Hint>{t('confluent.subjectsTruncated')}</Hint>}
              <div className="table-scroll" tabIndex={0} role="region" aria-label={t('confluent.parts.subjects')}>
                <Table fz="sm" data-testid="confluent-subjects">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('confluent.subject')}</Table.Th>
                      <Table.Th>{t('confluent.versions')}</Table.Th>
                      <Table.Th>{t('confluent.compatibility')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {v.registry.subjects.map((x) => (
                      <Table.Tr key={x.name} data-testid="confluent-subject" data-name={x.name}>
                        <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                          {x.name}
                        </Table.Td>
                        <Table.Td>{x.versions === null ? '–' : t('confluent.versionCount', { count: x.versions, latest: x.latest ?? '–' })}</Table.Td>
                        <Table.Td>
                          {x.compatibility ?? '–'}
                          {x.compatibility && (
                            <Text span size="xs" c="dimmed">
                              {' '}
                              ({x.ownCompatibility ? t('confluent.ownLevel') : t('confluent.registryLevel')})
                            </Text>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            </>
          )}
        </>
      )}
    </TabShell>
  );
}

// ---------- connectors ----------

export function ConfluentConnectorsTab({ platform }: { platform: Platform }) {
  const { t } = useTranslation('platforms');
  return (
    <TabShell platform={platform} title={t('confluent.connectorsTitle')} help={t('confluent.connectorsHelp')}>
      {(v) => {
        if (!v.connectors.length)
          return (
            <EmptyState icon={IconArrowsExchange} title={v.readAt ? t('confluent.noConnectors') : t('confluent.notRead')} testId="confluent-connectors-empty">
              {v.readAt ? t('confluent.noConnectorsHint') : t('confluent.notReadHint')}
            </EmptyState>
          );
        const failedTasks = v.connectors.reduce((n, c) => n + c.tasks.filter((x) => x.state === 'FAILED').length, 0);
        const running = v.connectors.filter((c) => c.state === 'RUNNING').length;
        const clusterName = (id: string) => v.clusters.find((c) => c.id === id)?.name ?? id;
        return (
          <>
            <Group gap="xs" wrap="wrap" data-testid="confluent-connector-summary">
              <Text size="sm">{t('connect.summary', { count: v.connectors.length, running })}</Text>
              {failedTasks > 0 && (
                <Badge color="red" variant="light" leftSection={<IconAlertTriangle size={12} />}>
                  {t('connect.failedTasks', { count: failedTasks })}
                </Badge>
              )}
            </Group>
            <Stack gap="xs">
              {v.connectors.map((c) => (
                <ConnectorCard key={`${c.clusterId}/${c.name}`} c={c} cluster={clusterName(c.clusterId)} />
              ))}
            </Stack>
          </>
        );
      }}
    </TabShell>
  );
}

function ConnectorCard({ c, cluster }: { c: ConfluentConnectorView; cluster: string }) {
  const { t } = useTranslation('platforms');
  const [traces, setTraces] = useState(false);
  const failed = [
    ...(c.trace ? [{ id: null as number | null, trace: c.trace, since: null as string | null }] : []),
    ...c.tasks.filter((x) => x.trace).map((x) => ({ id: x.id, trace: x.trace!, since: x.failedSince })),
  ];
  const byTopic = new Map<string, ConfluentConnectorView['topicComponents']>();
  for (const x of c.topicComponents) byTopic.set(x.topic, [...(byTopic.get(x.topic) ?? []), x]);
  return (
    <Paper withBorder p="sm" data-testid="confluent-connector" data-name={c.name}>
      <Group gap={6} wrap="wrap">
        <Text fw={600} size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
          {c.name}
        </Text>
        <Badge size="sm" variant="default">
          {t(`connect.types.${c.type}`)}
        </Badge>
        <Badge size="sm" variant="light" color={STATE_COLORS[c.state] ?? 'gray'}>
          {c.state}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
        <span className="mono">{c.class || '–'}</span> · {t('confluent.onCluster', { cluster })}
        {c.id ? ` · ${c.id}` : ''}
      </Text>
      <Stack gap={4} mt={6}>
        <Group gap={6} wrap="wrap" data-testid="confluent-tasks">
          <Text size="xs" c="dimmed">
            {t('connect.tasks', { count: c.tasks.length })}
          </Text>
          {c.tasks.map((x) => (
            <Badge key={x.id} size="sm" variant="outline" color={STATE_COLORS[x.state] ?? 'gray'} style={{ textTransform: 'none' }}>
              {t('connect.task', { id: x.id, state: x.state })}
            </Badge>
          ))}
        </Group>
        {c.topics.length > 0 && (
          <Group gap={6} wrap="wrap" data-testid="confluent-topics">
            <Text size="xs" c="dimmed">
              {c.type === 'sink' ? t('connect.reads') : t('connect.writes')}
            </Text>
            {c.topics.map((topic) => (
              <Text key={topic} size="xs" span>
                <Code>{topic}</Code>
                {(byTopic.get(topic) ?? []).map((x) => (
                  <Anchor key={x.componentId} component={Link} to={`/applications/${x.applicationId}`} size="xs" ml={4}>
                    {x.applicationName}
                  </Anchor>
                ))}
              </Text>
            ))}
          </Group>
        )}
        {failed.length > 0 && (
          <div>
            <Anchor
              component="button"
              type="button"
              size="xs"
              c="red"
              onClick={() => setTraces((x) => !x)}
              aria-expanded={traces}
              data-testid="confluent-trace-toggle"
            >
              {traces ? t('connect.hideErrors') : t('connect.showErrors', { count: failed.length })}
            </Anchor>
            <Collapse expanded={traces}>
              <Stack gap={6} mt={4}>
                {failed.map((f) => (
                  <div key={f.id ?? 'connector'}>
                    <Text size="xs" fw={500}>
                      {f.id === null ? t('connect.connectorError') : t('connect.taskError', { id: f.id })}
                      {f.since ? ` · ${t('connect.failedSince', { when: fmtRelative(f.since) })}` : ''}
                    </Text>
                    <Code
                      block
                      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--mantine-font-size-xs)' }}
                      data-testid="confluent-trace"
                    >
                      {f.trace.replace(/\t/g, '  ')}
                    </Code>
                  </div>
                ))}
                <Hint>{t('connect.traceHint')}</Hint>
              </Stack>
            </Collapse>
          </div>
        )}
      </Stack>
    </Paper>
  );
}

// ---------- service accounts and API keys ----------

export function ConfluentKeysTab({ platform }: { platform: Platform }) {
  const { t } = useTranslation('platforms');
  const { hasRole } = useMe();
  // like the credentials register: administrators, designers and operators add entries
  const canRegister = hasRole('admin') || hasRole('designer') || hasRole('operator');
  const [drafting, setDrafting] = useState<CredentialDraft | null>(null);
  const draftOf = (k: ConfluentApiKeyView): CredentialDraft => ({
    name: t('confluent.keyEntryName', { platform: platform.name, key: k.id }),
    type: 'apiClient',
    platformId: platform.id,
    description: t('confluent.keyEntryDescription', {
      name: k.name || k.id,
      owner: k.ownerName ? `${k.ownerName} (${k.ownerId})` : k.ownerId,
      resource: k.resourceId ?? t('confluent.cloudKey'),
    }),
    roles: [{ role: k.ownerKind || 'owner', scope: k.resourceId ?? 'cloud', grantedAt: k.createdAt, note: k.ownerId }],
    issuedAt: k.createdAt,
    expiresAt: k.expiresAt,
  });
  return (
    <TabShell platform={platform} title={t('confluent.keysTitle')} help={t('confluent.keysHelp')}>
      {(v) =>
        !v.apiKeys ? (
          <Alert color="gray" variant="light">
            {t('confluent.keysHidden')}
          </Alert>
        ) : !v.apiKeys.length ? (
          <EmptyState icon={IconKey} title={v.readAt ? t('confluent.noKeys') : t('confluent.notRead')} testId="confluent-keys-empty">
            {v.readAt ? t('confluent.noKeysHint') : t('confluent.notReadHint')}
          </EmptyState>
        ) : (
          <>
            <Text size="sm" data-testid="confluent-keys-summary">
              {t('confluent.keysSummary', { count: v.apiKeys.length, accounts: v.serviceAccounts?.length ?? 0 })}
            </Text>
            <div className="table-scroll" tabIndex={0} role="region" aria-label={t('confluent.parts.apiKeys')}>
              <Table fz="sm" data-testid="confluent-keys">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('confluent.key')}</Table.Th>
                    <Table.Th>{t('confluent.owner')}</Table.Th>
                    <Table.Th>{t('confluent.resource')}</Table.Th>
                    <Table.Th>{t('confluent.created')}</Table.Th>
                    <Table.Th>{t('confluent.expires')}</Table.Th>
                    {canRegister && (
                      <Table.Th>
                        <VisuallyHidden>{t('confluent.register')}</VisuallyHidden>
                      </Table.Th>
                    )}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {v.apiKeys.map((k) => (
                    <Table.Tr key={k.id} data-testid="confluent-key" data-id={k.id}>
                      <Table.Td>
                        <Text size="sm" className="mono">
                          {k.id}
                        </Text>
                        {k.name && (
                          <Text size="xs" c="dimmed">
                            {k.name}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{k.ownerName ?? k.ownerId}</Text>
                        <Text size="xs" c="dimmed" className="mono">
                          {k.ownerId}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" className="mono">
                          {k.resourceId ?? t('confluent.cloudKey')}
                        </Text>
                        {k.resourceKind && (
                          <Text size="xs" c="dimmed">
                            {k.resourceKind}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td className="nowrap">{k.createdAt ? fmtDate(k.createdAt) : '–'}</Table.Td>
                      <Table.Td>
                        <Text size="sm" className="nowrap">
                          {k.expiresAt ?? t('confluent.never')}
                        </Text>
                        {k.hint !== 'ok' && (
                          <Badge size="sm" variant="light" color={HINT_COLORS[k.hint]} data-testid="confluent-key-hint">
                            {t(`confluent.hints.${k.hint}`)}
                          </Badge>
                        )}
                      </Table.Td>
                      {canRegister && (
                        <Table.Td>
                          <Tooltip label={t('confluent.register')}>
                            <ActionIcon
                              variant="subtle"
                              size="sm"
                              aria-label={t('confluent.registerKey', { key: k.id })}
                              onClick={() => setDrafting(draftOf(k))}
                            >
                              <IconKey size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </Table.Td>
                      )}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            <Hint>{t('confluent.keysHint')}</Hint>
            {!!v.serviceAccounts?.length && (
              <div className="table-scroll" tabIndex={0} role="region" aria-label={t('confluent.parts.serviceAccounts')}>
                <Table fz="sm" data-testid="confluent-accounts">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('confluent.serviceAccount')}</Table.Th>
                      <Table.Th>{t('confluent.description')}</Table.Th>
                      <Table.Th>{t('confluent.keyCount')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {v.serviceAccounts.map((a) => (
                      <Table.Tr key={a.id}>
                        <Table.Td>
                          <Text size="sm">{a.name}</Text>
                          <Text size="xs" c="dimmed" className="mono">
                            {a.id}
                          </Text>
                        </Table.Td>
                        <Table.Td>{a.description || '–'}</Table.Td>
                        <Table.Td>{v.apiKeys!.filter((k) => k.ownerId === a.id).length}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            )}
            {drafting && <CredentialEditor initial={null} draft={drafting} onClose={() => setDrafting(null)} onSaved={() => setDrafting(null)} />}
          </>
        )
      }
    </TabShell>
  );
}
