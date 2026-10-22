import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Card, Checkbox, Divider, Group, NumberInput, PasswordInput, SimpleGrid, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDeviceFloppy, IconSend } from '@tabler/icons-react';
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

const CHANNELS: { value: NotificationChannel; label: string }[] = [
  { value: 'inApp', label: 'In-app' },
  { value: 'email', label: 'E-mail' },
  { value: 'teams', label: 'Teams' },
  { value: 'webhook', label: 'Webhook' },
];

/** Write-only secret: undefined = keep the stored value, '' = remove it, text = replace it. */
type Secret = string | undefined;

interface Draft {
  email: Omit<NotificationSettings['email'], 'hasPassword'>;
  teamsEnabled: boolean;
  webhookEnabled: boolean;
  routes: Record<NotificationEvent, NotificationChannel[]>;
  baseUrl: string;
}

const toDraft = (s: NotificationSettings): Draft => ({
  email: { enabled: s.email.enabled, host: s.email.host ?? '', port: s.email.port ?? 587, secure: s.email.secure, user: s.email.user ?? '', from: s.email.from ?? '' },
  teamsEnabled: s.teams.enabled,
  webhookEnabled: s.webhook.enabled,
  routes: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, s.routes?.[e] ?? ['inApp']])) as Draft['routes'],
  baseUrl: s.baseUrl ?? '',
});

function SecretInput({ label, description, stored, value, onChange, mono }: { label: string; description?: string; stored: boolean; value: Secret; onChange: (v: Secret) => void; mono?: boolean }) {
  const removing = stored && value === '';
  return (
    <div>
      <PasswordInput
        label={label}
        description={description}
        classNames={mono ? { input: 'mono' } : undefined}
        placeholder={stored ? 'unchanged' : 'not set'}
        value={value ?? ''}
        onChange={(e) => onChange(e.currentTarget.value === '' && !stored ? undefined : e.currentTarget.value)}
        autoComplete="new-password"
      />
      {stored && (
        <Group gap={6} mt={2}>
          {removing ? (
            <>
              <Text size="xs" c="orange">
                Will be removed when you save.
              </Text>
              <Anchor size="xs" component="button" type="button" onClick={() => onChange(undefined)}>
                Keep
              </Anchor>
            </>
          ) : (
            <Anchor size="xs" component="button" type="button" c="red" onClick={() => onChange('')}>
              Remove stored value
            </Anchor>
          )}
        </Group>
      )}
    </div>
  );
}

function TestButton({ channel, to, disabled }: { channel: NotificationChannel; to?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await post<{ ok: boolean; error?: string }>('/settings/notifications/test', { channel, ...(to ? { to } : {}) }));
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap={4}>
      <Group>
        <Button size="xs" variant="light" leftSection={<IconSend size={14} />} loading={busy} disabled={disabled} onClick={run}>
          Send test
        </Button>
      </Group>
      {result && (
        <Text size="xs" c={result.ok ? 'green' : 'red'} style={{ wordBreak: 'break-word' }}>
          {result.ok ? 'Test sent.' : `Failed: ${result.error ?? 'unknown error'}`}
        </Text>
      )}
    </Stack>
  );
}

/** Admin settings for e-mail, Teams, webhook and per-event routing. Hidden while the server has no endpoint for it. */
export function NotificationSettingsCard() {
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
    };
    setBusy(true);
    try {
      const saved = await put<NotificationSettings>('/settings/notifications', body);
      if (saved && typeof saved === 'object' && 'email' in saved) qc.setQueryData(['settings', 'notifications'], saved);
      else await qc.invalidateQueries({ queryKey: ['settings', 'notifications'] });
      notifyOk('Notification settings saved');
    } catch (e) {
      notifyError(e, 'Not saved');
    } finally {
      setBusy(false);
    }
  };

  const unsaved = dirty ? 'You have unsaved changes. Tests use the saved settings, so save first.' : undefined;

  return (
    <Card withBorder>
      <Title order={5}>Notifications</Title>
      <Text size="sm" c="dimmed" mb="sm">
        How people are told about failed runs, waiting decisions and more. In-app notifications appear under the bell.
      </Text>
      <Stack>
        <TextInput
          label="Base URL for links"
          description="Used for links in e-mails and Teams messages, e.g. https://service-manager.example.com"
          classNames={{ input: 'mono' }}
          placeholder={typeof window !== 'undefined' ? window.location.origin : ''}
          value={d.baseUrl}
          onChange={(e) => setD({ ...d, baseUrl: e.currentTarget.value })}
        />

        <Divider label="E-mail (SMTP)" labelPosition="left" />
        <Switch label="Send e-mails" checked={d.email.enabled} onChange={(e) => setEmail({ enabled: e.currentTarget.checked })} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="SMTP host" classNames={{ input: 'mono' }} placeholder="smtp.example.com" value={d.email.host} onChange={(e) => setEmail({ host: e.currentTarget.value })} />
          <NumberInput label="Port" min={1} max={65535} value={d.email.port} onChange={(v) => setEmail({ port: typeof v === 'number' ? v : 587 })} />
          <TextInput label="User" value={d.email.user ?? ''} onChange={(e) => setEmail({ user: e.currentTarget.value })} autoComplete="off" />
          <SecretInput label="Password" stored={stored.email.hasPassword} value={smtpPassword} onChange={setSmtpPassword} />
          <TextInput label="From" placeholder="Service Manager <noreply@example.com>" value={d.email.from} onChange={(e) => setEmail({ from: e.currentTarget.value })} />
          <Switch
            label="TLS from the start"
            description="On for port 465. Off uses STARTTLS when the server offers it."
            checked={d.email.secure}
            onChange={(e) => setEmail({ secure: e.currentTarget.checked })}
            mt={{ sm: 'lg' }}
          />
        </SimpleGrid>
        <Group align="flex-end" gap="sm">
          <TextInput label="Test recipient" size="xs" w={260} maw="100%" value={testTo} onChange={(e) => setTestTo(e.currentTarget.value)} />
          <TestButton channel="email" to={testTo.trim() || undefined} disabled={!!dirty || !stored.email.enabled} />
        </Group>

        <Divider label="Microsoft Teams" labelPosition="left" />
        <Switch label="Post to Teams" checked={d.teamsEnabled} onChange={(e) => setD({ ...d, teamsEnabled: e.currentTarget.checked })} />
        <SecretInput
          label="Webhook URL"
          description="Incoming webhook or Workflows “Post to a channel when a webhook request is received” URL"
          mono
          stored={stored.teams.hasWebhookUrl}
          value={teamsUrl}
          onChange={setTeamsUrl}
        />
        <TestButton channel="teams" disabled={!!dirty || !stored.teams.enabled || !stored.teams.hasWebhookUrl} />

        <Divider label="Webhook" labelPosition="left" />
        <Switch label="Send to a webhook" checked={d.webhookEnabled} onChange={(e) => setD({ ...d, webhookEnabled: e.currentTarget.checked })} />
        <SecretInput
          label="Webhook URL"
          description="Receives a JSON POST per notification (e.g. ticketing, Slack, automation)"
          mono
          stored={stored.webhook.hasUrl}
          value={webhookUrl}
          onChange={setWebhookUrl}
        />
        <TestButton channel="webhook" disabled={!!dirty || !stored.webhook.enabled || !stored.webhook.hasUrl} />

        <Divider label="Which events go where" labelPosition="left" />
        <Table.ScrollContainer minWidth={520}>
          <Table verticalSpacing={6} fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Event</Table.Th>
                {CHANNELS.map((c) => (
                  <Table.Th key={c.value} ta="center" w={80}>
                    {c.label}
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
                      {NOTIFICATION_EVENT_INFO[ev]}
                    </Text>
                  </Table.Td>
                  {CHANNELS.map((c) => (
                    <Table.Td key={c.value}>
                      <Checkbox
                        mx="auto"
                        w="fit-content"
                        aria-label={`${ev}: ${c.label}`}
                        checked={(d.routes[ev] ?? []).includes(c.value)}
                        onChange={(e) => toggleRoute(ev, c.value, e.currentTarget.checked)}
                      />
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Hint>Each event goes to the people it concerns. E-mails are only sent to users who turned e-mail notifications on in their profile.</Hint>
        <Group justify="flex-end" gap="sm">
          <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save} loading={busy} disabled={!dirty}>
            Save notification settings
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
