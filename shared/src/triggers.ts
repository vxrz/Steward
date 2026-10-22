/**
 * Webhook triggers: an inbound URL plus a secret that starts a chosen process,
 * with the process inputs mapped from the request (e.g. a Gatus alert).
 */

/**
 * How a caller proves it knows the secret:
 * - `token`: static header `Authorization: Bearer <secret>` or `X-Steward-Token: <secret>`
 * - `hmac`: `X-Steward-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>`
 * - `either`: one of the two
 */
export const WEBHOOK_AUTH_MODES = ['token', 'hmac', 'either'] as const;
export type WebhookAuthMode = (typeof WEBHOOK_AUTH_MODES)[number];

/** Request headers that can never be mapped into inputs (they carry credentials). */
export const WEBHOOK_FORBIDDEN_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-steward-token',
  'x-steward-signature',
  'x-steward-test',
] as const;

/** Largest accepted request body (bytes). */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

export interface WebhookTriggerSettings {
  name: string;
  description?: string;
  processId: string;
  /** Pin a process version; null/undefined = always the current version. */
  processVersion?: number | null;
  enabled: boolean;
  dryRun: boolean;
  /** Process input name → JSONata expression over `{ body, headers, query }`. */
  inputMapping: Record<string, string>;
  /** Connection slot → platform id (as for schedules). */
  bindings: Record<string, string>;
  authMode: WebhookAuthMode;
  /** Source addresses allowed to call the hook (IP or CIDR, IPv4/IPv6). Empty = any. */
  allowedCidrs: string[];
  /** Request headers (lower case) made available to the mapping as `headers.<name>`. */
  allowedHeaders: string[];
  /** Accepted calls per minute (1–600). */
  rateLimitPerMinute: number;
  /** Identical payloads within this many seconds are ignored (0 = off). */
  dedupeSeconds: number;
  /** Skip while the previous run of this trigger is still running or waiting. */
  skipIfRunning: boolean;
}

export interface WebhookTrigger extends WebhookTriggerSettings {
  id: string;
  processName?: string;
  /** Runs execute with the rights of this user. */
  owner: string;
  /** Path of the inbound URL, e.g. /api/hooks/wht_… */
  path: string;
  /** First characters of the secret, to tell secrets apart (the secret itself is never returned). */
  secretPrefix: string;
  secretRotatedAt: string;
  createdAt: string;
  updatedAt: string;
  lastFiredAt: string | null;
  lastRunId: string | null;
  lastRunStatus: string | null;
  /** started / skipped: … / failed: … */
  lastResult: string | null;
  fireCount: number;
  rejectedCount: number;
  lastRejectedAt: string | null;
  lastRejectedReason: string | null;
  canEdit: boolean;
}

/** Returned once on creation and on rotation. */
export interface WebhookTriggerSecret {
  trigger: WebhookTrigger;
  secret: string;
}

export interface WebhookFire {
  id: number;
  ts: string;
  sourceIp: string;
  payloadHash: string;
  outcome: 'started' | 'skipped' | 'failed';
  reason: string | null;
  runId: string | null;
  test: boolean;
}

export interface WebhookMappingPreview {
  inputs: Record<string, unknown>;
  errors: Record<string, string>;
}

export interface WebhookTestResult {
  status: number;
  response: { runId?: string; skipped?: string; error?: string };
  inputs: Record<string, unknown>;
}
