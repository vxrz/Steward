import { z } from 'zod';
import { boundedRecord } from '@sm/shared';

/** The file format of a template bundle (examples/bundles/*.yaml, v0.4.0) – also used by `npm run validate`. */

const KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** Five fields separated by blanks (the scheduler checks the expression itself) */
const fiveFields = (s: string) => s.split(/\s+/).filter(Boolean).length === 5;

export const bundleFileSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5000).default(''),
    tags: z.array(z.string().max(60)).max(20).default([]),
    platforms: z
      .array(
        z
          .object({
            key: z.string().regex(KEY_RE, 'a key of lower-case letters, digits and -'),
            label: z.string().trim().min(1).max(100),
            kinds: z.array(z.string().min(1).max(64)).min(1).max(10),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    processes: z
      .array(
        z
          .object({
            template: z.string().min(1).max(200),
            /** A cron expression, or "none"; default: the template's recommended schedule */
            schedule: z.string().trim().max(100).optional(),
            /** slot → bundle platform key; default: the bundle platform whose kinds fit the slot */
            connections: boundedRecord(z.string().max(40), 20).optional(),
            /** Inputs of the schedule and the dry run (the template's defaults otherwise) */
            inputs: boundedRecord(z.unknown(), 100).optional(),
            /** One dry run after the setup (default true) */
            dryRun: z.boolean().default(true),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    dashboards: z.array(z.string().min(1).max(200)).max(10).default([]),
    monitors: z
      .array(z.object({ file: z.string().min(1).max(200), optional: z.boolean().default(true) }).strict())
      .max(10)
      .default([]),
  })
  .strict()
  .superRefine((b, ctx) => {
    const keys = b.platforms.map((p) => p.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['platforms'], message: 'Platform keys must be unique' });
    b.processes.forEach((p, i) => {
      if (p.schedule && p.schedule !== 'none' && !fiveFields(p.schedule))
        ctx.addIssue({ code: 'custom', path: ['processes', i, 'schedule'], message: 'A cron expression with five fields, or "none"' });
      for (const [slot, key] of Object.entries(p.connections ?? {}))
        if (!keys.includes(key)) ctx.addIssue({ code: 'custom', path: ['processes', i, 'connections', slot], message: `No bundle platform "${key}"` });
    });
  });
export type BundleFile = z.infer<typeof bundleFileSchema>;

/** A template bundle file: has `platforms` and `processes` and no process steps (for the validator and Git sync). */
export const looksLikeBundle = (o: unknown): boolean =>
  !!o &&
  typeof o === 'object' &&
  Array.isArray((o as Record<string, unknown>).platforms) &&
  Array.isArray((o as Record<string, unknown>).processes) &&
  !('nodes' in o) &&
  !('steps' in o);
