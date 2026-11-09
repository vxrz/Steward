/**
 * Webhook triggers: an inbound URL plus a secret that starts a chosen process,
 * with the process inputs mapped from the request (e.g. a Gatus alert).
 */

import { z } from 'zod';
import type { ScheduleNotify } from './notifyPolicy.js';
import { boundedRecord } from './zodLimits.js';

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
  /** Connection slot → identity id (0.13.0, ADR 0009); a missing slot uses the platform's default identity. */
  identities?: Record<string, string>;
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
  /** Messages of its runs (#139); missing in input: unchanged (new triggers: after every run). `pause` has its own actions. */
  notify?: ScheduleNotify;
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

// ---------- example triggers (examples/triggers, 0.9.0) ----------

/**
 * An example webhook trigger (examples/triggers/*.yaml, #242): which process template it starts, the input mapping for
 * the sender's payload, a sample payload for the preview and the test call, and how to set up the sender (its URL
 * with the placeholders {post} – post or posts, as Steward's address is http or https –, {hostPath} – host and path of
 * the hook – and {secret}, and the body it sends). The trigger editor offers the mapping when the chosen process has
 * the inputs; the secret dialog shows the sender's setup with the real URL and secret.
 */
export const WEBHOOK_TRIGGER_EXAMPLE_KIND = 'webhookTrigger';
export const webhookTriggerExampleSchema = z
  .object({
    kind: z.literal(WEBHOOK_TRIGGER_EXAMPLE_KIND),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(5000).default(''),
    /** The process template it starts: a file name of examples/processes without .yaml */
    process: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, 'a template file name without .yaml, e.g. 76-changedetection-review-change'),
    authMode: z.enum(WEBHOOK_AUTH_MODES).default('token'),
    dedupeSeconds: z.number().int().min(0).max(86400).default(60),
    skipIfRunning: z.boolean().default(true),
    rateLimitPerMinute: z.number().int().min(1).max(600).default(30),
    /** Process input → JSONata over { body, headers, query } */
    inputMapping: boundedRecord(z.string().min(1).max(2000), 100),
    samplePayload: boundedRecord(z.unknown(), 100).default({}),
    sender: z
      .object({
        name: z.string().trim().min(1).max(100),
        url: z.string().max(500).optional(),
        body: z.string().max(4000).optional(),
        docs: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WebhookTriggerExampleFile = z.infer<typeof webhookTriggerExampleSchema>;

/** An example trigger as the trigger editor gets it. */
export interface WebhookTriggerExample extends WebhookTriggerExampleFile {
  /** Its file name (without .yaml) */
  id: string;
  /** The name of the process template (when it exists) */
  processName: string | null;
}
