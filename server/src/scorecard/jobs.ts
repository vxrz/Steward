import { OBJECTIVE_LIMITS, SCORECARD_LIMITS, type Locale, type ObjectiveWindow, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { newId, parseJson } from '../util.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { matches } from '../auth/permissions.js';
import { t, type MessageKey } from '../i18n/index.js';
import { notify, titleName } from '../notifications/service.js';
import { judge, readingCache, type ObjectiveRow } from './objectives.js';
import { computeScorecards, dayOf } from './scorecard.js';

/**
 * The objective and scorecard job (called by the notification job loop every few minutes, idempotent):
 *   1. once per hour and objective, a sample of the values Steward has read from Gatus (no call to Gatus: the metrics
 *      mode reads Gatus' uptime figures hourly) with the objective's status;
 *   2. a breach starts with the first sample below target and ends with the first sample that meets every target
 *      again ("no data" neither starts nor ends one); objectives with "notify" send one message when a breach
 *      starts – not with every sample, and at most one per objective within breachMessageCooldownHours (a flapping
 *      objective records every breach, but does not flood). Archived objectives are not sampled. The breach row is
 *      the claim, so the message goes out once, also across restarts;
 *   3. once per hour, today's scorecard snapshot of every service (computed for no particular reader); a day's
 *      snapshot is written during that day only, so trends never recompute history from changed data;
 *   4. retention: samples after OBJECTIVE_LIMITS.sampleRetentionDays, ended breaches after breachRetentionDays,
 *      snapshots after SCORECARD_LIMITS.snapshotRetentionDays.
 * Nothing happens while the vault is locked (audit entries and external channels need it).
 */

const HOUR = 3600000;
const DAY = 86400000;
const iso = (x: number) => new Date(x).toISOString();
const hourOf = (x: number) => iso(Math.floor(x / HOUR) * HOUR);

interface ServiceRow {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

/** Active users who own the service; administrators when nobody is named. */
function responsible(s: ServiceRow, all: UserInfo[]): UserInfo[] {
  const owners = parseJson<string[]>(s.owners, []);
  const named = all.filter((u) => owners.some((o) => matches(toAuthUser(u), o)));
  return named.length ? named : all.filter((u) => u.roles.includes('admin'));
}

const fmtPct = (l: Locale, x: number | null) =>
  x === null ? '–' : `${new Intl.NumberFormat(l, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(x)} %`;

function sendBreach(
  o: ObjectiveRow,
  s: ServiceRow,
  breachId: string,
  below: { window: ObjectiveWindow; target: number; value: number | null }[],
  users: UserInfo[],
): void {
  notify({
    event: 'objective.breached',
    text: (l) => ({
      title: t(l, 'objective.breachTitle', { name: titleName(o.name), service: titleName(s.name) }),
      body: t(l, 'objective.breachBody', {
        name: o.name,
        service: s.name,
        windows: below
          .map((w) =>
            t(l, 'objective.windowValue', {
              window: t(l, `objective.windows.${w.window}` as MessageKey),
              value: fmtPct(l, w.value),
              target: fmtPct(l, w.target),
            }),
          )
          .join('; '),
      }),
    }),
    link: `/services/${s.id}`,
    recipients: users,
    inAppKey: `objective:${o.id}:${breachId}`,
    externalKey: `objective:${o.id}:${breachId}`,
    data: { objectiveId: o.id, serviceId: s.id, breachId, windows: below.map((w) => w.window) },
  });
}

/** Samples every objective once per hour and starts/ends breaches. */
export function sampleObjectives(now = Date.now()): { sampled: number; breaches: number; recovered: number; notified: number } {
  const out = { sampled: 0, breaches: 0, recovered: 0, notified: 0 };
  const bucket = hourOf(now);
  const services = new Map(
    db()
      .all<ServiceRow>('SELECT id, name, owners, archived FROM services')
      .map((s) => [s.id, s]),
  );
  const cache = readingCache(now);
  let all: UserInfo[] | null = null;
  for (const o of db().all<ObjectiveRow>('SELECT * FROM availability_objectives ORDER BY id')) {
    const s = services.get(o.service_id);
    if (!s || s.archived || o.archived_at) continue;
    try {
      const reading = cache.read(o.platform_id, o.endpoint_key);
      const { windows, status } = judge(o, reading.values);
      const v = reading.values;
      const inserted = db().run(
        `INSERT INTO objective_samples (objective_id, bucket, value_h1, value_h24, value_d7, value_d30, status, sampled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (objective_id, bucket) DO NOTHING`,
        o.id,
        bucket,
        v.h1,
        v.h24,
        v.d7,
        v.d30,
        status,
        iso(now),
      ).changes;
      if (inserted !== 1) continue;
      out.sampled++;
      const open = db().get<{ id: string; started_at: string }>(
        'SELECT id, started_at FROM objective_breaches WHERE objective_id = ? AND ended_at IS NULL',
        o.id,
      );
      if (status === 'below' && !open) {
        const below = windows.filter((w) => w.status === 'below');
        const breachId = newId('obr_');
        // a flapping objective: no second message within the cooldown (every breach is still recorded)
        const send =
          !!o.notify &&
          !db().get(
            'SELECT 1 FROM objective_breaches WHERE objective_id = ? AND notified_at IS NOT NULL AND notified_at >= ?',
            o.id,
            iso(now - OBJECTIVE_LIMITS.breachMessageCooldownHours * HOUR),
          );
        db().tx(() => {
          db().run(
            'INSERT INTO objective_breaches (id, objective_id, started_at, ended_at, windows, notified_at) VALUES (?, ?, ?, NULL, ?, ?)',
            breachId,
            o.id,
            iso(now),
            JSON.stringify(below.map((w) => w.window)),
            send ? iso(now) : null,
          );
          audit({
            actor: 'system',
            action: 'objective.breached',
            entityType: 'objective',
            entityId: o.id,
            summary: `Availability objective "${o.name}" of service "${s.name}" below target (${below.map((w) => `${w.window}: ${w.value} % < ${w.target} %`).join(', ')})`,
            details: { serviceId: s.id, breachId, windows: below, notify: !!o.notify, messageSent: send },
          });
        });
        out.breaches++;
        if (send) {
          try {
            sendBreach(o, s, breachId, below, responsible(s, (all ??= listUsers().filter((u) => u.active))));
            out.notified++;
          } catch (err) {
            logger.warn({ err, objectiveId: o.id }, 'objective breach message could not be sent');
          }
        }
      } else if (status === 'met' && open) {
        db().tx(() => {
          db().run('UPDATE objective_breaches SET ended_at = ? WHERE id = ? AND ended_at IS NULL', iso(now), open.id);
          audit({
            actor: 'system',
            action: 'objective.recovered',
            entityType: 'objective',
            entityId: o.id,
            summary: `Availability objective "${o.name}" of service "${s.name}" met again`,
            details: { serviceId: s.id, breachId: open.id, since: open.started_at },
          });
        });
        out.recovered++;
      }
    } catch (err) {
      logger.warn({ err, objectiveId: o.id }, 'objective sample failed');
    }
  }
  return out;
}

/** Writes today's scorecard snapshot of every service (not archived), at most once per hour. Returns the rows written (null: not due). */
export function snapshotScorecards(now = Date.now(), force = false): number | null {
  const day = dayOf(now);
  const last = db().get<{ last_at: string | null }>('SELECT MAX(updated_at) AS last_at FROM scorecard_snapshots WHERE day = ?', day)?.last_at ?? null;
  if (!force && last && last >= hourOf(now)) return null;
  const cards = computeScorecards(undefined, null, now);
  db().tx(() => {
    // services archived (or gone) since the last snapshot of today are left out of today's
    db().run('DELETE FROM scorecard_snapshots WHERE day = ?', day);
    for (const { card: c, documentIds } of cards) {
      db().run(
        `INSERT INTO scorecard_snapshots (day, service_id, service_name, owners, attention, duties, availability, documentation, protection, document_ids, details, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        day,
        c.serviceId,
        c.serviceName,
        JSON.stringify(c.owners),
        c.attention ? 1 : 0,
        c.duties.status,
        c.availability.status,
        c.documentation.status,
        c.protection.status,
        JSON.stringify(documentIds),
        JSON.stringify({
          duties: { mandatory: c.duties.mandatory, recommended: c.duties.recommended, optional: c.duties.optional },
          availability: { total: c.availability.total, met: c.availability.met, below: c.availability.below, noData: c.availability.noData },
          objectives: c.availability.objectives.map((o) => ({ id: o.id, status: o.status })),
          documentation: {
            released: c.documentation.released,
            overdue: c.documentation.overdue,
            missing: c.documentation.missing,
          },
          protection: c.protection.dimensions.map((x) => ({ dimension: x.dimension, effective: x.effective, ok: x.ok })),
        }),
        iso(now),
      );
    }
  });
  return cards.length;
}

export function pruneScorecardData(now = Date.now()): { samples: number; breaches: number; snapshots: number } {
  return {
    samples: db().run('DELETE FROM objective_samples WHERE bucket < ?', iso(now - OBJECTIVE_LIMITS.sampleRetentionDays * DAY)).changes,
    breaches: db().run('DELETE FROM objective_breaches WHERE ended_at IS NOT NULL AND ended_at < ?', iso(now - OBJECTIVE_LIMITS.breachRetentionDays * DAY))
      .changes,
    snapshots: db().run('DELETE FROM scorecard_snapshots WHERE day < ?', dayOf(now - SCORECARD_LIMITS.snapshotRetentionDays * DAY)).changes,
  };
}

export function runScorecardJob(now = Date.now()): { sampled: number; breaches: number; notified: number; snapshots: number } {
  if (!vault().unlocked) return { sampled: 0, breaches: 0, notified: 0, snapshots: 0 };
  const s = sampleObjectives(now);
  let snapshots = 0;
  try {
    const n = snapshotScorecards(now);
    if (n !== null) {
      snapshots = n;
      pruneScorecardData(now);
    }
  } catch (err) {
    logger.warn({ err }, 'scorecard snapshot failed');
  }
  return { sampled: s.sampled, breaches: s.breaches, notified: s.notified, snapshots };
}
