import {
  IconActivityHeartbeat,
  IconApi,
  IconBroadcast,
  IconClockHour4,
  IconHierarchy2,
  IconNetwork,
  IconPlugConnected,
  IconWorldWww,
} from '@tabler/icons-react';
import type { CheckDef, CheckType } from '@sm/shared';
import i18n from '../../i18n';

export const CHECK_ICONS: Record<CheckType, typeof IconApi> = {
  ping: IconBroadcast,
  tcp: IconPlugConnected,
  http: IconWorldWww,
  platform: IconApi,
  freshness: IconClockHour4,
  heartbeat: IconActivityHeartbeat,
  gatus: IconNetwork,
  monitor: IconHierarchy2,
};

/** English default names of new checks; the UI language's version is used (monitors:newCheck.<type>). */
const DEFAULT_NAMES: Record<CheckType, string> = {
  ping: 'Host reachable',
  tcp: 'Port open',
  http: 'HTTP endpoint',
  platform: 'Platform API',
  freshness: 'Data in Insights Hub',
  heartbeat: 'Data reported by the gateway',
  gatus: 'Gatus endpoint',
  monitor: 'Sub-monitor',
};

/** A new check of the given type with sensible defaults. */
export function newCheck(type: CheckType, id: string): CheckDef {
  const base = { id, name: '' };
  const name = i18n.t(`monitors:newCheck.${type}` as 'common:add', { defaultValue: DEFAULT_NAMES[type] }) as string;
  switch (type) {
    case 'ping':
      return { ...base, name, type, host: '' } as CheckDef;
    case 'tcp':
      return { ...base, name, type, host: '', port: 502 } as CheckDef;
    case 'http':
      return { ...base, name, type, url: 'https://', method: 'GET' } as CheckDef;
    case 'platform':
      return { ...base, name, type, platform: '', method: 'GET', path: '/' } as CheckDef;
    case 'freshness':
      return {
        ...base,
        name,
        type,
        source: 'insightsHub',
        platform: '',
        assetId: '',
        aspect: '',
        variables: [],
        mode: 'cadence',
        expectedIntervalSeconds: 60,
      } as CheckDef;
    case 'heartbeat':
      return { ...base, name, type, mode: 'cadence', expectedIntervalSeconds: 60, authMode: 'token' } as CheckDef;
    case 'gatus':
      return { ...base, name, type, platform: '', endpointKey: '' } as CheckDef;
    case 'monitor':
      return { ...base, name, type, monitor: '' } as CheckDef;
  }
}
