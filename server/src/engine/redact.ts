import { secretEncodings } from '../platforms/outbound.js';

/**
 * Masking secrets in what a run records (protocol, logs, errors). It stays in Steward whatever the engine (ADR 0011):
 * an engine never sees an unredacted value.
 */

/** Keys whose values are never stored in the protocol (headers, credentials, OAuth token responses). */
const REDACT_KEY =
  /^(authorization|proxy-authorization|x-space-auth-key|x-api-key|api[-_]?key|cookie|set-cookie|password|passphrase|client_secret|access_token|refresh_token|id_token)$/i;

export class Redactor {
  private values = new Set<string>();
  /** Registers secret values – and the encoded forms they typically appear in (JSON, URL/form encoding, Base64). */
  add(...vals: string[]): void {
    for (const v of vals) {
      if (!v || v.length < 4) continue;
      // Mask the raw value and its simple encodings (base64, URL and form encoding in upper- and
      // lowercase hex, JSON escaping) so a secret cannot be smuggled into a log/protocol field in an
      // encoded form – or come back from a platform that echoes a query API key (Link headers, bodies).
      for (const enc of secretEncodings(v)) this.values.add(enc);
    }
  }
  /** The registered secret values (for scrubbing error reports). */
  list(): string[] {
    return [...this.values];
  }
  apply<T>(v: T): T {
    if (typeof v === 'string') {
      if (this.values.size === 0) return v;
      let s: string = v;
      // longest first, so a secret containing another one is replaced as a whole
      for (const secret of [...this.values].sort((a, b) => b.length - a.length)) if (s.includes(secret)) s = s.split(secret).join('***');
      // Basic credentials: user:password in Base64 – masked when they contain a registered secret
      s = s.replace(/\b(Basic)\s+([A-Za-z0-9+/]{6,}={0,2})/g, (m, scheme: string, b64: string) => {
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        return [...this.values].some((x) => decoded.includes(x)) ? `${scheme} ***` : m;
      });
      return s as T;
    }
    if (Array.isArray(v)) return v.map((x) => this.apply(x)) as T;
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (REDACT_KEY.test(k)) {
          // a token found in a response is a secret from now on (also where it shows up later, e.g. in a header)
          if (typeof val === 'string') this.add(val);
          out[k] = '***';
        } else out[k] = this.apply(val);
      }
      return out as T;
    }
    return v;
  }
}
