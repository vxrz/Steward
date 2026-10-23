// Only what errorReporting.ts uses, so the lazily loaded chunk stays small (tree-shaking; no replay/tracing/feedback code).
export {
  init,
  captureException,
  eventFiltersIntegration,
  functionToStringIntegration,
  browserApiErrorsIntegration,
  breadcrumbsIntegration,
  globalHandlersIntegration,
  linkedErrorsIntegration,
  dedupeIntegration,
  httpContextIntegration,
} from '@sentry/react';
