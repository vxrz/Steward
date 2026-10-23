import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconCheck, IconCopy, IconKey, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ApiToken, ApiTokenCreated, ApiTokenScope, UserInfo } from '@sm/shared';
import { del, getOptional, notifyError, notifyOk, patch, post } from '../api';
import { useMe } from '../auth';
import { Hint, PageHeader } from '../components/common';
import { ApiTokenTable } from '../components/ApiTokenTable';
import { PublicApiInfo, usePublicApi } from '../components/PublicApiInfo';
import { McpClientConfig, useMcpServer } from '../components/mcp/McpClientConfig';
import { ChangePasswordForm } from './Auth';
import { LanguageSelect } from '../components/LanguageSelect';
import { DailySummaryCard } from '../components/notifications/DailySummaryCard';
import {
  browserNotificationsSupported,
  getBrowserNotifyOptIn,
  setBrowserNotifyOptIn,
  showBrowserNotification,
} from '../components/notifications/browserNotify';
import { confirmDanger } from '../components/confirm';

export function ProfilePage() {
  const { t } = useTranslation('profile');
  const { me } = useMe();
  if (!me) return null;
  const u = me.user;
  const local = !u.authSource || u.authSource === 'local';
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Stack maw={760}>
        <AccountCard user={u} local={local} />
        <LanguageCard user={u} />
        <NotificationsCard user={u} />
        <DailySummaryCard />
        {local && <PasswordCard />}
        <TokensCard />
      </Stack>
    </>
  );
}

function LanguageCard({ user }: { user: UserInfo }) {
  const { t } = useTranslation('profile');
  return (
    <Card withBorder>
      <Title order={5} mb="sm">
        {t('language.title')}
      </Title>
      <LanguageSelect label={t('language.label')} description={t('language.hint')} maw={320} />
      {!user.locale && (
        <Text size="xs" c="dimmed" mt="xs">
          {t('language.notChosen')}
        </Text>
      )}
    </Card>
  );
}

function AccountCard({ user, local }: { user: UserInfo; local: boolean }) {
  const { t } = useTranslation(['profile', 'common']);
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDisplayName(user.displayName);
    setEmail(user.email ?? '');
  }, [user.displayName, user.email]);
  const dirty = displayName !== user.displayName || email !== (user.email ?? '');
  const save = async () => {
    setBusy(true);
    try {
      await patch<UserInfo>('/me', { displayName: displayName.trim(), email: email.trim() });
      await qc.invalidateQueries({ queryKey: ['auth'] });
      notifyOk(t('account.saved'));
    } catch (e) {
      notifyError(e, t('notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card withBorder>
      <Title order={5} mb="sm">
        {t('account.title')}
      </Title>
      <Stack gap="sm">
        <Group gap="xs">
          <Text size="sm" c="dimmed">
            {t('account.username')}
          </Text>
          <Code>{user.username}</Code>
          {user.roles.map((r) => (
            <Badge key={r} size="sm" variant="light">
              {t(`common:roles.${r}`)}
            </Badge>
          ))}
          {user.teams.map((team) => (
            <Badge key={team} size="sm" variant="outline" color="gray">
              {team}
            </Badge>
          ))}
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label={t('account.displayName')} required disabled={!local} value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} />
          <TextInput label={t('account.email')} type="email" disabled={!local} value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
        </SimpleGrid>
        {!local && <Hint>{t('account.ssoHint')}</Hint>}
        {local && (
          <Group>
            <Button onClick={save} loading={busy} disabled={!dirty || !displayName.trim()}>
              {t('common:save')}
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

function NotificationsCard({ user }: { user: UserInfo }) {
  const { t } = useTranslation('profile');
  const qc = useQueryClient();
  const supported = browserNotificationsSupported();
  const [browserOn, setBrowserOn] = useState(() => getBrowserNotifyOptIn() && supported && Notification.permission === 'granted');
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(supported ? Notification.permission : 'unsupported');
  const [emailBusy, setEmailBusy] = useState(false);

  const setEmailNotifications = async (on: boolean) => {
    setEmailBusy(true);
    try {
      await patch<UserInfo>('/me', { emailNotifications: on });
      await qc.invalidateQueries({ queryKey: ['auth'] });
    } catch (e) {
      notifyError(e, t('notSaved'));
    } finally {
      setEmailBusy(false);
    }
  };

  const toggleBrowser = async (on: boolean) => {
    if (!on) {
      setBrowserNotifyOptIn(false);
      setBrowserOn(false);
      return;
    }
    let p = Notification.permission;
    if (p === 'default') p = await Notification.requestPermission();
    setPermission(p);
    if (p === 'granted') {
      setBrowserNotifyOptIn(true);
      setBrowserOn(true);
    }
  };

  return (
    <Card withBorder>
      <Title order={5} mb="sm">
        {t('notifications.title')}
      </Title>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('notifications.intro')}
        </Text>
        <Switch
          label={t('notifications.email')}
          description={user.email ? t('notifications.emailHint', { email: user.email }) : t('notifications.emailMissing')}
          checked={user.emailNotifications && !!user.email}
          disabled={emailBusy || !user.email}
          onChange={(e) => setEmailNotifications(e.currentTarget.checked)}
        />
        <Switch
          label={t('notifications.browser')}
          description={
            permission === 'unsupported'
              ? t('notifications.browserUnsupported')
              : permission === 'denied'
                ? t('notifications.browserDenied')
                : t('notifications.browserHint')
          }
          checked={browserOn}
          disabled={permission === 'unsupported' || permission === 'denied'}
          onChange={(e) => toggleBrowser(e.currentTarget.checked)}
        />
        {browserOn && (
          <Group>
            <Button size="xs" variant="light" onClick={() => showBrowserNotification(t('notifications.testTitle'), t('notifications.testBody'), 'sm-test')}>
              {t('notifications.test')}
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

function PasswordCard() {
  const { t } = useTranslation('profile');
  const [open, setOpen] = useState(false);
  return (
    <Card withBorder>
      <Group justify="space-between" gap="sm">
        <div>
          <Title order={5}>{t('password.title')}</Title>
          <Text size="sm" c="dimmed">
            {t('password.hint')}
          </Text>
        </div>
        <Button variant="default" leftSection={<IconKey size={16} />} onClick={() => setOpen(true)}>
          {t('password.change')}
        </Button>
      </Group>
      <Modal opened={open} onClose={() => setOpen(false)} title={t('password.change')}>
        <ChangePasswordForm
          onDone={() => {
            setOpen(false);
            notifyOk(t('password.changed'));
          }}
        />
      </Modal>
    </Card>
  );
}

function TokensCard() {
  const { t } = useTranslation(['profile', 'common']);
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['me', 'tokens'], queryFn: () => getOptional<ApiToken[] | null>('/me/tokens', null) });
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const isMobile = useMediaQuery('(max-width: 48em)');

  const revoke = async (token: ApiToken) => {
    if (!(await confirmDanger({ action: 'revoke', message: t('tokens.revokeConfirm', { name: token.name }) }))) return;
    try {
      await del(`/me/tokens/${encodeURIComponent(token.id)}`);
      notifyOk(t('tokens.revoked'));
      qc.invalidateQueries({ queryKey: ['me', 'tokens'] });
    } catch (e) {
      notifyError(e);
    }
  };

  const list = tokens.data ?? [];
  const host = typeof window !== 'undefined' ? window.location.origin : 'http://<host>';
  const publicApi = usePublicApi();
  const mcp = useMcpServer();
  // The versioned REST API is the stable interface for scripts; fall back to the internal API when it is off.
  const exampleUrl = `${host}${publicApi.data?.enabled ? `${publicApi.data.basePath}/runs?limit=10` : '/api/runs'}`;
  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm" gap="sm">
        <div>
          <Title order={5}>{t('tokens.title')}</Title>
          <Text size="sm" c="dimmed">
            {t('tokens.hint')}
          </Text>
        </div>
        {tokens.data !== null && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
            {t('tokens.new')}
          </Button>
        )}
      </Group>
      {tokens.data === null ? (
        <Text size="sm" c="dimmed">
          {t('tokens.unavailable')}
        </Text>
      ) : list.length === 0 ? (
        <Text size="sm" c="dimmed">
          {tokens.isLoading ? t('common:loading') : t('tokens.none')}
        </Text>
      ) : (
        <ApiTokenTable tokens={list} onRevoke={revoke} />
      )}
      <Stack gap={4} mt="md">
        <PublicApiInfo status={publicApi.data} />
        <Text size="sm" mb={4}>
          {t('tokens.exampleReadOnly')}
        </Text>
      </Stack>
      <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{`curl -H "Authorization: Bearer <token>" "${exampleUrl}"`}</Code>
      {mcp.data?.enabled && (
        <Text size="sm" mt="sm">
          {t('tokens.mcpAvailable')}
        </Text>
      )}

      <CreateTokenModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(tk) => {
          setCreateOpen(false);
          setCreated(tk);
          qc.invalidateQueries({ queryKey: ['me', 'tokens'] });
        }}
      />
      <Modal opened={!!created} onClose={() => setCreated(null)} title={t('tokens.createdTitle')} size="lg" fullScreen={isMobile} closeOnClickOutside={false}>
        {created && (
          <Stack>
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />}>
              {t('tokens.copyNow')}
            </Alert>
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Code block style={{ flex: 1, minWidth: 0, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                {created.token}
              </Code>
              <CopyButton value={created.token}>
                {({ copied, copy }) => (
                  <Button
                    variant={copied ? 'light' : 'filled'}
                    color={copied ? 'green' : undefined}
                    leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                    onClick={copy}
                  >
                    {copied ? t('common:copied') : t('common:copy')}
                  </Button>
                )}
              </CopyButton>
            </Group>
            {created.scope === 'mcp' ? (
              mcp.data && (
                <div>
                  <Text size="sm" mb={4}>
                    {mcp.data.enabled ? t('tokens.mcpUseLike') : t('tokens.mcpServerOff')}
                  </Text>
                  <McpClientConfig status={mcp.data} token={created.token} />
                </div>
              )
            ) : (
              <div>
                <Text size="sm" mb={4}>
                  {t('tokens.useLike')}
                </Text>
                <Code
                  block
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                >{`curl -H "Authorization: Bearer ${created.token}" "${exampleUrl}"`}</Code>
              </div>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setCreated(null)}>
                {t('tokens.done')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Card>
  );
}

function CreateTokenModal({ opened, onClose, onCreated }: { opened: boolean; onClose: () => void; onCreated: (t: ApiTokenCreated) => void }) {
  const { t } = useTranslation(['profile', 'common']);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiTokenScope>('read');
  const [days, setDays] = useState<number | ''>(90);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (opened) {
      setName('');
      setScope('read');
      setDays(90);
    }
  }, [opened]);
  const submit = async () => {
    setBusy(true);
    try {
      const token = await post<ApiTokenCreated>('/me/tokens', { name: name.trim(), scope, ...(days ? { expiresInDays: days } : {}) });
      onCreated(token);
    } catch (e) {
      notifyError(e, t('tokens.notCreated'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title={t('tokens.newTitle')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack>
          <TextInput
            label={t('common:name')}
            description={t('tokens.nameHint')}
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-autofocus
          />
          <div>
            <Text size="sm" fw={500} mb={4}>
              {t('tokens.access')}
            </Text>
            <SegmentedControl
              fullWidth
              value={scope}
              onChange={(v) => setScope(v as ApiTokenScope)}
              data={[
                { value: 'read', label: t('tokens.readOnly') },
                { value: 'full', label: t('tokens.fullAccess') },
                { value: 'mcp', label: t('tokens.mcpClient') },
              ]}
            />
            <Hint>{scope === 'read' ? t('tokens.readHint') : scope === 'mcp' ? t('tokens.mcpHint') : t('tokens.fullHint')}</Hint>
          </div>
          <NumberInput
            label={t('tokens.expiresAfter')}
            description={t('tokens.expiresHint')}
            min={1}
            max={3650}
            value={days}
            onChange={(v) => setDays(typeof v === 'number' ? v : '')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              {t('tokens.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
