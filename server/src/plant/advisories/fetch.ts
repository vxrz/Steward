import crypto from 'node:crypto';
import { EnvHttpProxyAgent } from 'undici';
import { z } from 'zod';
import {
  ADVISORY_LIMITS as L,
  BRAND,
  advisorySourceKind,
  type AdvisoryFetchResult,
  type AdvisoryIntegrity,
  type AdvisorySource,
  type AdvisorySourceInput,
  type AdvisorySourceKind,
} from '@sm/shared';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import { currentUser } from '../../auth/context.js';
import { logger } from '../../log.js';
import { HttpError, nowIso, parseJson } from '../../util.js';
import { assertOutboundAllowed, fetchCheckingRedirects, guardedLookup } from '../../platforms/outbound.js';
import { outboundContext } from '../../platforms/policyContext.js';
import { plantEnabled } from '../settings.js';
import { assertPublicTlp, parseCsaf, PUBLIC_TLP } from './csaf.js';
import { rematchIfStale, saveAdvisory } from './store.js';

/**
 * Where advisories come from (docs/ADVISORIES.md "Sources"): CSAF 2.0 distribution (OASIS CSAF 2.0, section 7) as a
 * trusted provider publishes it –
 *
 *   provider    its provider-metadata.json (requirement 7, usually /.well-known/csaf/provider-metadata.json): the ROLIE
 *               feeds it lists (requirement 15) of TLP:WHITE, GREEN or unlabeled, else its directory (requirements
 *               11–13: changes.csv, newest first);
 *   aggregator  an aggregator.json (section 7.2): the provider-metadata.json of the providers and publishers it lists –
 *               at most ADVISORY_LIMITS.providersPerAggregator, optionally only publishers whose name contains one of
 *               the given words;
 *   rolie       one ROLIE feed (JSON, RFC 8322) directly.
 *
 * Every request goes through the outbound policy like a process step (address safety, the policy, every redirect hop –
 * at most 3), with a time limit and a size limit per answer; nothing is sent but GET. A document is kept only when its
 * hash file – where the feed lists one (rel "hash") or the directory has <file>.sha512 / .sha256 – matches (requirement
 * 18); an OpenPGP signature (.asc, requirement 19) is noted, not checked yet. Documents marked TLP:AMBER or RED are not
 * kept (everyone in the plant registry would read them). No source is set up or turned on by default.
 */

const dispatcher = new EnvHttpProxyAgent({ connect: { lookup: guardedLookup }, requestTls: { lookup: guardedLookup } } as never);
const TIMEOUT_MS = 30_000;

interface SourceRow {
  id: string;
  name: string;
  url: string;
  kind: string;
  enabled: number;
  interval_hours: number;
  publishers: string;
  since: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_count: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

const sourceOut = (r: SourceRow, counts: Map<string, number>): AdvisorySource => ({
  id: r.id,
  name: r.name,
  url: r.url,
  kind: r.kind as AdvisorySourceKind,
  enabled: r.enabled === 1,
  intervalHours: Number(r.interval_hours),
  publishers: parseJson<string[]>(r.publishers, []),
  since: r.since,
  lastRunAt: r.last_run_at,
  lastOkAt: r.last_ok_at,
  lastError: r.last_error,
  lastCount: Number(r.last_count),
  advisories: counts.get(r.id) ?? 0,
});

const advisoryCounts = () =>
  new Map(
    db()
      .all<{ source_id: string; n: number }>('SELECT source_id, COUNT(*) AS n FROM plant_advisories WHERE source_id IS NOT NULL GROUP BY source_id')
      .map((r) => [r.source_id, Number(r.n)]),
  );

export function listSources(): AdvisorySource[] {
  const counts = advisoryCounts();
  return db()
    .all<SourceRow>('SELECT * FROM plant_advisory_sources ORDER BY name, id')
    .map((r) => sourceOut(r, counts));
}

const sourceRow = (id: string): SourceRow => {
  const r = db().get<SourceRow>('SELECT * FROM plant_advisory_sources WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'There is no such advisory source', 'PLANT_ADVISORY_SOURCE_NOT_FOUND', { id });
  return r;
};
export const getSource = (id: string): AdvisorySource => sourceOut(sourceRow(id), advisoryCounts());

function checkUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'Give an http or https address', 'PLANT_ADVISORY_SOURCE_URL');
  if (u.username || u.password) throw new HttpError(400, 'An address with a user name or password is not kept', 'PLANT_ADVISORY_SOURCE_URL');
}

export function createSource(input: AdvisorySourceInput): AdvisorySource {
  checkUrl(input.url);
  const n = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_advisory_sources')?.n ?? 0;
  if (Number(n) >= L.sources) throw new HttpError(400, `At most ${L.sources} advisory sources`, 'PLANT_ADVISORY_SOURCES_LIMIT', { max: L.sources });
  const id = `avs_${crypto.randomBytes(8).toString('hex')}`;
  const by = currentUser()?.username ?? 'system';
  const now = nowIso();
  const kind = advisorySourceKind(input.url);
  db().tx(() => {
    db().run(
      `INSERT INTO plant_advisory_sources (id, name, url, kind, enabled, interval_hours, publishers, since, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.url,
      kind,
      input.enabled ? 1 : 0,
      input.intervalHours,
      JSON.stringify(input.publishers),
      input.since,
      now,
      by,
      now,
      by,
    );
    audit({
      action: 'plant.advisory_source_added',
      entityType: 'plant_advisory_source',
      entityId: id,
      summary: `Advisory source "${input.name}" added (${kind}, ${new URL(input.url).origin}${input.enabled ? `, every ${input.intervalHours} h` : ', off'})`,
      details: { ...input, kind },
    });
  });
  return getSource(id);
}

export function updateSource(id: string, input: AdvisorySourceInput): AdvisorySource {
  const before = sourceRow(id);
  checkUrl(input.url);
  const kind = advisorySourceKind(input.url);
  db().tx(() => {
    db().run(
      'UPDATE plant_advisory_sources SET name = ?, url = ?, kind = ?, enabled = ?, interval_hours = ?, publishers = ?, since = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      input.name,
      input.url,
      kind,
      input.enabled ? 1 : 0,
      input.intervalHours,
      JSON.stringify(input.publishers),
      input.since,
      nowIso(),
      currentUser()?.username ?? 'system',
      id,
    );
    // another address: what was fetched from the old one is no longer known
    if (before.url !== input.url) db().run('DELETE FROM plant_advisory_fetched WHERE source_id = ?', id);
    audit({
      action: 'plant.advisory_source_changed',
      entityType: 'plant_advisory_source',
      entityId: id,
      summary: `Advisory source "${input.name}" changed${before.url !== input.url ? ` (address ${new URL(before.url).origin} → ${new URL(input.url).origin})` : ''}${(before.enabled === 1) !== input.enabled ? (input.enabled ? ', turned on' : ', turned off') : ''}`,
      details: {
        before: {
          name: before.name,
          url: before.url,
          enabled: before.enabled === 1,
          intervalHours: before.interval_hours,
          publishers: parseJson(before.publishers, []),
          since: before.since,
        },
        after: { ...input, kind },
      },
    });
  });
  return getSource(id);
}

/** Removes a source; the advisories it brought stay (they are documents, with people's decisions on them). */
export function deleteSource(id: string): void {
  const r = sourceRow(id);
  db().tx(() => {
    db().run('DELETE FROM plant_advisory_fetched WHERE source_id = ?', id);
    db().run('UPDATE plant_advisories SET source_id = NULL WHERE source_id = ?', id);
    db().run('DELETE FROM plant_advisory_sources WHERE id = ?', id);
    audit({
      action: 'plant.advisory_source_removed',
      entityType: 'plant_advisory_source',
      entityId: id,
      summary: `Advisory source "${r.name}" removed (its advisories stay)`,
      details: { name: r.name, url: r.url },
    });
  });
}

// ---------- reading from providers ----------

/** GET through the outbound policy (every redirect hop checked), at most `max` bytes. */
export async function getLimited(url: string, max: number, accept: string): Promise<{ status: number; body: Buffer | null }> {
  const ctx = outboundContext();
  await assertOutboundAllowed(url, ctx);
  let res: Awaited<ReturnType<typeof fetchCheckingRedirects>>;
  try {
    res = await fetchCheckingRedirects(
      url,
      { method: 'GET', headers: { accept, 'user-agent': BRAND.slug }, dispatcher, signal: AbortSignal.timeout(TIMEOUT_MS) },
      ctx,
      { maxRedirects: 3 },
    );
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const err = e as Error & { cause?: Error & { code?: string } };
    if (err.cause?.code === 'ESSRFBLOCKED') throw new HttpError(403, err.cause.message, 'PLANT_ADVISORY_FETCH_BLOCKED');
    throw new HttpError(502, `${new URL(url).origin} is not reachable`, 'PLANT_ADVISORY_FETCH_FAILED', { origin: new URL(url).origin });
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined); // the body is not read: a failed cancel changes nothing
    return { status: res.status, body: null };
  }
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined); // too large: not read
    throw new HttpError(502, `The answer of ${new URL(url).origin} is larger than ${Math.round(max / 1024)} KB`, 'PLANT_ADVISORY_FETCH_TOO_LARGE', {
      kb: Math.round(max / 1024),
    });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined); // the rest is not read: a failed cancel changes nothing
        throw new HttpError(502, `The answer of ${new URL(url).origin} is larger than ${Math.round(max / 1024)} KB`, 'PLANT_ADVISORY_FETCH_TOO_LARGE', {
          kb: Math.round(max / 1024),
        });
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { status: res.status, body: Buffer.concat(chunks) };
}

async function getJson(url: string, max = L.indexBytes): Promise<unknown> {
  const r = await getLimited(url, max, 'application/json');
  if (!r.body) throw new HttpError(502, `${url.slice(0, 300)} answered HTTP ${r.status}`, 'PLANT_ADVISORY_FETCH_FAILED', { origin: new URL(url).origin });
  try {
    return JSON.parse(r.body.toString('utf8'));
  } catch {
    throw new HttpError(502, `${url.slice(0, 300)} is not JSON`, 'PLANT_ADVISORY_FETCH_FAILED', { origin: new URL(url).origin });
  }
}

const absolute = (href: string, base: string): string | null => {
  try {
    const u = new URL(href, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
};

const providerSchema = z.object({
  publisher: z.object({ name: z.string().max(500) }).optional(),
  distributions: z
    .array(
      z.object({
        directory_url: z.string().max(2000).optional(),
        rolie: z.object({ feeds: z.array(z.object({ tlp_label: z.string().max(50), url: z.string().max(2000) })).max(50) }).optional(),
      }),
    )
    .max(50)
    .optional(),
});
const metadataRef = z.object({ metadata: z.object({ url: z.string().max(2000), publisher: z.object({ name: z.string().max(500) }).optional() }) });
const aggregatorSchema = z.object({
  csaf_providers: z.array(metadataRef).max(10_000),
  csaf_publishers: z.array(metadataRef).max(10_000).optional(),
});
const feedSchema = z.object({
  feed: z.object({
    entry: z
      .array(
        z.object({
          id: z.string().max(1000).optional(),
          link: z
            .array(z.object({ rel: z.string().max(50), href: z.string().max(2000) }))
            .max(20)
            .optional(),
          updated: z.string().max(100).optional(),
          published: z.string().max(100).optional(),
          content: z.object({ src: z.string().max(2000).optional() }).optional(),
        }),
      )
      .max(100_000)
      .optional(),
  }),
});

/** A document a source lists: its address, when it changed, its hash and signature files. */
export interface Listed {
  url: string;
  updated: string;
  hashes: string[];
  signature: string;
}

async function readFeed(url: string): Promise<Listed[]> {
  const r = feedSchema.safeParse(await getJson(url));
  if (!r.success) throw new HttpError(502, `${url.slice(0, 300)} is not a ROLIE feed`, 'PLANT_ADVISORY_FEED_INVALID', { origin: new URL(url).origin });
  const out: Listed[] = [];
  for (const e of r.data.feed.entry ?? []) {
    const self = e.content?.src ?? e.link?.find((l) => l.rel === 'self')?.href;
    const doc = self ? absolute(self, url) : null;
    if (!doc) continue;
    out.push({
      url: doc,
      updated: e.updated ?? e.published ?? '',
      hashes: (e.link ?? []).filter((l) => l.rel === 'hash').flatMap((l) => absolute(l.href, url) ?? []),
      signature: (e.link ?? []).filter((l) => l.rel === 'signature').flatMap((l) => absolute(l.href, url) ?? [])[0] ?? '',
    });
  }
  return out;
}

/** changes.csv of a directory distribution: `"<path>","<current_release_date>"` per line, newest first. */
export function parseChanges(csv: string, base: string): Listed[] {
  const out: Listed[] = [];
  const dir = base.endsWith('/') ? base : `${base}/`;
  for (const line of csv.split('\n')) {
    const fields: string[] = [];
    let cur = '';
    let quoted = false;
    for (const c of line.trim()) {
      if (c === '"') quoted = !quoted;
      else if (c === ',' && !quoted) {
        fields.push(cur);
        cur = '';
      } else cur += c;
    }
    fields.push(cur);
    const [path, updated] = fields;
    if (!path || !path.endsWith('.json')) continue;
    const doc = absolute(path, dir);
    if (doc && doc.startsWith(dir)) out.push({ url: doc, updated: updated ?? '', hashes: [`${doc}.sha512`, `${doc}.sha256`], signature: '' });
  }
  return out;
}

async function readProvider(url: string): Promise<Listed[]> {
  const r = providerSchema.safeParse(await getJson(url));
  if (!r.success)
    throw new HttpError(502, `${url.slice(0, 300)} is not a provider-metadata.json`, 'PLANT_ADVISORY_FEED_INVALID', { origin: new URL(url).origin });
  const feeds = (r.data.distributions ?? []).flatMap((d) => d.rolie?.feeds ?? []).filter((f) => PUBLIC_TLP.has(f.tlp_label.toUpperCase()));
  const out: Listed[] = [];
  if (feeds.length) {
    for (const f of feeds) {
      const feed = absolute(f.url, url);
      if (feed) out.push(...(await readFeed(feed)));
    }
    return out;
  }
  for (const d of r.data.distributions ?? []) {
    const dir = d.directory_url ? absolute(d.directory_url, url) : null;
    if (!dir) continue;
    const changes = await getLimited(`${dir.endsWith('/') ? dir : `${dir}/`}changes.csv`, L.indexBytes, 'text/csv, text/plain');
    if (changes.body) out.push(...parseChanges(changes.body.toString('utf8'), dir));
  }
  return out;
}

async function readAggregator(url: string, publishers: string[]): Promise<Listed[]> {
  const r = aggregatorSchema.safeParse(await getJson(url));
  if (!r.success) throw new HttpError(502, `${url.slice(0, 300)} is not an aggregator.json`, 'PLANT_ADVISORY_FEED_INVALID', { origin: new URL(url).origin });
  const words = publishers.map((p) => p.toLowerCase());
  const refs = [...r.data.csaf_providers, ...(r.data.csaf_publishers ?? [])]
    .filter((x) => !words.length || words.some((w) => (x.metadata.publisher?.name ?? '').toLowerCase().includes(w)))
    .slice(0, L.providersPerAggregator);
  const out: Listed[] = [];
  for (const ref of refs) {
    const meta = absolute(ref.metadata.url, url);
    if (!meta) continue;
    try {
      out.push(...(await readProvider(meta)));
    } catch (err) {
      logger.warn({ err: (err as Error).message, provider: new URL(meta).origin }, 'advisory aggregator: a provider could not be read');
    }
  }
  return out;
}

/** Fetches the hash file and compares; the algorithm that matched, 'none' when no hash file exists. */
async function checkHash(doc: Buffer, hashes: string[]): Promise<AdvisoryIntegrity> {
  for (const h of hashes) {
    const algo = h.endsWith('.sha512') ? 'sha512' : h.endsWith('.sha256') ? 'sha256' : null;
    if (!algo) continue;
    const r = await getLimited(h, L.hashBytes, 'text/plain');
    if (r.status === 404 && !r.body) continue;
    if (!r.body) throw new HttpError(502, `The hash file answered HTTP ${r.status}`, 'PLANT_ADVISORY_FETCH_FAILED', { origin: new URL(h).origin });
    // requirement 18: the file starts with the hexadecimal hash; a file name may follow after a space
    const want = r.body.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const got = crypto.createHash(algo).update(doc).digest('hex');
    if (want !== got)
      throw new HttpError(502, `The ${algo.toUpperCase()} of the document does not match its hash file`, 'PLANT_ADVISORY_HASH', { algorithm: algo });
    return algo;
  }
  return 'none';
}

const dayOf = (s: string) => (Date.parse(s) ? new Date(Date.parse(s)).toISOString().slice(0, 10) : '');

/** Reads a source now: the documents it lists that are new or changed since the last run (at most documentsPerRun). */
export async function fetchSource(id: string): Promise<AdvisoryFetchResult> {
  const s = sourceRow(id);
  const now = nowIso();
  db().run('UPDATE plant_advisory_sources SET last_run_at = ? WHERE id = ?', now, id);
  const result: AdvisoryFetchResult = { source: getSource(id), read: 0, created: 0, updated: 0, unchanged: 0, failed: [] };
  let listed: Listed[];
  try {
    const kind = s.kind as AdvisorySourceKind;
    listed =
      kind === 'provider'
        ? await readProvider(s.url)
        : kind === 'aggregator'
          ? await readAggregator(s.url, parseJson<string[]>(s.publishers, []))
          : await readFeed(s.url);
  } catch (e) {
    const message = (e as Error).message.slice(0, 500);
    db().run('UPDATE plant_advisory_sources SET last_error = ?, last_count = 0 WHERE id = ?', message, id);
    logger.warn({ source: id, err: message }, 'advisory source could not be read');
    return { ...result, source: getSource(id), failed: [{ url: s.url, error: message }] };
  }
  const known = new Map(
    db()
      .all<{ url: string; updated: string; error: string | null }>('SELECT url, updated, error FROM plant_advisory_fetched WHERE source_id = ?', id)
      .map((r) => [r.url, r]),
  );
  const todo = [...new Map(listed.map((x) => [x.url, x])).values()]
    .filter((x) => !s.since || !x.updated || dayOf(x.updated) >= s.since)
    .filter((x) => {
      const k = known.get(x.url);
      return !k || k.error !== null || k.updated !== x.updated;
    })
    .sort((a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0))
    .slice(0, L.documentsPerRun);
  for (const x of todo) {
    const record = (values: { sha256?: string; advisoryId?: string | null; error?: string | null }) =>
      db().run(
        `INSERT INTO plant_advisory_fetched (source_id, url, updated, sha256, advisory_id, error, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, url) DO UPDATE SET updated = excluded.updated, sha256 = excluded.sha256, advisory_id = excluded.advisory_id, error = excluded.error, fetched_at = excluded.fetched_at`,
        id,
        x.url,
        x.updated,
        values.sha256 ?? '',
        values.advisoryId ?? null,
        values.error ?? null,
        nowIso(),
      );
    try {
      const r = await getLimited(x.url, L.documentBytes, 'application/json');
      if (!r.body) throw new HttpError(502, `The document answered HTTP ${r.status}`, 'PLANT_ADVISORY_FETCH_FAILED', { origin: new URL(x.url).origin });
      const integrity = await checkHash(r.body, x.hashes);
      const parsed = parseCsaf(r.body);
      assertPublicTlp(parsed);
      const saved = saveAdvisory(parsed, { origin: 'feed', sourceId: id, url: x.url, fileName: '', integrity, signatureUrl: x.signature });
      record({ sha256: parsed.sha256, advisoryId: saved.id });
      result.read++;
      if (saved.result === 'created') result.created++;
      else if (saved.result === 'updated') result.updated++;
      else result.unchanged++;
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      record({ error: message });
      result.failed.push({ url: x.url, error: message });
    }
  }
  db().run(
    'UPDATE plant_advisory_sources SET last_ok_at = ?, last_error = ?, last_count = ? WHERE id = ?',
    nowIso(),
    result.failed.length ? `${result.failed.length} document(s) failed: ${result.failed[0]!.error}`.slice(0, 500) : null,
    result.created + result.updated,
    id,
  );
  if (result.created || result.updated || result.failed.length)
    audit({
      action: 'plant.advisory_source_read',
      entityType: 'plant_advisory_source',
      entityId: id,
      summary: `Advisory source "${s.name}" read: ${result.created} new, ${result.updated} updated, ${result.failed.length} failed`,
      details: { created: result.created, updated: result.updated, unchanged: result.unchanged, failed: result.failed.slice(0, 20) },
    });
  return { ...result, source: getSource(id) };
}

/** The job: matches after plant changes, then every enabled source that is due. */
export async function runAdvisoryJob(now = Date.now()): Promise<number> {
  if (!plantEnabled()) return 0;
  rematchIfStale();
  let n = 0;
  for (const s of db().all<SourceRow>('SELECT * FROM plant_advisory_sources WHERE enabled = 1 ORDER BY id')) {
    const last = s.last_run_at ? Date.parse(s.last_run_at) : 0;
    if (now - last < Number(s.interval_hours) * 3_600_000) continue;
    try {
      const r = await fetchSource(s.id);
      n += r.created + r.updated;
    } catch (err) {
      logger.warn({ err, source: s.id }, 'advisory source run failed');
    }
  }
  return n;
}
