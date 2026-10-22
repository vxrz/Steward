import { getSecrets, listPlatforms } from './service.js';
import { resolveBaseUrl } from './http.js';
import type { OutboundContext } from './outbound.js';

/**
 * The server-wide outbound-policy context: every configured platform and how to
 * resolve its effective base-URL origin. Shared by the process engine, the
 * monitors feature and the OpenAPI-by-URL import so they enforce one policy.
 */
export function outboundContext(): OutboundContext {
  return {
    platforms: () => listPlatforms(),
    resolveOrigin: (p) => resolveBaseUrl(p, getSecrets(p.id)),
  };
}
