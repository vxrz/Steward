/**
 * Conservative detection of secret values in free text of the credentials
 * register. The register documents credentials; it must never hold one. The
 * patterns follow gitleaks' rules for the most common, unambiguous formats; the
 * generic rule only fires on long, random-looking tokens, so ordinary text,
 * KeePass paths, URLs, hostnames, UUIDs and hex fingerprints pass.
 *
 * The matched value is never echoed: callers get the kind of secret only.
 */

interface Rule {
  id: string;
  /** Human description for the error message */
  label: string;
  re: RegExp;
}

const RULES: Rule[] = [
  { id: 'private-key', label: 'a private key block', re: /-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'pkcs12', label: 'a private key container (PKCS#12)', re: /-----BEGIN PKCS12-----/ },
  { id: 'jwt', label: 'a JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'github-token', label: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/ },
  { id: 'gitlab-token', label: 'a GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'aws-access-key', label: 'an AWS access key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { id: 'aws-secret', label: 'an AWS secret access key', re: /aws.{0,20}?(?:secret|key).{0,20}?[:=]\s*["']?[A-Za-z0-9/+]{40}\b/i },
  { id: 'slack-token', label: 'a Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'slack-webhook', label: 'a Slack webhook URL', re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/ },
  { id: 'google-api-key', label: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-key', label: 'a Stripe key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/ },
  { id: 'openai-key', label: 'an API key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'azure-storage', label: 'an Azure storage account key', re: /AccountKey=[A-Za-z0-9+/]{80,}={0,2}/ },
  { id: 'npm-token', label: 'an npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'url-password', label: 'a password in a URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@[^\s/]+/i },
  { id: 'steward-token', label: 'a Steward API token or secret', re: /\b(?:smt|mhs|mgw|whs)_[A-Za-z0-9_-]{20,}\b/ },
];

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const classes = (s: string): number => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;

/** Long random-looking token: ≥ 32 chars of a base64/base64url alphabet, mixed case and digits, high entropy. */
function randomToken(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const tok = m[0];
    if (/^[0-9a-fA-F-]+$/.test(tok)) continue; // hex: hashes, fingerprints, UUIDs
    if (!/[a-z]/.test(tok) || !/[A-Z]/.test(tok) || !/[0-9]/.test(tok)) continue;
    if (tok.includes('/') && tok.split('/').every((part) => /^[A-Za-z0-9._-]{0,40}$/.test(part)) && tok.split('/').length > 2) continue; // a path
    if (entropy(tok) >= 4.5) return true;
  }
  return false;
}

/** `password: Summer2024!`, `client_secret = …`: the value must look like a password (3+ character classes, no path or URL). */
function assignedSecret(text: string): boolean {
  const re =
    /\b(?:password|passwd|passwort|kennwort|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token)\b\s*[:=]\s*["']?([^\s"'<>]{8,})/gi;
  for (const m of text.matchAll(re)) {
    const v = m[1]!;
    if (/^(https?|keepass|kdbx|file):/i.test(v) || /[\\/]/.test(v)) continue;
    if (/^\*+$/.test(v) || /^(see|in|stored|siehe|unknown|n\/a|none|tbd)/i.test(v)) continue;
    if (classes(v) >= 3) return true;
  }
  return false;
}

/** Returns a description of the kind of secret found, or null. */
export function findSecret(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const r of RULES) if (r.re.test(text)) return r.label;
  if (assignedSecret(text)) return 'a password or key value';
  if (randomToken(text)) return 'a long random token (it looks like a key or password)';
  return null;
}

export class SecretFoundError extends Error {
  constructor(
    public field: string,
    public kind: string,
  ) {
    super(`"${field}" looks like it contains ${kind}. Do not enter passwords or keys – document where they are kept (e.g. the KeePass database and entry).`);
  }
}

/** Throws SecretFoundError for the first field that contains something secret-looking. */
export function assertNoSecrets(fields: Record<string, string | null | undefined | string[]>): void {
  for (const [field, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      const kind = findSecret(v);
      if (kind) throw new SecretFoundError(field, kind);
    }
  }
}
