import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  ColorInput,
  FileButton,
  Group,
  Image,
  Modal,
  PasswordInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowBackUp, IconSend, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  DEFAULT_DAILY_SUMMARY,
  TEAM_NEW_RESOURCE_MODES,
  type DailySummaryPrefs,
  type Team,
  type TeamChannel,
  type TeamNewResourceMode,
  type TeamReportBranding,
  type TeamSettings,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../api';
import { appUrl } from '../../basePath';
import { DailySummaryFields, browserZone, zones } from '../notifications/DailySummaryCard';

type Draft = Omit<TeamChannel, 'hasUrl'> & { url: string };
type BrandingDraft = Omit<TeamReportBranding, 'customLogo'>;
type Save = (body: Record<string, unknown>, done: string) => Promise<boolean>;

/** Whether a value is the team's own or the instance default (#136), shown on every setting of a team. */
function Scope({ own, testId }: { own: boolean; testId: string }) {
  const { t } = useTranslation('users');
  return (
    <Badge variant="light" color={own ? 'grape' : 'gray'} data-testid={testId}>
      {own ? t('teamSettings.overrides') : t('teamSettings.inherited')}
    </Badge>
  );
}

function Section({ title, hint, own, testId, children }: { title: string; hint: string; own: boolean; testId: string; children: ReactNode }) {
  return (
    <Stack gap="sm" pt="sm">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Title order={3} size="h5">
            {title}
          </Title>
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        </div>
        <Scope own={own} testId={testId} />
      </Group>
      {children}
    </Stack>
  );
}

const ReadOnly = () => {
  const { t } = useTranslation('users');
  return (
    <Text size="xs" c="dimmed">
      {t('teamSettings.readOnly')}
    </Text>
  );
};

/**
 * A team's settings (#136): its own channel for messages about its resources, which new resources of its members it
 * owns, the daily summary its members get unless they chose their own, and report branding. Each shows whether it is
 * the team's own value or the instance default, with the way back to the default.
 */
export function TeamSettingsModal({ team, onClose }: { team: Team; onClose: () => void }) {
  // profile: the daily summary fields (loaded with the dialog, so opening that tab does not suspend it)
  const { t } = useTranslation(['users', 'common', 'profile']);
  const [tab, setTab] = useState<string | null>('channel');
  const qc = useQueryClient();
  const key = ['team-settings', team.id];
  const q = useQuery({ queryKey: key, queryFn: () => get<TeamSettings>(`/teams/${team.id}/settings`) });
  const s = q.data;
  const save: Save = async (body, done) => {
    try {
      qc.setQueryData(key, await put<TeamSettings>(`/teams/${team.id}/settings`, body));
      notifyOk(done);
      return true;
    } catch (e) {
      notifyError(e, t('teamSettings.notSaved'));
      return false;
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('teamSettings.title', { name: team.name })} size="lg">
      {s && (
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="channel">{t('teamSettings.tabs.channel')}</Tabs.Tab>
            <Tabs.Tab value="resources">{t('teamSettings.tabs.resources')}</Tabs.Tab>
            <Tabs.Tab value="summary">{t('teamSettings.tabs.summary')}</Tabs.Tab>
            <Tabs.Tab value="branding">{t('teamSettings.tabs.branding')}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="channel">
            <ChannelSection s={s} save={save} />
          </Tabs.Panel>
          <Tabs.Panel value="resources">
            <NewResourcesSection s={s} save={save} />
          </Tabs.Panel>
          <Tabs.Panel value="summary">
            <SummarySection s={s} save={save} />
          </Tabs.Panel>
          <Tabs.Panel value="branding">
            <BrandingSection s={s} save={save} onLogo={(next) => qc.setQueryData(key, next)} />
          </Tabs.Panel>
        </Tabs>
      )}
    </Modal>
  );
}

function ChannelSection({ s, save }: { s: TeamSettings; save: Save }) {
  const { t } = useTranslation(['users', 'common']);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<'save' | 'reset' | 'test' | null>(null);
  useEffect(() => {
    setDraft(s.channel ? { enabled: s.channel.enabled, format: s.channel.format, mode: s.channel.mode, url: '' } : null);
  }, [s.channel]);
  const overrides = !!s.channel;
  const store = async (channel: Draft | null, what: 'save' | 'reset') => {
    setBusy(what);
    const body = channel
      ? { channel: { enabled: channel.enabled, format: channel.format, mode: channel.mode, ...(channel.url ? { url: channel.url } : {}) } }
      : { channel: null };
    await save(body, what === 'reset' ? t('teamSettings.resetDone') : t('teamSettings.saved'));
    setBusy(null);
  };
  const test = async () => {
    setBusy('test');
    try {
      const r = await post<{ ok: boolean; error?: string }>(`/teams/${s.teamId}/settings/test`);
      if (r.ok) notifyOk(t('teamSettings.testSent'));
      else notifyError(new Error(r.error ?? ''), t('teamSettings.testFailed'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title={t('teamSettings.channel')} hint={t('teamSettings.channelHint')} own={overrides} testId="team-channel-scope">
      {!draft ? (
        <Alert variant="light" color="gray">
          <Text size="sm">{s.instance.teamsEnabled || s.instance.webhookEnabled ? t('teamSettings.usesInstance') : t('teamSettings.usesInstanceNone')}</Text>
          {s.canChange && (
            <Group mt="xs">
              <Button size="xs" variant="light" onClick={() => setDraft({ enabled: true, format: 'teams', mode: 'also', url: '' })}>
                {t('teamSettings.useOwn')}
              </Button>
              <Button size="xs" variant="subtle" component={Link} to="/settings/notifications">
                {t('teamSettings.instanceLink')}
              </Button>
            </Group>
          )}
        </Alert>
      ) : (
        <Stack gap="sm">
          <Switch
            label={t('teamSettings.enabled')}
            checked={draft.enabled}
            disabled={!s.canChange}
            onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })}
          />
          <Select
            label={t('teamSettings.format')}
            disabled={!s.canChange}
            data={[
              { value: 'teams', label: t('teamSettings.formats.teams') },
              { value: 'json', label: t('teamSettings.formats.json') },
            ]}
            value={draft.format}
            allowDeselect={false}
            onChange={(v) => v && setDraft({ ...draft, format: v as Draft['format'] })}
          />
          <PasswordInput
            label={t('teamSettings.url')}
            description={s.channel?.hasUrl ? t('teamSettings.urlStored') : t('teamSettings.urlHint')}
            disabled={!s.canChange}
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.currentTarget.value })}
            autoComplete="off"
          />
          <div>
            <Text size="sm" fw={500} mb={4}>
              {t('teamSettings.mode')}
            </Text>
            <SegmentedControl
              fullWidth
              disabled={!s.canChange}
              value={draft.mode}
              onChange={(v) => setDraft({ ...draft, mode: v as Draft['mode'] })}
              data={[
                { value: 'also', label: t('teamSettings.modes.also') },
                { value: 'instead', label: t('teamSettings.modes.instead') },
              ]}
            />
            <Text size="xs" c="dimmed" mt={4}>
              {t(`teamSettings.modeHints.${draft.mode}`)}
            </Text>
          </div>
          {s.canChange && (
            <Group justify="space-between">
              <Button
                variant="subtle"
                leftSection={<IconArrowBackUp size={14} />}
                loading={busy === 'reset'}
                onClick={() => (overrides ? store(null, 'reset') : setDraft(null))}
              >
                {t('teamSettings.backToDefault')}
              </Button>
              <Group>
                {s.channel?.hasUrl && (
                  <Button variant="default" leftSection={<IconSend size={14} />} loading={busy === 'test'} onClick={test}>
                    {t('teamSettings.test')}
                  </Button>
                )}
                <Button loading={busy === 'save'} onClick={() => store(draft, 'save')}>
                  {t('common:save')}
                </Button>
              </Group>
            </Group>
          )}
        </Stack>
      )}
      {!s.canChange && <ReadOnly />}
    </Section>
  );
}

function NewResourcesSection({ s, save }: { s: TeamSettings; save: Save }) {
  const { t } = useTranslation('users');
  const choose = (v: string) => save({ newResources: v as TeamNewResourceMode }, t('teamSettings.saved'));
  return (
    <Section
      title={t('teamSettings.newResources.title')}
      hint={t('teamSettings.newResources.hint')}
      own={s.newResources !== 'auto'}
      testId="team-new-resources-scope"
    >
      <SegmentedControl
        fullWidth
        disabled={!s.canChange}
        value={s.newResources}
        onChange={choose}
        data={TEAM_NEW_RESOURCE_MODES.map((m) => ({ value: m, label: t(`teamSettings.newResources.modes.${m}`) }))}
      />
      <Text size="xs" c="dimmed">
        {t(`teamSettings.newResources.hints.${s.newResources}`)}
      </Text>
      {!s.canChange && <ReadOnly />}
    </Section>
  );
}

function SummarySection({ s, save }: { s: TeamSettings; save: Save }) {
  const { t } = useTranslation(['users', 'common']);
  const [d, setD] = useState<DailySummaryPrefs | null>(s.summary);
  useEffect(() => setD(s.summary), [s.summary]);
  const zoneList = useMemo(() => {
    const list = zones();
    return d && !list.includes(d.timeZone) ? [d.timeZone, ...list] : list;
  }, [d]);
  const set = (patch: Partial<DailySummaryPrefs>) => d && setD({ ...d, ...patch });
  return (
    <Section title={t('teamSettings.summary.title')} hint={t('teamSettings.summary.hint')} own={!!s.summary} testId="team-summary-scope">
      {!d ? (
        <Alert variant="light" color="gray">
          <Text size="sm">{t('teamSettings.summary.usesInstance')}</Text>
          {s.canChange && (
            <Button size="xs" variant="light" mt="xs" onClick={() => setD({ ...DEFAULT_DAILY_SUMMARY, enabled: true, timeZone: browserZone() })}>
              {t('teamSettings.summary.setDefault')}
            </Button>
          )}
        </Alert>
      ) : (
        <Stack gap="sm">
          <Switch
            label={t('teamSettings.summary.enabled')}
            checked={d.enabled}
            disabled={!s.canChange}
            onChange={(e) => set({ enabled: e.currentTarget.checked })}
          />
          {d.enabled && <DailySummaryFields d={d} set={set} zoneList={zoneList} />}
          {s.canChange && (
            <Group justify="space-between">
              <Button
                variant="subtle"
                leftSection={<IconArrowBackUp size={14} />}
                onClick={() => (s.summary ? save({ summary: null }, t('teamSettings.resetDone')) : setD(null))}
              >
                {t('teamSettings.backToDefault')}
              </Button>
              <Button onClick={() => save({ summary: d }, t('teamSettings.saved'))} disabled={d.enabled && !d.sections.length}>
                {t('common:save')}
              </Button>
            </Group>
          )}
        </Stack>
      )}
      {!s.canChange && <ReadOnly />}
    </Section>
  );
}

const EMPTY_BRANDING: BrandingDraft = { companyName: null, accentColor: null, classification: null, footerNote: null };
const ownBranding = (b: TeamReportBranding | null): BrandingDraft =>
  b ? { companyName: b.companyName, accentColor: b.accentColor, classification: b.classification, footerNote: b.footerNote } : EMPTY_BRANDING;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function BrandingSection({ s, save, onLogo }: { s: TeamSettings; save: Save; onLogo: (next: TeamSettings) => void }) {
  const { t } = useTranslation(['users', 'common']);
  const [d, setD] = useState<BrandingDraft>(ownBranding(s.branding));
  const [logoKey, setLogoKey] = useState(0);
  useEffect(() => setD(ownBranding(s.branding)), [s.branding]);
  const field = (k: Exclude<keyof BrandingDraft, 'accentColor'>) => ({
    value: d[k] ?? '',
    placeholder: s.instance.branding[k] || t('teamSettings.branding.none'),
    disabled: !s.canChange,
    onChange: (e: { currentTarget: { value: string } }) => setD({ ...d, [k]: e.currentTarget.value || null }),
  });
  const upload = async (file: File | null) => {
    if (!file) return;
    try {
      onLogo(await post<TeamSettings>(`/teams/${s.teamId}/settings/logo`, { contentBase64: await readBase64(file) }));
      setLogoKey((k) => k + 1);
      notifyOk(t('teamSettings.branding.logoSaved'));
    } catch (e) {
      notifyError(e, t('teamSettings.notSaved'));
    }
  };
  const removeLogo = async () => {
    try {
      onLogo(await del<TeamSettings>(`/teams/${s.teamId}/settings/logo`));
      notifyOk(t('teamSettings.branding.logoRemoved'));
    } catch (e) {
      notifyError(e, t('teamSettings.notSaved'));
    }
  };
  return (
    <Section title={t('teamSettings.branding.title')} hint={t('teamSettings.branding.hint')} own={!!s.branding} testId="team-branding-scope">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label={t('teamSettings.branding.companyName')} maxLength={120} {...field('companyName')} />
        <ColorInput
          eyeDropperButtonProps={{ 'aria-label': t('teamSettings.branding.eyeDropper') }}
          label={t('teamSettings.branding.accentColor')}
          format="hex"
          value={d.accentColor ?? ''}
          placeholder={s.instance.branding.accentColor}
          disabled={!s.canChange}
          onChange={(v) => setD({ ...d, accentColor: v || null })}
        />
        <TextInput label={t('teamSettings.branding.classification')} maxLength={60} {...field('classification')} />
        <TextInput label={t('teamSettings.branding.footerNote')} maxLength={200} {...field('footerNote')} />
      </SimpleGrid>
      <Text size="xs" c="dimmed">
        {t('teamSettings.branding.emptyKeeps')}
      </Text>
      <Group gap="sm" align="center">
        {s.branding?.customLogo ? (
          <Image src={appUrl(`/api/teams/${s.teamId}/settings/logo?v=${logoKey}`)} h={32} w="auto" fit="contain" alt={t('teamSettings.branding.logo')} />
        ) : (
          <Text size="sm" c="dimmed">
            {t('teamSettings.branding.instanceLogo')}
          </Text>
        )}
        {s.canChange && (
          <>
            <FileButton onChange={upload} accept="image/png,image/jpeg">
              {(props) => (
                <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} {...props}>
                  {t('teamSettings.branding.uploadLogo')}
                </Button>
              )}
            </FileButton>
            {s.branding?.customLogo && (
              <Button size="xs" variant="subtle" color="red" onClick={removeLogo}>
                {t('teamSettings.branding.removeLogo')}
              </Button>
            )}
          </>
        )}
      </Group>
      <Text size="sm" data-testid="team-report-schedules">
        {s.reportSchedules.length ? t('teamSettings.branding.schedules', { count: s.reportSchedules.length }) : t('teamSettings.branding.noSchedules')}{' '}
        {s.reportSchedules.map((r, i) => (
          <span key={r.id}>
            {i > 0 && ', '}
            <Anchor component={Link} to="/reports" size="sm">
              {r.name}
            </Anchor>
          </span>
        ))}
      </Text>
      {s.canChange ? (
        <Group justify="space-between">
          <Button
            variant="subtle"
            leftSection={<IconArrowBackUp size={14} />}
            disabled={!s.branding}
            onClick={() => save({ branding: null }, t('teamSettings.resetDone'))}
          >
            {t('teamSettings.backToDefault')}
          </Button>
          <Button onClick={() => save({ branding: d }, t('teamSettings.saved'))}>{t('common:save')}</Button>
        </Group>
      ) : (
        <ReadOnly />
      )}
    </Section>
  );
}
