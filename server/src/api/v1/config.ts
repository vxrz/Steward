import { API_DOCS_MODES, type ApiDocsMode, type PublicApiStatus } from '@sm/shared';
import { getSettings } from '../../settings.js';
import { env } from '../../config.js';

/** Semantic version of the public API description (info.version). Bump minor for additive changes. */
export const API_VERSION = '1.1.0';
/** Mount points */
export const API_BASE = '/api/v1';
export const DOCS_BASE = '/api/docs';
export const DEFAULT_RATE_LIMIT = 600;

/** SM_API_V1=off turns the public API (and its documentation) off. Default: on. */
export function apiEnabled(): boolean {
  return env.SM_API_V1;
}

/**
 * Who may open the documentation (Swagger UI, OpenAPI document without a token):
 * SM_API_DOCS overrides the admin setting; an unknown value counts as "off".
 */
export function docsMode(): { mode: ApiDocsMode; source: 'env' | 'settings' } {
  if (!apiEnabled()) return { mode: 'off', source: 'env' };
  if (env.SM_API_DOCS) return { mode: env.SM_API_DOCS, source: 'env' };
  let mode: ApiDocsMode = 'authenticated';
  try {
    const s = getSettings().apiDocs;
    if ((API_DOCS_MODES as readonly string[]).includes(s)) mode = s;
  } catch {
    /* database not ready */
  }
  return { mode, source: 'settings' };
}

/** Requests per minute and token (SM_API_RATE_LIMIT, default 600; 0 or "off" = unlimited). */
export function rateLimitPerMinute(): number {
  return env.SM_API_RATE_LIMIT;
}

let docsUiAvailable = false;
/** Set when the Swagger UI assets were found and the page is registered. */
export function setDocsUiAvailable(v: boolean): void {
  docsUiAvailable = v;
}

/** Effective configuration for the web UI (the caller is signed in). */
export function publicApiStatus(): PublicApiStatus {
  const enabled = apiEnabled();
  const docs = docsMode();
  return {
    enabled,
    basePath: API_BASE,
    docs: docs.mode,
    docsSource: docs.source,
    docsUrl: enabled && docs.mode !== 'off' && docsUiAvailable ? `${DOCS_BASE}/` : null,
    rateLimitPerMinute: rateLimitPerMinute(),
    apiVersion: API_VERSION,
  };
}
