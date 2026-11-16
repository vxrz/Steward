import crypto from 'node:crypto';

/**
 * PEM text from a platform secret (0.26.2). A browser drops the line breaks of text pasted into a single-line field
 * (HTML value sanitisation), so a private key entered in a password field before 0.26.2 was stored as one line, which
 * OpenSSL cannot decode (`DECODER routines::unsupported`). normalizePem restores the structure of every PEM block
 * whose line breaks were removed or replaced by spaces – BEGIN line, RFC 1421 headers (Proc-Type, DEK-Info) and an
 * empty line, the base64 body wrapped at 64 characters, END line – and leaves a block with line breaks as it is. It
 * runs where the secret is parsed, so keys saved on one line work without being entered again.
 *
 * One linear pass with indexOf (like the certificate scan in credentials/certificates.ts), no regular expression on
 * the text, and the text is bounded (PEM_MAX_CHARS). Errors never contain key material.
 */

/** A private key, a certificate or a short chain fits easily; more is not a PEM secret. */
export const PEM_MAX_CHARS = 64 * 1024;
/** Longer labels than "ENCRYPTED PRIVATE KEY" exist (X509 CRL, TRUSTED CERTIFICATE …), none near this. */
const LABEL_MAX = 64;

export class PemError extends Error {}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
const isLabelChar = (c: number) => (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 32;
const isCipherChar = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isBase64 = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;

/** The text without any whitespace (spaces, tabs, line breaks). */
function stripSpace(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) if (!isSpace(s.charCodeAt(i))) out += s[i];
  return out;
}

function isBlank(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (!isSpace(s.charCodeAt(i))) return false;
  return true;
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  return i;
}

/**
 * Length in hex digits of the IV in a DEK-Info header – the cipher's IV length (AES: 16 bytes, DES and 3DES: 8).
 * Fixed by the cipher, so the IV is found where the newline before the base64 body is gone; never guessed from the
 * characters (the body may start with hex-looking ones).
 */
export function dekInfoIvHexLength(cipher: string): number {
  const name = cipher.toUpperCase();
  if (name.startsWith('AES-')) return 32;
  if (name === 'DES-CBC' || name === 'DES-EDE3-CBC' || name === 'DES-EDE-CBC') return 16;
  let iv: number | undefined;
  try {
    iv = crypto.getCipherInfo(name.toLowerCase())?.ivLength;
  } catch {
    iv = undefined;
  }
  if (!iv) throw new PemError(`The PEM header DEK-Info names a cipher Steward does not know (${name.slice(0, 40)})`);
  return iv * 2;
}

/** Proc-Type and DEK-Info at the start of a block's body, and where the base64 starts. */
function headersOf(body: string): { headers: string[]; rest: string } {
  let i = skipSpace(body, 0);
  if (!body.startsWith('Proc-Type:', i)) {
    // base64 has no colon: one means a header this repair does not know
    if (body.indexOf(':') !== -1) throw new PemError('The PEM block has a header other than Proc-Type and DEK-Info');
    return { headers: [], rest: body };
  }
  const dek = body.indexOf('DEK-Info:', i);
  if (dek === -1) throw new PemError('The PEM block has a Proc-Type header but no DEK-Info header');
  const procType = stripSpace(body.slice(i + 'Proc-Type:'.length, dek));
  i = skipSpace(body, dek + 'DEK-Info:'.length);
  const comma = body.indexOf(',', i);
  if (comma === -1 || comma - i > 40) throw new PemError('The PEM header DEK-Info has no cipher and IV');
  const cipher = body.slice(i, comma).trim();
  for (let k = 0; k < cipher.length; k++) if (!isCipherChar(cipher.charCodeAt(k))) throw new PemError('The PEM header DEK-Info has no valid cipher name');
  if (!cipher) throw new PemError('The PEM header DEK-Info has no valid cipher name');
  const ivLen = dekInfoIvHexLength(cipher);
  const ivStart = skipSpace(body, comma + 1);
  const iv = body.slice(ivStart, ivStart + ivLen);
  if (iv.length !== ivLen) throw new PemError('The IV in the PEM header DEK-Info is too short');
  for (let k = 0; k < iv.length; k++) if (!isHex(iv.charCodeAt(k))) throw new PemError('The IV in the PEM header DEK-Info is not hexadecimal');
  return { headers: [`Proc-Type: ${procType}`, `DEK-Info: ${cipher.toUpperCase()},${iv.toUpperCase()}`], rest: body.slice(ivStart + ivLen) };
}

/** A block's body rebuilt: headers, an empty line, the base64 wrapped at 64 characters. */
function rebuild(label: string, body: string): string {
  const { headers, rest } = headersOf(body);
  const b64 = stripSpace(rest);
  for (let k = 0; k < b64.length; k++) if (!isBase64(b64.charCodeAt(k))) throw new PemError('The body of a PEM block is not base64');
  const lines: string[] = [];
  for (let k = 0; k < b64.length; k += 64) lines.push(b64.slice(k, k + 64));
  return `-----BEGIN ${label}-----\n${headers.length ? `${headers.join('\n')}\n\n` : ''}${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** The labels of the PEM blocks in a text (BEGIN lines only), at most a few – for error messages. */
export function pemLabels(text: string): string[] {
  const labels: string[] = [];
  for (let i = text.indexOf('-----BEGIN '); i !== -1 && labels.length < 10;) {
    const end = text.indexOf('-----', i + 11);
    if (end === -1 || end - i - 11 > LABEL_MAX) break;
    labels.push(text.slice(i + 11, end));
    i = text.indexOf('-----BEGIN ', end + 5);
  }
  return labels;
}

/**
 * The PEM text with the structure of each block restored (see above). Text without a PEM block is returned as it is
 * (the parser then says what is wrong); a block that has line breaks is kept unchanged, CRLF included. Whitespace
 * outside the blocks is dropped when a block is rebuilt, other text outside them is kept.
 */
export function normalizePem(text: string): string {
  if (text.length > PEM_MAX_CHARS) throw new PemError(`The PEM text is too long (max. ${PEM_MAX_CHARS / 1024} KB)`);
  if (text.indexOf('-----BEGIN ') === -1) return text;
  const parts: string[] = [];
  let changed = false;
  let pos = 0;
  for (let i = text.indexOf('-----BEGIN '); i !== -1; i = text.indexOf('-----BEGIN ', pos)) {
    const labelEnd = text.indexOf('-----', i + 11);
    if (labelEnd === -1 || labelEnd - i - 11 > LABEL_MAX) break;
    const label = text.slice(i + 11, labelEnd);
    let ok = label.length > 0;
    for (let k = 0; ok && k < label.length; k++) ok = isLabelChar(label.charCodeAt(k));
    const endLine = `-----END ${label}-----`;
    const end = ok ? text.indexOf(endLine, labelEnd + 5) : -1;
    // not a block (or no END line): the rest stays as it is
    if (end === -1) break;
    const outside = text.slice(pos, i);
    const body = text.slice(labelEnd + 5, end);
    if (body.indexOf('\n') !== -1) {
      parts.push(outside, text.slice(i, end + endLine.length));
    } else {
      changed = true;
      if (!isBlank(outside)) parts.push(outside.endsWith('\n') ? outside : `${outside}\n`);
      parts.push(rebuild(label, body));
    }
    pos = end + endLine.length;
  }
  if (!changed) return text;
  const tail = text.slice(pos);
  if (!isBlank(tail)) parts.push(tail);
  // a block that kept its line breaks, followed by a rebuilt one: the rebuilt one starts on a line of its own
  let out = '';
  for (const p of parts) out += out && !out.endsWith('\n') && p.startsWith('-----BEGIN ') ? `\n${p}` : p;
  return out.endsWith('\n') ? out : `${out}\n`;
}

/** A passphrase pasted from a file: without its trailing line break (CR/LF only – other characters are part of it). */
export function pemPassphrase(passphrase: string | undefined): string | undefined {
  if (passphrase === undefined) return undefined;
  let end = passphrase.length;
  while (end > 0 && (passphrase.charCodeAt(end - 1) === 10 || passphrase.charCodeAt(end - 1) === 13)) end--;
  return end ? passphrase.slice(0, end) : undefined;
}

/** PEM blocks that are not a private key, named in the error when one is given instead. */
const OTHER_LABELS = ['CERTIFICATE', 'TRUSTED CERTIFICATE', 'X509 CERTIFICATE', 'CERTIFICATE REQUEST', 'PUBLIC KEY', 'RSA PUBLIC KEY', 'X509 CRL', 'PKCS7'];

const FORMATS =
  'expected the text of a PEM file: PKCS#8 (BEGIN PRIVATE KEY, or BEGIN ENCRYPTED PRIVATE KEY with a passphrase) or PKCS#1 (BEGIN RSA PRIVATE KEY, also encrypted), or SEC1 (BEGIN EC PRIVATE KEY) – not an OpenSSH or PuTTY key, not DER';

/**
 * A private key from a platform secret (PEM, optionally encrypted), with an error that says what is wrong – never the
 * key. `names` are the secrets it comes from, for the messages.
 */
export function readPrivateKey(
  pem: string | undefined,
  passphrase: string | undefined,
  names: { key: string; passphrase: string } = { key: 'privateKey', passphrase: 'privateKeyPassphrase' },
): crypto.KeyObject {
  if (!pem?.trim()) throw new Error(`Secret "${names.key}" (PEM) is not set`);
  const fail = (why: string) => new Error(`The private key cannot be read (secret ${names.key}): ${why}`);
  if (pem.includes('-----BEGIN OPENSSH PRIVATE KEY-----'))
    throw fail('this is an OpenSSH key – convert a copy of the key file to PEM with ssh-keygen -p -m PEM -f <copy> (or -m PKCS8) and paste that');
  if (pem.includes('PuTTY-User-Key-File')) throw fail(`this is a PuTTY key (.ppk) – export it as PEM (puttygen, Conversions); ${FORMATS}`);
  if (!pem.includes('-----BEGIN ')) throw fail(FORMATS);
  let text: string;
  try {
    text = normalizePem(pem);
  } catch (e) {
    throw fail((e as Error).message);
  }
  const pass = pemPassphrase(passphrase);
  try {
    return crypto.createPrivateKey({ key: text, format: 'pem', ...(pass ? { passphrase: pass } : {}) });
  } catch (e) {
    // OpenSSL's messages name the reason only (no key material)
    const msg = (e as Error).message;
    const labels = pemLabels(text);
    // an encrypted key: with a wrong passphrase OpenSSL mostly says "bad decrypt", now and then (the padding happened
    // to fit) that the decrypted bytes are no key – either way the passphrase is what to check
    const encrypted = labels.includes('ENCRYPTED PRIVATE KEY') || text.includes('Proc-Type: 4,ENCRYPTED') || /bad decrypt/i.test(msg);
    if (encrypted && pass) throw fail(`the passphrase does not decrypt it – check the passphrase (secret ${names.passphrase})`);
    if (encrypted || /interrupted or cancelled/i.test(msg)) throw fail(`it is encrypted and needs the secret ${names.passphrase}`);
    if (labels.length && !labels.some((l) => l.endsWith('PRIVATE KEY'))) {
      // only a label Steward knows is named (whatever stands between BEGIN and the dashes could be part of a key)
      const known = labels.filter((l) => OTHER_LABELS.includes(l));
      throw fail(`it holds ${known.length ? [...new Set(known)].join(', ') : 'no PEM block of a private key'}, not a private key`);
    }
    throw fail(`${FORMATS} (${msg.slice(0, 120)})`);
  }
}
