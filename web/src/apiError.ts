import type { ErrorParams } from '@sm/shared';

/**
 * An error answer of the API. Its own module, so the error texts (i18n/errors.ts) can recognise it without importing
 * the request helpers in api.ts, which import the error texts in turn (no import cycle, docs/ARCHITECTURE.md).
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: { path: string; message: string }[],
    public code?: string,
    public params?: ErrorParams,
    /** The server's X-Request-Id: the reference to quote for an unexpected error */
    public requestId?: string,
  ) {
    super(message);
  }
}
