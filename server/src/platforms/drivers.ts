import type { Platform, PlatformKind } from '@sm/shared';
import { snowflakeJwtHint } from './jwt.js';

/**
 * The server side of the platform kinds (0.11.0, docs/ARCHITECTURE.md#adding-a-platform-kind): what a connector does
 * differently from a plain HTTP API. The descriptor in shared/src/platformKinds.ts says what a kind is; this map holds
 * the code. A kind without an entry is tested with GET on its test path. The connectors' modules are imported lazily,
 * so an installation that never uses Kafka never loads its client.
 */

export interface DriverCheck {
  name: string;
  ok: boolean;
  message: string;
}

/** The answer of a connector's own connection test. */
export interface OwnTestResult {
  ok: boolean;
  message: string;
  checks?: DriverCheck[];
}

export interface ConnectionTestDriver {
  run: (p: Platform, secrets: Record<string, string>) => Promise<OwnTestResult>;
  /** The result shows when the cached access token was issued */
  token?: boolean;
  /** The platform answers no HTTP status (a database): a passing test shows none */
  noStatus?: boolean;
  /** Words added to the message of a failing test (the usual causes) */
  failureHint?: (message: string, p: Platform) => string;
}

export interface PlatformDriver {
  /** "Test connection" (kinds whose descriptor says connectionTest: 'own') */
  test?: ConnectionTestDriver;
}

/** A test that passes unless it throws (the message says what it found). */
const passes = (r: string | { message: string; checks?: DriverCheck[] }): OwnTestResult =>
  typeof r === 'string' ? { ok: true, message: r } : { ok: true, message: r.message, ...(r.checks ? { checks: r.checks } : {}) };

export const DRIVERS: Partial<Record<PlatformKind, PlatformDriver>> = {
  // Microsoft Graph (v0.5.0): the sign-in, the admin consent and every part Steward reads, with what is missing
  'microsoft-graph': { test: { run: async (p, s) => (await import('../entra/service.js')).testGraph(p, s), token: true } },
  // LLM gateways (0.6.0): the model list and one minimal request per model that is set up
  'llm-gateway': { test: { run: async (p, s) => (await import('../ai/gateway.js')).testGateway(p, s), token: true } },
  // database platforms (0.7.0): sign-in, the read-only session, whether the account can write, the catalog queries
  database: { test: { run: async (p, s) => (await import('../dbms/service.js')).testDatabase(p, s), token: true, noStatus: true } },
  // Kafka (#112) and MQTT (#113) are no HTTP APIs: their test connects to the cluster or broker
  kafka: { test: { run: async (p, s) => passes(await (await import('../kafka/service.js')).testKafka(p, s)) } },
  mqtt: { test: { run: async (p, s) => passes(await (await import('../mqtt/listener.js')).testMqtt(p, s)) } },
  // AWS (#116) asks STS who it is, then every part Steward reads, with what is missing (the test passes when STS works)
  aws: { test: { run: async (p, s) => passes(await (await import('../aws/service.js')).testAws(p, s)) } },
  snowflake: {
    test: {
      run: async (p, s) => passes(await (await import('../snowflake/service.js')).testSnowflake(p, s)),
      // Snowflake's "390144 JWT token is invalid" says nothing about why: the usual causes
      failureHint: (message, p) => snowflakeJwtHint(message, p.config.variables),
    },
  },
  // IBM Verify Privilege Vault (#205): signs in, then every read Steward makes, naming missing permissions
  'privilege-vault': { test: { run: async (p, s) => passes(await (await import('../pvault/service.js')).testPrivilegeVault(p, s)), token: true } },
  // InfluxDB (0.18.0): the version's ping or health endpoint, then a request that needs the credentials
  influxdb: { test: { run: async (p, s) => passes(await (await import('../influx/client.js')).testInflux(p, s)) } },
  // container registries (#241): the token flow and the tags of a test image
  'container-registry': { test: { run: async (p, s) => passes(await (await import('../versions/sources.js')).testRegistry(p, s)) } },
};

/** The driver of a kind; own connector types have none. */
export const driverOf = (kind: string): PlatformDriver | undefined => (Object.hasOwn(DRIVERS, kind) ? DRIVERS[kind as PlatformKind] : undefined);
