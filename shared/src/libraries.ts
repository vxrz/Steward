/**
 * Shared procedure libraries (0.10.0, #238, docs/adr/0014-shared-procedure-libraries.md, docs/LIBRARIES.md).
 *
 * A library is a named, versioned set of Steward items from one publisher; one version of it is a release. A
 * release is a folder with `steward-library.yaml` (written by the publisher), `release.json` (written by
 * `steward library build`: every file with its size and SHA-256) and `release.json.sig` (an OpenSSH signature,
 * `ssh-keygen -Y sign -n steward-library`). Steward verifies it against the keys an administrator trusts, shows
 * the whole release for review and installs it in one transaction. Nothing in a library runs by itself.
 */

export const LIBRARY_MANIFEST_FILE = 'steward-library.yaml';
export const LIBRARY_RELEASE_FILE = 'release.json';
export const LIBRARY_SIGNATURE_FILE = 'release.json.sig';
/** The SSHSIG namespace: separates these signatures from Git commit signatures made with the same key. */
export const LIBRARY_SIGNATURE_NAMESPACE = 'steward-library';
export const LIBRARY_MANIFEST_FORMAT = 'steward-library';
export const LIBRARY_RELEASE_FORMAT = 'steward-library-release';

/** Limits of one release (as Git sync's SYNC_LIMITS, plus the files of a library). */
export const LIBRARY_LIMITS = {
  /** Files of a release, release.json and its signature included */
  maxFiles: 200,
  /** One file */
  maxFileBytes: 256 * 1024,
  /** All files together */
  maxTotalBytes: 4 * 1024 * 1024,
  /** release.json */
  maxReleaseJsonBytes: 512 * 1024,
  /** An uploaded .zip of a library folder */
  maxUploadBytes: 8 * 1024 * 1024,
  /** Keys of one publisher */
  maxKeysPerPublisher: 20,
  /** Library ids a publisher may be limited to */
  maxLibrariesPerPublisher: 100,
  /** Tags one fetch of a library source lists */
  maxTags: 1000,
} as const;

/** Ids of libraries and publishers: lower case, digits and hyphens. */
export const LIBRARY_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** SemVer 2.0.0 without build metadata: 1.4.0, 1.5.0-rc.1. */
export const LIBRARY_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** What a library may carry. Never platforms, identities, credentials, access lists, schedules, triggers or settings. */
export const LIBRARY_ITEM_KINDS = ['process', 'dashboard', 'monitor', 'recordType', 'connector'] as const;
export type LibraryItemKind = (typeof LIBRARY_ITEM_KINDS)[number];

/**
 * A publisher key that is part of the build (shown as "Built in", can be removed by an administrator).
 *
 * TODO(maintainer): Steward's own publisher key lives on a maintainer's hardware key (ADR 0014, decided). Add it
 * here – `{ publisher: 'steward', name: 'Steward', key: 'sk-ssh-ed25519@openssh.com AAAA…' }` – together with its
 * fingerprint in SECURITY.md, then sign examples/release.json with it (docs/LIBRARIES.md, "Steward's own key").
 * Until then the list is empty and no installation trusts any publisher it was not told to trust.
 */
export interface BuiltInPublisherKey {
  publisher: string;
  name: string;
  contact?: string;
  /** OpenSSH public key line (ssh-ed25519 or sk-ssh-ed25519@openssh.com) */
  key: string;
}
export const BUILT_IN_PUBLISHER_KEYS: readonly BuiltInPublisherKey[] = [];

export const LIBRARY_KEY_STATES = ['active', 'retired', 'revoked'] as const;
/** The state a release shows for its signing key */
export type LibraryReleaseKeyState = LibraryKeyState | 'expired' | 'unknown';
export type LibraryKeyState = (typeof LIBRARY_KEY_STATES)[number];

/** Why a release was not staged (the source and the audit entry library.release_refused show it). */
export const LIBRARY_REFUSALS = [
  'LIBRARY_SIGNATURE_INVALID',
  'LIBRARY_KEY_UNKNOWN',
  'LIBRARY_KEY_REVOKED',
  'LIBRARY_KEY_RETIRED',
  'LIBRARY_KEY_EXPIRED',
  'LIBRARY_FILE_MISMATCH',
  'LIBRARY_DOWNGRADE',
  'LIBRARY_PUBLISHER_CHANGED',
  'LIBRARY_NOT_ALLOWED',
  'LIBRARY_INVALID',
  'LIBRARY_TAG_MISMATCH',
] as const;
export type LibraryRefusal = (typeof LIBRARY_REFUSALS)[number];

export interface LibraryKey {
  id: string;
  publisherId: string;
  /** `ssh-ed25519 AAAA…` (without comment) */
  key: string;
  type: 'ssh-ed25519' | 'sk-ssh-ed25519@openssh.com';
  /** What `ssh-keygen -l` prints: SHA256:… */
  fingerprint: string;
  comment: string;
  state: LibraryKeyState;
  expiresAt: string | null;
  revokedReason: string | null;
  builtIn: boolean;
  /** The seal (vault integrity key) holds: a key written into the database directly is not trusted */
  integrity: 'ok' | 'unsealed' | 'mismatch' | 'locked';
  createdBy: string;
  createdAt: string;
  changedBy: string | null;
  changedAt: string | null;
}

export interface LibraryPublisher {
  id: string;
  name: string;
  contact: string;
  /** Library ids this publisher may publish; empty = any */
  libraries: string[];
  builtIn: boolean;
  keys: LibraryKey[];
  integrity: 'ok' | 'unsealed' | 'mismatch' | 'locked';
  createdBy: string;
  createdAt: string;
  /** Libraries installed from this publisher */
  installed: string[];
}

export interface LibraryReferenceDef {
  ref: string;
  kind?: string;
  description?: string;
}

export interface LibraryChangelogEntry {
  release: string;
  notes: string;
}

/** Where a release came from. */
export type LibraryReleaseSource =
  { type: 'git'; sourceId: string; sourceName: string; repoUrl: string; tag: string; commit: string } | { type: 'upload'; fileName: string; sha256: string };

export const LIBRARY_RELEASE_STATES = ['staged', 'installed', 'previous', 'superseded', 'older'] as const;
export type LibraryReleaseState = (typeof LIBRARY_RELEASE_STATES)[number];

export interface LibraryReleaseSummary {
  id: string;
  library: string;
  name: string;
  publisherId: string;
  publisherName: string;
  release: string;
  state: LibraryReleaseState;
  /** SHA-256 of release.json (the signed file) */
  sha256: string;
  keyFingerprint: string;
  /** expired: the key's validity ended – its releases are no longer installed (a rollback to an installed one stays possible) */
  keyState: LibraryReleaseKeyState;
  stewardMinVersion: string;
  /** The running Steward is older than steward_min_version: listed as "Needs Steward x.y.z" */
  needsVersion: string | null;
  source: LibraryReleaseSource;
  stagedAt: string;
  stagedBy: string;
  installedAt: string | null;
  installedBy: string | null;
  items: number;
  /** Four-eyes (control point library.install): an install that waits for a second person */
  installRequest: { by: string; at: string; rollback: boolean } | null;
}

export interface LibraryInstallSummary {
  library: string;
  name: string;
  publisherId: string;
  publisherName: string;
  release: LibraryReleaseSummary;
  /** The release installed before this one (rollback target) */
  previous: { id: string; release: string } | null;
  /** A newer staged release waiting for review */
  update: { id: string; release: string } | null;
  held: boolean;
  heldBy: string | null;
  heldAt: string | null;
  /** Signed by a key that was revoked since */
  revoked: boolean;
  installedAt: string;
  installedBy: string;
  /** The library's Git source: when it was last checked and the newest release seen (freeze) */
  lastCheckedAt: string | null;
  newestSeen: string | null;
}

export type LibraryItemStatus = 'new' | 'changed' | 'unchanged' | 'removed' | 'conflict' | 'skipped';

/** Computed by Steward from the items, not from the publisher's words. */
export interface LibraryProcessAbilities {
  /** Connection slots with the platform kind they expect */
  slots: { slot: string; kind: string | null }[];
  /**
   * HTTP steps that may write: every method but GET, HEAD and OPTIONS – whatever their `mutating` flag says – and
   * read methods marked as mutating
   */
  writes: number;
  /**
   * Of those, steps marked `mutating: false` ("marked as not changing anything"): the engine treats them as reads, so
   * they also run in a dry run
   */
  markedNotChanging: number;
  accessChanges: number;
  browser: number;
  ai: number;
  databaseQueries: number;
  subprocesses: string[];
  /** Check steps that notify, user tasks that ask a person */
  notifications: number;
  userTasks: number;
  datasets: string[];
}

/** What a monitor's outputs do when its state changes (computed from the file): where data goes out, what it starts. */
export interface LibraryMonitorOutputs {
  outputs: { id: string; type: string; target: string; dryRun?: boolean }[];
  /** Webhooks (a URL or a platform) and Gatus/Zabbix pushes: monitor data leaves Steward */
  sendsOut: number;
  /** Processes the monitor starts (by id) */
  startsProcesses: string[];
  notifications: number;
}

export interface LibraryConnectorView {
  kind: string;
  label: string;
  /** Shown in full: credentials go there */
  baseUrl: string;
  tokenUrl: string | null;
  trustedOrigins: string[];
  authType: string;
  secretFields: string[];
  specs: number;
  /** The HTTP settings in full (config.http): TLS verification, CA certificate, proxy, default headers, … */
  http: Record<string, unknown>;
  /** Certificate verification is switched off */
  insecureTls: boolean;
  /** A CA certificate of its own is trusted */
  customCa: boolean;
  proxy: string | null;
  defaultHeaders: string[];
}

export interface LibraryReviewItem {
  path: string;
  kind: LibraryItemKind;
  /** The id the file gives (kept as it is – a clash is a conflict) */
  identity: string;
  name: string;
  status: LibraryItemStatus;
  conflictReason: 'notFromLibrary' | 'changedLocally' | 'otherLibrary' | null;
  /** The local item */
  entityId: string | null;
  /** The reviewer may create/change this item (the same rights as by hand) */
  canDecide: boolean;
  incomingText: string;
  currentText: string | null;
  /** Processes: what the process can do, and what is new since the installed release */
  abilities?: LibraryProcessAbilities;
  newAbilities?: string[];
  /** Monitors: platform references of the file */
  platformRefs?: string[];
  /** Monitors: what their outputs do */
  monitorOutputs?: LibraryMonitorOutputs;
  /** Connector types: the destinations, shown in full */
  connector?: LibraryConnectorView;
  /** A sub-process step names a process that is neither in the library nor a mapped reference */
  problems: string[];
  /** Four-eyes: what the stored request does with this item */
  requested?: 'install' | 'skip' | 'keepLocal' | 'takeLibrary' | 'detach' | 'link';
}

export interface LibraryReferenceChoice {
  ref: string;
  kind: string | null;
  description: string;
  /** The local platform/process chosen before (kept for updates) */
  mapped: string | null;
  /** New since the installed release */
  isNew: boolean;
  candidates: { id: string; name: string; kind?: string }[];
}

/**
 * Four-eyes: the decisions the requester stored, shown to the approver exactly as they will be installed. `hash`
 * binds the approval to them (a request withdrawn and asked again with other decisions is not approved by mistake).
 */
export interface LibraryRequestedDecisions {
  by: string;
  at: string;
  rollback: boolean;
  hash: string;
  /** reference → the chosen platform (name only when the viewer may see it) */
  platforms: { ref: string; id: string; name: string | null }[];
  processes: { ref: string; id: string; name: string | null }[];
  skip: string[];
  keepLocal: string[];
  takeLibrary: string[];
  comment: string | null;
}

export interface LibraryReview {
  release: LibraryReleaseSummary;
  /** Four-eyes: what the requester decided; the items and references below show the review for exactly these decisions */
  request: LibraryRequestedDecisions | null;
  installed: { id: string; release: string } | null;
  description: string;
  licence: string;
  changelog: LibraryChangelogEntry[];
  items: LibraryReviewItem[];
  references: { platforms: LibraryReferenceChoice[]; processes: LibraryReferenceChoice[] };
  /** Why accepting is not possible now, as codes: needsVersion, revokedKey, expiredKey, installed, notPrevious, downgrade, rights, undeclaredProcess */
  blockers: string[];
  canInstall: boolean;
  /** The release has connector types: only administrators install it */
  needsAdmin: boolean;
}

export interface LibraryInstallRequest {
  /** platform ref → platform id, process ref → process id */
  platforms?: Record<string, string>;
  processes?: Record<string, string>;
  /** New items not to install (paths) */
  skip?: string[];
  /** Conflicts: keep the local item (path) or take the library's */
  keepLocal?: string[];
  takeLibrary?: string[];
  comment?: string;
}

/** The library a process version came from (process_versions.origin; runs, reports and evidence name it). */
export interface LibraryOrigin {
  library: string;
  release: string;
  publisher: string;
  keyFingerprint: string;
  /** SHA-256 of the signed release.json */
  releaseSha256: string;
  releaseId: string;
}

/** An item installed from a library (the "From library" badge). */
export interface LibraryItemOrigin {
  kind: LibraryItemKind;
  entityId: string;
  /** The item's name in Steward */
  name: string;
  library: string;
  libraryName: string;
  release: string;
  releaseId: string;
  publisherId: string;
  path: string;
  changedLocally: boolean;
  held: boolean;
  revoked: boolean;
}

/** SemVer precedence (SemVer 2.0.0 section 11); null when one of them is not a version. */
export function compareSemver(a: string, b: string): number | null {
  const x = LIBRARY_SEMVER_RE.exec(a);
  const y = LIBRARY_SEMVER_RE.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  const pa = x[4];
  const pb = y[4];
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  const ia = pa.split('.');
  const ib = pb.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/.test(ia[i]!);
    const nb = /^\d+$/.test(ib[i]!);
    if (na && nb) {
      const d = Number(ia[i]) - Number(ib[i]);
      if (d) return Math.sign(d);
    } else if (na !== nb) return na ? -1 : 1;
    else if (ia[i] !== ib[i]) return ia[i]! < ib[i]! ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (v: string) => !!LIBRARY_SEMVER_RE.exec(v)?.[4];
