import { OBJECTIVE_LIMITS, type Locale, type ObjectiveDetail, type ObjectiveStatus, type ObjectiveWindow, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { matches } from '../auth/permissions.js';
import { forbid, me } from '../records/access.js';
import { t, type MessageKey } from '../i18n/index.js';
import { notify, titleName } from '../notifications/service.js';
import { objectiveInMaintenance } from '../catalogue/maintenance.js';
import { canEdit, getObjective, judge, objectiveRow, readingCache, rowTargets, serviceRef, type ObjectiveRow, type ReadingCache } from './objectives.js';

/**
 * Samples of availability objectives and their breaches (#86): the hourly sample of the objective job (jobs.ts) and the
 * final sample taken when an objective is archived. A sample stores the values Steward has read from Gatus (no call to
 * Gatus: the metrics mode reads Gatus' uptime figures). A breach starts with the first sample below target and ends
 * with the first one that meets every target again ("recovered") or when the objective is archived ("archived");
 * "no data" neither starts nor ends one. Objectives with "notify" send one message when a breach starts, at most one
 * per objective within OBJECTIVE_LIMITS.breachMessageCooldownHours (every breach is recorded).
 */

const HOUR = 3600000;
const iso = (x: number) => new Date(x).toISOString();

export interface ServiceRow {
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
    about: { kind: 'service', id: s.id },
    inAppKey: `objective:${o.id}:${breachId}`,
    externalKey: `objective:${o.id}:${breachId}`,
    data: { objectiveId: o.id, serviceId: s.id, breachId, windows: below.map((w) => w.window) },
  });
}

export interface SampleOutcome {
  sampled: boolean;
  status: ObjectiveStatus | null;
  breach: boolean;
  recovered: boolean;
  notified: boolean;
}

/**
 * Stores one sample of an objective under `bucket` (the start of the hour; the moment of the archive for the final
 * sample) and starts or ends its breach. Nothing happens when the bucket has a sample already.
 */
export function recordSample(
  o: ObjectiveRow,
  s: ServiceRow,
  now: number,
  bucket: string,
  cache: ReadingCache,
  users: () => UserInfo[] = () => listUsers().filter((u) => u.active),
): SampleOutcome {
  const out: SampleOutcome = { sampled: false, status: null, breach: false, recovered: false, notified: false };
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
  if (inserted !== 1) return out;
  out.sampled = true;
  out.status = status;
  const open = db().get<{ id: string; started_at: string }>('SELECT id, started_at FROM objective_breaches WHERE objective_id = ? AND ended_at IS NULL', o.id);
  if (status === 'below' && !open) {
    const below = windows.filter((w) => w.status === 'below');
    const breachId = newId('obr_');
    // a flapping objective: no second message within the cooldown (every breach is still recorded)
    // no message during planned maintenance of the service or application (the breach is still recorded)
    const inMaintenance = objectiveInMaintenance(o, now);
    const send =
      !!o.notify &&
      !inMaintenance &&
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
        details: { serviceId: s.id, breachId, windows: below, notify: !!o.notify, messageSent: send, inMaintenance },
      });
    });
    out.breach = true;
    if (send) {
      try {
        sendBreach(o, s, breachId, below, responsible(s, users()));
        out.notified = true;
      } catch (err) {
        logger.warn({ err, objectiveId: o.id }, 'objective breach message could not be sent');
      }
    }
  } else if (status === 'met' && open) {
    db().tx(() => {
      db().run("UPDATE objective_breaches SET ended_at = ?, end_reason = 'recovered' WHERE id = ? AND ended_at IS NULL", iso(now), open.id);
      audit({
        actor: 'system',
        action: 'objective.recovered',
        entityType: 'objective',
        entityId: o.id,
        summary: `Availability objective "${o.name}" of service "${s.name}" met again`,
        details: { serviceId: s.id, breachId: open.id, since: open.started_at },
      });
    });
    out.recovered = true;
  }
  return out;
}

/**
 * Archives (or restores) an objective. It is not deleted: its samples and breaches stay until the retention removes
 * them. Archiving first takes a final sample from the newest figures Steward has read from Gatus (as the hourly sample
 * would – a breach that began since the last sample is recorded and announced; without figures the final sample says
 * "no data"), then ends a breach going on as "archived". An archived objective is no longer sampled and still counts
 * on the scorecard with the status of its final sample until its longest window has passed – archiving does not
 * clean a scorecard.
 */
export function setObjectiveArchived(objectiveId: string, archived: boolean, now = Date.now()): ObjectiveDetail {
  const u = me();
  const cur = objectiveRow(objectiveId);
  const s = serviceRef(cur.service_id);
  if (!canEdit(u, s)) forbid('change objectives of this service', 'changeService');
  if (!!cur.archived_at === archived) return getObjective(objectiveId);
  if (!archived && s.archived) throw new HttpError(409, 'The service is archived', 'OBJECTIVE_SERVICE_ARCHIVED', { id: s.id });
  const final = archived ? recordSample(cur, s, now, iso(now), readingCache(now)) : null;
  db().tx(() => {
    db().run(
      'UPDATE availability_objectives SET archived_at = ?, archived_by = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      archived ? iso(now) : null,
      archived ? u.username : null,
      nowIso(),
      u.username,
      objectiveId,
    );
    // a breach going on ends with the archive – recorded as ended by archiving, not as recovered
    if (archived)
      db().run("UPDATE objective_breaches SET ended_at = ?, end_reason = 'archived' WHERE objective_id = ? AND ended_at IS NULL", iso(now), objectiveId);
    audit({
      action: archived ? 'objective.archived' : 'objective.restored',
      entityType: 'objective',
      entityId: objectiveId,
      summary: `Availability objective "${cur.name}" of service "${s.name}" ${archived ? `archived (final status: ${final?.status ?? 'unchanged'})` : 'restored'}`,
      details: { serviceId: s.id, platformId: cur.platform_id, endpointKey: cur.endpoint_key, targets: rowTargets(cur), finalStatus: final?.status ?? null },
    });
  });
  return getObjective(objectiveId);
}
