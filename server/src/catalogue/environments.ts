import { z } from 'zod';
import {
  CIA_COLORS,
  DEFAULT_ENVIRONMENTS,
  ENVIRONMENT_LIMITS,
  environmentRank,
  isProductionEnvironment,
  type CatalogueEnvironment,
  type EnvironmentSettings,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { forbid, me } from '../records/access.js';
import { readSetting, writeSetting } from '../settings.js';
import { HttpError, nowIso } from '../util.js';

/**
 * The environments of the catalogue (#129): an ordered list (name, colour, production flag) offered on platforms, on
 * the "runs on" links of applications and systems, and on components. Values stay free text – the list gives the
 * order, the colour and which environments count as production. Administrators change it.
 */

const SETTINGS_KEY = 'catalogue.environments';

interface Stored {
  environments: CatalogueEnvironment[];
  updatedAt: string;
  updatedBy: string;
}

/** An environment value: trimmed, at most 60 characters, no control characters. */
export const environmentValue = z
  .string()
  .trim()
  .max(ENVIRONMENT_LIMITS.name)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]*$/, 'No control characters');

export const environmentsInput = z
  .object({
    environments: z
      .array(
        z
          .object({
            name: environmentValue.pipe(z.string().min(1)),
            color: z.enum(CIA_COLORS).nullable().default(null),
            production: z.boolean().default(false),
          })
          .strict(),
      )
      .max(ENVIRONMENT_LIMITS.max),
  })
  .strict();

function stored(): Stored | null {
  const s = readSetting<Partial<Stored> | null>(SETTINGS_KEY, null);
  if (!s || !Array.isArray(s.environments)) return null;
  const parsed = environmentsInput.safeParse({ environments: s.environments });
  return parsed.success ? { environments: parsed.data.environments, updatedAt: s.updatedAt ?? '', updatedBy: s.updatedBy ?? '' } : null;
}

/** The list in use: the stored one, else dev / test / prod. */
export function environmentList(): CatalogueEnvironment[] {
  return stored()?.environments ?? DEFAULT_ENVIRONMENTS.map((e) => ({ ...e }));
}

export const isProduction = (name: string, list = environmentList()) => isProductionEnvironment(list, name);
export const rankOf = (name: string, list = environmentList()) => environmentRank(list, name);

/** Environment values in use on platforms, "runs on" links and components, with how often. */
function valuesInUse(): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db().all<{ v: string; n: number }>(
    `SELECT environment AS v, COUNT(*) AS n FROM platforms WHERE environment <> '' GROUP BY environment
     UNION ALL SELECT environment AS v, COUNT(*) AS n FROM application_systems WHERE environment <> '' GROUP BY environment
     UNION ALL SELECT environment AS v, COUNT(*) AS n FROM application_components WHERE environment <> '' GROUP BY environment`,
  ))
    out.set(r.v, (out.get(r.v) ?? 0) + Number(r.n));
  return out;
}

export function environmentSettings(): EnvironmentSettings {
  me();
  const s = stored();
  const list = s?.environments ?? DEFAULT_ENVIRONMENTS.map((e) => ({ ...e }));
  const listed = new Set(list.map((e) => e.name.toLowerCase()));
  const unlisted = [...valuesInUse()]
    .filter(([name]) => !listed.has(name.toLowerCase()))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { environments: list, unlisted, updatedAt: s?.updatedAt || null, updatedBy: s?.updatedBy || null, canEdit: isAdmin(currentUser()) };
}

export function saveEnvironments(input: z.infer<typeof environmentsInput>): EnvironmentSettings {
  const u = me();
  if (!isAdmin(u)) forbid('change the environments', 'manageSettings');
  const seen = new Set<string>();
  for (const e of input.environments) {
    const k = e.name.toLowerCase();
    if (seen.has(k)) throw new HttpError(400, `"${e.name}" is listed twice`, 'ENVIRONMENT_TWICE', { name: e.name });
    seen.add(k);
  }
  const before = environmentList();
  writeSetting(SETTINGS_KEY, { environments: input.environments, updatedAt: nowIso(), updatedBy: u.username });
  audit({
    action: 'catalogue.environments_changed',
    entityType: 'settings',
    entityId: SETTINGS_KEY,
    summary: `Environments changed: ${input.environments.map((e) => `${e.name}${e.production ? ' (production)' : ''}`).join(', ') || 'none'}`,
    details: { before, after: input.environments },
  });
  return environmentSettings();
}

/** Sorts by environment in list order ('' last), then by the second key. */
export function byEnvironment<T>(xs: T[], env: (x: T) => string, then: (a: T, b: T) => number = () => 0): T[] {
  const list = environmentList();
  return [...xs].sort((a, b) => rankOf(env(a), list) - rankOf(env(b), list) || env(a).localeCompare(env(b)) || then(a, b));
}
