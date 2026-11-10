import {
  CA_LIMITS,
  CA_SOURCE_DEFAULTS,
  CA_SOURCE_SWITCHES,
  INCIDENT_TYPE_ID,
  caConfirmInput,
  caSettingsInput,
  type CaSettings,
  type CaSeverity,
  type CaSource,
  type CaSourceSwitch,
  type CaSuggestion,
  type CaSuggestionList,
  type CaSuggestionStatus,
  type PersonReviewSource,
} from '@sm/shared';
import type { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { hasRole, isAdmin } from '../auth/permissions.js';
import { canEditService, canViewCatalogue } from '../records/access.js';
import { readSetting, writeSetting } from '../settings.js';
import { isoWeek } from '../backup/retention.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { forbid, me } from './access.js';
import { CaContext, getFinding, insertFinding, listFindings, sourceRef, type FindingFilter } from './corrective.js';

/**
 * Suggestions of the register of corrective actions (ADR 0029 part 3): Steward notices events that may be
 * nonconformities and suggests a finding for each; a person confirms it (a pre-filled finding) or dismisses it with a
 * reason – nothing becomes a finding without a person. Each suggestion has a source key (a duty period, an incident
 * review, a person review, a reconciliation check and week …) that is unique, so the same event is suggested once,
 * also after it was dismissed.
 *
 * The sources are a registry: each one reads its events and returns candidates. Switched on and off by an
 * administrator (tab Settings); the defaults are ADR 0029 decision 6. A new source (the supplier review of ADR 0029
 * part 1: expired certificate, missed supplier review, a finding recorded from the supplier page) registers itself
 * with registerSuggestionSource() from its feature and adds its switch to CA_SOURCE_SWITCHES (shared/src/corrective.ts).
 */

const SETTINGS_KEY = 'compliance.corrective';
const DAY = 86_400_000;
const READS_ALL = ['admin', 'auditor', 'designer', 'approver'];

// ---------- settings ----------

interface StoredSettings {
  sources?: Partial<Record<string, boolean>>;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/** Which sources are on: the stored switches, the default for a switch never set (so a new source starts at its default). */
export function sourceSwitches(): Record<CaSourceSwitch, boolean> {
  const s = readSetting<StoredSettings>(SETTINGS_KEY, {}).sources ?? {};
  return Object.fromEntries(CA_SOURCE_SWITCHES.map((k) => [k, typeof s[k] === 'boolean' ? s[k] : CA_SOURCE_DEFAULTS[k]])) as Record<CaSourceSwitch, boolean>;
}

export function getSettings(): CaSettings {
  const u = me();
  const s = readSetting<StoredSettings>(SETTINGS_KEY, {});
  return { sources: sourceSwitches(), updatedAt: s.updatedAt ?? null, updatedBy: s.updatedBy ?? null, canEdit: isAdmin(u) };
}

export function updateSettings(input: z.input<typeof caSettingsInput>): CaSettings {
  const u = me();
  if (!isAdmin(u)) forbid('change the sources of suggestions (administrators)', 'manageCorrective');
  const v = caSettingsInput.parse(input);
  const before = sourceSwitches();
  const after = { ...before, ...v.sources };
  const changed = CA_SOURCE_SWITCHES.filter((k) => before[k] !== after[k]);
  if (!changed.length) return getSettings();
  db().tx(() => {
    writeSetting(SETTINGS_KEY, { sources: after, updatedAt: nowIso(), updatedBy: u.username } satisfies StoredSettings);
    audit({
      action: 'corrective.settings_changed',
      entityType: 'settings',
      entityId: SETTINGS_KEY,
      summary: `Suggestion sources of corrective actions changed: ${changed.map((k) => `${k} ${after[k] ? 'on' : 'off'}`).join(', ')}`,
      details: { before, after },
    });
  });
  // a source switched on suggests right away (at the next run of the job, not after an hour)
  lastScan = 0;
  return getSettings();
}

// ---------- the sources ----------

/** One event that may be a nonconformity. */
export interface SuggestionCandidate {
  source: CaSource;
  /** Unique per event: the same key is never suggested twice */
  sourceKey: string;
  sourceKind: string | null;
  sourceId: string | null;
  sourceLabel: string;
  serviceId: string | null;
  controlIds: string[];
  recordId: string | null;
  /** English (API, MCP); the web app translates details.kind with the other details */
  title: string;
  details: Record<string, string | number> & { kind: string };
  severity: CaSeverity;
  occurredAt: string;
}

export interface SuggestionSourceDef {
  /** Short name (logs) */
  name: string;
  /** The events since `since` (ISO), as candidates; `on` says which switches are on */
  collect: (o: { now: number; since: string; on: (s: CaSourceSwitch) => boolean }) => SuggestionCandidate[];
}

const SOURCES: SuggestionSourceDef[] = [];

/** The extension point for further sources (the supplier review of ADR 0029 part 1). */
export function registerSuggestionSource(s: SuggestionSourceDef): void {
  if (!SOURCES.some((x) => x.name === s.name)) SOURCES.push(s);
}

/** The controls an item is mapped to (control_tags), as the suggestion's pre-filled controls. */
const controlsOf = (kind: string, ...targetIds: string[]): string[] =>
  targetIds.length
    ? [
        ...new Set(
          db()
            .all<{ control_id: string }>(
              `SELECT control_id FROM control_tags WHERE kind = ? AND target_id IN (${targetIds.map(() => '?').join(', ')}) ORDER BY control_id`,
              kind,
              ...targetIds,
            )
            .map((r) => r.control_id),
        ),
      ].slice(0, CA_LIMITS.controls)
    : [];

/** Missed or failed periods of mandatory (on by default) and recommended (off by default) duties. */
registerSuggestionSource({
  name: 'duties',
  collect: ({ since, on }) => {
    const levels = [on('dutyMandatory') && 'mandatory', on('dutyRecommended') && 'recommended'].filter((x): x is string => !!x);
    if (!levels.length) return [];
    return db()
      .all<{
        duty_id: string;
        period_key: string;
        status: string;
        level: string;
        duty_name: string;
        service_id: string;
        process_id: string;
        grace_end: string;
        closed_at: string;
      }>(
        `SELECT duty_id, period_key, status, level, duty_name, service_id, process_id, grace_end, closed_at FROM duty_periods
         WHERE closed_at IS NOT NULL AND status IN ('missed', 'failed') AND level IN (${levels.map(() => '?').join(', ')}) AND grace_end >= ?
         ORDER BY grace_end`,
        ...levels,
        since,
      )
      .map((p) => ({
        source: 'duty' as const,
        sourceKey: `duty:${p.duty_id}:${p.period_key}`,
        sourceKind: 'duty',
        sourceId: p.duty_id,
        sourceLabel: `${p.duty_name} · ${p.period_key}`,
        serviceId: p.service_id,
        controlIds: controlsOf('process', p.process_id),
        recordId: null,
        title: `${p.level === 'mandatory' ? 'Mandatory' : 'Recommended'} duty "${p.duty_name}" ${p.status} in period ${p.period_key}`,
        details: { kind: p.status === 'failed' ? 'dutyFailed' : 'dutyMissed', duty: p.duty_name, period: p.period_key, level: p.level },
        severity: p.level === 'mandatory' ? ('minor' as const) : ('observation' as const),
        occurredAt: p.grace_end,
      }));
  },
});

/** Accepted incident reviews: severity major or critical (on by default), minor (off by default). */
registerSuggestionSource({
  name: 'incidents',
  collect: ({ since, on }) => {
    if (!on('incidentMajor') && !on('incidentMinor')) return [];
    const out: SuggestionCandidate[] = [];
    for (const r of db().all<{ id: string; number: string; title: string; fields: string; accepted_at: string }>(
      `SELECT r.id, r.number, r.title, r.fields, MIN(e.created_at) AS accepted_at FROM records r
       JOIN record_events e ON e.record_id = r.id AND e.kind = 'transition' AND e.to_status = 'accepted'
       WHERE r.type_id = ? AND e.created_at >= ?
       GROUP BY r.id, r.number, r.title, r.fields ORDER BY accepted_at`,
      INCIDENT_TYPE_ID,
      since,
    )) {
      const severity = String(parseJson<Record<string, unknown>>(r.fields, {}).severity ?? '');
      const major = severity === 'major' || severity === 'critical';
      if (major ? !on('incidentMajor') : !on('incidentMinor')) continue;
      const service = db().get<{ id: string }>(
        `SELECT to_id AS id FROM item_links WHERE from_kind = 'record' AND from_id = ? AND to_kind = 'service'
         UNION SELECT from_id AS id FROM item_links WHERE from_kind = 'service' AND to_kind = 'record' AND to_id = ? ORDER BY id`,
        r.id,
        r.id,
      );
      out.push({
        source: 'incidentReview',
        sourceKey: `incident:${r.id}`,
        sourceKind: 'record',
        sourceId: r.id,
        sourceLabel: `${r.number} ${r.title}`,
        serviceId: service?.id ?? null,
        controlIds: [...new Set([...controlsOf('recordType', INCIDENT_TYPE_ID), ...controlsOf('record', r.id)])],
        recordId: r.id,
        title: `Incident review ${r.number} accepted (${severity || 'no severity'}): ${r.title}`.slice(0, CA_LIMITS.title),
        details: { kind: 'incident', record: r.number, title: r.title, severity: severity || '–' },
        severity: major ? 'major' : 'minor',
        occurredAt: r.accepted_at,
      });
    }
    return out;
  },
});

/** Person access reviews whose removals are still there 30 days after their approval (on by default). */
registerSuggestionSource({
  name: 'person-reviews',
  collect: ({ now, since, on }) => {
    if (!on('personReview')) return [];
    const due = new Date(now - CA_LIMITS.personReviewDays * DAY).toISOString();
    const out: SuggestionCandidate[] = [];
    for (const r of db().all<{ id: string; title: string; person_name: string; sources: string; approved_at: string }>(
      "SELECT id, title, person_name, sources, approved_at FROM person_reviews WHERE status = 'approved' AND approved_at <= ? AND approved_at >= ? ORDER BY approved_at",
      due,
      new Date(Date.parse(since) - CA_LIMITS.personReviewDays * DAY).toISOString(),
    )) {
      const left = Number(
        db().get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM person_review_items WHERE review_id = ? AND decision = 'remove' AND (recheck IS NULL OR recheck <> 'gone')",
          r.id,
        )!.n,
      );
      if (!left) continue;
      const checks = parseJson<PersonReviewSource[]>(r.sources, []).map((s) => s.checkId);
      out.push({
        source: 'accessReview',
        sourceKey: `personReview:${r.id}`,
        sourceKind: 'personReview',
        sourceId: r.id,
        sourceLabel: r.title,
        serviceId: null,
        controlIds: controlsOf('accessCheck', ...checks),
        recordId: null,
        title: `Person review "${r.title}": ${left} removal(s) not confirmed gone ${CA_LIMITS.personReviewDays} days after approval`.slice(0, CA_LIMITS.title),
        details: { kind: 'personReview', review: r.title, person: r.person_name, count: left, days: CA_LIMITS.personReviewDays },
        severity: 'minor',
        occurredAt: new Date(Date.parse(r.approved_at) + CA_LIMITS.personReviewDays * DAY).toISOString(),
      });
    }
    return out;
  },
});

/**
 * Reconciliation findings still open after seven days (off by default): one suggestion per check and ISO week, so a
 * check with many open findings brings one suggestion a week, not one per finding.
 */
registerSuggestionSource({
  name: 'reconciliation',
  collect: ({ now, on }) => {
    if (!on('reconciliation')) return [];
    const week = isoWeek(new Date(now));
    return db()
      .all<{ check_id: string; name: string; n: number; oldest: string }>(
        `SELECT f.check_id, c.name, COUNT(*) AS n, MIN(f.detected_at) AS oldest FROM access_findings f JOIN access_checks c ON c.id = f.check_id
         WHERE f.status = 'open' AND f.detected_at <= ? GROUP BY f.check_id, c.name ORDER BY f.check_id`,
        new Date(now - CA_LIMITS.reconciliationDays * DAY).toISOString(),
      )
      .map((c) => ({
        source: 'reconciliation' as const,
        sourceKey: `reconciliation:${c.check_id}:${week}`,
        sourceKind: 'accessCheck',
        sourceId: c.check_id,
        sourceLabel: c.name,
        serviceId: null,
        controlIds: controlsOf('accessCheck', c.check_id),
        recordId: null,
        title: `Access check "${c.name}": ${Number(c.n)} finding(s) open for more than ${CA_LIMITS.reconciliationDays} days (${week})`.slice(
          0,
          CA_LIMITS.title,
        ),
        details: { kind: 'reconciliation', check: c.name, count: Number(c.n), days: CA_LIMITS.reconciliationDays, week },
        severity: 'minor' as const,
        occurredAt: c.oldest,
      }));
  },
});

// ---------- scanning ----------

let lastScan = 0;

/**
 * Asks every source for its events of the last 90 days and stores the new ones as pending suggestions – at most 1,000
 * pending; further ones wait for the next run. Hourly (the job asks every five minutes); `force` runs it now.
 */
export function scanSuggestions(now = Date.now(), force = false): { added: number; waiting: number } {
  if (!force && now - lastScan < 3600_000) return { added: 0, waiting: 0 };
  lastScan = now;
  const switches = sourceSwitches();
  const on = (s: CaSourceSwitch) => switches[s];
  const since = new Date(now - CA_LIMITS.lookbackDays * DAY).toISOString();
  let pending = Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM ca_suggestions WHERE status = 'pending'")!.n);
  let added = 0;
  let waiting = 0;
  for (const src of SOURCES) {
    for (const c of src.collect({ now, since, on })) {
      if (db().get('SELECT 1 FROM ca_suggestions WHERE source_key = ?', c.sourceKey)) continue;
      if (pending >= CA_LIMITS.pendingSuggestions) {
        waiting++;
        continue;
      }
      const inserted = db().run(
        `INSERT INTO ca_suggestions (id, source, source_key, source_kind, source_id, source_label, service_id, control_ids, record_id, title, details,
           severity, occurred_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT (source_key) DO NOTHING`,
        newId('cas_'),
        c.source,
        c.sourceKey,
        c.sourceKind,
        c.sourceId,
        c.sourceLabel.slice(0, CA_LIMITS.sourceLabel),
        c.serviceId,
        JSON.stringify(c.controlIds),
        c.recordId,
        c.title.slice(0, CA_LIMITS.title),
        JSON.stringify(c.details),
        c.severity,
        c.occurredAt,
        nowIso(),
      ).changes;
      if (inserted) {
        pending++;
        added++;
      }
    }
  }
  return { added, waiting };
}

// ---------- reading and deciding ----------

interface SuggestionRow {
  id: string;
  source: CaSource;
  source_key: string;
  source_kind: string | null;
  source_id: string | null;
  source_label: string;
  service_id: string | null;
  control_ids: string;
  record_id: string | null;
  title: string;
  details: string;
  severity: CaSeverity;
  occurred_at: string;
  status: CaSuggestionStatus;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string;
  finding_id: string | null;
}

/** Suggestions without a service: the roles that read the whole register; with one: also the service's editors. */
function canSee(u: AuthUser, s: Pick<SuggestionRow, 'service_id'>, ctx: CaContext): boolean {
  if (hasRole(u, READS_ALL)) return true;
  const svc = ctx.service(s.service_id);
  return !!svc && canEditService(u, { kind: 'service', id: svc.id, owners: svc.owners });
}

/** Confirm or dismiss: designers, administrators and the service's editors. */
function canDecide(u: AuthUser, s: Pick<SuggestionRow, 'service_id'>, ctx: CaContext): boolean {
  if (hasRole(u, ['admin', 'designer'])) return true;
  const svc = ctx.service(s.service_id);
  return !!svc && canEditService(u, { kind: 'service', id: svc.id, owners: svc.owners });
}

function toSuggestion(r: SuggestionRow, u: AuthUser, ctx: CaContext): CaSuggestion {
  const svc = ctx.service(r.service_id);
  const finding = r.finding_id ? db().get<{ number: string }>('SELECT number FROM ca_findings WHERE id = ?', r.finding_id) : undefined;
  return {
    id: r.id,
    source: r.source,
    sourceKey: r.source_key,
    sourceRef: sourceRef(r.source_kind, r.source_id, r.source_label, u),
    serviceId: r.service_id,
    serviceName: svc && canViewCatalogue(u, { kind: 'service', id: svc.id, owners: svc.owners }) ? svc.name : null,
    controls: ctx.controlRefs(parseJson<string[]>(r.control_ids, [])),
    title: r.title,
    details: { kind: 'other', ...parseJson<Record<string, string | number>>(r.details, {}) },
    severity: r.severity,
    recordId: r.record_id,
    occurredAt: r.occurred_at,
    status: r.status,
    createdAt: r.created_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    reason: r.reason,
    findingId: r.finding_id,
    findingNumber: finding?.number ?? null,
    canDecide: r.status === 'pending' && canDecide(u, r, ctx),
  };
}

export function pendingSuggestionCount(u: AuthUser): number {
  const ctx = new CaContext();
  return db()
    .all<Pick<SuggestionRow, 'service_id'>>("SELECT service_id FROM ca_suggestions WHERE status = 'pending'")
    .filter((s) => canSee(u, s, ctx)).length;
}

/** The register with the number of pending suggestions the person may see. */
export const listRegister = (f: FindingFilter = {}) => listFindings(f, pendingSuggestionCount);

export function listSuggestions(status: CaSuggestionStatus | 'all' = 'pending'): CaSuggestionList {
  const u = me();
  const ctx = new CaContext();
  const rows = db().all<SuggestionRow>(
    `SELECT * FROM ca_suggestions ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY occurred_at DESC, id LIMIT 5000`,
    ...(status === 'all' ? [] : [status]),
  );
  const pendingAll = Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM ca_suggestions WHERE status = 'pending'")!.n);
  return {
    items: rows.filter((r) => canSee(u, r, ctx)).map((r) => toSuggestion(r, u, ctx)),
    pending: pendingSuggestionCount(u),
    limit: CA_LIMITS.pendingSuggestions,
    atLimit: pendingAll >= CA_LIMITS.pendingSuggestions,
  };
}

function pendingSuggestion(id: string, u: AuthUser, ctx: CaContext): SuggestionRow {
  const r = db().get<SuggestionRow>('SELECT * FROM ca_suggestions WHERE id = ?', id);
  if (!r || !canSee(u, r, ctx)) throw new HttpError(404, `Suggestion ${id} not found`, 'CA_SUGGESTION_NOT_FOUND', { id });
  if (r.status !== 'pending') throw new HttpError(409, `The suggestion was ${r.status} already`, 'CA_SUGGESTION_DECIDED', { status: r.status });
  if (!canDecide(u, r, ctx)) forbid('decide suggestions of corrective actions (designers, administrators and the editors of the service)', 'recordCorrective');
  return r;
}

/** Confirms a suggestion: a finding pre-filled from it (with the person's changes), linked to what it came from. */
export function confirmSuggestion(id: string, input: z.input<typeof caConfirmInput>) {
  const u = me();
  const v = caConfirmInput.parse(input);
  const ctx = new CaContext();
  const r = pendingSuggestion(id, u, ctx);
  const findingId = db().tx(() => {
    const f = insertFinding(
      {
        title: v.title ?? r.title,
        description: v.description ?? '',
        severity: v.severity ?? r.severity,
        serviceId: v.serviceId !== undefined ? v.serviceId : r.service_id,
        controlIds: v.controlIds ?? parseJson<string[]>(r.control_ids, []),
        owner: v.owner ?? null,
        dueDate: v.dueDate ?? null,
        cause: v.cause ?? '',
        grcRef: v.grcRef ?? '',
        grcUrl: v.grcUrl ?? '',
        source: r.source,
        sourceKind: r.source_kind,
        sourceId: r.source_id,
        sourceLabel: r.source_label,
        recordId: r.record_id,
        suggestionId: r.id,
      },
      ctx,
      u,
    );
    const now = nowIso();
    if (
      !db().run(
        "UPDATE ca_suggestions SET status = 'confirmed', decided_by = ?, decided_at = ?, finding_id = ? WHERE id = ? AND status = 'pending'",
        u.username,
        now,
        f.id,
        r.id,
      ).changes
    )
      throw new HttpError(409, 'The suggestion was decided already', 'CA_SUGGESTION_DECIDED', { status: 'decided' });
    audit({
      action: 'corrective.suggestion_confirmed',
      entityType: 'corrective_suggestion',
      entityId: r.id,
      summary: `Suggestion "${r.title}" confirmed as finding ${f.number}`,
      details: { sourceKey: r.source_key, source: r.source, findingId: f.id, number: f.number },
    });
    return f.id;
  });
  return getFinding(findingId);
}

export function dismissSuggestion(id: string, reason: string): CaSuggestion {
  const u = me();
  const ctx = new CaContext();
  const r = pendingSuggestion(id, u, ctx);
  const now = nowIso();
  db().tx(() => {
    db().run("UPDATE ca_suggestions SET status = 'dismissed', decided_by = ?, decided_at = ?, reason = ? WHERE id = ?", u.username, now, reason, r.id);
    audit({
      action: 'corrective.suggestion_dismissed',
      entityType: 'corrective_suggestion',
      entityId: r.id,
      summary: `Suggestion "${r.title}" dismissed: ${reason.slice(0, 300)}`,
      details: { sourceKey: r.source_key, source: r.source, reason },
    });
  });
  return toSuggestion(db().get<SuggestionRow>('SELECT * FROM ca_suggestions WHERE id = ?', r.id)!, u, new CaContext());
}
