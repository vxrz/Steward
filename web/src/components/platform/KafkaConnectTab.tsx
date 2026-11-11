import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Anchor, Badge, Button, Code, Collapse, Group, Modal, Paper, Stack, Table, Text, Title, UnstyledButton } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconArrowsExchange,
  IconChevronDown,
  IconChevronRight,
  IconDatabase,
  IconFileCode,
  IconRefresh,
  IconServer,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ConnectConnectorView, ConnectView, Platform } from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { EmptyState, Hint, QueryState } from '../common';
import { fmtDate, fmtRelative } from '../../format';
import { platformKeys } from '../../queryKeys';
import { TableScroll } from '../TableScroll';

/**
 * Platform → Connectors (0.9.0, #223, docs/KAFKA.md#kafka-connect-and-debezium): what Steward last read from a Kafka
 * Connect cluster – connectors with type, class, version, state and topics, their tasks with the error of a failed one,
 * the plugins – and the links: Kafka topic components of applications and, for Debezium connectors, the database
 * platform and system they read. Read-only: nothing here restarts, pauses or resumes a connector. A configuration is
 * read on request, with its secret-looking values removed, and never stored.
 */

const STATE_COLORS: Record<string, string> = { RUNNING: 'green', PAUSED: 'yellow', STOPPED: 'gray', FAILED: 'red', UNASSIGNED: 'orange', RESTARTING: 'blue' };

export function StateBadge({ state }: { state: string }) {
  return (
    <Badge size="sm" variant="light" color={STATE_COLORS[state] ?? 'gray'} data-testid="connect-state">
      {state}
    </Badge>
  );
}

export function KafkaConnectTab({ platform }: { platform: Platform }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: platformKeys.kafkaConnect(platform.id), queryFn: () => get<ConnectView>(`/platforms/${platform.id}/kafka-connect`) });
  const [reading, setReading] = useState(false);
  const [config, setConfig] = useState<string | null>(null);
  const [showPlugins, setShowPlugins] = useState(false);
  const v = q.data;

  const readNow = async () => {
    setReading(true);
    try {
      qc.setQueryData(platformKeys.kafkaConnect(platform.id), await post<ConnectView>(`/platforms/${platform.id}/kafka-connect/read`));
    } catch (e) {
      notifyError(e, t('connect.readFailed'));
    } finally {
      setReading(false);
    }
  };

  if (!v) return <QueryState query={q} rows={3} />;
  const r = v.readout;
  const failedTasks = v.connectors.reduce((n, c) => n + c.tasks.filter((x) => x.state === 'FAILED').length, 0);
  const running = v.connectors.filter((c) => c.state === 'RUNNING').length;

  return (
    <Stack gap="sm" data-testid="connect-tab">
      <Paper withBorder p="md">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <div style={{ flex: 1, minWidth: 220 }}>
            <Title order={5}>{t('connect.title')}</Title>
            <Hint>{t('connect.help')}</Hint>
          </div>
          {v.canRead && (
            <Button size="xs" leftSection={<IconRefresh size={14} />} loading={reading} onClick={() => void readNow()} data-testid="connect-read">
              {t('connect.readNow')}
            </Button>
          )}
        </Group>
        <Group gap="xs" mt="xs" wrap="wrap">
          {r && (
            <Text size="xs" c="dimmed" title={fmtDate(r.readAt)}>
              {t('connect.read', { when: fmtRelative(r.readAt) })}
              {r.worker?.version ? ` · ${t('connect.worker', { version: r.worker.version })}` : ''}
            </Text>
          )}
          <Text size="xs" c="dimmed" data-testid="connect-kafka">
            {v.kafkaPlatform ? (
              <>
                {t('connect.kafkaPlatform')}{' '}
                <Anchor component={Link} to={`/platforms/${v.kafkaPlatform.id}`} size="xs">
                  {v.kafkaPlatform.name}
                </Anchor>
              </>
            ) : v.kafkaPlatformMissing ? (
              t('connect.kafkaPlatformMissing')
            ) : (
              t('connect.kafkaPlatformNone')
            )}
          </Text>
        </Group>
      </Paper>
      {r?.error && (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          title={t('connect.readError', { when: fmtRelative(r.readAt) })}
          data-testid="connect-read-error"
        >
          <Text size="sm" style={{ wordBreak: 'break-word' }}>
            {r.error}
          </Text>
        </Alert>
      )}
      {!v.connectors.length ? (
        <EmptyState
          icon={IconArrowsExchange}
          title={r ? t('connect.emptyRead') : t('connect.empty')}
          whoCanAct={v.canRead ? undefined : t('connect.who')}
          testId="connect-empty"
        >
          {r ? t('connect.emptyReadHint') : t('connect.emptyHint')}
        </EmptyState>
      ) : (
        <>
          <Group gap="xs" wrap="wrap" data-testid="connect-summary">
            <Text size="sm">{t('connect.summary', { count: v.connectors.length, running })}</Text>
            {failedTasks > 0 && (
              <Badge color="red" variant="light" leftSection={<IconAlertTriangle size={12} />}>
                {t('connect.failedTasks', { count: failedTasks })}
              </Badge>
            )}
          </Group>
          <Stack gap="xs" data-testid="connect-connectors">
            {v.connectors.map((c) => (
              <ConnectorCard key={c.name} c={c} canRead={v.canRead} onConfig={() => setConfig(c.name)} />
            ))}
          </Stack>
        </>
      )}
      {!!r?.plugins.length && (
        <Paper withBorder p="sm">
          <UnstyledButton onClick={() => setShowPlugins((x) => !x)} aria-expanded={showPlugins} data-testid="connect-plugins-toggle">
            <Group gap={6} wrap="nowrap">
              {showPlugins ? <IconChevronDown size={14} aria-hidden /> : <IconChevronRight size={14} aria-hidden />}
              <Text size="sm" fw={500}>
                {t('connect.plugins', { count: r.plugins.length })}
              </Text>
            </Group>
          </UnstyledButton>
          <Collapse expanded={showPlugins}>
            <TableScroll style={{ marginTop: 'var(--mantine-spacing-xs)' }}>
              <Table fz="sm" data-testid="connect-plugins">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('connect.pluginClass')}</Table.Th>
                    <Table.Th>{t('connect.type')}</Table.Th>
                    <Table.Th>{t('connect.version')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {r.plugins.map((p) => (
                    <Table.Tr key={p.class}>
                      <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {p.class}
                      </Table.Td>
                      <Table.Td>{t(`connect.types.${p.type === 'source' || p.type === 'sink' ? p.type : 'unknown'}`)}</Table.Td>
                      <Table.Td className="mono nowrap">{p.version}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </TableScroll>
          </Collapse>
        </Paper>
      )}
      {config && <ConfigModal platformId={platform.id} name={config} onClose={() => setConfig(null)} />}
    </Stack>
  );
}

function ConnectorCard({ c, canRead, onConfig }: { c: ConnectConnectorView; canRead: boolean; onConfig: () => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  const [traces, setTraces] = useState(false);
  const failed = [
    ...(c.trace ? [{ id: null as number | null, trace: c.trace, since: null as string | null }] : []),
    ...c.tasks.filter((x) => x.trace).map((x) => ({ id: x.id, trace: x.trace!, since: x.failedSince })),
  ];
  const byTopic = new Map<string, ConnectConnectorView['topicComponents']>();
  for (const x of c.topicComponents) byTopic.set(x.topic, [...(byTopic.get(x.topic) ?? []), x]);
  return (
    <Paper withBorder p="sm" data-testid="connect-connector" data-name={c.name}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Text fw={600} size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
              {c.name}
            </Text>
            <Badge size="sm" variant="default">
              {t(`connect.types.${c.type}`)}
            </Badge>
            <StateBadge state={c.state} />
          </Group>
          <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
            {c.class || '–'}
            {c.version ? ` ${c.version}` : ''}
          </Text>
        </div>
        {canRead && (
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<IconFileCode size={14} />}
            onClick={onConfig}
            aria-label={t('connect.configOf', { name: c.name })}
          >
            {t('connect.config')}
          </Button>
        )}
      </Group>
      <Stack gap={4} mt={6}>
        <Group gap={6} wrap="wrap" data-testid="connect-tasks">
          <Text size="xs" c="dimmed">
            {t('connect.tasks', { count: c.tasks.length })}
          </Text>
          {c.tasks.map((x) => (
            <Badge key={x.id} size="sm" variant="outline" color={STATE_COLORS[x.state] ?? 'gray'} title={x.workerId} style={{ textTransform: 'none' }}>
              {t('connect.task', { id: x.id, state: x.state })}
            </Badge>
          ))}
          {c.workerId && (
            <Text size="xs" c="dimmed" className="mono">
              <IconServer size={12} aria-hidden style={{ verticalAlign: 'middle' }} /> {c.workerId}
            </Text>
          )}
        </Group>
        {c.topics.length > 0 && (
          <Group gap={6} wrap="wrap" data-testid="connect-topics">
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
        {c.type === 'sink' && c.groupId && (
          <Text size="xs" c="dimmed">
            {t('connect.group')} <Code>{c.groupId}</Code>
          </Text>
        )}
        {c.debezium && (
          <Group gap={6} wrap="wrap" data-testid="connect-database">
            <IconDatabase size={14} aria-hidden />
            <Text size="xs">
              {t('connect.capture', { dbms: c.debezium.dbms, host: c.debezium.host, port: c.debezium.port ?? '–' })}
              {c.debezium.databases.length ? ` · ${c.debezium.databases.join(', ')}` : ''}
            </Text>
            {c.database?.platform && (
              <Anchor component={Link} to={`/platforms/${c.database.platform.id}`} size="xs">
                {c.database.platform.name}
              </Anchor>
            )}
            {c.database?.system && (
              <Anchor component={Link} to={`/systems/${c.database.system.id}`} size="xs">
                {c.database.system.name}
              </Anchor>
            )}
            {!c.database?.platform && !c.database?.system && (
              <Text size="xs" c="dimmed">
                {t('connect.noDatabase')}
              </Text>
            )}
          </Group>
        )}
        {failed.length > 0 && (
          <div>
            <Anchor
              component="button"
              type="button"
              size="xs"
              c="red.8"
              onClick={() => setTraces((x) => !x)}
              aria-expanded={traces}
              data-testid="connect-trace-toggle"
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
                      data-testid="connect-trace"
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

function ConfigModal({ platformId, name, onClose }: { platformId: string; name: string; onClose: () => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  // read when the dialog opens, never cached: the configuration is not kept anywhere
  const q = useQuery({
    queryKey: platformKeys.kafkaConnectConfig(platformId, name),
    queryFn: () =>
      get<{ name: string; config: Record<string, string> }>(`/platforms/${platformId}/kafka-connect/connectors/${encodeURIComponent(name)}/config`),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  return (
    <Modal opened onClose={onClose} title={t('connect.configTitle', { name })} size="lg">
      <Stack gap="xs" data-testid="connect-config">
        <Hint>{t('connect.configHint')}</Hint>
        <QueryState query={q} rows={4} />
        {q.data && (
          <TableScroll>
            <Table fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('connect.key')}</Table.Th>
                  <Table.Th>{t('connect.value')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {Object.entries(q.data.config).map(([k, val]) => (
                  <Table.Tr key={k}>
                    <Table.Td className="mono" style={{ overflowWrap: 'anywhere', verticalAlign: 'top' }}>
                      {k}
                    </Table.Td>
                    <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {val === '***' ? (
                        <Text span size="xs" c="dimmed" fs="italic">
                          {t('connect.removed')}
                        </Text>
                      ) : (
                        val
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TableScroll>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:close')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
