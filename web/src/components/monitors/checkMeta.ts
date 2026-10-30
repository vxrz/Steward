import {
  IconActivityHeartbeat,
  IconApi,
  IconBroadcast,
  IconChartDots3,
  IconClockHour4,
  IconFlame,
  IconBox,
  IconGitBranch,
  IconTopologyStar3,
  IconAntenna,
  IconHierarchy2,
  IconNetwork,
  IconPlugConnected,
  IconWorldWww,
  IconSnowflake,
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
  checkmk: IconChartDots3,
  prometheus: IconFlame,
  kubernetes: IconBox,
  git: IconGitBranch,
  kafka: IconTopologyStar3,
  mqtt: IconAntenna,
  snowflake: IconSnowflake,
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
  checkmk: 'CheckMk service',
  prometheus: 'Prometheus query',
  kubernetes: 'Kubernetes deployments',
  git: 'Repository pipeline',
  kafka: 'Kafka topic',
  mqtt: 'MQTT topics',
  snowflake: 'Snowflake table fresh',
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
    case 'checkmk':
      return { ...base, name, type, platform: '', host: '' } as CheckDef;
    case 'prometheus':
      return { ...base, name, type, platform: '', query: '', direction: 'above', crit: 90, noData: 'unknown' } as CheckDef;
    case 'kubernetes':
      return { ...base, name, type, platform: '', namespace: '' } as CheckDef;
    case 'git':
      return { ...base, name, type, platform: '', repository: '', failedAs: 'down' } as CheckDef;
    case 'kafka':
      return { ...base, name, type, platform: '', topic: '', messagesWithinMinutes: 15, quietAs: 'down', stuckMinutes: 15 } as CheckDef;
    case 'mqtt':
      return { ...base, name, type, platform: '', topic: '', mode: 'any', withinMinutes: 15, quietAs: 'down' } as CheckDef;
    case 'snowflake':
      return { ...base, name, type, platform: '', mode: 'freshness', object: '', maxAgeMinutes: 1440, failAs: 'down' } as CheckDef;
    case 'monitor':
      return { ...base, name, type, monitor: '' } as CheckDef;
  }
}
