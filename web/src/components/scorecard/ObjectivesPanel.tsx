import { useState } from 'react';
import { ActionIcon, Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArchive, IconArchiveOff, IconEdit, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ObjectiveDetail, ObjectiveSummary } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { QueryState } from '../common';
import { confirmDanger } from '../confirm';
import { fmtDate, fmtRelative } from '../../format';

/** 45 → "45 min", 90 → "1 h 30 min" */
const fmtMinutes = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
import { Sparkline } from '../dashboard/charts';
import { OBJECTIVE_COLORS, ObjectiveFormModal, ObjectiveStatusBadge, fmtPct } from './common';

/**
 * The availability objectives of a service (service page): per objective the windows with their target, Gatus'
 * current uptime and the status; "Add objective", edit and delete for those who may edit the service.
 */
export function ObjectivesPanel({
  serviceId,
  canEdit = false,
  applications = [],
}: {
  serviceId: string;
  canEdit?: boolean;
  applications?: { id: string; name: string }[];
}) {
  const { t } = useTranslation('scorecard');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['objectives', serviceId],
    queryFn: () => get<ObjectiveSummary[]>(`/objectives?serviceId=${encodeURIComponent(serviceId)}&archived=1`),
  });
  const [editing, setEditing] = useState<ObjectiveSummary | 'new' | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['objectives'] });
    void qc.invalidateQueries({ queryKey: ['scorecard'] });
  };
  const setArchived = async (o: ObjectiveSummary, archived: boolean) => {
    if (archived && !(await confirmDanger({ action: 'archive', message: t('objectives.archiveConfirm', { name: o.name }) }))) return;
    try {
      await post(`/objectives/${o.id}/archive`, { archived });
      notifyOk(archived ? t('objectives.archived') : t('objectives.restored'));
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const all = q.data ?? [];
  const list = all.filter((o) => !o.archived);
  const archived = all.filter((o) => o.archived);
  const card = (o: ObjectiveSummary) => (
    <ObjectiveCard key={o.id} objective={o} onEdit={() => setEditing(o)} onArchive={() => void setArchived(o, !o.archived)} />
  );
  return (
    <Stack gap="xs" data-testid="objectives-panel">
      <Group justify="space-between">
        <Text fw={600} id="objectives-title">
          {t('objectives.title')}
        </Text>
        {canEdit && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            {t('form.add')}
          </Button>
        )}
      </Group>
      <QueryState query={q} rows={2} />
      {q.isSuccess && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('objectives.empty')}
        </Text>
      )}
      {list.length > 0 && (
        <Stack gap="xs" role="list" aria-labelledby="objectives-title">
          {list.map(card)}
        </Stack>
      )}
      {list.length > 0 && (
        <Text size="xs" c="dimmed">
          {t('objectives.hint')}
        </Text>
      )}
      {archived.length > 0 && (
        <details>
          <summary>
            <Text component="span" size="sm">
              {t('objectives.archivedList', { count: archived.length })}
            </Text>
          </summary>
          <Stack gap="xs" role="list" aria-label={t('objectives.archivedList', { count: archived.length })} mt="xs">
            {archived.map(card)}
          </Stack>
        </details>
      )}
      {editing && (
        <ObjectiveFormModal
          serviceId={serviceId}
          applications={applications}
          objective={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </Stack>
  );
}

/** One objective: its windows with target, value and status, the platform and endpoint (or "hidden"), and the history. */
function ObjectiveCard({ objective: o, onEdit, onArchive }: { objective: ObjectiveSummary; onEdit: () => void; onArchive: () => void }) {
  const { t } = useTranslation('scorecard');
  return (
    <Paper withBorder p="sm" role="listitem" data-testid={`objective-${o.id}`} data-inactive={o.archived || undefined}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Text fw={600} size="sm">
              {o.name}
            </Text>
            <ObjectiveStatusBadge status={o.status} size="xs" />
            {o.archived && (
              <Badge size="xs" variant="default" tt="none">
                {t('objectives.archivedOn', { date: fmtDate(o.archivedAt) })}
              </Badge>
            )}
            {o.notify && (
              <Badge size="xs" variant="default" tt="none">
                {t('objectives.notifies')}
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
            {o.platformVisible ? `${o.platformName ?? ''} · ${o.endpointName ?? o.endpointKey ?? ''}` : t('objectives.platformHidden')}
            {o.applicationName ? ` · ${t('objectives.application')}: ${o.applicationName}` : ''}
          </Text>
          <Group gap={6} wrap="wrap">
            {o.windows.map((w) => (
              <Badge
                key={w.window}
                size="sm"
                variant="outline"
                color={OBJECTIVE_COLORS[w.status]}
                tt="none"
                data-testid={`window-${w.window}`}
                aria-label={t('objectives.windowAria', {
                  window: t(`windows.${w.window}`),
                  value: fmtPct(w.value),
                  target: fmtPct(w.target),
                  status: t(`objectiveStatuses.${w.status}`),
                })}
              >
                {t('objectives.window', { window: t(`windows.${w.window}`), value: fmtPct(w.value), target: fmtPct(w.target) })}
              </Badge>
            ))}
          </Group>
          {o.windows.some((w) => (w.plannedMinutes ?? 0) > 0) && (
            <Text size="xs" c="dimmed" data-testid="objective-planned">
              {t('objectives.planned', {
                list: o.windows
                  .filter((w) => (w.plannedMinutes ?? 0) > 0)
                  .map((w) => `${t(`windows.${w.window}`)} ${fmtMinutes(w.plannedMinutes ?? 0)}`)
                  .join(' · '),
              })}
            </Text>
          )}
          {o.noDataReason && !o.archived && (
            <Text size="xs" c={o.noDataTooLong ? 'red.8' : 'dimmed'}>
              {o.noDataTooLong && o.noDataSince ? `${t('objectives.noDataSince', { date: fmtDate(o.noDataSince) })} ` : ''}
              {t(`noData.${o.noDataReason}`)}
            </Text>
          )}
          {o.breach && (
            <Text size="xs" c="red.8">
              {t('objectives.breachSince', { date: fmtDate(o.breach.startedAt) })}
            </Text>
          )}
          {o.valuesAt && (
            <Text size="xs" c="dimmed">
              {t('objectives.valuesAt', { when: fmtRelative(o.valuesAt) })}
            </Text>
          )}
          <ObjectiveHistory objective={o} />
        </Stack>
        {o.canEdit && (
          <Group gap={2} wrap="nowrap">
            {!o.archived && (
              <ActionIcon variant="subtle" aria-label={t('form.editOf', { name: o.name })} onClick={onEdit}>
                <IconEdit size={16} />
              </ActionIcon>
            )}
            <ActionIcon
              variant="subtle"
              aria-label={o.archived ? t('objectives.restoreOf', { name: o.name }) : t('objectives.archiveOf', { name: o.name })}
              onClick={onArchive}
            >
              {o.archived ? <IconArchiveOff size={16} /> : <IconArchive size={16} />}
            </ActionIcon>
          </Group>
        )}
      </Group>
    </Paper>
  );
}

/** The stored hourly samples of the first window with a target (last 30 days), on demand. */
function ObjectiveHistory({ objective: o }: { objective: ObjectiveSummary }) {
  const { t } = useTranslation('scorecard');
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['objectives', 'detail', o.id], queryFn: () => get<ObjectiveDetail>(`/objectives/${o.id}`), enabled: open });
  const w = o.windows[0]?.window;
  if (!w) return null;
  const samples = (q.data?.samples ?? []).filter((x) => x.values[w] !== null).reverse();
  const below = (q.data?.samples ?? []).filter((x) => x.status === 'below').length;
  return (
    <Stack gap={2}>
      <Button variant="subtle" size="compact-xs" w="fit-content" px={0} onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        {open ? t('objectives.hideHistory') : t('objectives.showHistory')}
      </Button>
      {open && <QueryState query={q} rows={1} />}
      {open && q.data && (
        <Stack gap={2} data-testid="objective-history">
          <Text size="xs" c="dimmed">
            {t('objectives.historySummary', {
              count: q.data.samples.length,
              below,
              breaches: q.data.breaches.length,
              window: t(`windows.${w}`),
            })}
          </Text>
          {samples.length > 1 && <Sparkline points={samples.map((x) => ({ ts: x.at, value: x.values[w]! }))} height={32} />}
          {q.data.breaches.slice(0, 5).map((b) => (
            <Text size="xs" key={b.id} data-testid="objective-breach">
              {b.endedAt
                ? t(b.endReason === 'archived' ? 'objectives.breachArchived' : 'objectives.breachRecovered', {
                    from: fmtDate(b.startedAt),
                    to: fmtDate(b.endedAt),
                  })
                : t('objectives.breachSince', { date: fmtDate(b.startedAt) })}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
