import { z } from 'zod';
import { RECORDING_LIMITS, boundedRecord, type PlatformRecording, type RecordingInput } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor } from '../auth/context.js';
import { require } from '../auth/permissions.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { getPlatform, getSecrets } from './service.js';
import { secretValues, type HttpResult } from './http.js';

/**
 * Recorded platform responses (#105): per platform, answers to operations (method and path, optionally matching
 * query parameters and parts of a JSON body) that a **test run** of a process or monitor uses instead of the
 * platform. Never used by real runs or dry runs.
 *
 * Recordings can hold personal data: reading them needs `use` on the platform (as a run would fetch the same data),
 * changing them `manage`. Credentials are redacted when a recording is stored: the platform's secrets and cached
 * tokens become "***", and headers that carry credentials or cookies are dropped.
 */

export const recordingInput = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
    path: z.string().trim().min(1).max(RECORDING_LIMITS.pathChars),
    query: boundedRecord(z.string().max(2000), RECORDING_LIMITS.queryKeys).optional(),
    bodyMatch: z.unknown().optional(),
    status: z.number().int().min(100).max(599),
    headers: boundedRecord(z.string().max(RECORDING_LIMITS.headerChars), RECORDING_LIMITS.headers).optional(),
    body: z.unknown().optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

/** Headers that carry credentials or session state: never stored. */
const DROPPED_HEADERS = /^(set-cookie|cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-amz-security-token)$/i;

interface Row {
  id: string;
  platform_id: string;
  method: string;
  path: string;
  query: string;
  body_match: string | null;
  status: number;
  headers: string;
  body: string | null;
  note: string;
  size: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

function toRecording(r: Row): PlatformRecording {
  return {
    id: r.id,
    platformId: r.platform_id,
    method: r.method as PlatformRecording['method'],
    path: r.path,
    query: parseJson(r.query, {}),
    bodyMatch: r.body_match === null ? null : parseJson(r.body_match, null),
    status: r.status,
    headers: parseJson(r.headers, {}),
    body: r.body === null ? null : parseJson(r.body, null),
    note: r.note,
    size: r.size,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function platformFor(id: string, perm: 'use' | 'manage', what: string) {
  const p = getPlatform(id);
  require(p.permissions, perm, what);
  return p;
}

/** Splits "/users?active=true" into the path and its query parameters (the parameters given separately win). */
export function splitPath(path: string, query: Record<string, unknown> = {}): { path: string; query: Record<string, string> } {
  const q: Record<string, string> = {};
  let p = path.trim();
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = u.pathname + u.search;
    } catch {
      /* kept as it is */
    }
  }
  const i = p.indexOf('?');
  if (i >= 0) {
    for (const [k, v] of new URLSearchParams(p.slice(i + 1))) q[k] = v;
    p = p.slice(0, i);
  }
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    q[k] = Array.isArray(v) ? v.map(String).join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return { path: p, query: q };
}

/** Replaces the platform's secrets and cached tokens by "***" in every string. */
function redactor(platformId: string): <T>(v: T) => T {
  const vals = secretValues(getSecrets(platformId)).filter((s) => s.length >= 4);
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return vals.reduce((s, sec) => (s.includes(sec) ? s.split(sec).join('***') : s), x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return <T>(v: T) => walk(v) as T;
}

function clean(platformId: string, input: z.infer<typeof recordingInput>) {
  const redact = redactor(platformId);
  const { path, query } = splitPath(input.path, input.query ?? {});
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {})
      .map(([k, v]) => [k.toLowerCase(), v] as const)
      .filter(([k]) => !DROPPED_HEADERS.test(k)),
  );
  const body = input.body === undefined ? null : JSON.stringify(redact(input.body));
  const bodyMatch = input.bodyMatch === undefined || input.bodyMatch === null ? null : JSON.stringify(input.bodyMatch);
  const size = (body?.length ?? 0) + JSON.stringify(headers).length;
  if ((body?.length ?? 0) > RECORDING_LIMITS.bodyBytes)
    throw new HttpError(413, `The recorded body is larger than ${RECORDING_LIMITS.bodyBytes / 1024 / 1024} MB`, 'RECORDING_TOO_LARGE', {
      maxMb: RECORDING_LIMITS.bodyBytes / 1024 / 1024,
    });
  if ((bodyMatch?.length ?? 0) > 20_000) throw new HttpError(400, 'The body to match is too large', 'RECORDING_MATCH_TOO_LARGE');
  return {
    method: input.method,
    path,
    query: JSON.stringify(query),
    bodyMatch,
    status: input.status,
    headers: JSON.stringify(redact(headers)),
    body,
    note: input.note ?? '',
    size,
  };
}

export function listRecordings(platformId: string): PlatformRecording[] {
  platformFor(platformId, 'use', 'see the recorded responses of this platform');
  return db().all<Row>('SELECT * FROM platform_recordings WHERE platform_id = ? ORDER BY path, method, created_at', platformId).map(toRecording);
}

function getRow(platformId: string, id: string): Row {
  const r = db().get<Row>('SELECT * FROM platform_recordings WHERE id = ? AND platform_id = ?', id, platformId);
  if (!r) throw new HttpError(404, `Recorded response ${id} not found`, 'RECORDING_NOT_FOUND');
  return r;
}

const label = (r: { method: string; path: string; query: string | Record<string, string> }) => {
  const q = typeof r.query === 'string' ? parseJson<Record<string, string>>(r.query, {}) : r.query;
  const qs = new URLSearchParams(q).toString();
  return `${r.method} ${r.path}${qs ? `?${qs}` : ''}`;
};

export function createRecording(platformId: string, input: RecordingInput | z.infer<typeof recordingInput>): PlatformRecording {
  const p = platformFor(platformId, 'manage', 'record responses of this platform');
  const n = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM platform_recordings WHERE platform_id = ?', platformId)?.n ?? 0;
  if (n >= RECORDING_LIMITS.perPlatform)
    throw new HttpError(409, `A platform keeps at most ${RECORDING_LIMITS.perPlatform} recorded responses`, 'RECORDING_LIMIT', {
      max: RECORDING_LIMITS.perPlatform,
    });
  const c = clean(platformId, recordingInput.parse(input));
  const id = newId('rec_');
  const now = nowIso();
  const actor = currentActor();
  db().run(
    `INSERT INTO platform_recordings (id, platform_id, method, path, query, body_match, status, headers, body, note, size, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    platformId,
    c.method,
    c.path,
    c.query,
    c.bodyMatch,
    c.status,
    c.headers,
    c.body,
    c.note,
    c.size,
    now,
    actor,
    now,
    actor,
  );
  audit({
    action: 'platform.recording_added',
    entityType: 'platform',
    entityId: platformId,
    summary: `Recorded response ${label(c)} → HTTP ${c.status} added to "${p.name}" (${c.size} bytes)`,
    details: { recordingId: id, method: c.method, path: c.path, query: JSON.parse(c.query), status: c.status, size: c.size },
  });
  return toRecording(getRow(platformId, id));
}

export function updateRecording(platformId: string, id: string, input: z.infer<typeof recordingInput>): PlatformRecording {
  const p = platformFor(platformId, 'manage', 'change the recorded responses of this platform');
  getRow(platformId, id);
  const c = clean(platformId, recordingInput.parse(input));
  db().run(
    `UPDATE platform_recordings SET method = ?, path = ?, query = ?, body_match = ?, status = ?, headers = ?, body = ?, note = ?, size = ?, updated_at = ?, updated_by = ?
     WHERE id = ? AND platform_id = ?`,
    c.method,
    c.path,
    c.query,
    c.bodyMatch,
    c.status,
    c.headers,
    c.body,
    c.note,
    c.size,
    nowIso(),
    currentActor(),
    id,
    platformId,
  );
  audit({
    action: 'platform.recording_changed',
    entityType: 'platform',
    entityId: platformId,
    summary: `Recorded response ${label(c)} → HTTP ${c.status} of "${p.name}" changed`,
    details: { recordingId: id, method: c.method, path: c.path, status: c.status, size: c.size },
  });
  return toRecording(getRow(platformId, id));
}

export function deleteRecording(platformId: string, id: string): void {
  const p = platformFor(platformId, 'manage', 'remove recorded responses of this platform');
  const r = getRow(platformId, id);
  db().run('DELETE FROM platform_recordings WHERE id = ? AND platform_id = ?', id, platformId);
  audit({
    action: 'platform.recording_removed',
    entityType: 'platform',
    entityId: platformId,
    summary: `Recorded response ${label(r)} removed from "${p.name}"`,
    details: { recordingId: id, method: r.method, path: r.path },
  });
}

// ---------- matching ----------

/** `{name}` matches one path segment, a trailing `*` the rest of the path. */
function pathScore(pattern: string, path: string): number | null {
  const a = pattern.split('/');
  const b = path.split('/');
  let score = 0;
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    if (seg === '*' && i === a.length - 1) return b.length >= a.length - 1 ? score : null;
    if (i >= b.length) return null;
    if (/^\{[^/{}]+\}$/.test(seg)) continue;
    if (seg !== b[i]) return null;
    score += 2;
  }
  return a.length === b.length ? score + 1 : null;
}

/** Every key and value of `want` is in `have` (objects recursively, arrays by position). */
function contains(have: unknown, want: unknown): boolean {
  if (want === null || typeof want !== 'object') return have === want;
  if (Array.isArray(want)) return Array.isArray(have) && want.every((w, i) => contains(have[i], w));
  if (!have || typeof have !== 'object') return false;
  return Object.entries(want as Record<string, unknown>).every(([k, v]) => contains((have as Record<string, unknown>)[k], v));
}

export interface RecordedAnswer {
  recordingId: string;
  result: HttpResult;
}

/**
 * The recorded response for a request, or null. When several fit, the most specific wins: more literal path segments,
 * then more query parameters, then a body to match, then the newest.
 */
export function findRecording(
  platformId: string,
  req: { method: string; url: string; query?: Record<string, unknown>; body?: unknown },
): RecordedAnswer | null {
  const { path, query } = splitPath(req.url, req.query ?? {});
  const method = req.method.toUpperCase();
  let best: { row: Row; score: number } | null = null;
  for (const row of db().all<Row>('SELECT * FROM platform_recordings WHERE platform_id = ? AND method = ? ORDER BY updated_at DESC', platformId, method)) {
    const ps = pathScore(row.path, path);
    if (ps === null) continue;
    const want = parseJson<Record<string, string>>(row.query, {});
    if (!Object.entries(want).every(([k, v]) => query[k] === v)) continue;
    const match = row.body_match === null ? undefined : parseJson<unknown>(row.body_match, undefined);
    if (match !== undefined && !contains(req.body, match)) continue;
    const score = ps * 1000 + Object.keys(want).length * 10 + (match !== undefined ? 5 : 0);
    if (!best || score > best.score) best = { row, score };
  }
  if (!best) return null;
  const r = best.row;
  return {
    recordingId: r.id,
    result: {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      url: label({ method: r.method, path, query }).slice(method.length + 1),
      headers: parseJson(r.headers, {}),
      body: r.body === null ? null : parseJson(r.body, null),
      durationMs: 0,
    },
  };
}

/** The error a test run reports for a call without a recording. */
export function missingRecording(platformName: string, method: string, url: string, query?: Record<string, unknown>): Error {
  const { path, query: q } = splitPath(url, query ?? {});
  const qs = new URLSearchParams(q).toString();
  return Object.assign(
    new Error(
      `Test run: no recorded response for ${method.toUpperCase()} ${path}${qs ? `?${qs}` : ''} on "${platformName}" – record one under Platforms → ${platformName} → Recorded responses`,
    ),
    { retryable: false, code: 'RECORDING_MISSING' },
  );
}
