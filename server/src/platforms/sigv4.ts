import crypto from 'node:crypto';

/**
 * AWS Signature Version 4 (#114), written out instead of pulling in the AWS SDK: every request to a platform with the
 * auth type aws_sigv4 is signed right before it is sent, over the exact body that goes over the wire. Checked against
 * the examples of AWS's documentation (server/test/platform-auth.test.ts).
 *
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as AWS wants it (encodeURIComponent leaves !'()* alone). */
export const awsEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The signing key for a day, region and service. */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

function canonicalPath(pathname: string, service: string): string {
  if (!pathname) return '/';
  // S3 takes the path as it is (encoded once); every other service wants each segment encoded twice
  if (service === 's3') return pathname;
  return pathname
    .split('/')
    .map((seg) => awsEncode(decodeURIComponentSafe(seg)))
    .map((seg) => awsEncode(seg))
    .join('/');
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function canonicalQuery(params: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of params) pairs.push([awsEncode(k), awsEncode(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Signs a request: adds x-amz-date (and x-amz-security-token with temporary credentials, x-amz-content-sha256 for S3)
 * and the Authorization header to `headers` (lower-case names). Signs host, content-type, content-md5 and the x-amz-*
 * headers.
 */
export function signRequest(
  r: { method: string; url: string; headers: Record<string, string>; body?: string | Buffer },
  o: { region: string; service: string; credentials: AwsCredentials; now?: Date; unsignedPayload?: boolean },
): void {
  const u = new URL(r.url);
  const now = o.now ?? new Date();
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);
  const payloadHash = o.unsignedPayload ? 'UNSIGNED-PAYLOAD' : sha256(r.body ?? '');
  r.headers['x-amz-date'] = stamp;
  if (o.credentials.sessionToken) r.headers['x-amz-security-token'] = o.credentials.sessionToken;
  if (o.service === 's3') r.headers['x-amz-content-sha256'] = payloadHash;
  delete r.headers.authorization;
  const signed: [string, string][] = [['host', u.host]];
  for (const [k, v] of Object.entries(r.headers)) {
    const name = k.toLowerCase();
    if (name === 'host') continue;
    if (name.startsWith('x-amz-') || name === 'content-type' || name === 'content-md5') signed.push([name, String(v).trim().replace(/\s+/g, ' ')]);
  }
  signed.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const signedHeaders = signed.map(([k]) => k).join(';');
  const canonical = [
    r.method.toUpperCase(),
    canonicalPath(u.pathname, o.service),
    canonicalQuery(u.searchParams),
    signed.map(([k, v]) => `${k}:${v}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(o.credentials.secretAccessKey, day, o.region, o.service))
    .update(toSign)
    .digest('hex');
  r.headers.authorization = `AWS4-HMAC-SHA256 Credential=${o.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** The temporary credentials in an STS AssumeRole answer (XML). */
export function parseAssumeRole(xml: string): (AwsCredentials & { expiration: number }) | null {
  const tag = (name: string) => {
    const open = `<${name}>`;
    const from = xml.indexOf(open);
    if (from < 0) return null;
    const to = xml.indexOf(`</${name}>`, from);
    return to < 0 ? null : xml.slice(from + open.length, to).trim();
  };
  const accessKeyId = tag('AccessKeyId');
  const secretAccessKey = tag('SecretAccessKey');
  const sessionToken = tag('SessionToken');
  const expiration = Date.parse(tag('Expiration') ?? '');
  return accessKeyId && secretAccessKey && sessionToken && Number.isFinite(expiration) ? { accessKeyId, secretAccessKey, sessionToken, expiration } : null;
}
