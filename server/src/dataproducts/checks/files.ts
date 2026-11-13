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
 * A prefix with more keys than the limit is judged on the keys read, and the message says so. Folder markers do not
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
  return judgeAge(
    c,
    `S3: ${el.qualified_name}`,
    Number.isFinite(minutes) ? minutes : null,
    c.maxAgeMinutes ?? 1440,
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
  return measure === 'bytes' ? finish(c, el, 'bytes', 'bytes', what, s.bytes, now) : finish(c, el, 'objects', 'objects', what, s.objects, now);
}
