import type { DataDiscoveryMode, DataEnvironmentRule, DiscoveredElement, Platform } from '@sm/shared';
import { parseJson } from '../../util.js';
import type { DiscoverySourceRow } from '../store.js';

/**
 * What a discovery reader gets (ADR 0036 part 5): the source's settings, the platform with the secrets of the identity
 * the source names, how many elements the run may hand over (one more tells the job it was cut), and a signal that ends
 * at the run's time budget. Readers are async generators that yield elements in the order parents before children;
 * the job writes them in batches (store.upsertDiscovered) and stops reading when the limit or the budget is reached.
 * Readers only read metadata – catalogue views, SHOW statements, Kafka metadata and the Schema Registry, the stored
 * schema snapshot – never a row of a user table or a message (the statement and call allow-lists of the tests).
 */
export interface DiscoveryContext {
  source: ParsedSource;
  platform: Platform;
  secrets: Record<string, string>;
  /** Elements the run hands over at most (the job asks for one more than DATA_PRODUCT_LIMITS.elementsPerRun) */
  max: number;
  signal: AbortSignal;
  /** Something the run could not read without failing (a Schema Registry): kept on the run */
  warn: (w: DiscoveryProblem) => void;
}

/** A run's problem as the run history keeps it: an English message, and a code with params for the web app. */
export interface DiscoveryProblem {
  message: string;
  code: string;
  params?: Record<string, string | number | boolean | null>;
}

/** A failure of a reader that says what went wrong in the person's terms (the run keeps the code). */
export class DiscoveryError extends Error {
  constructor(readonly problem: DiscoveryProblem) {
    super(problem.message);
  }
}

export type DiscoveryReader = (ctx: DiscoveryContext) => AsyncGenerator<DiscoveredElement[]>;

export interface ParsedSource {
  id: string;
  name: string;
  platformId: string;
  scope: string[];
  includePrefixes: string[];
  excludePrefixes: string[];
  environmentRules: DataEnvironmentRule[];
  mode: DataDiscoveryMode | null;
  identityId: string | null;
  runAs: string;
}

export function parseSource(r: DiscoverySourceRow): ParsedSource {
  return {
    id: r.id,
    name: r.name,
    platformId: r.platform_id,
    scope: parseJson<string[]>(r.scope, []),
    includePrefixes: parseJson<string[]>(r.include_prefixes, []),
    excludePrefixes: parseJson<string[]>(r.exclude_prefixes, []),
    environmentRules: parseJson<DataEnvironmentRule[]>(r.environment_rules, []),
    mode: (r.mode as DataDiscoveryMode | null) ?? null,
    identityId: r.identity_id,
    runAs: r.run_as,
  };
}

/** A number from a catalogue cell ('' and null: unknown). */
export const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A short text from a platform (untrusted: cut, never interpreted). */
export const short = (v: string | null | undefined, n = 200): string | null => (v === null || v === undefined || v === '' ? null : String(v).slice(0, n));
