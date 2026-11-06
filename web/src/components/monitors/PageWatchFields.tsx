import { useState } from 'react';
import { Autocomplete, Group, NumberInput, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PAGE_WATCH_UUID_RE, type CheckOf, type PageWatchList, type Platform } from '@sm/shared';
import { get } from '../../api';
import { platformKeys } from '../../queryKeys';

type Scope = 'watch' | 'tag' | 'all';
type PageWatchCheck = CheckOf<'page-watch'>;

/**
 * The settings of a "Page watch" check (#242): which watches of a changedetection.io platform – one, the ones with a
 * tag, or all – and how a change, a failing watch, one not checked for too long and a paused one count. The watch and
 * tag pickers offer what Steward last read from the platform; a UUID can be typed when it was not read yet.
 */
export function PageWatchFields({
  check: c,
  set,
  platforms,
  disabled,
  err,
}: {
  check: PageWatchCheck;
  set: (p: Partial<PageWatchCheck>) => void;
  platforms: Platform[];
  disabled?: boolean;
  err: (field: string) => string | undefined;
}) {
  const { t } = useTranslation('monitors');
  const [scope, setScope] = useState<Scope>(c.watch ? 'watch' : c.tag ? 'tag' : 'all');
  const known = platforms.some((p) => p.id === c.platform);
  const list = useQuery({
    queryKey: platformKeys.watches(c.platform),
    queryFn: () => get<PageWatchList>(`/changedetection/${c.platform}/watches`),
    enabled: known,
    retry: false,
  });
  const watches = list.data?.watches ?? [];
  const options = watches.filter((w) => w.state !== 'removed').map((w) => ({ value: w.uuid, label: w.title }));
  if (c.watch && !options.some((o) => o.value === c.watch)) options.push({ value: c.watch, label: c.watch });
  const pickScope = (s: Scope) => {
    setScope(s);
    set({ watch: undefined, tag: undefined });
  };
  return (
    <Stack gap="sm">
      <div>
        <Text size="sm" fw={500} mb={4} id="page-watch-scope">
          {t('form.pageWatchScope')}
        </Text>
        <SegmentedControl
          aria-labelledby="page-watch-scope"
          size="xs"
          fullWidth
          disabled={disabled}
          value={scope}
          onChange={(v) => pickScope(v as Scope)}
          data={[
            { value: 'watch', label: t('form.pageWatchScopeWatch') },
            { value: 'tag', label: t('form.pageWatchScopeTag') },
            { value: 'all', label: t('form.pageWatchScopeAll') },
          ]}
        />
      </div>
      {scope === 'watch' &&
        (options.length ? (
          <Select
            label={t('form.pageWatchWatch')}
            description={t('form.pageWatchWatchHint')}
            required
            searchable
            data-field="watch"
            error={err('watch')}
            disabled={disabled}
            data={options}
            value={c.watch || null}
            onChange={(v) => set({ watch: v ?? undefined })}
            nothingFoundMessage={t('form.pageWatchNoWatch')}
          />
        ) : (
          <TextInput
            label={t('form.pageWatchUuid')}
            description={known ? t('form.pageWatchNotRead') : t('form.pageWatchUuidHint')}
            required
            data-field="watch"
            classNames={{ input: 'mono' }}
            error={err('watch') ?? (c.watch && !PAGE_WATCH_UUID_RE.test(c.watch) ? t('form.pageWatchUuidInvalid') : undefined)}
            disabled={disabled}
            value={c.watch ?? ''}
            onChange={(e) => set({ watch: e.currentTarget.value.trim() || undefined })}
          />
        ))}
      {scope === 'tag' && (
        <Autocomplete
          label={t('form.pageWatchTag')}
          description={t('form.pageWatchTagHint')}
          required
          data-field="tag"
          error={err('tag')}
          disabled={disabled}
          data={list.data?.tags ?? []}
          value={c.tag ?? ''}
          onChange={(v) => set({ tag: v || undefined })}
        />
      )}
      <Group grow align="flex-start">
        <NumberInput
          label={t('form.pageWatchChangedWithin')}
          min={1}
          max={8760}
          data-field="changedWithinHours"
          error={err('changedWithinHours')}
          disabled={disabled}
          value={c.changedWithinHours ?? 24}
          onChange={(v) => set({ changedWithinHours: typeof v === 'number' ? v : 24 })}
        />
        <Select
          label={t('form.pageWatchChangedAs')}
          description={t('form.pageWatchChangedAsHint')}
          allowDeselect={false}
          disabled={disabled}
          data={[
            { value: 'up', label: t('form.pageWatchInformational') },
            { value: 'degraded', label: t('status.degraded') },
          ]}
          value={c.changedAs ?? 'up'}
          onChange={(v) => set({ changedAs: (v as 'up' | 'degraded') ?? 'up' })}
        />
      </Group>
      <Group grow align="flex-start">
        <Select
          label={t('form.pageWatchFailingAs')}
          description={t('form.pageWatchFailingAsHint')}
          allowDeselect={false}
          disabled={disabled}
          data={[
            { value: 'degraded', label: t('status.degraded') },
            { value: 'down', label: t('status.down') },
          ]}
          value={c.failingAs ?? 'degraded'}
          onChange={(v) => set({ failingAs: (v as 'down' | 'degraded') ?? 'degraded' })}
        />
        <NumberInput
          label={t('form.pageWatchMaxCheckAge')}
          description={t('form.pageWatchMaxCheckAgeHint')}
          min={1}
          max={8760}
          data-field="maxCheckAgeHours"
          error={err('maxCheckAgeHours')}
          disabled={disabled}
          value={c.maxCheckAgeHours ?? ''}
          onChange={(v) => set({ maxCheckAgeHours: typeof v === 'number' ? v : undefined })}
        />
      </Group>
      <Select
        label={t('form.pageWatchPausedAs')}
        allowDeselect={false}
        disabled={disabled}
        data={[
          { value: 'ignore', label: t('form.pageWatchPausedIgnore') },
          { value: 'degraded', label: t('status.degraded') },
        ]}
        value={c.pausedAs ?? 'ignore'}
        onChange={(v) => set({ pausedAs: (v as 'ignore' | 'degraded') ?? 'ignore' })}
      />
    </Stack>
  );
}
