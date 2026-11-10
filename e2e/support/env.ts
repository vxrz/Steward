import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared constants for the UI tests (used by the config, the global setup and the specs). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const AUTH_DIR = path.join(ROOT, 'e2e', '.auth');

export const MASTER_PASSPHRASE = 'e2e-master-passphrase';
export const DEMO_PASSWORD = 'Demo-password-1';
/**
 * The request budget per user and minute of the test servers (SM_RATE_LIMIT_PER_MINUTE; production default 600): the
 * specs running side by side share the demo users, and a page load is dozens of requests – on a loaded machine (or
 * with --repeat-each) a shared user ran into 429 and its page logged errors. Ten times the default here only; the
 * limits themselves are tested in server/test/rate-limit.test.ts, a 429 in the UI in auth.spec.ts.
 */
export const E2E_RATE_LIMIT = process.env.SM_E2E_RATE_LIMIT ?? '6000';

export const USERS = {
  admin: { username: 'admin', password: 'Admin-password-1', displayName: 'admin' },
  dana: { username: 'dana', password: DEMO_PASSWORD, displayName: 'Dana Designer' },
  olivia: { username: 'olivia', password: DEMO_PASSWORD, displayName: 'Olivia Operator' },
  adam: { username: 'adam', password: DEMO_PASSWORD, displayName: 'Adam Approver' },
  audrey: { username: 'audrey', password: DEMO_PASSWORD, displayName: 'Audrey Auditor' },
  vera: { username: 'vera', password: DEMO_PASSWORD, displayName: 'Vera Viewer' },
  stella: { username: 'stella', password: DEMO_PASSWORD, displayName: 'Stella Status' },
} as const;
export type UserKey = keyof typeof USERS;

/** Storage state (session cookie) of a user, written by the global setup. */
export const authFile = (user: UserKey) => path.join(AUTH_DIR, `${user}.json`);

/**
 * E2E_BASE_PATH=/steward runs the UI tests against Steward under a path prefix (SM_BASE_PATH) behind a
 * reverse proxy (scripts/reverse-proxy.mjs); '' (default) is the root, without a proxy.
 */
export const BASE_PATH = (() => {
  const raw = (process.env.E2E_BASE_PATH ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const p = raw.startsWith('/') ? raw : '/' + raw;
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(p)) throw new Error(`E2E_BASE_PATH: "${raw}" is not a path like /steward`);
  return p;
})();

/** Origin the tests talk to (the demo server, or the reverse proxy in front of it; port chosen in playwright.config.ts). */
export const origin = () => `http://127.0.0.1:${process.env.SM_E2E_PORT}`;
/** Base URL of Steward for the tests: origin plus base path. */
export const baseURL = () => origin() + BASE_PATH;

/** Ids of the demo processes created by POST /api/demo/setup (template file name without the number prefix). */
export const PROCESS = {
  accessReview1: 'ih-access-review-1-flag',
  privilegedReview: 'ih-privileged-access-review',
  healthCheck: 'ih-health-check',
  iemDeviceStatus: 'iem-device-status',
} as const;

/** A link as the web app renders it (href attribute): the app path below the base path. */
export const appHref = (path: string) => BASE_PATH + path;

/**
 * How the test servers start (cwd server/): from the TypeScript sources with tsx (default), or the compiled bundle
 * with SM_E2E_SERVER=dist (`npm run build` builds server/dist) – what the container image runs.
 */
export const serverArgs = (): string[] =>
  process.env.SM_E2E_SERVER === 'dist' ? ['--enable-source-maps', 'dist/index.js'] : ['--import', 'tsx', 'src/index.ts'];
