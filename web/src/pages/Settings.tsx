import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Card, Code, Group, NumberInput, Paper, SegmentedControl, SimpleGrid, Stack, Switch, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconTrashX } from '@tabler/icons-react';
import type { ApiToken, AuthStatus, MaintenanceStatus, Settings } from '@sm/shared';
import { BRAND } from '../../../shared/src/brand';
import { del, get, getOptional, notifyError, notifyOk, post, put } from '../api';
import { PageHeader } from '../components/common';
import { useMe } from '../auth';
import { fmtDate, fmtRelative } from '../format';
import { ApiTokenTable } from '../components/ApiTokenTable';
import { NotificationSettingsCard } from '../components/notifications/NotificationSettingsCard';
import { PublicApiInfo, usePublicApi } from '../components/PublicApiInfo';
import { ReportBrandingCard } from '../components/reports/ReportBrandingCard';

export function SettingsPage({ browserAvailable }: { browserAvailable: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/settings') });
  const { caps } = useMe();
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => get<AuthStatus>('/auth/status') });
  const ssoCount = auth.data?.ssoProviders?.length ?? 0;
  const readOnly = !caps.manageSettings;
  const publicApi = usePublicApi();
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data) setS(settings.data);
  }, [settings.data]);
  if (!s) return null;
  return (
    <>
      <PageHeader title="Settings" description={readOnly ? 'Only administrators can change settings.' : undefined} />
      <Stack maw={760}>
        <Card withBorder>
          <Title order={5} mb="sm">
            Sign-in
          </Title>
          <Stack gap="xs">
            <SegmentedControl
              disabled={readOnly}
              fullWidth
              value={s.passwordLogin ?? 'all'}
              onChange={(v) => setS({ ...s, passwordLogin: v as Settings['passwordLogin'] })}
              data={[
                { value: 'all', label: 'Password and SSO' },
                { value: 'adminsOnly', label: 'SSO only' },
              ]}
            />
            <Text size="xs" c="dimmed">
              {(s.passwordLogin ?? 'all') === 'adminsOnly'
                ? 'Everyone signs in with single sign-on. Local administrator accounts can still use their password – keep at least one as break-glass access in case the identity provider is unavailable.'
                : 'Users can sign in with a local password or, if configured, with single sign-on.'}
            </Text>
            {ssoCount === 0 && (s.passwordLogin ?? 'all') === 'adminsOnly' && (
              <Alert color="orange" variant="light" p="xs">
                No single sign-on provider is enabled yet – only administrators would be able to sign in. Configure one under Users &amp; teams.
              </Alert>
            )}
          </Stack>
        </Card>
        <Card withBorder>
          <Title order={5} mb="sm">
            Browser automation
          </Title>
          {!browserAvailable && (
            <Alert color="orange" mb="sm">
              Playwright is not installed. Run <Code>npm install</Code> and <Code>npx playwright install chromium</Code>, then restart.
            </Alert>
          )}
          <Stack>
            <Switch
              disabled={readOnly}
              label="Run browser headless"
              description="Turn off to watch the browser while a process runs (useful when building browser steps)."
              checked={s.browserHeadless}
              onChange={(e) => setS({ ...s, browserHeadless: e.currentTarget.checked })}
            />
            <NumberInput
              disabled={readOnly}
              label="Default timeout per action (ms)"
              min={1000}
              step={1000}
              value={s.browserTimeoutMs}
              onChange={(v) => setS({ ...s, browserTimeoutMs: Number(v) || 30000 })}
            />
            <Text size="xs" c="dimmed">
              Tip: <Code>npx playwright codegen https://your-portal</Code> records clicks and shows selectors you can paste into browser steps.
            </Text>
          </Stack>
        </Card>
        <Card withBorder>
          <Title order={5} mb="sm">
            Data retention
          </Title>
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NumberInput
                disabled={readOnly}
                label="Keep runs (days)"
                description="Includes logs and evidence files. 0 = forever."
                min={0}
                value={s.retentionRunDays ?? 0}
                onChange={(v) => setS({ ...s, retentionRunDays: typeof v === 'number' ? v : 0 })}
              />
              <NumberInput
                disabled={readOnly}
                label="Keep read notifications (days)"
                description="Unread ones are always kept."
                min={1}
                value={s.retentionNotificationDays ?? 30}
                onChange={(v) => setS({ ...s, retentionNotificationDays: typeof v === 'number' ? v : 30 })}
              />
            </SimpleGrid>
            <Text size="xs" c="dimmed">
              Older runs and read notifications are deleted automatically. The audit log is never pruned.
            </Text>
            {!readOnly && <MaintenanceStatusView />}
          </Stack>
        </Card>
        {publicApi.data && (
          <Card withBorder>
            <Title order={5} mb="sm">
              REST API
            </Title>
            <Stack gap="xs">
              <PublicApiInfo status={publicApi.data} />
              {publicApi.data.enabled && (
                <>
                  <Text size="sm" fw={500}>
                    Who can open the API documentation
                  </Text>
                  <SegmentedControl
                    disabled={readOnly || publicApi.data.docsSource === 'env'}
                    fullWidth
                    value={publicApi.data.docsSource === 'env' ? publicApi.data.docs : (s.apiDocs ?? 'authenticated')}
                    onChange={(v) => setS({ ...s, apiDocs: v as Settings['apiDocs'] })}
                    data={[
                      { value: 'off', label: 'Off' },
                      { value: 'authenticated', label: 'Signed-in users' },
                      { value: 'public', label: 'Public' },
                    ]}
                  />
                  <Text size="xs" c="dimmed">
                    {publicApi.data.docsSource === 'env' ? (
                      <>
                        Set by the environment variable <Code>SM_API_DOCS</Code> on the server.{' '}
                      </>
                    ) : null}
                    Who may open the interactive documentation (Swagger UI) and the OpenAPI document without a token. The API itself always needs an API token
                    (created on the profile page){publicApi.data.rateLimitPerMinute ? ` and allows ${publicApi.data.rateLimitPerMinute} requests per minute and token` : ''}.
                  </Text>
                </>
              )}
            </Stack>
          </Card>
        )}
        {!readOnly && (
        <Group>
          <Button
            onClick={async () => {
              try {
                await put('/settings', s);
                notifyOk('Settings saved');
                qc.invalidateQueries();
              } catch (e) {
                notifyError(e);
              }
            }}
          >
            Save
          </Button>
        </Group>
        )}
        {!readOnly && <ReportBrandingCard />}
        {!readOnly && <NotificationSettingsCard />}
        {!readOnly && <AdminTokensCard />}
        <Card withBorder>
          <Title order={5} mb="xs">
            Unattended operation
          </Title>
          <Text size="sm">
            Schedules only run while the vault is unlocked; scheduled runs use the rights of the person who owns the schedule. To start unlocked after a reboot (e.g. as a Windows service), set the environment variable{' '}
            <Code>SM_MASTER_PASSPHRASE</Code>. To let colleagues use the tool over the network, start it with <Code>SM_HOST=0.0.0.0</Code>,{' '}
            <Code>SM_ALLOWED_HOSTS=&lt;hostname&gt;</Code> and HTTPS (<Code>SM_TLS_CERT</Code>/<Code>SM_TLS_KEY</Code>). Keep the data directory (<Code>data/</Code>) backed up – it contains the database, encrypted credentials, evidence files and the
            audit log. See the <Anchor href={`${BRAND.repoUrl}#readme`} target="_blank">README</Anchor> for details.
          </Text>
        </Card>
      </Stack>
    </>
  );
}

function fmtBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Paper withBorder p="xs" title={hint}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600}>{value}</Text>
    </Paper>
  );
}

/** Storage numbers and the "Clean up now" button. Hidden while the server has no maintenance endpoint. */
function MaintenanceStatusView() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['maintenance'], queryFn: () => getOptional<MaintenanceStatus | null>('/maintenance', null) });
  const [busy, setBusy] = useState(false);
  const m = status.data;
  if (!m) return null;
  const cleanup = async () => {
    if (!confirm('Delete runs and notifications older than the saved retention periods now? This cannot be undone.')) return;
    setBusy(true);
    try {
      type Result = { runsDeleted: number; artifactsDeleted: number; notificationsDeleted: number };
      // Accepts the cleanup result or the refreshed maintenance status (which carries it as lastCleanup).
      const r = await post<Result | MaintenanceStatus>('/maintenance/cleanup');
      const c = r && 'runsDeleted' in r ? r : (r as MaintenanceStatus | null)?.lastCleanup;
      notifyOk(c ? `${c.runsDeleted} runs, ${c.artifactsDeleted} files and ${c.notificationsDeleted} notifications deleted.` : 'Done.', 'Cleanup finished');
      if (r && 'databaseBytes' in r) qc.setQueryData(['maintenance'], r);
      else qc.invalidateQueries({ queryKey: ['maintenance'] });
    } catch (e) {
      notifyError(e, 'Cleanup failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="xs">
      <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
        <Stat label="Database" value={fmtBytes(m.databaseBytes)} />
        <Stat label="Evidence files" value={fmtBytes(m.artifactBytes)} />
        <Stat label="Runs" value={m.runs.toLocaleString()} />
        <Stat label="Oldest run" value={m.oldestRun ? fmtRelative(m.oldestRun) : '–'} hint={m.oldestRun ? fmtDate(m.oldestRun) : undefined} />
        <Stat label="Audit entries" value={m.auditEntries.toLocaleString()} />
        <Stat label="Last cleanup" value={m.lastCleanup ? fmtRelative(m.lastCleanup.at) : 'never'} hint={m.lastCleanup ? fmtDate(m.lastCleanup.at) : undefined} />
      </SimpleGrid>
      {m.lastCleanup && (
        <Text size="xs" c="dimmed">
          Last cleanup removed {m.lastCleanup.runsDeleted} runs, {m.lastCleanup.artifactsDeleted} files and {m.lastCleanup.notificationsDeleted} notifications.
        </Text>
      )}
      <Group>
        <Button variant="light" color="red" leftSection={<IconTrashX size={16} />} loading={busy} onClick={cleanup}>
          Clean up now
        </Button>
        <Text size="xs" c="dimmed">
          Uses the saved retention periods. Cleanup also runs automatically.
        </Text>
      </Group>
    </Stack>
  );
}

/** Every user's API tokens (administrators). Hidden while the server has no token endpoint. */
function AdminTokensCard() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['tokens', 'all'], queryFn: () => getOptional<ApiToken[] | null>('/tokens', null) });
  if (!tokens.data) return null;
  const revoke = async (t: ApiToken) => {
    if (!confirm(`Revoke the token “${t.name}” of ${t.owner}? Scripts using it stop working immediately.`)) return;
    try {
      await del(`/tokens/${encodeURIComponent(t.id)}`);
      notifyOk('Token revoked');
      qc.invalidateQueries({ queryKey: ['tokens'] });
      qc.invalidateQueries({ queryKey: ['me', 'tokens'] });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Card withBorder>
      <Title order={5}>API tokens</Title>
      <Text size="sm" c="dimmed" mb="sm">
        Tokens of all users. Users create their own tokens on their profile page.
      </Text>
      {tokens.data.length === 0 ? (
        <Text size="sm" c="dimmed">
          No tokens yet.
        </Text>
      ) : (
        <ApiTokenTable tokens={tokens.data} showOwner onRevoke={revoke} />
      )}
    </Card>
  );
}
