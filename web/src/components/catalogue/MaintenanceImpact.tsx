import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, List, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconBellRinging, IconCalendarPause, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  IMPACT_GROUPS,
  type ImpactDowntimeResult,
  type ImpactExpectation,
  type ImpactGroupKind,
  type ImpactItem,
  type ImpactMonitor,
  type ImpactNotifyResult,
  type MaintenanceImpact,
  type MaintenanceKind,
} from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { CollapsibleSection } from '../page/CollapsibleSection';

/**
 * Impact before maintenance (0.14): what a window affects – in the form before it is saved (the targets as chosen) and
 * on the window's page – grouped and counted, each item linked; monitors with what they do meanwhile (a monitor with an
 * Off state goes Off, not down); the owners and contacts to tell. One click: planned downtime for the affected monitors
 * (or listing them in the window), and telling the owners through the window's announcement.
 */

const EXPECT_COLOR: Record<ImpactExpectation, string> = { maintenance: 'gray', downtime: 'gray', off: 'blue', down: 'orange' };

export const impactKey = (windowId: string | undefined, targets: string[], kind: MaintenanceKind, quiet: boolean) =>
  windowId ? ['maintenance-windows', windowId, 'impact'] : ['maintenance-windows', 'impact', targets.join(','), kind, quiet];

export function useMaintenanceImpact(p: { windowId?: string; targets: string[]; kind: MaintenanceKind; quietMonitors: boolean }) {
  return useQuery({
    queryKey: impactKey(p.windowId, p.targets, p.kind, p.quietMonitors),
    queryFn: () =>
      p.windowId
        ? get<MaintenanceImpact>(`/maintenance-windows/${p.windowId}/impact`)
        : get<MaintenanceImpact>(
            `/maintenance-windows/impact?targets=${encodeURIComponent(p.targets.join(','))}&kind=${p.kind}&quietMonitors=${p.quietMonitors ? 'true' : 'false'}`,
          ),
    enabled: !!p.windowId || p.targets.length > 0,
    staleTime: 10_000,
  });
}

function ItemLine({ item, group }: { item: ImpactItem; group: ImpactGroupKind }) {
  const { t } = useTranslation(['applications', 'monitors']);
  const m = group === 'monitors' ? (item as ImpactMonitor) : null;
  return (
    <List.Item>
      <Group gap={6} wrap="wrap">
        {item.path ? (
          <Anchor component={Link} to={item.path} size="sm">
            {item.name || item.id}
          </Anchor>
        ) : (
          <Text size="sm">{item.name || item.id}</Text>
        )}
        {m && (
          <Badge size="sm" variant="light" color={EXPECT_COLOR[m.expect]} tt="none" data-testid={`impact-expect-${m.expect}`}>
            {t(`maintenance.impactView.expect.${m.expect}`)}
          </Badge>
        )}
        {m && (
          <Text size="xs" c="dimmed">
            {t('maintenance.impactView.statusNow', {
              status: !m.enabled
                ? t('maintenance.impactView.disabled')
                : m.status
                  ? t(`monitors:status.${m.status as 'up'}`, { defaultValue: m.status })
                  : t('maintenance.impactView.noStatus'),
            })}
          </Text>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {[item.detail, `${t(`maintenance.impactView.via.${item.via}`)}${item.from ? ` · ${item.from}` : ''}`].filter(Boolean).join(' · ')}
      </Text>
    </List.Item>
  );
}

/**
 * The impact of a window (`windowId`) or of the form's targets. `onIncludeMonitors`: in the form, list the monitors
 * the planner may add; `canEdit`: on the window's page, the one-click actions.
 */
export function MaintenanceImpactPanel({
  windowId,
  targets,
  kind,
  quietMonitors,
  canEdit,
  onIncludeMonitors,
  onWindow,
}: {
  windowId?: string;
  targets: string[];
  kind: MaintenanceKind;
  quietMonitors: boolean;
  canEdit?: boolean;
  onIncludeMonitors?: (ids: string[]) => void;
  /** After planned downtime was made: open that window */
  onWindow?: (id: string) => void;
}) {
  const { t } = useTranslation('applications');
  const qc = useQueryClient();
  const q = useMaintenanceImpact({ windowId, targets, kind, quietMonitors });
  const [busy, setBusy] = useState<string | null>(null);
  const i = q.data;
  if (!windowId && !targets.length) return null;
  const shown = IMPACT_GROUPS.filter((g) => i && i.groups[g].total + i.groups[g].hidden > 0);
  const total = i ? shown.reduce((n, g) => n + i.groups[g].total + i.groups[g].hidden, 0) : 0;
  const monitors = (i?.groups.monitors.items ?? []) as ImpactMonitor[];
  const addable = monitors.filter((m) => m.canAdd);
  const notifiable = (i?.contacts ?? []).filter((c) => c.notifiable).length;
  const summary = i
    ? shown
        .filter((g) => g !== 'monitors')
        .slice(0, 4)
        .map((g) => t(`maintenance.impactView.count.${g}`, { count: i.groups[g].total + i.groups[g].hidden }))
        .join(' · ')
    : '';
  const goesDown = monitors.filter((m) => m.expect === 'down').length;
  const goesOff = monitors.filter((m) => m.expect === 'off').length;

  const act = async (what: 'downtime' | 'include' | 'notify') => {
    if (!windowId) return;
    setBusy(what);
    try {
      if (what === 'notify') {
        const r = await post<ImpactNotifyResult>(`/maintenance-windows/${windowId}/impact/notify`, {});
        notifyOk(r.already ? t('maintenance.impactView.notifiedBefore') : t('maintenance.impactView.notified', { count: r.recipients }));
      } else {
        const r = await post<ImpactDowntimeResult>(`/maintenance-windows/${windowId}/impact/downtime`, { mode: what });
        notifyOk(
          t(what === 'downtime' ? 'maintenance.impactView.downtimeMade' : 'maintenance.impactView.included', { count: r.added }) +
            (r.skipped ? ` ${t('maintenance.impactView.skipped', { count: r.skipped })}` : ''),
        );
        void qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
        if (what === 'downtime') onWindow?.(r.window.id);
      }
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <CollapsibleSection
      id={windowId ? 'maintenance-impact' : 'maintenance-impact-form'}
      testId="maintenance-impact"
      order={3}
      size="h5"
      title={t('maintenance.impactView.title')}
      count={i ? total : undefined}
      summary={
        <Text size="xs" c="dimmed">
          {q.isLoading ? t('maintenance.impactView.loading') : summary}
        </Text>
      }
      tone={goesDown ? 'warning' : undefined}
      defaultOpen={!!windowId}
      description={t('maintenance.impactView.help')}
    >
      {q.isError && <Alert color="red">{(q.error as Error).message}</Alert>}
      {i && (
        <Stack gap="sm">
          {total === 0 && (
            <Text size="sm" c="dimmed" data-testid="impact-empty">
              {t('maintenance.impactView.nothing')}
            </Text>
          )}
          {i.truncated && (
            <Text size="xs" c="dimmed" data-testid="impact-truncated">
              {t('maintenance.impactView.truncated')}
            </Text>
          )}
          {monitors.length > 0 && (
            <Text size="sm" data-testid="impact-monitor-summary">
              {t('maintenance.impactView.monitorSummary', { down: goesDown, off: goesOff, count: monitors.length })}
            </Text>
          )}
          {(onIncludeMonitors || canEdit) && addable.length > 0 && (
            <Group gap="xs" wrap="wrap">
              {onIncludeMonitors && (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => onIncludeMonitors(addable.map((m) => m.id))}
                  data-testid="impact-include-monitors"
                >
                  {t('maintenance.impactView.includeMonitors', { count: addable.length })}
                </Button>
              )}
              {canEdit && windowId && (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconCalendarPause size={14} />}
                  loading={busy === 'downtime'}
                  onClick={() => void act('downtime')}
                  data-testid="impact-add-downtime"
                >
                  {t('maintenance.impactView.addDowntime', { count: addable.filter((m) => m.expect !== 'downtime').length })}
                </Button>
              )}
              {canEdit && windowId && kind === 'maintenance' && (
                <Button size="xs" variant="default" loading={busy === 'include'} onClick={() => void act('include')} data-testid="impact-include-window">
                  {t('maintenance.impactView.includeInWindow', { count: addable.length })}
                </Button>
              )}
            </Group>
          )}
          {shown.map((g) => (
            <CollapsibleSection
              key={g}
              id={`impact-${g}`}
              testId={`impact-${g}`}
              order={4}
              size="h6"
              title={t(`maintenance.impactView.groups.${g}`)}
              count={i.groups[g].total + i.groups[g].hidden}
              defaultOpen={i.groups[g].total <= 8}
              collapseOnPhone
            >
              <List size="sm" spacing={4} listStyleType="none" pl={0}>
                {i.groups[g].items.map((x) => (
                  <ItemLine key={x.id} item={x} group={g} />
                ))}
              </List>
              {i.groups[g].total > i.groups[g].items.length && (
                <Text size="xs" c="dimmed">
                  {t('maintenance.impactView.more', { count: i.groups[g].total - i.groups[g].items.length })}
                </Text>
              )}
              {i.groups[g].hidden > 0 && (
                <Text size="xs" c="dimmed" data-testid={`impact-${g}-hidden`}>
                  {t('maintenance.impactView.hidden', { count: i.groups[g].hidden })}
                </Text>
              )}
            </CollapsibleSection>
          ))}
          {i.contacts.length > 0 && (
            <CollapsibleSection
              id="impact-contacts"
              testId="impact-contacts"
              order={4}
              size="h6"
              title={t('maintenance.impactView.contacts')}
              count={i.contacts.length}
              defaultOpen={i.contacts.length <= 8}
              collapseOnPhone
              actions={
                canEdit &&
                windowId &&
                notifiable > 0 && (
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconBellRinging size={12} />}
                    loading={busy === 'notify'}
                    onClick={() => void act('notify')}
                    data-testid="impact-notify"
                  >
                    {t('maintenance.impactView.notify', { count: notifiable })}
                  </Button>
                )
              }
            >
              <List size="sm" spacing={4} listStyleType="none" pl={0}>
                {i.contacts.map((c) => (
                  <List.Item key={c.subject}>
                    <Text size="sm" span>
                      {c.label}
                    </Text>
                    {!c.notifiable && (
                      <Text size="xs" c="dimmed" span>
                        {' '}
                        · {t('maintenance.impactView.notNotifiable')}
                      </Text>
                    )}
                    {c.of.length > 0 && (
                      <Text size="xs" c="dimmed">
                        {c.of.join(', ')}
                      </Text>
                    )}
                  </List.Item>
                ))}
              </List>
            </CollapsibleSection>
          )}
        </Stack>
      )}
    </CollapsibleSection>
  );
}
