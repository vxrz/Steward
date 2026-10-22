import { Badge, Tooltip } from '@mantine/core';
import { MONITOR_STATUS_INFO, type CauseRef, type MonitorStatus, type UptimeSet } from '@sm/shared';

export const MONITOR_COLORS: Record<MonitorStatus, string> = {
  up: 'green',
  degraded: 'yellow',
  down: 'red',
  unknown: 'gray',
  blocked: 'orange',
  maintenance: 'blue',
};

export const MONITOR_LABELS: Record<MonitorStatus, string> = {
  up: 'Up',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown',
  blocked: 'Blocked',
  maintenance: 'Maintenance',
};

export function MonitorStatusBadge({ status, size = 'sm', variant = 'filled' }: { status: MonitorStatus; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; variant?: 'filled' | 'light' | 'outline' }) {
  return (
    <Tooltip label={MONITOR_STATUS_INFO[status]} withArrow>
      <Badge color={MONITOR_COLORS[status]} size={size} variant={variant} data-status={status}>
        {MONITOR_LABELS[status]}
      </Badge>
    </Tooltip>
  );
}

export const fmtUptime = (v: number | null | undefined): string => (v === null || v === undefined ? '–' : `${v.toFixed(v >= 99.99 || v === 0 ? 0 : 2)} %`);

export function uptimeText(u: UptimeSet): string {
  return `24 h ${fmtUptime(u.h24)} · 7 d ${fmtUptime(u.d7)} · 30 d ${fmtUptime(u.d30)}`;
}

export const causeText = (c: CauseRef, currentMonitorId?: string): string => (c.monitorId === currentMonitorId ? c.checkName : `${c.monitorName} › ${c.checkName}`);
