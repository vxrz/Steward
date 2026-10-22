import crypto, { X509Certificate } from 'node:crypto';
import { CERTIFICATE_MAX_BYTES, type CertificateInfo, type CertificateSummary } from '@sm/shared';
import { HttpError } from '../util.js';

/**
 * Public certificates for the credentials register: PEM (one certificate or a
 * chain), CRT or DER. Only the parsed metadata is kept – subject, issuer,
 * serial, SHA-256 fingerprint, SANs and validity – not the file: the register
 * documents a certificate, it is not a certificate store, and metadata cannot
 * be mistaken for (or turned into) a deployable credential.
 *
 * Anything that contains a private key is rejected, so a key never reaches the
 * database, the audit log or a backup by accident.
 */

const CERT_LABELS = ['CERTIFICATE', 'X509 CERTIFICATE', 'TRUSTED CERTIFICATE'];
/** Certificates per file (a chain); the PEM scan gives up after one more BEGIN line. */
const MAX_CERTS = 20;
const PRIVATE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|-----BEGIN PKCS12-----/;

export class CertificateError extends HttpError {
  constructor(message: string, code = 'CERTIFICATE_INVALID') {
    super(400, message, code);
  }
}

const iso = (s: string) => new Date(s).toISOString();

/**
 * The certificate PEM blocks of a text, in one linear pass with indexOf (a lazy regex rescans the rest of
 * the text for every BEGIN line without an END – quadratic). At most MAX_CERTS + 1 BEGIN lines are
 * looked at; more means "too many certificates".
 */
function pemCertificates(text: string): string[] {
  const blocks: string[] = [];
  let begins = 0;
  for (let i = text.indexOf('-----BEGIN '); i !== -1;) {
    if (++begins > MAX_CERTS + 1) throw new CertificateError(`Too many certificates in the file (max. ${MAX_CERTS})`);
    const labelEnd = text.indexOf('-----', i + 11);
    if (labelEnd === -1) break;
    const label = text.slice(i + 11, labelEnd);
    const next = text.indexOf('-----BEGIN ', labelEnd + 5);
    if (CERT_LABELS.includes(label)) {
      // the END line of this block, before the next BEGIN line
      const end = text.indexOf('-----END ', labelEnd + 5);
      if (end !== -1 && (next === -1 || end < next)) {
        const endLabelEnd = text.indexOf('-----', end + 9);
        if (endLabelEnd !== -1 && CERT_LABELS.includes(text.slice(end + 9, endLabelEnd))) blocks.push(text.slice(i, endLabelEnd + 5));
      }
    }
    i = next;
  }
  return blocks;
}

function summary(c: X509Certificate): CertificateSummary {
  return {
    subject: c.subject.replace(/\n/g, ', '),
    issuer: c.issuer.replace(/\n/g, ', '),
    serialNumber: c.serialNumber,
    fingerprint256: c.fingerprint256,
    notBefore: iso(c.validFrom),
    notAfter: iso(c.validTo),
  };
}

/** True when the DER bytes are a private key (PKCS#8, PKCS#1 or SEC1) instead of a certificate. */
function derIsPrivateKey(der: Buffer): boolean {
  for (const type of ['pkcs8', 'pkcs1', 'sec1'] as const) {
    try {
      crypto.createPrivateKey({ key: der, format: 'der', type });
      return true;
    } catch {
      /* not this kind */
    }
  }
  return false;
}

/** A PKCS#12/PFX file starts with a SEQUENCE whose first element is INTEGER 3 (version). */
function looksLikePkcs12(der: Buffer): boolean {
  if (der[0] !== 0x30) return false;
  let i = 1;
  const len = der[i]!;
  i += len & 0x80 ? 1 + (len & 0x7f) : 1;
  return der[i] === 0x02 && der[i + 1] === 0x01 && der[i + 2] === 0x03;
}

/** Parses an uploaded certificate (chain). The leaf is the first certificate. */
export function parseCertificate(data: Buffer): CertificateInfo {
  if (!data.length) throw new CertificateError('The file is empty');
  if (data.length > CERTIFICATE_MAX_BYTES) throw new CertificateError(`The file is too large (max. ${CERTIFICATE_MAX_BYTES / 1024} KB)`);
  const text = data.toString('latin1');
  if (PRIVATE.test(text)) {
    throw new CertificateError(
      'The file contains a private key. Steward only documents certificates: upload the public certificate (PEM/CRT/DER) and keep the key where it belongs (e.g. KeePass).',
      'PRIVATE_KEY_REJECTED',
    );
  }
  let certs: X509Certificate[];
  if (text.includes('-----BEGIN')) {
    const blocks = pemCertificates(text);
    if (!blocks.length) throw new CertificateError('No certificate found – expected a PEM block "-----BEGIN CERTIFICATE-----"');
    if (blocks.length > MAX_CERTS) throw new CertificateError(`Too many certificates in the file (max. ${MAX_CERTS})`);
    try {
      certs = blocks.map((b) => new X509Certificate(b));
    } catch {
      throw new CertificateError('The certificate could not be read (invalid PEM)');
    }
  } else {
    if (derIsPrivateKey(data)) {
      throw new CertificateError('The file is a private key. Upload the public certificate only.', 'PRIVATE_KEY_REJECTED');
    }
    try {
      certs = [new X509Certificate(data)];
    } catch {
      if (looksLikePkcs12(data)) {
        throw new CertificateError(
          'This looks like a PKCS#12 (.pfx/.p12) file, which contains the private key. Export the public certificate only (e.g. openssl pkcs12 -in file.pfx -nokeys -clcerts).',
          'PRIVATE_KEY_REJECTED',
        );
      }
      throw new CertificateError('The file is not a certificate (expected PEM, CRT or DER)');
    }
  }
  const [leaf, ...rest] = certs as [X509Certificate, ...X509Certificate[]];
  const sans = (leaf.subjectAltName ?? '')
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200);
  const chainNotAfter = certs.map((c) => Date.parse(c.validTo)).reduce((a, b) => Math.min(a, b));
  return {
    ...summary(leaf),
    subjectAltNames: sans,
    isCA: leaf.ca,
    selfSigned:
      leaf.subject === leaf.issuer &&
      (() => {
        try {
          return leaf.verify(leaf.publicKey);
        } catch {
          return false;
        }
      })(),
    chain: rest.map(summary),
    chainNotAfter: new Date(chainNotAfter).toISOString(),
  };
}

/** Accepts base64 (DER or PEM) or a PEM string. */
export function certificateBytes(input: { contentBase64?: string; pem?: string }): Buffer {
  if (input.pem) return Buffer.from(input.pem, 'utf8');
  if (input.contentBase64) return Buffer.from(input.contentBase64, 'base64');
  throw new CertificateError('No certificate given');
}
