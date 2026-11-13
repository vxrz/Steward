import type { Platform } from '@sm/shared';
import { platformRequest, type HttpResult } from '../platforms/http.js';
import { awsEncode } from '../platforms/sigv4.js';
import { assertOutboundAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { unescapeXml, xmlAll, xmlOne } from '../platforms/xml.js';
import { homeRegion } from './client.js';

/**
 * S3 listings of an AWS account (0.25.0, ADR 0037 part 2: object storage for data products) – **ListObjectsV2 only**:
 * the keys, sizes and last changes below a prefix, never an object's content (no GetObject, no HeadObject). The calls go
 * through the platform's request path – SigV4 for the service `s3`, the outbound policy (the endpoint is checked before
 * the first call to a bucket), the platform's proxy – and take `s3:ListBucket`, which a policy can restrict to the
 * prefixes a source names (`s3:prefix` condition, docs/AWS.md#object-storage-for-data-products).
 *
 * Where the calls go: the platform's base URL decides, as for every other AWS service (client.ts) – real AWS endpoints
 * address a bucket virtual-hosted (`https://<bucket>.s3.<region>.amazonaws.com/`, path style for a bucket with dots),
 * any other base URL (LocalStack, the demo) path style (`<base>/<bucket>`). A bucket in another region than the
 * platform's answers with its region (301 with `x-amz-bucket-region`, or 400 AuthorizationHeaderMalformed): the call is
 * made again there once, and the region is remembered for the bucket.
 */

export interface S3Page {
  keys: { key: string; size: number; lastModified: string }[];
  prefixes: string[];
  next: string | null;
}

const realAws = (p: Platform): boolean => {
  try {
    return /\.amazonaws\.com(\.cn)?$/.test(new URL(p.baseUrl ?? '').hostname);
  } catch {
    return false;
  }
};

/** The address of a bucket's listing (no query). */
export function bucketUrl(p: Platform, bucket: string, region: string): string {
  if (!realAws(p)) return `${(p.baseUrl ?? '').replace(/\/+$/, '')}/${awsEncode(bucket)}`;
  const dom = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  // a bucket name with dots does not fit the wildcard certificate of virtual-hosted addresses
  return bucket.includes('.') ? `https://s3.${region}.${dom}/${bucket}` : `https://${bucket}.s3.${region}.${dom}/`;
}

/** The region a refusal names for the bucket (a listing sent to the wrong region). */
function regionHint(r: HttpResult): string | null {
  const header = r.headers['x-amz-bucket-region'];
  if (typeof header === 'string' && /^[a-z]{2}(-[a-z]+)+-\d$/.test(header)) return header;
  const body = typeof r.body === 'string' ? r.body : '';
  const region = xmlOne(body, 'Region');
  return region && /^[a-z]{2}(-[a-z]+)+-\d$/.test(region) ? region : null;
}

function s3Error(r: HttpResult, bucket: string): Error {
  const body = typeof r.body === 'string' ? r.body : '';
  const code = xmlOne(body, 'Code');
  const message = xmlOne(body, 'Message');
  return Object.assign(
    new Error(
      `S3 ListObjectsV2 of ${bucket} failed with HTTP ${r.status}${code ? ` (${code}${message ? `: ${unescapeXml(message).slice(0, 300)}` : ''})` : ''}`,
    ),
    { status: r.status, s3Code: code ?? null },
  );
}

export class S3Lister {
  private readonly regions = new Map<string, string>();
  private readonly checked = new Set<string>();
  /** ListObjectsV2 calls made (the run's limit counts them) */
  calls = 0;

  constructor(
    private readonly p: Platform,
    private readonly secrets: Record<string, string>,
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * One page of a listing: up to `maxKeys` keys (at most 1,000) directly below `prefix` and, with a delimiter, the
   * prefixes one level down. `token` continues a listing.
   */
  async list(bucket: string, prefix: string, o: { delimiter?: '/'; token?: string | null; maxKeys?: number } = {}): Promise<S3Page> {
    const params: [string, string][] = [
      ['list-type', '2'],
      ['prefix', prefix],
      ['max-keys', String(Math.min(1_000, Math.max(1, o.maxKeys ?? 1_000)))],
      ...(o.delimiter ? ([['delimiter', o.delimiter]] as [string, string][]) : []),
      ...(o.token ? ([['continuation-token', o.token]] as [string, string][]) : []),
    ];
    const query = params
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${awsEncode(k)}=${awsEncode(v)}`)
      .join('&');
    for (let attempt = 0; ; attempt++) {
      const region = this.regions.get(bucket) ?? homeRegion(this.p);
      const base = bucketUrl(this.p, bucket, region);
      // the bucket's address must be allowed by the outbound policy (an allow-list may leave S3 out) – once per address
      if (!this.checked.has(base)) {
        await assertOutboundAllowed(base, outboundContext());
        this.checked.add(base);
      }
      this.calls++;
      const r = await platformRequest(
        this.p,
        this.secrets,
        {
          method: 'GET',
          url: `${base}?${query}`,
          aws: { service: 's3', region },
          rawText: true,
          maxResponseBytes: 8 * 1024 * 1024,
          // a listing: a read-only identity lets it through (ADR 0009)
          intent: 'read',
        },
        this.signal,
      );
      if (!r.ok) {
        const hint = attempt === 0 && (r.status === 301 || r.status === 400) ? regionHint(r) : null;
        if (hint && hint !== region) {
          this.regions.set(bucket, hint);
          continue;
        }
        throw s3Error(r, bucket);
      }
      const xml = typeof r.body === 'string' ? r.body : '';
      const keys = xmlAll(xml, 'Contents').flatMap((c) => {
        const key = unescapeXml(xmlOne(c, 'Key') ?? '');
        if (!key) return [];
        return [{ key, size: Number(xmlOne(c, 'Size') ?? 0) || 0, lastModified: xmlOne(c, 'LastModified') ?? '' }];
      });
      const prefixes = xmlAll(xml, 'CommonPrefixes')
        .map((c) => unescapeXml(xmlOne(c, 'Prefix') ?? ''))
        .filter(Boolean);
      const truncated = xmlOne(xml, 'IsTruncated') === 'true';
      const next = truncated ? unescapeXml(xmlOne(xml, 'NextContinuationToken') ?? '') || null : null;
      return { keys, prefixes, next };
    }
  }
}
