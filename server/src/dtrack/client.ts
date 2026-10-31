import { DTRACK_LIMITS, DTRACK_SEVERITIES, type DtrackFinding, type DtrackReadout, type DtrackSeverity, type Platform } from '@sm/shared';
import { platformRequest } from '../platforms/http.js';

/**
 * The Dependency-Track REST API (#119), read-only with an API key (X-Api-Key, a team with VIEW_PORTFOLIO and
 * VIEW_VULNERABILITY / VIEW_POLICY_VIOLATION). The platform's base URL is the API server (https://dtrack-api.example.com);
 * the variable frontendUrl, when set, gives links into Dependency-Track's own UI.
 *
 *   GET /api/v1/project/lookup?name=&version=   a project by name and version
 *   GET /api/v1/project/latest/{name}           the latest version of a project (4.10+)
 *   GET /api/v1/project/{uuid}
 *   GET /api/v1/metrics/project/{uuid}/current  counts per severity, policy violations, risk score
 *   GET /api/v1/finding/project/{uuid}          findings with their analysis (suppressed ones left out)
 */

interface Project {
  uuid: string;
  name: string;
  version?: string | null;
  lastBomImport?: number | null;
}

interface Metrics {
  critical?: number;
  high?: number;
  medium?: number;
  low?: number;
  unassigned?: number;
  policyViolationsFail?: number;
  policyViolationsWarn?: number;
  policyViolationsInfo?: number;
  inheritedRiskScore?: number;
}

interface Finding {
  component?: { name?: string; group?: string; version?: string };
  vulnerability?: {
    vulnId?: string;
    source?: string;
    severity?: string;
    epssScore?: number | null;
    cvssV3BaseScore?: number | null;
    cvssV2BaseScore?: number | null;
    patchedVersions?: string | null;
  };
  analysis?: { state?: string | null; isSuppressed?: boolean };
}

const NOT_COUNTED = new Set(['NOT_AFFECTED', 'FALSE_POSITIVE']);
const RANK: Record<DtrackSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, unassigned: 4 };

export function severityOf(s: string | undefined): DtrackSeverity {
  const v = String(s ?? '').toLowerCase();
  return (DTRACK_SEVERITIES as readonly string[]).includes(v) ? (v as DtrackSeverity) : v === 'info' ? 'low' : 'unassigned';
}

export class DtrackClient {
  constructor(
    readonly p: Platform,
    private readonly secrets: Record<string, string>,
    private readonly signal?: AbortSignal,
  ) {}

  private async get<T>(path: string, query: Record<string, string> = {}, optional = false): Promise<T | null> {
    const r = await platformRequest(this.p, this.secrets, { method: 'GET', url: path, query, maxResponseBytes: 32 * 1024 * 1024 }, this.signal);
    if (optional && r.status === 404) return null;
    if (!r.ok) {
      const msg = typeof r.body === 'string' ? r.body.slice(0, 200) : '';
      throw Object.assign(new Error(`Dependency-Track answered HTTP ${r.status} for ${path}${msg ? `: ${msg}` : ''}`), { status: r.status });
    }
    return r.body as T;
  }

  async version(): Promise<string> {
    const v = await this.get<{ version?: string; application?: string }>('/api/version');
    return v?.version ?? '?';
  }

  /** The project a component names: a UUID, name@version or name@latest. */
  async project(ref: string): Promise<Project | null> {
    const r = ref.trim();
    if (/^[0-9a-f-]{36}$/i.test(r)) return this.get<Project>(`/api/v1/project/${encodeURIComponent(r)}`, {}, true);
    const at = r.lastIndexOf('@');
    const name = r.slice(0, at);
    const version = r.slice(at + 1);
    if (version.toLowerCase() === 'latest') return this.get<Project>(`/api/v1/project/latest/${encodeURIComponent(name)}`, {}, true);
    return this.get<Project>('/api/v1/project/lookup', { name, version }, true);
  }

  async read(ref: string): Promise<Omit<DtrackReadout, 'readAt' | 'error'>> {
    const project = await this.project(ref);
    if (!project) throw Object.assign(new Error(`Dependency-Track has no project ${ref}`), { status: 404 });
    const m = (await this.get<Metrics>(`/api/v1/metrics/project/${encodeURIComponent(project.uuid)}/current`, {}, true)) ?? {};
    const findings = (await this.get<Finding[]>(`/api/v1/finding/project/${encodeURIComponent(project.uuid)}`, { suppressed: 'false' })) ?? [];
    // counted from the findings, so an analysis of NOT_AFFECTED or FALSE_POSITIVE takes a finding out at once
    // (the metrics follow only after Dependency-Track's next metrics update)
    const open = findings.filter((f) => !f.analysis?.isSuppressed && !NOT_COUNTED.has(String(f.analysis?.state ?? '')));
    const counts = Object.fromEntries(DTRACK_SEVERITIES.map((s) => [s, 0])) as Record<DtrackSeverity, number>;
    for (const f of open) counts[severityOf(f.vulnerability?.severity)]++;
    const top: DtrackFinding[] = open
      .map((f) => ({
        vulnId: f.vulnerability?.vulnId ?? '?',
        source: f.vulnerability?.source ?? '',
        severity: severityOf(f.vulnerability?.severity),
        component: [f.component?.group, f.component?.name].filter(Boolean).join('/') || '?',
        version: f.component?.version ?? '',
        fixedIn: f.vulnerability?.patchedVersions || null,
        epss: typeof f.vulnerability?.epssScore === 'number' ? f.vulnerability.epssScore : null,
        cvss: f.vulnerability?.cvssV3BaseScore ?? f.vulnerability?.cvssV2BaseScore ?? null,
        analysis: f.analysis?.state ?? null,
      }))
      .sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.epss ?? 0) - (a.epss ?? 0) || (b.cvss ?? 0) - (a.cvss ?? 0))
      .slice(0, DTRACK_LIMITS.topFindings);
    const front = String(this.p.config.variables?.frontendUrl ?? '').replace(/\/+$/, '');
    return {
      project: {
        uuid: project.uuid,
        name: project.name,
        version: project.version ?? '',
        lastBomImport: project.lastBomImport ? new Date(project.lastBomImport).toISOString() : null,
      },
      counts,
      policy: { fail: Number(m.policyViolationsFail ?? 0), warn: Number(m.policyViolationsWarn ?? 0), info: Number(m.policyViolationsInfo ?? 0) },
      riskScore: typeof m.inheritedRiskScore === 'number' ? m.inheritedRiskScore : null,
      top,
      url: /^https?:\/\//i.test(front) ? `${front}/projects/${project.uuid}` : null,
    };
  }
}
