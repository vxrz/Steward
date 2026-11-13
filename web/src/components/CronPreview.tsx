import { Alert, Button, Code, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { post } from '../api';
import { dateTimeFormat } from '../format';
import { codeText, errorText } from '../i18n/errors';

export interface CronWarning {
  code: string;
  message: string;
  params?: { suggestion?: string; context?: string };
}

/** The browser's own time zone (Europe/Berlin), UTC when it cannot tell. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The IANA time zones for a picker, with UTC and the current value (a zone the browser does not list stays choosable). */
export function timeZoneOptions(current?: string | null): string[] {
  let list: string[];
  try {
    list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    list = [];
  }
  return [...new Set([...(current ? [current] : []), 'UTC', ...list])].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}

/**
 * A planned run as its schedule sees it: in the schedule's time zone with the zone's short name ("2 Dec 2026, 06:00
 * CET") when it differs from the browser's, so "06:00 on the first Tuesday" reads as 06:00 – and in the browser's zone
 * otherwise.
 */
export function fmtRun(iso: string, timezone?: string | null): string {
  const other = !!timezone && timezone !== browserTimeZone();
  try {
    // dateStyle/timeStyle cannot be combined with timeZoneName: the fields one by one
    return other
      ? dateTimeFormat({
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: timezone,
          timeZoneName: 'short',
        }).format(new Date(iso))
      : dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  }
}

/** The next runs of a cron expression and its traps (POST /api/cron/preview), asked for once typing pauses. */
export function useCronPreview(cron: string, timezone?: string) {
  const [debounced] = useDebouncedValue(cron.trim(), 400);
  return useQuery({
    queryKey: ['cron', debounced, timezone || ''],
    queryFn: () => post<{ next: string[]; warnings?: CronWarning[] }>('/cron/preview', { cron: debounced, timezone: timezone || undefined }),
    enabled: !!debounced,
    retry: false,
  });
}

/**
 * Warnings about a cron expression that parses but does not do what it looks like (both day fields restricted: either
 * one matching is enough), with the expression that was probably meant.
 */
export function CronWarnings({ warnings, onUse }: { warnings?: CronWarning[]; onUse?: (cron: string) => void }) {
  const { t } = useTranslation();
  if (!warnings?.length) return null;
  return (
    <Stack gap={4} mt={6}>
      {warnings.map((w) => {
        const suggestion = w.params?.suggestion;
        return (
          <Alert key={w.code} color="yellow" variant="light" p="xs" icon={<IconAlertTriangle size={16} />} data-testid="cron-warning">
            <Text size="xs">{codeText(w.code, w.params, w.message) ?? w.message}</Text>
            {suggestion && onUse && (
              <Button size="compact-xs" variant="light" mt={4} onClick={() => onUse(suggestion)}>
                {t('cron.use')} <Code ml={4}>{suggestion}</Code>
              </Button>
            )}
          </Alert>
        );
      })}
    </Stack>
  );
}

/** Below a cron field: the next runs, why the expression does not parse, and its traps. */
export function CronPreview({ cron, timezone, onUse }: { cron: string; timezone?: string; onUse?: (cron: string) => void }) {
  const { t } = useTranslation();
  const preview = useCronPreview(cron, timezone);
  if (!cron.trim()) return null;
  return (
    <div data-testid="cron-preview">
      {preview.error ? (
        <Text size="xs" c="red" mt={4}>
          {errorText(preview.error)}
        </Text>
      ) : (
        preview.data && (
          <Text size="xs" c="dimmed" mt={4}>
            {t('cron.next', {
              dates: preview.data.next
                .slice(0, 3)
                .map((n) => fmtRun(n, timezone))
                .join(' · '),
            })}
          </Text>
        )
      )}
      <CronWarnings warnings={preview.data?.warnings} onUse={onUse} />
    </div>
  );
}
