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
import type { ApiToken, ApiTokenCreated, ApiTokenScope, UserInfo } from '@sm/shared';
import { del, getOptional, notifyError, notifyOk, patch, post } from '../api';
import { useMe } from '../auth';
import { Hint, PageHeader } from '../components/common';
import { ApiTokenTable } from '../components/ApiTokenTable';
import { PublicApiInfo, usePublicApi } from '../components/PublicApiInfo';
import { ChangePasswordForm } from './Auth';
import {
  browserNotificationsSupported,
  getBrowserNotifyOptIn,
  setBrowserNotifyOptIn,
  showBrowserNotification,
} from '../components/notifications/browserNotify';

export function ProfilePage() {
  const { me } = useMe();
  if (!me) return null;
  const u = me.user;
  const local = !u.authSource || u.authSource === 'local';
  return (
    <>
      <PageHeader title="Profile" description="Your account, notifications and API tokens." />
      <Stack maw={760}>
        <AccountCard user={u} local={local} />
        <NotificationsCard user={u} />
        {local && <PasswordCard />}
        <TokensCard />
      </Stack>
    </>
  );
}

function AccountCard({ user, local }: { user: UserInfo; local: boolean }) {
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
      notifyOk('Profile saved');
    } catch (e) {
      notifyError(e, 'Not saved');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card withBorder>
      <Title order={5} mb="sm">
        Account
      </Title>
      <Stack gap="sm">
        <Group gap="xs">
          <Text size="sm" c="dimmed">
            Username
          </Text>
          <Code>{user.username}</Code>
          {user.roles.map((r) => (
            <Badge key={r} size="sm" variant="light">
              {r}
            </Badge>
          ))}
          {user.teams.map((t) => (
            <Badge key={t} size="sm" variant="outline" color="gray">
              {t}
            </Badge>
          ))}
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Display name" required disabled={!local} value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} />
          <TextInput label="E-mail" type="email" disabled={!local} value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
        </SimpleGrid>
        {!local && <Hint>Name and e-mail come from your single sign-on provider and are updated when you sign in.</Hint>}
        {local && (
          <Group>
            <Button onClick={save} loading={busy} disabled={!dirty || !displayName.trim()}>
              Save
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

function NotificationsCard({ user }: { user: UserInfo }) {
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
      notifyError(e, 'Not saved');
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
        Notifications
      </Title>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          The bell in the header always shows your notifications. Administrators choose which events are sent by which channel.
        </Text>
        <Switch
          label="E-mail notifications"
          description={user.email ? `Sent to ${user.email} when e-mail is set up on this server.` : 'Add an e-mail address to your account first.'}
          checked={user.emailNotifications && !!user.email}
          disabled={emailBusy || !user.email}
          onChange={(e) => setEmailNotifications(e.currentTarget.checked)}
        />
        <Switch
          label="Browser notifications"
          description={
            permission === 'unsupported'
              ? 'This browser does not support notifications.'
              : permission === 'denied'
                ? 'Blocked by your browser. Allow notifications for this site in the browser settings, then try again.'
                : 'Show a system notification on this device while the app is open in a tab.'
          }
          checked={browserOn}
          disabled={permission === 'unsupported' || permission === 'denied'}
          onChange={(e) => toggleBrowser(e.currentTarget.checked)}
        />
        {browserOn && (
          <Group>
            <Button size="xs" variant="light" onClick={() => showBrowserNotification('Test notification', 'Browser notifications work.', 'sm-test')}>
              Show a test notification
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

function PasswordCard() {
  const [open, setOpen] = useState(false);
  return (
    <Card withBorder>
      <Group justify="space-between" gap="sm">
        <div>
          <Title order={5}>Password</Title>
          <Text size="sm" c="dimmed">
            Change the password you use to sign in.
          </Text>
        </div>
        <Button variant="default" leftSection={<IconKey size={16} />} onClick={() => setOpen(true)}>
          Change password
        </Button>
      </Group>
      <Modal opened={open} onClose={() => setOpen(false)} title="Change password">
        <ChangePasswordForm
          onDone={() => {
            setOpen(false);
            notifyOk('Password changed');
          }}
        />
      </Modal>
    </Card>
  );
}

function TokensCard() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['me', 'tokens'], queryFn: () => getOptional<ApiToken[] | null>('/me/tokens', null) });
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const isMobile = useMediaQuery('(max-width: 48em)');

  const revoke = async (t: ApiToken) => {
    if (!confirm(`Revoke the token “${t.name}”? Scripts using it stop working immediately.`)) return;
    try {
      await del(`/me/tokens/${encodeURIComponent(t.id)}`);
      notifyOk('Token revoked');
      qc.invalidateQueries({ queryKey: ['me', 'tokens'] });
    } catch (e) {
      notifyError(e);
    }
  };

  const list = tokens.data ?? [];
  const host = typeof window !== 'undefined' ? window.location.origin : 'http://<host>';
  const publicApi = usePublicApi();
  // The versioned REST API is the stable interface for scripts; fall back to the internal API when it is off.
  const exampleUrl = `${host}${publicApi.data?.enabled ? `${publicApi.data.basePath}/runs?limit=10` : '/api/runs'}`;
  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm" gap="sm">
        <div>
          <Title order={5}>API tokens</Title>
          <Text size="sm" c="dimmed">
            For scripts and other tools. A token acts with your rights.
          </Text>
        </div>
        {tokens.data !== null && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
            New token
          </Button>
        )}
      </Group>
      {tokens.data === null ? (
        <Text size="sm" c="dimmed">
          API tokens are not available on this server.
        </Text>
      ) : list.length === 0 ? (
        <Text size="sm" c="dimmed">
          {tokens.isLoading ? 'Loading…' : 'No tokens yet.'}
        </Text>
      ) : (
        <ApiTokenTable tokens={list} onRevoke={revoke} />
      )}
      <Stack gap={4} mt="md">
        <PublicApiInfo status={publicApi.data} />
        <Text size="sm" mb={4}>
          Example (a read-only token is enough):
        </Text>
      </Stack>
      <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{`curl -H "Authorization: Bearer <token>" "${exampleUrl}"`}</Code>

      <CreateTokenModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(t) => {
          setCreateOpen(false);
          setCreated(t);
          qc.invalidateQueries({ queryKey: ['me', 'tokens'] });
        }}
      />
      <Modal opened={!!created} onClose={() => setCreated(null)} title="Token created" size="lg" fullScreen={isMobile} closeOnClickOutside={false}>
        {created && (
          <Stack>
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />}>
              Copy the token now. It is shown only once and cannot be recovered.
            </Alert>
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Code block style={{ flex: 1, minWidth: 0, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                {created.token}
              </Code>
              <CopyButton value={created.token}>
                {({ copied, copy }) => (
                  <Button variant={copied ? 'light' : 'filled'} color={copied ? 'green' : undefined} leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <div>
              <Text size="sm" mb={4}>
                Use it like this:
              </Text>
              <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{`curl -H "Authorization: Bearer ${created.token}" "${exampleUrl}"`}</Code>
            </div>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setCreated(null)}>
                Done
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Card>
  );
}

function CreateTokenModal({ opened, onClose, onCreated }: { opened: boolean; onClose: () => void; onCreated: (t: ApiTokenCreated) => void }) {
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
      const t = await post<ApiTokenCreated>('/me/tokens', { name: name.trim(), scope, ...(days ? { expiresInDays: days } : {}) });
      onCreated(t);
    } catch (e) {
      notifyError(e, 'Token not created');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title="New API token">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack>
          <TextInput label="Name" description="What the token is for, e.g. “Nightly report script”" required value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
          <div>
            <Text size="sm" fw={500} mb={4}>
              Access
            </Text>
            <SegmentedControl
              fullWidth
              value={scope}
              onChange={(v) => setScope(v as ApiTokenScope)}
              data={[
                { value: 'read', label: 'Read only' },
                { value: 'full', label: 'Full access' },
              ]}
            />
            <Hint>{scope === 'read' ? 'Can only read data (GET requests).' : 'Can do everything you can do, including starting runs and changing data.'}</Hint>
          </div>
          <NumberInput
            label="Expires after (days)"
            description="Leave empty for a token that never expires"
            min={1}
            max={3650}
            value={days}
            onChange={(v) => setDays(typeof v === 'number' ? v : '')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              Create token
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
