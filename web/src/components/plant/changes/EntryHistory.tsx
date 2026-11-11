import { Anchor, Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconArrowBackUp, IconHistory } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantChangeSetDetail, PlantEntryHistory, PlantEntryKind } from '@sm/shared';
import { get, notifyError, post } from '../../../api';
import { fmtDate, fmtRelative } from '../../../format';
import { plantKeys } from '../../../queryKeys';
import { EmptyState, QueryState } from '../../common';
import { FieldDiffs } from '../changes';
import { SourceBadge, useKindName } from './common';

/**
 * The History tab of an entry (0.13.0, ADR 0020 §4): every applied change set that touched it – and, for a site or an
 * asset, what belongs to it – newest first: when, who wrote it and who applied it, the change set and where it came
 * from, the fields that changed (full values). _Revert_ writes a new draft with the inverse change, based on now. For
 * the time before 0.13 the entry's audit entries.
 */
export function EntryHistory({ kind, id, scope = '', children = false }: { kind: PlantEntryKind; id: string; scope?: string; children?: boolean }) {
  const { t } = useTranslation(['plantChanges', 'common']);
  const kindName = useKindName();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = `${kind}:${scope}:${id}:${children ? 1 : 0}`;
  const history = useQuery({
    queryKey: plantKeys.history(key),
    queryFn: () =>
      get<PlantEntryHistory>(`/plant/history?kind=${kind}&scope=${encodeURIComponent(scope)}&id=${encodeURIComponent(id)}${children ? '&children=1' : ''}`),
  });
  const revert = useMutation({
    mutationFn: (historyId: string) => post<PlantChangeSetDetail & { skipped: number }>(`/plant/history/${encodeURIComponent(historyId)}/revert`, {}),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: plantKeys.config });
      void qc.invalidateQueries({ queryKey: ['plant', 'change-sets'] });
      navigate(`/plant/changes/${encodeURIComponent(d.id)}`);
    },
    onError: (e) => notifyError(e),
  });
  const items = history.data?.items ?? [];
  return (
    <Stack gap="sm" data-testid="entry-history">
      <QueryState query={history} />
      {history.isSuccess && !items.length && (
        <EmptyState icon={IconHistory} title={t('history.emptyTitle')} compact>
          {t('history.emptyText')}
        </EmptyState>
      )}
      <Stack gap="xs" component="ol" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={t('history.label')}>
        {items.map((h) => (
          <Paper key={h.id} withBorder p="sm" component="li" data-testid="history-row">
            <Group justify="space-between" align="flex-start" gap="xs" wrap="wrap">
              <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                <Group gap="xs" wrap="wrap">
                  <Badge
                    size="sm"
                    variant="light"
                    color={h.op === 'add' ? 'green' : h.op === 'remove' ? 'red' : h.op === 'rename' ? 'violet' : h.op === 'move' ? 'grape' : 'blue'}
                  >
                    {t(`history.ops.${h.op}`)}
                  </Badge>
                  {(h.kind !== kind || h.entryId !== id) && (
                    <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {kindName(h.kind)} {h.entryId}
                    </Text>
                  )}
                  {h.changeSet && <SourceBadge source={h.changeSet.source} />}
                  <Text size="xs" c="dimmed" title={fmtDate(h.at)}>
                    {fmtRelative(h.at)}
                  </Text>
                </Group>
                <Text size="sm">
                  {h.by === h.appliedBy ? t('history.byOne', { by: h.by }) : t('history.byTwo', { by: h.by, appliedBy: h.appliedBy })}
                  {' · '}
                  {t('history.revision', { revision: h.revision })}
                </Text>
                {h.changeSet && (
                  <Anchor component={Link} to={`/plant/changes/${encodeURIComponent(h.changeSet.id)}`} size="sm" style={{ overflowWrap: 'anywhere' }}>
                    {h.changeSet.title}
                  </Anchor>
                )}
                <FieldDiffs diff={h.diff} />
              </Stack>
              {h.canRevert && (
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconArrowBackUp size={14} aria-hidden />}
                  loading={revert.isPending && revert.variables === h.id}
                  onClick={() => revert.mutate(h.id)}
                  data-testid="history-revert"
                >
                  {/* 0.19.0: a removal is reverted by adding the entry again */}
                  {h.op === 'remove' ? t('history.restore') : t('history.revert')}
                </Button>
              )}
            </Group>
          </Paper>
        ))}
      </Stack>
      {history.data && (
        <Text size="sm" c="dimmed">
          {t('history.before')}{' '}
          <Anchor component={Link} to={history.data.auditPath}>
            {t('history.audit')}
          </Anchor>
        </Text>
      )}
    </Stack>
  );
}
