import { Alert, Button, Code, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { post } from '../api';
import { fmtDate } from '../format';
import { codeText, errorText } from '../i18n/errors';

export interface CronWarning {
  code: string;
  message: string;
  params?: { suggestion?: string; context?: string };
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
                .map((n) => fmtDate(n))
                .join(' · '),
            })}
          </Text>
        )
      )}
      <CronWarnings warnings={preview.data?.warnings} onUse={onUse} />
    </div>
  );
}
