import { db } from '../db.js';

/**
 * A platform that is deleted takes its own cost plan with it (0.19.0, ADR 0032): its plan lines, entries, import
 * records and the payment schedules it pays (lines of other plans made from them become ordinary lines), and its place
 * on contracts. In the caller's transaction; the caller's audit entry records the counts.
 */
export function forgetPlatformPlan(platformId: string): { planLines: number; entries: number; schedules: number; contracts: number } {
  const schedules = db()
    .all<{ id: string }>('SELECT id FROM cost_schedules WHERE platform_id = ?', platformId)
    .map((r) => r.id);
  for (const id of schedules) db().run('UPDATE cost_plan_lines SET schedule_id = NULL, schedule_part = NULL, schedule_basis = NULL WHERE schedule_id = ?', id);
  db().run('DELETE FROM cost_entry_imports WHERE platform_id = ?', platformId);
  return {
    schedules: db().run('DELETE FROM cost_schedules WHERE platform_id = ?', platformId).changes,
    entries: db().run('DELETE FROM cost_entries WHERE platform_id = ?', platformId).changes,
    planLines: db().run('DELETE FROM cost_plan_lines WHERE platform_id = ?', platformId).changes,
    contracts: db().run('DELETE FROM supplier_contract_platforms WHERE platform_id = ?', platformId).changes,
  };
}
