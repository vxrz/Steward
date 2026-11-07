import { ActionIcon, Box, Button, Chip, Group, Select, SimpleGrid, Stack, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DECISION_RHYTHMS,
  DEFAULT_QUIET_HOURS,
  DIGEST_GROUPS,
  DIGEST_RHYTHMS,
  WEEKDAYS,
  wallQuiet,
  type DigestChoice,
  type DigestGroup,
  type DigestPrefs,
  type QuietHours,
  type Weekday,
} from '@sm/shared';

/**
 * Quiet hours and digests (0.10.0, ADR 0012): the fields shared by the profile, the team defaults, the instance
 * channels, team channels and monitor outputs in Teams format. Nothing is dropped: messages held during quiet hours
 * arrive in one catch-up message at their end.
 */

/** Days as chips (Monday first). */
function DayChips({ value, onChange, label }: { value: Weekday[]; onChange: (v: Weekday[]) => void; label: string }) {
  const { t } = useTranslation('notifications');
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <Chip.Group multiple value={value} onChange={(v) => onChange(WEEKDAYS.filter((d) => v.includes(d)))}>
        <Group gap={6}>
          {WEEKDAYS.map((d) => (
            <Chip key={d} value={d} size="xs" variant="outline">
              {t(`quiet.days.${d}`)}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
    </Stack>
  );
}

/** The week at a glance: one row per day, shaded where it is quiet (the wall clock, without daylight-saving nights). */
export function WeekGrid({ value }: { value: Pick<QuietHours, 'windows' | 'allDay'> }) {
  const { t } = useTranslation('notifications');
  // Monday first; JavaScript counts from Sunday
  const rows = WEEKDAYS.map((d, i) => ({ d, js: (i + 1) % 7 }));
  const slots = Array.from({ length: 48 }, (_, k) => k * 30 + 15);
  return (
    <Box role="img" aria-label={t('quiet.gridLabel')} data-testid="quiet-week-grid">
      <Stack gap={3}>
        {rows.map(({ d, js }) => (
          <Group key={d} gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed" w={28} style={{ flexShrink: 0 }}>
              {t(`quiet.days.${d}`)}
            </Text>
            <Box style={{ display: 'flex', flex: 1, height: 10, borderRadius: 3, overflow: 'hidden', background: 'var(--mantine-color-default-hover)' }}>
              {slots.map((m) => (
                <Box
                  key={m}
                  style={{ flex: 1, background: wallQuiet(value, { weekday: js, minutes: m }) ? 'var(--mantine-color-indigo-filled)' : undefined }}
                />
              ))}
            </Box>
          </Group>
        ))}
        <Group gap={6} wrap="nowrap" aria-hidden>
          <Box w={28} style={{ flexShrink: 0 }} />
          <Group justify="space-between" style={{ flex: 1 }}>
            {['00', '06', '12', '18', '24'].map((h) => (
              <Text key={h} size="xs" c="dimmed">
                {h}
              </Text>
            ))}
          </Group>
        </Group>
      </Stack>
    </Box>
  );
}

/** Quiet hours: on/off, time zone, windows, whole days, whether urgent messages break through. */
export function QuietHoursFields({
  value,
  onChange,
  zoneList,
  channel = false,
}: {
  value: QuietHours;
  onChange: (v: QuietHours) => void;
  zoneList: string[];
  /** A channel target: "this channel" instead of "me" */
  channel?: boolean;
}) {
  const { t } = useTranslation('notifications');
  const set = (patch: Partial<QuietHours>) => onChange({ ...value, ...patch });
  const setWindow = (i: number, patch: Partial<QuietHours['windows'][number]>) =>
    set({ windows: value.windows.map((w, k) => (k === i ? { ...w, ...patch } : w)) });
  return (
    <Stack gap="sm">
      <Switch
        label={t(channel ? 'quiet.enabledChannel' : 'quiet.enabled')}
        checked={value.enabled}
        onChange={(e) => set({ enabled: e.currentTarget.checked })}
        data-testid="quiet-enabled"
      />
      {value.enabled && (
        <>
          <Select
            label={t('quiet.timeZone')}
            data={zoneList.length ? zoneList : [value.timeZone]}
            value={value.timeZone}
            onChange={(v) => v && set({ timeZone: v })}
            searchable
            allowDeselect={false}
            maw={320}
          />
          <Stack gap="xs">
            <Text size="sm" fw={500}>
              {t('quiet.windows')}
            </Text>
            {value.windows.length === 0 && (
              <Text size="xs" c="dimmed">
                {t('quiet.noWindows')}
              </Text>
            )}
            {value.windows.map((w, i) => (
              <Box key={i} p="xs" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }} data-testid="quiet-window">
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                  <DayChips label={t('quiet.windowDays')} value={w.days} onChange={(days) => setWindow(i, { days })} />
                  <Tooltip label={t('quiet.removeWindow')}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={t('quiet.removeWindow')}
                      onClick={() => set({ windows: value.windows.filter((_, k) => k !== i) })}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                <SimpleGrid cols={2} mt="xs" maw={320}>
                  <TextInput type="time" label={t('quiet.from')} value={w.from} onChange={(e) => setWindow(i, { from: e.currentTarget.value || w.from })} />
                  <TextInput type="time" label={t('quiet.to')} value={w.to} onChange={(e) => setWindow(i, { to: e.currentTarget.value || w.to })} />
                </SimpleGrid>
              </Box>
            ))}
            {value.windows.length < 14 && (
              <Group>
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => set({ windows: [...value.windows, { ...DEFAULT_QUIET_HOURS.windows[0]! }] })}
                >
                  {t('quiet.addWindow')}
                </Button>
              </Group>
            )}
            <Text size="xs" c="dimmed">
              {t('quiet.windowHint')}
            </Text>
          </Stack>
          <DayChips label={t('quiet.allDay')} value={value.allDay} onChange={(allDay) => set({ allDay })} />
          <WeekGrid value={value} />
          <Switch
            label={t('quiet.urgent')}
            description={t(channel ? 'quiet.urgentHintChannel' : 'quiet.urgentHint')}
            checked={value.urgentBreaksThrough}
            onChange={(e) => set({ urgentBreaksThrough: e.currentTarget.checked })}
          />
        </>
      )}
    </Stack>
  );
}

/** Digests: one row per event group (e-mail only). Decisions: immediately or hourly. */
export function DigestFields({ value, onChange, zoneList }: { value: DigestPrefs; onChange: (v: DigestPrefs) => void; zoneList: string[] }) {
  const { t } = useTranslation('notifications');
  const setGroup = (g: DigestGroup, c: DigestChoice) => {
    const groups = { ...value.groups };
    if (c.rhythm === 'immediately') delete groups[g];
    else groups[g] = c;
    onChange({ ...value, groups });
  };
  const timed = DIGEST_GROUPS.some((g) => value.groups[g]?.rhythm === 'daily' || value.groups[g]?.rhythm === 'weekly');
  return (
    <Stack gap="sm">
      {DIGEST_GROUPS.map((g) => {
        const c: DigestChoice = value.groups[g] ?? { rhythm: 'immediately' };
        const rhythms = g === 'decisions' ? DECISION_RHYTHMS : DIGEST_RHYTHMS;
        const label = t(`quiet.groups.${g}`);
        return (
          <Group key={g} justify="space-between" align="flex-start" gap="xs" wrap="wrap" data-testid={`digest-${g}`}>
            <Box style={{ flex: '1 1 220px', minWidth: 0 }}>
              <Text size="sm" fw={500}>
                {label}
              </Text>
              <Text size="xs" c="dimmed">
                {t(`quiet.groupHints.${g}`)}
              </Text>
            </Box>
            <Group gap="xs" wrap="wrap" style={{ flex: '0 1 auto' }}>
              <Select
                aria-label={label}
                w={150}
                data={rhythms.map((r) => ({ value: r, label: t(`quiet.rhythms.${r}`) }))}
                value={c.rhythm}
                allowDeselect={false}
                onChange={(v) =>
                  v &&
                  setGroup(g, {
                    rhythm: v as DigestChoice['rhythm'],
                    ...(v === 'daily' || v === 'weekly' ? { time: c.time ?? '17:00' } : {}),
                    ...(v === 'weekly' ? { weekday: c.weekday ?? 'fri' } : {}),
                  })
                }
              />
              {c.rhythm === 'weekly' && (
                <Select
                  aria-label={t('quiet.weekday')}
                  w={140}
                  data={WEEKDAYS.map((d) => ({ value: d, label: t(`quiet.daysLong.${d}`) }))}
                  value={c.weekday ?? 'fri'}
                  allowDeselect={false}
                  onChange={(v) => v && setGroup(g, { ...c, weekday: v as Weekday })}
                />
              )}
              {(c.rhythm === 'daily' || c.rhythm === 'weekly') && (
                <TextInput
                  type="time"
                  aria-label={t('quiet.at')}
                  w={130}
                  value={c.time ?? '17:00'}
                  onChange={(e) => setGroup(g, { ...c, time: e.currentTarget.value || c.time })}
                />
              )}
            </Group>
          </Group>
        );
      })}
      {timed && (
        <Select
          label={t('quiet.digestTimeZone')}
          data={zoneList.length ? zoneList : [value.timeZone]}
          value={value.timeZone}
          onChange={(v) => v && onChange({ ...value, timeZone: v })}
          searchable
          allowDeselect={false}
          maw={320}
        />
      )}
    </Stack>
  );
}
