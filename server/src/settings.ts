import { DEFAULT_LOCALE, PASSWORD_LOGIN_MODES, type OutboundPolicy, type PasswordLogin, type Settings } from '@sm/shared';
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
  findingDismissFourEyes: false,
});

/** Keys used by feature modules (see readSetting); never part of the public Settings. */
const INTERNAL = [
  'notifications.',
  'maintenance.',
  'reports.',
  'monitors.',
  'vault.',
  'audit.',
  'security.',
  'theme.',
  'credentials.',
  'gatus.',
  'mcp.',
  'tickets.',
  'system.',
];

/** SM_PASSWORD_LOGIN (all | adminsOnly | none) for locked-down deployments: wins over the stored setting. */
export function passwordLoginFromEnv(): PasswordLogin | undefined {
  const v = process.env.SM_PASSWORD_LOGIN?.trim();
  return (PASSWORD_LOGIN_MODES as readonly string[]).includes(v ?? '') ? (v as PasswordLogin) : undefined;
}

/** Who may sign in with a password right now (checked at sign-in and for every session request). */
export function passwordLoginMode(): PasswordLogin {
  const env = passwordLoginFromEnv();
  if (env) return env;
  const r = db().get<{ value: string }>("SELECT value FROM settings WHERE key = 'passwordLogin'");
  try {
    const v = r ? (JSON.parse(r.value) as unknown) : 'all';
    return (PASSWORD_LOGIN_MODES as readonly unknown[]).includes(v) ? (v as PasswordLogin) : 'all';
  } catch {
    return 'all';
  }
}

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
  if (!(PASSWORD_LOGIN_MODES as readonly unknown[]).includes(s.passwordLogin)) s.passwordLogin = 'all';
  const envLogin = passwordLoginFromEnv();
  if (envLogin) s.passwordLogin = envLogin;
  s.passwordLoginFromEnv = !!envLogin;
  return s as unknown as Settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const allowed: (keyof Settings)[] = [
    'passwordLogin',
    'browserHeadless',
    'browserTimeoutMs',
    'retentionRunDays',
    'retentionNotificationDays',
    'retentionMonitorDays',
    'defaultLocale',
    'apiDocs',
    'outboundPolicy',
    'outboundAllowList',
    'findingDismissFourEyes',
  ];
  db().tx(() => {
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        db().run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(patch[k]));
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
