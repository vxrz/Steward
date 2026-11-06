/**
 * Version watch (#241): the newest version of every tech stack entry, how far behind the installed one is and where
 * the newest version was found. Read-only, from structured sources (never web pages), cached once a day per source.
 *
 * Sources, tried in the order of the settings (first match wins, configurable per entry):
 *   dtrack     Dependency-Track's repository metadata analyzer: the latest version of a package URL
 *   registry   public package registries by package URL: npm, PyPI, Maven Central, NuGet, the Go module proxy, crates.io
 *   oci        tags of a container image on a registry platform (OCI distribution API)
 *   git        releases or tags of a repository on a Git platform (GitHub, GitLab, Forgejo/Gitea)
 *   endoflife  endoflife.date: the latest release of the newest release cycle
 */

export const VERSION_SOURCES = ['dtrack', 'registry', 'oci', 'git', 'endoflife'] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];

/** Package registries Steward reads by package URL type (purl spec: npm, pypi, maven, nuget, golang, cargo). */
export const PACKAGE_ECOSYSTEMS = ['npm', 'pypi', 'maven', 'nuget', 'golang', 'cargo'] as const;
export type PackageEcosystem = (typeof PACKAGE_ECOSYSTEMS)[number];

/** The public registries (an administrator may name a mirror instead, or turn one off with an empty address). */
export const DEFAULT_REGISTRY_URLS: Record<PackageEcosystem, string> = {
  npm: 'https://registry.npmjs.org',
  pypi: 'https://pypi.org',
  maven: 'https://repo1.maven.org/maven2',
  nuget: 'https://api.nuget.org/v3-flatcontainer',
  golang: 'https://proxy.golang.org',
  cargo: 'https://crates.io',
};

/**
 * How versions are compared: semver (Semantic Versioning 2.0.0, also NuGet, Go modules and Cargo), pep440 (Python),
 * maven (Maven's ComparableVersion), loose (numbers separated by dots, the rest a pre-release); auto: by the source.
 */
export const VERSION_SCHEMES = ['auto', 'semver', 'pep440', 'maven', 'loose'] as const;
export type VersionScheme = (typeof VERSION_SCHEMES)[number];

/** A platform of this kind is a container registry (OCI distribution API: GHCR, Docker Hub, Harbor …). */
export const CONTAINER_REGISTRY_KIND = 'container-registry';

export const VERSION_LIMITS = {
  /** Hours between two reads of one lookup (per source) */
  refreshHoursMin: 1,
  refreshHoursMax: 168,
  defaultRefreshHours: 24,
  /** A failed lookup is tried again after this many hours at the latest */
  retryHours: 6,
  /** Versions kept per lookup (the newest) */
  versionsPerLookup: 2000,
  /** Lookups read per run of the job (the rest follow in the next runs) */
  lookupsPerRun: 200,
  /** Largest answer of a registry (bytes) */
  answerBytes: 16 * 1024 * 1024,
  /** Pages of tags or releases read from a registry or Git platform */
  pages: 10,
  warnMinorsMax: 100,
  warnDaysMax: 3650,
  tagPattern: 100,
} as const;

/** Where to look for new versions of one tech stack entry (none stored: automatic). */
export interface VersionWatchConfig {
  /** auto: the sources in the order of the settings, the first that answers wins; a source: only that one; off: not watched */
  source: 'auto' | 'off' | VersionSource;
  /** registry, dtrack: the package URL (pkg:npm/react); empty: the SBOM's, else the product's */
  purl: string;
  /** oci: a container registry platform; git: a Git platform */
  platformId: string | null;
  /** oci: the image repository on the platform (library/postgres); git: owner/repository (GitLab: group/project) */
  name: string;
  /** oci, git: which tags count – a template with {version}: "{version}-alpine", "v{version}"; empty: the installed tag's shape */
  tagPattern: string;
  /** git: releases (default) or tags */
  gitRefs: 'releases' | 'tags';
  scheme: VersionScheme;
  /** Pre-releases count as newer versions; null: the setting */
  prereleases: boolean | null;
}

export const DEFAULT_WATCH_CONFIG: VersionWatchConfig = {
  source: 'auto',
  purl: '',
  platformId: null,
  name: '',
  tagPattern: '',
  gitRefs: 'releases',
  scheme: 'auto',
  prereleases: null,
};

/** Behind by: the first part that differs (major, else minor, else patch), the others 0. */
export interface VersionBehind {
  major: number;
  minor: number;
  patch: number;
}

/** current: the newest; patch/minor/major: behind by such a release; unknown: no newest version or the installed one is not a version */
export const VERSION_LAGS = ['current', 'patch', 'minor', 'major', 'unknown'] as const;
export type VersionLag = (typeof VERSION_LAGS)[number];

/** The newest version of a tech stack entry. */
export interface StackVersion {
  /** The source that answered (first match), null: none */
  source: VersionSource | null;
  /** What was looked up there: a package URL, an image, a repository, the product */
  ref: string;
  /** Where: npm, PyPI …, a platform's name, endoflife.date */
  where: string;
  newest: string | null;
  /** When the newest version was published, when the source says so */
  newestAt: string | null;
  lag: VersionLag;
  behind: VersionBehind | null;
  /** Days since the first release newer than the installed one; null: not behind or no dates */
  daysBehind: number | null;
  /** When the source was read */
  checkedAt: string | null;
  /** Why no source answered (the last source's reason); null when one did */
  error: string | null;
  /** The entry has its own setting (not automatic) */
  configured: boolean;
  /** Pre-releases count */
  prereleases: boolean;
}

/** What each source said for one entry (details of an entry). */
export interface VersionTry {
  source: VersionSource;
  ref: string;
  where: string;
  newest: string | null;
  checkedAt: string | null;
  /** not applicable, not read yet, blocked by the outbound policy, HTTP 404 … */
  note: string | null;
}

/** One tech stack entry with its version watch (the dialog of an entry). */
export interface VersionEntryDetail {
  holder: 'component' | 'system';
  holderId: string;
  holderName: string;
  product: string;
  label: string;
  version: string;
  config: VersionWatchConfig;
  watch: StackVersion | null;
  tried: VersionTry[];
  /** Open findings of the component's Dependency-Track project, and those in this package (of the worst ones read) */
  vulnerabilities: {
    project: string;
    counts: { critical: number; high: number; medium: number; low: number };
    findings: { vulnId: string; severity: string; component: string; version: string; fixedIn: string | null }[];
    readAt: string;
  } | null;
  canEdit: boolean;
}

export interface VersionSettings {
  /** The sources tried for an entry without its own setting, in this order (first match wins); missing ones are off */
  order: VersionSource[];
  /** Hours between two reads of a lookup, per source (default a day) */
  refreshHours: Record<VersionSource, number>;
  /** The address of each package registry (a mirror works too); empty: not read */
  registries: Record<PackageEcosystem, string>;
  /** Container registry platforms tried for images read from clusters and repositories (in this order) */
  ociPlatformIds: string[];
  /** A Git platform (GitHub) for the releases of a product's upstream repository (pkg:github/… of the product list); null: none */
  gitPlatformId: string | null;
  /** Pre-releases count (default off; an entry can turn them on) */
  prereleases: boolean;
  /** Message the application owners when a new major release appears */
  notify: boolean;
  /** Count on the scorecard (part "Up to date") */
  scorecard: boolean;
  /** Scorecard and dataset: "behind" (pending) above this many minor releases … */
  warnMinors: number;
  /** … or this many days */
  warnDays: number;
}

export const DEFAULT_VERSION_SETTINGS: VersionSettings = {
  order: ['dtrack', 'registry', 'oci', 'git', 'endoflife'],
  refreshHours: { dtrack: 24, registry: 24, oci: 24, git: 24, endoflife: 24 },
  registries: { ...DEFAULT_REGISTRY_URLS },
  ociPlatformIds: [],
  gitPlatformId: null,
  prereleases: false,
  notify: true,
  scorecard: false,
  warnMinors: 2,
  warnDays: 180,
};

export interface VersionWatchStatus {
  settings: VersionSettings;
  /** Tech stack entries (of applications not archived and of systems) */
  entries: number;
  /** … with a newest version */
  withNewest: number;
  current: number;
  behind: Record<'major' | 'minor' | 'patch', number>;
  refreshedAt: string | null;
  /** Lookups per source: how many, how many failed, the last read */
  sources: { source: VersionSource; lookups: number; failed: number; refreshedAt: string | null }[];
  /** The lookups that failed at their last read (at most 20) */
  errors: { source: VersionSource; ref: string; error: string }[];
  canEdit: boolean;
  canRefresh: boolean;
}

/** {version} once, with a short literal before and after it ("v{version}", "{version}-alpine"). */
export function isTagPattern(p: string): boolean {
  if (p.length > VERSION_LIMITS.tagPattern) return false;
  const i = p.indexOf('{version}');
  if (i < 0 || p.indexOf('{version}', i + 1) >= 0) return false;
  const rest = p.slice(0, i) + p.slice(i + 9);
  for (const ch of rest) if (!/[A-Za-z0-9._+-]/.test(ch)) return false;
  return true;
}

/** The built-in dataset "Component versions" (dashboards, reports): one row per tech stack entry. */
export const COMPONENT_VERSIONS_DATASET = 'catalogue.versions';
