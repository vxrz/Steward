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
  IconShieldCheck,
  IconUserShield,
  IconLock,
  IconDatabase,
  IconTable,
  IconSchema,
  IconArrowsExchange,
  IconArrowBigUpLines,
  IconFileDiff,
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
  'kafka-connect': IconArrowsExchange,
  mqtt: IconAntenna,
  snowflake: IconSnowflake,
  database: IconDatabase,
  dynamodb: IconTable,
  'db-schema': IconSchema,
  'dependency-track': IconShieldCheck,
  'version-behind': IconArrowBigUpLines,
  entra: IconUserShield,
  'privilege-vault': IconLock,
  'page-watch': IconFileDiff,
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
  'kafka-connect': 'Connectors running',
  mqtt: 'MQTT topics',
  snowflake: 'Snowflake table fresh',
  database: 'Database reachable',
  dynamodb: 'DynamoDB table fresh',
  'db-schema': 'No breaking schema change',
  'dependency-track': 'No critical vulnerabilities',
  'version-behind': 'Tech stack up to date',
  entra: 'App credentials valid',
  'privilege-vault': 'Vault hygiene',
  'page-watch': 'Vendor pages watched',
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
    case 'kafka-connect':
      return { ...base, name, type, platform: '', notRunningAs: 'down', pausedAs: 'degraded', failedMinutes: 10, quietAs: 'degraded' } as CheckDef;
    case 'mqtt':
      return { ...base, name, type, platform: '', topic: '', mode: 'any', withinMinutes: 15, quietAs: 'down' } as CheckDef;
    case 'snowflake':
      return { ...base, name, type, platform: '', mode: 'freshness', object: '', maxAgeMinutes: 1440, failAs: 'down' } as CheckDef;
    case 'database':
      return { ...base, name, type, platform: '', mode: 'connection', direction: 'above', noData: 'unknown' } as CheckDef;
    case 'dynamodb':
      return {
        ...base,
        name,
        type,
        platform: '',
        table: '',
        mode: 'newestItem',
        partitionKeyType: 'S',
        partitionValues: [],
        timeFormat: 'auto',
        freshnessMode: 'cadence',
        expectedIntervalSeconds: 300,
        activeTable: 'required',
        pointInTimeRecovery: 'report',
        timeToLive: 'report',
        failAs: 'degraded',
      } as CheckDef;
    case 'db-schema':
      return { ...base, name, type, platform: '', mode: 'breaking', withinHours: 24, read: false, noData: 'unknown' } as CheckDef;
    case 'dependency-track':
      return { ...base, name, type, platform: '', project: '', maxCritical: 0, policyFail: true, failAs: 'down' } as CheckDef;
    case 'version-behind':
      return { ...base, name, type, application: '', maxMinors: 2, majorAs: 'down', eolAs: 'down' } as CheckDef;
    case 'entra':
      return { ...base, name, type, platform: '', mode: 'app-credentials', withinDays: 30, downWithinDays: 7 } as CheckDef;
    case 'privilege-vault':
      return {
        ...base,
        name,
        type,
        platform: '',
        maxAgeDays: 90,
        privilegedFolders: [],
        privilegedTemplates: [],
        maxFindings: 0,
        failAs: 'degraded',
      } as CheckDef;
    case 'page-watch':
      return { ...base, name, type, platform: '', changedWithinHours: 24, changedAs: 'up', failingAs: 'degraded', pausedAs: 'ignore' } as CheckDef;
    case 'monitor':
      return { ...base, name, type, monitor: '' } as CheckDef;
  }
}
