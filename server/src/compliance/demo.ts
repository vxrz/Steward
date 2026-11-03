import { db } from '../db.js';
import { logger } from '../log.js';
import { nowIso } from '../util.js';
import { currentActor } from '../auth/context.js';
import { checkInput, createCheck, runCheck } from './reconciliation.js';
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

/**
 * Demo data: access checks of the simulated Snowflake account (roles of users), the AWS account (IAM users) and the
 * GitHub organisation acme, with their baseline snapshots – so a person review (e.g. of karla.lang@example.com or bob)
 * finds the person on several platforms. Named after the Insights Hub check, which stays the first in the list.
 */
export async function setupAccessSourcesDemo(platformByKind: Map<string, string>): Promise<number> {
  const checks: { name: string; kind: string; source: 'snowflake' | 'aws' | 'git'; scope: string | null; description: string }[] = [
    {
      name: 'Platform access (demo) – Snowflake roles',
      kind: 'snowflake',
      source: 'snowflake',
      scope: '',
      description: 'The roles of every user of the demo Snowflake account.',
    },
    {
      name: 'Platform access (demo) – AWS IAM users',
      kind: 'aws',
      source: 'aws',
      scope: null,
      description: 'The IAM users of the demo AWS account with their groups and policies.',
    },
    {
      name: 'Platform access (demo) – GitHub organisation acme',
      kind: 'github',
      source: 'git',
      scope: 'acme',
      description: 'Owners, members and outside collaborators of acme on the demo GitHub.',
    },
  ];
  let n = 0;
  for (const c of checks) {
    const platformId = platformByKind.get(c.kind);
    if (!platformId || db().get('SELECT 1 FROM access_checks WHERE name = ?', c.name)) continue;
    try {
      const check = createCheck(
        checkInput.parse({ name: c.name, description: c.description, platformId, source: c.source, scope: c.scope, cron: '45 6 * * *', timezone: 'UTC' }),
      );
      await runCheck(check.id, { actor: currentActor(), trigger: 'demo' });
      n++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, check: c.name }, 'demo access check not created');
    }
  }
  return n;
}
