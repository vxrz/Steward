/**
 * Platform identities (0.9.0, #228, ADR 0009): several sets of credentials under one platform. Step 1 – every platform
 * has exactly one default identity, which holds the credentials and the MCP mode that used to sit on the platform row.
 *
 * This module only reads and maps rows; the seal is in integrity.ts, the resolver (getConnection) in service.ts.
 */
import type { IdentityMcp, McpGatewayConfig, McpWriteMode, PlatformIdentity } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';

export interface IdentityRow {
  id: string;
  platform_id: string;
  name: string;
  description: string;
  is_default: number | boolean;
  auth: string | null;
  variables: string;
  secrets: string | null;
  acl: string;
  read_only: number | boolean;
  privileged: number | boolean;
  operation_filter: string | null;
  mcp: string;
  credential_source: string | null;
  config_mac: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export const DEFAULT_IDENTITY_NAME = 'Default';

/**
 * The id of a platform's default identity: pi_ + the random part of the platform id. Deterministic, so the SQL
 * migration, migration packages and the caches (keyed per identity) agree on it.
 */
export function defaultIdentityId(platformId: string): string {
  return platformId.startsWith('pf_') ? `pi_${platformId.slice(3)}` : `pi_${platformId}`;
}

const WRITE_MODES = ['confirm', 'fourEyes'] as const;
const isWriteMode = (w: unknown): w is (typeof WRITE_MODES)[number] => typeof w === 'string' && (WRITE_MODES as readonly string[]).includes(w);

/** The MCP mode of the old platform setting config.mcpGateway (enabled, writes) – as the SQL migration maps it. */
export function mcpFromGateway(g: { enabled?: unknown; writes?: unknown } | undefined | null): IdentityMcp {
  const writes = isWriteMode(g?.writes) ? g.writes : undefined;
  if (g?.enabled === true) return writes ? { mode: 'writes', writes } : { mode: 'read' };
  return writes ? { mode: 'off', writes } : { mode: 'off' };
}

/** An identity's MCP mode as read from the database (anything unexpected counts as off). */
export function parseMcp(text: string | null | undefined): IdentityMcp {
  const m = parseJson<{ mode?: unknown; writes?: unknown }>(text, {});
  const writes = isWriteMode(m.writes) ? m.writes : undefined;
  if (m.mode === 'writes') return writes ? { mode: 'writes', writes } : { mode: 'read' };
  if (m.mode === 'read') return { mode: 'read' };
  return writes ? { mode: 'off', writes } : { mode: 'off' };
}

/** The MCP mode for a gateway setting as the existing route sends it ({ enabled, writes }). */
export function mcpFromSetting(enabled: boolean, writes: McpWriteMode): IdentityMcp {
  return mcpFromGateway({ enabled, writes });
}

/**
 * The platform's config.mcpGateway as the API and the gateway read it (unchanged since 0.8.0): `enabled` and `writes`
 * from the default identity, `allowedPathPrefixes` from the platform (they describe the API, not a credential).
 */
export function gatewayView(stored: McpGatewayConfig | undefined, mcp: IdentityMcp): McpGatewayConfig | undefined {
  const prefixes = stored?.allowedPathPrefixes;
  if (!stored && mcp.mode === 'off' && !mcp.writes) return undefined;
  return {
    enabled: mcp.mode !== 'off',
    ...(prefixes?.length ? { allowedPathPrefixes: prefixes } : {}),
    ...(mcp.writes ? { writes: mcp.writes } : {}),
  };
}

/** Whether the stored platform config still has the MCP mode (enabled, writes) that identities hold now. */
export function hasLegacyGateway(config: string): boolean {
  const g = parseJson<{ mcpGateway?: Record<string, unknown> }>(config, {}).mcpGateway;
  return !!g && typeof g === 'object' && ('enabled' in g || 'writes' in g);
}

/**
 * config with mcpGateway reduced to the platform's part (the path prefixes, possibly none – the key stays, so the API
 * shows { enabled: false } for a gateway that was turned off, as before).
 */
export function configWithoutMcpMode(config: string): string {
  const cfg = parseJson<Record<string, unknown>>(config, {});
  const g = cfg.mcpGateway as Record<string, unknown> | undefined;
  if (!g || typeof g !== 'object') return config;
  const prefixes = Array.isArray(g.allowedPathPrefixes) ? g.allowedPathPrefixes : [];
  const { mcpGateway: _gateway, ...others } = cfg;
  return JSON.stringify({ ...others, mcpGateway: { allowedPathPrefixes: prefixes } });
}

const flag = (v: number | boolean | null | undefined) => v === true || Number(v) === 1;

export function identityRows(platformId: string): IdentityRow[] {
  return db().all<IdentityRow>('SELECT * FROM platform_identities WHERE platform_id = ? ORDER BY is_default DESC, lower(name), id', platformId);
}

export function defaultIdentityRow(platformId: string): IdentityRow | undefined {
  return db().get<IdentityRow>('SELECT * FROM platform_identities WHERE platform_id = ? AND is_default = 1', platformId);
}

export function identityRow(platformId: string, identityId: string): IdentityRow | undefined {
  return db().get<IdentityRow>('SELECT * FROM platform_identities WHERE id = ? AND platform_id = ?', identityId, platformId);
}

/** The default identity of every platform (one query, for lists). */
export function defaultIdentityRows(): Map<string, IdentityRow> {
  return new Map(
    db()
      .all<IdentityRow>('SELECT * FROM platform_identities WHERE is_default = 1')
      .map((r) => [r.platform_id, r]),
  );
}

/** All identities of every platform, by platform (one query, for lists). */
export function allIdentityRows(): Map<string, IdentityRow[]> {
  const out = new Map<string, IdentityRow[]>();
  for (const r of db().all<IdentityRow>('SELECT * FROM platform_identities ORDER BY is_default DESC, lower(name), id')) {
    const list = out.get(r.platform_id) ?? [];
    list.push(r);
    out.set(r.platform_id, list);
  }
  return out;
}

/** Names and flags of an identity – never secrets, the sign-in settings or variables. */
export function toIdentity(r: IdentityRow, extra: { secretKeys: string[]; integrity: PlatformIdentity['integrity']; mayUse: boolean }): PlatformIdentity {
  const filter = parseJson<PlatformIdentity['operationFilter']>(r.operation_filter, null);
  return {
    id: r.id,
    platformId: r.platform_id,
    name: r.name,
    description: r.description,
    default: flag(r.is_default),
    readOnly: flag(r.read_only),
    privileged: flag(r.privileged),
    mcp: parseMcp(r.mcp),
    operationFilter:
      filter && (filter.preset === 'read' || filter.preset === 'chosen')
        ? { preset: filter.preset, operations: Array.isArray(filter.operations) ? filter.operations : [] }
        : null,
    ownSignIn: r.auth !== null && r.auth !== '',
    secretKeys: extra.secretKeys,
    integrity: extra.integrity,
    mayUse: extra.mayUse,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * The variable names a template uses ({{ vars.port }}, vars['port'], vars["port"]) – read with string functions, no
 * regular expression built from input.
 */
export function templateVariableNames(text: string): string[] {
  const out = new Set<string>();
  let i = text.indexOf('vars');
  while (i >= 0) {
    const before = i > 0 ? text[i - 1]! : ' ';
    let j = i + 4;
    if (!/[A-Za-z0-9_$.]/.test(before)) {
      while (text[j] === ' ') j++;
      if (text[j] === '.') {
        j++;
        while (text[j] === ' ') j++;
        let end = j;
        while (end < text.length && /[A-Za-z0-9_$]/.test(text[end]!)) end++;
        if (end > j) out.add(text.slice(j, end));
      } else if (text[j] === '[') {
        j++;
        while (text[j] === ' ') j++;
        const quote = text[j];
        if (quote === "'" || quote === '"' || quote === '`') {
          const end = text.indexOf(quote, j + 1);
          if (end > j) out.add(text.slice(j + 1, end));
        }
      }
    }
    i = text.indexOf('vars', i + 4);
  }
  return [...out];
}

/** Where a platform's requests and credentials go: its base URL, the token URLs of its sign-in, its trusted origins and portal. */
interface FixedSources {
  baseUrl: string;
  auth?: { tokenUrl?: string; request?: { url?: string }; refresh?: { request?: { url?: string } } } | null;
  http?: { trustedOrigins?: string[] };
  portalUrl?: string;
}

/**
 * The variables an identity may not override (ADR 0009, IDENTITY_VARIABLE_FIXED): those used in the base URL, the token
 * URL of the platform's or the identity's sign-in, the trusted origins or the portal URL – an identity cannot point at
 * another system.
 */
export function fixedVariables(platform: FixedSources, identityAuth?: FixedSources['auth']): Set<string> {
  const texts = [platform.baseUrl, platform.portalUrl ?? '', ...(platform.http?.trustedOrigins ?? [])];
  for (const a of [platform.auth, identityAuth]) if (a) texts.push(a.tokenUrl ?? '', a.request?.url ?? '', a.refresh?.request?.url ?? '');
  return new Set(texts.flatMap((t) => (typeof t === 'string' ? templateVariableNames(t) : [])));
}

/**
 * The identity's sign-in settings and variables merged into the platform's (NULL auth: the platform's). Variables an
 * identity may not override (fixedVariables) are dropped at use time too, not only at save (0.9.0): a row changed in the
 * database and sealed cannot move the base URL or a token URL.
 */
export function mergedAuthAndVariables<A, V extends Record<string, string>>(
  platform: { auth: A; variables: V; baseUrl?: string; http?: { trustedOrigins?: string[] }; portalUrl?: string },
  r: IdentityRow,
): { auth: A; variables: V } {
  const auth = r.auth ? parseJson<A | null>(r.auth, null) : null;
  const vars = parseJson<Record<string, unknown>>(r.variables, {});
  const fixed = fixedVariables(
    { baseUrl: platform.baseUrl ?? '', auth: platform.auth as FixedSources['auth'], http: platform.http, portalUrl: platform.portalUrl },
    auth as FixedSources['auth'],
  );
  const overlay = Object.fromEntries(
    Object.entries(vars && typeof vars === 'object' && !Array.isArray(vars) ? vars : {}).filter(
      ([k, v]) => typeof v === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype' && !fixed.has(k),
    ),
  ) as Record<string, string>;
  return { auth: auth ?? platform.auth, variables: { ...platform.variables, ...overlay } };
}
