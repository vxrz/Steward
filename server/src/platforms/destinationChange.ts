import { z } from 'zod';
import { DATABASE_KIND, databaseSettingsSchema, type DatabaseSettings } from '@sm/shared';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { requireSession } from '../auth/step-up.js';
import { HttpError } from '../util.js';
import { changedDestination, platformDestination, type DestinationSource, type PlatformDestination } from './destination.js';
import { clearStoredCredentials, hasStoredCredentials } from './identityService.js';
import { getPlatform, storedConfig } from './service.js';

/**
 * A change of where a platform's stored credentials go (security review 0.19.0 H1, docs/PLATFORMS.md#changing-the-address):
 * a new base URL, trusted origin, sign-in address, portal, proxy, broker or database host. While credentials are stored:
 *
 * - only a signed-in session may do it (API tokens: SESSION_REQUIRED), after a step-up (control point
 *   platform.destination, the route's rule below);
 * - the request says what happens to the credentials (`credentials`): `clear` removes them from every identity (they are
 *   entered again for the new address), `keep` sends them there – administrators only. Without a choice the answer is
 *   409 PLATFORM_DESTINATION_CREDENTIALS and the web app asks;
 * - the audit entry platform.destination_changed holds the old and the new destination.
 *
 * A platform without stored credentials changes its address like any other setting (audited the same way).
 */
export const credentialChoice = z.enum(['keep', 'clear']).optional();
export type CredentialChoice = z.infer<typeof credentialChoice>;

export interface DestinationChange {
  before: PlatformDestination;
  after: PlatformDestination;
  changed: (keyof PlatformDestination)[];
  /** Credentials were stored when the change was asked for */
  stored: boolean;
  clear: boolean;
}

interface PlatformPatch {
  kind?: string;
  baseUrl?: string;
  config?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The platform as PUT /platforms/:id would leave it (as updatePlatform: a new config replaces the stored one, the database connection stays). */
export function afterPlatformUpdate(id: string, patch: PlatformPatch): DestinationSource {
  const p = getPlatform(id);
  const stored = storedConfig(id);
  return {
    kind: typeof patch.kind === 'string' ? patch.kind : p.kind,
    baseUrl: typeof patch.baseUrl === 'string' ? patch.baseUrl : p.baseUrl,
    config: isObject(patch.config) ? { ...patch.config, ...(stored.database ? { database: stored.database } : {}) } : stored,
  };
}

/** The platform as PUT /platforms/:id/database would leave it. */
export function afterDatabaseUpdate(id: string, settings: DatabaseSettings): DestinationSource {
  const p = getPlatform(id);
  // other kinds have no connection to change (the route refuses them)
  return { kind: p.kind, baseUrl: p.baseUrl, config: { ...storedConfig(id), ...(p.kind === DATABASE_KIND ? { database: settings } : {}) } };
}

function destinationOf(id: string): PlatformDestination {
  const p = getPlatform(id);
  return platformDestination({ kind: p.kind, baseUrl: p.baseUrl, config: storedConfig(id) });
}

/** For the step-up rule: the change moves stored credentials to another address. */
export function movesCredentials(id: string, after: DestinationSource): boolean {
  return changedDestination(destinationOf(id), platformDestination(after)).length > 0 && hasStoredCredentials(id);
}

/** The step-up rules of the routes (auth/step-up.ts `when`): the raw body, before validation. */
export const destinationRules = {
  platform: (id: string, body: unknown) => {
    const b = isObject(body) ? body : {};
    return movesCredentials(id, afterPlatformUpdate(id, { kind: b.kind as string, baseUrl: b.baseUrl as string, config: b.config }));
  },
  database: (id: string, body: unknown) => {
    const parsed = databaseSettingsSchema.safeParse(isObject(body) ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'credentials')) : body);
    // an invalid body is refused by the route itself
    return parsed.success && movesCredentials(id, afterDatabaseUpdate(id, parsed.data));
  },
};

/** Before the change is written: what it does, or the refusal (see above). null: the destination stays. */
export function planDestinationChange(id: string, after: DestinationSource, choice: CredentialChoice): DestinationChange | null {
  const before = destinationOf(id);
  const next = platformDestination(after);
  const changed = changedDestination(before, next);
  if (!changed.length) return null;
  const stored = hasStoredCredentials(id);
  if (stored) {
    const u = requireSession(currentUser());
    const name = getPlatform(id).name;
    if (!choice)
      throw new HttpError(
        409,
        `The change sends the stored credentials of "${name}" to another address – say whether to keep them (administrators only) or remove them`,
        'PLATFORM_DESTINATION_CREDENTIALS',
        { name, admin: isAdmin(u) },
      );
    if (choice === 'keep' && !isAdmin(u))
      throw new HttpError(
        403,
        `Only an administrator can send the stored credentials of "${name}" to a new address – save without them and enter them again`,
        'PLATFORM_CREDENTIALS_KEEP_ADMIN',
        { name },
      );
  }
  return { before, after: next, changed, stored, clear: stored && choice !== 'keep' };
}

/** A proxy URL may carry a user and password: never in the audit log. */
const forAudit = (d: PlatformDestination): PlatformDestination => ({ ...d, proxy: d.proxy.replace(/\/\/[^/@]*@/, '//***@') });

/** After the change was written (in the same transaction): removes the credentials if asked, and audits the change. */
export function recordDestinationChange(id: string, change: DestinationChange | null): void {
  if (!change) return;
  const identities = change.clear ? clearStoredCredentials(id) : [];
  const credentials = !change.stored ? 'none' : change.clear ? 'removed' : 'kept';
  const what = { none: 'no credentials stored', removed: 'stored credentials removed', kept: 'stored credentials kept for the new address' }[credentials];
  audit({
    action: 'platform.destination_changed',
    entityType: 'platform',
    entityId: id,
    summary: `Address of "${getPlatform(id).name}" changed (${change.changed.join(', ')}): ${what}`,
    details: {
      changed: change.changed,
      before: forAudit(change.before),
      after: forAudit(change.after),
      credentials,
      ...(identities.length ? { identities } : {}),
    },
  });
}
