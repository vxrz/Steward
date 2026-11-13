import {
  DATA_DISCOVERY_LIMITS as DL,
  discoveryKeeps,
  environmentByRules,
  fileFormatOf,
  openLineageDataset,
  parseObjectStorageUrl,
  S3_DISCOVERY_SCOPE_RE,
  type DataFileFormat,
  type DiscoveredElement,
} from '@sm/shared';
import { db } from '../../db.js';
import { S3Lister } from '../../aws/s3list.js';
import { DiscoveryError, type DiscoveryContext } from './common.js';

/**
 * Object storage discovery (0.25.0, ADR 0037 part 2): `files.path` elements from S3, through an AWS account platform –
 * **only the prefixes named**: the source's scope (`s3://<bucket>/<prefix>/`; a bucket's root only when the scope names
 * it so) and the `files.path` elements of the platform that are part of a product. Never a whole account.
 *
 * Each named prefix is listed with ListObjectsV2 – with the delimiter `/` for the prefixes one level down, then without it
 * for the keys below, 1,000 a call – metadata only, no GetObject: the number of objects, their size, the newest `LastModified`, the format by the keys'
 * suffixes (Parquet, CSV, JSON, Avro, ORC; Iceberg by its `metadata/*.metadata.json`, Delta by its `_delta_log/`),
 * Hive-style partitions (`key=value/`) with their keys, and the prefixes one level down. A prefix of the scope also
 * gives an element for each prefix one level down that is not a partition (the datasets below a landing area).
 *
 * Limits per run: DATA_DISCOVERY_LIMITS.s3Prefixes listings (calls) and s3Keys keys read. A run a limit cuts says so
 * (DATA_DISCOVERY_TOO_LARGE, truncated – nothing is marked missing); the elements it could not read whole carry
 * `truncated` in their readout.
 */

/** The calls discovery makes on S3 (the metadata-only test checks every request against it). */
export const S3_DISCOVERY_CALLS: readonly RegExp[] = [/^GET \/[^?]*\?(continuation-token=[^&]+&)?(delimiter=%2F&)?list-type=2&max-keys=\d+&prefix=[^&]*$/];

/** The run's limits (DATA_DISCOVERY_LIMITS; the tests lower them). */
export const S3_RUN_LIMITS = { prefixes: DL.s3Prefixes as number, keys: DL.s3Keys as number };

interface Target {
  bucket: string;
  prefix: string;
  /** The element's environment: a product's element keeps its own */
  environment: string;
  /** A prefix of the scope: the datasets one level down are elements too */
  scope: boolean;
}

interface Summary {
  objects: number;
  bytes: number;
  newest: string | null;
  formats: Map<DataFileFormat, number>;
  partitionKeys: string[];
  partitions: Set<string>;
  prefixes: number;
  iceberg: boolean;
  delta: boolean;
  truncated: boolean;
}

const empty = (): Summary => ({
  objects: 0,
  bytes: 0,
  newest: null,
  formats: new Map(),
  partitionKeys: [],
  partitions: new Set(),
  prefixes: 0,
  iceberg: false,
  delta: false,
  truncated: false,
});

const HIVE = /^[^=/]+=[^/]*$/;

/** Adds one object (its key relative to the summary's prefix) to a summary. */
function add(s: Summary, rel: string, size: number, lastModified: string): void {
  if (!rel || rel.endsWith('/')) return; // a folder marker
  s.objects++;
  s.bytes += size;
  if (lastModified && (!s.newest || lastModified > s.newest)) s.newest = lastModified;
  const parts = rel.split('/');
  const name = parts[parts.length - 1]!;
  if (parts[0] === 'metadata' && name.endsWith('.metadata.json')) s.iceberg = true;
  if (parts[0] === '_delta_log') s.delta = true;
  // Hive-style partitions: key=value folders, in their order
  const dirs = parts.slice(0, -1);
  const hive = dirs.filter((d) => HIVE.test(d));
  if (hive.length && hive.length === dirs.length - (parts[0] === 'data' ? 1 : 0)) {
    s.partitions.add(dirs.join('/'));
    hive.forEach((d, i) => {
      const k = d.slice(0, d.indexOf('='));
      if (s.partitionKeys[i] === undefined) s.partitionKeys[i] = k;
    });
  }
  // marker and checksum files say nothing of the format
  if (name.startsWith('_') || name.startsWith('.')) return;
  const f = fileFormatOf(name);
  s.formats.set(f ?? 'other', (s.formats.get(f ?? 'other') ?? 0) + 1);
}

function formatOf(s: Summary): DataFileFormat | null {
  if (s.iceberg) return 'iceberg';
  if (s.delta) return 'delta';
  const known = [...s.formats].filter(([f]) => f !== 'other').sort((a, b) => b[1] - a[1]);
  if (!known.length) return s.formats.size ? 'other' : null;
  // one format for (nearly) all files; else mixed
  const total = [...s.formats.values()].reduce((a, b) => a + b, 0);
  return known[0]![1] >= total * 0.9 ? known[0]![0] : 'mixed';
}

const readout = (s: Summary): DiscoveredElement['readout'] => ({
  objects: s.objects,
  bytes: s.bytes,
  lastAltered: s.newest,
  format: formatOf(s),
  formats: [...s.formats]
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${f}:${n}`)
    .join(',')
    .slice(0, 200),
  partitionKeys: s.partitionKeys.filter(Boolean).join(',').slice(0, 200) || null,
  partitions: s.partitions.size || null,
  prefixes: s.prefixes,
  ...(s.truncated ? { truncated: true } : {}),
});

/** The `files.path` elements of this platform that are part of a product: read as well (their own environment). */
function productPrefixes(platformId: string): { qualifiedName: string; environment: string }[] {
  return db()
    .all<{ qualified_name: string; environment: string }>(
      `SELECT DISTINCT e.qualified_name, e.environment FROM dp_elements e JOIN dp_members m ON m.element_id = e.id
     WHERE e.platform_id = ? AND e.kind = 'files.path' ORDER BY e.qualified_name LIMIT ?`,
      platformId,
      DL.scope * 20,
    )
    .map((r) => ({ qualifiedName: r.qualified_name, environment: r.environment }));
}

/** The source's S3 scope entries, checked (DATA_DISCOVERY_SCOPE otherwise). */
export function s3Scope(entries: readonly string[]): { bucket: string; prefix: string }[] {
  return entries.map((raw) => {
    const e = raw.trim();
    const u = S3_DISCOVERY_SCOPE_RE.test(e) ? parseObjectStorageUrl(e) : null;
    if (!u)
      throw new DiscoveryError({
        message: `"${e.slice(0, 100)}" is not an S3 prefix (s3://bucket/prefix/)`,
        code: 'DATA_DISCOVERY_SCOPE',
        params: { context: 's3', value: e.slice(0, 100) },
      });
    return { bucket: u.bucket, prefix: u.prefix };
  });
}

export async function* readS3(ctx: DiscoveryContext): AsyncGenerator<DiscoveredElement[]> {
  const { source, platform } = ctx;
  const fallback = platform.environment ?? '';
  const targets: Target[] = s3Scope(source.scope).map((x) => ({
    ...x,
    environment: environmentByRules(x.bucket, source.environmentRules, fallback),
    scope: true,
  }));
  const seen = new Set(targets.map((t) => `${t.bucket}/${t.prefix}`));
  for (const p of productPrefixes(platform.id)) {
    const u = parseObjectStorageUrl(p.qualifiedName);
    // a bucket's root only when the scope names it
    if (!u || !u.prefix || seen.has(`${u.bucket}/${u.prefix}`)) continue;
    seen.add(`${u.bucket}/${u.prefix}`);
    targets.push({ bucket: u.bucket, prefix: u.prefix, environment: p.environment, scope: false });
  }
  if (!targets.length)
    throw new DiscoveryError({
      message: 'Name at least one S3 prefix in the scope (s3://bucket/prefix/), or add a files.path element of this platform to a product',
      code: 'DATA_DISCOVERY_SCOPE',
      params: { context: 's3Empty' },
    });
  const lister = new S3Lister(platform, ctx.secrets, ctx.signal);
  let keysRead = 0;
  let cut: 'keys' | 'prefixes' | null = null;
  const stop = (why: 'keys' | 'prefixes') => {
    if (cut) return;
    cut = why;
    ctx.warn({
      message:
        why === 'keys'
          ? `The run stopped reading after ${S3_RUN_LIMITS.keys.toLocaleString('en-GB')} object keys: narrow the scope – nothing is marked missing`
          : `The run stopped after ${S3_RUN_LIMITS.prefixes.toLocaleString('en-GB')} S3 listings: narrow the scope – nothing is marked missing`,
      code: 'DATA_DISCOVERY_TOO_LARGE',
      params: { context: why === 'keys' ? 's3Keys' : 's3Prefixes', max: why === 'keys' ? S3_RUN_LIMITS.keys : S3_RUN_LIMITS.prefixes },
    });
  };
  const keeps = (qn: string) => discoveryKeeps(qn, source.includePrefixes, source.excludePrefixes, false);
  const element = (t: { bucket: string; prefix: string; environment: string }, s: Summary): DiscoveredElement => {
    const qn = `s3://${t.bucket}/${t.prefix}`;
    const ol = openLineageDataset('files.path', null, qn);
    const name = t.prefix.replace(/\/+$/, '').split('/').pop() || t.bucket;
    return {
      kind: 'files.path',
      qualifiedName: qn,
      displayName: name.slice(0, 200),
      parentQualifiedName: null,
      environment: t.environment,
      externalId: null,
      flags: {},
      readout: readout(s),
      olNamespace: ol?.namespace ?? null,
      olName: ol?.name ?? null,
    };
  };

  /** Pages of a listing within the run's limits (null once a limit is reached). */
  async function* pages(bucket: string, prefix: string, delimiter?: '/') {
    let token: string | null = null;
    do {
      if (lister.calls >= S3_RUN_LIMITS.prefixes) return stop('prefixes');
      if (keysRead >= S3_RUN_LIMITS.keys) return stop('keys');
      const page = await lister.list(bucket, prefix, { delimiter, token, maxKeys: Math.min(1_000, S3_RUN_LIMITS.keys - keysRead) });
      keysRead += page.keys.length;
      yield page;
      token = page.next;
    } while (token && !ctx.signal.aborted);
  }

  for (const t of targets) {
    if (cut || ctx.signal.aborted) break;
    if (!keeps(`s3://${t.bucket}/${t.prefix}`)) continue;
    const total = empty();
    /** The datasets one level down (prefixes of the scope only): their own summaries and the folders below them */
    const children = new Map<string, Summary>();
    const below = new Map<string, Set<string>>();
    // 1. with the delimiter: the prefixes one level down (partitions, datasets, a table format's folders)
    for await (const page of pages(t.bucket, t.prefix, '/')) {
      total.prefixes += page.prefixes.length;
      if (t.scope)
        for (const p of page.prefixes) {
          const seg = p.slice(t.prefix.length);
          if (!HIVE.test(seg.replace(/\/$/, '')) && !['metadata/', 'data/', '_delta_log/'].includes(seg)) {
            children.set(seg, empty());
            below.set(seg, new Set());
          }
        }
    }
    // 2. every key below, page by page (1,000 a call): counted, summed, the newest change, formats and partitions
    if (!cut)
      for await (const page of pages(t.bucket, t.prefix)) {
        for (const k of page.keys) {
          const rel = k.key.slice(t.prefix.length);
          add(total, rel, k.size, k.lastModified);
          const slash = rel.indexOf('/');
          const seg = slash > 0 ? rel.slice(0, slash + 1) : '';
          const child = seg ? children.get(seg) : undefined;
          if (!child) continue;
          const inner = rel.slice(slash + 1);
          add(child, inner, k.size, k.lastModified);
          if (inner.includes('/')) below.get(seg)!.add(inner.slice(0, inner.indexOf('/')));
        }
      }
    for (const [seg, c] of children) c.prefixes = below.get(seg)!.size;
    if (cut) {
      total.truncated = true;
      for (const c of children.values()) c.truncated = true;
    }
    // an empty prefix is no dataset (S3 has no folders): not found, so missing after a complete run
    const out: DiscoveredElement[] = [];
    if (total.objects || total.prefixes) out.push(element(t, total));
    for (const [seg, s] of children)
      if ((s.objects || s.prefixes) && keeps(`s3://${t.bucket}/${t.prefix}${seg}`))
        out.push(element({ bucket: t.bucket, prefix: `${t.prefix}${seg}`, environment: t.environment }, s));
    yield out;
  }
}
