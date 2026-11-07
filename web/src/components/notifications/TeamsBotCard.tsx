import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconDownload } from '@tabler/icons-react';
import type { NotificationSettings, Team, TeamsBotConversation, TeamsBotSettings } from '@sm/shared';
import { apiUrl, get, getOptional, notifyError, notifyOk, put } from '../../api';
import { fmtRelative } from '../../format';
import { useSaveSection } from '../settings/SaveBar';
import { useSsoProviders } from '../sso/SsoSection';

/**
 * Settings → Notifications → Teams bot (ADR 0013 stage 2, a preview, off by default): approve inside the Teams card.
 * The app id, the allowed tenants, the Entra sign-in provider (tid + oid), the bot's credential, which conversation
 * takes the decision cards of a channel, where the bot is installed, and the app package to upload to the tenant.
 */

const KEY = ['teams-bot'];
const CONVERSATIONS = ['teams-bot', 'conversations'];

interface Draft {
  enabled: boolean;
  appId: string;
  tenantIds: string[];
  providerId: string | null;
  credential: 'certificate' | 'secret';
  channels: Record<string, string>;
}

const toDraft = (s: TeamsBotSettings): Draft => ({
  enabled: s.enabled,
  appId: s.appId,
  tenantIds: s.tenantIds,
  providerId: s.providerId,
  credential: s.credential,
  channels: s.channels,
});

export function TeamsBotCard() {
  const { t } = useTranslation(['notifications', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => getOptional<TeamsBotSettings | null>('/settings/teams-bot', null) });
  const conversations = useQuery({
    queryKey: CONVERSATIONS,
    queryFn: () => get<TeamsBotConversation[]>('/settings/teams-bot/conversations'),
    enabled: !!q.data,
  });
  const providers = useSsoProviders(!!q.data);
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => get<Team[]>('/teams'), enabled: !!q.data });
  const notif = useQuery({ queryKey: ['settings', 'notifications'], queryFn: () => getOptional<NotificationSettings | null>('/settings/notifications', null) });
  const [d, setD] = useState<Draft | null>(null);
  const [secret, setSecret] = useState<string | undefined>();
  const [cert, setCert] = useState<string | undefined>();
  const [key, setKey] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) {
      setD(toDraft(q.data));
      setSecret(undefined);
      setCert(undefined);
      setKey(undefined);
    }
  }, [q.data]);
  const dirty = !!q.data && !!d && (JSON.stringify(d) !== JSON.stringify(toDraft(q.data)) || secret !== undefined || cert !== undefined || key !== undefined);
  const save = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const body = {
        ...d,
        ...(secret !== undefined ? { clientSecret: secret } : {}),
        ...(cert !== undefined ? { certificatePem: cert } : {}),
        ...(key !== undefined ? { privateKeyPem: key } : {}),
      };
      qc.setQueryData(KEY, await put<TeamsBotSettings>('/settings/teams-bot', body));
      notifyOk(t('bot.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const inBar = useSaveSection('teamsBot', { dirty, save, reset: () => q.data && setD(toDraft(q.data)) });
  if (!q.data || !d) return null;
  const s = q.data;
  const active = (conversations.data ?? []).filter((c) => c.kind === 'channel' && !c.removedAt);
  const targets = [
    { value: 'teams:instance', label: t('bot.targets.teams') },
    ...(notif.data?.webhook.format === 'teams' ? [{ value: 'webhook:instance', label: t('bot.targets.webhook') }] : []),
    ...(teams.data ?? []).map((x) => ({ value: `team:${x.id}`, label: t('bot.targets.team', { team: x.name }) })),
  ];
  const conversationData = [{ value: '', label: t('bot.useWebhook') }, ...active.map((c) => ({ value: c.id, label: c.name || c.id }))];
  const setChannel = (target: string, conv: string) => {
    const channels = { ...d.channels };
    if (conv) channels[target] = conv;
    else delete channels[target];
    setD({ ...d, channels });
  };
  return (
    <Card withBorder data-testid="teams-bot-card">
      <Group gap="xs" mb="xs">
        <Title order={5}>{t('bot.title')}</Title>
        <Badge color="grape" variant="light" data-testid="teams-bot-preview">
          {t('bot.preview')}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('bot.intro')}
      </Text>
      <Stack gap="sm">
        {s.listener ? (
          <Text size="sm">
            {t('bot.listener', { port: s.listener.port })} <Code>{s.listener.path}</Code>
          </Text>
        ) : (
          <Alert color="gray" variant="light">
            {t('bot.noListener')}
          </Alert>
        )}
        <Switch label={t('bot.enabled')} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
        <TextInput
          label={t('bot.appId')}
          description={t('bot.appIdHint')}
          classNames={{ input: 'mono' }}
          value={d.appId}
          onChange={(e) => setD({ ...d, appId: e.currentTarget.value.trim() })}
          maw={420}
        />
        <TagsInput
          label={t('bot.tenants')}
          description={t('bot.tenantsHint')}
          value={d.tenantIds}
          onChange={(v) => setD({ ...d, tenantIds: v.map((x) => x.trim().toLowerCase()) })}
          maxTags={10}
        />
        <Select
          label={t('bot.provider')}
          description={t('bot.providerHint')}
          data={(providers.data ?? []).map((p) => ({ value: p.id, label: p.displayName }))}
          value={d.providerId}
          onChange={(v) => setD({ ...d, providerId: v })}
          clearable
          maw={420}
        />
        <div>
          <Text size="sm" fw={500} mb={4}>
            {t('bot.credential')}
          </Text>
          <SegmentedControl
            value={d.credential}
            onChange={(v) => setD({ ...d, credential: v as Draft['credential'] })}
            data={[
              { value: 'certificate', label: t('bot.credentials.certificate') },
              { value: 'secret', label: t('bot.credentials.secret') },
            ]}
          />
          <Text size="xs" c="dimmed" mt={4}>
            {s.hasCredential ? t('bot.credentialStored') : t('bot.credentialHint')}
          </Text>
        </div>
        {d.credential === 'secret' ? (
          <PasswordInput
            label={t('bot.secret')}
            placeholder={s.hasCredential ? t('bot.unchanged') : undefined}
            value={secret ?? ''}
            onChange={(e) => setSecret(e.currentTarget.value || undefined)}
            autoComplete="new-password"
            maw={420}
          />
        ) : (
          <>
            <Textarea
              label={t('bot.certificate')}
              placeholder={s.hasCredential ? t('bot.unchanged') : '-----BEGIN CERTIFICATE-----'}
              classNames={{ input: 'mono' }}
              autosize
              minRows={2}
              maxRows={6}
              value={cert ?? ''}
              onChange={(e) => setCert(e.currentTarget.value || undefined)}
            />
            <Textarea
              label={t('bot.privateKey')}
              placeholder={s.hasCredential ? t('bot.unchanged') : '-----BEGIN PRIVATE KEY-----'}
              classNames={{ input: 'mono' }}
              autosize
              minRows={2}
              maxRows={6}
              value={key ?? ''}
              onChange={(e) => setKey(e.currentTarget.value || undefined)}
            />
          </>
        )}
        <div>
          <Text size="sm" fw={500}>
            {t('bot.channels')}
          </Text>
          <Text size="xs" c="dimmed" mb={4}>
            {active.length ? t('bot.channelsHint') : t('bot.channelsNone')}
          </Text>
          {active.length > 0 && (
            <Stack gap={6}>
              {targets.map((x) => (
                <Select
                  key={x.value}
                  label={x.label}
                  data={conversationData}
                  value={d.channels[x.value] ?? ''}
                  onChange={(v) => setChannel(x.value, v ?? '')}
                  allowDeselect={false}
                  maw={420}
                />
              ))}
            </Stack>
          )}
        </div>
        <div>
          <Text size="sm" fw={500} mb={4}>
            {t('bot.installed')}
          </Text>
          {(conversations.data ?? []).length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('bot.installedNone')}
            </Text>
          ) : (
            <div className="table-scroll">
              <Table fz="sm" aria-label={t('bot.installed')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('bot.where')}</Table.Th>
                    <Table.Th>{t('bot.kind')}</Table.Th>
                    <Table.Th>{t('bot.since')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {(conversations.data ?? []).map((c) => (
                    <Table.Tr key={c.id}>
                      <Table.Td>{c.kind === 'personal' ? (c.user ?? t('bot.notLinked')) : c.name || c.id}</Table.Td>
                      <Table.Td>{t(`bot.kinds.${c.kind}`)}</Table.Td>
                      <Table.Td>{c.removedAt ? t('bot.removed') : fmtRelative(c.installedAt)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </div>
        <Group justify="space-between" wrap="wrap" gap="xs">
          {s.appId ? (
            <Button size="xs" variant="default" component="a" href={apiUrl('/settings/teams-bot/package')} leftSection={<IconDownload size={14} />}>
              {t('bot.package')}
            </Button>
          ) : (
            <Text size="xs" c="dimmed">
              {t('bot.packageNeedsAppId')}
            </Text>
          )}
          {!inBar && dirty && (
            <Button size="xs" onClick={() => void save()} loading={busy}>
              {t('common:save')}
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
