import { db } from './db.js';
import { audit } from './audit.js';
import { readSetting, writeSetting } from './settings.js';
import { Vault, vault } from './vault.js';
import { HttpError } from './util.js';

/**
 * Everything in the database that is encrypted with the vault's data key. Rotating the data key
 * re-encrypts all of it in one transaction. server/test/security-review-c.test.ts fails when a source
 * file uses the vault's encrypt() without being listed here – register new encrypted fields below.
 */
export const ENCRYPTED_COLUMNS: { table: string; id: string; column: string; file: string }[] = [
  { table: 'platforms', id: 'id', column: 'secrets', file: 'platforms/service.ts' },
  { table: 'identity_providers', id: 'id', column: 'secret', file: 'auth/sso.ts' },
  { table: 'webhook_triggers', id: 'id', column: 'secret_enc', file: 'triggers/service.ts' },
  { table: 'runs', id: 'id', column: 'sealed_inputs', file: 'engine/secret-inputs.ts' },
  { table: 'schedules', id: 'id', column: 'sealed_inputs', file: 'engine/secret-inputs.ts' },
  { table: 'monitor_gateways', id: 'id', column: 'secret_enc', file: 'monitors/gateways.ts' },
  // heartbeat checks: every check with a secret has a unique hook id
  { table: 'monitor_checks', id: 'hook_id', column: 'secret_enc', file: 'monitors/service.ts' },
  { table: 'sync_sources', id: 'id', column: 'token_enc', file: 'sync/service.ts' },
  { table: 'sync_sources', id: 'id', column: 'webhook_secret_enc', file: 'sync/service.ts' },
];
/** Settings rows of the form {blob: <encrypted>, …}. */
export const ENCRYPTED_SETTINGS: { key: string; file: string }[] = [
  { key: 'notifications.secrets', file: 'notifications/settings.ts' },
  { key: 'backup.key', file: 'backup/service.ts' },
];

export const KEY_ID_SETTING = 'vault.keyId';

/** Connects the vault to the database's record of the data key id (detects a vault.json that belongs to another database). */
export function connectVaultToDatabase(v: Vault = vault()): void {
  v.keyIdStore = {
    get: () => readSetting<string | undefined>(KEY_ID_SETTING, undefined),
    set: (id) => writeSetting(KEY_ID_SETTING, id),
  };
}

/** Changes the master passphrase; with rotateDataKey every stored secret is re-encrypted with a new data key. */
export async function changeMasterPassphrase(current: string, next: string, rotateDataKey: boolean): Promise<{ rotated: boolean; reencrypted: number }> {
  if (!vault().unlocked) throw new HttpError(423, 'Vault is locked', 'VAULT_LOCKED');
  let reencrypted = 0;
  const { rotated, keyId } = await vault().changePassphrase(
    current,
    next,
    rotateDataKey
      ? (convert, newKeyId) => {
          db().tx(() => {
            for (const c of ENCRYPTED_COLUMNS) {
              const rows = db().all<Record<string, string | null>>(`SELECT ${c.id} AS id, ${c.column} AS blob FROM ${c.table} WHERE ${c.column} IS NOT NULL`);
              for (const r of rows) {
                if (!r.blob) continue;
                db().run(`UPDATE ${c.table} SET ${c.column} = ? WHERE ${c.id} = ?`, convert(r.blob), r.id);
                reencrypted++;
              }
            }
            for (const s of ENCRYPTED_SETTINGS) {
              const v = readSetting<{ blob?: string } | null>(s.key, null);
              if (v?.blob) {
                writeSetting(s.key, { ...v, blob: convert(v.blob) });
                reencrypted++;
              }
            }
            writeSetting(KEY_ID_SETTING, newKeyId);
          });
        }
      : undefined,
  );
  audit({
    action: 'vault.passphrase_changed',
    entityType: 'vault',
    summary: rotated ? `Master passphrase changed and data key rotated (${reencrypted} secret(s) re-encrypted)` : 'Master passphrase changed',
    details: { rotated, reencrypted, keyId },
  });
  return { rotated, reencrypted };
}
