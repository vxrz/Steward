import fs from 'node:fs';
import type { Platform } from '@sm/shared';
import { platformRequest, type HttpResult } from '../platforms/http.js';
import { unescapeXml, xmlAll, xmlOne } from '../platforms/xml.js';

/**
 * The few S3 calls backups need (#117), over the platform request layer – so the platform's proxy, outbound policy and
 * AWS SigV4 signing (auth type aws_sigv4, service s3) apply as for every other call. The platform's base URL is the
 * bucket: https://<bucket>.s3.<region>.amazonaws.com (virtual-hosted) or https://<host>/<bucket> (path style:
 * MinIO, Ceph, most S3-compatible storage).
 */

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

/** Objects up to this size go up in one PUT; larger ones as a multipart upload in parts of PART_BYTES. */
export const SINGLE_PUT_MAX = Number(process.env.SM_BACKUP_SINGLE_PUT_BYTES) || 32 * 1024 * 1024;
export const PART_BYTES = Math.max(Number(process.env.SM_BACKUP_PART_BYTES) || 16 * 1024 * 1024, 1024);

/** Object keys Steward writes: letters, digits and . _ - / only, so the URL path and the signature need no escaping. */
export function checkKey(key: string): string {
  if (!/^[A-Za-z0-9._\-/]{1,900}$/.test(key) || key.startsWith('/') || key.split('/').some((p) => p === '..' || p === '.'))
    throw new Error(`Invalid object key "${key.slice(0, 100)}"`);
  return key;
}

function s3Error(what: string, r: HttpResult): Error {
  const body = typeof r.body === 'string' ? r.body : '';
  const code = xmlOne(body, 'Code');
  const message = xmlOne(body, 'Message');
  return Object.assign(new Error(`S3 ${what} failed with HTTP ${r.status}${code ? ` (${code}${message ? `: ${unescapeXml(message)}` : ''})` : ''}`), {
    status: r.status,
    s3Code: code,
  });
}

export class S3Client {
  constructor(
    private readonly p: Platform,
    private readonly secrets: Record<string, string>,
  ) {}

  private req(method: string, url: string, o: { body?: Buffer | string; headers?: Record<string, string>; file?: string; text?: boolean } = {}) {
    return platformRequest(this.p, this.secrets, {
      method,
      url,
      headers: o.headers,
      ...(o.body !== undefined ? { body: o.body, bodyType: Buffer.isBuffer(o.body) ? 'binary' : 'text' } : {}),
      ...(o.file ? { responseFile: o.file } : {}),
      rawText: true,
    });
  }

  /** Uploads a file (one PUT, or multipart above SINGLE_PUT_MAX). `meta` becomes x-amz-meta-* headers. */
  async putFile(key: string, file: string, meta: Record<string, string> = {}): Promise<{ parts: number }> {
    checkKey(key);
    const size = (await fs.promises.stat(file)).size;
    const metaHeaders = Object.fromEntries(Object.entries(meta).map(([k, v]) => [`x-amz-meta-${k.toLowerCase()}`, v]));
    if (size <= SINGLE_PUT_MAX) {
      const r = await this.req('PUT', `/${key}`, {
        body: await fs.promises.readFile(file),
        headers: { 'content-type': 'application/octet-stream', ...metaHeaders },
      });
      if (!r.ok) throw s3Error(`upload of ${key}`, r);
      return { parts: 1 };
    }
    const start = await this.req('POST', `/${key}?uploads`, { headers: { 'content-type': 'application/octet-stream', ...metaHeaders } });
    const uploadId = start.ok && typeof start.body === 'string' ? xmlOne(start.body, 'UploadId') : undefined;
    if (!uploadId) throw s3Error(`multipart upload of ${key}`, start);
    const id = encodeURIComponent(unescapeXml(uploadId));
    const etags: string[] = [];
    const fh = await fs.promises.open(file, 'r');
    try {
      for (let pos = 0, n = 1; pos < size; pos += PART_BYTES, n++) {
        const buf = Buffer.alloc(Math.min(PART_BYTES, size - pos));
        await fh.read(buf, 0, buf.length, pos);
        const r = await this.req('PUT', `/${key}?partNumber=${n}&uploadId=${id}`, { body: buf });
        if (!r.ok || !r.headers.etag) throw s3Error(`upload of part ${n} of ${key}`, r);
        etags.push(r.headers.etag);
      }
      const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const done = await this.req('POST', `/${key}?uploadId=${id}`, { body: xml, headers: { 'content-type': 'application/xml' } });
      // S3 can answer 200 with an error in the body
      if (!done.ok || (typeof done.body === 'string' && done.body.includes('<Error>'))) throw s3Error(`completing the upload of ${key}`, done);
      return { parts: etags.length };
    } catch (e) {
      await this.req('DELETE', `/${key}?uploadId=${id}`).catch(() => undefined);
      throw e;
    } finally {
      await fh.close();
    }
  }

  /** Downloads an object into a file; returns its size, SHA-256 and metadata. */
  async getFile(key: string, file: string): Promise<{ bytes: number; sha256: string; meta: Record<string, string> }> {
    checkKey(key);
    const r = await this.req('GET', `/${key}`, { file });
    if (!r.ok) throw s3Error(`download of ${key}`, r);
    const meta = Object.fromEntries(
      Object.entries(r.headers)
        .filter(([k]) => k.startsWith('x-amz-meta-'))
        .map(([k, v]) => [k.slice('x-amz-meta-'.length), v]),
    );
    return { ...(r.body as { bytes: number; sha256: string }), meta };
  }

  /** All objects under a prefix (ListObjectsV2, paged). */
  async list(prefix: string, max = 10000): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) });
      const r = await this.req('GET', `/?${q.toString()}`);
      if (!r.ok || typeof r.body !== 'string') throw s3Error('listing the backups', r);
      for (const c of xmlAll(r.body, 'Contents')) {
        const key = unescapeXml(xmlOne(c, 'Key') ?? '');
        if (key) out.push({ key, size: Number(xmlOne(c, 'Size') ?? 0), lastModified: xmlOne(c, 'LastModified') ?? '' });
      }
      token = xmlOne(r.body, 'IsTruncated') === 'true' ? unescapeXml(xmlOne(r.body, 'NextContinuationToken') ?? '') || undefined : undefined;
    } while (token && out.length < max);
    return out;
  }

  /** Deletes an object; an object kept by S3 Object Lock (403 AccessDenied) is reported, not thrown. */
  async delete(key: string): Promise<{ deleted: boolean; locked?: boolean }> {
    checkKey(key);
    const r = await this.req('DELETE', `/${key}`);
    if (r.ok) return { deleted: true };
    if (r.status === 403) return { deleted: false, locked: true };
    throw s3Error(`deleting ${key}`, r);
  }
}
