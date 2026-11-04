import {
  controlPoint,
  defaultAssurancePolicy,
  effectiveRule,
  normalizePolicy,
  type AssurancePolicy,
  type ItemOverride,
  type McpWriteMode,
  type PointRule,
} from '@sm/shared';
import { authenticRows, type AuditRow } from '../audit.js';
import { checkMac, configMac } from '../integrity.js';
import { logger } from '../log.js';
import { readSetting, writeSetting } from '../settings.js';
import { parseJson } from '../util.js';

/**
 * The stored assurance policy (#210) and the rules it gives – the lowest layer, read by the permission checks
 * (permissions.ts) and the services; enforcement, changes and proofs are in assurance.ts.
 *
 * The policy is a setting sealed with the vault's integrity key (like the sign-in providers): a change made directly in
 * the database does not count – the version the audit log names (every change writes `assurance.policy_changed` with
 * the policy after it) applies instead, and the log says so.
 */

const KEY = 'assurance.policy';
interface Stored {
  policy: AssurancePolicy;
  mac: string;
  since: string;
}

let cached: { policy: AssurancePolicy; since: string | null } | null = null;
let warned = false;

/** Tests and a restore: read the stored policy again. */
export function forgetAssurancePolicy(): void {
  cached = null;
  warned = false;
}

/** The policy in force now, and since when (null: never changed – the defaults, as in 0.4.0). */
export function currentPolicyInfo(): { policy: AssurancePolicy; since: string | null } {
  if (cached) return cached;
  const stored = readSetting<Stored | null>(KEY, null);
  if (!stored?.policy) return (cached = { policy: defaultAssurancePolicy(), since: null });
  const policy = normalizePolicy({ ...defaultAssurancePolicy(), ...stored.policy });
  const state = checkMac('assurance', 'policy', stored.policy, stored.mac);
  // locked vault: nothing can be verified yet (and nobody signs in to change anything); read again after the unlock
  if (state === 'locked') return { policy, since: stored.since ?? null };
  if (state !== 'ok') {
    if (!warned) logger.error({ state }, 'assurance policy: the stored policy does not match its seal – the version in the audit log applies');
    warned = true;
    const fromAudit = policyAsOf(new Date().toISOString());
    return (cached = { policy: fromAudit.policy, since: fromAudit.since });
  }
  return (cached = { policy, since: stored.since ?? null });
}

export const currentPolicy = (): AssurancePolicy => currentPolicyInfo().policy;

/** Stores a new version (the caller audits it). */
export function writePolicy(policy: AssurancePolicy, since: string): void {
  const p = normalizePolicy(policy);
  writeSetting(KEY, { policy: p, mac: configMac('assurance', 'policy', p), since } satisfies Stored);
  cached = { policy: p, since };
}

/**
 * The policy as it was at a point in time, from the audit log: the policy after the last authentic
 * `assurance.policy_changed` entry at or before `at` (none: the defaults, version 0).
 */
export function policyAsOf(at: string): { policy: AssurancePolicy; since: string | null; seq: number | null } {
  const ts = new Date(at).toISOString();
  const { rows } = authenticRows('action = ? AND ts <= ?', ['assurance.policy_changed', ts], { ownOnly: true, limit: 20 });
  const r = rows[0] as AuditRow | undefined;
  if (!r) return { policy: defaultAssurancePolicy(), since: null, seq: null };
  const after = parseJson<{ after?: AssurancePolicy }>(r.details, {}).after;
  return { policy: normalizePolicy({ ...defaultAssurancePolicy(), ...(after ?? {}) }), since: r.ts, seq: Number(r.seq) };
}

/** The effective rule of a point for one item (max of baseline, policy and the item's own switch). */
export function pointRule(
  key: string,
  item: ItemOverride = {},
  policy: AssurancePolicy = currentPolicy(),
): Omit<PointRule, 'fourEyes'> & { fourEyes: boolean } {
  const p = controlPoint(key);
  if (!p) throw new Error(`Unknown control point "${key}"`);
  return effectiveRule(p, policy, item);
}

/** Whether a second person is needed at a point – for an item that asks for it itself (`itemRequires`) or by the policy. */
export const fourEyesRequired = (key: string, itemRequires = false): boolean => pointRule(key, { fourEyes: itemRequires }).fourEyes;

/** A platform's MCP write mode under the policy: with four-eyes required for MCP writes, "confirm" becomes "fourEyes". */
export function effectiveMcpMode<M extends McpWriteMode>(mode: M): M | 'fourEyes' {
  return mode === 'confirm' && fourEyesRequired('mcp.write') ? 'fourEyes' : mode;
}
