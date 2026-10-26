import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconCalendarOff, IconEdit, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DutySummary } from '@sm/shared';
import { get } from '../../api';
import { QueryState } from '../common';
import { DutyFormModal, DutyLevelBadge, DutyStatusBadge, PeriodLine, SkipModal } from './common';

/**
 * The duties of a service (service page: with "Add duty", edit and exceptions for those who may) or the duties of
 * services that are about one application (application page: read-only, with the service named).
 */
export function DutiesPanel({
  serviceId,
  applicationId,
  canEdit = false,
  applications = [],
}: {
  serviceId?: string;
  applicationId?: string;
  canEdit?: boolean;
  applications?: { id: string; name: string }[];
}) {
  const { t } = useTranslation('duties');
  const qc = useQueryClient();
  const filter = serviceId ? `serviceId=${encodeURIComponent(serviceId)}` : `applicationId=${encodeURIComponent(applicationId ?? '')}`;
  const q = useQuery({ queryKey: ['duties', filter], queryFn: () => get<DutySummary[]>(`/duties?${filter}`) });
  const [editing, setEditing] = useState<DutySummary | 'new' | null>(null);
  const [skipping, setSkipping] = useState<DutySummary | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['duties'] });
  const list = q.data ?? [];
  return (
    <Stack gap="xs" data-testid="duties-panel">
      <Group justify="space-between">
        <Text fw={600} id="duties-title">
          {t('panelTitle')}
        </Text>
        {serviceId && canEdit && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            {t('add')}
          </Button>
        )}
      </Group>
      <QueryState query={q} rows={2} />
      {q.isSuccess && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {serviceId ? t('empty') : t('emptyApplication')}
        </Text>
      )}
      {list.length > 0 && (
        <>
          <Stack gap="xs" role="list" aria-labelledby="duties-title">
            {list.map((d) => (
              <Paper key={d.id} withBorder p="sm" role="listitem" data-testid={`duty-${d.id}`}>
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <Stack gap={4} style={{ minWidth: 0 }}>
                    <Group gap={6} wrap="wrap">
                      <Anchor component={Link} to={`/duties/${d.id}`} fw={600} size="sm">
                        {d.name}
                      </Anchor>
                      <DutyLevelBadge level={d.level} />
                      <Badge size="xs" variant="default" tt="none">
                        {t(`intervals.${d.interval}`)}
                        {d.graceDays ? ` ${t('graceShort', { count: d.graceDays })}` : ''}
                      </Badge>
                      {d.plannedSkips > 0 && (
                        <Badge size="xs" color="orange" variant="light" tt="none" data-testid="planned-skips">
                          {t('plannedSkips', { count: d.plannedSkips })}
                        </Badge>
                      )}
                      {d.pendingSkips > 0 && (
                        <Badge size="xs" color="violet" variant="light" tt="none">
                          {t('pendingSkips', { count: d.pendingSkips })}
                        </Badge>
                      )}
                    </Group>
                    {!serviceId && (
                      <Text size="xs">
                        {t('service')}:{' '}
                        <Anchor component={Link} to={`/services/${d.serviceId}`} size="xs">
                          {d.serviceName}
                        </Anchor>
                      </Text>
                    )}
                    <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                      {t('process')}: {d.processName ?? t('processHidden')}
                      {d.applicationName && serviceId ? ` · ${t('application')}: ${d.applicationName}` : ''}
                    </Text>
                    <Group gap="lg" wrap="wrap" mt={2}>
                      <Stack gap={2}>
                        <Group gap={6}>
                          <Text size="xs" fw={500}>
                            {t('current')}
                          </Text>
                          <DutyStatusBadge period={d.current} size="xs" />
                        </Group>
                        {d.current && <PeriodLine period={d.current} tz={d.timeZone} />}
                      </Stack>
                      {d.previous && (
                        <Stack gap={2}>
                          <Group gap={6}>
                            <Text size="xs" fw={500}>
                              {t('previous')}
                            </Text>
                            <DutyStatusBadge period={d.previous} size="xs" />
                          </Group>
                          <PeriodLine period={d.previous} tz={d.timeZone} />
                        </Stack>
                      )}
                    </Group>
                  </Stack>
                  {serviceId && (d.canEdit || d.canRequestSkip) && (
                    <Group gap={2} wrap="nowrap">
                      {d.canRequestSkip && (
                        <ActionIcon variant="subtle" aria-label={t('askSkipOf', { name: d.name })} onClick={() => setSkipping(d)}>
                          <IconCalendarOff size={16} />
                        </ActionIcon>
                      )}
                      {d.canEdit && (
                        <ActionIcon variant="subtle" aria-label={t('editOf', { name: d.name })} onClick={() => setEditing(d)}>
                          <IconEdit size={16} />
                        </ActionIcon>
                      )}
                    </Group>
                  )}
                </Group>
              </Paper>
            ))}
          </Stack>
          <Text size="xs" c="dimmed">
            {t('panelHint', { tz: list[0]!.timeZone })}
          </Text>
        </>
      )}
      {editing && serviceId && (
        <DutyFormModal
          serviceId={serviceId}
          applications={applications}
          duty={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {skipping && <SkipModal duty={skipping} onClose={() => setSkipping(null)} onSaved={refresh} />}
    </Stack>
  );
}
