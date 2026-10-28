import { OBJECTIVE_LIMITS, SCORECARD_LIMITS, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { listUsers } from '../auth/users.js';
import { readingCache, type ObjectiveRow } from './objectives.js';
import { recordSample, type ServiceRow } from './sampling.js';
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

/** Samples every objective that is not archived once per hour and starts/ends breaches (sampling.ts). */
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
  const users = () => (all ??= listUsers().filter((u) => u.active));
  for (const o of db().all<ObjectiveRow>('SELECT * FROM availability_objectives ORDER BY id')) {
    const s = services.get(o.service_id);
    if (!s || s.archived || o.archived_at) continue;
    try {
      const r = recordSample(o, s, now, bucket, cache, users);
      if (r.sampled) out.sampled++;
      if (r.breach) out.breaches++;
      if (r.recovered) out.recovered++;
      if (r.notified) out.notified++;
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
        `INSERT INTO scorecard_snapshots (day, service_id, service_name, owners, attention, duties, availability, documentation, protection, lifecycle, document_ids, details, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        day,
        c.serviceId,
        c.serviceName,
        JSON.stringify(c.owners),
        c.attention ? 1 : 0,
        c.duties.status,
        c.availability.status,
        c.documentation.status,
        c.protection.status,
        c.lifecycle.status,
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
          lifecycle: { enabled: c.lifecycle.enabled, entries: c.lifecycle.entries, eol: c.lifecycle.eol, ending: c.lifecycle.ending },
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
