import type { BuildInfo } from '../../shared/src/system';

// Replaced at build time (web/vite.config.ts → define).
declare const __SM_VERSION__: string;
declare const __SM_BUILD_COMMIT__: string | null;
declare const __SM_BUILD_DATE__: string | null;

/** Version and build of this web UI bundle (commit/date null = development build). */
export const WEB_BUILD: BuildInfo = {
  version: typeof __SM_VERSION__ === 'string' ? __SM_VERSION__ : '0.0.0',
  commit: typeof __SM_BUILD_COMMIT__ === 'string' && __SM_BUILD_COMMIT__ ? __SM_BUILD_COMMIT__ : null,
  date: typeof __SM_BUILD_DATE__ === 'string' && import.meta.env.PROD ? __SM_BUILD_DATE__ : null,
};

/** "a1b2c3d4e5f6" (12 characters) or null */
export const shortCommit = (commit: string | null | undefined): string | null => (commit ? commit.slice(0, 12) : null);
