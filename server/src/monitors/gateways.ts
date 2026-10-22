import crypto from 'node:crypto';
import { z } from 'zod';
import { HEARTBEAT_AUTH_MODES, type MonitorGateway } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { parseCidr } from '../triggers/service.js';
import { canCreateMonitors, type GatewayRow } from './model.js';

/**
 * Gateways: one secret for a system (e.g. an IoT gateway) that reports many
 * heartbeat checks in one call (POST /api/hooks/monitors), mapped by check key.
 * Like webhook triggers, the secret is shown once and stored encrypted (HMAC)
 * plus as a SHA-256 hash (token comparison).
 */
export const GATEWAY_SECRET_PREFIX = 'mgw_';

export const gatewaySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(''),
  enabled: z.boolean().default(true),
  authMode: z.enum(HEARTBEAT_AUTH_MODES).default('token'),
  allowedCidrs: z.array(z.string().max(64)).max(50).default([]),
  allowedKeys: z.array(z.string().min(1).max(200)).max(200).default([]),
  rateLimitPerMinute: z.number().int().min(1).max(6000).default(120),
});
export type GatewayInput = z.infer<typeof gatewaySchema>;

function canEdit(r: GatewayRow): boolean {
  const u = currentUser();
  return !!u && (isAdmin(u) || r.owner.toLowerCase() === u.username.toLowerCase());
}

const pendingCounts = new Map<string, { accepted: number; rejected: number; seen?: string }>();

function toGateway(r: GatewayRow): MonitorGateway {
  const p = pendingCounts.get(r.id);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    owner: r.owner,
    enabled: !!r.enabled,
    authMode: r.auth_mode,
    allowedCidrs: parseJson(r.allowed_cidrs, []),
    allowedKeys: parseJson(r.allowed_keys, []),
    rateLimitPerMinute: r.rate_limit_per_min,
    secretPrefix: r.secret_prefix,
    secretRotatedAt: r.secret_rotated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeenAt: p?.seen ?? r.last_seen_at,
    acceptedCount: r.accepted_count + (p?.accepted ?? 0),
    rejectedCount: r.rejected_count + (p?.rejected ?? 0),
    canEdit: canEdit(r),
  };
}

/** Gateways are visible to designers and administrators (they carry no monitor data). */
function requireView(): void {
  if (!canCreateMonitors()) throw new HttpError(403, 'Only designers and administrators can manage gateways', 'FORBIDDEN', { context: 'manageGateways' });
}

export const gatewayRow = (id: string) => db().get<GatewayRow>('SELECT * FROM monitor_gateways WHERE id = ?', id);

export function listGateways(): MonitorGateway[] {
  requireView();
  return db().all<GatewayRow>('SELECT * FROM monitor_gateways ORDER BY name').map(toGateway);
}

function requireEdit(id: string): GatewayRow {
  requireView();
  const r = gatewayRow(id);
  if (!r) throw new HttpError(404, 'Gateway not found', 'GATEWAY_NOT_FOUND');
  if (!canEdit(r)) throw new HttpError(403, 'Only the owner or an administrator can change this gateway', 'FORBIDDEN', { context: 'ownerOnly' });
  return r;
}

function clean(input: GatewayInput): GatewayInput {
  const cidrs = [...new Set(input.allowedCidrs.map((c) => c.trim()).filter(Boolean))];
  cidrs.forEach(parseCidr);
  for (const k of input.allowedKeys)
    if (!/^[A-Za-z0-9_.:/*-]+$/.test(k))
      throw new HttpError(400, `Invalid key pattern "${k}" (letters, digits, _ . : / - and * as wildcard)`, 'GATEWAY_KEY_PATTERN', { pattern: k });
  return { ...input, allowedCidrs: cidrs, allowedKeys: [...new Set(input.allowedKeys.map((k) => k.trim()))] };
}

function newSecret() {
  const secret = GATEWAY_SECRET_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { secret, enc: vault().encrypt(secret), hash: sha256(secret), prefix: secret.slice(0, GATEWAY_SECRET_PREFIX.length + 4) };
}

export function createGateway(raw: GatewayInput): { gateway: MonitorGateway; secret: string } {
  requireView();
  const s = clean(raw);
  const owner = currentUser()!.username;
  const id = newId('gw_');
  const sec = newSecret();
  const ts = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO monitor_gateways (id, name, description, owner, enabled, auth_mode, secret_enc, secret_hash, secret_prefix, secret_rotated_at, allowed_cidrs, allowed_keys, rate_limit_per_min, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      s.name,
      s.description,
      owner,
      s.enabled ? 1 : 0,
      s.authMode,
      sec.enc,
      sec.hash,
      sec.prefix,
      ts,
      JSON.stringify(s.allowedCidrs),
      JSON.stringify(s.allowedKeys),
      s.rateLimitPerMinute,
      ts,
      ts,
    );
    audit({
      action: 'monitor.gateway_created',
      entityType: 'monitor-gateway',
      entityId: id,
      summary: `Monitor gateway "${s.name}" created`,
      details: { ...s, secretPrefix: sec.prefix },
    });
  });
  return { gateway: toGateway(gatewayRow(id)!), secret: sec.secret };
}

export function updateGateway(id: string, raw: GatewayInput): MonitorGateway {
  const before = requireEdit(id);
  const s = clean(raw);
  db().tx(() => {
    db().run(
      'UPDATE monitor_gateways SET name = ?, description = ?, enabled = ?, auth_mode = ?, allowed_cidrs = ?, allowed_keys = ?, rate_limit_per_min = ?, updated_at = ? WHERE id = ?',
      s.name,
      s.description,
      s.enabled ? 1 : 0,
      s.authMode,
      JSON.stringify(s.allowedCidrs),
      JSON.stringify(s.allowedKeys),
      s.rateLimitPerMinute,
      nowIso(),
      id,
    );
    audit({
      action: 'monitor.gateway_updated',
      entityType: 'monitor-gateway',
      entityId: id,
      summary: `Monitor gateway "${s.name}" updated${s.enabled ? '' : ' (disabled)'}`,
      details: { ...s, previousName: before.name },
    });
  });
  return toGateway(gatewayRow(id)!);
}

export function rotateGatewaySecret(id: string): { gateway: MonitorGateway; secret: string } {
  const r = requireEdit(id);
  const sec = newSecret();
  const ts = nowIso();
  db().tx(() => {
    db().run(
      'UPDATE monitor_gateways SET secret_enc = ?, secret_hash = ?, secret_prefix = ?, secret_rotated_at = ?, updated_at = ? WHERE id = ?',
      sec.enc,
      sec.hash,
      sec.prefix,
      ts,
      ts,
      id,
    );
    audit({
      action: 'monitor.gateway_secret_rotated',
      entityType: 'monitor-gateway',
      entityId: id,
      summary: `Secret of monitor gateway "${r.name}" rotated (old secret ${r.secret_prefix}… is no longer accepted)`,
      details: { oldPrefix: r.secret_prefix, newPrefix: sec.prefix },
    });
  });
  return { gateway: toGateway(gatewayRow(id)!), secret: sec.secret };
}

export function deleteGateway(id: string): void {
  const r = requireEdit(id);
  db().tx(() => {
    db().run('DELETE FROM monitor_gateways WHERE id = ?', id);
    audit({ action: 'monitor.gateway_deleted', entityType: 'monitor-gateway', entityId: id, summary: `Monitor gateway "${r.name}" deleted` });
  });
  pendingCounts.delete(id);
}

// ---------- counters (written at most every few seconds) ----------

let lastFlush = 0;
export function countGateway(id: string, what: 'accepted' | 'rejected', n = 1): void {
  const p = pendingCounts.get(id) ?? { accepted: 0, rejected: 0 };
  p[what] += n;
  if (what === 'accepted') p.seen = nowIso();
  pendingCounts.set(id, p);
  if (Date.now() - lastFlush > 5000) flushGatewayCounts();
}

export function flushGatewayCounts(): void {
  lastFlush = Date.now();
  for (const [id, p] of pendingCounts) {
    db().run(
      'UPDATE monitor_gateways SET accepted_count = accepted_count + ?, rejected_count = rejected_count + ?, last_seen_at = COALESCE(?, last_seen_at) WHERE id = ?',
      p.accepted,
      p.rejected,
      p.seen ?? null,
      id,
    );
  }
  pendingCounts.clear();
}

/** Glob match of a check key against the gateway's allowed keys ("*" = any characters). No patterns = nothing allowed. */
export function keyAllowed(patterns: string[], key: string): boolean {
  if (!patterns.length) return false;
  return patterns.some((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(key));
}
