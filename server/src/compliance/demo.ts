import { db } from '../db.js';
import { logger } from '../log.js';
import { nowIso } from '../util.js';
import { currentActor } from '../auth/context.js';
import { createCheck, runCheck } from './reconciliation.js';
import { ensureCatalogues } from './controls.js';
import { DEFAULT_ACCESS_CONTROLS } from './catalogues.js';

export const DEMO_CHECK_NAME = 'Insights Hub (demo) – user access';

/**
 * Demo data: an access reconciliation of the simulated Insights Hub (daily), mapped to the access
 * control requirements, with its baseline snapshot. "Simulate a change outside Steward" on the
 * reconciliation page then grants an administrator role in the simulated tenant.
 */
export async function setupComplianceDemo(platformId: string | undefined): Promise<boolean> {
  if (!platformId || db().get('SELECT 1 FROM access_checks WHERE name = ?', DEMO_CHECK_NAME)) return false;
  try {
    const check = createCheck({
      name: DEMO_CHECK_NAME,
      description: 'Who has which role and group in the demo tenant – compared daily with the documented access changes.',
      platformId,
      source: 'insights-hub',
      datasetKey: null,
      cron: '40 6 * * *',
      timezone: 'UTC',
      enabled: true,
      notify: [],
      // the access reviews flag users with this marker group – it grants no access
      ignoreRights: ['mdsp_usergroup:AccessReview'],
    });
    ensureCatalogues();
    for (const d of DEFAULT_ACCESS_CONTROLS) {
      const ctl = db().get<{ id: string }>(
        'SELECT c.id FROM controls c JOIN control_catalogues k ON k.id = c.catalogue_id WHERE k.key = ? AND c.ref = ?',
        d.catalogue,
        d.ref,
      );
      if (ctl)
        db().run(
          "INSERT INTO control_tags (control_id, kind, target_id, created_at, created_by) VALUES (?, 'accessCheck', ?, ?, ?) ON CONFLICT DO NOTHING",
          ctl.id,
          check.id,
          nowIso(),
          currentActor(),
        );
    }
    await runCheck(check.id, { actor: currentActor(), trigger: 'manual' });
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo access reconciliation not created');
    return false;
  }
}
