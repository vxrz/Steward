import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Group, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconBrandTeams, IconCircleCheck } from '@tabler/icons-react';
import { NOTIFICATION_EVENT_INFO, NOTIFICATION_EVENTS, type NotificationEvent, type TeamsPersonalState } from '@sm/shared';
import { getOptional, notifyError, notifyOk, put } from '../../api';
import { fmtDate } from '../../format';

const KEY = ['teams-personal'];

/**
 * Profile → Teams (personal) (0.15.0, ADR 0025): the events that come to the person's chat with the Teams bot instead of
 * by e-mail. Hidden while the bot is off (or its module); nothing is chosen by default.
 */
export function TeamsPersonalCard() {
  const { t } = useTranslation(['notifications', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => getOptional<TeamsPersonalState | null>('/me/teams-personal', null) });
  const [chosen, setChosen] = useState<NotificationEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setChosen(q.data.events);
  }, [q.data]);
  if (!q.data?.available || !chosen) return null;
  const st = q.data;
  // what can be chosen now, and what was chosen before but is no longer routed to e-mail (it can be taken off)
  const list = NOTIFICATION_EVENTS.filter((e) => st.offered.includes(e) || st.events.includes(e));
  const dirty = JSON.stringify([...chosen].sort()) !== JSON.stringify([...st.events].sort());
  const save = async () => {
    setBusy(true);
    try {
      qc.setQueryData(KEY, await put<TeamsPersonalState>('/me/teams-personal', { events: chosen }));
      notifyOk(t('personal.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const label = (e: NotificationEvent) => t(`events.${e}.label` as 'events.run.failed.label', { defaultValue: e });
  const info = (e: NotificationEvent) => t(`events.${e}.info` as 'events.run.failed.info', { defaultValue: NOTIFICATION_EVENT_INFO[e] });
  return (
    <Card withBorder data-testid="teams-personal-card">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="xs">
        <Group gap={8} wrap="nowrap">
          <IconBrandTeams size={18} aria-hidden />
          <Title order={5}>{t('personal.title')}</Title>
        </Group>
        <Badge variant="light" color="grape">
          {t('bot.preview')}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('personal.intro')}
      </Text>
      <Stack gap="sm">
        {st.connected ? (
          <Group gap={6} wrap="nowrap" data-testid="teams-personal-connected">
            <IconCircleCheck size={16} color="var(--mantine-color-green-7)" aria-hidden />
            <Text size="sm">{t('personal.connected', { since: fmtDate(st.connectedSince) })}</Text>
          </Group>
        ) : (
          <Alert color="gray" variant="light" data-testid="teams-personal-not-connected">
            {t(st.notLinked ? 'personal.notLinked' : 'personal.notConnected')}
          </Alert>
        )}
        {list.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('personal.nothingOffered')}
          </Text>
        ) : (
          <Checkbox.Group
            label={t('personal.events')}
            description={t('personal.eventsHint')}
            value={chosen}
            onChange={(v) => setChosen(v as NotificationEvent[])}
          >
            <Stack gap={6} mt="xs">
              {list.map((e) => (
                <Checkbox
                  key={e}
                  value={e}
                  label={label(e)}
                  description={st.offered.includes(e) ? info(e) : t('personal.notRouted')}
                  data-testid={`teams-personal-${e}`}
                />
              ))}
            </Stack>
          </Checkbox.Group>
        )}
        <Text size="xs" c="dimmed">
          {t('personal.fallback')}
        </Text>
        <Group justify="flex-end">
          <Button size="xs" loading={busy} disabled={!dirty} onClick={() => void save()}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
