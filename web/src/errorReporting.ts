/**
 * Browser error reporting to a Sentry-compatible service. Off unless the server
 * hands out a DSN (GET /api/client-config, from SM_SENTRY_DSN / SM_SENTRY_DSN_WEB),
 * so one build works everywhere. The SDK is a separate chunk that is only
 * downloaded when reporting is on. Events are scrubbed with the same rules as on
 * the server (@sm/shared scrubEvent); no session replay, no tracing, no sessions.
 */
import { scrubBreadcrumb, scrubEvent, type ClientConfig } from '@sm/shared';

type SentryReact = typeof import('./sentry');

let sdk: SentryReact | undefined;
let off = false;
/** Errors that happen before the SDK is loaded (sent once it is, dropped when reporting is off). */
const early: { error: unknown; componentStack?: string }[] = [];
const MAX_EARLY = 10;

function remember(error: unknown, componentStack?: string) {
  if (!off && early.length < MAX_EARLY) early.push({ error, componentStack });
}
const onError = (e: ErrorEvent) => remember(e.error ?? e.message);
const onRejection = (e: PromiseRejectionEvent) => remember(e.reason);

/** Reports an error caught by an error boundary (or elsewhere). No-op when reporting is off. */
export function reportError(error: unknown, componentStack?: string): void {
  if (sdk) {
    sdk.captureException(error, componentStack ? { contexts: { react: { componentStack } } } : undefined);
  } else remember(error, componentStack);
}

export async function initErrorReporting(): Promise<void> {
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  try {
    const res = await fetch('/api/client-config', { credentials: 'same-origin' });
    const cfg = res.ok ? ((await res.json()) as ClientConfig) : null;
    const er = cfg?.errorReporting;
    if (!er?.dsn) throw new Error('off');
    const Sentry = await import('./sentry');
    Sentry.init({
      dsn: er.dsn,
      environment: er.environment,
      release: er.release,
      sendDefaultPii: false,
      // explicit list: no console breadcrumbs, no session replay, no tracing, no release-health sessions
      defaultIntegrations: false,
      integrations: [
        Sentry.eventFiltersIntegration(),
        Sentry.functionToStringIntegration(),
        Sentry.browserApiErrorsIntegration(),
        Sentry.breadcrumbsIntegration({ console: false, dom: true, fetch: true, history: true, xhr: true, sentry: false }),
        Sentry.globalHandlersIntegration(),
        Sentry.linkedErrorsIntegration(),
        Sentry.dedupeIntegration(),
        Sentry.httpContextIntegration(),
      ],
      maxBreadcrumbs: 30,
      beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
      beforeSend: (event) => scrubEvent(event),
    });
    sdk = Sentry;
    for (const e of early.splice(0)) reportError(e.error, e.componentStack);
  } catch {
    off = true;
    early.length = 0;
  } finally {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  }
}
