import { z } from 'zod';
import {
  DEFAULT_LIFECYCLE_SETTINGS,
  LIFECYCLE_LIMITS,
  isProductionEnvironment,
  type LifecycleSettings,
  type LifecycleStatus,
  type Platform,
  type StackLifecycle,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { forbid, me, canCreateServices } from '../records/access.js';
import { readSetting, writeSetting } from '../settings.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { logger } from '../log.js';
import { environmentList } from './environments.js';
import { assertOutboundAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { platformRequest, resolveBaseUrl } from '../platforms/http.js';
import { getSecrets, listPlatforms } from '../platforms/service.js';

/**
 * End of life of the tech stack (#104): the release cycles of the products in the stacks of application components,
 * read from endoflife.date through a platform of kind `endoflife-date` (its public API needs no login; the outbound
 * policy applies like for every platform). A daily refresh keeps a small cache (eol_releases); every stack entry is
 * matched to its release cycle by its version ("24.11.0" → "24", "3.20.3" → "3.20").
 */

export const ENDOFLIFE_KIND = 'endoflife-date';
const SETTINGS_KEY = 'catalogue.lifecycle';
const DAY = 86_400_000;
/** At most this many products per refresh (the stacks of a large installation stay far below) */
const MAX_PRODUCTS = 500;

export const settingsInput = z
  .object({
    platformId: z.string().trim().min(1).max(100).nullable(),
    warnDays: z.number().int().min(LIFECYCLE_LIMITS.warnDaysMin).max(LIFECYCLE_LIMITS.warnDaysMax),
    notify: z.boolean(),
    scorecard: z.boolean(),
  })
  .strict();

export function lifecycleSettings(): LifecycleSettings {
  return { ...DEFAULT_LIFECYCLE_SETTINGS, ...readSetting<Partial<LifecycleSettings>>(SETTINGS_KEY, {}) };
}

/** The platform to read: the chosen one, else the first of kind endoflife-date (by name). */
function sourcePlatform(s = lifecycleSettings()): Platform | null {
  const all = listPlatforms().filter((p) => p.kind === ENDOFLIFE_KIND);
  if (s.platformId) return all.find((p) => p.id === s.platformId) ?? null;
  return all[0] ?? null;
}

const canEdit = () => isAdmin(currentUser());
const canRefresh = () => {
  const u = currentUser();
  return !!u && (isAdmin(u) || canCreateServices(u));
};

export function lifecycleStatus(): LifecycleStatus {
  me();
  const s = lifecycleSettings();
  const p = sourcePlatform(s);
  const products = usedProducts();
  const fetched = db().all<{ product: string; fetched_at: string; error: string | null }>('SELECT * FROM eol_products');
  const withData = new Set(
    db()
      .all<{ product: string }>('SELECT DISTINCT product FROM eol_releases')
      .map((r) => r.product),
  );
  const latest =
    fetched
      .map((f) => f.fetched_at)
      .sort()
      .at(-1) ?? null;
  return {
    settings: s,
    platform: p ? { id: p.id, name: p.name } : null,
    products: products.length,
    withData: products.filter((x) => withData.has(x)).length,
    refreshedAt: latest,
    errors: fetched.filter((f) => f.error && products.includes(f.product)).map((f) => ({ product: f.product, error: f.error! })),
    canEdit: canEdit(),
    canRefresh: canRefresh(),
  };
}

export function saveLifecycleSettings(input: z.infer<typeof settingsInput>): LifecycleStatus {
  me();
  if (!canEdit()) forbid('change the end-of-life settings', 'manageSettings');
  if (input.platformId) {
    const p = listPlatforms().find((x) => x.id === input.platformId);
    if (!p || p.kind !== ENDOFLIFE_KIND)
      throw new HttpError(400, 'Choose a platform of kind endoflife.date', 'LIFECYCLE_PLATFORM_KIND', { id: input.platformId });
  }
  const before = lifecycleSettings();
  writeSetting(SETTINGS_KEY, input);
  audit({
    action: 'catalogue.lifecycle_settings_changed',
    entityType: 'settings',
    entityId: SETTINGS_KEY,
    summary: `End-of-life settings changed (warn ${input.warnDays} days before, messages ${input.notify ? 'on' : 'off'}, scorecard ${input.scorecard ? 'on' : 'off'})`,
    details: { before, after: input },
  });
  return lifecycleStatus();
}

// ---------- the cache ----------

/** Products used in a tech stack of an application that is not archived, or of a system (#129). */
function usedProducts(): string[] {
  return db()
    .all<{ product: string }>(
      `SELECT cs.product FROM component_stack cs
       JOIN application_components c ON c.id = cs.component_id
       JOIN applications a ON a.id = c.application_id
       WHERE a.archived = 0
       UNION SELECT product FROM system_stack ORDER BY product`,
    )
    .map((r) => r.product);
}

/** One stack entry of an application (not archived): of a component, or of a system it runs on (#129). */
export interface AppStackRow {
  application_id: string;
  application: string;
  owners: string;
  /** The component's or the system's name */
  holder: string;
  holder_kind: 'component' | 'system';
  environment: string;
  product: string;
  version: string;
}

/** The stack entries of all applications that are not archived, components first. */
export function appStackRows(): AppStackRow[] {
  return db().all<AppStackRow>(
    `SELECT a.id AS application_id, a.name AS application, a.owners, c.name AS holder, 'component' AS holder_kind, c.environment, cs.product, cs.version
     FROM component_stack cs JOIN application_components c ON c.id = cs.component_id JOIN applications a ON a.id = c.application_id
     WHERE a.archived = 0
     UNION ALL
     SELECT a.id AS application_id, a.name AS application, a.owners, s.name AS holder, 'system' AS holder_kind, l.environment, ss.product, ss.version
     FROM system_stack ss JOIN systems s ON s.id = ss.system_id JOIN application_systems l ON l.system_id = s.id JOIN applications a ON a.id = l.application_id
     WHERE a.archived = 0
     ORDER BY application, holder_kind, holder, product`,
  );
}

interface ApiRelease {
  name?: unknown;
  label?: unknown;
  releaseDate?: unknown;
  isLts?: unknown;
  eoasFrom?: unknown;
  isEol?: unknown;
  eolFrom?: unknown;
  latest?: { name?: unknown } | null;
}

const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const text = (v: unknown, max = 100): string => (typeof v === 'string' ? v.slice(0, max) : '');

let running: Promise<{ refreshed: number; failed: number }> | null = null;

/**
 * Reads every used product from endoflife.date (GET /api/v1/products/{product}) and replaces its cached release
 * cycles. Products that endoflife.date does not answer for keep their old data and record the error. One refresh at a
 * time; returns how many were refreshed and how many failed.
 */
export function refreshLifecycle(products = usedProducts()): Promise<{ refreshed: number; failed: number }> {
  if (running) return running;
  running = (async () => {
    const p = sourcePlatform();
    if (!p) throw new HttpError(409, 'No endoflife.date platform is set up', 'LIFECYCLE_NO_PLATFORM');
    const secrets = getSecrets(p.id);
    await assertOutboundAllowed(await resolveBaseUrl(p, secrets), outboundContext());
    let refreshed = 0;
    let failed = 0;
    for (const product of products.slice(0, MAX_PRODUCTS)) {
      let error: string | null = null;
      try {
        const r = await platformRequest(
          p,
          secrets,
          { method: 'GET', url: `/api/v1/products/${encodeURIComponent(product)}`, maxResponseBytes: 2 * 1024 * 1024 },
          AbortSignal.timeout(20_000),
        );
        if (r.status === 404) error = 'endoflife.date does not know this product';
        else if (!r.ok) error = `HTTP ${r.status}`;
        else {
          const releases = (r.body as { result?: { releases?: ApiRelease[] } } | null)?.result?.releases;
          if (!Array.isArray(releases)) error = 'the answer has no release cycles';
          else {
            db().tx(() => {
              db().run('DELETE FROM eol_releases WHERE product = ?', product);
              for (const x of releases.slice(0, 500)) {
                const cycle = text(x.name, 60);
                if (!cycle) continue;
                db().run(
                  `INSERT INTO eol_releases (product, cycle, label, release_date, is_lts, eoas_from, eol_from, is_eol, latest)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
                  product,
                  cycle,
                  text(x.label, 120),
                  day(x.releaseDate),
                  x.isLts === true ? 1 : 0,
                  day(x.eoasFrom),
                  day(x.eolFrom),
                  x.isEol === true ? 1 : 0,
                  text(x.latest?.name, 60) || null,
                );
              }
            });
          }
        }
      } catch (e) {
        error = String((e as Error).message ?? e).slice(0, 300);
      }
      db().run(
        'INSERT INTO eol_products (product, fetched_at, error) VALUES (?, ?, ?) ON CONFLICT (product) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error',
        product,
        nowIso(),
        error,
      );
      if (error) failed++;
      else refreshed++;
    }
    return { refreshed, failed };
  })().finally(() => {
    running = null;
  });
  return running;
}

/** "Refresh now" (administrators, designers): audited. */
export async function refreshLifecycleNow(): Promise<LifecycleStatus> {
  me();
  if (!canRefresh()) forbid('refresh the end-of-life data', 'createApplications');
  const r = await refreshLifecycle();
  audit({
    action: 'catalogue.lifecycle_refreshed',
    entityType: 'settings',
    entityId: SETTINGS_KEY,
    summary: `End-of-life data refreshed: ${r.refreshed} product(s)${r.failed ? `, ${r.failed} failed` : ''}`,
    details: r,
  });
  return lifecycleStatus();
}

// ---------- matching ----------

interface ReleaseRow {
  product: string;
  cycle: string;
  is_lts: number;
  eoas_from: string | null;
  eol_from: string | null;
  is_eol: number;
  latest: string | null;
}

/**
 * The release cycle a version belongs to: the longest cycle the version equals or starts with followed by a dot or a
 * dash ("24.11.0" → "24", "3.20.3" → "3.20" and not "3.2", "2.4.62-alpine" → "2.4"). A leading "v" is ignored.
 */
export function cycleFor(version: string, cycles: string[]): string | null {
  const v = version
    .trim()
    .replace(/^v(?=\d)/i, '')
    .toLowerCase();
  if (!v) return null;
  let best: string | null = null;
  for (const c of cycles) {
    const k = c.toLowerCase();
    if (v === k || v.startsWith(`${k}.`) || v.startsWith(`${k}-`)) if (!best || k.length > best.length) best = c;
  }
  return best;
}

/** The release cycles of products, by product. */
export function releasesOf(products: string[]): Map<string, ReleaseRow[]> {
  const out = new Map<string, ReleaseRow[]>();
  if (!products.length) return out;
  const wanted = new Set(products);
  for (const r of db().all<ReleaseRow>('SELECT product, cycle, is_lts, eoas_from, eol_from, is_eol, latest FROM eol_releases'))
    if (wanted.has(r.product)) out.set(r.product, [...(out.get(r.product) ?? []), r]);
  return out;
}

const daysUntil = (d: string, now = Date.now()) => Math.ceil((Date.parse(`${d}T00:00:00Z`) - now) / DAY);

/** The end of life of one stack entry; null when the product has no data. */
export function lifecycleOf(
  product: string,
  version: string,
  releases: Map<string, ReleaseRow[]>,
  warnDays = lifecycleSettings().warnDays,
  now = Date.now(),
): StackLifecycle | null {
  const list = releases.get(product);
  if (!list?.length) return null;
  const cycle = cycleFor(
    version,
    list.map((r) => r.cycle),
  );
  const r = cycle ? list.find((x) => x.cycle === cycle) : undefined;
  if (!r) return { state: 'unknown', cycle: null, eolFrom: null, eoasFrom: null, isLts: false, latest: null, daysLeft: null };
  const daysLeft = r.eol_from ? daysUntil(r.eol_from, now) : null;
  const eol = !!r.is_eol || (daysLeft !== null && daysLeft <= 0);
  return {
    state: eol ? 'eol' : daysLeft !== null && daysLeft <= warnDays ? 'ending' : 'supported',
    cycle: r.cycle,
    eolFrom: r.eol_from,
    eoasFrom: r.eoas_from,
    isLts: !!r.is_lts,
    latest: r.latest,
    daysLeft,
  };
}

// ---------- messages to application owners ----------

type NoticeRow = AppStackRow;

/**
 * Messages the owners of applications whose components reach the end of life of their release cycle: once when the
 * cycle is within the warning period ("ending"), once when it is past ("eol") – per application, product and cycle.
 * Idempotent; returns the number of messages.
 */
export async function checkLifecycleNotices(now = Date.now()): Promise<number> {
  const s = lifecycleSettings();
  if (!s.notify) return 0;
  const rows = appStackRows();
  const releases = releasesOf([...new Set(rows.map((r) => r.product))]);
  const envs = environmentList();
  // per application, product and cycle: the components and systems concerned ("db01 (prod)"), production first
  const groups = new Map<string, { row: NoticeRow; lc: StackLifecycle; components: string[]; production: boolean }>();
  for (const r of rows) {
    const lc = lifecycleOf(r.product, r.version, releases, s.warnDays, now);
    if (!lc || !lc.cycle || (lc.state !== 'ending' && lc.state !== 'eol')) continue;
    const key = `${r.application_id}\u0000${r.product}\u0000${lc.cycle}\u0000${lc.state}`;
    const g = groups.get(key) ?? { row: r, lc, components: [], production: false };
    const label = r.environment ? `${r.holder} (${r.environment})` : r.holder;
    if (!g.components.includes(label)) g.components.push(label);
    if (isProductionEnvironment(envs, r.environment)) g.production = true;
    groups.set(key, g);
  }
  let sent = 0;
  const { notify } = await import('../notifications/service.js');
  const { usersOfSubjects } = await import('../tickets/reminders.js');
  const { t } = await import('../i18n/index.js');
  const { listUsers } = await import('../auth/users.js');
  const admins = () => listUsers().filter((u) => u.active && u.roles.includes('admin'));
  const { productLabel } = await import('./components.js');
  for (const { row, lc, components, production } of [...groups.values()].sort((a, b) => Number(b.production) - Number(a.production))) {
    const claimed =
      db().run(
        'INSERT INTO eol_notices (application_id, product, cycle, kind, sent_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        row.application_id,
        row.product,
        lc.cycle,
        lc.state,
        new Date(now).toISOString(),
      ).changes === 1;
    if (!claimed) continue;
    const owners = usersOfSubjects(parseJson<string[]>(row.owners, []));
    const recipients = owners.length ? owners : admins();
    const product = `${productLabel(row.product)} ${lc.cycle}`;
    const params = { product, application: row.application, components: components.join(', '), date: lc.eolFrom ?? '?', days: Math.abs(lc.daysLeft ?? 0) };
    notify({
      event: 'stack.eol',
      text: (l) => ({
        title: t(l, lc.state === 'eol' ? 'stackEol.titleEol' : 'stackEol.titleEnding', params),
        body: t(l, lc.state === 'eol' ? 'stackEol.bodyEol' : 'stackEol.bodyEnding', params),
      }),
      link: `/applications/${row.application_id}`,
      recipients,
      inAppKey: `stack-eol:${row.application_id}:${row.product}:${lc.cycle}:${lc.state}`,
      externalKey: `stack-eol:${row.application_id}:${row.product}:${lc.cycle}:${lc.state}`,
      data: { applicationId: row.application_id, product: row.product, cycle: lc.cycle, state: lc.state, eolFrom: lc.eolFrom, components, production },
    });
    audit({
      action: 'application.eol_notice_sent',
      entityType: 'application',
      entityId: row.application_id,
      actor: 'system',
      summary: `${product} ${lc.state === 'eol' ? 'reached its end of life' : `reaches its end of life on ${lc.eolFrom}`} (application "${row.application}", ${components.join(', ')}) – message to ${recipients.map((u) => u.username).join(', ') || 'nobody'}`,
      details: { product: row.product, cycle: lc.cycle, state: lc.state, eolFrom: lc.eolFrom, components, production },
    });
    sent++;
  }
  return sent;
}

/** When a refresh by the job failed as a whole (e.g. the outbound policy refuses endoflife.date): wait an hour. */
let failedAt = 0;
const RETRY_AFTER = 3_600_000;

/**
 * The job (every few minutes): refresh when the last refresh is older than a day (or never ran), read products that
 * were added to a tech stack since, then the messages.
 */
export async function runLifecycleJob(now = Date.now()): Promise<void> {
  if (!sourcePlatform()) return;
  if (failedAt && now - failedAt < RETRY_AFTER) return;
  const last = db().get<{ t: string | null }>('SELECT MAX(fetched_at) AS t FROM eol_products')?.t ?? null;
  const products = usedProducts();
  const missing = products.filter((p) => !db().get('SELECT 1 FROM eol_products WHERE product = ?', p));
  try {
    if (!last || now - Date.parse(last) >= DAY) await refreshLifecycle(products);
    else if (missing.length) await refreshLifecycle(missing);
    failedAt = 0;
  } catch (err) {
    failedAt = now;
    throw err;
  }
  try {
    await checkLifecycleNotices(now);
  } catch (err) {
    logger.warn({ err }, 'end-of-life messages failed');
  }
}
