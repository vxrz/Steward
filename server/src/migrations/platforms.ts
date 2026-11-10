import type { NamedMigration } from '../db.js';
import { pgDdl } from '../database/sql.js';

/** platforms-005 (0.9.0, ADR 0009): identities – several sets of credentials per platform. */
const IDENTITIES_DDL = `
  CREATE TABLE platform_identities (
    id TEXT PRIMARY KEY,
    platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    auth TEXT,
    variables TEXT NOT NULL DEFAULT '{}',
    secrets TEXT,
    acl TEXT NOT NULL DEFAULT '[]',
    read_only INTEGER NOT NULL DEFAULT 0,
    privileged INTEGER NOT NULL DEFAULT 0,
    operation_filter TEXT,
    mcp TEXT NOT NULL DEFAULT '{"mode":"off"}',
    credential_source TEXT,
    config_mac TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE UNIQUE INDEX platform_identities_name ON platform_identities(platform_id, lower(name));
  CREATE UNIQUE INDEX platform_identities_default ON platform_identities(platform_id) WHERE is_default = 1;
`;

/**
 * One default identity per platform: id pi_ + the random part of the platform id (platforms/identities.ts
 * defaultIdentityId), the ciphertext of platforms.secrets copied unchanged (the vault encrypts without context), the MCP
 * mode from config.mcpGateway. Not sealed: the one-time step after the next unlock (platforms/integrity.ts
 * createPlatformIdentities) seals it and empties platforms.secrets – only for platforms whose seal is intact.
 */
const identitiesInsert = (enabled: string, writes: string) => `
  INSERT INTO platform_identities (id, platform_id, name, description, is_default, auth, variables, secrets, acl, read_only, privileged,
    operation_filter, mcp, credential_source, config_mac, created_at, created_by, updated_at, updated_by)
  SELECT CASE WHEN substr(id, 1, 3) = 'pf_' THEN 'pi_' || substr(id, 4) ELSE 'pi_' || id END,
    id, 'Default', '', 1, NULL, '{}', secrets, '[]', 0, 0, NULL,
    CASE
      WHEN ${enabled} AND ${writes} IN ('confirm', 'fourEyes') THEN '{"mode":"writes","writes":"' || ${writes} || '"}'
      WHEN ${enabled} THEN '{"mode":"read"}'
      WHEN ${writes} IN ('confirm', 'fourEyes') THEN '{"mode":"off","writes":"' || ${writes} || '"}'
      ELSE '{"mode":"off"}'
    END,
    NULL, NULL, created_at, 'system', updated_at, 'system'
  FROM platforms;
`;

/**
 * Platforms and their API specifications.
 * - platforms-004: what Steward last read from a Kafka Connect cluster (0.9.0, #223, kafkaconnect/service.ts): connectors,
 *   tasks and plugins – never a connector configuration.
 * - platforms-005: identities (0.9.0, #228, ADR 0009) – one default identity per platform, no change in behaviour.
 * - platforms-006: choosing identities (0.13.0, ADR 0009 step 2) – the identity per connection slot of schedules and
 *   webhook triggers (JSON slot → identity id; '{}': every slot uses the default identity, as before) and the identity
 *   of an MCP request waiting for approval (NULL: the default identity).
 * - platforms-007: disabled identities (0.13.0, ADR 0009) – an identity that was added or changed outside Steward is kept
 *   disabled when an administrator confirms the platform's settings, until enabled one by one.
 * - platforms-003: the periodic connection test of a platform (v0.4.0, platforms/health.ts): off by default.
 * - platforms-002: recorded responses for test runs (#105).
 * - platforms-001: the path prefix of an API specification (the path of its server URL, editable per spec). NULL for
 *   specs imported before: their prefix is derived from server_url when read (platforms/service.ts, specPrefix).
 */
export const PLATFORM_MIGRATIONS: NamedMigration[] = [
  {
    name: 'platforms-001-spec-path-prefix',
    sql: `ALTER TABLE platform_specs ADD COLUMN path_prefix TEXT;`,
  },
  {
    // Recorded responses (#105): answers that test runs use instead of the platform
    name: 'platforms-002-recordings',
    sql: `
      CREATE TABLE platform_recordings (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        query TEXT NOT NULL DEFAULT '{}',
        body_match TEXT,
        status INTEGER NOT NULL,
        headers TEXT NOT NULL DEFAULT '{}',
        body TEXT,
        note TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX platform_recordings_platform ON platform_recordings(platform_id, method);
    `,
  },
  {
    // Platform health (v0.4.0): an optional periodic connection test; failures notify the platform's managers
    name: 'platforms-003-health',
    sql: `
      CREATE TABLE platform_health (
        platform_id TEXT PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        last_run_at TEXT,
        failing_since TEXT,
        notified_at TEXT,
        updated_by TEXT,
        updated_at TEXT
      );
    `,
  },
  {
    // Kafka Connect (0.9.0, #223): the last readout per platform (no configuration) and the Kafka platform it was linked to
    name: 'platforms-004-kafka-connect',
    sql: `
      CREATE TABLE kafka_connect_readouts (
        platform_id TEXT PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
        kafka_platform_id TEXT,
        readout TEXT NOT NULL,
        read_at TEXT NOT NULL,
        read_by TEXT NOT NULL
      );
    `,
  },
  {
    // Identities (0.9.0, #228, ADR 0009): additive – platforms.secrets stays (emptied by the one-time step after unlock)
    name: 'platforms-005-identities',
    sql: IDENTITIES_DDL + identitiesInsert("json_extract(config, '$.mcpGateway.enabled') = 1", "json_extract(config, '$.mcpGateway.writes')"),
    pg: pgDdl(IDENTITIES_DDL) + identitiesInsert("(config::jsonb #>> '{mcpGateway,enabled}') = 'true'", "(config::jsonb #>> '{mcpGateway,writes}')"),
  },
  {
    // Choosing identities (0.13.0, ADR 0009 step 2): additive, nothing changes until someone names another identity
    name: 'platforms-006-identity-choices',
    sql: `
      ALTER TABLE schedules ADD COLUMN identities TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE webhook_triggers ADD COLUMN identities TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE mcp_requests ADD COLUMN identity_id TEXT;
    `,
  },
  {
    // Disabled identities (0.13.0, ADR 0009): additive, 0 = active (every identity so far)
    name: 'platforms-007-identity-disabled',
    sql: `ALTER TABLE platform_identities ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;`,
  },
];
