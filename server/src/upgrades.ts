import { audit } from './audit.js';
import { db, PENDING_UPGRADES_KEY, type UpgradeInfo } from './db.js';
import { readSetting, writeSetting } from './settings.js';

const schema = (s: UpgradeInfo['fromSchema']) => `${s.core}+${s.named}`;

/**
 * Writes one system.upgraded audit entry per upgrade the database recorded at start-up (db.ts,
 * recordVersion). Called once the vault is open: the audit log needs its key, and the entry has to
 * come after the migrations (the audit log itself may be part of them). The records stay in the
 * database until then, so a restart before the unlock does not lose them.
 */
export function auditPendingUpgrades(): number {
  const list = readSetting<UpgradeInfo[]>(PENDING_UPGRADES_KEY, []);
  if (!Array.isArray(list) || !list.length) return 0;
  db().tx(() => {
    for (const u of list) {
      const versions = u.fromVersion && u.fromVersion !== u.toVersion ? `from ${u.fromVersion} to ${u.toVersion}` : `to ${u.toVersion}`;
      const migrations = u.migrations.length ? `${u.migrations.length} migration(s) applied` : 'no schema changes';
      audit({
        actor: 'system',
        action: 'system.upgraded',
        entityType: 'system',
        summary: `Upgraded ${versions}: ${migrations}, schema ${schema(u.fromSchema)} → ${schema(u.toSchema)}${u.backup ? `; backup before migrating: ${u.backup}` : ''}`,
        details: u,
      });
    }
    writeSetting(PENDING_UPGRADES_KEY, null);
  });
  return list.length;
}
