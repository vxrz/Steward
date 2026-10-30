import type { ImageProductRule, NamespaceReadout } from './kubernetes.js';
import type { RepositoryReadout } from './git.js';
import type { TopicReadout } from './kafka.js';
import type { Backlink, ItemLink, ReviewStatus, ServiceCriticality } from './records.js';

/**
 * Applications in the service catalogue (#84): what people call a platform ("Insights Hub", "Industrial Edge")
 * and smaller applications without an interface. Steward platforms (integrations with an API and credentials)
 * are mapped to them, services consist of them, and each one has an optional CIA rating (protection need).
 */

// ---------- CIA rating (protection need) ----------

/** The three dimensions of a protection need: confidentiality, integrity, availability. */
export const CIA_DIMENSIONS = ['confidentiality', 'integrity', 'availability'] as const;
export type CiaDimension = (typeof CIA_DIMENSIONS)[number];

/**
 * Colours a level can have: a fixed palette (Mantine colour names), so administrators choose from a list and never
 * enter CSS.
 */
export const CIA_COLORS = ['gray', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'grape', 'pink', 'yellow', 'orange', 'red'] as const;
export type CiaColor = (typeof CIA_COLORS)[number];

/** Keys of levels: stable (ratings store them), lower case. */
export const CIA_LEVEL_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const CIA_LIMITS = { minLevels: 2, maxLevels: 10, label: 60, description: 500, justification: 2000, reason: 2000 } as const;

export interface CiaLevel {
  key: string;
  label: string;
  description: string;
  color: CiaColor;
}

/**
 * The default scale: the protection needs of BSI IT-Grundschutz (BSI-Standard 200-2), lowest first. Their labels and
 * descriptions are translated in the UI (built-in levels); a custom scale shows what the administrator entered.
 */
export const DEFAULT_CIA_LEVELS: readonly CiaLevel[] = [
  { key: 'normal', label: 'Normal', description: 'The impact of damage is limited and calculable.', color: 'green' },
  { key: 'high', label: 'High', description: 'The impact of damage can be considerable.', color: 'orange' },
  { key: 'very_high', label: 'Very high', description: 'The impact of damage can reach an existentially threatening, catastrophic level.', color: 'red' },
];

/**
 * default: the BSI scale for all three dimensions; shared: one custom scale for all three; perDimension: a custom
 * scale for each dimension.
 */
export const CIA_SCALE_MODES = ['default', 'shared', 'perDimension'] as const;
export type CiaScaleMode = (typeof CIA_SCALE_MODES)[number];

export interface CiaScale {
  mode: CiaScaleMode;
  /** The ordered levels (lowest first) of each dimension; the same list three times unless mode is perDimension */
  levels: Record<CiaDimension, CiaLevel[]>;
  updatedAt: string | null;
  updatedBy: string | null;
  /** How many application ratings and service overrides use each level key, per dimension (for the mapping when the scale changes) */
  usage: Record<CiaDimension, Record<string, number>>;
  canEdit: boolean;
  /** The stored scale is not valid (e.g. from a migration package): the BSI default is in use until an administrator saves one */
  storedInvalid?: boolean;
}

/** One dimension of an application's rating. */
export interface CiaRating {
  /** Key of a level of the dimension's scale */
  level: string;
  justification: string;
  ratedAt: string;
  ratedBy: string;
  /** The scale changed and this level is no longer on it (or was flagged for re-rating): it does not count until rated again */
  needsRerating: boolean;
  /** Set by a scale change: the label the level had before (mapped or flagged) */
  previousLabel: string | null;
}

export type ApplicationRating = Record<CiaDimension, CiaRating | null>;

/** A service override of a dimension of its derived protection need (cumulation or distribution effect). */
export interface ProtectionNeedOverride {
  level: string;
  reason: string;
  setAt: string;
  setBy: string;
  needsRerating: boolean;
  previousLabel: string | null;
}

/**
 * One dimension of a service's protection need: derived with the maximum principle (the highest level across its
 * applications that are not archived), and the effective one (the override when set, else the derived level).
 */
export interface ProtectionNeedDimension {
  /** Highest level across the applications (null: none rated) */
  derived: string | null;
  /** Applications whose rating gave the derived level */
  derivedFrom: string[];
  /** Applications (not archived) with a valid rating of this dimension … */
  rated: number;
  /** … of this many applications (not archived) */
  total: number;
  /** Applications whose rating needs re-rating after a scale change (not counted) */
  needsRerating: number;
  /** Archived applications of the service (not counted, not in total) */
  archived: number;
  /** The stored CIA scale is not valid: this need cannot be determined until an administrator saves a scale */
  scaleInvalid: boolean;
  override: ProtectionNeedOverride | null;
  /** The override when set (and valid), else the derived level */
  effective: string | null;
}

export type ServiceProtectionNeed = Record<CiaDimension, ProtectionNeedDimension>;

// ---------- applications ----------

/** How a service uses an application: its primary application, a dependency, or something else (free text). */
export const APPLICATION_ROLES = ['primary', 'dependency', 'other'] as const;
export type ApplicationRole = (typeof APPLICATION_ROLES)[number];

export interface ApplicationServiceRef {
  id: string;
  name: string;
  archived: boolean;
  role: ApplicationRole | null;
  roleText: string;
}

/** A Steward platform mapped to an application. Platforms the reader may not see: visible false, no id or name. */
export interface ApplicationIntegration {
  visible: boolean;
  platformId: string | null;
  name: string;
  kind: string | null;
  environment: string | null;
  path: string | null;
  mappedAt: string;
  mappedBy: string;
  /** The user may remove the platform from the application (manage right on the platform) */
  canManage: boolean;
}

export interface ApplicationSummary {
  id: string;
  name: string;
  vendor: string;
  version: string;
  url: string;
  criticality: ServiceCriticality | null;
  /** Steward users and teams responsible (user:<name>, team:<name>) */
  owners: string[];
  tags: string[];
  cmdb: { system: string; id: string; url: string } | null;
  archived: boolean;
  services: ApplicationServiceRef[];
  /** Mapped platforms (all, also those the reader may not see) */
  integrationCount: number;
  rating: ApplicationRating;
  /** Living documents scoped to the application that the reader may read */
  documentCount: number;
  overdueDocuments: number;
  /** Components (repositories, images, topics, …) of the application */
  componentCount: number;
  /** "Runs on" links to systems (#129) */
  systemCount: number;
  updatedAt: string;
}

/** A living document scoped to an application ("applies to"). Only documents the reader may read are listed. */
export interface ApplicationDocument {
  id: string;
  number: string;
  title: string;
  typeKey: string;
  typeName: string;
  status: string;
  edition: string | null;
  reviewStatus: ReviewStatus;
  nextReviewAt: string | null;
  daysLeft: number | null;
}

export interface ApplicationDetail extends ApplicationSummary {
  description: string;
  createdAt: string;
  createdBy: string;
  updatedBy: string;
  integrations: ApplicationIntegration[];
  links: ItemLink[];
  backlinks: Backlink[];
  documents: ApplicationDocument[];
  components: ApplicationComponent[];
  /** The tech stack of all components together: one entry per product and version */
  stack: ApplicationStackItem[];
  /** Credentials register entries that name the application under "used by" and that the reader may see (#125) */
  credentials: ApplicationCredential[];
  /** The systems the application runs on, per environment (#129) */
  systems: ApplicationSystemLink[];
  canEdit: boolean;
}

export interface ApplicationCredential {
  id: string;
  name: string;
  type: string;
  status: 'ok' | 'dueSoon' | 'overdue' | 'expired';
  nextDueAt: string | null;
  roles: string[];
  /** belongsTo: the entry belongs to the application, one of its components or the system (#143); usedBy: it names it under "used by" */
  relation: 'belongsTo' | 'usedBy';
  /** Belongs to a component of the application: its name */
  componentName: string | null;
}

// ---------- components and tech stack (#103) ----------

/**
 * What an application consists of: a short fixed list of types, so processes can ask for "all Kafka topics of
 * this application". Anything else is "other".
 */
export const COMPONENT_TYPES = [
  'repository',
  'container-image',
  'kafka-topic',
  'snowflake-database',
  'cloud-account',
  'kubernetes-namespace',
  'platform',
  'other',
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

/** Where a tech stack entry comes from: entered by hand (wins over the others), read from an SBOM, from the images running in a Kubernetes namespace (#111), or from a repository's files (#107). */
export const STACK_SOURCES = ['manual', 'sbom', 'cluster', 'repository'] as const;
export type StackSource = (typeof STACK_SOURCES)[number];

export const COMPONENT_LIMITS = {
  perApplication: 200,
  name: 200,
  note: 2000,
  stackPerComponent: 100,
  version: 60,
  /** An SBOM (CycloneDX or SPDX JSON), uploaded or fetched */
  sbomBytes: 10 * 1024 * 1024,
  /** Components and packages read from one SBOM */
  sbomComponents: 50_000,
} as const;

/** One product of a component's tech stack: an endoflife.date product and the version in use. */
export interface StackEntry {
  /** endoflife.date product id (e.g. "nodejs") */
  product: string;
  /** Its name (e.g. "Node.js"); the id when the product is no longer on the list */
  label: string;
  version: string;
  source: StackSource;
  /** SBOM entries: the SBOM component it was read from (package URL, CPE or name) */
  sbomRef: string;
  setAt: string;
  setBy: string;
  /** End of life of the release cycle in use (#104); null when there is no end-of-life data for the product */
  lifecycle: StackLifecycle | null;
}

// ---------- end of life (#104) ----------

/**
 * supported: end of life not in sight; ending: within the warning period (default 90 days); eol: past its end of
 * life; unknown: no matching release cycle (version empty or not on endoflife.date).
 */
export const LIFECYCLE_STATES = ['supported', 'ending', 'eol', 'unknown'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export interface StackLifecycle {
  state: LifecycleState;
  /** The release cycle the version belongs to (e.g. "24" for 24.11.0); null when none matched */
  cycle: string | null;
  /** End of life (YYYY-MM-DD); null when not known */
  eolFrom: string | null;
  /** End of active support (YYYY-MM-DD), for products that have one */
  eoasFrom: string | null;
  isLts: boolean;
  /** Latest version of the cycle */
  latest: string | null;
  /** Whole days until the end of life (negative: past); null when not known */
  daysLeft: number | null;
}

export const LIFECYCLE_LIMITS = { warnDaysMin: 1, warnDaysMax: 730, defaultWarnDays: 90 } as const;

export interface LifecycleSettings {
  /** The endoflife.date platform to read; null: the first platform of kind endoflife-date */
  platformId: string | null;
  /** "Ending" this many days before the end of life */
  warnDays: number;
  /** Message the application owners when a component's release cycle is ending and when it reached its end of life */
  notify: boolean;
  /** Count the tech stack on the scorecard (part "Tech stack") */
  scorecard: boolean;
  /** Own container images and their product, before the built-in ones (#111) */
  imageMap?: ImageProductRule[];
}

export const DEFAULT_LIFECYCLE_SETTINGS: LifecycleSettings = { platformId: null, warnDays: LIFECYCLE_LIMITS.defaultWarnDays, notify: true, scorecard: false };

export interface LifecycleStatus {
  settings: LifecycleSettings;
  /** The platform in use (null: none of kind endoflife-date) */
  platform: { id: string; name: string } | null;
  /** Products in the tech stacks / of these with end-of-life data */
  products: number;
  withData: number;
  refreshedAt: string | null;
  /** Products that could not be read at the last refresh */
  errors: { product: string; error: string }[];
  canEdit: boolean;
  canRefresh: boolean;
}

export interface ApplicationComponent {
  id: string;
  type: ComponentType;
  name: string;
  url: string;
  note: string;
  /** The environment (#129): empty when the component serves all environments (e.g. the repository) */
  environment: string;
  stack: StackEntry[];
  /** The last SBOM import */
  sbom: { format: SbomFormat; name: string; importedAt: string; importedBy: string } | null;
  /** Kubernetes namespace (#111): the cluster (a platform of kind kubernetes) and what Steward last read from it */
  platformId?: string | null;
  cluster?: NamespaceReadout | null;
  /** Repository (#107): what Steward last read from its Git platform (platformId: a platform of kind github, gitlab or forgejo) */
  repository?: RepositoryReadout | null;
  /** Kafka topic (#112): what Steward last read from its Kafka platform */
  topic?: TopicReadout | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** A product and version across the components and systems of an application. */
export interface ApplicationStackItem {
  product: string;
  label: string;
  version: string;
  lifecycle: StackLifecycle | null;
  components: { id: string; name: string; type: ComponentType; environment: string }[];
  /** Systems the application runs on with this product (#129), one entry per link */
  systems: { id: string; name: string; environment: string }[];
  /** The environments it is used in, in the order of the environment list ('' – not specific to one – last) */
  environments: string[];
  /** Used in an environment flagged as production */
  production: boolean;
}

/** A product of the endoflife.date list, offered when a stack is entered by hand. */
export interface StackProduct {
  id: string;
  label: string;
  category: string;
  /** Release cycles, newest first (e.g. "24", "22") */
  cycles: string[];
}

export const SBOM_FORMATS = ['cyclonedx', 'spdx'] as const;
export type SbomFormat = (typeof SBOM_FORMATS)[number];

/**
 * What an SBOM import changes in a component's stack:
 * add / update / remove (an SBOM entry the new SBOM no longer has), keep (same version), manual (the SBOM names
 * another version, the entry entered by hand stays).
 */
export interface SbomChange {
  action: 'add' | 'update' | 'remove' | 'keep' | 'manual';
  product: string;
  label: string;
  /** The version afterwards (remove: the version removed) */
  version: string;
  /** update / manual: the version before (manual: the SBOM's version) */
  other: string | null;
  /** The SBOM component it was read from */
  sbomRef: string;
}

export interface SbomPreview {
  format: SbomFormat;
  /** Name of what the SBOM describes (its metadata), if any */
  name: string;
  /** Components and packages in the SBOM */
  total: number;
  /** Of these, the ones endoflife.date knows (the others are libraries and stay out) */
  matched: number;
  changes: SbomChange[];
}

// ---------- environments (#129) ----------

/**
 * The environments of an organisation, in order: offered on platforms, on "runs on" links and on components. Free
 * text stays possible; the list gives the order, a colour and which ones count as production (end of life is more
 * urgent there).
 */
export interface CatalogueEnvironment {
  name: string;
  color: CiaColor | null;
  production: boolean;
}

export const ENVIRONMENT_LIMITS = { max: 30, name: 60 } as const;

export const DEFAULT_ENVIRONMENTS: readonly CatalogueEnvironment[] = [
  { name: 'dev', color: 'blue', production: false },
  { name: 'test', color: 'yellow', production: false },
  { name: 'prod', color: 'red', production: true },
];

export interface EnvironmentSettings {
  environments: CatalogueEnvironment[];
  /** Values in use on platforms, links and components that are not on the list (to adopt them) */
  unlisted: { name: string; count: number }[];
  updatedAt: string | null;
  updatedBy: string | null;
  canEdit: boolean;
}

/** Position of an environment in the list for sorting: unlisted values after the list, '' (all environments) last. */
export function environmentRank(list: readonly { name: string }[], name: string): number {
  if (!name) return list.length + 2;
  const i = list.findIndex((e) => e.name.toLowerCase() === name.toLowerCase());
  return i < 0 ? list.length + 1 : i;
}

export const isProductionEnvironment = (list: readonly CatalogueEnvironment[], name: string): boolean =>
  !!name && list.some((e) => e.production && e.name.toLowerCase() === name.toLowerCase());

// ---------- systems (#129) ----------

/** What a system is: a short fixed list, anything else is "other". */
export const SYSTEM_KINDS = ['server', 'vm', 'cluster', 'appliance', 'cloud-service', 'other'] as const;
export type SystemKind = (typeof SYSTEM_KINDS)[number];

export const SYSTEM_LIMITS = { name: 160, vendor: 120, note: 2000, linkNote: 500, perApplication: 200 } as const;

export interface SystemSummary {
  id: string;
  name: string;
  kind: SystemKind;
  /** Vendor or provider (AWS, Azure, on-premises, the hoster, …) */
  vendor: string;
  cmdbUrl: string;
  owners: string[];
  note: string;
  /** The Steward platform this system is (null: none, or one the reader may not see – then platformHidden) */
  platform: { id: string; name: string; environment: string } | null;
  platformHidden: boolean;
  /** Distinct applications that run on it */
  applicationCount: number;
  /** Its environments (from the links), in list order */
  environments: string[];
  /** Products of the stack past their end of life / ending */
  eol: number;
  ending: number;
  updatedAt: string;
}

export interface SystemApplicationRef {
  linkId: string;
  applicationId: string;
  applicationName: string;
  archived: boolean;
  environment: string;
  note: string;
}

export interface SystemDetail extends SystemSummary {
  stack: StackEntry[];
  sbom: { format: SbomFormat; name: string; importedAt: string; importedBy: string } | null;
  applications: SystemApplicationRef[];
  /** Credentials register entries that belong to the system and that the reader may see (#143) */
  credentials: ApplicationCredential[];
  createdAt: string;
  createdBy: string;
  updatedBy: string;
  canEdit: boolean;
}

/** An application runs on a system in an environment. */
export interface ApplicationSystemLink {
  id: string;
  systemId: string;
  name: string;
  kind: SystemKind;
  vendor: string;
  environment: string;
  note: string;
  stack: StackEntry[];
  createdAt: string;
  createdBy: string;
}

/** An application of a service (service page), with its rating and its integrations. */
export interface ServiceApplication {
  id: string;
  name: string;
  archived: boolean;
  criticality: ServiceCriticality | null;
  role: ApplicationRole | null;
  roleText: string;
  rating: ApplicationRating;
  integrations: ApplicationIntegration[];
  addedAt: string;
  addedBy: string;
}

/** An application a document applies to. */
export interface DocumentApplicationRef {
  id: string;
  name: string;
  archived: boolean;
}

/** Index of a level in a scale (-1: not on it). The maximum principle compares these. */
export function levelRank(levels: readonly CiaLevel[], key: string | null | undefined): number {
  return key ? levels.findIndex((l) => l.key === key) : -1;
}

/** A value for each dimension. */
export function byDimension<T>(f: (d: CiaDimension) => T): Record<CiaDimension, T> {
  return { confidentiality: f('confidentiality'), integrity: f('integrity'), availability: f('availability') };
}

/**
 * Level keys on both scales whose order among the kept keys changed: ratings with such a key mean something else
 * on the new scale (a scale change flags them for re-rating, after a confirmation).
 */
export function reorderedLevels(before: readonly { key: string }[], next: readonly { key: string }[]): string[] {
  const nextKeys = new Set(next.map((l) => l.key));
  const beforeKeys = new Set(before.map((l) => l.key));
  const a = before.map((l) => l.key).filter((k) => nextKeys.has(k));
  const b = next.map((l) => l.key).filter((k) => beforeKeys.has(k));
  return a.filter((k, i) => b[i] !== k);
}

/**
 * Level keys on both scales that take a label another level had before (labels swapped, e.g. normal → "High" and
 * high → "Normal"): their ratings read differently afterwards, like a re-order. A new text is not a swap.
 */
export function swappedLabels(before: readonly { key: string; label: string }[], next: readonly { key: string; label: string }[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const beforeKeys = new Set(before.map((l) => l.key));
  return next
    .filter((l) => beforeKeys.has(l.key))
    .filter((l) => before.some((b) => b.key !== l.key && norm(b.label) === norm(l.label)))
    .map((l) => l.key);
}

/** Kept levels whose ratings would mean something else on the new scale: moved, or given another level's label. */
export function remeanedLevels(before: readonly { key: string; label: string }[], next: readonly { key: string; label: string }[]): string[] {
  return [...new Set([...reorderedLevels(before, next), ...swappedLabels(before, next)])];
}
