import { useEffect, useMemo, useState } from 'react';
import { Alert, Anchor, Badge, Button, Card, Checkbox, Group, Modal, Select, SimpleGrid, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconArrowBackUp } from '@tabler/icons-react';
import { DAILY_SUMMARY_SECTIONS, type DailySummaryContent, type DailySummaryPrefs, type DailySummaryState } from '@sm/shared';
import { del, get, notifyError, notifyOk, put } from '../../api';
import { fmtRelative } from '../../format';

/** Where the daily summary settings come from (#136): the person's own, a team default or the instance default. */
export function SourceBadge({ source }: { source: DailySummaryState['source'] }) {
  const { t } = useTranslation('profile');
  return (
    <Badge variant="light" color={source.from === 'own' ? 'blue' : 'gray'} data-testid="daily-summary-source">
      {source.from === 'team' ? t('dailySummary.source.team', { team: source.team }) : t(`dailySummary.source.${source.from}`)}
    </Badge>
  );
}

/** The fields of a daily summary: a person's own (Profile) or a team's default for its members (team settings). */
export function DailySummaryFields({
  d,
  set,
  zoneList,
  emailBlockedReason,
}: {
  d: DailySummaryPrefs;
  set: (patch: Partial<DailySummaryPrefs>) => void;
  zoneList: string[];
  emailBlockedReason?: DailySummaryState['emailBlockedReason'];
}) {
  const { t } = useTranslation('profile');
  return (
    <>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <TextInput type="time" label={t('dailySummary.time')} value={d.time} onChange={(e) => set({ time: e.currentTarget.value || d.time })} />
        <Select
          label={t('dailySummary.timeZone')}
          data={zoneList.length ? zoneList : [d.timeZone]}
          value={d.timeZone}
          onChange={(v) => v && set({ timeZone: v })}
          searchable
          allowDeselect={false}
        />
        <Select
          label={t('dailySummary.days')}
          data={(['weekdays', 'everyday'] as const).map((x) => ({ value: x, label: t(`dailySummary.daysOptions.${x}`) }))}
          value={d.days}
          onChange={(v) => v && set({ days: v as DailySummaryPrefs['days'] })}
          allowDeselect={false}
        />
      </SimpleGrid>
      <Select
        label={t('dailySummary.channel')}
        maw={320}
        data={(['inApp', 'inAppEmail'] as const).map((x) => ({ value: x, label: t(`dailySummary.channelOptions.${x}`) }))}
        value={d.channel}
        onChange={(v) => v && set({ channel: v as DailySummaryPrefs['channel'] })}
        allowDeselect={false}
      />
      {d.channel === 'inAppEmail' && emailBlockedReason && (
        <Text size="xs" c="dimmed">
          {t(`dailySummary.emailBlocked.${emailBlockedReason}`)}
        </Text>
      )}
      <Checkbox.Group label={t('dailySummary.sections')} value={d.sections} onChange={(v) => set({ sections: v as DailySummaryPrefs['sections'] })}>
        <SimpleGrid cols={{ base: 1, sm: 2 }} mt={6} spacing={6}>
          {DAILY_SUMMARY_SECTIONS.map((s) => (
            <Checkbox key={s} value={s} label={t(`dailySummary.sectionNames.${s}`)} />
          ))}
        </SimpleGrid>
      </Checkbox.Group>
      <Switch label={t('dailySummary.skipEmpty')} checked={d.skipEmpty} onChange={(e) => set({ skipEmpty: e.currentTarget.checked })} />
    </>
  );
}

export const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const zones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
};

/** Profile → Daily summary: opt in, time and days, channel, sections, preview. */
export function DailySummaryCard() {
  const { t } = useTranslation('profile');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['daily-summary'], queryFn: () => get<DailySummaryState>('/me/daily-summary') });
  const [d, setD] = useState<DailySummaryPrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<(DailySummaryContent & { title: string }) | null>(null);
  const zoneList = useMemo(() => {
    const list = zones();
    return d && !list.includes(d.timeZone) ? [d.timeZone, ...list] : list;
  }, [d]);
  useEffect(() => {
    if (q.data)
      setD(q.data.prefs.enabled ? q.data.prefs : { ...q.data.prefs, timeZone: q.data.prefs.timeZone === 'UTC' ? browserZone() : q.data.prefs.timeZone });
  }, [q.data]);
  if (!q.data || !d) return null;
  const st = q.data;
  const set = (patch: Partial<DailySummaryPrefs>) => setD({ ...d, ...patch });
  const save = async () => {
    setBusy(true);
    try {
      qc.setQueryData(['daily-summary'], await put<DailySummaryState>('/me/daily-summary', d));
      notifyOk(t('dailySummary.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    setBusy(true);
    try {
      qc.setQueryData(['daily-summary'], await del<DailySummaryState>('/me/daily-summary'));
      notifyOk(t('dailySummary.resetDone'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const showPreview = async () => {
    try {
      setPreview(await get<DailySummaryContent & { title: string }>('/me/daily-summary/preview'));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="xs">
        <Title order={5}>{t('dailySummary.title')}</Title>
        <SourceBadge source={st.source} />
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('dailySummary.intro')}
      </Text>
      <Stack gap="sm">
        {!st.allowed && (
          <Alert color="gray" variant="light">
            {t('dailySummary.notAllowed')}
          </Alert>
        )}
        <Switch
          label={t('dailySummary.enabled')}
          checked={d.enabled}
          disabled={!st.allowed && !d.enabled}
          onChange={(e) => set({ enabled: e.currentTarget.checked })}
        />
        {d.enabled && <DailySummaryFields d={d} set={set} zoneList={zoneList} emailBlockedReason={st.emailBlockedReason} />}
        <Group justify="space-between" wrap="wrap">
          <Text size="xs" c="dimmed">
            {st.lastSentAt ? t('dailySummary.lastSent', { when: fmtRelative(st.lastSentAt) }) : ''}
          </Text>
          <Group gap="xs">
            {st.source.from === 'own' && (
              <Button size="xs" variant="subtle" leftSection={<IconArrowBackUp size={14} />} onClick={reset} loading={busy}>
                {t('dailySummary.backToDefault')}
              </Button>
            )}
            <Button size="xs" variant="default" onClick={showPreview}>
              {t('dailySummary.preview')}
            </Button>
            <Button size="xs" onClick={save} loading={busy} disabled={d.enabled && !d.sections.length}>
              {t('dailySummary.save')}
            </Button>
          </Group>
        </Group>
      </Stack>
      {preview && (
        <Modal opened onClose={() => setPreview(null)} title={t('dailySummary.previewTitle', { title: preview.title })} size="lg">
          {preview.empty ? (
            <Text size="sm" c="dimmed">
              {t('dailySummary.previewEmpty')}
            </Text>
          ) : (
            <Stack gap="sm" data-testid="daily-summary-preview">
              {preview.sections
                .filter((s) => s.count > 0)
                .map((s) => (
                  <div key={s.id}>
                    <Text fw={600} size="sm">
                      {t(`dailySummary.sectionNames.${s.id}`)} ({s.count})
                    </Text>
                    <Stack gap={2} mt={2}>
                      {s.items.map((i, n) => (
                        <div key={n}>
                          {i.link ? (
                            <Anchor component={Link} to={i.link} size="sm" onClick={() => setPreview(null)}>
                              {i.title}
                            </Anchor>
                          ) : (
                            <Text size="sm">{i.title}</Text>
                          )}
                          {i.detail && (
                            <Text size="xs" c="dimmed">
                              {i.detail}
                            </Text>
                          )}
                        </div>
                      ))}
                      {s.more > 0 && (
                        <Text size="xs" c="dimmed">
                          {t('dailySummary.more', { count: s.more })}
                        </Text>
                      )}
                    </Stack>
                  </div>
                ))}
            </Stack>
          )}
        </Modal>
      )}
    </Card>
  );
}
