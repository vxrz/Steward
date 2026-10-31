import { useEffect, useState, type ReactNode } from 'react';
import {
  Alert,
  Anchor,
  Button,
  Card,
  Code,
  Grid,
  Group,
  NavLink,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconBell,
  IconBuildingFactory2,
  IconLanguage,
  IconMapPinOff,
  IconPalette,
  IconPlugConnected,
  IconScale,
  IconSettings,
  IconShieldLock,
  IconTool,
  IconTrashX,
  IconWorld,
  type Icon,
} from '@tabler/icons-react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { allowListEntryProblem, allowListLines, type ApiToken, type AuthStatus, type MaintenanceStatus, type Settings } from '@sm/shared';
import { BRAND } from '../../../shared/src/brand';
import { del, get, getOptional, notifyError, notifyOk, post, put } from '../api';
import { EmptyState, PageHeader } from '../components/common';
import { useMe } from '../auth';
import { fmtBytes, fmtDate, fmtNumber, fmtRelative } from '../format';
import { DEFAULT_LOCALE, LANGUAGES, isLocale } from '../i18n/languages';
import i18n from '../i18n';
import { ApiTokenTable } from '../components/ApiTokenTable';
import { NotificationLookCard } from '../components/notifications/NotificationLookCard';
import { NotificationSettingsCard } from '../components/notifications/NotificationSettingsCard';
import { PublicApiInfo, usePublicApi } from '../components/PublicApiInfo';
import { ReportBrandingCard } from '../components/reports/ReportBrandingCard';
import { CredentialReminderSettingsCard } from '../components/credentials/CredentialReminderSettingsCard';
import { DailySummaryAdminCard } from '../components/notifications/DailySummaryAdminCard';
import { TicketSettingsCard } from '../components/tickets/TicketSettingsCard';
import { VaultPassphraseCard } from '../components/security/VaultPassphraseCard';
import { ThemeSettingsCard } from '../components/theme/ThemeSettingsCard';
import { SystemStatusLink } from '../components/theme/SystemStatusLink';
import { McpServerCard } from '../components/mcp/McpServerCard';
import { GitSyncSettingsCard } from '../components/gitsync/GitSyncSettingsCard';
import { MigrationSettingsCard } from '../components/migration/MigrationSettingsCard';
import { BackupSettingsCard } from '../components/backup/BackupSettingsCard';
import { confirmDanger, confirmDialog } from '../components/confirm';
import { EnvironmentsCard } from '../components/catalogue/environments';
import { EndOfLifeButton } from '../components/catalogue/lifecycle';
import { SignInPolicyCard } from '../components/security/SignInPolicyCard';
import { CiaScalePage } from './CiaScale';
import { RulesPanel } from './Scorecard';

/**
 * Settings by area (#136). Each area has a stable URL (/settings/<area>); everything here is an instance setting that
 * administrators change. Personal settings are on the profile, team settings on the team.
 */
export const SETTINGS_AREAS = ['general', 'security', 'integrations', 'notifications', 'appearance', 'catalogue', 'maintenance'] as const;
export type SettingsArea = (typeof SETTINGS_AREAS)[number];
const AREA_ICONS: Record<SettingsArea, Icon> = {
  general: IconSettings,
  security: IconShieldLock,
  integrations: IconPlugConnected,
  notifications: IconBell,
  appearance: IconPalette,
  catalogue: IconScale,
  maintenance: IconTool,
};
const isArea = (x: string | undefined): x is SettingsArea => !!x && (SETTINGS_AREAS as readonly string[]).includes(x);

/** /settings and the old anchors (/settings#notifications in messages) lead to an area. */
export function SettingsIndex() {
  const { hash } = useLocation();
  // anchors of the single page before the areas (links in messages, bookmarks)
  const OLD_ANCHORS: Record<string, SettingsArea> = { '#notifications': 'notifications', '#environments': 'catalogue' };
  const area = OLD_ANCHORS[hash] ?? 'general';
  return <Navigate to={`/settings/${area}`} replace />;
}

/** The instance settings document (PUT /settings): one draft per area page, saved whole. */
function useInstanceSettings(enabled: boolean) {
  const { t } = useTranslation(['settings', 'common']);
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/settings/instance'), enabled });
  const [s, setS] = useState<Settings | null>(null);
  // the allow-list is edited as text: parsed into entries for saving, but the text (with new, empty lines) stays as typed
  const [allowText, setAllowText] = useState('');
  useEffect(() => {
    if (settings.data) {
      setS(settings.data);
      setAllowText((settings.data.outboundAllowList ?? []).join('\n'));
    }
  }, [settings.data]);
  const allowProblems = allowListLines(allowText)
    .map((line) => ({ line, problem: allowListEntryProblem(line) }))
    .filter((x) => x.problem);
  const save = async () => {
    if (!s) return;
    const mode = s.passwordLogin;
    const turningOff = mode !== 'all' && mode !== settings.data?.passwordLogin && !s.passwordLoginFromEnv;
    if (turningOff && !(await confirmDialog({ action: 'confirm', message: t(`signIn.confirm.${mode}`) }))) return;
    try {
      await put('/settings/instance', s);
      notifyOk(t('saved'));
      qc.invalidateQueries();
    } catch (e) {
      notifyError(e);
    }
  };
  const dirty = !!s && !!settings.data && JSON.stringify(s) !== JSON.stringify(settings.data);
  return { saved: settings.data, s, setS, allowText, setAllowText, allowProblems, save, dirty };
}
type Draft = ReturnType<typeof useInstanceSettings> & { s: Settings };

function SaveBar({ d }: { d: Draft }) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <Group>
      <Button disabled={d.allowProblems.length > 0 || !d.dirty} onClick={d.save}>
        {t('common:save')}
      </Button>
    </Group>
  );
}

/** Where a setting applies and who changes it. */
export function ScopeNote({ children }: { children?: ReactNode }) {
  const { t } = useTranslation('settings');
  return (
    <Alert variant="light" color="gray" icon={<IconWorld size={18} />} p="xs" data-testid="settings-scope">
      <Text size="sm">
        <Trans t={t} i18nKey="scope.instance" components={{ b: <b /> }} />{' '}
        <Trans t={t} i18nKey="scope.personal" components={{ a: <Anchor component={Link} to="/profile" inherit /> }} />
      </Text>
      {children}
    </Alert>
  );
}

export function SettingsPage({ browserAvailable }: { browserAvailable: boolean }) {
  const { t } = useTranslation(['settings', 'common', 'nav']);
  const { area } = useParams();
  const { caps } = useMe();
  // settings are the administrators' (the server checks it); others see where their own settings are
  const readOnly = !caps.manageSettings;
  const d = useInstanceSettings(!readOnly);
  if (!isArea(area))
    return (
      <EmptyState
        icon={IconMapPinOff}
        title={t('nav:pageNotFound')}
        action={
          <Button component={Link} to="/">
            {t('nav:backToDashboard')}
          </Button>
        }
      />
    );
  const nav = (
    <Stack gap={2} component="nav" aria-label={t('areas.label')}>
      {SETTINGS_AREAS.map((a) => {
        const I = AREA_ICONS[a];
        return (
          <NavLink
            key={a}
            component={Link}
            to={`/settings/${a}`}
            label={t(`areas.${a}.title`)}
            leftSection={<I size={16} />}
            active={a === area}
            aria-current={a === area ? 'page' : undefined}
          />
        );
      })}
    </Stack>
  );
  return (
    <>
      <PageHeader title={t('title')} description={t(`areas.${area}.description`)} actions={caps.viewAudit || !readOnly ? <SystemStatusLink /> : undefined} />
      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 3 }}>{nav}</Grid.Col>
        <Grid.Col span={{ base: 12, md: 9 }}>
          <Stack maw={760}>
            <ScopeNote>
              {readOnly && (
                <Text size="sm" mt={4}>
                  {t('readOnly')}
                </Text>
              )}
            </ScopeNote>
            {!readOnly && d.s && <Area area={area} d={d as Draft} browserAvailable={browserAvailable} />}
          </Stack>
        </Grid.Col>
      </Grid>
    </>
  );
}

function Area({ area, d, browserAvailable }: { area: SettingsArea; d: Draft; browserAvailable: boolean }) {
  switch (area) {
    case 'general':
      return (
        <>
          <LanguageCard d={d} />
          <BrowserCard d={d} browserAvailable={browserAvailable} />
          <SaveBar d={d} />
          <UnattendedCard />
        </>
      );
    case 'security':
      return (
        <>
          <SignInCard d={d} />
          <OutboundCard d={d} />
          <PublicApiCard d={d} />
          <SaveBar d={d} />
          <McpServerCard />
          <VaultPassphraseCard />
          <AdminTokensCard />
        </>
      );
    case 'integrations':
      return (
        <>
          <TicketSettingsCard />
          <GitSyncSettingsCard />
          <MigrationSettingsCard />
          <EndOfLifeCard />
        </>
      );
    case 'notifications':
      return (
        <>
          <NotificationSettingsCard />
          <NotificationLookCard />
          <DailySummaryAdminCard />
          <CredentialReminderSettingsCard />
        </>
      );
    case 'appearance':
      return (
        <>
          <ThemeSettingsCard />
          <ReportBrandingCard />
        </>
      );
    case 'catalogue':
      return (
        <>
          <ComplianceCard d={d} />
          <SaveBar d={d} />
          <Card withBorder id="cia-scale">
            <CiaScalePage embedded />
          </Card>
          <Card withBorder id="scorecard-rules">
            <RulesPanel />
          </Card>
          <EnvironmentsCard />
        </>
      );
    case 'maintenance':
      return (
        <>
          <RetentionCard d={d} />
          <SaveBar d={d} />
          <BackupSettingsCard />
        </>
      );
  }
}

function SignInCard({ d }: { d: Draft }) {
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => get<AuthStatus>('/auth/status') });
  return (
    <SignInPolicyCard settings={d.s} saved={d.saved?.passwordLogin} auth={auth.data} readOnly={false} onChange={(v) => d.setS({ ...d.s, passwordLogin: v })} />
  );
}

function LanguageCard({ d }: { d: Draft }) {
  const { t } = useTranslation(['settings', 'common']);
  const { s, setS } = d;
  return (
    <Card withBorder>
      <Group gap="xs" mb="sm" wrap="nowrap">
        <IconLanguage size={18} />
        <Title order={5}>{t('language.title')}</Title>
      </Group>
      <Select
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
  );
}

function BrowserCard({ d, browserAvailable }: { d: Draft; browserAvailable: boolean }) {
  const { t } = useTranslation(['settings', 'common']);
  const { s, setS } = d;
  return (
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
          label={t('browser.headless')}
          description={t('browser.headlessHint')}
          checked={s.browserHeadless}
          onChange={(e) => setS({ ...s, browserHeadless: e.currentTarget.checked })}
        />
        <NumberInput
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
  );
}

function OutboundCard({ d }: { d: Draft }) {
  const { t } = useTranslation(['settings', 'common']);
  const { s, setS, allowText, setAllowText, allowProblems } = d;
  const policy = s.outboundPolicy ?? 'platforms';
  return (
    <Card withBorder>
      <Title order={5} mb="sm">
        {t('outbound.title')}
      </Title>
      <Stack gap="xs">
        <SegmentedControl
          fullWidth
          value={policy}
          onChange={(v) => setS({ ...s, outboundPolicy: v as Settings['outboundPolicy'] })}
          data={[
            { value: 'platforms', label: t('outbound.platforms') },
            { value: 'allowList', label: t('outbound.allowList') },
            { value: 'open', label: t('outbound.open') },
          ]}
        />
        <Text size="xs" c="dimmed">
          {policy === 'open' ? t('outbound.openWarning') : policy === 'allowList' ? t('outbound.allowListHint') : t('outbound.platformsHint')}
        </Text>
        {policy === 'open' && (
          <Alert color="orange" variant="light" p="xs">
            {t('outbound.openWarning')}
          </Alert>
        )}
        <Textarea
          label={t('outbound.listLabel')}
          placeholder={t('outbound.listPlaceholder')}
          autosize
          minRows={2}
          maxRows={8}
          value={allowText}
          onChange={(e) => {
            const text = e.currentTarget.value;
            setAllowText(text);
            setS({ ...s, outboundAllowList: allowListLines(text) });
          }}
          error={
            allowProblems.length
              ? allowProblems.map((x) => t('outbound.invalidEntry', { entry: x.line, problem: t(`outbound.problems.${x.problem!}`) })).join(' · ')
              : undefined
          }
          classNames={{ input: 'mono' }}
        />
        <Text size="xs" c="dimmed">
          {t('outbound.listHint')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('outbound.note')}
        </Text>
      </Stack>
    </Card>
  );
}

function ComplianceCard({ d }: { d: Draft }) {
  const { t } = useTranslation(['settings', 'common']);
  const { s, setS } = d;
  return (
    <Card withBorder>
      <Title order={5} mb="sm">
        {t('compliance.title')}
      </Title>
      <Switch
        label={t('compliance.dismissFourEyes')}
        description={t('compliance.dismissFourEyesHint')}
        checked={!!s.findingDismissFourEyes}
        onChange={(e) => setS({ ...s, findingDismissFourEyes: e.currentTarget.checked })}
      />
    </Card>
  );
}

function RetentionCard({ d }: { d: Draft }) {
  const { t } = useTranslation(['settings', 'common']);
  const { s, setS } = d;
  return (
    <Card withBorder>
      <Title order={5} mb="sm">
        {t('retention.title')}
      </Title>
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <NumberInput
            label={t('retention.runs')}
            description={t('retention.runsHint')}
            min={0}
            value={s.retentionRunDays ?? 0}
            onChange={(v) => setS({ ...s, retentionRunDays: typeof v === 'number' ? v : 0 })}
          />
          <NumberInput
            label={t('retention.notifications')}
            description={t('retention.notificationsHint')}
            min={1}
            value={s.retentionNotificationDays ?? 30}
            onChange={(v) => setS({ ...s, retentionNotificationDays: typeof v === 'number' ? v : 30 })}
          />
          <NumberInput
            label={t('retention.monitors')}
            description={t('retention.monitorsHint')}
            min={1}
            value={s.retentionMonitorDays ?? 30}
            onChange={(v) => setS({ ...s, retentionMonitorDays: typeof v === 'number' ? v : 30 })}
          />
        </SimpleGrid>
        <Text size="xs" c="dimmed">
          {t('retention.hint')}
        </Text>
        <MaintenanceStatusView />
      </Stack>
    </Card>
  );
}

function PublicApiCard({ d }: { d: Draft }) {
  const { t } = useTranslation(['settings', 'common']);
  const { s, setS } = d;
  const publicApi = usePublicApi();
  if (!publicApi.data) return null;
  return (
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
              disabled={publicApi.data.docsSource === 'env'}
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
              {publicApi.data.rateLimitPerMinute ? t('publicApi.docsHintRateLimit', { count: publicApi.data.rateLimitPerMinute }) : t('publicApi.docsHint')}
            </Text>
          </>
        )}
      </Stack>
    </Card>
  );
}

function EndOfLifeCard() {
  const { t } = useTranslation('settings');
  return (
    <Card withBorder>
      <Group gap="xs" mb="xs">
        <IconBuildingFactory2 size={18} />
        <Title order={5}>{t('endOfLife.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('endOfLife.hint')}
      </Text>
      <Group>
        <EndOfLifeButton />
      </Group>
    </Card>
  );
}

function UnattendedCard() {
  const { t } = useTranslation('settings');
  return (
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
            readme: <Anchor inherit href={`${BRAND.repoUrl}#readme`} target="_blank" />,
          }}
        />
      </Text>
    </Card>
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
    if (!(await confirmDanger({ action: 'cleanup', message: t('maintenance.confirm') }))) return;
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
    if (!(await confirmDanger({ action: 'revoke', message: t('tokens.revokeConfirm', { name: token.name, owner: token.owner }) }))) return;
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
