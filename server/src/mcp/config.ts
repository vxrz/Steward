/**
 * Configuration of the MCP server (docs/MCP.md): off by default; an administrator turns it on in the
 * settings (stored as the internal setting "mcp.enabled"). SM_MCP=off turns it off for good,
 * whatever the setting says. Limits come from environment variables with safe defaults.
 */
import type { McpServerStatus } from '@sm/shared';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { readSetting, writeSetting } from '../settings.js';

/** Endpoint of the Streamable HTTP transport. */
export const MCP_PATH = '/api/mcp';

/** Modern protocol revisions: version and capabilities in every request's `_meta`, no handshake. */
export const MODERN_VERSIONS = ['2026-07-28'] as const;
/** Legacy revisions with the `initialize` handshake (served statelessly, without sessions). */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18'] as const;
export const SUPPORTED_VERSIONS: string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

/** Largest accepted HTTP request body (a JSON-RPC message with tool arguments is a few kB). */
export const MAX_REQUEST_BYTES = 64 * 1024;
/** Largest serialized tool result (JSON text); bigger results are cut down or refused with a hint to page. */
export const MAX_RESULT_CHARS = 200_000;
/** Largest platform response the gateway reads. */
export const MAX_GATEWAY_RESPONSE_BYTES = 512 * 1024;
/** Time limit of one tool call (platform calls have their own, shorter limit). */
export const TOOL_TIMEOUT_MS = 30_000;
export const GATEWAY_TIMEOUT_MS = 20_000;

const OFF = ['off', '0', 'false', 'no', 'disabled'];
const SETTING = 'mcp.enabled';

const warned = new Set<string>();
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  if (!warned.has(name)) {
    warned.add(name);
    logger.warn(`${name}="${raw}" is not a positive whole number – using ${fallback}`);
  }
  return fallback;
}

/** SM_MCP=off: the MCP endpoint is off whatever the setting says. */
export function mcpForcedOff(): boolean {
  return OFF.includes((process.env.SM_MCP ?? '').trim().toLowerCase());
}

export function mcpEnabled(): boolean {
  if (mcpForcedOff()) return false;
  try {
    return readSetting<boolean>(SETTING, false) === true;
  } catch {
    return false; // database not ready
  }
}

export function setMcpEnabled(enabled: boolean): void {
  const before = readSetting<boolean>(SETTING, false) === true;
  writeSetting(SETTING, enabled);
  if (before !== enabled) {
    audit({
      action: 'mcp.settings_changed',
      entityType: 'settings',
      entityId: 'mcp',
      summary: `MCP server ${enabled ? 'turned on' : 'turned off'}`,
      details: { enabled, previous: before },
    });
  }
}

const RUN_REQUESTS = 'mcp.runRequests';

/** Assistants may ask to start runs, each confirmed by the token owner (#11, default off). */
export function mcpRunRequests(): boolean {
  try {
    return readSetting<boolean>(RUN_REQUESTS, false) === true;
  } catch {
    return false;
  }
}

export function setMcpRunRequests(on: boolean): void {
  const before = mcpRunRequests();
  writeSetting(RUN_REQUESTS, on);
  if (before !== on)
    audit({
      action: 'mcp.settings_changed',
      entityType: 'settings',
      entityId: 'mcp',
      summary: `Run requests from AI assistants ${on ? 'allowed (each confirmed by the token owner)' : 'turned off'}`,
      details: { runRequests: on, previous: before },
    });
}

/** Requests per minute and token on the MCP endpoint (SM_MCP_RATE_LIMIT, default 120). */
export const mcpRateLimit = () => intEnv('SM_MCP_RATE_LIMIT', 120);
/** Gateway calls per minute, user and platform (SM_MCP_GATEWAY_RATE_LIMIT, default 30). */
export const gatewayRateLimit = () => intEnv('SM_MCP_GATEWAY_RATE_LIMIT', 30);
/** Gateway calls in flight per platform (SM_MCP_GATEWAY_CONCURRENCY, default 2; at most half the platform's http.maxConcurrency). */
export const gatewayConcurrency = () => intEnv('SM_MCP_GATEWAY_CONCURRENCY', 2);

/**
 * Origins a browser-based MCP client may send (DNS-rebinding protection): Steward's own origin(s) and
 * SM_MCP_ALLOWED_ORIGINS (comma-separated). Desktop clients send no Origin header at all.
 */
export function extraAllowedOrigins(): string[] {
  const out: string[] = [];
  for (const raw of [config.publicUrl, ...(process.env.SM_MCP_ALLOWED_ORIGINS ?? '').split(',')]) {
    const v = raw?.trim();
    if (!v) continue;
    try {
      out.push(new URL(v).origin);
    } catch {
      /* ignore invalid entries */
    }
  }
  return out;
}

/** For the settings page and the profile page (signed-in users). */
export function mcpServerStatus(): McpServerStatus {
  return {
    enabled: mcpEnabled(),
    forcedOff: mcpForcedOff(),
    path: MCP_PATH,
    protocolVersions: SUPPORTED_VERSIONS,
    rateLimitPerMinute: mcpRateLimit(),
    gatewayRateLimitPerMinute: gatewayRateLimit(),
    runRequests: mcpRunRequests(),
  };
}
