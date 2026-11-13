import { DATA_DISCOVERY_LIMITS as DL, parseObjectStorageUrl, type CheckOf, type Platform } from '@sm/shared';
import { S3Lister } from '../../aws/s3list.js';
import type { ElementRow } from '../store.js';
import { judgeAge, type CheckResult } from './freshness.js';
import { finish } from './volume.js';

/**
 * Freshness and volume of a `files.path` element on S3 (0.25.0, ADR 0037 part 2) – from the listing of its prefix
 * (ListObjectsV2, 1,000 keys a call, at most DATA_DISCOVERY_LIMITS.s3CheckKeys keys; metadata only, never an object):
 *
 *   freshness  the newest `LastModified` below the prefix against `maxAgeMinutes`
 *   volume     the number of objects (`measure: rows`) or their size in bytes (`bytes`) against the reading before –
 *              the same rules as a table's rows (minRows, minGrowth, maxChangePct)
 *
 * A prefix with more keys than the limit is judged on the keys read, and the message says so – its freshness only when
 * the keys read hold a recent object: S3 lists the oldest partitions first, so a cut listing never proves staleness
 * (unknown instead), and its volume only against an absolute minimum the keys read already reach (growth and change rules
 * are unknown on a cut listing, and it is not stored as a reading). Folder markers do not
 * count. The element's platform must be an AWS account platform; the monitor owner's use right on it is checked by the
 * caller (element.ts), as for every platform check.
 */

type Check = CheckOf<'data-element'>;

async function summary(el: ElementRow, platform: Platform, secrets: Record<string, string>) {
  const u = parseObjectStorageUrl(el.qualified_name);
  if (!u) return { error: `"${el.qualified_name}" is not an S3 address (s3://bucket/prefix/)` };
  const lister = new S3Lister(platform, secrets);
  let objects = 0;
  let bytes = 0;
  let newest: string | null = null;
  let token: string | null = null;
  let read = 0;
  do {
    const page = await lister.list(u.bucket, u.prefix, { token, maxKeys: Math.min(1_000, DL.s3CheckKeys - read) });
    read += page.keys.length;
    for (const k of page.keys) {
      if (k.key.endsWith('/')) continue;
      objects++;
      bytes += k.size;
      if (k.lastModified && (!newest || k.lastModified > newest)) newest = k.lastModified;
    }
    token = page.next;
  } while (token && read < DL.s3CheckKeys);
  return { objects, bytes, newest, partial: !!token };
}

const partialNote = (partial: boolean) => (partial ? ` (the first ${DL.s3CheckKeys.toLocaleString('en-GB')} keys)` : '');

export async function filesFreshness(c: Check, el: ElementRow, platform: Platform, secrets: Record<string, string>, now: number): Promise<CheckResult> {
  if (platform.kind !== 'aws') return { status: 'unknown', message: `"${platform.name}" is not an AWS account platform – S3 is read through one` };
  const s = await summary(el, platform, secrets);
  if ('error' in s) return { status: 'unknown', message: s.error! };
  if (!s.objects) return { status: c.failAs, message: `S3: no object below ${el.qualified_name}`, value: { objects: 0 } };
  const minutes = s.newest ? Math.max(0, Math.floor((now - Date.parse(s.newest)) / 60_000)) : null;
  const maxAge = c.maxAgeMinutes ?? 1440;
  // S3 lists keys in their order – the oldest partitions (dt=…) first: a listing the limit cut proves freshness when it
  // found a recent object, never staleness (the newest objects may lie beyond the keys read)
  if (s.partial && (minutes === null || !Number.isFinite(minutes) || minutes > maxAge))
    return {
      status: 'unknown',
      message: `S3: ${el.qualified_name} – the first ${DL.s3CheckKeys.toLocaleString('en-GB')} keys hold no object changed within ${maxAge} minutes; newer ones may follow (name a narrower prefix)`,
      value: { objects: s.objects, newest: s.newest, partial: true },
    };
  return judgeAge(
    c,
    `S3: ${el.qualified_name}`,
    Number.isFinite(minutes) ? minutes : null,
    maxAge,
    { objects: s.objects, newest: s.newest },
    partialNote(s.partial),
  );
}

export async function filesVolume(c: Check, el: ElementRow, platform: Platform, secrets: Record<string, string>, now: number): Promise<CheckResult> {
  if (platform.kind !== 'aws') return { status: 'unknown', message: `"${platform.name}" is not an AWS account platform – S3 is read through one` };
  const s = await summary(el, platform, secrets);
  if ('error' in s) return { status: 'unknown', message: s.error! };
  const measure = c.measure ?? 'rows';
  const what = `S3: ${el.qualified_name}${partialNote(s.partial)}`;
  if (s.partial) {
    // a cut listing is a lower bound: growth and change cannot be judged on it (nor stored as a reading for later ones);
    // an absolute minimum passes when the keys read already reach it
    const unit = measure === 'bytes' ? 'bytes' : 'objects';
    const value = measure === 'bytes' ? s.bytes : s.objects;
    const n = (x: number) => x.toLocaleString('en-GB');
    if (c.minGrowth !== undefined || c.maxChangePct !== undefined || c.minRows === undefined || value < c.minRows)
      return {
        status: 'unknown',
        message: `S3: ${el.qualified_name} – the first ${n(DL.s3CheckKeys)} keys hold ${n(value)} ${unit}; more may follow, so ${
          c.minGrowth !== undefined || c.maxChangePct !== undefined ? 'growth and change are' : 'the volume is'
        } not judged (name a narrower prefix)`,
        value: { value, partial: true },
      };
    return { status: 'up', message: `${what}: at least ${n(value)} ${unit} (at least ${n(c.minRows)})`, value: { value, partial: true } };
  }
  return measure === 'bytes' ? finish(c, el, 'bytes', 'bytes', what, s.bytes, now) : finish(c, el, 'objects', 'objects', what, s.objects, now);
}
