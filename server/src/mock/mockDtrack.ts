import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * A demo Dependency-Track (#119) under /mock/dtrack: the few API calls Steward reads, for the projects shop-web
 * (2.4.1 and 2.5.0, the latest) and crm-api 1.0.0. Requests need the demo API key (X-Api-Key). Tests can add
 * findings (addDtrackFinding) and reset (resetDtrack).
 */

export const DEMO_DTRACK = { apiKey: 'demo-dtrack-api-key' };

interface DemoFinding {
  vulnId: string;
  severity: string;
  component: { name: string; group?: string; version: string };
  epss?: number;
  cvss?: number;
  patched?: string;
  state?: string;
  suppressed?: boolean;
}

interface DemoProject {
  uuid: string;
  name: string;
  version: string;
  isLatest: boolean;
  lastBomImport: number;
  findings: DemoFinding[];
  policy: { fail: number; warn: number; info: number };
}

const day = 86400_000;
const seed = (): DemoProject[] => [
  {
    uuid: '6b1f3c2a-0d4e-4c55-9a11-2f7f0e6b1a01',
    name: 'shop-web',
    version: '2.4.1',
    isLatest: false,
    lastBomImport: Date.now() - 3 * day,
    policy: { fail: 1, warn: 2, info: 0 },
    findings: [
      {
        vulnId: 'CVE-2021-44228',
        severity: 'CRITICAL',
        component: { group: 'org.apache.logging.log4j', name: 'log4j-core', version: '2.14.1' },
        epss: 0.975,
        cvss: 10,
        patched: '2.17.1',
      },
      { vulnId: 'GHSA-35jh-r3h4-6jhm', severity: 'HIGH', component: { name: 'lodash', version: '4.17.15' }, epss: 0.012, cvss: 7.2, patched: '4.17.21' },
      {
        vulnId: 'CVE-2024-4068',
        severity: 'HIGH',
        component: { name: 'braces', version: '3.0.2' },
        epss: 0.002,
        cvss: 7.5,
        patched: '3.0.3',
        state: 'NOT_AFFECTED',
      },
      { vulnId: 'CVE-2022-25883', severity: 'MEDIUM', component: { name: 'semver', version: '7.3.5' }, epss: 0.004, cvss: 5.3, patched: '7.5.2' },
      { vulnId: 'CVE-2020-28469', severity: 'MEDIUM', component: { name: 'glob-parent', version: '5.1.1' }, cvss: 5.3, suppressed: true },
      { vulnId: 'CVE-2023-26115', severity: 'LOW', component: { name: 'word-wrap', version: '1.2.3' }, cvss: 3.1, patched: '1.2.4', state: 'IN_TRIAGE' },
    ],
  },
  {
    uuid: '6b1f3c2a-0d4e-4c55-9a11-2f7f0e6b1a02',
    name: 'shop-web',
    version: '2.5.0',
    isLatest: true,
    lastBomImport: Date.now() - day,
    policy: { fail: 0, warn: 1, info: 0 },
    findings: [{ vulnId: 'CVE-2022-25883', severity: 'MEDIUM', component: { name: 'semver', version: '7.3.5' }, epss: 0.004, cvss: 5.3, patched: '7.5.2' }],
  },
  {
    uuid: '9c2d4e5f-1a2b-4c3d-8e9f-0a1b2c3d4e05',
    name: 'crm-api',
    version: '1.0.0',
    isLatest: true,
    lastBomImport: Date.now() - 10 * day,
    policy: { fail: 0, warn: 0, info: 0 },
    findings: [],
  },
];

let projects = seed();
export function resetDtrack(): void {
  projects = seed();
}
export function addDtrackFinding(project: string, f: DemoFinding): void {
  projects.find((p) => p.uuid === project || `${p.name}@${p.version}` === project)?.findings.push(f);
}
export function setDtrackPolicy(project: string, policy: DemoProject['policy']): void {
  const p = projects.find((x) => x.uuid === project || `${x.name}@${x.version}` === project);
  if (p) p.policy = policy;
}

const out = (p: DemoProject) => ({ uuid: p.uuid, name: p.name, version: p.version, isLatest: p.isLatest, lastBomImport: p.lastBomImport, active: true });

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.headers['x-api-key'] === DEMO_DTRACK.apiKey) return true;
  void reply.code(401).type('text/plain').send('Unauthorized');
  return false;
}

export async function mockDtrack(app: FastifyInstance): Promise<void> {
  app.get('/dtrack/api/version', async () => ({ version: '4.12.1', application: 'Dependency-Track' }));
  app.get('/dtrack/api/v1/project', async (req, reply) => {
    if (!authorized(req, reply)) return;
    return projects.map(out);
  });
  app.get('/dtrack/api/v1/project/lookup', async (req, reply) => {
    if (!authorized(req, reply)) return;
    const q = req.query as { name?: string; version?: string };
    const p = projects.find((x) => x.name === q.name && x.version === q.version);
    return p ? out(p) : reply.code(404).send('The project could not be found.');
  });
  app.get('/dtrack/api/v1/project/latest/:name', async (req, reply) => {
    if (!authorized(req, reply)) return;
    const p = projects.find((x) => x.name === (req.params as { name: string }).name && x.isLatest);
    return p ? out(p) : reply.code(404).send('The project could not be found.');
  });
  app.get('/dtrack/api/v1/project/:uuid', async (req, reply) => {
    if (!authorized(req, reply)) return;
    const p = projects.find((x) => x.uuid === (req.params as { uuid: string }).uuid);
    return p ? out(p) : reply.code(404).send('The project could not be found.');
  });
  app.get('/dtrack/api/v1/metrics/project/:uuid/current', async (req, reply) => {
    if (!authorized(req, reply)) return;
    const p = projects.find((x) => x.uuid === (req.params as { uuid: string }).uuid);
    if (!p) return reply.code(404).send('The project could not be found.');
    // like Dependency-Track: suppressed findings do not count, analysis states only after the next metrics update
    const open = p.findings.filter((f) => !f.suppressed);
    const n = (s: string) => open.filter((f) => f.severity === s).length;
    return {
      critical: n('CRITICAL'),
      high: n('HIGH'),
      medium: n('MEDIUM'),
      low: n('LOW'),
      unassigned: n('UNASSIGNED'),
      policyViolationsFail: p.policy.fail,
      policyViolationsWarn: p.policy.warn,
      policyViolationsInfo: p.policy.info,
      inheritedRiskScore: n('CRITICAL') * 10 + n('HIGH') * 5 + n('MEDIUM') * 3 + n('LOW'),
    };
  });
  app.get('/dtrack/api/v1/finding/project/:uuid', async (req, reply) => {
    if (!authorized(req, reply)) return;
    const p = projects.find((x) => x.uuid === (req.params as { uuid: string }).uuid);
    if (!p) return reply.code(404).send('The project could not be found.');
    const withSuppressed = (req.query as { suppressed?: string }).suppressed === 'true';
    return p.findings
      .filter((f) => withSuppressed || !f.suppressed)
      .map((f) => ({
        component: f.component,
        vulnerability: {
          vulnId: f.vulnId,
          source: f.vulnId.startsWith('GHSA') ? 'GITHUB' : 'NVD',
          severity: f.severity,
          epssScore: f.epss ?? null,
          cvssV3BaseScore: f.cvss ?? null,
          patchedVersions: f.patched ?? null,
        },
        analysis: { state: f.state ?? null, isSuppressed: !!f.suppressed },
      }));
  });
}
