import type { MonitorStatus } from '@sm/shared';
import { HttpError } from '../util.js';
import { vault } from '../vault.js';
import { audit } from '../audit.js';
import { loadMonitor, timeoutMs } from './model.js';
import { requireMonitor } from './service.js';
import { runActiveCheck } from './checks.js';

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
