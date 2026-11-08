/**
 * Removing secrets from what a step sends to a model (docs/AI.md#allowed-data): the run's known secrets (platform
 * credentials, secret inputs, tokens seen in answers) in their usual encodings, values under keys that name
 * credentials, and strings that look like credentials (bearer and basic values, JSON Web Tokens, private keys,
 * Steward API tokens, well-known token formats, credentials in URLs, key=value secrets). Unlike error reports
 * (shared/scrub.ts) it keeps e-mail and IP addresses and ordinary ids: they are data the question may be about.
 */

const MASK = '[removed]';

/** Keys whose values are credentials, wherever they appear. */
const SECRET_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|x-auth-token|x-space-auth-key|password|passwd|pwd|passphrase|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|token|private[-_]?key|secret[-_]?access[-_]?key|session[-_]?token|connection[-_]?string)$/i;

const PATTERNS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // PEM private keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  // credentials in URLs
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // Authorization header values
  [/\b(Bearer|Basic|SharedAccessSignature)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  // Steward API tokens and well-known provider token formats
  [/\bsmt_[A-Za-z0-9_-]{6,}/g, MASK],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9_-]{20,})\b/g,
    MASK,
  ],
  // key=value and "key": "value" with a credential key
  [
    /\b((?:[a-z_-]*?)(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret))(["']?\s*[:=]\s*["']?)([^\s"'&,;}]{4,})/gi,
    `$1$2${MASK}`,
  ],
];

export interface Scrubbed<T> {
  value: T;
  /** How many values were removed */
  removed: number;
}

/** Removes secrets from a JSON-like value; `secrets` are exact values (and their encodings) that must not leave. */
export function scrubForModel<T>(value: T, secrets: readonly string[]): Scrubbed<T> {
  let removed = 0;
  const known = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
  const text = (s: string): string => {
    let out = s;
    for (const k of known)
      if (out.includes(k)) {
        removed += out.split(k).length - 1;
        out = out.split(k).join(MASK);
      }
    for (const [re, to] of PATTERNS)
      out = out.replace(re, (...m: unknown[]) => {
        removed++;
        return typeof to === 'string' ? to.replace(/\$(\d)/g, (_x, i: string) => String(m[Number(i)] ?? '')) : to(...(m as [string, ...string[]]));
      });
    return out;
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return text(v);
    if (!v || typeof v !== 'object') return v;
    if (depth > 40) return '[…]';
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && val !== null && val !== undefined && val !== '' && typeof val !== 'boolean') {
        removed++;
        out[k] = MASK;
      } else out[k] = walk(val, depth + 1);
    }
    return out;
  };
  const result = walk(value, 0) as T;
  return { value: result, removed };
}
