import { DTRACK_KIND, DTRACK_LIMITS, type DtrackReadout, type Platform } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { HttpError, parseJson } from '../util.js';
import { platformFor } from '../monitors/platforms.js';
import { DtrackClient } from './client.js';

/**
 * Dependency-Track (#119). Any application component can name a Dependency-Track platform and its project there; every
 * 6 hours (or on "Read now") Steward reads the project's open findings and policy violations. The scorecard's part
 * "Vulnerabilities" and the monitor check type dependency-track use what was read.
 */

interface Row {
  id: string;
  application_id: string;
  name: string;
  dt_platform_id: string | null;
  dt_project: string | null;
  dt_state: string | null;
  updated_by: string;
}

export function dtrackClient(p: Platform, secrets: Record<string, string>): DtrackClient {
  if (p.kind !== DTRACK_KIND) throw new HttpError(400, `"${p.name}" is not a Dependency-Track platform`, 'DTRACK_PLATFORM');
  return new DtrackClient(p, secrets);
}

const EMPTY = (): Omit<DtrackReadout, 'readAt' | 'error'> => ({
  project: null,
  counts: { critical: 0, high: 0, medium: 0, low: 0, unassigned: 0 },
  policy: { fail: 0, warn: 0, info: 0 },
  riskScore: null,
  top: [],
  url: null,
});

/** Reads the component's project now, with the rights of `actor` on the platform; a failed read keeps the last one. */
export async function refreshDtrackComponent(componentId: string, actor: string, now = Date.now()): Promise<DtrackReadout> {
  const c = db().get<Row>(
    'SELECT id, application_id, name, dt_platform_id, dt_project, dt_state, updated_by FROM application_components WHERE id = ?',
    componentId,
  );
  if (!c) throw new HttpError(404, `Component ${componentId} not found`, 'COMPONENT_NOT_FOUND', { id: componentId });
  if (!c.dt_platform_id || !c.dt_project) throw new HttpError(400, 'Name the Dependency-Track project of the component first', 'COMPONENT_DTRACK_REQUIRED');
  const at = new Date(now).toISOString();
  const before = parseJson<DtrackReadout | null>(c.dt_state, null);
  let readout: DtrackReadout;
  try {
    const { platform, secrets } = platformFor(actor, c.dt_platform_id);
    readout = { readAt: at, error: null, ...(await dtrackClient(platform, secrets).read(c.dt_project)) };
  } catch (e) {
    readout = { ...(before ?? EMPTY()), readAt: at, error: (e as Error).message.slice(0, 500) };
  }
  db().run('UPDATE application_components SET dt_state = ? WHERE id = ?', JSON.stringify(readout), componentId);
  // new critical findings or failing policies are worth a line in the application's history
  if (!readout.error && before && !before.error) {
    const was = new Set(before.top.filter((f) => f.severity === 'critical').map((f) => `${f.vulnId}|${f.component}`));
    const fresh = readout.top.filter((f) => f.severity === 'critical' && !was.has(`${f.vulnId}|${f.component}`));
    if (fresh.length || readout.policy.fail > before.policy.fail)
      audit({
        action: 'application.vulnerabilities_found',
        entityType: 'application',
        entityId: c.application_id,
        actor,
        summary: `Dependency-Track ${c.dt_project}: ${[
          fresh.length ? `new critical ${fresh.map((f) => `${f.vulnId} in ${f.component}`).join(', ')}` : '',
          readout.policy.fail > before.policy.fail ? `${readout.policy.fail} failing policy violation(s)` : '',
        ]
          .filter(Boolean)
          .join('; ')}`.slice(0, 1000),
        details: {
          componentId,
          project: readout.project?.uuid,
          critical: readout.counts.critical,
          policyFail: readout.policy.fail,
          new: fresh.map((f) => f.vulnId),
        },
      });
  }
  return readout;
}

export async function runDtrackJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const rows = db().all<Row>(
    `SELECT c.id, c.application_id, c.name, c.dt_platform_id, c.dt_project, c.dt_state, c.updated_by FROM application_components c
     JOIN applications a ON a.id = c.application_id JOIN platforms p ON p.id = c.dt_platform_id
     WHERE c.dt_project IS NOT NULL AND p.kind = ? AND a.archived = 0`,
    DTRACK_KIND,
  );
  let n = 0;
  for (const r of rows) {
    const last = parseJson<DtrackReadout | null>(r.dt_state, null);
    const age = last ? now - Date.parse(last.readAt) : -1;
    if (last && age >= 0 && age < DTRACK_LIMITS.refreshHours * 3_600_000) continue;
    try {
      await refreshDtrackComponent(r.id, r.updated_by, now);
      n++;
    } catch (err) {
      logger.warn({ err, component: r.id }, 'reading a Dependency-Track project failed');
    }
  }
  return n;
}
