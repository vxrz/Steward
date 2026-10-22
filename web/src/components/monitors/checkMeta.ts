import { IconActivityHeartbeat, IconApi, IconBroadcast, IconClockHour4, IconHierarchy2, IconNetwork, IconPlugConnected, IconWorldWww } from '@tabler/icons-react';
import type { CheckDef, CheckType } from '@sm/shared';

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

/** A new check of the given type with sensible defaults. */
export function newCheck(type: CheckType, id: string): CheckDef {
  const base = { id, name: '' };
  switch (type) {
    case 'ping':
      return { ...base, name: 'Host reachable', type, host: '' } as CheckDef;
    case 'tcp':
      return { ...base, name: 'Port open', type, host: '', port: 502 } as CheckDef;
    case 'http':
      return { ...base, name: 'HTTP endpoint', type, url: 'https://', method: 'GET' } as CheckDef;
    case 'platform':
      return { ...base, name: 'Platform API', type, platform: '', method: 'GET', path: '/' } as CheckDef;
    case 'freshness':
      return { ...base, name: 'Data in Insights Hub', type, source: 'insightsHub', platform: '', assetId: '', aspect: '', variables: [], mode: 'cadence', expectedIntervalSeconds: 60 } as CheckDef;
    case 'heartbeat':
      return { ...base, name: 'Data reported by the gateway', type, mode: 'cadence', expectedIntervalSeconds: 60, authMode: 'token' } as CheckDef;
    case 'gatus':
      return { ...base, name: 'Gatus endpoint', type, platform: '', endpointKey: '' } as CheckDef;
    case 'monitor':
      return { ...base, name: 'Sub-monitor', type, monitor: '' } as CheckDef;
  }
}
