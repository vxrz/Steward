import { useEffect, useState } from 'react';
import { ActionIcon, Button, Card, Checkbox, Group, NumberInput, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { TICKET_SOURCE_KEY_RE, type TicketSettings } from '@sm/shared';
import { notifyError, notifyOk, put } from '../../api';
import { useTicketSettings } from './common';

/** Settings → Ticket references (administrators): sources and the default reminder. */
export function TicketSettingsCard() {
  const { t } = useTranslation('tickets');
  const qc = useQueryClient();
  const q = useTicketSettings();
  const [d, setD] = useState<TicketSettings | null>(null);
  const [busy, setBusy] = useState(false);
  // the stored names (the lists show the built-in ones in the UI language until they are renamed here)
  useEffect(() => {
    if (q.data) setD(q.data);
  }, [q.data]);
  if (!d) return null;
  const setSource = (i: number, patch: Partial<TicketSettings['sources'][number]>) =>
    setD({ ...d, sources: d.sources.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const valid = d.sources.length > 0 && d.sources.every((s) => TICKET_SOURCE_KEY_RE.test(s.key) && s.label.trim());
  const save = async () => {
    setBusy(true);
    try {
      const next = await put<TicketSettings>('/ticket-references/settings', { ...d, sources: d.sources.map((s) => ({ ...s, label: s.label.trim() })) });
      qc.setQueryData(['ticket-settings'], next);
      notifyOk(t('settings.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card withBorder>
      <Title order={5} mb="xs">
        {t('settings.title')}
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        {t('settings.description')}
      </Text>
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          {t('settings.sources')}
        </Text>
        {d.sources.map((s, i) => (
          <Group key={i} gap="xs" align="flex-end" wrap="wrap">
            <TextInput
              size="xs"
              label={t('settings.key')}
              value={s.key}
              onChange={(e) => setSource(i, { key: e.currentTarget.value.toLowerCase() })}
              error={TICKET_SOURCE_KEY_RE.test(s.key) ? undefined : true}
              classNames={{ input: 'mono' }}
              style={{ flex: '1 1 140px' }}
            />
            <TextInput
              size="xs"
              label={t('settings.label')}
              value={s.label}
              onChange={(e) => setSource(i, { label: e.currentTarget.value })}
              style={{ flex: '2 1 180px' }}
              maxLength={80}
            />
            <Checkbox size="xs" label={t('settings.vendor')} checked={s.vendor} onChange={(e) => setSource(i, { vendor: e.currentTarget.checked })} mb={6} />
            <ActionIcon
              variant="subtle"
              color="red"
              mb={2}
              aria-label={t('settings.removeSource', { name: s.label || s.key })}
              onClick={() => setD({ ...d, sources: d.sources.filter((_, j) => j !== i) })}
              disabled={d.sources.length <= 1}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        ))}
        <Button
          size="xs"
          variant="default"
          w="fit-content"
          leftSection={<IconPlus size={14} />}
          onClick={() => setD({ ...d, sources: [...d.sources, { key: '', label: '', vendor: false }] })}
          disabled={d.sources.length >= 30}
        >
          {t('settings.addSource')}
        </Button>
        <Switch
          mt="xs"
          label={t('settings.reminderDefault')}
          description={t('settings.reminderDefaultHint')}
          checked={d.reminderDays !== null}
          onChange={(e) => setD({ ...d, reminderDays: e.currentTarget.checked ? 7 : null })}
        />
        {d.reminderDays !== null && (
          <NumberInput
            label={t('settings.reminderDays')}
            min={1}
            max={365}
            maw={220}
            value={d.reminderDays}
            onChange={(v) => setD({ ...d, reminderDays: typeof v === 'number' ? v : 7 })}
          />
        )}
        <Group justify="flex-end">
          <Button size="xs" onClick={save} loading={busy} disabled={!valid}>
            {t('settings.save')}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
