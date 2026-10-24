/** Types for reverse-proxy.mjs (a minimal reverse proxy for tests). */
export interface ReverseProxy {
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  /** Every request passed on: the path as the client sent it and the upstream status. */
  requests: { method: string; path: string; status: number }[];
  close: () => Promise<void>;
}

export function startReverseProxy(opts: {
  /** Steward's own address, e.g. http://127.0.0.1:4310 */
  target: string;
  /** Port to listen on (default: a free one) */
  port?: number;
  host?: string;
  /** X-Forwarded-Proto to send (default http) */
  proto?: string;
  /** Strip this prefix before passing the request on (simulates a misconfigured proxy) */
  stripPrefix?: string;
  /** Send the target's Host header instead of the client's (nginx's default) */
  rewriteHost?: boolean;
}): Promise<ReverseProxy>;
