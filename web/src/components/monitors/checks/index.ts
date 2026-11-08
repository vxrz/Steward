import { createElement, type ComponentType } from 'react';
import type { CheckType } from '@sm/shared';
import { CheckmkFields } from './CheckmkFields';
import { CostCheckFields } from '../../costs/CostCheckFields';
import { DataContractFields } from './DataContractFields';
import { DatabaseFields } from './DatabaseFields';
import { DbSchemaFields } from './DbSchemaFields';
import { DependencyTrackFields } from './DependencyTrackFields';
import { DynamoDbFields } from './DynamoDbFields';
import { EntraFields } from './EntraFields';
import { FreshnessCheckFields } from './FreshnessCheckFields';
import { GatusFields } from './GatusFields';
import { GitFields } from './GitFields';
import { HeartbeatFields } from './HeartbeatFields';
import { HttpFields } from './HttpFields';
import { KafkaConnectFields } from './KafkaConnectFields';
import { KafkaFields } from './KafkaFields';
import { KubernetesFields } from './KubernetesFields';
import { MqttFields } from './MqttFields';
import { PageWatchCheckFields } from './PageWatchCheckFields';
import { PingFields } from './PingFields';
import { PlatformCheckFields } from './PlatformCheckFields';
import { PrivilegeVaultFields } from './PrivilegeVaultFields';
import { PrometheusFields } from './PrometheusFields';
import { SnowflakeFields } from './SnowflakeFields';
import { SubMonitorFields } from './SubMonitorFields';
import { TcpFields } from './TcpFields';
import { VersionBehindFields } from './VersionBehindFields';
import type { CheckFieldsProps } from './common';

/**
 * The web side of the check types (shared/src/checkTypes.ts): the fields of each type's form, between the name and id
 * and the schedule. A typed record: a check type without a form does not compile.
 */
export const CHECK_FIELDS: { [T in CheckType]: ComponentType<CheckFieldsProps<T>> } = {
  ping: PingFields,
  tcp: TcpFields,
  http: HttpFields,
  platform: PlatformCheckFields,
  freshness: FreshnessCheckFields,
  heartbeat: HeartbeatFields,
  gatus: GatusFields,
  checkmk: CheckmkFields,
  prometheus: PrometheusFields,
  kubernetes: KubernetesFields,
  git: GitFields,
  kafka: KafkaFields,
  'kafka-connect': KafkaConnectFields,
  mqtt: MqttFields,
  snowflake: SnowflakeFields,
  database: DatabaseFields,
  dynamodb: DynamoDbFields,
  'db-schema': DbSchemaFields,
  cost: CostCheckFields,
  'data-contract': DataContractFields,
  'dependency-track': DependencyTrackFields,
  'version-behind': VersionBehindFields,
  entra: EntraFields,
  'privilege-vault': PrivilegeVaultFields,
  'page-watch': PageWatchCheckFields,
  monitor: SubMonitorFields,
};

/** The form of a check's type, for a check of any type (the record's key is the check's type). */
export function CheckFields(props: CheckFieldsProps) {
  return createElement(CHECK_FIELDS[props.c.type] as ComponentType<CheckFieldsProps>, props);
}
