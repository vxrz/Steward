import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared constants for the UI tests (used by the config, the global setup and the specs). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const AUTH_DIR = path.join(ROOT, 'e2e', '.auth');

export const MASTER_PASSPHRASE = 'e2e-master-passphrase';
export const DEMO_PASSWORD = 'Demo-password-1';

export const USERS = {
  admin: { username: 'admin', password: 'Admin-password-1', displayName: 'admin' },
  dana: { username: 'dana', password: DEMO_PASSWORD, displayName: 'Dana Designer' },
  olivia: { username: 'olivia', password: DEMO_PASSWORD, displayName: 'Olivia Operator' },
  adam: { username: 'adam', password: DEMO_PASSWORD, displayName: 'Adam Approver' },
  audrey: { username: 'audrey', password: DEMO_PASSWORD, displayName: 'Audrey Auditor' },
  vera: { username: 'vera', password: DEMO_PASSWORD, displayName: 'Vera Viewer' },
} as const;
export type UserKey = keyof typeof USERS;

/** Storage state (session cookie) of a user, written by the global setup. */
export const authFile = (user: UserKey) => path.join(AUTH_DIR, `${user}.json`);

/** Base URL of the demo server started by the global setup (port chosen in playwright.config.ts). */
export const baseURL = () => `http://127.0.0.1:${process.env.SM_E2E_PORT}`;

/** Ids of the demo processes created by POST /api/demo/setup (template file name without the number prefix). */
export const PROCESS = {
  accessReview1: 'ih-access-review-1-flag',
  privilegedReview: 'ih-privileged-access-review',
  healthCheck: 'ih-health-check',
  iemDeviceStatus: 'iem-device-status',
} as const;
