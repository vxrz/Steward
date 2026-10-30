/** Dependency-Track (#119): vulnerabilities and policy violations of an application component's project. */

export const DTRACK_KIND = 'dependency-track';

export const DTRACK_LIMITS = {
  /** A component's project is read again after this many hours (or on "Read now") */
  refreshHours: 6,
  /** Findings listed in the readout (critical and high first) */
  topFindings: 10,
} as const;

export const DTRACK_SEVERITIES = ['critical', 'high', 'medium', 'low', 'unassigned'] as const;
export type DtrackSeverity = (typeof DTRACK_SEVERITIES)[number];

/** The project of a component: "name@version", "name@latest" (Dependency-Track 4.10+) or the project's UUID. */
export const DTRACK_PROJECT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[^@\s][^@]{0,254}@[^@\s]{1,100})$/i;

export interface DtrackLink {
  platformId: string;
  project: string;
}

export interface DtrackFinding {
  vulnId: string;
  source: string;
  severity: DtrackSeverity;
  /** The package it is in */
  component: string;
  version: string;
  /** A version without it, when Dependency-Track knows one */
  fixedIn: string | null;
  epss: number | null;
  cvss: number | null;
  /** NOT_SET, IN_TRIAGE, EXPLOITABLE, RESOLVED … (NOT_AFFECTED and FALSE_POSITIVE do not count) */
  analysis: string | null;
}

export interface DtrackReadout {
  readAt: string;
  error: string | null;
  project: { uuid: string; name: string; version: string; lastBomImport: string | null } | null;
  /** Open findings: not suppressed, not analysed as not affected or false positive */
  counts: Record<DtrackSeverity, number>;
  policy: { fail: number; warn: number; info: number };
  riskScore: number | null;
  top: DtrackFinding[];
  /** Link to the project in Dependency-Track's own UI, when the frontend URL is set */
  url: string | null;
}
