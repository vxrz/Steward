import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from './config.js';
import { DEFAULT_BODY_LIMIT } from './bodyLimits.js';
import { logger } from './log.js';

/**
 * Request and connection timeouts (security review 0.19.0 M1). Fastify sets Node's own limits to 0 (none), so a client
 * – without signing in – could hold a connection open for ever by sending its body one byte at a time.
 *
 * - SM_REQUEST_TIMEOUT_SECONDS (120): the time from the request's headers until its body is received; then 408 and the
 *   connection is closed. The answer is not limited: downloads (exports, backups, reports) take as long as they take.
 * - SM_UPLOAD_TIMEOUT_SECONDS (3600): the same for uploads of signed-in callers – multipart files and routes with a
 *   body limit above 1 MB (migration packages up to SM_MIGRATION_MAX_MB, FOCUS files, imports). Anonymous requests
 *   never get it (their bodies are at most 64 KiB anyway).
 * - SM_CONNECTION_TIMEOUT_SECONDS (600): a connection with no traffic in either direction for this long is closed
 *   (Fastify's connectionTimeout, the socket's inactivity timeout); SM_KEEP_ALIVE_TIMEOUT_SECONDS (72): idle keep-alive.
 *
 * The request timer is per request (Node's server.requestTimeout cannot make room for one route's uploads); Node's
 * own requestTimeout is set to the longer of both as a backstop.
 */

const TIMER = Symbol('smBodyTimer');
type Raw = IncomingMessage & { [TIMER]?: NodeJS.Timeout };

const ms = (seconds: number) => seconds * 1000;

/** The options of Fastify() for a server (app.ts, the Teams bot listener). */
export function serverTimeouts(): { requestTimeout: number; connectionTimeout: number; keepAliveTimeout: number } {
  const request = ms(env.SM_REQUEST_TIMEOUT_SECONDS);
  const upload = ms(env.SM_UPLOAD_TIMEOUT_SECONDS);
  return {
    // 0 when either is "no limit": the per-request timer below decides
    requestTimeout: request && upload ? Math.max(request, upload) : 0,
    connectionTimeout: ms(env.SM_CONNECTION_TIMEOUT_SECONDS),
    keepAliveTimeout: ms(env.SM_KEEP_ALIVE_TIMEOUT_SECONDS),
  };
}

function disarm(raw: Raw): void {
  if (raw[TIMER]) clearTimeout(raw[TIMER]);
  delete raw[TIMER];
}

/** Closes the connection unless the request's body has been received within `limit` ms (0: no limit). */
function arm(raw: Raw, limit: number): void {
  disarm(raw);
  if (!limit || raw.complete) return;
  const t = setTimeout(() => {
    delete raw[TIMER];
    if (raw.complete || raw.socket.destroyed) return;
    logger.warn({ url: raw.url?.split('?')[0], limitSeconds: limit / 1000 }, 'Request body not received in time – connection closed (408)');
    // what Node's own requestTimeout answers
    raw.socket.end('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    setTimeout(() => raw.socket.destroy(), 1000).unref();
  }, limit);
  t.unref();
  raw[TIMER] = t;
  raw.once('end', () => disarm(raw));
  raw.once('close', () => disarm(raw));
}

/** An upload: a file (multipart) or a route that accepts more than the default body limit. */
function isUpload(req: FastifyRequest): boolean {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  return type.startsWith('multipart/form-data') || (req.routeOptions.bodyLimit ?? DEFAULT_BODY_LIMIT) > DEFAULT_BODY_LIMIT;
}

/** The first hook: every request gets SM_REQUEST_TIMEOUT_SECONDS for its body. */
export function installRequestTimeout(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    arm(req.raw as Raw, ms(env.SM_REQUEST_TIMEOUT_SECONDS));
    done();
  });
  // answered without reading the body (refused, 413 …): nothing left to wait for on this connection
  app.addHook('onResponse', (req, _reply, done) => {
    disarm(req.raw as Raw);
    done();
  });
}

/** After authentication: a signed-in caller's upload gets SM_UPLOAD_TIMEOUT_SECONDS instead. */
export function extendForSignedInUploads(app: FastifyInstance, signedIn: (req: FastifyRequest) => boolean): void {
  app.addHook('onRequest', (req, _reply, done) => {
    const raw = req.raw as Raw;
    if (raw[TIMER] && signedIn(req) && isUpload(req)) arm(raw, ms(env.SM_UPLOAD_TIMEOUT_SECONDS));
    done();
  });
}
