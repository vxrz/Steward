import type { CheckOf, MonitorStatus, StackVersion } from '@sm/shared';
import { db } from '../db.js';
import { runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { catalogueVisibleNow } from '../records/access.js';
import { HttpError } from '../util.js';
import { CheckSetupError } from '../monitors/platforms.js';
import { lifecycleOf, lifecycleSettings, releasesOf } from '../catalogue/lifecycle.js';
import { productLabel } from '../catalogue/components.js';
import { watchOf, type WatchedEntry } from './service.js';

/**
 * The monitor check "Version behind" (#241): the tech stack of one application – its components and the systems it runs
 * on – judged from the version watch's cache (the check itself calls nothing):
 *   down (majorAs)    a major release behind
 *   down (eolAs)      the release cycle in use reached its end of life
 *   degraded          more than maxMinors minor releases behind, or the first newer release older than maxDays
 * The application is resolved with the monitor owner's view: one they may not see answers like a missing one.
 */

type AppRow = { id: string; name: string; owners: string; archived: number };

function findApplication(ref: string): AppRow | null {
  return (
    db().get<AppRow>('SELECT id, name, owners, archived FROM applications WHERE id = ?', ref) ??
    db().get<AppRow>('SELECT id, name, owners, archived FROM applications WHERE lower(name) = lower(?) AND archived = 0', ref) ??
    null
  );
}

/** Saving or trying the check: the person doing it must see the application – a hidden one reads like a missing one. */
export function requireVisibleApplication(check: string, ref: string): void {
  const a = findApplication(ref);
  if (!a || !catalogueVisibleNow('application', a))
    throw new HttpError(400, `Check "${check}": application "${ref.slice(0, 100)}" not found`, 'APPLICATION_NOT_FOUND', { id: ref.slice(0, 100) });
}

interface Row {
  holder_kind: 'component' | 'system';
  holder_id: string;
  holder_name: string;
  environment: string;
  product: string;
  version: string;
  source: string;
  sbom_ref: string;
  dt_platform_id: string | null;
  dt_state: string | null;
  updated_by: string;
}

/** The stack entries of an application: its components and the systems it runs on (with the environment of the link). */
export function applicationEntries(appId: string): WatchedEntry[] {
  const rows = db().all<Row>(
    `SELECT 'component' AS holder_kind, c.id AS holder_id, c.name AS holder_name, c.environment, cs.product, cs.version, cs.source, cs.sbom_ref,
            c.dt_platform_id, c.dt_state, c.updated_by
     FROM component_stack cs JOIN application_components c ON c.id = cs.component_id WHERE c.application_id = ?
     UNION ALL
     SELECT 'system' AS holder_kind, s.id AS holder_id, s.name AS holder_name, l.environment, ss.product, ss.version, ss.source, ss.sbom_ref,
            NULL AS dt_platform_id, NULL AS dt_state, s.updated_by
     FROM system_stack ss JOIN systems s ON s.id = ss.system_id JOIN application_systems l ON l.system_id = s.id WHERE l.application_id = ?
     ORDER BY holder_kind, holder_name, product`,
    appId,
    appId,
  );
  return rows.map((r) => ({
    holderKind: r.holder_kind,
    holderId: r.holder_id,
    holderName: r.holder_name,
    applicationId: appId,
    environment: r.environment ?? '',
    product: r.product,
    version: r.version ?? '',
    stackSource: r.source,
    ref: r.sbom_ref ?? '',
    dtPlatformId: r.dt_platform_id,
    dtState: r.dt_state,
    updatedBy: r.updated_by,
  }));
}

const RANK: Record<MonitorStatus, number> = { up: 0, unknown: 1, degraded: 2, down: 3 } as Record<MonitorStatus, number>;

export function versionBehindCheck(
  c: CheckOf<'version-behind'>,
  ctx: { owner: string; now: () => number },
): { status: MonitorStatus; message: string; value?: unknown } {
  const u = findUserByName(ctx.owner);
  if (!u || !u.active) throw new CheckSetupError(`the monitor owner ${ctx.owner} is missing or deactivated`);
  const app = runAs(toAuthUser(u), () => {
    const a = findApplication(c.application);
    return a && catalogueVisibleNow('application', a) ? a : null;
  });
  if (!app) throw new CheckSetupError(`application ${c.application} does not exist or the monitor owner may not see it`);
  if (app.archived) return { status: 'unknown', message: `The application "${app.name}" is archived` };
  const env = (c.environment ?? '').trim().toLowerCase();
  const products = c.products?.length ? new Set(c.products) : null;
  const entries = applicationEntries(app.id).filter(
    (e) => (!env || !e.environment || e.environment.toLowerCase() === env) && (!products || products.has(e.product)),
  );
  if (!entries.length) return { status: 'unknown', message: `"${app.name}" has no tech stack${env || products ? ' in this selection' : ''}` };
  const now = ctx.now();
  const watch = watchOf(entries, now);
  const s = lifecycleSettings();
  const releases = releasesOf([...new Set(entries.map((e) => e.product))]);
  const findings: { status: MonitorStatus; text: string; product: string; holder: string; installed: string; newest: string | null; reason: string }[] = [];
  let known = 0;
  for (const e of entries) {
    const w: StackVersion | null = watch.get(`${e.holderKind}\u0000${e.holderId}\u0000${e.product}`)?.watch ?? null;
    const lc = lifecycleOf(e.product, e.version, releases, s.warnDays, now);
    if (w?.newest) known++;
    const name = `${productLabel(e.product)} ${e.version}`.trim();
    const where = e.environment ? `${e.holderName} (${e.environment})` : e.holderName;
    const add = (status: MonitorStatus, reason: string, text: string) =>
      findings.push({ status, text: `${name} ${text} – ${where}`, product: e.product, holder: where, installed: e.version, newest: w?.newest ?? null, reason });
    if (c.eolAs !== 'ignore' && lc?.state === 'eol') add(c.eolAs, 'eol', `end of life${lc.eolFrom ? ` since ${lc.eolFrom}` : ''}`);
    if (!w?.newest || !w.behind) continue;
    const days = w.daysBehind !== null ? `, ${w.daysBehind} days` : '';
    if (w.lag === 'major') add(c.majorAs, 'major', `→ ${w.newest} (${w.behind.major} major${w.behind.major === 1 ? '' : 's'} behind${days})`);
    else if (w.lag === 'minor' && w.behind.minor > c.maxMinors) add('degraded', 'minor', `→ ${w.newest} (${w.behind.minor} minor releases behind${days})`);
    else if (c.maxDays !== undefined && w.daysBehind !== null && w.daysBehind > c.maxDays && w.lag !== 'current')
      add('degraded', 'days', `→ ${w.newest} (behind for ${w.daysBehind} days)`);
  }
  findings.sort((a, b) => RANK[b.status] - RANK[a.status]);
  const value = { application: app.name, entries: entries.length, known, findings: findings.slice(0, 20).map(({ text: _t, ...f }) => f) };
  if (!findings.length) {
    if (!known && !entries.some((e) => lifecycleOf(e.product, e.version, releases, s.warnDays, now)))
      return { status: 'unknown', message: `No newest versions known yet for "${app.name}" – the version watch reads them once a day`, value };
    return { status: 'up', message: `"${app.name}": ${known} of ${entries.length} stack entries checked, none too far behind`, value };
  }
  const worst = findings[0]!.status;
  const shown = findings.slice(0, 3).map((f) => f.text);
  return {
    status: worst,
    message:
      `${findings.length} of ${entries.length} stack entries of "${app.name}": ${shown.join('; ')}${findings.length > 3 ? ` and ${findings.length - 3} more` : ''}`.slice(
        0,
        1000,
      ),
    value,
  };
}
