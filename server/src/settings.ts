import { DEFAULT_LOCALE, type OutboundPolicy, type Settings } from '@sm/shared';
import { db } from './db.js';

const DEFAULTS = (): Settings => ({
  passwordLogin: 'all',
  browserHeadless: true,
  browserTimeoutMs: 30000,
  retentionRunDays: 0,
  retentionNotificationDays: 30,
  defaultLocale: DEFAULT_LOCALE,
  retentionMonitorDays: 30,
  apiDocs: 'authenticated',
  outboundPolicy: (['platforms', 'allowList', 'open'] as const).includes(process.env.SM_OUTBOUND_POLICY as OutboundPolicy)
    ? (process.env.SM_OUTBOUND_POLICY as OutboundPolicy)
    : 'platforms',
  outboundAllowList: [],
});

/** Keys used by feature modules (see readSetting); never part of the public Settings. */
const INTERNAL = ['notifications.', 'maintenance.', 'reports.', 'monitors.', 'vault.', 'audit.', 'security.', 'theme.', 'mcp.'];

export function getSettings(): Settings {
  const rows = db().all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const s = DEFAULTS() as unknown as Record<string, unknown>;
  for (const r of rows) {
    if (INTERNAL.some((p) => r.key.startsWith(p))) continue;
    try {
      s[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore */
    }
  }
  // An explicit environment override always wins over the stored value.
  if ((['platforms', 'allowList', 'open'] as const).includes(process.env.SM_OUTBOUND_POLICY as OutboundPolicy)) {
    s.outboundPolicy = process.env.SM_OUTBOUND_POLICY;
  }
  return s as unknown as Settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const allowed: (keyof Settings)[] = ['passwordLogin', 'browserHeadless', 'browserTimeoutMs', 'retentionRunDays', 'retentionNotificationDays', 'retentionMonitorDays', 'defaultLocale', 'apiDocs', 'outboundPolicy', 'outboundAllowList'];
  db().tx(() => {
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        db().run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          k,
          JSON.stringify(patch[k]),
        );
      }
    }
  });
  return getSettings();
}

/** Internal key/value storage for feature modules (keys must start with one of INTERNAL). */
export function readSetting<T>(key: string, fallback: T): T {
  const r = db().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (!r) return fallback;
  try {
    return JSON.parse(r.value) as T;
  } catch {
    return fallback;
  }
}

export function writeSetting(key: string, value: unknown): void {
  if (!INTERNAL.some((p) => key.startsWith(p))) throw new Error(`Internal setting key must start with ${INTERNAL.join(' or ')}`);
  if (value === undefined || value === null) db().run('DELETE FROM settings WHERE key = ?', key);
  else db().run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
