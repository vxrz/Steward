/**
 * Credentials register: documentation of credentials (who owns them, where they
 * are kept, when they expire or need rotating). Steward never stores a secret
 * value here – there is deliberately no field for one.
 */

export const CREDENTIAL_TYPES = ['apiClient', 'technicalUser', 'password', 'token', 'certificate', 'agentCertificate', 'sshKey', 'other'] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const CREDENTIAL_TYPE_INFO: Record<CredentialType, string> = {
  apiClient: 'API client / OAuth client',
  technicalUser: 'Technical user / service account',
  password: 'Password',
  token: 'Token / API key',
  certificate: 'Certificate',
  agentCertificate: 'Agent / device certificate (e.g. Insights Hub agent)',
  sshKey: 'SSH key',
  other: 'Other',
};

/** ok → dueSoon → overdue (rotation/review date passed) → expired (expiry date passed). */
export const CREDENTIAL_STATUSES = ['ok', 'dueSoon', 'overdue', 'expired'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const CREDENTIAL_DUE_KINDS = ['expiry', 'rotation', 'review'] as const;
export type CredentialDueKind = (typeof CREDENTIAL_DUE_KINDS)[number];

/**
 * Internal link to another Steward object. The kind is open on purpose (process,
 * monitor, platform today; e.g. "service" for a service catalogue later).
 */
export interface CredentialLink {
  kind: string;
  id: string;
  /** Resolved display name (null when the object no longer exists or is not visible) */
  label?: string | null;
}

export interface CredentialOwner {
  email: string;
  /** e.g. "Business owner", "IT operations" */
  role: string;
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  serialNumber: string;
  /** SHA-256 fingerprint, colon-separated hex */
  fingerprint256: string;
  notBefore: string;
  notAfter: string;
}

export interface CertificateInfo extends CertificateSummary {
  subjectAltNames: string[];
  isCA: boolean;
  selfSigned: boolean;
  /** The other certificates of an uploaded chain (leaf first is the entry itself) */
  chain: CertificateSummary[];
  /** Earliest notAfter of the whole chain (what "expires at" was set from) */
  chainNotAfter: string;
}

export interface CredentialDue {
  kind: CredentialDueKind;
  dueAt: string;
  /** Whole days until the due date (negative when passed) */
  daysLeft: number;
  status: CredentialStatus;
}

export interface CredentialReminderOverride {
  /** Remind this many days before a due date, e.g. [30, 14, 7, 1] */
  daysBefore?: number[];
  /** Repeat the overdue reminder every N days (0 = once) */
  overdueEveryDays?: number;
  /** No reminders for this entry */
  disabled?: boolean;
}

export type CredentialPermission = 'view' | 'edit' | 'archive' | 'delete';

export interface Credential {
  id: string;
  name: string;
  type: CredentialType;
  /** A Steward platform, or null with a free-text platform */
  platformId: string | null;
  platformName: string | null;
  platformText: string;
  environment: string;
  description: string;
  usedBy: { text: string; links: CredentialLink[] };
  owners: CredentialOwner[];
  /** Steward users and teams that own the entry: user:<name>, team:<name> */
  ownerSubjects: string[];
  /** Where the secret is kept: free text (e.g. KeePass database and entry path) and an optional link or path */
  location: { text: string; url: string | null };
  issuedAt: string | null;
  expiresAt: string | null;
  rotationIntervalDays: number | null;
  lastRotatedAt: string | null;
  reviewIntervalDays: number | null;
  lastReviewedAt: string | null;
  nextRotationAt: string | null;
  nextReviewAt: string | null;
  /** The earliest of expiry, next rotation and next review */
  nextDueAt: string | null;
  status: CredentialStatus;
  dues: CredentialDue[];
  certificate: CertificateInfo | null;
  /** Keep "expires at" in sync with a Gatus endpoint's certificate expiry (metrics mode) */
  gatus: { platformId: string; endpointKey: string } | null;
  reminders: CredentialReminderOverride | null;
  notes: string;
  tags: string[];
  archived: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
  permissions: CredentialPermission[];
}

export const CREDENTIAL_EVENT_KINDS = ['created', 'updated', 'rotated', 'reviewed', 'certificate', 'expirySynced', 'archived', 'restored', 'reminded'] as const;
export type CredentialEventKind = (typeof CREDENTIAL_EVENT_KINDS)[number];

export interface CredentialEvent {
  id: number;
  ts: string;
  actor: string;
  kind: CredentialEventKind;
  comment: string;
  details: Record<string, unknown>;
}

export interface CredentialReminderSettings {
  enabled: boolean;
  daysBefore: number[];
  overdueEveryDays: number;
  /** "Due soon" status this many days before a due date */
  dueSoonDays: number;
}

export const DEFAULT_CREDENTIAL_REMINDERS: CredentialReminderSettings = { enabled: true, daysBefore: [30, 14, 7, 1], overdueEveryDays: 7, dueSoonDays: 30 };

export interface CredentialList {
  items: Credential[];
  /** The signed-in user may create entries */
  canCreate: boolean;
}

/** Largest certificate upload (PEM/DER/chain). */
export const CERTIFICATE_MAX_BYTES = 256 * 1024;
