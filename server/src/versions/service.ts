import { z } from 'zod';
import {
  CONTAINER_REGISTRY_KIND,
  DEFAULT_VERSION_SETTINGS,
  DEFAULT_WATCH_CONFIG,
  DTRACK_KIND,
  PACKAGE_ECOSYSTEMS,
  VERSION_LIMITS,
  VERSION_SCHEMES,
  VERSION_SOURCES,
  imageProduct,
  isGitPlatformKind,
  isTagPattern,
  splitImage,
  tagVersion,
  type DtrackReadout,
  type PackageEcosystem,
  type Platform,
  type StackVersion,
  type VersionEntryDetail,
  type VersionSettings,
  type VersionSource,
  type VersionTry,
  type VersionWatchConfig,
  type VersionWatchStatus,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { forbid, me, canCreateServices, catalogueVisibleNow } from '../records/access.js';
import { readSetting, writeSetting } from '../settings.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { getConnection, listPlatforms } from '../platforms/service.js';
import { ownerProblem, platformFor } from '../monitors/platforms.js';
import { behindOf, newestOf, parseVersion, type Scheme, type Version } from './compare.js';
import { ECOSYSTEM_LABELS, isEcosystem, parsePurl, purlLabel, type Purl } from './purl.js';
import { readDtrackLatest, readGitRefs, readOciTags, readRegistry, ociNameOk, type FoundVersion } from './sources.js';
// cycles with the catalogue modules: used only at call time
import { lifecycleSettings } from '../catalogue/lifecycle.js';
import { productLabel, productPurls } from '../catalogue/components.js';
import { canEditApplication } from '../catalogue/applications.js';
import { canEditSystem } from '../catalogue/systems.js';

/**
 * Version watch (#241): for every tech stack entry (of application components and of systems) the newest version from
 * structured sources, how far behind the installed version is, and where it was found. Read-only and cached: the job
 * reads each lookup once a day by default (per source), pages and the API only read the cache.
 *
 * Which sources are asked: an entry without its own setting tries the sources in the order of the settings – the first
 * that answers with a version wins; an entry can name one source (and the package URL, image, repository, tag pattern,
 * comparison rules, pre-releases). See docs/APPLICATIONS.md#version-watch.
 */

const SETTINGS_KEY = 'catalogue.versions';
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------- settings ----------

const hours = z.number().int().min(VERSION_LIMITS.refreshHoursMin).max(VERSION_LIMITS.refreshHoursMax);
/** An http(s) address without query or fragment, or empty (the registry is not read). */
function isRegistryAddress(v: string): boolean {
  if (!v) return true;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.search && !u.hash && !u.username && !u.password && !v.includes('#') && !v.includes('?');
  } catch {
    return false;
  }
}
const registryAddress = z.string().trim().max(300).refine(isRegistryAddress, 'an http(s) address without query, or empty');

export const versionSettingsInput = z
  .object({
    order: z
      .array(z.enum(VERSION_SOURCES))
      .max(VERSION_SOURCES.length)
      .refine((l) => new Set(l).size === l.length, 'each source once'),
    refreshHours: z.object(Object.fromEntries(VERSION_SOURCES.map((s) => [s, hours])) as Record<VersionSource, typeof hours>).strict(),
    registries: z.object(Object.fromEntries(PACKAGE_ECOSYSTEMS.map((e) => [e, registryAddress])) as Record<PackageEcosystem, typeof registryAddress>).strict(),
    ociPlatformIds: z.array(z.string().trim().min(1).max(100)).max(20),
    gitPlatformId: z.string().trim().min(1).max(100).nullable(),
    prereleases: z.boolean(),
    notify: z.boolean(),
    scorecard: z.boolean(),
    warnMinors: z.number().int().min(1).max(VERSION_LIMITS.warnMinorsMax),
    warnDays: z.number().int().min(1).max(VERSION_LIMITS.warnDaysMax),
  })
  .strict();

export function versionSettings(): VersionSettings {
  const s = readSetting<Partial<VersionSettings>>(SETTINGS_KEY, {});
  return {
    ...DEFAULT_VERSION_SETTINGS,
    ...s,
    refreshHours: { ...DEFAULT_VERSION_SETTINGS.refreshHours, ...(s.refreshHours ?? {}) },
    registries: { ...DEFAULT_VERSION_SETTINGS.registries, ...(s.registries ?? {}) },
  };
}

const canEditSettings = () => isAdmin(currentUser());
const canRefresh = () => {
  const u = currentUser();
  return !!u && (isAdmin(u) || canCreateServices(u));
};

export function saveVersionSettings(input: z.infer<typeof versionSettingsInput>): VersionWatchStatus {
  me();
  if (!canEditSettings()) forbid('change the version watch settings', 'manageSettings');
  const kinds = new Map(listPlatforms().map((p) => [p.id, p.kind]));
  for (const id of input.ociPlatformIds)
    if (kinds.get(id) !== CONTAINER_REGISTRY_KIND) throw new HttpError(400, 'Choose platforms of kind container registry', 'VERSIONS_OCI_PLATFORM', { id });
  if (input.gitPlatformId && !isGitPlatformKind(kinds.get(input.gitPlatformId)))
    throw new HttpError(400, 'Choose a GitHub, GitLab or Forgejo platform', 'VERSIONS_GIT_PLATFORM', { id: input.gitPlatformId });
  const before = versionSettings();
  writeSetting(SETTINGS_KEY, input);
  audit({
    action: 'catalogue.versions_settings_changed',
    entityType: 'settings',
    entityId: SETTINGS_KEY,
    summary: `Version watch settings changed (sources ${input.order.join(', ') || 'none'}, messages ${input.notify ? 'on' : 'off'}, scorecard ${input.scorecard ? 'on' : 'off'})`,
    details: { before, after: input },
  });
  return versionStatus();
}

// ---------- entries ----------

/** One tech stack entry with what the version watch needs. */
export interface WatchedEntry {
  holderKind: 'component' | 'system';
  holderId: string;
  holderName: string;
  /** Components: the application (not archived); systems: '' */
  applicationId: string;
  environment: string;
  product: string;
  version: string;
  stackSource: string;
  ref: string;
  /** The component's Dependency-Track platform and who last changed the component (it is read with their rights) */
  dtPlatformId: string | null;
  dtState: string | null;
  updatedBy: string;
}

interface EntryRow {
  holder_kind: 'component' | 'system';
  holder_id: string;
  holder_name: string;
  application_id: string;
  environment: string;
  product: string;
  version: string;
  source: string;
  sbom_ref: string;
  dt_platform_id: string | null;
  dt_state: string | null;
  updated_by: string;
}

const toWatched = (r: EntryRow): WatchedEntry => ({
  holderKind: r.holder_kind,
  holderId: r.holder_id,
  holderName: r.holder_name,
  applicationId: r.application_id ?? '',
  environment: r.environment ?? '',
  product: r.product,
  version: r.version ?? '',
  stackSource: r.source,
  ref: r.sbom_ref ?? '',
  dtPlatformId: r.dt_platform_id ?? null,
  dtState: r.dt_state ?? null,
  updatedBy: r.updated_by,
});

const ENTRY_SELECT = `
  SELECT 'component' AS holder_kind, c.id AS holder_id, c.name AS holder_name, c.application_id, c.environment, cs.product, cs.version,
         cs.source, cs.sbom_ref, c.dt_platform_id, c.dt_state, c.updated_by
  FROM component_stack cs JOIN application_components c ON c.id = cs.component_id JOIN applications a ON a.id = c.application_id
  WHERE a.archived = 0`;
const SYSTEM_SELECT = `
  SELECT 'system' AS holder_kind, s.id AS holder_id, s.name AS holder_name, '' AS application_id, '' AS environment, ss.product, ss.version,
         ss.source, ss.sbom_ref, NULL AS dt_platform_id, NULL AS dt_state, s.updated_by
  FROM system_stack ss JOIN systems s ON s.id = ss.system_id`;

/** Every watched entry: components of applications that are not archived, and systems. */
export function allEntries(): WatchedEntry[] {
  return db().all<EntryRow>(`${ENTRY_SELECT} UNION ALL ${SYSTEM_SELECT} ORDER BY holder_name, product`).map(toWatched);
}

function entriesOf(kind: 'component' | 'system', ids: string[]): WatchedEntry[] {
  if (!ids.length) return [];
  const out: WatchedEntry[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const marks = chunk.map(() => '?').join(', ');
    const sql =
      kind === 'component'
        ? `SELECT 'component' AS holder_kind, c.id AS holder_id, c.name AS holder_name, c.application_id, c.environment, cs.product, cs.version,
             cs.source, cs.sbom_ref, c.dt_platform_id, c.dt_state, c.updated_by
           FROM component_stack cs JOIN application_components c ON c.id = cs.component_id WHERE c.id IN (${marks})`
        : `${SYSTEM_SELECT} WHERE s.id IN (${marks})`;
    out.push(
      ...db()
        .all<EntryRow>(sql, ...chunk)
        .map(toWatched),
    );
  }
  return out;
}

const entryKey = (kind: string, id: string, product: string) => `${kind}\u0000${id}\u0000${product}`;

interface StoredConfig {
  config: VersionWatchConfig;
  setBy: string;
}

function configsOf(entries: WatchedEntry[]): Map<string, StoredConfig> {
  const out = new Map<string, StoredConfig>();
  const holders = [...new Set(entries.map((e) => `${e.holderKind}\u0000${e.holderId}`))];
  if (!holders.length) return out;
  const rows = db().all<{ holder_kind: string; holder_id: string; product: string; config: string; set_by: string }>(
    'SELECT holder_kind, holder_id, product, config, set_by FROM stack_version_watch',
  );
  const wanted = new Set(holders);
  for (const r of rows)
    if (wanted.has(`${r.holder_kind}\u0000${r.holder_id}`))
      out.set(entryKey(r.holder_kind, r.holder_id, r.product), {
        config: { ...DEFAULT_WATCH_CONFIG, ...parseJson<Partial<VersionWatchConfig>>(r.config, {}) },
        setBy: r.set_by,
      });
  return out;
}

// ---------- plan: which lookups an entry needs ----------

/** A lookup: what one source is asked (shared by every entry that asks the same). */
export interface Lookup {
  key: string;
  source: Exclude<VersionSource, 'endoflife'>;
  ref: string;
  where: string;
  /** Read with these rights (null: the platform chosen by an administrator in the settings) */
  actor: string | null;
  platformId: string | null;
  purl?: Purl;
  base?: string;
  name?: string;
  refs?: 'releases' | 'tags';
}

/**
 * Where a version was found, as the reader may see it: a platform they may not see ("Viewers see no platforms") is
 * named by its kind only. Jobs (no reader) see every name.
 */
const platformLabel = (p: Platform, kind: string): string => (currentUser() && !p.permissions.length ? kind : p.name);

interface Candidate {
  source: VersionSource;
  ref: string;
  where: string;
  scheme: Scheme;
  /** oci, git: the tag template ({version}); '' none */
  pattern: string;
  lookup: Lookup | null;
  /** Why this source does not apply (shown in the details); null when it does */
  skip: string | null;
}

interface PlanCtx {
  settings: VersionSettings;
  platforms: Map<string, Platform>;
  purlsOf: (product: string) => string[];
  imageMap: { image: string; product: string }[];
  products: Set<string>;
}

function planCtx(): PlanCtx {
  return {
    settings: versionSettings(),
    platforms: new Map(listPlatforms().map((p) => [p.id, p])),
    purlsOf: productPurls,
    imageMap: lifecycleSettings().imageMap ?? [],
    products: new Set(
      db()
        .all<{ product: string }>('SELECT DISTINCT product FROM eol_releases')
        .map((r) => r.product),
    ),
  };
}

const schemeOf = (cfg: VersionWatchConfig, auto: Scheme): Scheme => (cfg.scheme === 'auto' ? auto : cfg.scheme);
const ecosystemScheme = (type: string): Scheme => (type === 'pypi' ? 'pep440' : type === 'maven' ? 'maven' : 'semver');

/** The image of an entry read from a cluster or a repository's Dockerfile (its ref), when it is one. */
function imageOf(e: WatchedEntry, imageMap: PlanCtx['imageMap']): { registry: string; name: string; tag: string } | null {
  if (e.stackSource !== 'cluster' && e.stackSource !== 'repository') return null;
  const ref = e.ref.trim();
  if (!ref || ref.startsWith('pkg:') || ref.startsWith('cpe:') || ref.length > 300) return null;
  if (imageProduct(ref, imageMap)?.product !== e.product) return null;
  const { repository, tag } = splitImage(ref);
  const parts = repository.toLowerCase().split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (parts[0]!.includes('.') || parts[0]!.includes(':') || parts[0] === 'localhost')) registry = parts.shift()!;
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io';
  if (registry === 'docker.io' && parts.length === 1) parts.unshift('library');
  const name = parts.join('/');
  return ociNameOk(name) ? { registry, name, tag } : null;
}

/** The registry host a container registry platform serves: its variable "registry", else its base URL's host. */
function registryOf(p: Platform): string {
  const v = String(p.config.variables?.registry ?? '')
    .trim()
    .toLowerCase();
  if (v) return v;
  try {
    return new URL(p.baseUrl).host.toLowerCase();
  } catch {
    return '';
  }
}

/** The tag template of an installed tag: "16.4-alpine" → "{version}-alpine", "v2.4.1" → "v{version}". */
export function patternOfTag(tag: string): string {
  const version = tagVersion(tag);
  if (!version) return '{version}';
  const prefix = tag[0] === 'v' || tag[0] === 'V' ? tag[0] : '';
  const rest = tag.slice(prefix.length + version.length);
  const p = `${prefix}{version}${rest}`;
  return isTagPattern(p) ? p : '{version}';
}

/** The version a tag names under a template, or null when the tag does not fit it. */
export function versionOfTag(tag: string, pattern: string): string | null {
  if (!pattern) return tag;
  const i = pattern.indexOf('{version}');
  if (i < 0) return null;
  const before = pattern.slice(0, i);
  const after = pattern.slice(i + 9);
  if (tag.length <= before.length + after.length || !tag.startsWith(before) || !tag.endsWith(after)) return null;
  return tag.slice(before.length, tag.length - after.length);
}

function purlOf(e: WatchedEntry, cfg: VersionWatchConfig, ctx: PlanCtx, types: readonly string[]): Purl | null {
  if (cfg.purl) return parsePurl(cfg.purl);
  if (e.ref.startsWith('pkg:')) {
    const p = parsePurl(e.ref);
    if (p && types.includes(p.type)) return p;
  }
  for (const u of ctx.purlsOf(e.product)) {
    const p = parsePurl(u);
    if (p && types.includes(p.type)) return p;
  }
  return null;
}

const DTRACK_TYPES = [...PACKAGE_ECOSYSTEMS, 'gem', 'composer', 'hex', 'cpan', 'github'];

/** The sources asked for an entry, in order, with what each would look up (or why it does not apply). */
function candidatesOf(e: WatchedEntry, stored: StoredConfig | undefined, ctx: PlanCtx): Candidate[] {
  const cfg = stored?.config ?? DEFAULT_WATCH_CONFIG;
  if (cfg.source === 'off') return [];
  const order: VersionSource[] = cfg.source === 'auto' ? ctx.settings.order : [cfg.source];
  const ownPlatform = cfg.platformId ? ctx.platforms.get(cfg.platformId) : undefined;
  const out: Candidate[] = [];
  const skip = (source: VersionSource, why: string): Candidate => ({ source, ref: '', where: '', scheme: 'loose', pattern: '', lookup: null, skip: why });
  for (const source of order) {
    if (source === 'endoflife') {
      out.push(
        ctx.products.has(e.product)
          ? { source, ref: e.product, where: 'endoflife.date', scheme: schemeOf(cfg, 'loose'), pattern: '', lookup: null, skip: null }
          : skip(source, 'no end-of-life data for the product'),
      );
    } else if (source === 'registry') {
      const p = purlOf(e, cfg, ctx, PACKAGE_ECOSYSTEMS);
      if (!p || !isEcosystem(p.type)) {
        out.push(skip(source, 'no package URL of npm, PyPI, Maven, NuGet, Go or Cargo'));
        continue;
      }
      const base = ctx.settings.registries[p.type];
      if (!base) {
        out.push(skip(source, `the registry ${ECOSYSTEM_LABELS[p.type]} is turned off`));
        continue;
      }
      const ref = purlLabel(p);
      out.push({
        source,
        ref,
        where: ECOSYSTEM_LABELS[p.type],
        scheme: schemeOf(cfg, ecosystemScheme(p.type)),
        pattern: '',
        lookup: { key: `registry:${p.type}:${ref}:${base}`, source, ref, where: ECOSYSTEM_LABELS[p.type], actor: null, platformId: null, purl: p, base },
        skip: null,
      });
    } else if (source === 'dtrack') {
      if (e.holderKind !== 'component' || !e.dtPlatformId) {
        out.push(skip(source, 'the component names no Dependency-Track project'));
        continue;
      }
      const p = purlOf(e, cfg, ctx, DTRACK_TYPES);
      const dt = ctx.platforms.get(e.dtPlatformId);
      if (!p || dt?.kind !== DTRACK_KIND) {
        out.push(skip(source, p ? 'the Dependency-Track platform is missing' : 'no package URL'));
        continue;
      }
      const ref = purlLabel(p);
      out.push({
        source,
        ref,
        where: platformLabel(dt, 'Dependency-Track'),
        scheme: schemeOf(cfg, ecosystemScheme(p.type)),
        pattern: '',
        lookup: { key: `dtrack:${dt.id}:${ref}`, source, ref, where: dt.name, actor: e.updatedBy, platformId: dt.id, purl: p },
        skip: null,
      });
    } else if (source === 'oci') {
      const image = imageOf(e, ctx.imageMap);
      let platform: Platform | undefined;
      let name = '';
      let actor: string | null = null;
      if (ownPlatform?.kind === CONTAINER_REGISTRY_KIND && cfg.name) {
        platform = ownPlatform;
        name = cfg.name.toLowerCase();
        actor = stored!.setBy;
      } else if (image) {
        platform = ctx.settings.ociPlatformIds
          .map((id) => ctx.platforms.get(id))
          .find((p) => p?.kind === CONTAINER_REGISTRY_KIND && registryOf(p) === image.registry);
        name = image.name;
      }
      if (!platform || !name || !ociNameOk(name)) {
        out.push(skip(source, image ? `no container registry platform for ${image.registry} in the settings` : 'not read from an image'));
        continue;
      }
      const pattern = cfg.tagPattern || (image ? patternOfTag(image.tag) : '{version}');
      out.push({
        source,
        ref: name,
        where: platformLabel(platform, 'Container registry'),
        scheme: schemeOf(cfg, 'loose'),
        pattern,
        lookup: { key: `oci:${platform.id}:${name}`, source, ref: name, where: platform.name, actor, platformId: platform.id, name },
        skip: null,
      });
    } else if (source === 'git') {
      let platform: Platform | undefined;
      let repo = '';
      let actor: string | null = null;
      if (ownPlatform && isGitPlatformKind(ownPlatform.kind) && cfg.name) {
        platform = ownPlatform;
        repo = cfg.name;
        actor = stored!.setBy;
      } else if (ctx.settings.gitPlatformId) {
        const p = ctx.platforms.get(ctx.settings.gitPlatformId);
        const gh = ctx
          .purlsOf(e.product)
          .map(parsePurl)
          .find((x) => x?.type === 'github' && x.namespace.length === 1);
        if (p && gh) {
          platform = p;
          repo = `${gh.namespace[0]}/${gh.name}`;
        }
      }
      if (!platform || !repo) {
        out.push(skip(source, 'no repository named'));
        continue;
      }
      const refs = cfg.gitRefs;
      out.push({
        source,
        ref: repo,
        where: platformLabel(platform, 'Git platform'),
        scheme: schemeOf(cfg, 'loose'),
        pattern: cfg.tagPattern,
        lookup: { key: `git:${platform.id}:${repo}:${refs}`, source, ref: repo, where: platform.name, actor, platformId: platform.id, name: repo, refs },
        skip: null,
      });
    }
  }
  return out;
}

// ---------- evaluation ----------

interface LookupRow {
  key: string;
  versions: string;
  fetched_at: string;
  error: string | null;
}

function lookupRows(keys: string[]): Map<string, LookupRow> {
  const out = new Map<string, LookupRow>();
  const list = [...new Set(keys)];
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    for (const r of db().all<LookupRow>(
      `SELECT key, versions, fetched_at, error FROM version_lookups WHERE key IN (${chunk.map(() => '?').join(', ')})`,
      ...chunk,
    ))
      out.set(r.key, r);
  }
  return out;
}

interface EolData {
  versions: Map<string, FoundVersion[]>;
  readAt: Map<string, string>;
}

function eolData(products: string[]): EolData {
  const versions = new Map<string, FoundVersion[]>();
  const readAt = new Map<string, string>();
  const wanted = new Set(products);
  if (!wanted.size) return { versions, readAt };
  for (const r of db().all<{ product: string; latest: string | null; latest_date: string | null }>('SELECT product, latest, latest_date FROM eol_releases'))
    if (wanted.has(r.product) && r.latest) versions.set(r.product, [...(versions.get(r.product) ?? []), { v: r.latest, at: r.latest_date }]);
  for (const r of db().all<{ product: string; fetched_at: string }>('SELECT product, fetched_at FROM eol_products'))
    if (wanted.has(r.product)) readAt.set(r.product, r.fetched_at);
  return { versions, readAt };
}

const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY));

interface Evaluated {
  watch: StackVersion | null;
  tried: VersionTry[];
  /** The newest version, parsed (for messages: its major) */
  newest: Version | null;
  installed: Version | null;
}

/** The first source that answers wins: the newest version there, and how far behind the installed version is. */
function evaluate(
  e: WatchedEntry,
  stored: StoredConfig | undefined,
  cands: Candidate[],
  rows: Map<string, LookupRow>,
  eol: EolData,
  ctx: PlanCtx,
  now: number,
  /** Ask every source (the details of an entry: what each one says), the first answer still wins */
  all = false,
): Evaluated {
  const cfg = stored?.config ?? DEFAULT_WATCH_CONFIG;
  const prereleases = cfg.prereleases ?? ctx.settings.prereleases;
  const tried: VersionTry[] = [];
  let lastError: string | null = null;
  let first: Evaluated | null = null;
  for (const c of cands) {
    if (c.skip) {
      tried.push({ source: c.source, ref: '', where: '', newest: null, checkedAt: null, note: c.skip });
      continue;
    }
    let found: FoundVersion[];
    let checkedAt: string | null;
    let note: string | null = null;
    if (c.source === 'endoflife') {
      found = eol.versions.get(e.product) ?? [];
      checkedAt = eol.readAt.get(e.product) ?? null;
    } else {
      const row = rows.get(c.lookup!.key);
      if (!row) {
        tried.push({ source: c.source, ref: c.ref, where: c.where, newest: null, checkedAt: null, note: 'not read yet' });
        lastError = 'not read yet';
        continue;
      }
      found = parseJson<FoundVersion[]>(row.versions, []);
      checkedAt = row.fetched_at;
      note = row.error;
    }
    const parsed: { version: Version; at: string | null; name: string }[] = [];
    for (const f of found) {
      const text = c.pattern ? versionOfTag(f.v, c.pattern) : f.v;
      if (!text) continue;
      const version = parseVersion(text, c.scheme);
      if (!version) continue;
      // a tag with another variant ("18.1-alpine" for the pattern {version}) is not a version of this image
      if (c.pattern && version.scheme === 'loose' && version.key && !version.pre) continue;
      if (f.pre) version.pre = true;
      parsed.push({ version, at: f.at, name: f.v });
    }
    const best = newestOf(parsed, prereleases);
    if (!best) {
      const why = note ?? (found.length ? `no version fits${c.pattern ? ` the tag pattern ${c.pattern}` : ''}` : 'no versions');
      tried.push({ source: c.source, ref: c.ref, where: c.where, newest: null, checkedAt, note: why });
      lastError = why;
      continue;
    }
    tried.push({ source: c.source, ref: c.ref, where: c.where, newest: best.name, checkedAt, note });
    if (first) continue;
    const installed = parseVersion(e.version, c.scheme) ?? parseVersion(e.version, 'loose');
    const newest = installed && installed.scheme !== best.version.scheme ? (parseVersion(best.version.raw, 'loose') ?? best.version) : best.version;
    const { lag, behind } = installed ? behindOf(installed, newest) : { lag: 'unknown' as const, behind: null };
    // days behind: since the first release newer than the installed one
    let daysBehind: number | null = null;
    if (installed && lag !== 'current' && lag !== 'unknown') {
      const newer = parsed
        .filter((x) => (prereleases || !x.version.pre) && x.at)
        .filter((x) => {
          const v = installed.scheme === x.version.scheme ? x.version : parseVersion(x.version.raw, 'loose');
          return !!v && behindOf(installed, v).lag !== 'current';
        })
        .map((x) => x.at!)
        .sort();
      if (newer[0]) daysBehind = daysSince(newer[0], now);
      else if (best.at) daysBehind = daysSince(best.at, now);
    }
    first = {
      watch: {
        source: c.source,
        ref: c.ref,
        where: c.where,
        // as the source names it: the tag with its suffix, the release's tag
        newest: best.name,
        newestAt: best.at,
        lag,
        behind,
        daysBehind,
        checkedAt,
        error: null,
        configured: !!stored,
        prereleases,
      },
      tried,
      newest,
      installed,
    };
    if (!all) return first;
  }
  if (first) return first;
  if (!cands.length) return { watch: null, tried, newest: null, installed: null };
  return {
    watch: {
      source: null,
      ref: '',
      where: '',
      newest: null,
      newestAt: null,
      lag: 'unknown',
      behind: null,
      daysBehind: null,
      checkedAt: null,
      error: lastError ?? 'no source applies',
      configured: !!stored,
      prereleases,
    },
    tried,
    newest: null,
    installed: null,
  };
}

/** The version watch of many entries at once (pages, the API, the dataset, checks): from the cache only. */
export function watchOf(entries: WatchedEntry[], now = Date.now(), all = false): Map<string, Evaluated & { entry: WatchedEntry }> {
  const out = new Map<string, Evaluated & { entry: WatchedEntry }>();
  if (!entries.length) return out;
  const ctx = planCtx();
  const configs = configsOf(entries);
  const plans = entries.map((e) => {
    const stored = configs.get(entryKey(e.holderKind, e.holderId, e.product));
    return { e, stored, cands: candidatesOf(e, stored, ctx) };
  });
  const rows = lookupRows(plans.flatMap((p) => p.cands.flatMap((c) => (c.lookup ? [c.lookup.key] : []))));
  const eol = eolData([...new Set(entries.map((e) => e.product))]);
  for (const p of plans)
    out.set(entryKey(p.e.holderKind, p.e.holderId, p.e.product), { ...evaluate(p.e, p.stored, p.cands, rows, eol, ctx, now, all), entry: p.e });
  return out;
}

/** For the stack of components and systems (components.ts, systems.ts): the watch of each entry, by holder and product. */
export function stackWatch(kind: 'component' | 'system', ids: string[]): (id: string, product: string) => StackVersion | null {
  const m = watchOf(entriesOf(kind, [...new Set(ids)]));
  return (id, product) => m.get(entryKey(kind, id, product))?.watch ?? null;
}

// ---------- reading (the job, "refresh now", one entry) ----------

async function runLookup(l: Lookup): Promise<FoundVersion[]> {
  if (l.source === 'registry') return readRegistry(l.purl!, l.base!);
  if (!vault().unlocked) throw new Error('the vault is locked');
  const { platform, secrets } = l.actor ? platformFor(l.actor, l.platformId!) : getConnection(l.platformId!);
  if (l.source === 'dtrack') {
    if (platform.kind !== DTRACK_KIND) throw new Error(`"${platform.name}" is not a Dependency-Track platform`);
    return readDtrackLatest(platform, secrets, l.purl!);
  }
  if (l.source === 'oci') {
    if (platform.kind !== CONTAINER_REGISTRY_KIND) throw new Error(`"${platform.name}" is not a container registry platform`);
    return readOciTags(platform, secrets, l.name!);
  }
  return readGitRefs(platform, secrets, l.name!, l.refs ?? 'releases');
}

/** Reads lookups and stores what they found; a failed read keeps the versions read before and records why. */
async function readLookups(list: Lookup[], now = Date.now()): Promise<{ read: number; failed: number }> {
  let read = 0;
  let failed = 0;
  for (const l of list) {
    let versions: FoundVersion[] | null = null;
    let error: string | null = null;
    try {
      versions = await runLookup(l);
    } catch (e) {
      error = String((e as Error).message ?? e).slice(0, 300);
    }
    const at = new Date(now).toISOString();
    if (versions)
      db().run(
        `INSERT INTO version_lookups (key, source, ref, versions, fetched_at, error) VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT (key) DO UPDATE SET versions = excluded.versions, fetched_at = excluded.fetched_at, error = NULL`,
        l.key,
        l.source,
        l.ref.slice(0, 300),
        JSON.stringify(versions),
        at,
      );
    else
      db().run(
        `INSERT INTO version_lookups (key, source, ref, versions, fetched_at, error) VALUES (?, ?, ?, '[]', ?, ?)
         ON CONFLICT (key) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error`,
        l.key,
        l.source,
        l.ref.slice(0, 300),
        at,
        error,
      );
    if (error) failed++;
    else read++;
  }
  return { read, failed };
}

/** The lookups every entry needs (one per key; the administrator's platform choice wins over a person's rights). */
function neededLookups(entries = allEntries()): Lookup[] {
  const ctx = planCtx();
  const configs = configsOf(entries);
  const out = new Map<string, Lookup>();
  for (const e of entries)
    for (const c of candidatesOf(e, configs.get(entryKey(e.holderKind, e.holderId, e.product)), ctx)) {
      if (!c.lookup) continue;
      const have = out.get(c.lookup.key);
      if (!have || (have.actor && !c.lookup.actor)) out.set(c.lookup.key, c.lookup);
    }
  return [...out.values()];
}

let running: Promise<{ read: number; failed: number }> | null = null;

/**
 * Reads the lookups that are due (older than the source's interval; failed ones again after VERSION_LIMITS.retryHours at
 * the latest), at most VERSION_LIMITS.lookupsPerRun at a time; `force` reads all. Lookups no entry needs any more are
 * removed. One refresh at a time.
 */
export function refreshVersions(o: { force?: boolean; now?: number } = {}): Promise<{ read: number; failed: number }> {
  if (running) return running;
  running = (async () => {
    const now = o.now ?? Date.now();
    const s = versionSettings();
    const needed = neededLookups();
    const keys = new Set(needed.map((l) => l.key));
    const rows = new Map(
      db()
        .all<{ key: string; fetched_at: string; error: string | null }>('SELECT key, fetched_at, error FROM version_lookups')
        .map((r) => [r.key, r]),
    );
    for (const k of rows.keys()) if (!keys.has(k)) db().run('DELETE FROM version_lookups WHERE key = ?', k);
    const due = needed.filter((l) => {
      if (o.force) return true;
      const r = rows.get(l.key);
      if (!r) return true;
      const age = now - Date.parse(r.fetched_at);
      const every = s.refreshHours[l.source] * HOUR;
      return age >= (r.error ? Math.min(every, VERSION_LIMITS.retryHours * HOUR) : every);
    });
    // never read first, then the oldest
    due.sort((a, b) => (rows.get(a.key)?.fetched_at ?? '').localeCompare(rows.get(b.key)?.fetched_at ?? ''));
    return readLookups(due.slice(0, o.force ? VERSION_LIMITS.lookupsPerRun * 5 : VERSION_LIMITS.lookupsPerRun), now);
  })().finally(() => {
    running = null;
  });
  return running;
}

/** "Refresh now" (administrators, designers): every lookup, audited. */
export async function refreshVersionsNow(): Promise<VersionWatchStatus> {
  me();
  if (!canRefresh()) forbid('refresh the version watch', 'createApplications');
  const r = await refreshVersions({ force: true });
  (await import('./dataset.js')).publishVersionDataset(true);
  audit({
    action: 'catalogue.versions_refreshed',
    entityType: 'settings',
    entityId: SETTINGS_KEY,
    summary: `Version watch refreshed: ${r.read} lookup(s)${r.failed ? `, ${r.failed} failed` : ''}`,
    details: r,
  });
  return versionStatus();
}

/** The job (every few minutes): due lookups, then the messages; entries' own settings of deleted stack entries go. */
export async function runVersionJob(now = Date.now()): Promise<void> {
  db().run(
    `DELETE FROM stack_version_watch WHERE (holder_kind = 'component' AND NOT EXISTS (SELECT 1 FROM component_stack cs WHERE cs.component_id = stack_version_watch.holder_id AND cs.product = stack_version_watch.product))
       OR (holder_kind = 'system' AND NOT EXISTS (SELECT 1 FROM system_stack ss WHERE ss.system_id = stack_version_watch.holder_id AND ss.product = stack_version_watch.product))`,
  );
  await refreshVersions({ now });
  try {
    await checkMajorReleaseNotices(now);
  } catch (err) {
    logger.warn({ err }, 'version watch messages failed');
  }
  // the dataset "Component versions" (at most hourly)
  const { publishVersionDataset } = await import('./dataset.js');
  publishVersionDataset(false, now);
}

// ---------- status, one entry ----------

/** The entries of applications and systems the caller may see (#131): a hidden one is neither counted nor named. */
function visibleEntries(): WatchedEntry[] {
  const apps = new Map(
    db()
      .all<{ id: string; owners: string }>('SELECT id, owners FROM applications')
      .map((a) => [a.id, catalogueVisibleNow('application', a)]),
  );
  const systems = new Map(
    db()
      .all<{ id: string; owners: string }>('SELECT id, owners FROM systems')
      .map((x) => [x.id, catalogueVisibleNow('system', x)]),
  );
  return allEntries().filter((e) => (e.holderKind === 'component' ? apps.get(e.applicationId) : systems.get(e.holderId)) === true);
}

export function versionStatus(): VersionWatchStatus {
  me();
  const s = versionSettings();
  const entries = visibleEntries();
  const m = watchOf(entries);
  const watches = [...m.values()].map((x) => x.watch).filter((w): w is StackVersion => !!w);
  // only the lookups of the entries the caller may see: their names (images, repositories, package URLs) stay private
  const keys = new Set(neededLookups(entries).map((l) => l.key));
  const lookups = db()
    .all<{ key: string; source: VersionSource; ref: string; fetched_at: string; error: string | null }>(
      'SELECT key, source, ref, fetched_at, error FROM version_lookups ORDER BY fetched_at DESC',
    )
    .filter((l) => keys.has(l.key));
  const eolAt = db().get<{ t: string | null }>('SELECT MAX(fetched_at) AS t FROM eol_products')?.t ?? null;
  // internal mirror addresses and platform ids are for administrators (who change them)
  const { registries: _r, ociPlatformIds: _o, gitPlatformId: _g, ...open } = s;
  return {
    settings: canEditSettings() ? s : open,
    entries: entries.length,
    withNewest: watches.filter((w) => w.newest).length,
    current: watches.filter((w) => w.lag === 'current').length,
    behind: {
      major: watches.filter((w) => w.lag === 'major').length,
      minor: watches.filter((w) => w.lag === 'minor').length,
      patch: watches.filter((w) => w.lag === 'patch').length,
    },
    refreshedAt: lookups[0]?.fetched_at ?? null,
    sources: VERSION_SOURCES.map((source) => {
      if (source === 'endoflife') return { source, lookups: 0, failed: 0, refreshedAt: eolAt };
      const l = lookups.filter((x) => x.source === source);
      return { source, lookups: l.length, failed: l.filter((x) => x.error).length, refreshedAt: l[0]?.fetched_at ?? null };
    }),
    errors: lookups
      .filter((x) => x.error)
      .slice(0, 20)
      .map((x) => ({ source: x.source, ref: x.ref, error: x.error! })),
    canEdit: canEditSettings(),
    canRefresh: canRefresh(),
  };
}

export const entryRef = z
  .object({
    holder: z.enum(['component', 'system']),
    id: z.string().trim().min(1).max(100),
    product: z.string().trim().min(1).max(100),
  })
  .strict();

export const watchConfigInput = z
  .object({
    source: z.enum(['auto', 'off', ...VERSION_SOURCES]),
    purl: z.string().trim().max(300).default(''),
    platformId: z.string().trim().min(1).max(100).nullable().default(null),
    name: z.string().trim().max(300).default(''),
    tagPattern: z.string().trim().max(VERSION_LIMITS.tagPattern).default(''),
    gitRefs: z.enum(['releases', 'tags']).default('releases'),
    scheme: z.enum(VERSION_SCHEMES).default('auto'),
    prereleases: z.boolean().nullable().default(null),
  })
  .strict();

type Holder = { kind: 'component' | 'system'; id: string; name: string; owners: string; appId: string; appName: string; archived: boolean };

/** The holder of an entry as the caller sees it: one they may not see answers like a missing one. */
function holderOf(kind: 'component' | 'system', id: string): Holder {
  if (kind === 'component') {
    const r = db().get<{ id: string; name: string; application_id: string; owners: string; app_name: string; archived: number }>(
      `SELECT c.id, c.name, c.application_id, a.owners, a.name AS app_name, a.archived FROM application_components c JOIN applications a ON a.id = c.application_id WHERE c.id = ?`,
      id,
    );
    if (!r || !catalogueVisibleNow('application', { id: r.application_id, owners: r.owners }))
      throw new HttpError(404, `Component ${id} not found`, 'COMPONENT_NOT_FOUND', { id });
    return { kind, id: r.id, name: r.name, owners: r.owners, appId: r.application_id, appName: r.app_name, archived: !!r.archived };
  }
  const r = db().get<{ id: string; name: string; owners: string }>('SELECT id, name, owners FROM systems WHERE id = ?', id);
  if (!r || !catalogueVisibleNow('system', r)) throw new HttpError(404, `System ${id} not found`, 'SYSTEM_NOT_FOUND', { id });
  return { kind, id: r.id, name: r.name, owners: r.owners, appId: '', appName: '', archived: false };
}

function canEditHolder(u: AuthUser | null, h: Holder): boolean {
  if (h.archived) return false;
  if (h.kind === 'component') return canEditApplication(u, { id: h.appId, owners: h.owners });
  return canEditSystem(u, { id: h.id, owners: h.owners });
}

function storedConfig(h: Holder, product: string): StoredConfig | undefined {
  return configsOf([{ holderKind: h.kind, holderId: h.id } as WatchedEntry]).get(entryKey(h.kind, h.id, product));
}

/** One entry with its setting, what each source said and the component's vulnerabilities. */
export function versionEntry(ref: z.infer<typeof entryRef>): VersionEntryDetail {
  const u = me();
  const h = holderOf(ref.holder, ref.id);
  const e = entriesOf(ref.holder, [ref.id]).find((x) => x.product === ref.product);
  if (!e) throw new HttpError(404, `The tech stack has no product ${ref.product}`, 'STACK_ENTRY_NOT_FOUND', { product: ref.product });
  const ev = watchOf([e], Date.now(), true).get(entryKey(e.holderKind, e.holderId, e.product))!;
  const stored = storedConfig(h, e.product);
  return {
    holder: h.kind,
    holderId: h.id,
    holderName: h.name,
    product: e.product,
    label: productLabel(e.product),
    version: e.version,
    config: stored?.config ?? DEFAULT_WATCH_CONFIG,
    watch: ev.watch,
    tried: ev.tried,
    vulnerabilities: vulnerabilitiesOf(e, stored?.config),
    canEdit: canEditHolder(u, h),
  };
}

/** The open findings of the component's Dependency-Track project, and those in the entry's package (of the worst ones read). */
function vulnerabilitiesOf(e: WatchedEntry, cfg?: VersionWatchConfig): VersionEntryDetail['vulnerabilities'] {
  const r = parseJson<DtrackReadout | null>(e.dtState, null);
  if (!r || !r.readAt || !r.project) return null;
  const p =
    (cfg?.purl ? parsePurl(cfg.purl) : null) ??
    (e.ref.startsWith('pkg:') ? parsePurl(e.ref) : null) ??
    productPurls(e.product)
      .map(parsePurl)
      .find((x) => !!x && DTRACK_TYPES.includes(x.type)) ??
    null;
  const names = new Set<string>();
  if (p) {
    names.add(p.name.toLowerCase());
    if (p.namespace.length) names.add(`${p.namespace.join('/')}/${p.name}`.toLowerCase());
  }
  return {
    project: `${r.project.name}@${r.project.version}`,
    counts: { critical: r.counts?.critical ?? 0, high: r.counts?.high ?? 0, medium: r.counts?.medium ?? 0, low: r.counts?.low ?? 0 },
    findings: (r.top ?? [])
      .filter((f) => names.has(f.component.toLowerCase()) || [...names].some((n) => f.component.toLowerCase().endsWith(`/${n}`)))
      .map((f) => ({ vulnId: f.vulnId, severity: f.severity, component: f.component, version: f.version, fixedIn: f.fixedIn })),
    readAt: r.readAt,
  };
}

/** Saves the setting of one entry (whoever may change the application or system), reads its sources now, audited. */
export async function saveVersionEntry(ref: z.infer<typeof entryRef>, input: z.infer<typeof watchConfigInput>): Promise<VersionEntryDetail> {
  const u = me();
  const h = holderOf(ref.holder, ref.id);
  if (!canEditHolder(u, h)) forbid('change where Steward looks for new versions', ref.holder === 'component' ? 'changeApplication' : 'changeSystem');
  const e = entriesOf(ref.holder, [ref.id]).find((x) => x.product === ref.product);
  if (!e) throw new HttpError(404, `The tech stack has no product ${ref.product}`, 'STACK_ENTRY_NOT_FOUND', { product: ref.product });
  const config: VersionWatchConfig = { ...DEFAULT_WATCH_CONFIG, ...input };
  if (config.purl && !parsePurl(config.purl))
    throw new HttpError(400, 'Not a package URL (pkg:type/namespace/name)', 'VERSIONS_PURL', { purl: config.purl.slice(0, 100) });
  if (config.tagPattern && !isTagPattern(config.tagPattern))
    throw new HttpError(400, 'A tag pattern has {version} once, e.g. {version}-alpine or v{version}', 'VERSIONS_TAG_PATTERN');
  if (config.source === 'oci' || config.source === 'git' || config.platformId) {
    const p = config.platformId ? listPlatforms().find((x) => x.id === config.platformId) : undefined;
    const kindOk = !!p && (p.kind === CONTAINER_REGISTRY_KIND || isGitPlatformKind(p.kind));
    if (
      !p ||
      !kindOk ||
      ownerProblem(u.username, p.id) ||
      (config.source === 'oci' && p.kind !== CONTAINER_REGISTRY_KIND) ||
      (config.source === 'git' && !isGitPlatformKind(p.kind))
    )
      throw new HttpError(400, 'Choose a container registry or Git platform you may use', 'VERSIONS_PLATFORM', { id: config.platformId });
    if (!config.name) throw new HttpError(400, 'Name the image or the repository on the platform', 'VERSIONS_NAME');
    if (p.kind === CONTAINER_REGISTRY_KIND && !ociNameOk(config.name.toLowerCase()))
      throw new HttpError(400, 'An image repository has lower-case letters, digits, ".", "_", "-" and "/"', 'VERSIONS_NAME');
    if (isGitPlatformKind(p.kind) && (config.name.split('/').length < 2 || config.name.split('/').some((x) => !x || x === '.' || x === '..')))
      throw new HttpError(400, 'The repository is owner/repository (GitLab: group/project)', 'VERSIONS_NAME');
  }
  const automatic = JSON.stringify(config) === JSON.stringify(DEFAULT_WATCH_CONFIG);
  const before = storedConfig(h, e.product)?.config ?? DEFAULT_WATCH_CONFIG;
  db().tx(() => {
    db().run('DELETE FROM stack_version_watch WHERE holder_kind = ? AND holder_id = ? AND product = ?', h.kind, h.id, e.product);
    if (!automatic)
      db().run(
        'INSERT INTO stack_version_watch (holder_kind, holder_id, product, config, set_at, set_by) VALUES (?, ?, ?, ?, ?, ?)',
        h.kind,
        h.id,
        e.product,
        JSON.stringify(config),
        nowIso(),
        u.username,
      );
    audit({
      action: h.kind === 'component' ? 'application.version_watch_changed' : 'system.version_watch_changed',
      entityType: h.kind === 'component' ? 'application' : 'system',
      entityId: h.kind === 'component' ? h.appId : h.id,
      summary: `Version watch of ${e.product} in ${h.kind} "${h.name}"${h.appName ? ` of application "${h.appName}"` : ''}: ${automatic ? 'automatic' : config.source}`,
      details: { holder: h.kind, holderId: h.id, product: e.product, before, after: config },
    });
  });
  await readEntryNow(e);
  return versionEntry(ref);
}

/** Reads the sources of one entry now (whoever may change it). */
export async function readVersionEntry(ref: z.infer<typeof entryRef>): Promise<VersionEntryDetail> {
  const u = me();
  const h = holderOf(ref.holder, ref.id);
  if (!canEditHolder(u, h)) forbid('read the versions of this entry now', ref.holder === 'component' ? 'changeApplication' : 'changeSystem');
  const e = entriesOf(ref.holder, [ref.id]).find((x) => x.product === ref.product);
  if (!e) throw new HttpError(404, `The tech stack has no product ${ref.product}`, 'STACK_ENTRY_NOT_FOUND', { product: ref.product });
  await readEntryNow(e);
  audit({
    action: h.kind === 'component' ? 'application.versions_read' : 'system.versions_read',
    entityType: h.kind === 'component' ? 'application' : 'system',
    entityId: h.kind === 'component' ? h.appId : h.id,
    summary: `Versions of ${e.product} in ${h.kind} "${h.name}" read now`,
    details: { holder: h.kind, holderId: h.id, product: e.product },
  });
  return versionEntry(ref);
}

async function readEntryNow(e: WatchedEntry): Promise<void> {
  const list = neededLookups([e]);
  if (list.length) await readLookups(list.slice(0, 6));
}

// ---------- messages: a new major release ----------

/**
 * Messages the owners of an application (else the administrators) when a new major release of a product in its stack
 * appears – once per application, product and major. The newest major known when an entry is first seen is recorded
 * without a message (no flood when the watch is turned on); systems the same, to the people responsible for them.
 */
export async function checkMajorReleaseNotices(now = Date.now()): Promise<number> {
  const s = versionSettings();
  if (!s.notify) return 0;
  const m = watchOf(allEntries(), now);
  const groups = new Map<
    string,
    { target: string; kind: 'application' | 'system'; product: string; major: number; newest: string; holders: string[]; installed: string[] }
  >();
  for (const x of m.values()) {
    const w = x.watch;
    if (!w?.newest || !x.newest || !x.newest.release.length) continue;
    const target = x.entry.holderKind === 'component' ? x.entry.applicationId : x.entry.holderId;
    const key = `${target}\u0000${x.entry.product}`;
    const major = x.newest.release[0]!;
    const g = groups.get(key) ?? {
      target,
      kind: x.entry.holderKind === 'component' ? ('application' as const) : ('system' as const),
      product: x.entry.product,
      major,
      newest: w.newest,
      holders: [],
      installed: [],
    };
    if (major > g.major) Object.assign(g, { major, newest: w.newest });
    if (w.lag === 'major') {
      const label = x.entry.environment ? `${x.entry.holderName} (${x.entry.environment})` : x.entry.holderName;
      if (!g.holders.includes(label)) g.holders.push(label);
      if (!g.installed.includes(x.entry.version)) g.installed.push(x.entry.version);
    }
    groups.set(key, g);
  }
  const { notify } = await import('../notifications/service.js');
  const { usersOfSubjects } = await import('../tickets/reminders.js');
  const { t } = await import('../i18n/index.js');
  const { listUsers } = await import('../auth/users.js');
  const admins = () => listUsers().filter((u) => u.active && u.roles.includes('admin'));
  let sent = 0;
  for (const g of groups.values()) {
    const known = db().all<{ major: string }>('SELECT major FROM version_notices WHERE target_id = ? AND product = ?', g.target, g.product);
    const claim = () =>
      db().run(
        'INSERT INTO version_notices (target_id, product, major, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
        g.target,
        g.product,
        String(g.major),
        new Date(now).toISOString(),
      ).changes === 1;
    // first sight: the newest major is the starting point, no message
    if (!known.length || !g.holders.length) {
      if (!known.some((k) => k.major === String(g.major))) claim();
      continue;
    }
    if (known.some((k) => Number(k.major) >= g.major) || !claim()) continue;
    const row =
      g.kind === 'application'
        ? db().get<{ name: string; owners: string }>('SELECT name, owners FROM applications WHERE id = ?', g.target)
        : db().get<{ name: string; owners: string }>('SELECT name, owners FROM systems WHERE id = ?', g.target);
    if (!row) continue;
    const owners = usersOfSubjects(parseJson<string[]>(row.owners, []));
    const recipients = owners.length ? owners : admins();
    const params = { product: productLabel(g.product), newest: g.newest, name: row.name, holders: g.holders.join(', '), installed: g.installed.join(', ') };
    const link = g.kind === 'application' ? `/applications/${g.target}` : `/systems/${g.target}`;
    notify({
      event: 'stack.release',
      text: (l) => ({
        title: t(l, 'stackRelease.title', params),
        body: t(l, g.kind === 'application' ? 'stackRelease.body' : 'stackRelease.systemBody', params),
      }),
      link,
      recipients,
      about: { kind: g.kind, id: g.target },
      inAppKey: `stack-release:${g.target}:${g.product}:${g.major}`,
      externalKey: `stack-release:${g.target}:${g.product}:${g.major}`,
      data: { [g.kind === 'application' ? 'applicationId' : 'systemId']: g.target, product: g.product, newest: g.newest, major: g.major, holders: g.holders },
    });
    audit({
      action: g.kind === 'application' ? 'application.major_release_notice_sent' : 'system.major_release_notice_sent',
      entityType: g.kind,
      entityId: g.target,
      actor: 'system',
      summary: `New major release ${productLabel(g.product)} ${g.newest} (${g.kind} "${row.name}" uses ${g.installed.join(', ')}) – message to ${recipients.map((u) => u.username).join(', ') || 'nobody'}`,
      details: { product: g.product, newest: g.newest, major: g.major, holders: g.holders, installed: g.installed },
    });
    sent++;
  }
  return sent;
}

/** Whether a version watch entry counts as behind for the scorecard and the dataset (above the settings' limits). */
export function isWellBehind(w: StackVersion, s: VersionSettings): boolean {
  return w.lag === 'major' || (w.lag === 'minor' && (w.behind?.minor ?? 0) > s.warnMinors) || (w.daysBehind ?? 0) > s.warnDays;
}
