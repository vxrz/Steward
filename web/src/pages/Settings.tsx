import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Card, Code, Group, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Switch, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconLanguage, IconTrashX } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { ApiToken, AuthStatus, MaintenanceStatus, Settings } from '@sm/shared';
import { BRAND } from '../../../shared/src/brand';
import { del, get, getOptional, notifyError, notifyOk, post, put } from '../api';
import { PageHeader } from '../components/common';
import { useMe } from '../auth';
import { fmtBytes, fmtDate, fmtNumber, fmtRelative } from '../format';
import { DEFAULT_LOCALE, LANGUAGES, isLocale } from '../i18n/languages';
import i18n from '../i18n';
import { ApiTokenTable } from '../components/ApiTokenTable';
import { NotificationSettingsCard } from '../components/notifications/NotificationSettingsCard';
import { PublicApiInfo, usePublicApi } from '../components/PublicApiInfo';
import { ReportBrandingCard } from '../components/reports/ReportBrandingCard';

export function SettingsPage({ browserAvailable }: { browserAvailable: boolean }) {
  const { t } = useTranslation(['settings', 'common']);
  const qc = useQueryClient();
  const { caps } = useMe();
  // Settings are admin-only on the server; other users just see a note.
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/settings'), enabled: caps.manageSettings });
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => get<AuthStatus>('/auth/status') });
  const ssoCount = auth.data?.ssoProviders?.length ?? 0;
  const readOnly = !caps.manageSettings;
  const publicApi = usePublicApi();
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data) setS(settings.data);
  }, [settings.data]);
  if (readOnly) return <PageHeader title={t("title")} description={t("readOnly")} />;
  if (!s) return null;
  return (
    <>
      <PageHeader title={t('title')} description={readOnly ? t('readOnly') : undefined} />
      <Stack maw={760}>
        <Card withBorder>
          <Title order={5} mb="sm">
            {t('signIn.title')}
          </Title>
          <Stack gap="xs">
            <SegmentedControl
              disabled={readOnly}
              fullWidth
              value={s.passwordLogin ?? 'all'}
              onChange={(v) => setS({ ...s, passwordLogin: v as Settings['passwordLogin'] })}
              data={[
                { value: 'all', label: t('signIn.all') },
                { value: 'adminsOnly', label: t('signIn.adminsOnly') },
              ]}
            />
            <Text size="xs" c="dimmed">
              {(s.passwordLogin ?? 'all') === 'adminsOnly' ? t('signIn.adminsOnlyHint') : t('signIn.allHint')}
            </Text>
            {ssoCount === 0 && (s.passwordLogin ?? 'all') === 'adminsOnly' && (
              <Alert color="orange" variant="light" p="xs">
                {t('signIn.noProvider')}
              </Alert>
            )}
          </Stack>
        </Card>
        <Card withBorder>
          <Group gap="xs" mb="sm" wrap="nowrap">
            <IconLanguage size={18} />
            <Title order={5}>{t('language.title')}</Title>
          </Group>
          <Select
            disabled={readOnly}
            label={t('language.default')}
            description={t('language.defaultHint')}
            data={LANGUAGES.map((l) => ({ value: l.code, label: l.nativeName }))}
            value={s.defaultLocale ?? DEFAULT_LOCALE}
            allowDeselect={false}
            onChange={(v) => isLocale(v) && setS({ ...s, defaultLocale: v })}
            maw={320}
          />
          <Text size="xs" c="dimmed" mt="xs">
            {t('language.hint')}
          </Text>
        </Card>
        <Card withBorder>
          <Title order={5} mb="sm">
            {t('browser.title')}
          </Title>
          {!browserAvailable && (
            <Alert color="orange" mb="sm">
              <Trans t={t} i18nKey="browser.missing" components={{ c: <Code /> }} />
            </Alert>
          )}
          <Stack>
            <Switch
              disabled={readOnly}
              label={t('browser.headless')}
              description={t('browser.headlessHint')}
              checked={s.browserHeadless}
              onChange={(e) => setS({ ...s, browserHeadless: e.currentTarget.checked })}
            />
            <NumberInput
              disabled={readOnly}
              label={t('browser.timeout')}
              min={1000}
              step={1000}
              value={s.browserTimeoutMs}
              onChange={(v) => setS({ ...s, browserTimeoutMs: Number(v) || 30000 })}
            />
            <Text size="xs" c="dimmed">
              <Trans t={t} i18nKey="browser.tip" components={{ c: <Code /> }} />
            </Text>
          </Stack>
        </Card>
        <Card withBorder>
          <Title order={5} mb="sm">
            {t('retention.title')}
          </Title>
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NumberInput
                disabled={readOnly}
                label={t('retention.runs')}
                description={t('retention.runsHint')}
                min={0}
                value={s.retentionRunDays ?? 0}
                onChange={(v) => setS({ ...s, retentionRunDays: typeof v === 'number' ? v : 0 })}
              />
              <NumberInput
                disabled={readOnly}
                label={t('retention.notifications')}
                description={t('retention.notificationsHint')}
                min={1}
                value={s.retentionNotificationDays ?? 30}
                onChange={(v) => setS({ ...s, retentionNotificationDays: typeof v === 'number' ? v : 30 })}
              />
            </SimpleGrid>
            <Text size="xs" c="dimmed">
              {t('retention.hint')}
            </Text>
            {!readOnly && <MaintenanceStatusView />}
          </Stack>
        </Card>
        {publicApi.data && (
          <Card withBorder>
            <Title order={5} mb="sm">
              {t('publicApi.title')}
            </Title>
            <Stack gap="xs">
              <PublicApiInfo status={publicApi.data} />
              {publicApi.data.enabled && (
                <>
                  <Text size="sm" fw={500}>
                    {t('publicApi.docsAccess')}
                  </Text>
                  <SegmentedControl
                    disabled={readOnly || publicApi.data.docsSource === 'env'}
                    fullWidth
                    value={publicApi.data.docsSource === 'env' ? publicApi.data.docs : (s.apiDocs ?? 'authenticated')}
                    onChange={(v) => setS({ ...s, apiDocs: v as Settings['apiDocs'] })}
                    data={[
                      { value: 'off', label: t('publicApi.docsModes.off') },
                      { value: 'authenticated', label: t('publicApi.docsModes.authenticated') },
                      { value: 'public', label: t('publicApi.docsModes.public') },
                    ]}
                  />
                  <Text size="xs" c="dimmed">
                    {publicApi.data.docsSource === 'env' ? (
                      <>
                        <Trans t={t} i18nKey="publicApi.docsFromEnv" values={{ name: 'SM_API_DOCS' }} components={{ c: <Code /> }} />{' '}
                      </>
                    ) : null}
                    {publicApi.data.rateLimitPerMinute
                      ? t('publicApi.docsHintRateLimit', { count: publicApi.data.rateLimitPerMinute })
                      : t('publicApi.docsHint')}
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
                notifyOk(t('saved'));
                qc.invalidateQueries();
              } catch (e) {
                notifyError(e);
              }
            }}
          >
            {t('common:save')}
          </Button>
        </Group>
        )}
        {!readOnly && <ReportBrandingCard />}
        {!readOnly && <NotificationSettingsCard />}
        {!readOnly && <AdminTokensCard />}
        <Card withBorder>
          <Title order={5} mb="xs">
            {t('unattended.title')}
          </Title>
          <Text size="sm">
            <Trans
              t={t}
              i18nKey="unattended.text"
              components={{
                c: <Code />,
                hosts: <Code>{'SM_ALLOWED_HOSTS=<hostname>'}</Code>,
                readme: <Anchor href={`${BRAND.repoUrl}#readme`} target="_blank" />,
              }}
            />
          </Text>
        </Card>
      </Stack>
    </>
  );
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
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['maintenance'], queryFn: () => getOptional<MaintenanceStatus | null>('/maintenance', null) });
  const [busy, setBusy] = useState(false);
  const m = status.data;
  if (!m) return null;
  const cleanup = async () => {
    if (!confirm(t('maintenance.confirm'))) return;
    setBusy(true);
    try {
      type Result = { runsDeleted: number; artifactsDeleted: number; notificationsDeleted: number };
      // Accepts the cleanup result or the refreshed maintenance status (which carries it as lastCleanup).
      const r = await post<Result | MaintenanceStatus>('/maintenance/cleanup');
      const c = r && 'runsDeleted' in r ? r : (r as MaintenanceStatus | null)?.lastCleanup;
      notifyOk(c ? t('maintenance.result', cleanupCounts(c)) : t('maintenance.done'), t('maintenance.finished'));
      if (r && 'databaseBytes' in r) qc.setQueryData(['maintenance'], r);
      else qc.invalidateQueries({ queryKey: ['maintenance'] });
    } catch (e) {
      notifyError(e, t('maintenance.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="xs">
      <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
        <Stat label={t('maintenance.database')} value={fmtBytes(m.databaseBytes)} />
        <Stat label={t('maintenance.evidence')} value={fmtBytes(m.artifactBytes)} />
        <Stat label={t('maintenance.runs')} value={fmtNumber(m.runs)} />
        <Stat label={t('maintenance.oldest')} value={m.oldestRun ? fmtRelative(m.oldestRun) : '–'} hint={m.oldestRun ? fmtDate(m.oldestRun) : undefined} />
        <Stat label={t('maintenance.auditEntries')} value={fmtNumber(m.auditEntries)} />
        <Stat
          label={t('maintenance.lastCleanup')}
          value={m.lastCleanup ? fmtRelative(m.lastCleanup.at) : t('maintenance.never')}
          hint={m.lastCleanup ? fmtDate(m.lastCleanup.at) : undefined}
        />
      </SimpleGrid>
      {m.lastCleanup && (
        <Text size="xs" c="dimmed">
          {t('maintenance.lastResult', cleanupCounts(m.lastCleanup))}
        </Text>
      )}
      <Group>
        <Button variant="light" color="red" leftSection={<IconTrashX size={16} />} loading={busy} onClick={cleanup}>
          {t('maintenance.cleanup')}
        </Button>
        <Text size="xs" c="dimmed">
          {t('maintenance.cleanupHint')}
        </Text>
      </Group>
    </Stack>
  );
}

/** "3 runs", "1 file", … as values for the cleanup messages. */
function cleanupCounts(c: { runsDeleted: number; artifactsDeleted: number; notificationsDeleted: number }) {
  return {
    runs: i18n.t('settings:maintenance.nRuns', { count: c.runsDeleted }),
    files: i18n.t('settings:maintenance.nFiles', { count: c.artifactsDeleted }),
    notifications: i18n.t('settings:maintenance.nNotifications', { count: c.notificationsDeleted }),
  };
}

/** Every user's API tokens (administrators). Hidden while the server has no token endpoint. */
function AdminTokensCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['tokens', 'all'], queryFn: () => getOptional<ApiToken[] | null>('/tokens', null) });
  if (!tokens.data) return null;
  const revoke = async (token: ApiToken) => {
    if (!confirm(t('tokens.revokeConfirm', { name: token.name, owner: token.owner }))) return;
    try {
      await del(`/tokens/${encodeURIComponent(token.id)}`);
      notifyOk(t('tokens.revoked'));
      qc.invalidateQueries({ queryKey: ['tokens'] });
      qc.invalidateQueries({ queryKey: ['me', 'tokens'] });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Card withBorder>
      <Title order={5}>{t('tokens.title')}</Title>
      <Text size="sm" c="dimmed" mb="sm">
        {t('tokens.hint')}
      </Text>
      {tokens.data.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('tokens.none')}
        </Text>
      ) : (
        <ApiTokenTable tokens={tokens.data} showOwner onRevoke={revoke} />
      )}
    </Card>
  );
}
