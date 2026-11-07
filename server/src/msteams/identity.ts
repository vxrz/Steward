import type { UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { getUser } from '../auth/users.js';
import { getProvider } from '../auth/sso.js';
import { identityKeys } from '../auth/sso-claims.js';
import { botConfig } from './settings.js';

/**
 * Who clicks in Teams (ADR 0013): Teams names the person by `from.aadObjectId` and the tenant. Steward builds the
 * stable identity key of the configured Entra provider – `<provider>#iss=<issuer>#tid=<tenant>#oid=<object id>` – and
 * looks it up in `users.external_id`, exactly as a single sign-on would. Never by user principal name, e-mail or
 * display name (the nOAuth rule). The provider's issuer must name the activity's tenant. No session is created.
 */
export function userForTeams(tenantId: string, aadObjectId: string): UserInfo | null {
  const providerId = botConfig().providerId;
  if (!providerId || !tenantId || !aadObjectId) return null;
  let issuer: string;
  let claims: string[];
  try {
    const p = getProvider(providerId);
    if (!p.enabled) return null;
    issuer = p.issuer.replace(/\/+$/, '');
    claims = p.stableIdClaims;
  } catch {
    return null; // the provider was removed
  }
  // a single-tenant issuer names its tenant: it must be the one the click comes from
  if (!issuer.toLowerCase().includes(`/${tenantId.toLowerCase()}/`)) return null;
  if ([...claims].sort().join(',') !== 'oid,tid') return null;
  const { key } = identityKeys(providerId, { iss: issuer, tid: tenantId, oid: aadObjectId }, claims);
  if (!key) return null;
  const row = db().get<{ id: string }>('SELECT id FROM users WHERE external_id = ?', key);
  if (!row) return null;
  try {
    const u = getUser(row.id);
    return u.active ? u : null;
  } catch {
    return null; // deleted meanwhile
  }
}

/** The Entra object ids of people (for a card's per-viewer refresh list): the reverse of userForTeams. */
export function aadObjectIdOf(u: UserInfo): string | null {
  const providerId = botConfig().providerId;
  const r = db().get<{ external_id: string | null }>('SELECT external_id FROM users WHERE id = ?', u.id);
  const ext = r?.external_id ?? '';
  if (!providerId || !ext.startsWith(`${providerId}#`)) return null;
  const oid = ext.split('#').find((p) => p.startsWith('oid='));
  return oid ? decodeURIComponent(oid.slice(4)) : null;
}
