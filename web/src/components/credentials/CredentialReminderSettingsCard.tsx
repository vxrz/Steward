import { useEffect, useState } from 'react';
import { Button, Card, Group, NumberInput, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CredentialReminderSettings } from '@sm/shared';
import { getOptional, notifyError, notifyOk, put } from '../../api';
import { useSaveSection } from '../settings/SaveBar';

/** Settings → Credential reminders (administrators): default reminder days and the "due soon" window. */
export function CredentialReminderSettingsCard() {
  const { t } = useTranslation('credentials');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['credential-settings'], queryFn: () => getOptional<CredentialReminderSettings | null>('/credentials/settings', null) });
  const [d, setD] = useState<CredentialReminderSettings | null>(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const fromServer = (x: CredentialReminderSettings) => {
    setD(x);
    setDays(x.daysBefore.join(', '));
  };
  useEffect(() => {
    if (q.data) fromServer(q.data);
  }, [q.data]);
  const parsed = days
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  const valid = parsed.every((x) => Number.isInteger(x) && x >= 0 && x <= 365) && parsed.length <= 10;
  const dirty = !!d && !!q.data && (JSON.stringify(d) !== JSON.stringify(q.data) || days !== q.data.daysBefore.join(', '));
  const save = async () => {
    // the field already says what is wrong; the button stays enabled (U16)
    if (!d || !valid) return;
    setBusy(true);
    try {
      const next = await put<CredentialReminderSettings>('/credentials/settings', { ...d, daysBefore: parsed });
      qc.setQueryData(['credential-settings'], next);
      notifyOk(t('settings.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const inBar = useSaveSection('credentialReminders', { dirty, valid, save, reset: () => q.data && fromServer(q.data) });
  if (!d) return null;
  return (
    <Card withBorder>
      <Title order={5} mb="xs">
        {t('settings.title')}
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        {t('settings.description')}
      </Text>
      <Stack gap="xs">
        <Switch label={t('settings.enabled')} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
        <TextInput
          label={t('settings.daysBefore')}
          description={t('settings.daysBeforeHint')}
          value={days}
          onChange={(e) => setDays(e.currentTarget.value)}
          error={valid ? undefined : t('settings.daysInvalid')}
        />
        <Group grow align="flex-start">
          <NumberInput
            label={t('settings.overdueEvery')}
            description={t('settings.overdueEveryHint')}
            min={0}
            max={365}
            value={d.overdueEveryDays}
            onChange={(v) => setD({ ...d, overdueEveryDays: typeof v === 'number' ? v : 0 })}
          />
          <NumberInput
            label={t('settings.dueSoonDays')}
            description={t('settings.dueSoonHint')}
            min={1}
            max={365}
            value={d.dueSoonDays}
            onChange={(v) => setD({ ...d, dueSoonDays: typeof v === 'number' ? v : 30 })}
          />
        </Group>
        {!inBar && (
          <Group justify="flex-end">
            <Button size="xs" onClick={save} loading={busy}>
              {t('settings.save')}
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
