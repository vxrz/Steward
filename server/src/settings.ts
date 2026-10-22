import type { Settings } from '@sm/shared';
import { db } from './db.js';

const DEFAULTS = (): Settings => ({
  browserHeadless: true,
  browserTimeoutMs: 30000,
});

export function getSettings(): Settings {
  const rows = db().all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const s = DEFAULTS() as unknown as Record<string, unknown>;
  for (const r of rows) {
    try {
      s[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore */
    }
  }
  return s as unknown as Settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const allowed: (keyof Settings)[] = ['browserHeadless', 'browserTimeoutMs'];
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

