/** Building blocks shared by the MCP tools (tools.ts) and the platform gateway (gateway.ts). */
import { z, type ZodTypeAny } from 'zod';
import type { UserInfo } from '@sm/shared';

export interface McpPrincipal {
  user: UserInfo;
  tokenId: string;
  tokenName: string;
}

export interface ToolContext {
  principal: McpPrincipal;
  signal: AbortSignal;
  ip: string;
}

/** A failure the model should see (and may correct), reported as a tool result with isError. */
export class ToolError extends Error {}

export interface ToolDef<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Whether the token owner gets this tool in tools/list (the handler checks rights again). */
  visible?: (ctx: ToolContext) => boolean;
  /** Platform gateway tools: open world (they reach another system), audited per call. */
  gateway?: boolean;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown> | unknown;
}

export const defineTool = <S extends ZodTypeAny>(t: ToolDef<S>): ToolDef => t as unknown as ToolDef;

// ---------- shared input pieces ----------

export const cursorArg = z.string().max(2000).optional().describe('Cursor from the previous result (`nextCursor`); omit for the first page');
export const limitArg = (max = 100, def = 20) => z.number().int().min(1).max(max).default(def).describe(`Page size (1–${max}, default ${def})`);
export const idArg = (what: string) => z.string().min(1).max(200).describe(what);
export const isoArg = (what: string) =>
  z
    .string()
    .max(40)
    .refine((v) => !Number.isNaN(Date.parse(v)), 'an ISO 8601 date-time, e.g. 2026-01-31T00:00:00Z')
    .optional()
    .describe(what);

// ---------- output helpers ----------

/** Long strings, big arrays and deep nesting are cut so one result stays readable and small. */
export function cap(v: unknown, opts: { maxString?: number; maxArray?: number; maxDepth?: number } = {}, depth = 0): unknown {
  const maxString = opts.maxString ?? 2000;
  const maxArray = opts.maxArray ?? 200;
  const maxDepth = opts.maxDepth ?? 8;
  if (typeof v === 'string') return v.length > maxString ? `${v.slice(0, maxString)}… [${v.length - maxString} more characters]` : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth >= maxDepth) return '[…]';
  if (Array.isArray(v)) {
    const out = v.slice(0, maxArray).map((x) => cap(x, opts, depth + 1));
    if (v.length > maxArray) out.push(`[… ${v.length - maxArray} more items]`);
    return out;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, x] of entries.slice(0, maxArray)) out[k] = cap(x, opts, depth + 1);
  if (entries.length > maxArray) out['…'] = `${entries.length - maxArray} more fields`;
  return out;
}
