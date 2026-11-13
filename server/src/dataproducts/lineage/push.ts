import { DATA_LINEAGE_LIMITS as LL, DATA_LINEAGE_TOKEN_PREFIX, type DataLineageImport } from '@sm/shared';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import { logger } from '../../log.js';
import { readCookie, SESSION_COOKIE } from '../../auth/cookies.js';
import { findUserByName, toAuthUser } from '../../auth/users.js';
import { runAs } from '../../auth/context.js';
import { moduleEnabled } from '../../modules/registry.js';
import { addressAllowed } from '../../triggers/service.js';
import { HttpError, nowIso, parseJson, sha256 } from '../../util.js';
import { applyOlEvents, parseOlPush } from './openlineage.js';
import { importManifest, importRunResults } from './dbt.js';
import { creatorMayPush, tokenExpired, type LineageTokenRow } from './sources.js';
import { lineageSourceRow, type LineageSourceRow } from './store.js';

/**
 * The push endpoint of lineage sources (ADR 0036 security notes: "OpenLineage pushes come in with hashed push tokens,
 * allowed addresses, rate limits and size limits checked from the headers before the body is read"):
 *
 *   POST /api/hooks/data-lineage/<sourceId>                  OpenLineage event(s) (an `openlineage` source)
 *   POST /api/hooks/data-lineage/<sourceId>/api/v1/lineage   the same, for clients that append their default endpoint
 *   POST /api/hooks/data-lineage/<sourceId>/dbt/manifest     manifest.json (a `dbt` source)
 *   POST /api/hooks/data-lineage/<sourceId>/dbt/run-results  run_results.json (a `dbt` source)
 *
 * Machine to machine with the source's push token only (`Authorization: Bearer sdl_…`): no session, no API token (they
 * carry a person's rights – a push token can do nothing but push to its source). Everything that needs only the headers
 * is checked before the body is read: the module is on, the token (hash, not revoked or expired, of this source, its
 * creator still active and allowed to manage the source), the address, the rate limit, the content type and the length.
 * Refusals after that – a body that is no event, too many datasets – count on the source (`refused`, the last error).
 */

export interface PushHead {
  sourceId: string;
  contentType: string | undefined;
  contentLength: number | null;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  /** What the path takes: OpenLineage events or a dbt file */
  file: 'openlineage' | 'manifest' | 'runResults';
}
export interface PushResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}
export interface VerifiedLineageToken {
  id: string;
  name: string;
  sourceId: string;
  createdBy: string;
}

const header = (h: PushHead['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** One answer for every token that does not open this source: unknown, revoked, expired, of another source, another address. */
export const REFUSED: PushResponse = {
  status: 401,
  body: { error: 'Invalid push token for this lineage source', code: 'DATA_LINEAGE_TOKEN_INVALID' },
  headers: { 'www-authenticate': 'Bearer realm="Steward data lineage"' },
};

const NOT_FOUND: PushResponse = { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };

const calls = new Map<string, number[]>();
export function resetLineagePushState(): void {
  calls.clear();
}

/** The largest body a path takes. */
export const pushLimit = (file: PushHead['file']): number =>
  file === 'manifest' ? LL.manifestBytes : file === 'runResults' ? LL.runResultsBytes : LL.eventBytes;

/** Everything that needs only the headers; runs before the body is read. */
export function authorizeLineagePush(req: PushHead): { ok: true; token: VerifiedLineageToken } | { ok: false; res: PushResponse } {
  const no = (res: PushResponse) => ({ ok: false as const, res });
  // a switched-off module: as if the address did not exist
  if (!moduleEnabled('dataProducts')) return no(NOT_FOUND);
  if (readCookie(header(req.headers, 'cookie'), SESSION_COOKIE) !== undefined)
    return no({
      status: 400,
      body: {
        error: 'Sign-in sessions are not accepted here – send a push token (Authorization: Bearer sdl_…) without the session cookie',
        code: 'DATA_LINEAGE_PUSH_SESSION',
      },
    });
  const auth = (header(req.headers, 'authorization') ?? '').trim();
  const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!presented || presented.includes(' '))
    return no({ ...REFUSED, body: { error: 'Send the push token as "Authorization: Bearer sdl_…"', code: 'DATA_LINEAGE_TOKEN_MISSING' } });
  if (!presented.startsWith(DATA_LINEAGE_TOKEN_PREFIX))
    return no({
      status: 401,
      body: {
        error: 'This address takes a lineage push token (sdl_…), not an API token – create one on the lineage source (Data → Discovery)',
        code: 'DATA_LINEAGE_API_TOKEN',
      },
      headers: REFUSED.headers,
    });
  if (presented.length > 200) return no(REFUSED);
  const r = db().get<LineageTokenRow>('SELECT * FROM dp_lineage_tokens WHERE hash = ?', sha256(presented));
  if (!r || r.revoked_at || tokenExpired(r) || r.source_id !== req.sourceId) return no(REFUSED);
  if (!creatorMayPush(r)) {
    logger.warn({ tokenId: r.id, createdBy: r.created_by }, 'lineage push refused: the creator of the token is inactive or may no longer manage the source');
    return no(REFUSED);
  }
  if (!addressAllowed(parseJson<string[]>(r.allowed_cidrs, []), req.ip)) {
    logger.warn({ tokenId: r.id, ip: req.ip }, 'lineage push refused: address not allowed');
    return no(REFUSED);
  }
  const now = Date.now();
  const recent = (calls.get(r.id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= Number(r.rate_limit_per_minute)) {
    calls.set(r.id, recent);
    return no({
      status: 429,
      body: { error: `More than ${r.rate_limit_per_minute} pushes a minute`, code: 'DATA_LINEAGE_RATE' },
      headers: { 'retry-after': String(Math.max(1, Math.ceil((60_000 - (now - recent[0]!)) / 1000))) },
    });
  }
  recent.push(now);
  calls.set(r.id, recent);
  const ct = (req.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct !== 'application/json') return no({ status: 415, body: { error: 'Send JSON (Content-Type: application/json)', code: 'DATA_LINEAGE_PUSH_TYPE' } });
  const max = pushLimit(req.file);
  if (req.contentLength !== null && req.contentLength > max)
    return no({
      status: 413,
      body: { error: `The body is larger than ${Math.floor(max / 1024)} KB`, code: 'BODY_TOO_LARGE_KIB', params: { maxKib: Math.floor(max / 1024) } },
    });
  return { ok: true, token: { id: r.id, name: r.name, sourceId: r.source_id, createdBy: r.created_by } };
}

/** Counts a push on the source: taken (with the time) or refused (with why). */
function count(sourceId: string, refused: HttpError | null, n = 1): void {
  const now = nowIso();
  if (refused)
    db().run(
      'UPDATE dp_lineage_sources SET refused = refused + 1, last_error = ?, last_error_at = ? WHERE id = ?',
      JSON.stringify({ message: refused.message.slice(0, 500), code: refused.code ?? null }),
      now,
      sourceId,
    );
  else db().run('UPDATE dp_lineage_sources SET received = received + ?, last_event_at = ? WHERE id = ?', n, now, sourceId);
}

const asResponse = (e: HttpError): PushResponse => ({
  status: e.statusCode,
  body: { error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.params ? { params: e.params } : {}) },
});

function parseBody(raw: Buffer | undefined, file: PushHead['file']): unknown {
  const text = (raw ?? Buffer.alloc(0)).toString('utf8');
  if (!text.trim())
    throw new HttpError(400, 'The body is empty', file === 'openlineage' ? 'DATA_LINEAGE_EVENT_INVALID' : 'DATA_LINEAGE_DBT_INVALID', { where: '' });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'The body is not JSON', file === 'openlineage' ? 'DATA_LINEAGE_EVENT_INVALID' : 'DATA_LINEAGE_DBT_INVALID', { where: '' });
  }
}

/** The source of a verified token, refused when it is paused or of the other kind. */
function sourceFor(token: VerifiedLineageToken, file: PushHead['file']): LineageSourceRow {
  const src = lineageSourceRow(token.sourceId);
  if (!src) throw new HttpError(404, 'Not found', 'NOT_FOUND');
  if (!Number(src.enabled)) throw new HttpError(409, `Lineage source "${src.name}" is paused`, 'DATA_LINEAGE_SOURCE_PAUSED', { name: src.name });
  const wants = file === 'openlineage' ? 'openlineage' : 'dbt';
  if (src.kind !== wants)
    throw new HttpError(
      400,
      src.kind === 'dbt' ? 'This lineage source takes dbt files, not OpenLineage events' : 'This lineage source takes OpenLineage events, not dbt files',
      'DATA_LINEAGE_SOURCE_KIND',
      {
        context: src.kind,
      },
    );
  return src;
}

/** OpenLineage event(s) of a verified push: one transaction for the push. */
export function pushOpenLineage(token: VerifiedLineageToken, req: { raw: Buffer | undefined; ip: string }): PushResponse {
  db().run('UPDATE dp_lineage_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?', nowIso(), req.ip, token.id);
  let src: LineageSourceRow;
  try {
    src = sourceFor(token, 'openlineage');
  } catch (e) {
    if (e instanceof HttpError) return asResponse(e);
    throw e;
  }
  try {
    const events = parseOlPush(parseBody(req.raw, 'openlineage'));
    const aliases = parseJson(src.namespace_aliases, []);
    const out = db().tx(() => {
      const r = applyOlEvents(src.id, aliases, events);
      count(src.id, null, events.length);
      // a push that proposes something new is in the audit log (runs of known jobs are not: they come every few minutes)
      if (r.proposals.created || r.proposals.changed)
        audit({
          actor: `push token "${token.name}"`.slice(0, 120),
          action: 'datalineage.pushed',
          entityType: 'data_lineage_source',
          entityId: src.id,
          summary: `Lineage source "${src.name}": ${r.proposals.created} job(s) proposed, ${r.proposals.changed} changed`,
          details: { tokenId: token.id, ip: req.ip, events: r.events, ...r.proposals },
        });
      return r;
    });
    return { status: 200, body: { accepted: out.events, proposals: out.proposals } };
  } catch (e) {
    if (e instanceof HttpError) {
      count(src.id, e);
      return asResponse(e);
    }
    throw e;
  }
}

/** A dbt file of a verified push or an upload in the app (as the token's creator, or the person signed in). */
export async function importDbtFile(
  src: LineageSourceRow,
  file: 'manifest' | 'runResults',
  raw: Buffer | undefined,
  by: { actor: string; via: 'push' | 'upload'; tokenId?: string; ip?: string },
): Promise<DataLineageImport> {
  if (!src.platform_id)
    throw new HttpError(400, 'A dbt source names the platform its models live on', 'DATA_LINEAGE_SOURCE_PLATFORM', { context: 'dbtNeedsPlatform' });
  if ((raw?.length ?? 0) > pushLimit(file))
    throw new HttpError(413, `The file is larger than ${Math.floor(pushLimit(file) / 1024)} KB`, 'BODY_TOO_LARGE_KIB', {
      maxKib: Math.floor(pushLimit(file) / 1024),
    });
  const body = parseBody(raw, file);
  const hash = sha256(raw ?? Buffer.alloc(0));
  const counts: Record<string, number> =
    file === 'manifest' ? (await importManifest(src.id, src.platform_id, body)).counts : (await importRunResults(src.id, body)).counts;
  const result: DataLineageImport = { file, at: nowIso(), by: by.actor, sha256: hash, counts };
  db().tx(() => {
    db().run(
      'UPDATE dp_lineage_sources SET last_import = ?, received = received + 1, last_event_at = ? WHERE id = ?',
      JSON.stringify(result),
      result.at,
      src.id,
    );
    audit({
      ...(by.via === 'push' ? { actor: by.actor } : {}),
      action: 'datalineage.imported',
      entityType: 'data_lineage_source',
      entityId: src.id,
      summary:
        `Lineage source "${src.name}": dbt ${file === 'manifest' ? 'manifest.json' : 'run_results.json'} ${by.via === 'push' ? 'pushed' : 'uploaded'} – ${Object.entries(
          counts,
        )
          .map(([k, v]) => `${v} ${k}`)
          .join(', ')}`.slice(0, 500),
      details: { file, via: by.via, sha256: hash, ...counts, ...(by.tokenId ? { tokenId: by.tokenId, ip: by.ip } : {}) },
    });
  });
  return result;
}

/** A dbt file of a verified push: imported with the token's creator's rights (no person is signed in). */
export async function pushDbt(
  token: VerifiedLineageToken,
  file: 'manifest' | 'runResults',
  req: { raw: Buffer | undefined; ip: string },
): Promise<PushResponse> {
  db().run('UPDATE dp_lineage_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?', nowIso(), req.ip, token.id);
  let src: LineageSourceRow;
  try {
    src = sourceFor(token, file);
  } catch (e) {
    if (e instanceof HttpError) return asResponse(e);
    throw e;
  }
  const creator = findUserByName(token.createdBy);
  try {
    const out = await runAs(creator ? toAuthUser(creator) : null, () =>
      importDbtFile(src, file, req.raw, { actor: `push token "${token.name}"`.slice(0, 120), via: 'push', tokenId: token.id, ip: req.ip }),
    );
    return { status: 200, body: { import: out } };
  } catch (e) {
    if (e instanceof HttpError) {
      count(src.id, e);
      return asResponse(e);
    }
    throw e;
  }
}
