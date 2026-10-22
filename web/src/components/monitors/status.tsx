import { Badge, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { CHECK_TYPE_INFO, MONITOR_STATUS_INFO, type CauseRef, type CheckType, type MonitorStatus, type UptimeSet } from '@sm/shared';
import i18n from '../../i18n';
import { numberFormat } from '../../format';

export const MONITOR_COLORS: Record<MonitorStatus, string> = {
  up: 'green',
  degraded: 'yellow',
  down: 'red',
  unknown: 'gray',
  blocked: 'orange',
  maintenance: 'blue',
};

/** English defaults; the UI shows monitors:status.<status>. */
const MONITOR_LABELS: Record<MonitorStatus, string> = {
  up: 'Up',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown',
  blocked: 'Blocked',
  maintenance: 'Maintenance',
};

const tx = (key: string, defaultValue: string, vars?: Record<string, unknown>): string => i18n.t(key as 'common:add', { defaultValue, ...vars }) as string;

/** "Down", "Ausgefallen" … */
export const monitorStatusLabel = (s: MonitorStatus): string => tx(`monitors:status.${s}`, MONITOR_LABELS[s]);
/** Lower-case form for counts ("2 down", "2 ausgefallen"). */
export const monitorStatusLower = (s: MonitorStatus): string => tx(`monitors:statusLower.${s}`, MONITOR_LABELS[s].toLowerCase());
/** Explanation of a status (tooltip), from MONITOR_STATUS_INFO in shared. */
export const monitorStatusInfo = (s: MonitorStatus): string => tx(`monitors:statusInfo.${s}`, MONITOR_STATUS_INFO[s]);
/** Name and help of a check type, from CHECK_TYPE_INFO in shared via monitors:checkTypes.<type>. */
export const checkTypeLabel = (t: CheckType): string => tx(`monitors:checkTypes.${t}.label`, CHECK_TYPE_INFO[t].label);
export const checkTypeHelp = (t: CheckType): string => tx(`monitors:checkTypes.${t}.help`, CHECK_TYPE_INFO[t].help);

export function MonitorStatusBadge({ status, size = 'sm', variant = 'filled' }: { status: MonitorStatus; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; variant?: 'filled' | 'light' | 'outline' }) {
  useTranslation('monitors'); // re-render on a language switch
  return (
    <Tooltip label={monitorStatusInfo(status)} withArrow>
      <Badge color={MONITOR_COLORS[status]} size={size} variant={variant} data-status={status}>
        {monitorStatusLabel(status)}
      </Badge>
    </Tooltip>
  );
}

export const fmtUptime = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '–';
  const digits = v >= 99.99 || v === 0 ? 0 : 2;
  return `${numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)} %`;
};

export function uptimeText(u: UptimeSet): string {
  return tx('monitors:uptime.all', '24 h {{h24}} · 7 d {{d7}} · 30 d {{d30}}', { h24: fmtUptime(u.h24), d7: fmtUptime(u.d7), d30: fmtUptime(u.d30) });
}

export const causeText = (c: CauseRef, currentMonitorId?: string): string => (c.monitorId === currentMonitorId ? c.checkName : `${c.monitorName} › ${c.checkName}`);
