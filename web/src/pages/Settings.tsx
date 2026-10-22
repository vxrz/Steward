import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Card, Code, Group, NumberInput, Stack, Switch, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Settings } from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../api';
import { PageHeader } from '../components/common';
import { useMe } from '../auth';

export function SettingsPage({ browserAvailable }: { browserAvailable: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/settings') });
  const { caps } = useMe();
  const readOnly = !caps.manageSettings;
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data) setS(settings.data);
  }, [settings.data]);
  if (!s) return null;
  return (
    <>
      <PageHeader title="Settings" description={readOnly ? 'Only administrators can change settings.' : undefined} />
      <Stack maw={640}>
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
        <Card withBorder>
          <Title order={5} mb="xs">
            Unattended operation
          </Title>
          <Text size="sm">
            Schedules only run while the vault is unlocked; scheduled runs use the rights of the person who owns the schedule. To start unlocked after a reboot (e.g. as a Windows service), set the environment variable{' '}
            <Code>SM_MASTER_PASSPHRASE</Code>. To let colleagues use the tool over the network, start it with <Code>SM_HOST=0.0.0.0</Code>,{' '}
            <Code>SM_ALLOWED_HOSTS=&lt;hostname&gt;</Code> and HTTPS (<Code>SM_TLS_CERT</Code>/<Code>SM_TLS_KEY</Code>). Keep the data directory (<Code>data/</Code>) backed up – it contains the database, encrypted credentials, evidence files and the
            audit log. See the <Anchor href="https://github.com/vxrz/service-manager#readme" target="_blank">README</Anchor> for details.
          </Text>
        </Card>
      </Stack>
    </>
  );
}
