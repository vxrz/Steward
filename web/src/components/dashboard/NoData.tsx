import { Anchor, Group, Stack, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { DatasetPublisher } from '@sm/shared';
import { get } from '../../api';
import { errorText } from '../../i18n/errors';
import { isNotFound } from './data';
import { useMe } from '../../auth';
import { datasetKeys } from '../../queryKeys';

/**
 * A widget without data, in plain words and by role: viewers learn who fills it ("ask a designer to schedule
 * Privileged access review"), people who may run or edit the publishing process get the links to it and its
 * schedule – and the dataset key as a detail. The publishing process is read from the process definitions, so it
 * is known before the first run.
 */
export function NoData({ dataset, error }: { dataset?: string; error?: unknown }) {
  const { t } = useTranslation(['dashboards', 'editor']);
  const { caps } = useMe();
  const empty = !error || isNotFound(error);
  // data the person may not read (U3): say so, instead of "no process fills this widget"
  const hidden = useQuery({
    queryKey: datasetKeys.visibility(dataset),
    queryFn: () => get<{ hiddenByPermissions: boolean }>(`/datasets/${encodeURIComponent(dataset!)}/visibility`),
    enabled: !!dataset && empty,
    staleTime: 60000,
    retry: false,
  });
  const publishers = useQuery({
    queryKey: datasetKeys.publishers(dataset),
    queryFn: () => get<DatasetPublisher[]>(`/datasets/${encodeURIComponent(dataset!)}/publishers`),
    enabled: !!dataset && empty,
    staleTime: 60000,
    retry: false,
  });
  if (!dataset)
    return (
      <Text size="sm" c="dimmed">
        {t('w.chooseDataset')}
      </Text>
    );
  if (!empty)
    return (
      <Text size="sm" c="dimmed">
        {errorText(error)}
      </Text>
    );
  if (hidden.data?.hiddenByPermissions)
    return (
      <Text size="sm" c="dimmed" data-testid="widget-no-access">
        {t('w.noDataHidden')}
      </Text>
    );
  if (!publishers.isSuccess && !publishers.isError) return null;
  const list = publishers.data ?? [];
  // the one that fills it: a scheduled one first
  const p = list.find((x) => x.scheduled) ?? list[0];
  const name = <b />;
  const maker = !!p && (p.canEdit || p.canRun);
  return (
    <Stack gap={4} data-testid="widget-no-data">
      <Text size="sm" c="dimmed">
        {!p ? (
          t('w.noDataNoProcess')
        ) : p.scheduled ? (
          <Trans t={t} i18nKey="w.noDataScheduled" values={{ process: p.processName }} components={{ b: name }} />
        ) : maker ? (
          <Trans t={t} i18nKey="w.noDataRunIt" values={{ process: p.processName }} components={{ b: name }} />
        ) : (
          <Trans t={t} i18nKey="w.noDataAsk" values={{ process: p.processName }} components={{ b: name }} />
        )}
      </Text>
      {maker && (
        <Group gap="sm">
          <Anchor component={Link} to={`/processes/${p.processId}`} size="xs">
            {t('w.openProcess')}
          </Anchor>
          {!p.scheduled && p.canRun && (
            <Anchor component={Link} to={`/schedules?new=1&processId=${encodeURIComponent(p.processId)}`} size="xs">
              {t('w.scheduleIt')}
            </Anchor>
          )}
        </Group>
      )}
      {!p && caps.createProcesses && (
        <Text size="xs" c="dimmed">
          <Trans t={t} i18nKey="w.noDataHowTo" values={{ node: t('editor:steps.publish.label'), dataset }} components={{ c: <span className="mono" /> }} />
        </Text>
      )}
      {maker && (
        <Text size="xs" c="dimmed">
          <Trans t={t} i18nKey="w.datasetKey" values={{ dataset }} components={{ c: <span className="mono" /> }} />
        </Text>
      )}
    </Stack>
  );
}
