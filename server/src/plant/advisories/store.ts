import {
  ADVISORY_LIMITS as L,
  ADVISORY_SEVERITY_RANK,
  type AdvisoryAssetMatch,
  type AdvisoryDecisionInput,
  type AdvisoryDetail,
  type AdvisoryFix,
  type AdvisoryIntegrity,
  type AdvisoryList,
  type AdvisoryMatchKind,
  type AdvisoryMatchReason,
  type AdvisoryProfileMatch,
  type AdvisoryRemediationInput,
  type AdvisoryRemediationState,
  type AdvisoryRemediationStatus,
  type AdvisorySeverity,
  type AdvisorySiteInput,
  type AdvisorySort,
  type AdvisorySiteState,
  type AdvisoryStatus,
  type AdvisorySummary,
  type AdvisoryTile,
  type AdvisoryUploadInput,
  type AdvisoryUploadResult,
  type AdvisoryZoneRef,
  type AssetAdvisories,
  type PlantPermission,
} from '@sm/shared';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import { currentUser, type AuthUser } from '../../auth/context.js';
import { forbid, me } from '../../auth/access.js';
import { logger } from '../../log.js';
import { HttpError, nowIso, parseJson } from '../../util.js';
import { likeEscape } from '../../database/sql.js';
import { canManageCatalogue, siteRights } from '../access.js';
import { plantEnabled } from '../settings.js';
import { advisoryId, assertPublicTlp, parseCsaf, type CsafContent, type ParsedCsaf } from './csaf.js';
import { matchAdvisory, matchProfile, normVendor, type MatchCandidate, type MatchResult } from './match.js';

/**
 * Advisories as Steward keeps them (docs/ADVISORIES.md): one row per CSAF document (publisher namespace + tracking
 * id; a newer release replaces the older one), the assets it matches with the decisions and remediation people
 * recorded, and a site's "not applicable". Everything a reader gets is limited to the sites they may see – an
 * advisory itself (a published document) everyone in the plant registry sees.
 *
 * Matches are computed when a document arrives and again whenever the plant data they depend on changed (manufacturer,
 * model, site of an asset, its assignment's profile and firmware, a profile's manufacturer, model and version) – checked
 * by a cheap fingerprint before every read and by the advisories job, so no plant write path needs to know about them.
 * A match that no longer holds (the firmware was updated) stays with its decisions but no longer counts (current 0).
 */

export interface AdvisoryRow {
  id: string;
  publisher: string;
  namespace: string;
  tracking_id: string;
  title: string;
  category: string;
  doc_status: string;
  version: string;
  initial_release: string;
  current_release: string;
  language: string;
  tlp: string;
  aggregate_severity: string;
  severity: string;
  cvss: number | null;
  cves: string;
  vendors: string;
  content: string;
  document: string;
  sha256: string;
  size: number;
  origin: string;
  source_id: string | null;
  url: string;
  file_name: string;
  integrity: string;
  signature_url: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface MatchRow {
  advisory_id: string;
  asset_id: string;
  site_id: string;
  kind: string;
  current: number;
  product_ids: string;
  cves: string;
  cvss: number | null;
  severity: string;
  reasons: string;
  fixes: string;
  first_matched_at: string;
  last_matched_at: string;
  decision: string | null;
  decision_reason: string;
  decided_by: string | null;
  decided_at: string | null;
  remediation: string;
  remediation_reason: string;
  remediation_until: string | null;
  remediation_window: string | null;
  remediation_change_set: string | null;
  remediation_note: string;
  remediation_by: string | null;
  remediation_at: string | null;
  notified_at: string | null;
}

interface SiteRow {
  advisory_id: string;
  site_id: string;
  not_applicable: number;
  reason: string;
  decided_by: string;
  decided_at: string;
}

/** Columns of the list (not the documents) */
const LIST_COLUMNS =
  'id, publisher, namespace, tracking_id, title, category, doc_status, version, initial_release, current_release, severity, cvss, cves, origin, source_id, created_at';

const today = () => nowIso().slice(0, 10);
const counted = (m: Pick<MatchRow, 'kind' | 'decision' | 'current'>) =>
  m.current === 1 && ((m.kind === 'exact' && m.decision !== 'dismissed') || (m.kind === 'possible' && m.decision === 'confirmed'));
const pending = (m: Pick<MatchRow, 'kind' | 'decision' | 'current'>) => m.current === 1 && m.kind === 'possible' && m.decision === null;
const acceptExpired = (m: Pick<MatchRow, 'remediation' | 'remediation_until'>) =>
  m.remediation === 'accepted' && !!m.remediation_until && m.remediation_until < today();
const stillOpen = (m: MatchRow) => m.remediation === 'open' || m.remediation === 'planned' || acceptExpired(m);

// ---------- the reader's view: sites, names, zones ----------

interface Reader {
  user: AuthUser | null;
  rights: Map<string, PlantPermission[]>;
  siteNames: Map<string, string>;
}

function reader(u: AuthUser | null = currentUser()): Reader {
  const rows = db().all<{ id: string; acl: string; name: string }>('SELECT id, acl, name FROM plant_sites');
  return { user: u, rights: siteRights(rows, u), siteNames: new Map(rows.map((r) => [r.id, r.name])) };
}
const sees = (r: Reader, siteId: string) => r.rights.get(siteId)?.includes('view') ?? false;
const manages = (r: Reader, siteId: string) => r.rights.get(siteId)?.includes('manage') ?? false;

/** The zones of assets: through the VLANs of their devices (IEC 62443-3-2 zones of the site that hold those VLANs). */
function zonesOf(assetIds: string[]): Map<string, AdvisoryZoneRef[]> {
  const out = new Map<string, AdvisoryZoneRef[]>();
  if (!assetIds.length) return out;
  const wanted = new Set(assetIds);
  const devices = db()
    .all<{ asset_id: string; vlan_id: string | null; site_id: string }>(
      'SELECT d.asset_id, d.vlan_id, a.site_id FROM plant_devices d JOIN plant_assets a ON a.id = d.asset_id WHERE d.vlan_id IS NOT NULL',
    )
    .filter((d) => wanted.has(d.asset_id));
  if (!devices.length) return out;
  const zones = db().all<{ site_id: string; id: string; name: string; vlans: string; sl_target: number | null }>(
    'SELECT site_id, id, name, vlans, sl_target FROM plant_zones ORDER BY site_id, position, id',
  );
  for (const d of devices) {
    const list = out.get(d.asset_id) ?? [];
    for (const z of zones)
      if (z.site_id === d.site_id && parseJson<string[]>(z.vlans, []).includes(d.vlan_id!) && !list.some((x) => x.id === z.id))
        list.push({ siteId: z.site_id, id: z.id, name: z.name, slTarget: z.sl_target === null ? null : Number(z.sl_target) });
    out.set(d.asset_id, list);
  }
  return out;
}

// ---------- matching ----------

/** Every asset that is not decommissioned, with its assignment's firmware and its device profile (bases followed). */
export function candidates(): MatchCandidate[] {
  const profiles = new Map(
    db()
      .all<{ id: string; manufacturer: string; model: string; version: string; base_id: string | null }>(
        'SELECT id, manufacturer, model, version, base_id FROM plant_profiles',
      )
      .map((p) => [p.id, p]),
  );
  // a derived profile without its own manufacturer, model or version takes its base's
  const field = (id: string, k: 'manufacturer' | 'model' | 'version'): string => {
    let p = profiles.get(id);
    for (let i = 0; p && i < 20; i++) {
      if (p[k]) return p[k];
      p = p.base_id ? profiles.get(p.base_id) : undefined;
    }
    return '';
  };
  return db()
    .all<{ id: string; site_id: string; manufacturer: string; model: string; firmware: string | null; profile_id: string | null }>(
      `SELECT a.id, a.site_id, a.manufacturer, a.model, s.firmware, s.profile_id
       FROM plant_assets a LEFT JOIN plant_assignments s ON s.asset_id = a.id
       WHERE a.status <> 'decommissioned' ORDER BY a.id`,
    )
    .map((a) => ({
      assetId: a.id,
      siteId: a.site_id,
      manufacturer: a.manufacturer,
      model: a.model,
      firmware: a.firmware ?? '',
      profile:
        a.profile_id && profiles.has(a.profile_id)
          ? {
              id: a.profile_id,
              manufacturer: field(a.profile_id, 'manufacturer'),
              model: field(a.profile_id, 'model'),
              version: field(a.profile_id, 'version'),
            }
          : null,
    }));
}

/** The normalised vendors an advisory names (to skip documents no asset can match). */
export const vendorsOf = (content: CsafContent): string[] => [...new Set(content.products.map((p) => normVendor(p.vendor)).filter(Boolean))].slice(0, 500);

function vendorsMeet(advisory: string[], assets: Set<string>): boolean {
  for (const v of advisory) {
    if (assets.has(v)) return true;
    for (const a of assets) {
      const [short, long] = a.length <= v.length ? [a, v] : [v, a];
      if (short.length >= 4 && long.includes(short)) return true;
    }
  }
  return false;
}

/**
 * Writes the matches of one advisory: new ones are added, existing ones keep their decisions and remediation (their
 * reasons and kind are updated), ones that no longer hold become current 0. Returns the counted matches that are new.
 */
function writeMatches(advisoryId: string, found: Map<string, MatchResult>, sites: Map<string, string>): { counted: number; possible: number } {
  const now = nowIso();
  const before = new Map(
    db()
      .all<MatchRow>('SELECT * FROM plant_advisory_matches WHERE advisory_id = ?', advisoryId)
      .map((m) => [m.asset_id, m]),
  );
  let countedN = 0;
  let possible = 0;
  for (const [assetId, m] of found) {
    const site = sites.get(assetId) ?? '';
    const old = before.get(assetId);
    const values = [m.kind, JSON.stringify(m.productIds), JSON.stringify(m.cves), m.cvss, m.severity, JSON.stringify(m.reasons), JSON.stringify(m.fixes)];
    if (old)
      db().run(
        `UPDATE plant_advisory_matches SET kind = ?, product_ids = ?, cves = ?, cvss = ?, severity = ?, reasons = ?, fixes = ?, site_id = ?, current = 1, last_matched_at = ?
         WHERE advisory_id = ? AND asset_id = ?`,
        ...values,
        site,
        now,
        advisoryId,
        assetId,
      );
    else
      db().run(
        `INSERT INTO plant_advisory_matches (advisory_id, asset_id, site_id, kind, product_ids, cves, cvss, severity, reasons, fixes, first_matched_at, last_matched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        advisoryId,
        assetId,
        site,
        ...values,
        now,
        now,
      );
    if (m.kind === 'exact') countedN++;
    else possible++;
  }
  for (const [assetId, old] of before)
    if (!found.has(assetId) && old.current === 1)
      db().run('UPDATE plant_advisory_matches SET current = 0 WHERE advisory_id = ? AND asset_id = ?', advisoryId, assetId);
  return { counted: countedN, possible };
}

/** What the matches depend on, cheaply: counts, latest changes and revisions of assets, assignments and profiles. */
export function plantFingerprint(): string {
  const of = (table: string) => {
    const r = db().get<{ n: number; at: string | null; rev: number | null }>(`SELECT COUNT(*) AS n, MAX(updated_at) AS at, SUM(revision) AS rev FROM ${table}`);
    return `${r?.n ?? 0}:${r?.at ?? ''}:${r?.rev ?? 0}`;
  };
  return [of('plant_assets'), of('plant_assignments'), of('plant_profiles')].join('|');
}

interface Batch {
  list: MatchCandidate[];
  sites: Map<string, string>;
  assetVendors: Set<string>;
  withMatches: Set<string>;
}
const batchOf = (): Batch => {
  const list = candidates();
  return {
    list,
    sites: new Map(list.map((c) => [c.assetId, c.siteId])),
    assetVendors: new Set(list.flatMap((c) => [normVendor(c.manufacturer), c.profile ? normVendor(c.profile.manufacturer) : '']).filter(Boolean)),
    withMatches: new Set(
      db()
        .all<{ advisory_id: string }>('SELECT DISTINCT advisory_id FROM plant_advisory_matches WHERE current = 1')
        .map((r) => r.advisory_id),
    ),
  };
};

/** Matches one advisory and stamps it with the plant data it was matched against; one without a vendor any asset has is only stamped. */
function matchOne(id: string, vendors: string, b: Batch, stamp: string): number {
  let n = 0;
  if (b.withMatches.has(id) || vendorsMeet(parseJson<string[]>(vendors, []), b.assetVendors)) {
    const row = db().get<{ content: string }>('SELECT content FROM plant_advisories WHERE id = ?', id);
    if (row) {
      const content = parseJson<CsafContent>(row.content, { summary: '', products: [], vulnerabilities: [], references: [] });
      const found = matchAdvisory(content, b.list);
      db().tx(() => {
        const w = writeMatches(id, found, b.sites);
        n = w.counted + w.possible;
        db().run('UPDATE plant_advisories SET match_stamp = ? WHERE id = ?', stamp, id);
      });
      return n;
    }
  }
  db().run('UPDATE plant_advisories SET match_stamp = ? WHERE id = ?', stamp, id);
  return n;
}

function cleanUp(): void {
  // matches of assets that are gone, "not applicable" of sites that are gone
  db().run('DELETE FROM plant_advisory_matches WHERE asset_id NOT IN (SELECT id FROM plant_assets)');
  db().run('DELETE FROM plant_advisory_sites WHERE site_id NOT IN (SELECT id FROM plant_sites)');
}

/** Matches the given advisories now (a document that just arrived). */
export function rematch(ids: string[]): { advisories: number; matches: number } {
  const b = batchOf();
  const stamp = plantFingerprint();
  let matches = 0;
  const rows = db().all<{ id: string; vendors: string }>(`SELECT id, vendors FROM plant_advisories WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids);
  for (const r of rows) matches += matchOne(r.id, r.vendors, b, stamp);
  cleanUp();
  notifyNewMatches();
  return { advisories: rows.length, matches };
}

/** The stamp every advisory has once it is matched against the current plant data (a read then skips matching). */
let doneFor = '';

/**
 * Matches the advisories not yet matched against the current plant data – newest first, at most `max` advisories or
 * `ms` milliseconds, so a large feed never blocks a request or the job; the rest follows on the next call (their stamps
 * say where it stopped). Returns how many are still to do.
 */
export function matchBatch(o: { max: number; ms: number } = { max: 100, ms: 1000 }): { matched: number; remaining: number } {
  if (!plantEnabled()) return { matched: 0, remaining: 0 };
  const stamp = plantFingerprint();
  if (stamp === doneFor) return { matched: 0, remaining: 0 };
  const started = Date.now();
  const todo = db().all<{ id: string; vendors: string }>(
    'SELECT id, vendors FROM plant_advisories WHERE match_stamp <> ? ORDER BY current_release DESC, id LIMIT ?',
    stamp,
    o.max + 1,
  );
  let matched = 0;
  if (todo.length) {
    const b = batchOf();
    for (const r of todo.slice(0, o.max)) {
      matchOne(r.id, r.vendors, b, stamp);
      matched++;
      if (Date.now() - started > o.ms) break;
    }
  }
  cleanUp();
  notifyNewMatches();
  const remaining = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_advisories WHERE match_stamp <> ?', stamp)?.n ?? 0);
  if (!remaining) doneFor = stamp;
  return { matched, remaining };
}

/** Before reads: a small batch, so pages follow plant changes at once in all but very large installations (the job does the rest). */
export function rematchIfStale(): void {
  try {
    matchBatch({ max: 100, ms: 1000 });
  } catch (err) {
    logger.warn({ err }, 'plant advisories: matching failed');
  }
}
/** Tests: forget what was matched (the next batch checks the stamps again). */
export const resetAdvisoryFingerprint = (): void => {
  doneFor = '';
};

// ---------- saving a document ----------

export interface SaveOptions {
  origin: 'feed' | 'upload';
  sourceId: string | null;
  url: string;
  fileName: string;
  integrity: AdvisoryIntegrity;
  signatureUrl: string;
}

/** Older than what is stored: the release dates as times (documents write them in several ISO forms). */
const time = (s: string) => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

/** Saves a parsed document (new, a newer release, or unchanged) and matches it. Inside the caller's rights checks. */
export function saveAdvisory(p: ParsedCsaf, o: SaveOptions): { id: string; result: 'created' | 'updated' | 'unchanged' | 'older' } {
  const id = advisoryId(p.meta.namespace, p.meta.trackingId);
  const old = db().get<AdvisoryRow>('SELECT * FROM plant_advisories WHERE id = ?', id);
  if (old && old.sha256 === p.sha256) return { id, result: 'unchanged' };
  if (old && time(old.current_release) > time(p.meta.currentRelease)) return { id, result: 'older' };
  const actor = currentUser()?.username ?? 'system';
  const now = nowIso();
  const m = p.meta;
  const values = [
    m.publisher,
    m.namespace,
    m.trackingId,
    m.title,
    m.category,
    m.status,
    m.version,
    m.initialRelease,
    m.currentRelease,
    m.language,
    m.tlp,
    m.aggregateSeverity,
    p.severity,
    ADVISORY_SEVERITY_RANK[p.severity],
    p.cvss,
    JSON.stringify(p.cves),
    JSON.stringify(vendorsOf(p.content)),
    JSON.stringify(p.content),
    p.text,
    p.sha256,
    p.size,
    o.origin,
    o.sourceId,
    o.url,
    o.fileName,
    o.integrity,
    o.signatureUrl,
  ];
  db().tx(() => {
    if (old)
      db().run(
        `UPDATE plant_advisories SET publisher = ?, namespace = ?, tracking_id = ?, title = ?, category = ?, doc_status = ?, version = ?, initial_release = ?,
           current_release = ?, language = ?, tlp = ?, aggregate_severity = ?, severity = ?, severity_rank = ?, cvss = ?, cves = ?, vendors = ?, content = ?, document = ?,
           sha256 = ?, size = ?, origin = ?, source_id = ?, url = ?, file_name = ?, integrity = ?, signature_url = ?, updated_at = ?, updated_by = ?
         WHERE id = ?`,
        ...values,
        now,
        actor,
        id,
      );
    else
      db().run(
        `INSERT INTO plant_advisories (publisher, namespace, tracking_id, title, category, doc_status, version, initial_release, current_release, language,
           tlp, aggregate_severity, severity, severity_rank, cvss, cves, vendors, content, document, sha256, size, origin, source_id, url, file_name, integrity,
           signature_url, created_at, created_by, updated_at, updated_by, id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...values,
        now,
        actor,
        now,
        actor,
        id,
      );
    audit({
      action: old ? 'plant.advisory_updated' : 'plant.advisory_added',
      entityType: 'plant_advisory',
      entityId: id,
      summary: `Security advisory ${m.trackingId} "${m.title.slice(0, 200)}" of ${m.publisher} ${old ? `updated to version ${m.version}` : `added (version ${m.version})`} – ${o.origin === 'upload' ? `uploaded${o.fileName ? ` (${o.fileName.slice(0, 100)})` : ''}` : `from ${o.url.slice(0, 300)}`}`,
      details: {
        trackingId: m.trackingId,
        publisher: m.publisher,
        namespace: m.namespace,
        version: m.version,
        previousVersion: old?.version ?? null,
        currentRelease: m.currentRelease,
        severity: p.severity,
        cvss: p.cvss,
        cves: p.cves.slice(0, 50),
        sha256: p.sha256,
        integrity: o.integrity,
        origin: o.origin,
        ...(o.sourceId ? { sourceId: o.sourceId } : {}),
        ...(o.url ? { url: o.url.slice(0, 500) } : {}),
      },
    });
  });
  rematch([id]);
  return { id, result: old ? 'updated' : 'created' };
}

/** An uploaded document (offline plants): designers and administrators; a SHA-256 given must match. */
export function uploadAdvisory(input: AdvisoryUploadInput): AdvisoryUploadResult {
  const u = me();
  if (!canManageCatalogue(u)) forbid('upload advisories', 'managePlantCatalogue');
  const parsed = parseCsaf(input.content);
  if (input.sha256 && input.sha256.toLowerCase() !== parsed.sha256)
    throw new HttpError(400, 'The SHA-256 of the file does not match the one you gave', 'PLANT_ADVISORY_HASH', { algorithm: 'sha256' });
  assertPublicTlp(parsed);
  const saved = saveAdvisory(parsed, {
    origin: 'upload',
    sourceId: null,
    url: '',
    fileName: input.fileName,
    integrity: input.sha256 ? 'uploaded_sha256' : 'uploaded',
    signatureUrl: '',
  });
  const all = db().all<MatchRow>('SELECT * FROM plant_advisory_matches WHERE advisory_id = ? AND current = 1', saved.id);
  const r = reader(u);
  const visible = all.filter((m) => sees(r, m.site_id));
  const row = db().get<AdvisoryRow>(`SELECT ${LIST_COLUMNS} FROM plant_advisories WHERE id = ?`, saved.id)!;
  const sitesRows = db().all<SiteRow>('SELECT * FROM plant_advisory_sites WHERE advisory_id = ?', saved.id);
  return {
    advisory: summaryOf(row, visible, naOf(sitesRows, saved.id), r, zonesOf(visible.map((m) => m.asset_id)), sourceNames()),
    result: saved.result,
    matches: visible.filter(counted).length,
    possible: visible.filter(pending).length,
  };
}

// ---------- notifications ----------

/** New counted high and critical matches → the site's managers (event plant.advisory_matched), once per match. */
export function notifyNewMatches(): void {
  const rows = db().all<MatchRow & { title: string; tracking_id: string; publisher: string; adv_severity: string }>(
    `SELECT m.*, a.title, a.tracking_id, a.publisher, a.severity AS adv_severity FROM plant_advisory_matches m JOIN plant_advisories a ON a.id = m.advisory_id
     WHERE m.notified_at IS NULL AND m.current = 1`,
  );
  if (!rows.length) return;
  const na = new Set(
    db()
      .all<SiteRow>('SELECT * FROM plant_advisory_sites WHERE not_applicable = 1')
      .map((s) => `${s.advisory_id}|${s.site_id}`),
  );
  const groups = new Map<string, typeof rows>();
  const now = nowIso();
  for (const m of rows) {
    if (!counted(m)) continue;
    const sev = (m.severity !== 'unknown' ? m.severity : m.adv_severity) as AdvisorySeverity;
    // seen once: a lower severity or a site that said "not applicable" never notifies later for this match
    db().run('UPDATE plant_advisory_matches SET notified_at = ? WHERE advisory_id = ? AND asset_id = ?', now, m.advisory_id, m.asset_id);
    if (ADVISORY_SEVERITY_RANK[sev] < ADVISORY_SEVERITY_RANK.high || na.has(`${m.advisory_id}|${m.site_id}`)) continue;
    const key = `${m.advisory_id}|${m.site_id}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  if (!groups.size) return;
  void import('./notify.js')
    .then((n) => {
      for (const list of groups.values()) n.notifyAdvisoryMatched(list[0]!, list);
    })
    .catch((err: unknown) => logger.warn({ err }, 'plant advisories: could not notify'));
}

// ---------- reading ----------

function remediationOf(m: MatchRow, names: { windows: Map<string, string>; changeSets: Map<string, string> }): AdvisoryRemediationState {
  return {
    status: m.remediation as AdvisoryRemediationStatus,
    reason: m.remediation_reason,
    until: m.remediation_until,
    expired: acceptExpired(m),
    windowId: m.remediation_window,
    windowTitle: m.remediation_window ? (names.windows.get(m.remediation_window) ?? null) : null,
    changeSetId: m.remediation_change_set,
    changeSetTitle: m.remediation_change_set ? (names.changeSets.get(m.remediation_change_set) ?? null) : null,
    note: m.remediation_note,
    by: m.remediation_by,
    at: m.remediation_at,
  };
}

function linkedNames(rows: MatchRow[]) {
  const windows = [...new Set(rows.map((r) => r.remediation_window).filter((x): x is string => !!x))];
  const changeSets = [...new Set(rows.map((r) => r.remediation_change_set).filter((x): x is string => !!x))];
  const q = (table: string, list: string[]) =>
    list.length
      ? new Map(
          db()
            .all<{ id: string; title: string }>(`SELECT id, title FROM ${table} WHERE id IN (${list.map(() => '?').join(', ')})`, ...list)
            .map((r) => [r.id, r.title]),
        )
      : new Map<string, string>();
  return { windows: q('maintenance_windows', windows), changeSets: q('plant_change_sets', changeSets) };
}

function assetMatches(rows: MatchRow[], r: Reader, naSites: Set<string>): AdvisoryAssetMatch[] {
  if (!rows.length) return [];
  const assets = new Map(
    db()
      .all<{ id: string; name: string; manufacturer: string; model: string; firmware: string | null }>(
        `SELECT a.id, a.name, a.manufacturer, a.model, s.firmware FROM plant_assets a LEFT JOIN plant_assignments s ON s.asset_id = a.id
         WHERE a.id IN (${rows.map(() => '?').join(', ')})`,
        ...rows.map((m) => m.asset_id),
      )
      .map((a) => [a.id, a]),
  );
  const zones = zonesOf(rows.map((m) => m.asset_id));
  const names = linkedNames(rows);
  return rows.map((m) => {
    const a = assets.get(m.asset_id);
    return {
      assetId: m.asset_id,
      assetName: a?.name ?? m.asset_id,
      siteId: m.site_id,
      siteName: r.siteNames.get(m.site_id) ?? m.site_id,
      zones: zones.get(m.asset_id) ?? [],
      manufacturer: a?.manufacturer ?? '',
      model: a?.model ?? '',
      firmware: a?.firmware ?? '',
      kind: m.kind as AdvisoryMatchKind,
      counted: counted(m),
      decision: (m.decision as AdvisoryAssetMatch['decision']) ?? null,
      decisionReason: m.decision_reason,
      decidedBy: m.decided_by,
      decidedAt: m.decided_at,
      cves: parseJson<string[]>(m.cves, []),
      cvss: m.cvss === null ? null : Number(m.cvss),
      severity: m.severity as AdvisorySeverity,
      reasons: parseJson<AdvisoryMatchReason[]>(m.reasons, []),
      fixes: parseJson<AdvisoryFix[]>(m.fixes, []),
      remediation: remediationOf(m, names),
      siteNotApplicable: naSites.has(m.site_id),
      firstMatchedAt: m.first_matched_at,
      canManage: manages(r, m.site_id),
    };
  });
}

function statusOf(visible: MatchRow[], naSites: Set<string>): Pick<AdvisorySummary, 'status' | 'affectedAssets' | 'openAssets' | 'possibleMatches'> {
  const active = visible.filter((m) => !naSites.has(m.site_id));
  const affected = active.filter(counted);
  const open = affected.filter(stillOpen);
  const possibleMatches = active.filter(pending).length;
  const status: AdvisoryStatus = open.length
    ? 'open'
    : affected.length
      ? 'mitigated'
      : visible.some((m) => naSites.has(m.site_id) && (counted(m) || pending(m)))
        ? 'not_applicable'
        : 'unaffected';
  return { status, affectedAssets: affected.length, openAssets: open.length, possibleMatches };
}

function summaryOf(
  a: Pick<
    AdvisoryRow,
    'id' | 'tracking_id' | 'title' | 'publisher' | 'severity' | 'cvss' | 'cves' | 'initial_release' | 'current_release' | 'version' | 'origin' | 'source_id'
  >,
  visible: MatchRow[],
  naSites: Set<string>,
  r: Reader,
  zones: Map<string, AdvisoryZoneRef[]>,
  sourceNames: Map<string, string>,
): AdvisorySummary {
  const relevant = visible.filter((m) => !naSites.has(m.site_id) && (counted(m) || pending(m)));
  const siteIds = [...new Set(relevant.map((m) => m.site_id))];
  const zoneList: AdvisoryZoneRef[] = [];
  for (const m of relevant) for (const z of zones.get(m.asset_id) ?? []) if (!zoneList.some((x) => x.siteId === z.siteId && x.id === z.id)) zoneList.push(z);
  return {
    id: a.id,
    trackingId: a.tracking_id,
    title: a.title,
    publisher: a.publisher,
    severity: a.severity as AdvisorySeverity,
    cvss: a.cvss === null ? null : Number(a.cvss),
    cves: parseJson<string[]>(a.cves, []),
    published: a.initial_release,
    updated: a.current_release,
    version: a.version,
    ...statusOf(visible, naSites),
    sites: siteIds.map((id) => ({ id, name: r.siteNames.get(id) ?? id })).sort((x, y) => x.name.localeCompare(y.name)),
    zones: zoneList,
    origin: a.origin === 'feed' ? 'feed' : 'upload',
    sourceName: a.source_id ? (sourceNames.get(a.source_id) ?? null) : null,
  };
}

const sourceNames = () =>
  new Map(
    db()
      .all<{ id: string; name: string }>('SELECT id, name FROM plant_advisory_sources')
      .map((s) => [s.id, s.name]),
  );
const naOf = (rows: SiteRow[], advisoryId: string) => new Set(rows.filter((s) => s.advisory_id === advisoryId && s.not_applicable === 1).map((s) => s.site_id));

export interface ListFilter {
  /** Only advisories affecting this site; their counts are this site's */
  site?: string;
  status?: AdvisoryStatus;
  severity?: AdvisorySeverity;
  /** A vendor the advisory names (normalised: "Example Meters Ltd." finds "examplemeters…") */
  vendor?: string;
  /** Text in the title, tracking id, publisher or a CVE */
  q?: string;
  /** Only advisories with counted or possible matches at the reader's sites (the default view) */
  affecting?: boolean;
  sort?: AdvisorySort;
  order?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

const COUNTED_SQL = "((m.kind = 'exact' AND (m.decision IS NULL OR m.decision <> 'dismissed')) OR (m.kind = 'possible' AND m.decision = 'confirmed'))";
const PENDING_SQL = "(m.kind = 'possible' AND m.decision IS NULL)";
const OPEN_SQL = "(m.remediation IN ('open', 'planned') OR (m.remediation = 'accepted' AND m.remediation_until < ?))";
const STATUS_SQL =
  "CASE WHEN COALESCE(x.open_assets, 0) > 0 THEN 'open' WHEN COALESCE(x.affected, 0) > 0 THEN 'mitigated' WHEN COALESCE(x.na_hits, 0) > 0 THEN 'not_applicable' ELSE 'unaffected' END";
const SORT_SQL: Record<AdvisorySort, string[]> = {
  severity: ['a.severity_rank', 'COALESCE(a.cvss, -1)', 'a.current_release'],
  updated: ['a.current_release'],
  published: ['a.initial_release'],
  affected: ['affected', 'open_assets', 'possible'],
  title: ['lower(a.title)'],
};

/**
 * The list (0.14): filtered, sorted and paged by the database – the counts and the status are the reader's (matches of
 * the sites they may see, without the sites that marked an advisory not applicable), aggregated in one query; only
 * the page's advisories get their sites and zones.
 */
export function listAdvisories(f: ListFilter = {}): AdvisoryList {
  const u = me();
  rematchIfStale();
  const r = reader(u);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const visibleSites = [...r.rights.keys()].filter((id) => sees(r, id));
  const all = visibleSites.length === r.rights.size;
  const scope = f.site ? (visibleSites.includes(f.site) ? [f.site] : []) : visibleSites;
  const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
  // the matches that count for the reader: current, at a site they see (all of them: no list), not marked not applicable
  const siteWhere = f.site || !all ? (scope.length ? `AND m.site_id IN (${marks(scope.length)})` : 'AND 1 = 0') : '';
  const siteParams = f.site || !all ? scope : [];
  const day = today();
  const agg = `
    SELECT m.advisory_id,
      SUM(CASE WHEN s.site_id IS NULL AND ${COUNTED_SQL} THEN 1 ELSE 0 END) AS affected,
      SUM(CASE WHEN s.site_id IS NULL AND ${COUNTED_SQL} AND ${OPEN_SQL} THEN 1 ELSE 0 END) AS open_assets,
      SUM(CASE WHEN s.site_id IS NULL AND ${PENDING_SQL} THEN 1 ELSE 0 END) AS possible,
      SUM(CASE WHEN s.site_id IS NOT NULL AND (${COUNTED_SQL} OR ${PENDING_SQL}) THEN 1 ELSE 0 END) AS na_hits
    FROM plant_advisory_matches m
    LEFT JOIN plant_advisory_sites s ON s.advisory_id = m.advisory_id AND s.site_id = m.site_id AND s.not_applicable = 1
    WHERE m.current = 1 ${siteWhere}
    GROUP BY m.advisory_id`;
  const where: string[] = [];
  const params: unknown[] = [day, ...siteParams];
  const like = (col: string) => `lower(${col}) LIKE lower(?) ESCAPE '\\'`;
  if (f.severity) (where.push('a.severity = ?'), params.push(f.severity));
  if (f.status) (where.push(`${STATUS_SQL} = ?`), params.push(f.status));
  if (f.affecting || f.site) where.push('(COALESCE(x.affected, 0) > 0 OR COALESCE(x.possible, 0) > 0)');
  const vendor = f.vendor ? normVendor(f.vendor) : '';
  if (vendor) (where.push('a.vendors LIKE ?'), params.push(`%"${likeEscape(vendor)}%`));
  if (f.vendor && !vendor) where.push('1 = 0');
  const q = f.q?.trim();
  if (q) {
    const v = `%${likeEscape(q.slice(0, 200))}%`;
    where.push(`(${like('a.title')} OR ${like('a.tracking_id')} OR ${like('a.publisher')} OR ${like('a.cves')})`);
    params.push(v, v, v, v);
  }
  const from = `FROM plant_advisories a LEFT JOIN (${agg}) x ON x.advisory_id = a.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const sort = f.sort ?? 'severity';
  const dir = (f.order ?? (sort === 'title' ? 'asc' : 'desc')) === 'asc' ? 'ASC' : 'DESC';
  const order = [...SORT_SQL[sort].map((c) => `${c} ${dir}`), `a.id ${dir}`].join(', ');
  const total = Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, ...params)?.n ?? 0);
  const rows = db().all<AdvisoryRow & { affected: number; open_assets: number; possible: number }>(
    `SELECT ${LIST_COLUMNS.split(', ')
      .map((c) => `a.${c}`)
      .join(', ')}, COALESCE(x.affected, 0) AS affected, COALESCE(x.open_assets, 0) AS open_assets, COALESCE(x.possible, 0) AS possible
     ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  // the page: its matches at the sites in scope, for their sites and zones
  const ids = rows.map((a) => a.id);
  const matches = ids.length
    ? db()
        .all<MatchRow>(`SELECT * FROM plant_advisory_matches WHERE current = 1 AND advisory_id IN (${marks(ids.length)})`, ...ids)
        .filter((m) => sees(r, m.site_id) && (!f.site || m.site_id === f.site))
    : [];
  const sitesRows = ids.length ? db().all<SiteRow>(`SELECT * FROM plant_advisory_sites WHERE advisory_id IN (${marks(ids.length)})`, ...ids) : [];
  const byAdvisory = new Map<string, MatchRow[]>();
  for (const m of matches) byAdvisory.set(m.advisory_id, [...(byAdvisory.get(m.advisory_id) ?? []), m]);
  const zones = zonesOf([...new Set(matches.map((m) => m.asset_id))]);
  const names = sourceNames();
  return {
    items: rows.map((a) => summaryOf(a, byAdvisory.get(a.id) ?? [], naOf(sitesRows, a.id), r, zones, names)),
    total,
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
    canUpload: canManageCatalogue(u),
    canManageSources: u.roles.includes('admin'),
  };
}

const notFound = (id: string) => new HttpError(404, 'There is no such advisory', 'PLANT_ADVISORY_NOT_FOUND', { id });

export function getAdvisory(id: string): AdvisoryDetail {
  const u = me();
  rematchIfStale();
  const a = db().get<AdvisoryRow>('SELECT * FROM plant_advisories WHERE id = ?', id);
  if (!a) throw notFound(id);
  const r = reader(u);
  const all = db().all<MatchRow>('SELECT * FROM plant_advisory_matches WHERE advisory_id = ? AND current = 1 ORDER BY site_id, asset_id', id);
  const visible = all.filter((m) => sees(r, m.site_id));
  const sitesRows = db().all<SiteRow>('SELECT * FROM plant_advisory_sites WHERE advisory_id = ?', id);
  const na = naOf(sitesRows, id);
  const zones = zonesOf(visible.map((m) => m.asset_id));
  const content = parseJson<CsafContent>(a.content, { summary: '', products: [], vulnerabilities: [], references: [] });
  const siteIds = [...new Set([...visible.map((m) => m.site_id), ...sitesRows.map((s) => s.site_id).filter((s) => sees(r, s))])];
  const siteStates: AdvisorySiteState[] = siteIds.map((sid) => {
    const s = sitesRows.find((x) => x.site_id === sid);
    return {
      siteId: sid,
      siteName: r.siteNames.get(sid) ?? sid,
      notApplicable: s?.not_applicable === 1,
      reason: s?.reason ?? '',
      by: s?.decided_by ?? null,
      at: s?.decided_at ?? null,
      canManage: manages(r, sid),
    };
  });
  const profiles: AdvisoryProfileMatch[] = [];
  for (const p of db().all<{ id: string; name: string; manufacturer: string; model: string; version: string }>(
    "SELECT id, name, manufacturer, model, version FROM plant_profiles WHERE manufacturer <> '' AND model <> '' ORDER BY name, id",
  )) {
    const m = matchProfile(content, p);
    if (m) profiles.push({ ...p, ...m });
  }
  const PRODUCTS_SHOWN = 200;
  return {
    ...summaryOf(a, visible, na, r, zones, sourceNames()),
    category: a.category,
    docStatus: a.doc_status,
    tlp: a.tlp,
    language: a.language,
    summary: content.summary,
    aggregateSeverity: a.aggregate_severity,
    references: content.references,
    vulnerabilities: content.vulnerabilities,
    products: content.products.slice(0, PRODUCTS_SHOWN),
    moreProducts: Math.max(0, content.products.length - PRODUCTS_SHOWN),
    integrity: a.integrity as AdvisoryIntegrity,
    signatureUrl: a.signature_url,
    url: a.url,
    fileName: a.file_name,
    sha256: a.sha256,
    createdAt: a.created_at,
    createdBy: a.created_by,
    matches: assetMatches(visible, r, na),
    hiddenMatches: all.filter((m) => !sees(r, m.site_id) && (counted(m) || pending(m))).length,
    siteStates,
    profiles: profiles.slice(0, 100),
    canDelete: canManageCatalogue(u),
  };
}

/** The document as it was received (JSON). */
export function advisoryDocument(id: string): { name: string; body: string } {
  me();
  const a = db().get<{ document: string; tracking_id: string; file_name: string }>(
    'SELECT document, tracking_id, file_name FROM plant_advisories WHERE id = ?',
    id,
  );
  if (!a) throw notFound(id);
  // CSAF 2.0 §5.1: the file name is the tracking id, lower case, other characters as "_"
  const base = [...a.tracking_id.toLowerCase()].map((c) => ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '+' || c === '-' ? c : '_')).join('');
  return { name: `${base || 'advisory'}.json`, body: a.document };
}

/** The asset page's section: the advisories that match the asset (also dismissed and possible ones). */
export function assetAdvisories(assetId: string): AssetAdvisories {
  const u = me();
  rematchIfStale();
  const asset = db().get<{ id: string; site_id: string }>('SELECT id, site_id FROM plant_assets WHERE id = ?', assetId);
  const r = reader(u);
  if (!asset || !sees(r, asset.site_id)) throw new HttpError(404, 'There is no such asset', 'PLANT_ASSET_NOT_FOUND', { id: assetId });
  const rows = db().all<MatchRow>('SELECT * FROM plant_advisory_matches WHERE asset_id = ? AND current = 1', assetId);
  if (!rows.length) return { items: [], open: 0 };
  const ads = db().all<AdvisoryRow>(
    `SELECT ${LIST_COLUMNS} FROM plant_advisories WHERE id IN (${rows.map(() => '?').join(', ')}) ORDER BY current_release DESC`,
    ...rows.map((m) => m.advisory_id),
  );
  const sitesRows = db().all<SiteRow>('SELECT * FROM plant_advisory_sites WHERE site_id = ?', asset.site_id);
  const zones = zonesOf([assetId]);
  const names = sourceNames();
  const items = ads.map((a) => {
    const m = rows.filter((x) => x.advisory_id === a.id);
    const na = naOf(sitesRows, a.id);
    return { advisory: summaryOf(a, m, na, r, zones, names), match: assetMatches(m, r, na)[0]! };
  });
  items.sort(
    (x, y) =>
      Number(y.match.counted) - Number(x.match.counted) ||
      ADVISORY_SEVERITY_RANK[y.advisory.severity] - ADVISORY_SEVERITY_RANK[x.advisory.severity] ||
      y.advisory.updated.localeCompare(x.advisory.updated),
  );
  return {
    items,
    open:
      items.filter((i) => i.match.counted && !i.match.siteNotApplicable && ['open', 'planned'].includes(i.match.remediation.status)).length +
      items.filter((i) => i.match.counted && !i.match.siteNotApplicable && i.match.remediation.expired).length,
  };
}

/** The start page's tile: open advisories at the reader's sites, by severity and site. */
export function advisoryTile(): AdvisoryTile {
  const u = me();
  rematchIfStale();
  const r = reader(u);
  const matches = db()
    .all<MatchRow & { adv_severity: string }>(
      'SELECT m.*, a.severity AS adv_severity FROM plant_advisory_matches m JOIN plant_advisories a ON a.id = m.advisory_id WHERE m.current = 1',
    )
    .filter((m) => sees(r, m.site_id));
  const na = new Set(
    db()
      .all<SiteRow>('SELECT * FROM plant_advisory_sites WHERE not_applicable = 1')
      .map((s) => `${s.advisory_id}|${s.site_id}`),
  );
  const active = matches.filter((m) => !na.has(`${m.advisory_id}|${m.site_id}`));
  const open = active.filter((m) => counted(m) && stillOpen(m));
  const advisories = new Map<string, string>();
  for (const m of open) advisories.set(m.advisory_id, m.adv_severity);
  const sites = new Map<string, { advisories: Set<string>; assets: Set<string> }>();
  for (const m of open) {
    const s = sites.get(m.site_id) ?? { advisories: new Set(), assets: new Set() };
    s.advisories.add(m.advisory_id);
    s.assets.add(m.asset_id);
    sites.set(m.site_id, s);
  }
  return {
    openAdvisories: advisories.size,
    openAssets: new Set(open.map((m) => m.asset_id)).size,
    critical: [...advisories.values()].filter((s) => s === 'critical').length,
    high: [...advisories.values()].filter((s) => s === 'high').length,
    possibleMatches: active.filter(pending).length,
    sites: [...sites.entries()]
      .map(([id, s]) => ({ id, name: r.siteNames.get(id) ?? id, advisories: s.advisories.size, assets: s.assets.size }))
      .sort((x, y) => y.assets - x.assets || x.name.localeCompare(y.name))
      .slice(0, 10),
  };
}

// ---------- decisions ----------

function matchFor(advisoryIdValue: string, assetId: string, what: string): { m: MatchRow; title: string; tracking: string; assetName: string } {
  const u = me();
  const a = db().get<{ title: string; tracking_id: string }>('SELECT title, tracking_id FROM plant_advisories WHERE id = ?', advisoryIdValue);
  if (!a) throw notFound(advisoryIdValue);
  const m = db().get<MatchRow>('SELECT * FROM plant_advisory_matches WHERE advisory_id = ? AND asset_id = ? AND current = 1', advisoryIdValue, assetId);
  const r = reader(u);
  if (!m || !sees(r, m.site_id))
    throw new HttpError(404, 'The advisory does not match this asset', 'PLANT_ADVISORY_NO_MATCH', { advisory: advisoryIdValue, asset: assetId });
  if (!manages(r, m.site_id)) forbid(what, 'managePlant');
  const asset = db().get<{ name: string }>('SELECT name FROM plant_assets WHERE id = ?', assetId);
  return { m, title: a.title, tracking: a.tracking_id, assetName: asset?.name ?? assetId };
}

/** Confirm or dismiss a match on one asset (with a reason), or take the decision back. Audited. */
export function decideMatch(advisory: string, assetId: string, input: AdvisoryDecisionInput): AdvisoryAssetMatch {
  const { m, tracking, assetName } = matchFor(advisory, assetId, 'decide on matches of this site');
  const u = me();
  const now = nowIso();
  db().tx(() => {
    db().run(
      'UPDATE plant_advisory_matches SET decision = ?, decision_reason = ?, decided_by = ?, decided_at = ? WHERE advisory_id = ? AND asset_id = ?',
      input.decision,
      input.reason,
      input.decision ? u.username : null,
      input.decision ? now : null,
      advisory,
      assetId,
    );
    // a person's own decision is no news to tell the site's managers
    if (input.decision === 'confirmed')
      db().run('UPDATE plant_advisory_matches SET notified_at = COALESCE(notified_at, ?) WHERE advisory_id = ? AND asset_id = ?', now, advisory, assetId);
    audit({
      action:
        input.decision === 'confirmed'
          ? 'asset.advisory_confirmed'
          : input.decision === 'dismissed'
            ? 'asset.advisory_dismissed'
            : 'asset.advisory_decision_reset',
      entityType: 'plant_asset',
      entityId: assetId,
      summary: `${input.decision === 'confirmed' ? 'Confirmed' : input.decision === 'dismissed' ? 'Dismissed' : 'Took back the decision on'} the ${m.kind} match of advisory ${tracking} on asset "${assetName}"${input.reason ? `: ${input.reason.slice(0, 300)}` : ''}`,
      details: { advisoryId: advisory, trackingId: tracking, site: m.site_id, kind: m.kind, before: m.decision, after: input.decision, reason: input.reason },
    });
  });
  return reread(advisory, assetId);
}

/** The remediation of one affected asset. Audited. */
export function setRemediation(advisory: string, assetId: string, input: AdvisoryRemediationInput): AdvisoryAssetMatch {
  const { m, tracking, assetName } = matchFor(advisory, assetId, 'record the remediation of assets of this site');
  const u = me();
  if (input.status === 'accepted') {
    const max = new Date(Date.now() + L.acceptMaxDays * 86_400_000).toISOString().slice(0, 10);
    if (!input.until || input.until < today() || input.until > max)
      throw new HttpError(400, `An accepted risk ends between today and ${max}`, 'PLANT_ADVISORY_UNTIL', { max });
  }
  const windowId = input.status === 'planned' ? input.windowId : null;
  const changeSetId = input.status === 'planned' ? input.changeSetId : null;
  if (windowId && !db().get('SELECT 1 FROM maintenance_windows WHERE id = ?', windowId))
    throw new HttpError(400, 'There is no such maintenance window', 'PLANT_ADVISORY_LINK', { id: windowId });
  if (changeSetId && !db().get('SELECT 1 FROM plant_change_sets WHERE id = ?', changeSetId))
    throw new HttpError(400, 'There is no such change set', 'PLANT_ADVISORY_LINK', { id: changeSetId });
  const now = nowIso();
  const after = {
    status: input.status,
    reason: input.reason,
    until: input.status === 'accepted' ? input.until : null,
    windowId,
    changeSetId,
    note: input.note,
  };
  db().tx(() => {
    db().run(
      `UPDATE plant_advisory_matches SET remediation = ?, remediation_reason = ?, remediation_until = ?, remediation_window = ?, remediation_change_set = ?,
         remediation_note = ?, remediation_by = ?, remediation_at = ? WHERE advisory_id = ? AND asset_id = ?`,
      after.status,
      after.reason,
      after.until,
      after.windowId,
      after.changeSetId,
      after.note,
      u.username,
      now,
      advisory,
      assetId,
    );
    audit({
      action: 'asset.advisory_remediation_set',
      entityType: 'plant_asset',
      entityId: assetId,
      summary: `Remediation of advisory ${tracking} on asset "${assetName}": ${m.remediation} → ${after.status}${after.until ? ` until ${after.until}` : ''}${after.reason ? ` (${after.reason.slice(0, 200)})` : ''}`,
      details: {
        advisoryId: advisory,
        trackingId: tracking,
        site: m.site_id,
        before: {
          status: m.remediation,
          reason: m.remediation_reason,
          until: m.remediation_until,
          windowId: m.remediation_window,
          changeSetId: m.remediation_change_set,
        },
        after,
      },
    });
  });
  return reread(advisory, assetId);
}

function reread(advisory: string, assetId: string): AdvisoryAssetMatch {
  const r = reader();
  const m = db().get<MatchRow>('SELECT * FROM plant_advisory_matches WHERE advisory_id = ? AND asset_id = ?', advisory, assetId)!;
  const na = new Set(
    db()
      .all<SiteRow>('SELECT * FROM plant_advisory_sites WHERE advisory_id = ? AND not_applicable = 1', advisory)
      .map((s) => s.site_id),
  );
  return assetMatches([m], r, na)[0]!;
}

/** A site marks the advisory as not applicable (with a reason), or takes it back. Audited on the site. */
export function setSiteState(advisory: string, siteId: string, input: AdvisorySiteInput): AdvisorySiteState {
  const u = me();
  const a = db().get<{ tracking_id: string }>('SELECT tracking_id FROM plant_advisories WHERE id = ?', advisory);
  if (!a) throw notFound(advisory);
  const r = reader(u);
  if (!sees(r, siteId)) throw new HttpError(404, 'There is no such site', 'PLANT_SITE_NOT_FOUND', { id: siteId });
  if (!manages(r, siteId)) forbid('mark advisories of this site', 'managePlant');
  const now = nowIso();
  const before = db().get<SiteRow>('SELECT * FROM plant_advisory_sites WHERE advisory_id = ? AND site_id = ?', advisory, siteId);
  db().tx(() => {
    db().run(
      `INSERT INTO plant_advisory_sites (advisory_id, site_id, not_applicable, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (advisory_id, site_id) DO UPDATE SET not_applicable = excluded.not_applicable, reason = excluded.reason, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
      advisory,
      siteId,
      input.notApplicable ? 1 : 0,
      input.reason,
      u.username,
      now,
    );
    audit({
      action: input.notApplicable ? 'site.advisory_not_applicable' : 'site.advisory_applicable',
      entityType: 'plant_site',
      entityId: siteId,
      summary: `Advisory ${a.tracking_id} ${input.notApplicable ? 'marked as not applicable' : 'applies again'} at site ${r.siteNames.get(siteId) ?? siteId}${input.reason ? `: ${input.reason.slice(0, 300)}` : ''}`,
      details: {
        advisoryId: advisory,
        trackingId: a.tracking_id,
        before: before ? before.not_applicable === 1 : false,
        after: input.notApplicable,
        reason: input.reason,
      },
    });
  });
  return {
    siteId,
    siteName: r.siteNames.get(siteId) ?? siteId,
    notApplicable: input.notApplicable,
    reason: input.reason,
    by: u.username,
    at: now,
    canManage: true,
  };
}

/** Removes an advisory with its matches and decisions (designers and administrators). Audited. */
export function deleteAdvisory(id: string): void {
  const u = me();
  if (!canManageCatalogue(u)) forbid('remove advisories', 'managePlantCatalogue');
  const a = db().get<AdvisoryRow>('SELECT * FROM plant_advisories WHERE id = ?', id);
  if (!a) throw notFound(id);
  db().tx(() => {
    const n = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_advisory_matches WHERE advisory_id = ?', id)?.n ?? 0;
    db().run('DELETE FROM plant_advisory_matches WHERE advisory_id = ?', id);
    db().run('DELETE FROM plant_advisory_sites WHERE advisory_id = ?', id);
    db().run('UPDATE plant_advisory_fetched SET advisory_id = NULL WHERE advisory_id = ?', id);
    db().run('DELETE FROM plant_advisories WHERE id = ?', id);
    audit({
      action: 'plant.advisory_removed',
      entityType: 'plant_advisory',
      entityId: id,
      summary: `Security advisory ${a.tracking_id} "${a.title.slice(0, 200)}" removed with ${n} match${n === 1 ? '' : 'es'} and their decisions`,
      details: { trackingId: a.tracking_id, publisher: a.publisher, version: a.version, sha256: a.sha256, matches: n },
    });
  });
}
