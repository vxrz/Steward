/**
 * Scrubbing of error reports (Sentry-compatible events) before they leave the
 * process – used by the server and the web UI. Dependency-free on purpose, and
 * deliberately aggressive: a report with a few "***" too many is still useful,
 * a report with a leaked token is an incident.
 *
 * What it does (see docs/ERROR-REPORTING.md):
 * - replaces known secret values (platform secrets, passphrases) with ***
 * - masks values under sensitive keys (authorization, cookie, password, token, secret, …)
 * - masks token-like strings: Steward API tokens (smt_…), JWTs, bearer/basic
 *   credentials, credentials in URLs, key=value secrets, e-mail and IP addresses,
 *   long random-looking strings
 * - removes query strings and fragments from URLs
 * - replaces user names in home-directory paths (/home/<user>, C:\Users\<user>)
 * - removes request headers (except User-Agent), cookies, bodies, query strings,
 *   user e-mail/IP/name, the host name (server_name), local variables
 */

export const SCRUBBED = '***';

/** Keys whose values are never sent, wherever they appear. */
const SENSITIVE_KEY =
  /passw|passphrase|secret|token|authori[sz]ation|^auth$|cookie|session.?id|^session$|credential|private.?key|api.?key|x-space-auth-key|signature|^email$|^e-mail$|^ip_address$|^ip$|^username$|^displayname$|^dsn$|enduser/i;

interface Pattern {
  re: RegExp;
  to: string | ((m: string, ...g: string[]) => string);
}

const PATTERNS: Pattern[] = [
  // credentials in URLs: https://user:pass@host
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, to: `$1${SCRUBBED}@` },
  // query strings and fragments of absolute and absolute-path URLs
  { re: /((?:\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*|(?<![\w.])\/[\w\-./~%]*)?)\?[^\s#"'<>]*(#[^\s"'<>]*)?/gi, to: (m, base) => (base ? `${base}?${SCRUBBED}` : m) },
  // Authorization header values
  { re: /\b(Bearer|SharedAccessSignature)\s+[A-Za-z0-9._~+/=:,-]{4,}/gi, to: `$1 ${SCRUBBED}` },
  { re: /\b(Basic)\s+[A-Za-z0-9+/]{8,}={0,2}/g, to: `$1 ${SCRUBBED}` },
  // Steward API tokens
  { re: /\bsmt_[A-Za-z0-9_-]{6,}/g, to: `smt_${SCRUBBED}` },
  // JSON Web Tokens
  { re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, to: SCRUBBED },
  // well-known provider token formats (GitHub, Slack, AWS access keys, Google API keys)
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, to: SCRUBBED },
  // key=value / "key": "value" pairs with sensitive keys
  {
    re: /\b((?:[a-z_-]*?)(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?key|sig|signature|session|cookie))(["']?\s*[:=]\s*["']?)([^\s"'&,;}]+)/gi,
    to: `$1$2${SCRUBBED}`,
  },
  // e-mail addresses
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, to: `${SCRUBBED}@${SCRUBBED}` },
  // IPv4 addresses (optionally with port)
  { re: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, to: '0.0.0.0' },
  // IPv6 addresses (full form, or compressed with "::"; not times like 10:30:45)
  { re: /\b(?:[0-9a-f]{1,4}:){5,7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?/gi, to: '::' },
  // long random-looking strings (keys, hashes, opaque tokens); at least one digit and one letter
  { re: /\b(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/g, to: SCRUBBED },
];

/** Random identifiers that are useful for correlation and safe to keep. */
const KEEP_KEY = /^(trace_id|span_id|parent_span_id|event_id|release|dist|environment|run_id|request_id)$/;

/** User names in home-directory paths. */
const HOME_PATHS: Pattern[] = [
  { re: /(\/home\/|\/Users\/)[^/\s'"]+/g, to: '$1<user>' },
  { re: /([A-Za-z]:\\+(?:Users|Documents and Settings)\\+)[^\\\s'"]+/gi, to: '$1<user>' },
];

export interface ScrubOptions {
  /** Exact values that must never be sent (secrets, passphrases). Values shorter than 4 characters are ignored. */
  secrets?: Iterable<string>;
}

function secretList(opts: ScrubOptions): string[] {
  const out = new Set<string>();
  for (const s of opts.secrets ?? []) if (typeof s === 'string' && s.length >= 4) out.add(s);
  // longest first, so a secret containing another one is replaced as a whole
  return [...out].sort((a, b) => b.length - a.length);
}

function scrubWith(s: string, secrets: string[], patterns = true): string {
  let out = s;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(SCRUBBED);
  for (const p of HOME_PATHS) out = out.replace(p.re, p.to as string);
  if (patterns) for (const p of PATTERNS) out = out.replace(p.re, p.to as never);
  return out;
}

/** Scrubs one string (messages, URLs, exception values). */
export function scrubString(s: string, opts: ScrubOptions = {}): string {
  return scrubWith(s, secretList(opts));
}

/** Removes query string and fragment of a URL or path. */
export function stripQuery(url: string): string {
  return url.replace(/[?#].*$/s, '');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function deep(v: unknown, secrets: string[], depth: number, seen: WeakSet<object>): unknown {
  if (typeof v === 'string') return scrubWith(v, secrets);
  if (!v || typeof v !== 'object') return v;
  if (depth > 12 || seen.has(v)) return '[…]';
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => deep(x, secrets, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (KEEP_KEY.test(k) && typeof val === 'string') {
      out[k] = val;
      continue;
    }
    out[k] = isSensitiveKey(k) && val !== null && val !== undefined && val !== '' ? SCRUBBED : deep(val, secrets, depth + 1, seen);
  }
  return out;
}

/** Deep scrub of any JSON-like value (sensitive keys are masked, strings scrubbed). */
export function scrubValue<T>(v: T, opts: ScrubOptions = {}): T {
  return deep(v, secretList(opts), 0, new WeakSet()) as T;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function scrubFrames(frames: unknown, secrets: string[]): void {
  if (!Array.isArray(frames)) return;
  for (const f of frames as Obj[]) {
    if (!isObj(f)) continue;
    delete f.vars; // local variables can contain anything
    for (const k of ['filename', 'abs_path', 'module']) if (typeof f[k] === 'string') f[k] = scrubWith(stripQuery(f[k] as string), secrets, false);
    for (const k of ['context_line', 'pre_context', 'post_context']) if (k in f) f[k] = deep(f[k], secrets, 0, new WeakSet());
  }
}

function scrubRequest(req: unknown, secrets: string[]): Obj | undefined {
  if (!isObj(req)) return undefined;
  const out: Obj = {};
  if (typeof req.method === 'string') out.method = req.method;
  // path only: the host name of an internal server is nobody else's business
  if (typeof req.url === 'string') out.url = scrubWith(stripQuery(req.url).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') || '/', secrets);
  const headers = isObj(req.headers) ? req.headers : {};
  const ua = Object.entries(headers).find(([k]) => k.toLowerCase() === 'user-agent')?.[1];
  if (typeof ua === 'string') out.headers = { 'User-Agent': ua };
  // cookies, query_string, data (bodies), env, other headers: never sent
  return out;
}

/** Breadcrumbs: console output is dropped (unknown content), URLs lose their query, everything else is scrubbed. */
export function scrubBreadcrumb<T>(crumb: T, opts: ScrubOptions = {}): T | null {
  return scrubCrumb(crumb, secretList(opts));
}

function scrubCrumb<T>(crumb: T, secrets: string[]): T | null {
  if (!isObj(crumb)) return crumb;
  if (crumb.category === 'console') return null;
  const c: Obj = { ...crumb };
  if (isObj(c.data)) {
    const d: Obj = { ...c.data };
    for (const k of ['url', 'from', 'to']) if (typeof d[k] === 'string') d[k] = stripQuery(d[k] as string);
    c.data = deep(d, secrets, 0, new WeakSet());
  }
  if (typeof c.message === 'string') c.message = scrubWith(c.message, secrets);
  return c as T;
}

/**
 * Scrubs a Sentry-compatible event in place-safe manner (returns a new object for
 * the parts it rewrites). Works for server and browser events.
 */
export function scrubEvent<T>(event: T, opts: ScrubOptions = {}): T {
  if (!isObj(event)) return event;
  const secrets = secretList(opts);
  const e: Obj = { ...event };

  // identity: only an opaque id (set by us) may remain
  if (isObj(e.user) && typeof e.user.id === 'string') e.user = { id: e.user.id };
  else delete e.user;
  delete e.server_name;

  if (e.request !== undefined) e.request = scrubRequest(e.request, secrets);
  if (typeof e.message === 'string') e.message = scrubWith(e.message, secrets);
  if (isObj(e.logentry)) e.logentry = deep(e.logentry, secrets, 0, new WeakSet());
  if (typeof e.transaction === 'string') e.transaction = scrubWith(stripQuery(e.transaction), secrets);
  if (typeof e.culprit === 'string') e.culprit = scrubWith(e.culprit, secrets);

  if (isObj(e.exception) && Array.isArray(e.exception.values)) {
    e.exception = {
      ...e.exception,
      values: (e.exception.values as Obj[]).map((x) => {
        if (!isObj(x)) return x;
        const v: Obj = { ...x };
        if (typeof v.value === 'string') v.value = scrubWith(v.value, secrets);
        if (isObj(v.stacktrace)) {
          v.stacktrace = { ...v.stacktrace, frames: Array.isArray(v.stacktrace.frames) ? (v.stacktrace.frames as Obj[]).map((f) => ({ ...f })) : v.stacktrace.frames };
          scrubFrames((v.stacktrace as Obj).frames, secrets);
        }
        if (isObj(v.mechanism) && isObj(v.mechanism.data)) v.mechanism = { ...v.mechanism, data: deep(v.mechanism.data, secrets, 0, new WeakSet()) };
        return v;
      }),
    };
  }
  if (isObj(e.threads) && Array.isArray(e.threads.values)) {
    for (const t of e.threads.values as Obj[]) if (isObj(t) && isObj(t.stacktrace)) scrubFrames(t.stacktrace.frames, secrets);
  }
  if (Array.isArray(e.breadcrumbs)) e.breadcrumbs = e.breadcrumbs.map((b) => scrubCrumb(b, secrets)).filter((b) => b !== null);
  if (isObj(e.breadcrumbs) && Array.isArray(e.breadcrumbs.values)) {
    e.breadcrumbs = { values: (e.breadcrumbs.values as unknown[]).map((b) => scrubCrumb(b, secrets)).filter((b) => b !== null) };
  }
  for (const k of ['extra', 'tags', 'spans']) if (e[k] !== undefined) e[k] = deep(e[k], secrets, 0, new WeakSet());
  if (isObj(e.contexts)) {
    const ctx: Obj = { ...e.contexts };
    if (isObj(ctx.device)) {
      const { device_name: _dn, name: _n, ...rest } = ctx.device;
      ctx.device = rest;
    }
    delete ctx.cloud_resource;
    for (const [k, v] of Object.entries(ctx)) {
      // trace ids are random identifiers, keep them as they are
      if (k !== 'trace') ctx[k] = deep(v, secrets, 0, new WeakSet());
    }
    e.contexts = ctx;
  }
  return e as T;
}

/** GET /api/client-config: runtime settings for the web UI (public, no secrets). */
export interface ClientConfig {
  /** Browser error reporting; null when off. The DSN's key is public by design (it can only submit events). */
  errorReporting: { dsn: string; environment: string; release: string } | null;
}
