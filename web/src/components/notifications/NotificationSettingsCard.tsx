import { useEffect, useState } from 'react';
import {
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Divider,
  Group,
  NumberInput,
  PasswordInput,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDeviceFloppy, IconSend } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_INFO,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationSettings,
  type NotificationSettingsInput,
} from '@sm/shared';
import { getOptional, notifyError, notifyOk, post, put } from '../../api';
import { useMe } from '../../auth';
import { Hint } from '../common';
import i18n from '../../i18n';
import { errorText } from '../../i18n/errors';
import { appUrl } from '../../basePath';

const CHANNELS: NotificationChannel[] = ['inApp', 'email', 'teams', 'webhook'];

/** Description of an event (English default in shared/, translated in the notifications namespace). */
const eventInfo = (ev: NotificationEvent): string =>
  i18n.t(`notifications:events.${ev}.info` as 'notifications:events.run.failed.info', { defaultValue: NOTIFICATION_EVENT_INFO[ev] });

/** Write-only secret: undefined = keep the stored value, '' = remove it, text = replace it. */
type Secret = string | undefined;

interface Draft {
  email: Omit<NotificationSettings['email'], 'hasPassword'>;
  teamsEnabled: boolean;
  webhookEnabled: boolean;
  routes: Record<NotificationEvent, NotificationChannel[]>;
  baseUrl: string;
  allowedEmailDomains: string[];
}

const toDraft = (s: NotificationSettings): Draft => ({
  email: {
    enabled: s.email.enabled,
    host: s.email.host ?? '',
    port: s.email.port ?? 587,
    secure: s.email.secure,
    user: s.email.user ?? '',
    from: s.email.from ?? '',
  },
  teamsEnabled: s.teams.enabled,
  webhookEnabled: s.webhook.enabled,
  routes: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, s.routes?.[e] ?? ['inApp']])) as Draft['routes'],
  baseUrl: s.baseUrl ?? '',
  allowedEmailDomains: s.allowedEmailDomains ?? [],
});

function SecretInput({
  label,
  description,
  stored,
  value,
  onChange,
  mono,
}: {
  label: string;
  description?: string;
  stored: boolean;
  value: Secret;
  onChange: (v: Secret) => void;
  mono?: boolean;
}) {
  const { t } = useTranslation('settings');
  const removing = stored && value === '';
  return (
    <div>
      <PasswordInput
        label={label}
        description={description}
        classNames={mono ? { input: 'mono' } : undefined}
        placeholder={stored ? t('notify.unchanged') : t('notify.notSet')}
        value={value ?? ''}
        onChange={(e) => onChange(e.currentTarget.value === '' && !stored ? undefined : e.currentTarget.value)}
        autoComplete="new-password"
      />
      {stored && (
        <Group gap={6} mt={2}>
          {removing ? (
            <>
              <Text size="xs" c="orange">
                {t('notify.willBeRemoved')}
              </Text>
              <Anchor size="xs" component="button" type="button" onClick={() => onChange(undefined)}>
                {t('notify.keep')}
              </Anchor>
            </>
          ) : (
            <Anchor size="xs" component="button" type="button" c="red" onClick={() => onChange('')}>
              {t('notify.removeStored')}
            </Anchor>
          )}
        </Group>
      )}
    </div>
  );
}

function TestButton({ channel, to, disabled }: { channel: NotificationChannel; to?: string; disabled?: boolean }) {
  const { t } = useTranslation('settings');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await post<{ ok: boolean; error?: string }>('/settings/notifications/test', { channel, ...(to ? { to } : {}) }));
    } catch (e) {
      setResult({ ok: false, error: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap={4}>
      <Group>
        <Button size="xs" variant="light" leftSection={<IconSend size={14} />} loading={busy} disabled={disabled} onClick={run}>
          {t('notify.sendTest')}
        </Button>
      </Group>
      {result && (
        <Text size="xs" c={result.ok ? 'green' : 'red'} style={{ wordBreak: 'break-word' }}>
          {result.ok ? t('notify.testSent') : t('notify.testFailed', { error: result.error ?? t('notify.unknownError') })}
        </Text>
      )}
    </Stack>
  );
}

/** Admin settings for e-mail, Teams, webhook and per-event routing. Hidden while the server has no endpoint for it. */
export function NotificationSettingsCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const { me } = useMe();
  const q = useQuery({ queryKey: ['settings', 'notifications'], queryFn: () => getOptional<NotificationSettings | null>('/settings/notifications', null) });
  const [d, setD] = useState<Draft | null>(null);
  const [smtpPassword, setSmtpPassword] = useState<Secret>();
  const [teamsUrl, setTeamsUrl] = useState<Secret>();
  const [webhookUrl, setWebhookUrl] = useState<Secret>();
  const [testTo, setTestTo] = useState(me?.user.email ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.data) {
      setD(toDraft(q.data));
      setSmtpPassword(undefined);
      setTeamsUrl(undefined);
      setWebhookUrl(undefined);
    }
  }, [q.data]);

  if (!q.data || !d) return null;
  const stored = q.data;
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(stored)) || smtpPassword !== undefined || teamsUrl !== undefined || webhookUrl !== undefined;
  const setEmail = (patch: Partial<Draft['email']>) => setD({ ...d, email: { ...d.email, ...patch } });
  const toggleRoute = (ev: NotificationEvent, ch: NotificationChannel, on: boolean) => {
    const cur = d.routes[ev] ?? [];
    setD({ ...d, routes: { ...d.routes, [ev]: on ? [...new Set([...cur, ch])] : cur.filter((c) => c !== ch) } });
  };

  const save = async () => {
    const body: NotificationSettingsInput = {
      email: { ...d.email, user: d.email.user || undefined, ...(smtpPassword !== undefined ? { password: smtpPassword } : {}) },
      teams: { enabled: d.teamsEnabled, ...(teamsUrl !== undefined ? { webhookUrl: teamsUrl } : {}) },
      webhook: { enabled: d.webhookEnabled, ...(webhookUrl !== undefined ? { url: webhookUrl } : {}) },
      routes: d.routes,
      baseUrl: d.baseUrl.trim() || undefined,
      allowedEmailDomains: d.allowedEmailDomains,
    };
    setBusy(true);
    try {
      const saved = await put<NotificationSettings>('/settings/notifications', body);
      if (saved && typeof saved === 'object' && 'email' in saved) qc.setQueryData(['settings', 'notifications'], saved);
      else await qc.invalidateQueries({ queryKey: ['settings', 'notifications'] });
      notifyOk(t('notify.saved'));
    } catch (e) {
      notifyError(e, t('notify.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  const unsaved = dirty ? t('notify.unsaved') : undefined;

  return (
    <Card withBorder>
      <Title order={5}>{t('notify.title')}</Title>
      <Text size="sm" c="dimmed" mb="sm">
        {t('notify.intro')}
      </Text>
      <Stack>
        <TextInput
          label={t('notify.baseUrl')}
          description={t('notify.baseUrlHint', { example: 'https://steward.example.com' })}
          classNames={{ input: 'mono' }}
          placeholder={appUrl()}
          value={d.baseUrl}
          onChange={(e) => setD({ ...d, baseUrl: e.currentTarget.value })}
        />

        <Divider label={t('notify.email')} labelPosition="left" />
        <Switch label={t('notify.sendEmails')} checked={d.email.enabled} onChange={(e) => setEmail({ enabled: e.currentTarget.checked })} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label={t('notify.smtpHost')}
            classNames={{ input: 'mono' }}
            placeholder="smtp.example.com"
            value={d.email.host}
            onChange={(e) => setEmail({ host: e.currentTarget.value })}
          />
          <NumberInput
            label={t('notify.port')}
            min={1}
            max={65535}
            value={d.email.port}
            onChange={(v) => setEmail({ port: typeof v === 'number' ? v : 587 })}
          />
          <TextInput label={t('notify.user')} value={d.email.user ?? ''} onChange={(e) => setEmail({ user: e.currentTarget.value })} autoComplete="off" />
          <SecretInput
            label={t('notify.password')}
            // the stored password stays with its server: another host, port or user needs it again (the server refuses otherwise)
            description={
              stored.email.hasPassword &&
              smtpPassword === undefined &&
              (d.email.host.trim().toLowerCase() !== stored.email.host.toLowerCase() ||
                d.email.port !== stored.email.port ||
                (d.email.user ?? '').trim() !== (stored.email.user ?? ''))
                ? t('notify.passwordAgain')
                : undefined
            }
            stored={stored.email.hasPassword}
            value={smtpPassword}
            onChange={setSmtpPassword}
          />
          <TextInput
            label={t('notify.from')}
            placeholder="Steward <noreply@example.com>"
            value={d.email.from}
            onChange={(e) => setEmail({ from: e.currentTarget.value })}
          />
          <Switch
            label={t('notify.secure')}
            description={t('notify.secureHint')}
            checked={d.email.secure}
            onChange={(e) => setEmail({ secure: e.currentTarget.checked })}
            mt={{ sm: 'lg' }}
          />
        </SimpleGrid>
        <TagsInput
          label={t('notify.allowedDomains')}
          description={t('notify.allowedDomainsHint')}
          placeholder={d.allowedEmailDomains.length ? undefined : t('notify.allowedDomainsPlaceholder')}
          classNames={{ input: 'mono' }}
          maxTags={100}
          splitChars={[',', ' ', ';']}
          value={d.allowedEmailDomains}
          onChange={(v) => setD({ ...d, allowedEmailDomains: v.map((x) => x.trim().toLowerCase()).filter(Boolean) })}
        />
        <Group align="flex-end" gap="sm">
          <TextInput label={t('notify.testRecipient')} size="xs" w={260} maw="100%" value={testTo} onChange={(e) => setTestTo(e.currentTarget.value)} />
          <TestButton channel="email" to={testTo.trim() || undefined} disabled={!!dirty || !stored.email.enabled} />
        </Group>

        <Divider label="Microsoft Teams" labelPosition="left" />
        <Switch label={t('notify.postTeams')} checked={d.teamsEnabled} onChange={(e) => setD({ ...d, teamsEnabled: e.currentTarget.checked })} />
        <SecretInput
          label={t('notify.webhookUrl')}
          description={t('notify.teamsUrlHint')}
          mono
          stored={stored.teams.hasWebhookUrl}
          value={teamsUrl}
          onChange={setTeamsUrl}
        />
        <TestButton channel="teams" disabled={!!dirty || !stored.teams.enabled || !stored.teams.hasWebhookUrl} />

        <Divider label="Webhook" labelPosition="left" />
        <Switch label={t('notify.sendWebhook')} checked={d.webhookEnabled} onChange={(e) => setD({ ...d, webhookEnabled: e.currentTarget.checked })} />
        <SecretInput
          label={t('notify.webhookUrl')}
          description={t('notify.webhookUrlHint')}
          mono
          stored={stored.webhook.hasUrl}
          value={webhookUrl}
          onChange={setWebhookUrl}
        />
        <TestButton channel="webhook" disabled={!!dirty || !stored.webhook.enabled || !stored.webhook.hasUrl} />

        <Divider label={t('notify.routes')} labelPosition="left" />
        <Table.ScrollContainer minWidth={520}>
          <Table verticalSpacing={6} fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('notify.event')}</Table.Th>
                {CHANNELS.map((c) => (
                  <Table.Th key={c} ta="center" w={80}>
                    {t(`notify.channels.${c}`)}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {NOTIFICATION_EVENTS.map((ev) => (
                <Table.Tr key={ev}>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {ev}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {eventInfo(ev)}
                    </Text>
                  </Table.Td>
                  {CHANNELS.map((c) => (
                    <Table.Td key={c}>
                      <Checkbox
                        mx="auto"
                        w="fit-content"
                        aria-label={`${ev}: ${t(`notify.channels.${c}`)}`}
                        checked={(d.routes[ev] ?? []).includes(c)}
                        onChange={(e) => toggleRoute(ev, c, e.currentTarget.checked)}
                      />
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Hint>{t('notify.routesHint')}</Hint>
        <Group justify="flex-end" gap="sm">
          <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save} loading={busy} disabled={!dirty}>
            {t('notify.save')}
          </Button>
        </Group>
        {unsaved && (
          <Alert color="yellow" variant="light" p="xs">
            {unsaved}
          </Alert>
        )}
      </Stack>
    </Card>
  );
}
