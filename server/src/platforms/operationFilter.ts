/**
 * The operation filter of a platform identity (0.13.0, ADR 0009 step 3): which operations of the platform's API
 * specifications a request through the identity may call.
 *
 * - Presets: read (every GET and HEAD of the current specs, plus chosen extras) and chosen (operations picked one by one).
 *   No filter (null) allows every operation.
 * - A reference names the spec's own path (`specId`, `method`, `specPath`), so a new path prefix or a replaced spec
 *   (same id) follows. A reference that no longer resolves is stale: it matches nothing (fail closed).
 * - Matching: the final URL's origin must be the base URL's and its path must lie below the base URL's path. The rest is
 *   split into decoded segments (undecodable segments, an encoded "/" or "\\", ";" path parameters and dot segments are
 *   refused). `{param}` matches one non-empty segment; literals compare case-insensitively. Of all operations of the
 *   specs (allowed or not) with the request's method (HEAD counts as GET), the most specific matching one decides – most
 *   literal segments; on a tie every tied operation must be allowed. A request that matches no operation is refused.
 * - The filter sees method and path, never query or body.
 */
import type { ApiOperation, IdentityOperationFilter, IdentityOperationRef } from '@sm/shared';

export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** The method as matched: upper case, HEAD as GET. */
const normMethod = (m: string) => {
  const u = m.trim().toUpperCase();
  return u === 'HEAD' ? 'GET' : u;
};

/** The spec's own path of an operation (listOperations puts the effective path in `path` and the spec's in `specPath` when they differ). */
export const specPathOf = (o: ApiOperation): string => o.specPath ?? o.path;

/** The operation a reference names in the platform's current operations, or null (stale). */
export function resolveOperationRef(ref: IdentityOperationRef, ops: readonly ApiOperation[]): ApiOperation | null {
  const m = ref.method.trim().toUpperCase();
  return ops.find((o) => o.specId === ref.specId && o.method.toUpperCase() === m && specPathOf(o) === ref.specPath) ?? null;
}

/** The references of a filter that no longer resolve. */
export function staleRefs(filter: IdentityOperationFilter | null | undefined, ops: readonly ApiOperation[]): IdentityOperationRef[] {
  if (!filter) return [];
  return filter.operations.filter((r) => !resolveOperationRef(r, ops));
}

/** The reference of an operation (for a filter). */
export const refOf = (o: ApiOperation): IdentityOperationRef => ({
  specId: o.specId,
  method: o.method.toUpperCase(),
  specPath: specPathOf(o),
  ...(o.operationId ? { operationId: o.operationId } : {}),
});

/** The operations a filter allows (of the platform's current operations). */
export function allowedOperations(filter: IdentityOperationFilter, ops: readonly ApiOperation[]): Set<ApiOperation> {
  const out = new Set<ApiOperation>();
  if (filter.preset === 'read') for (const o of ops) if (SAFE_METHODS.has(o.method.toUpperCase())) out.add(o);
  for (const r of filter.operations) {
    const o = resolveOperationRef(r, ops);
    if (o) out.add(o);
  }
  return out;
}

/**
 * Decoded segments of a path below the base path, or null when it cannot be matched safely: a segment that cannot be
 * decoded, an encoded "/" or "\\", a ";" path parameter, or a dot segment.
 */
export function decodedSegments(path: string): string[] | null {
  const out: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '') continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg.includes('/') || seg.includes('\\') || seg.includes(';') || seg === '.' || seg === '..' || seg.includes('\u0000')) return null;
    out.push(seg);
  }
  return out;
}

/** The path of `url` below the base URL (origin equal, path under the base path), or null. */
export function pathBelowBase(url: string, baseUrl: string): string | null {
  let u: URL;
  let b: URL;
  try {
    u = new URL(url);
    b = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.origin !== b.origin) return null;
  const base = b.pathname.replace(/\/+$/, '');
  if (base && u.pathname !== base && !u.pathname.startsWith(base + '/')) return null;
  return u.pathname.slice(base.length) || '/';
}

/** Segments of an operation's template ({param} as null). */
function templateSegments(path: string): (string | null)[] {
  return path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (/^\{[^}]+\}$/.test(s) ? null : s));
}

/** How specifically a template matches the segments: the number of literal segments, or null (no match). */
function score(template: (string | null)[], segs: string[]): number | null {
  if (template.length !== segs.length) return null;
  let literals = 0;
  for (let i = 0; i < segs.length; i++) {
    const t = template[i];
    if (t === null || t === undefined) {
      if (!segs[i]) return null;
      continue;
    }
    if (t.toLowerCase() !== segs[i]!.toLowerCase()) return null;
    literals++;
  }
  return literals;
}

export interface FilterDecision {
  allowed: boolean;
  /** The operation that decided ("METHOD /path"), or the closest one when none matched */
  operation: string | null;
  /** No operation of the specs matches the request at all */
  unmatched: boolean;
}

/**
 * Whether a request (method, path below the base URL) may go through a filter. `ops`: every operation of the platform's
 * specs; `allowed`: the ones the filter allows.
 */
export function decide(method: string, relPath: string | null, ops: readonly ApiOperation[], allowed: ReadonlySet<ApiOperation>): FilterDecision {
  const segs = relPath === null ? null : decodedSegments(relPath);
  if (!segs) return { allowed: false, operation: null, unmatched: true };
  const m = normMethod(method);
  let best = -1;
  let tied: ApiOperation[] = [];
  for (const o of ops) {
    if (normMethod(o.method) !== m) continue;
    const s = score(templateSegments(o.path), segs);
    if (s === null) continue;
    if (s > best) {
      best = s;
      tied = [o];
    } else if (s === best) tied.push(o);
  }
  if (!tied.length) {
    // the closest operation, for the message: the same path with another method, else nothing
    const other = ops.find((o) => score(templateSegments(o.path), segs) !== null);
    return { allowed: false, operation: other ? `${other.method.toUpperCase()} ${other.path}` : null, unmatched: true };
  }
  const first = tied[0]!;
  return { allowed: tied.every((o) => allowed.has(o)), operation: `${first.method.toUpperCase()} ${first.path}`, unmatched: false };
}

/** A filter given by a client, cleaned: preset, at most 2000 references with plain fields. */
export function cleanFilter(input: unknown): IdentityOperationFilter | null {
  if (input === null || input === undefined) return null;
  const f = input as { preset?: unknown; operations?: unknown };
  if (f.preset !== 'read' && f.preset !== 'chosen') return null;
  const ops = Array.isArray(f.operations) ? f.operations : [];
  const seen = new Set<string>();
  const out: IdentityOperationRef[] = [];
  for (const raw of ops.slice(0, 2000)) {
    const r = raw as Partial<IdentityOperationRef>;
    if (typeof r?.specId !== 'string' || typeof r.method !== 'string' || typeof r.specPath !== 'string') continue;
    const ref: IdentityOperationRef = {
      specId: r.specId.slice(0, 64),
      method: r.method.trim().toUpperCase().slice(0, 10),
      specPath: r.specPath.slice(0, 2000),
      ...(typeof r.operationId === 'string' && r.operationId ? { operationId: r.operationId.slice(0, 300) } : {}),
    };
    const key = `${ref.specId} ${ref.method} ${ref.specPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return { preset: f.preset, operations: out };
}

/**
 * Whether `next` allows anything `before` did not (a loosening needs a step-up, ADR 0009): no filter allows everything;
 * read covers every GET/HEAD. Compared on the current operations.
 */
export function filterWidens(before: IdentityOperationFilter | null, next: IdentityOperationFilter | null, ops: readonly ApiOperation[]): boolean {
  if (!before) return false;
  if (!next) return true;
  const a = allowedOperations(before, ops);
  const b = allowedOperations(next, ops);
  for (const o of b) if (!a.has(o)) return true;
  // references that do not resolve now could resolve later: new stale references widen too
  const key = (r: IdentityOperationRef) => `${r.specId} ${r.method} ${r.specPath}`;
  const had = new Set(before.operations.map(key));
  if (next.preset === 'read' && before.preset === 'chosen') return true;
  return next.operations.some((r) => !had.has(key(r)) && !resolveOperationRef(r, ops));
}
