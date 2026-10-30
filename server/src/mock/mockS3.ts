import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { signRequest } from '../platforms/sigv4.js';
import { escapeXml } from '../platforms/xml.js';

/**
 * A small S3 for the demo and the tests (#117): path-style buckets under /mock/s3/<bucket>, objects in memory.
 * PUT/GET/DELETE of objects, ListObjectsV2 and multipart uploads. Every request must be signed with AWS SigV4 for the
 * demo key AKIADEMOEXAMPLE / demoSecretKey (service s3): the mock recomputes the signature from the request as it
 * arrived and checks x-amz-content-sha256 against the body. A bucket whose name ends in "-locked" refuses deletes
 * like a bucket with S3 Object Lock.
 */

export const DEMO_S3 = { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey', bucket: 'steward-backups', region: 'eu-central-1' };

interface Obj {
  body: Buffer;
  meta: Record<string, string>;
  lastModified: Date;
}

const buckets = new Map<string, Map<string, Obj>>();
const uploads = new Map<string, { bucket: string; key: string; meta: Record<string, string>; parts: Map<number, Buffer> }>();

const bucket = (name: string) => {
  let b = buckets.get(name);
  if (!b) buckets.set(name, (b = new Map()));
  return b;
};

/** For tests: the objects of a bucket, and changing one in place. */
export const mockS3Objects = (name = DEMO_S3.bucket): Map<string, Obj> => bucket(name);
export function resetMockS3(): void {
  buckets.clear();
  uploads.clear();
}

const xmlEscape = escapeXml;
const etagOf = (b: Buffer) => `"${crypto.createHash('md5').update(b).digest('hex')}"`;

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply
    .code(status)
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`);
}

/** Recomputes the SigV4 signature of the request as it arrived. */
function signatureOk(req: FastifyRequest, body: Buffer): string | null {
  const auth = String(req.headers.authorization ?? '');
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=[0-9a-f]{64}$/.exec(auth);
  if (!m) return 'missing or malformed SigV4 Authorization header';
  if (m[1] !== DEMO_S3.accessKeyId) return 'unknown access key';
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  if (req.headers['x-amz-content-sha256'] !== sha && req.headers['x-amz-content-sha256'] !== 'UNSIGNED-PAYLOAD')
    return 'x-amz-content-sha256 does not match the body';
  const stamp = String(req.headers['x-amz-date'] ?? '');
  const now = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
  if (Number.isNaN(now.getTime()) || Math.abs(Date.now() - now.getTime()) > 15 * 60_000) return 'x-amz-date missing or too far off';
  const headers: Record<string, string> = {};
  for (const h of m[4]!.split(';')) if (h !== 'host' && h !== 'x-amz-date' && h !== 'x-amz-content-sha256') headers[h] = String(req.headers[h] ?? '');
  const again = { method: req.method, url: `http://${req.headers.host}${req.url}`, headers, body };
  signRequest(again, {
    region: m[3]!,
    service: 's3',
    credentials: { accessKeyId: DEMO_S3.accessKeyId, secretAccessKey: DEMO_S3.secretAccessKey },
    now,
    unsignedPayload: req.headers['x-amz-content-sha256'] === 'UNSIGNED-PAYLOAD',
  });
  return again.headers.authorization === auth ? null : 'signature does not match';
}

export async function mockS3(app: FastifyInstance): Promise<void> {
  await app.register(
    async (s3) => {
      s3.removeAllContentTypeParsers();
      s3.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 }, (_req, body, done) => done(null, body));
      const handler = async (req: FastifyRequest, reply: FastifyReply) => {
        const { bucket: name, '*': rest } = req.params as { bucket: string; '*'?: string };
        const key = rest ?? '';
        const q = req.query as Record<string, string | undefined>;
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const bad = signatureOk(req, body);
        if (bad) return error(reply, 403, 'SignatureDoesNotMatch', bad);
        const b = bucket(name);
        const meta = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-amz-meta-'))) as Record<string, string>;
        if (!key) {
          if (req.method !== 'GET' || q['list-type'] !== '2') return error(reply, 400, 'InvalidRequest', 'only ListObjectsV2 on the bucket');
          const prefix = q.prefix ?? '';
          const keys = [...b.keys()].filter((k) => k.startsWith(prefix)).sort();
          const start = q['continuation-token'] ? keys.indexOf(q['continuation-token']) : 0;
          const page = keys.slice(Math.max(0, start), Math.max(0, start) + 2);
          const next = keys[Math.max(0, start) + 2];
          return reply.type('application/xml').send(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xmlEscape(name)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${xmlEscape(next)}</NextContinuationToken>` : ''}${page
              .map((k) => {
                const o = b.get(k)!;
                return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>${etagOf(o.body)}</ETag><Size>${o.body.length}</Size></Contents>`;
              })
              .join('')}</ListBucketResult>`,
          );
        }
        if (req.method === 'POST' && 'uploads' in q) {
          const id = crypto.randomBytes(12).toString('base64url');
          uploads.set(id, { bucket: name, key, meta, parts: new Map() });
          return reply
            .type('application/xml')
            .send(
              `<InitiateMultipartUploadResult><Bucket>${name}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
            );
        }
        if (q.uploadId) {
          const u = uploads.get(q.uploadId);
          if (!u || u.key !== key || u.bucket !== name) return error(reply, 404, 'NoSuchUpload', 'unknown upload');
          if (req.method === 'PUT') {
            u.parts.set(Number(q.partNumber), body);
            return reply.header('etag', etagOf(body)).send();
          }
          if (req.method === 'DELETE') {
            uploads.delete(q.uploadId);
            return reply.code(204).send();
          }
          if (req.method === 'POST') {
            const xml = body.toString('utf8');
            const numbers = [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((x) => Number(x[1]));
            if (!numbers.length || numbers.some((n, i) => n !== i + 1 || !u.parts.has(n)))
              return error(reply, 400, 'InvalidPart', 'parts missing or out of order');
            b.set(key, { body: Buffer.concat(numbers.map((n) => u.parts.get(n)!)), meta: u.meta, lastModified: new Date() });
            uploads.delete(q.uploadId);
            return reply.type('application/xml').send(`<CompleteMultipartUploadResult><Key>${xmlEscape(key)}</Key></CompleteMultipartUploadResult>`);
          }
        }
        if (req.method === 'PUT') {
          b.set(key, { body, meta, lastModified: new Date() });
          return reply.header('etag', etagOf(body)).send();
        }
        const o = b.get(key);
        if (req.method === 'DELETE') {
          if (name.endsWith('-locked')) return error(reply, 403, 'AccessDenied', 'Access Denied because object protected by object lock.');
          b.delete(key);
          return reply.code(204).send();
        }
        if (!o) return error(reply, 404, 'NoSuchKey', 'The specified key does not exist.');
        for (const [k, v] of Object.entries(o.meta)) reply.header(k, v);
        return reply.type('application/octet-stream').header('etag', etagOf(o.body)).send(o.body);
      };
      s3.route({ method: ['GET', 'PUT', 'POST', 'DELETE'], url: '/:bucket', handler });
      s3.route({ method: ['GET', 'PUT', 'POST', 'DELETE'], url: '/:bucket/*', handler });
    },
    { prefix: '/s3' },
  );
}
