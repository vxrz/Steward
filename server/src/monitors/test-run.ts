import { checkSchema, issueLabel, type CheckDef, type MonitorStatus } from '@sm/shared';
import { HttpError } from '../util.js';
import { vault } from '../vault.js';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { canCreateMonitors, loadMonitor, timeoutMs } from './model.js';
import { requireMonitor } from './service.js';
import { isActive, runActiveCheck } from './checks.js';
import { resolvePlatformRef } from './platforms.js';

/**
 * Test run of a monitor (#105): its platform checks answered from the platforms' recorded responses, nothing stored
 * – no results, no status change, no messages. Other check types need the real network and are skipped.
 */

export interface MonitorTestResult {
  checkId: string;
  name: string;
  type: string;
  /** null: skipped */
  status: MonitorStatus | null;
  message: string;
  /** true: answered by a recorded response; false: no recording fitted */
  recorded: boolean;
  skipped: boolean;
}

/** Check types that a test run answers from recordings: they call a platform through its connection. */
const RECORDABLE = new Set(['platform', 'freshness']);

export async function testRunMonitor(id: string): Promise<{ checks: MonitorTestResult[] }> {
  const r = requireMonitor(id, 'acknowledge', 'test the checks of this monitor');
  if (!vault().unlocked) throw new HttpError(423, 'The vault is locked', 'VAULT_LOCKED');
  if (r.is_template) throw new HttpError(409, 'Templates are not evaluated', 'MONITOR_NOT_LOADED', { context: 'template' });
  const m = loadMonitor(r);
  const out: MonitorTestResult[] = [];
  const signal = AbortSignal.timeout(120_000);
  for (const c of m.def.checks) {
    const base = { checkId: c.id, name: c.name, type: c.type };
    // a freshness check of the shared Insights Hub read (no path) reads many assets at once: not recorded
    const recordable = RECORDABLE.has(c.type) && (c.type !== 'freshness' || !!(c as { path?: string }).path);
    if (!recordable) {
      out.push({ ...base, status: null, message: 'Skipped: only platform checks run against recorded responses', recorded: false, skipped: true });
      continue;
    }
    const used = { recorded: false };
    const res = await runActiveCheck(c as Parameters<typeof runActiveCheck>[0], {
      owner: m.owner,
      signal,
      timeoutMs: timeoutMs(m, c),
      now: () => Date.now(),
      recorded: used,
    });
    out.push({ ...base, status: res.status, message: res.message, recorded: used.recorded, skipped: false });
  }
  audit({
    action: 'monitor.test_run',
    entityType: 'monitor',
    entityId: m.id,
    summary: `Test run of monitor "${m.name}" with recorded responses: ${out.filter((x) => !x.skipped).length} check(s), ${out.filter((x) => x.skipped).length} skipped`,
    details: { checks: out.map((x) => ({ checkId: x.checkId, status: x.status, recorded: x.recorded, skipped: x.skipped })) },
  });
  return { checks: out };
}

/**
 * _Check now_ on one card while editing (#141): runs the check as it is in the editor, before it is saved, with the
 * rights of the monitor's owner (a new monitor: the person editing it). Nothing is stored; the outbound policy and
 * the platform rights apply as for a running monitor. Heartbeat and sub-monitor checks have no call to make.
 */
export async function previewCheck(input: { monitorId?: string; check: unknown; timeoutSeconds?: number }): Promise<{
  status: MonitorStatus;
  message: string;
  durationMs: number | null;
}> {
  let owner: string;
  let monitorId: string | null = null;
  if (input.monitorId) {
    const r = requireMonitor(input.monitorId, 'edit', 'try the checks of this monitor');
    owner = r.owner;
    monitorId = r.id;
  } else {
    if (!canCreateMonitors()) throw new HttpError(403, 'You may not create monitors', 'FORBIDDEN');
    owner = currentUser()!.username;
  }
  if (!vault().unlocked) throw new HttpError(423, 'The vault is locked', 'VAULT_LOCKED');
  const parsed = checkSchema.safeParse(input.check);
  if (!parsed.success) {
    const def = { checks: [input.check] };
    const details = parsed.error.issues.map((i) => `${issueLabel(def, ['checks', 0, ...i.path].join('.'))}: ${i.message}`).join('; ');
    throw Object.assign(new HttpError(400, details, 'MONITOR_INVALID', { details }), {
      issues: parsed.error.issues.map((i) => ({ path: ['checks', 0, ...i.path].join('.'), message: i.message })),
    });
  }
  const c: CheckDef = { ...parsed.data };
  if (!isActive(c)) throw new HttpError(409, 'This check type is evaluated from reports, not by a call', 'CHECK_PREVIEW_UNSUPPORTED', { type: c.type });
  if ('platform' in c && c.platform) {
    const kind = c.type === 'gatus' ? 'gatus' : c.type === 'freshness' && c.source === 'insightsHub' ? 'insights-hub' : undefined;
    (c as { platform: string }).platform = resolvePlatformRef(c.platform, kind).id;
  }
  const started = Date.now();
  const res = await runActiveCheck(c, {
    owner,
    signal: AbortSignal.timeout(60_000),
    timeoutMs: Math.min(c.timeoutSeconds ?? input.timeoutSeconds ?? 10, 60) * 1000,
    now: () => Date.now(),
  });
  audit({
    action: 'monitor.check_previewed',
    entityType: 'monitor',
    entityId: monitorId ?? undefined,
    summary: `Check "${c.name}" (${c.type}) tried in the editor: ${res.status}`,
    details: { checkId: c.id, type: c.type, status: res.status },
  });
  return { status: res.status, message: res.message, durationMs: res.durationMs ?? Date.now() - started };
}
