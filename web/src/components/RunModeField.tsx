import { Anchor, Input, SegmentedControl, Stack, Text } from '@mantine/core';
import { useQueries } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import type { Platform, PlatformRecording } from '@sm/shared';
import { get } from '../api';

/**
 * How a run treats the platforms (#137): a dry run executes reads and only records writes, a test run answers every
 * platform call from the recorded responses, a run executes everything. One choice instead of two switches, because a
 * test run is always a dry run.
 */
export type RunMode = 'dry' | 'test' | 'real';

export const runModeOf = (o: { dryRun: boolean; recorded?: boolean }): RunMode => (o.recorded ? 'test' : o.dryRun ? 'dry' : 'real');
export const runModeFlags = (m: RunMode) => ({ dryRun: m !== 'real', recorded: m === 'test' });

/** How many recorded responses the bound platforms have, for the test run's description. */
function RecordingCounts({ platformIds }: { platformIds: string[] }) {
  const { t } = useTranslation('runs');
  const ids = [...new Set(platformIds.filter(Boolean))];
  const platforms = useQueries({
    queries: ids.map((id) => ({ queryKey: ['platform', id], queryFn: () => get<Platform>(`/platforms/${id}`) })),
  });
  const recordings = useQueries({
    queries: ids.map((id) => ({ queryKey: ['platform-recordings', id], queryFn: () => get<PlatformRecording[]>(`/platforms/${id}/recordings`) })),
  });
  if (!ids.length) return null;
  return (
    <Stack gap={2} data-testid="run-mode-recordings">
      {ids.map((id, i) => {
        const name = platforms[i]?.data?.name ?? id;
        const count = recordings[i]?.data?.length;
        if (count === undefined) return null;
        return (
          <Text key={id} size="xs" c={count ? 'dimmed' : 'orange'}>
            {count ? (
              t('mode.recordings', { name, count })
            ) : (
              <Trans
                t={t}
                i18nKey="mode.noRecordings"
                values={{ name }}
                components={{ a: <Anchor inherit component={Link} to={`/platforms/${id}?tab=recordings`} /> }}
              />
            )}
          </Text>
        );
      })}
    </Stack>
  );
}

export function RunModeField({
  value,
  onChange,
  modes = ['dry', 'test', 'real'],
  platformIds = [],
  label,
}: {
  value: RunMode;
  onChange: (m: RunMode) => void;
  /** The modes offered here; schedules and triggers have no test run. */
  modes?: RunMode[];
  /** Bound platforms: the test run names how many recorded responses each has. */
  platformIds?: string[];
  label?: string;
}) {
  const { t } = useTranslation('runs');
  const id = 'run-mode';
  return (
    <Input.Wrapper label={label ?? t('mode.label')} id={id} labelProps={{ id: `${id}-label` }}>
      <Stack gap={6} mt={4}>
        <SegmentedControl
          fullWidth
          aria-labelledby={`${id}-label`}
          value={value}
          onChange={(v) => onChange(v as RunMode)}
          data={modes.map((m) => ({ value: m, label: t(`mode.${m}`) }))}
          data-testid="run-mode"
        />
        <Text size="xs" c="dimmed" data-testid="run-mode-description">
          {t(`mode.${value}Hint`)}
        </Text>
        {value === 'test' && <RecordingCounts platformIds={platformIds} />}
      </Stack>
    </Input.Wrapper>
  );
}
