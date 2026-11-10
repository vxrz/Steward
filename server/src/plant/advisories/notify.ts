import { listUsers, toAuthUser } from '../../auth/users.js';
import { db } from '../../db.js';
import { t } from '../../i18n/index.js';
import { logger } from '../../log.js';
import { notify, titleName } from '../../notifications/service.js';
import { sitePermissions } from '../access.js';

/**
 * A new high or critical advisory match (counted: exact, or confirmed) at a site → its managers, through the routes of
 * the event plant.advisory_matched; quiet hours and digests apply as for every message. One message per advisory and
 * site with the assets it affects there; the site's owning teams' channels get it too.
 */
export function notifyAdvisoryMatched(
  first: { advisory_id: string; site_id: string; title: string; tracking_id: string; publisher: string; severity: string; adv_severity: string },
  matches: { asset_id: string; cvss: number | null }[],
): void {
  try {
    const site = db().get<{ id: string; name: string; acl: string }>('SELECT id, name, acl FROM plant_sites WHERE id = ?', first.site_id);
    if (!site) return;
    const recipients = listUsers().filter((u) => u.active && sitePermissions(site, toAuthUser(u)).includes('manage'));
    if (!recipients.length) return;
    const names = db()
      .all<{ id: string; name: string }>(
        `SELECT id, name FROM plant_assets WHERE id IN (${matches.map(() => '?').join(', ')})`,
        ...matches.map((m) => m.asset_id),
      )
      .map((a) => a.name)
      .sort();
    const severity = first.severity !== 'unknown' ? first.severity : first.adv_severity;
    const cvss = matches.reduce<number | null>((x, m) => (m.cvss !== null && (x === null || Number(m.cvss) > x) ? Number(m.cvss) : x), null);
    notify({
      event: 'plant.advisory_matched',
      text: (l) => ({
        title: t(l, 'advisoryMatched.title', {
          severity: t(l, `advisoryMatched.severity.${severity as 'high'}`),
          site: titleName(site.name, 60),
          id: titleName(first.tracking_id, 60),
        }),
        body: t(l, 'advisoryMatched.body', {
          count: names.length,
          title: first.title.slice(0, 300),
          id: first.tracking_id,
          publisher: first.publisher,
          site: site.name,
          assets: names.slice(0, 20).join(', ') + (names.length > 20 ? ' …' : ''),
          cvss: cvss === null ? '–' : cvss.toFixed(1),
        }),
      }),
      link: `/plant/advisories/${encodeURIComponent(first.advisory_id)}?site=${encodeURIComponent(site.id)}`,
      recipients,
      inAppKey: `advisory:${first.advisory_id}:${site.id}`,
      externalKey: `advisory:${first.advisory_id}:${site.id}`,
      data: {
        advisoryId: first.advisory_id,
        trackingId: first.tracking_id,
        site: site.id,
        severity,
        cvss,
        assets: matches.map((m) => m.asset_id).slice(0, 50),
      },
      about: { kind: 'site', id: site.id },
    });
  } catch (err) {
    logger.warn({ err, advisory: first.advisory_id }, 'could not notify about an advisory match');
  }
}
