import { useState } from 'react';
import { ActionIcon, Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ObjectiveSummary } from '@sm/shared';
import { del, get, notifyError, notifyOk } from '../../api';
import { QueryState } from '../common';
import { confirmDanger } from '../confirm';
import { fmtDate, fmtRelative } from '../../format';
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
  const q = useQuery({ queryKey: ['objectives', serviceId], queryFn: () => get<ObjectiveSummary[]>(`/objectives?serviceId=${encodeURIComponent(serviceId)}`) });
  const [editing, setEditing] = useState<ObjectiveSummary | 'new' | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['objectives'] });
    void qc.invalidateQueries({ queryKey: ['scorecard'] });
  };
  const remove = async (o: ObjectiveSummary) => {
    if (!(await confirmDanger({ action: 'delete', message: t('objectives.deleteConfirm', { name: o.name }) }))) return;
    try {
      await del(`/objectives/${o.id}`);
      notifyOk(t('objectives.deleted'));
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const list = q.data ?? [];
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
          {list.map((o) => (
            <Paper key={o.id} withBorder p="sm" role="listitem" data-testid={`objective-${o.id}`}>
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={4} style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="wrap">
                    <Text fw={600} size="sm">
                      {o.name}
                    </Text>
                    <ObjectiveStatusBadge status={o.status} size="xs" />
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
                  {o.noDataReason && (
                    <Text size="xs" c="dimmed">
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
                </Stack>
                {o.canEdit && (
                  <Group gap={2} wrap="nowrap">
                    <ActionIcon variant="subtle" aria-label={t('form.editOf', { name: o.name })} onClick={() => setEditing(o)}>
                      <IconEdit size={16} />
                    </ActionIcon>
                    <ActionIcon variant="subtle" color="red" aria-label={t('objectives.deleteOf', { name: o.name })} onClick={() => void remove(o)}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                )}
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
      {list.length > 0 && (
        <Text size="xs" c="dimmed">
          {t('objectives.hint')}
        </Text>
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
