import { Link } from 'react-router-dom';
import { Alert, Anchor, Badge, Box, Button, Card, Group, List, Loader, Select, SimpleGrid, Stack, Switch, Text, ThemeIcon, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconArrowsDiff,
  IconBulb,
  IconCheck,
  IconHeartRateMonitor,
  IconPackages,
  IconRobot,
  IconTemplate,
} from '@tabler/icons-react';
import { PLATFORM_HEALTH_INTERVALS, type CheckType, type Platform, type PlatformGetStarted, type PlatformHealth } from '@sm/shared';
import { get, notifyError, put } from '../../api';
import { fmtDate, fmtRelative } from '../../format';
import { checkTypeLabel } from '../monitors/status';

/** What a connection test result looks like for the hints (POST /platforms/:id/test). */
export interface TestOutcome {
  ok: boolean;
  status: number;
  message: string;
}

export type TestHintKey = 'credentials' | 'forbidden' | 'baseUrl' | 'apiUrl' | 'signIn' | 'dns' | 'reach' | 'outbound' | 'tls' | 'timeout';

/** The usual fixes for a failed connection test, from its status and the plain-language diagnosis (v0.3.1 messages). */
export function testHints(r: TestOutcome): TestHintKey[] {
  if (r.ok) return [];
  const m = r.message.toLowerCase();
  const out = new Set<TestHintKey>();
  if (r.status === 401) out.add('credentials');
  if (r.status === 403) out.add('forbidden');
  if (r.status === 404) out.add('baseUrl');
  if (m.includes('html page') || m.includes('not json')) out.add('apiUrl');
  if (m.includes('sign-in') || m.includes('login') || (r.status >= 300 && r.status < 400)) out.add('signIn');
  if (m.includes('enotfound') || m.includes('getaddrinfo') || m.includes('could not resolve')) out.add('dns');
  if (m.includes('econnrefused') || m.includes('econnreset') || m.includes('could not be reached') || m.includes('socket')) out.add('reach');
  if (m.includes('outbound policy') || m.includes('allow-list')) out.add('outbound');
  if (m.includes('certificate') || m.includes('self-signed') || m.includes('self signed') || m.includes('tls')) out.add('tls');
  if (m.includes('timeout') || m.includes('timed out') || m.includes('aborted')) out.add('timeout');
  if (!out.size && r.status === 0) out.add('reach');
  return [...out];
}

/** The fix hints of a failed test, inline. */
export function TestHints({ result }: { result: TestOutcome }) {
  const { t } = useTranslation('platforms');
  const hints = testHints(result);
  if (!hints.length) return null;
  return (
    <Stack gap={2} mt="xs" data-testid="platform-test-hints">
      <Text size="xs" fw={600}>
        {t('wizard.hints.title')}
      </Text>
      <List size="xs" spacing={2} icon={<IconBulb size={12} />}>
        {hints.map((h) => (
          <List.Item key={h}>{t(`wizard.hints.${h}`)}</List.Item>
        ))}
      </List>
    </Stack>
  );
}

/**
 * "Get started with this platform" (v0.4.0): matching templates and bundles, monitor check types and examples, access
 * checks and the MCP gateway – the setup wizard's last step and a tab of the platform page.
 */
export function GetStartedPanel({ platform, onNavigate }: { platform: Pick<Platform, 'id' | 'kind' | 'name'>; onNavigate?: () => void }) {
  const { t } = useTranslation('platforms');
  const q = useQuery({ queryKey: ['platform', platform.id, 'get-started'], queryFn: () => get<PlatformGetStarted>(`/platforms/${platform.id}/get-started`) });
  if (q.isLoading) return <Loader size="sm" />;
  const g = q.data;
  if (!g) return null;
  const nothing = !g.templates.length && !g.bundles.length && !g.monitorTypes.length && !g.accessSources.length && !g.mcp;
  const link = (to: string, label: string) => (
    <Anchor component={Link} to={to} size="sm" onClick={onNavigate}>
      {label}
    </Anchor>
  );
  return (
    <Stack gap="sm" data-testid="platform-get-started">
      <Text size="sm" c="dimmed">
        {t('start.intro', { name: platform.name })}
      </Text>
      {nothing && <Alert color="gray">{t('start.nothing')}</Alert>}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {g.bundles.length > 0 && (
          <Card withBorder padding="sm">
            <Group gap={6} mb={4}>
              <ThemeIcon size="sm" variant="light">
                <IconPackages size={14} />
              </ThemeIcon>
              <Title order={6}>{t('start.bundles')}</Title>
            </Group>
            <Text size="xs" c="dimmed" mb={4}>
              {t('start.bundlesHint')}
            </Text>
            <Stack gap={4}>
              {g.bundles.map((b) => (
                <Group key={b.id} justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm" style={{ minWidth: 0 }}>
                    {b.name}
                  </Text>
                  <Button size="compact-xs" variant="light" component={Link} to={`/processes?bundle=${encodeURIComponent(b.id)}`} onClick={onNavigate}>
                    {t('start.setUp')}
                  </Button>
                </Group>
              ))}
            </Stack>
          </Card>
        )}
        {g.templates.length > 0 && (
          <Card withBorder padding="sm">
            <Group gap={6} mb={4}>
              <ThemeIcon size="sm" variant="light">
                <IconTemplate size={14} />
              </ThemeIcon>
              <Title order={6}>{t('start.templates', { count: g.templates.length })}</Title>
            </Group>
            <List size="sm" spacing={2}>
              {g.templates.slice(0, 6).map((x) => (
                <List.Item key={x.id}>{x.name}</List.Item>
              ))}
            </List>
            {link(`/processes?templates=${encodeURIComponent(g.kind)}`, t('start.allTemplates'))}
          </Card>
        )}
        {g.monitorTypes.length > 0 && (
          <Card withBorder padding="sm">
            <Group gap={6} mb={4}>
              <ThemeIcon size="sm" variant="light">
                <IconHeartRateMonitor size={14} />
              </ThemeIcon>
              <Title order={6}>{t('start.monitors')}</Title>
            </Group>
            <Group gap={4} mb={4}>
              {g.monitorTypes.map((x) => (
                <Badge key={x} size="sm" variant="light" tt="none">
                  {checkTypeLabel(x as CheckType)}
                </Badge>
              ))}
            </Group>
            {g.monitorExamples.length > 0 && (
              <Text size="xs" c="dimmed" mb={4}>
                {t('start.monitorExamples', { names: g.monitorExamples.map((e) => e.name).join(', ') })}
              </Text>
            )}
            {link('/monitors/new', t('start.newMonitor'))}
          </Card>
        )}
        {g.accessSources.length > 0 && (
          <Card withBorder padding="sm">
            <Group gap={6} mb={4}>
              <ThemeIcon size="sm" variant="light">
                <IconArrowsDiff size={14} />
              </ThemeIcon>
              <Title order={6}>{t('start.access')}</Title>
            </Group>
            <Text size="xs" c="dimmed" mb={4}>
              {t('start.accessHint')}
            </Text>
            {link(`/compliance/reconciliation?new=1&platform=${encodeURIComponent(platform.id)}`, t('start.newAccessCheck'))}
          </Card>
        )}
        {g.mcp && (
          <Card withBorder padding="sm">
            <Group gap={6} mb={4}>
              <ThemeIcon size="sm" variant="light">
                <IconRobot size={14} />
              </ThemeIcon>
              <Title order={6}>{t('start.mcp')}</Title>
            </Group>
            <Text size="xs" c="dimmed" mb={4}>
              {t('start.mcpHint')}
            </Text>
            {link(`/platforms/${encodeURIComponent(platform.id)}?tab=mcp`, t('start.openMcp'))}
          </Card>
        )}
      </SimpleGrid>
    </Stack>
  );
}

/**
 * Platform health (v0.4.0): the last connection test, prominently, and the optional periodic test whose failures notify
 * the platform's managers.
 */
export function PlatformHealthPanel({ platform, canManage }: { platform: Pick<Platform, 'id'>; canManage: boolean }) {
  const { t } = useTranslation('platforms');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform', platform.id, 'health'], queryFn: () => get<PlatformHealth>(`/platforms/${platform.id}/health`) });
  const h = q.data;
  if (!h) return null;
  const save = async (next: { enabled: boolean; intervalMinutes: number }) => {
    try {
      qc.setQueryData(['platform', platform.id, 'health'], await put<PlatformHealth>(`/platforms/${platform.id}/health`, next));
    } catch (e) {
      notifyError(e);
    }
  };
  const last = h.lastTest;
  const color = !last ? 'gray' : last.ok ? 'green' : 'red';
  return (
    <Card withBorder padding="sm" mb="md" data-testid="platform-health">
      <Group justify="space-between" wrap="wrap" align="flex-start" gap="sm">
        {/* a basis, so the periodic test wraps below on a phone instead of squeezing the text to one letter a line */}
        <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: '1 1 240px' }}>
          <ThemeIcon color={color} variant="light" size="lg" aria-hidden>
            {last && !last.ok ? <IconAlertTriangle size={18} /> : last ? <IconCheck size={18} /> : <IconActivityHeartbeat size={18} />}
          </ThemeIcon>
          <Box style={{ minWidth: 0 }}>
            <Text fw={600} size="sm" c={last && !last.ok ? 'red' : undefined}>
              {!last ? t('health.never') : last.ok ? t('health.ok', { when: fmtRelative(last.at) }) : t('health.failed', { when: fmtRelative(last.at) })}
            </Text>
            {last && (
              <Text size="xs" c="dimmed" title={fmtDate(last.at)} style={{ overflowWrap: 'anywhere' }}>
                {last.by === 'system' ? t('health.byPeriodic') : t('health.by', { user: last.by })} · {last.message}
              </Text>
            )}
            {h.failingSince && (
              <Text size="xs" c="red" data-testid="platform-failing-since">
                {t('health.failingSince', { when: fmtRelative(h.failingSince) })}
              </Text>
            )}
          </Box>
        </Group>
        <Group gap="xs" wrap="wrap" align="flex-end">
          <Switch
            size="sm"
            label={t('health.periodic')}
            checked={h.periodic.enabled}
            disabled={!canManage}
            onChange={(e) => save({ enabled: e.currentTarget.checked, intervalMinutes: h.periodic.intervalMinutes })}
            data-testid="platform-health-periodic"
          />
          <Select
            size="xs"
            w={150}
            aria-label={t('health.interval')}
            disabled={!canManage || !h.periodic.enabled}
            allowDeselect={false}
            data={PLATFORM_HEALTH_INTERVALS.map((m) => ({
              value: String(m),
              label: t('health.every', { count: m < 60 ? m : m / 60, context: m < 60 ? 'minutes' : 'hours' }),
            }))}
            value={String(h.periodic.intervalMinutes)}
            onChange={(v) => v && save({ enabled: h.periodic.enabled, intervalMinutes: Number(v) })}
          />
        </Group>
      </Group>
      {h.periodic.enabled && (
        <Text size="xs" c="dimmed" mt={6}>
          {t('health.periodicHint')}
          {h.periodic.nextAt ? ` ${t('health.next', { when: fmtRelative(h.periodic.nextAt) })}` : ''}
        </Text>
      )}
    </Card>
  );
}
