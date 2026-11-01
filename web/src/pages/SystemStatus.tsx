import type { ReactNode } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Button, Card, Code, CopyButton, Group, List, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconCopy, IconExternalLink, IconRefresh } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { BRAND } from '../../../shared/src/brand';
import type { SystemStatus } from '../../../shared/src/system';
import { get } from '../api';
import { PageHeader } from '../components/common';
import { shortCommit } from '../buildInfo';
import { fmtBytes, fmtDate, fmtNumber, fmtRelative } from '../format';
import { errorText } from '../i18n/errors';
import { appUrl } from '../basePath';

const doc = (p: string) => `${BRAND.repoUrl}/blob/HEAD/docs/${p}`;

/** 3 d 4 h · 5 h 2 min · 4 min (unit symbols are the same in all supported languages) */
function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${fmtNumber(d)} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

function State({ ok, on, off }: { ok: boolean | null; on: string; off: string }) {
  return (
    <Badge variant="light" color={ok === null ? 'gray' : ok ? 'green' : 'red'} size="sm">
      {ok ? on : off}
    </Badge>
  );
}

function Toggle({ on }: { on: boolean }) {
  const { t } = useTranslation('system');
  return (
    <Badge variant="light" color={on ? 'green' : 'gray'} size="sm">
      {on ? t('status.on') : t('status.off')}
    </Badge>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card withBorder>
      <Title order={5} mb="xs">
        {title}
      </Title>
      <Table verticalSpacing={4} fz="sm">
        <Table.Tbody>{children}</Table.Tbody>
      </Table>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Table.Tr>
      <Table.Th scope="row" fw={500} w="45%" style={{ verticalAlign: 'top' }}>
        {label}
      </Table.Th>
      <Table.Td style={{ wordBreak: 'break-word' }}>{children}</Table.Td>
    </Table.Tr>
  );
}

function Endpoint({ path, label }: { path: string; label: string }) {
  const { t } = useTranslation('system');
  const url = appUrl(path);
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <Text size="sm" fw={500} w={64} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Code style={{ overflowWrap: 'anywhere' }}>{url}</Code>
      <CopyButton value={url}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? t('status.copied') : t('status.copy')}>
            <ActionIcon variant="subtle" color={copied ? 'green' : 'gray'} onClick={copy} aria-label={t('status.copyUrl', { url })}>
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

/** Settings → System status (administrators; auditors see a limited view without paths and host names). */
export function SystemStatusPage() {
  const { t } = useTranslation('system');
  const q = useQuery({ queryKey: ['system-status'], queryFn: () => get<SystemStatus>('/system/status'), refetchInterval: 30000 });
  const s = q.data;
  const check = (k: keyof SystemStatus['checks']) => s?.checks[k];
  const deployment = s ? t(`status.deployments.${s.deployment}`) : '';
  return (
    <>
      <PageHeader
        back="settings"
        title={t('status.title')}
        description={t('status.intro', { brand: BRAND.name })}
        actions={
          <Button variant="default" leftSection={<IconRefresh size={16} />} loading={q.isFetching} onClick={() => void q.refetch()}>
            {t('status.refresh')}
          </Button>
        }
      />
      {q.isError && (
        <Alert color="red" mb="md">
          {errorText(q.error)}
        </Alert>
      )}
      {s && (
        <Stack>
          <Card withBorder>
            <Group justify="space-between" wrap="wrap" gap="xs">
              <Group gap="xs">
                <Title order={4}>{s.ready ? t('status.ready') : t('status.notReady')}</Title>
                <Badge color={s.ready ? 'green' : 'red'} variant="light" size="lg" data-testid="readiness">
                  {s.ready ? t('status.readyBadge') : t('status.notReadyBadge')}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed">
                {t('status.generated', { when: fmtDate(s.generatedAt) })}
              </Text>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 3 }} mt="sm" spacing="xs">
              {(['vault', 'database', 'scheduler'] as const).map((k) => (
                <Group key={k} gap={6} wrap="nowrap" align="flex-start">
                  <State ok={check(k)!.ok} on={t('status.ok')} off={t('status.problem')} />
                  <Stack gap={0} style={{ minWidth: 0 }}>
                    <Text size="sm" fw={500}>
                      {t(`status.checks.${k}`)}
                    </Text>
                    {check(k)!.message && (
                      <Text size="xs" c="dimmed">
                        {check(k)!.message}
                      </Text>
                    )}
                  </Stack>
                </Group>
              ))}
            </SimpleGrid>
            {s.view === 'limited' && (
              <Text size="xs" c="dimmed" mt="sm">
                {t('status.limited')}
              </Text>
            )}
          </Card>

          <Card withBorder>
            <Title order={5} mb={4}>
              {t('status.monitoring.title')}
            </Title>
            <Text size="sm" c="dimmed" mb="xs">
              {t('status.monitoring.intro', { brand: BRAND.name })}
            </Text>
            <Stack gap={4} mb="xs">
              <Endpoint path="/api/health" label={t('status.monitoring.health')} />
              <Endpoint path="/api/ready" label={t('status.monitoring.ready')} />
              <Endpoint path="/api/metrics" label={t('status.monitoring.metrics')} />
            </Stack>
            <List size="sm" spacing={2}>
              <List.Item>{t('status.monitoring.healthHint')}</List.Item>
              <List.Item>{t('status.monitoring.readyHint')}</List.Item>
              <List.Item>{s.metrics.access === 'public' ? t('status.monitoring.metricsPublic') : t('status.monitoring.metricsAuth')}</List.Item>
              <List.Item>{t('status.monitoring.kubernetes')}</List.Item>
            </List>
            <Group gap="md" mt="xs">
              {[
                ['INSTALL.md#health-and-readiness', t('status.monitoring.docsInstall')],
                ['MONITORS.md', t('status.monitoring.docsMonitors')],
                ['GATUS.md', t('status.monitoring.docsGatus')],
              ].map(([p, label]) => (
                <Anchor key={p} href={doc(p!)} target="_blank" rel="noopener" size="sm">
                  <Group gap={4} wrap="nowrap" component="span">
                    {label}
                    <IconExternalLink size={12} aria-hidden />
                  </Group>
                </Anchor>
              ))}
            </Group>
          </Card>

          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Section title={t('status.sections.runtime')}>
              <Row label={t('status.runtime.version')}>
                {s.build.version}
                {s.build.commit ? ` · ${shortCommit(s.build.commit)}` : ` · ${t('status.development')}`}
                {s.build.date ? ` · ${fmtDate(s.build.date)}` : ''}
              </Row>
              <Row label={t('status.runtime.deployment')}>{deployment}</Row>
              <Row label={t('status.runtime.node')}>{s.runtime.node}</Row>
              <Row label={t('status.runtime.platform')}>
                {s.runtime.platform} / {s.runtime.arch} · {t('status.runtime.cpus', { count: s.runtime.cpus })}
              </Row>
              <Row label={t('status.runtime.uptime')}>
                {fmtUptime(s.runtime.uptimeSeconds)} · {t('status.runtime.since', { when: fmtDate(s.runtime.startedAt) })}
              </Row>
              <Row label={t('status.runtime.memory')}>
                {t('status.runtime.memoryValue', {
                  rss: fmtBytes(s.runtime.memory.rss),
                  heap: fmtBytes(s.runtime.memory.heapUsed),
                  heapTotal: fmtBytes(s.runtime.memory.heapTotal),
                })}
              </Row>
              <Row label={t('status.runtime.pdf')}>
                {s.pdf.worker === 'off'
                  ? t('status.runtime.pdfOff')
                  : s.pdf.worker === 'unavailable'
                    ? t('status.runtime.pdfUnavailable')
                    : t('status.runtime.pdfWorker')}
                {s.pdf.reason ? (
                  <>
                    {' '}
                    <Code style={{ overflowWrap: 'anywhere' }}>{s.pdf.reason}</Code>
                  </>
                ) : null}
                {s.pdf.waiting > 0 ? ` · ${t('status.runtime.pdfWaiting', { count: s.pdf.waiting })}` : ''}
              </Row>
              <Row label={t('status.runtime.timeZone')}>{s.runtime.timeZone}</Row>
              {s.runtime.hostname && <Row label={t('status.runtime.hostname')}>{s.runtime.hostname}</Row>}
              {s.runtime.pid !== undefined && <Row label={t('status.runtime.pid')}>{s.runtime.pid}</Row>}
              {s.runtime.dataDir && (
                <Row label={t('status.runtime.dataDir')}>
                  <Code style={{ overflowWrap: 'anywhere' }}>{s.runtime.dataDir}</Code>
                </Row>
              )}
            </Section>

            <Section title={t('status.sections.storage')}>
              <Row label={t('status.database.type')}>{s.database.kind === 'sqlite' ? 'SQLite' : 'PostgreSQL'}</Row>
              <Row label={t('status.database.size')}>{fmtBytes(s.database.sizeBytes)}</Row>
              {s.database.location && (
                <Row label={t('status.database.location')}>
                  <Code style={{ overflowWrap: 'anywhere' }}>{s.database.location}</Code>
                </Row>
              )}
              <Row label={t('status.vault.title')}>
                <State
                  ok={s.vault.unlocked}
                  on={t('status.vault.unlocked')}
                  off={s.vault.initialized ? t('status.vault.locked') : t('status.vault.notSetUp')}
                />
              </Row>
              <Row label={t('status.vault.unattended')}>
                <Toggle on={s.vault.unattendedUnlock} />
              </Row>
              <Row label={t('status.retention.runs')}>
                {s.retention.runDays ? t('status.retention.days', { count: s.retention.runDays }) : t('status.retention.forever')}
                {!s.retention.runDays && (s.database.sizeBytes ?? 0) > 1024 ** 3 && (
                  <Text size="xs" c="orange" mt={2}>
                    {t('status.retention.foreverHint', { size: fmtBytes(s.database.sizeBytes) })}
                  </Text>
                )}
              </Row>
              <Row label={t('status.retention.notifications')}>{t('status.retention.days', { count: s.retention.notificationDays })}</Row>
              <Row label={t('status.retention.monitors')}>{t('status.retention.days', { count: s.retention.monitorDays })}</Row>
              <Row label={t('status.retention.lastCleanup')}>
                {s.retention.lastCleanup ? (
                  <span title={fmtDate(s.retention.lastCleanup.at)}>
                    {fmtRelative(s.retention.lastCleanup.at)} ·{' '}
                    {t('status.retention.removed', { runs: s.retention.lastCleanup.runsDeleted, notifications: s.retention.lastCleanup.notificationsDeleted })}
                  </span>
                ) : (
                  t('status.never')
                )}
              </Row>
            </Section>

            <Section title={t('status.sections.engines')}>
              <Row label={t('status.scheduler.schedules')}>
                {t('status.scheduler.counts', { enabled: s.scheduler.enabled, total: s.scheduler.total, armed: s.scheduler.armed })}
              </Row>
              <Row label={t('status.scheduler.next')}>
                {s.scheduler.next.length ? (
                  <Stack gap={0}>
                    {s.scheduler.next.map((n) => (
                      <Text size="sm" key={n.id}>
                        <span title={fmtDate(n.nextRunAt)}>{fmtRelative(n.nextRunAt)}</span> – {n.name}
                      </Text>
                    ))}
                  </Stack>
                ) : (
                  t('status.scheduler.none')
                )}
              </Row>
              <Row label={t('status.monitors.engine')}>
                <State ok={s.monitors.engineRunning} on={t('status.monitors.running')} off={t('status.monitors.stopped')} />
              </Row>
              <Row label={t('status.monitors.monitors')}>
                {t('status.monitors.counts', { enabled: s.monitors.enabled, total: s.monitors.total, checks: s.monitors.checks })}
              </Row>
              <Row label={t('status.monitors.down')}>{fmtNumber(s.monitors.down)}</Row>
              <Row label={t('status.monitors.lastCheck')}>
                {s.monitors.lastCheckAt ? <span title={fmtDate(s.monitors.lastCheckAt)}>{fmtRelative(s.monitors.lastCheckAt)}</span> : t('status.never')}
              </Row>
            </Section>

            <Section title={t('status.sections.integrations')}>
              <Row label={t('status.notifications.email')}>
                <Toggle on={s.notifications.email} />
              </Row>
              <Row label={t('status.notifications.teams')}>
                <Toggle on={s.notifications.teams} />
              </Row>
              <Row label={t('status.notifications.webhook')}>
                <Toggle on={s.notifications.webhook} />
              </Row>
              <Row label={t('status.observability.errorServer')}>
                <Toggle on={s.errorReporting.server} />
                {s.errorReporting.environment && s.errorReporting.server ? ` ${s.errorReporting.environment}` : ''}
              </Row>
              <Row label={t('status.observability.errorBrowser')}>
                <Toggle on={s.errorReporting.browser} />
              </Row>
              <Row label={t('status.observability.tracing')}>
                <Toggle on={s.tracing.enabled} />
              </Row>
              <Row label={t('status.observability.metrics')}>
                {s.metrics.access === 'public' ? t('status.observability.metricsPublic') : t('status.observability.metricsAuth')}
              </Row>
              <Row label={t('status.api.title')}>
                {s.publicApi.enabled ? (
                  <>
                    <Toggle on /> <Code>{s.publicApi.basePath}</Code> v{s.publicApi.apiVersion}
                  </>
                ) : (
                  <Toggle on={false} />
                )}
              </Row>
              <Row label={t('status.api.docs')}>{t(`status.api.docsModes.${s.publicApi.docs}`)}</Row>
              <Row label={t('status.api.rateLimit')}>
                {s.publicApi.rateLimitPerMinute ? t('status.api.perMinute', { count: s.publicApi.rateLimitPerMinute }) : t('status.api.unlimited')}
              </Row>
              <Row label={t('status.security.tls')}>
                <Toggle on={s.security.tls} />
              </Row>
              {s.security.passwordLogin && (
                <Row label={t('status.security.passwordLogin')}>
                  <span data-testid="status-password-login">
                    {t(`status.security.passwordLoginModes.${s.security.passwordLogin}`)}
                    {s.security.passwordLoginFromEnv
                      ? ` (${t(s.security.passwordLoginPending ? 'status.security.pendingNone' : 'status.security.fromEnv', { name: 'SM_PASSWORD_LOGIN' })})`
                      : ''}
                  </span>
                </Row>
              )}
              {s.security.emergencyWindowsOpen !== undefined && (
                <Row label={t('status.security.emergencyWindows')}>{fmtNumber(s.security.emergencyWindowsOpen)}</Row>
              )}
              {s.security.allowedHosts && (
                <Row label={t('status.security.allowedHosts')}>
                  {s.security.allowedHosts.length ? s.security.allowedHosts.join(', ') : t('status.security.localOnly')}
                </Row>
              )}
              {s.security.proxyFromEnvironment !== undefined && (
                <Row label={t('status.security.proxy')}>
                  <Toggle on={s.security.proxyFromEnvironment} />
                </Row>
              )}
            </Section>
          </SimpleGrid>
        </Stack>
      )}
    </>
  );
}
