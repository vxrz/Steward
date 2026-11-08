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
  IconCoin,
  IconContract,
} from '@tabler/icons-react';
import { CHECK_TYPE_DEFS, type CheckDef, type CheckType } from '@sm/shared';
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
  cost: IconCoin,
  'data-contract': IconContract,
  'dependency-track': IconShieldCheck,
  'version-behind': IconArrowBigUpLines,
  entra: IconUserShield,
  'privilege-vault': IconLock,
  'page-watch': IconFileDiff,
  monitor: IconHierarchy2,
};

/** A new check of the given type with sensible defaults (the type's descriptor); its name in the UI language (monitors:newCheck.<type>). */
export function newCheck(type: CheckType, id: string): CheckDef {
  const d = CHECK_TYPE_DEFS[type];
  const name = i18n.t(`monitors:newCheck.${type}` as 'common:add', { defaultValue: d.defaultName }) as string;
  return { id, name, type, ...structuredClone(d.defaults) } as CheckDef;
}
