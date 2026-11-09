import type { FastifyInstance, FastifyRequest } from 'fastify';
import { context, propagation, trace, type Span } from '@opentelemetry/api';
import { Histogram, type Registry } from 'prom-client';
import { SpanKind, SpanStatusCode, tracer, tracingEnabled } from './telemetry.js';
import { requestDbStats } from './database/timing.js';

/**
 * Metrics and trace spans for Steward's own HTTP server (O11 of the 0.10 review), after the OpenTelemetry semantic
 * conventions for HTTP servers:
 *   sm_http_server_request_duration_seconds{http_request_method,http_route,http_response_status_code}
 *     histogram (OTel `http.server.request.duration`; its _count is the request count). The route is the template the
 *     request matched ("/api/runs/:id"), never the path; unknown methods count as "_OTHER" and requests that matched no
 *     route have an empty route – so the label set stays bounded.
 *   with OpenTelemetry on (OTEL_EXPORTER_OTLP_ENDPOINT): one SERVER span per request, "GET /api/runs/:id", with
 *     http.request.method, http.route, url.path (no query), url.scheme, http.response.status_code, error.type for
 *     5xx and the database statements and time of the request (sm.db.statements, sm.db.duration_ms). It is the
 *     parent of the spans the request starts (a run started by it, platform calls); a W3C traceparent header from the
 *     caller continues the caller's trace. No client address, user agent or user: they are personal data.
 * The request's database totals also go into its log line (app.ts: dbStatements, dbMs).
 */

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);

const duration = new Histogram({
  name: 'sm_http_server_request_duration_seconds',
  help: "Duration of requests to Steward's own HTTP server (web UI and API) by method, route template and status code",
  labelNames: ['http_request_method', 'http_route', 'http_response_status_code'] as const,
  // the OpenTelemetry default buckets for http.server.request.duration
  buckets: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10],
  registers: [],
});

export function registerHttpServerMetrics(registry: Registry): void {
  if (!registry.getSingleMetric('sm_http_server_request_duration_seconds')) registry.registerMetric(duration);
}

interface Observed {
  smSpan?: Span;
  smDb?: { statements: number; ms: number };
}

/** The request's database totals so far (statements, ms), for its log line. */
export function requestDbTotals(req: FastifyRequest): { statements: number; ms: number } | undefined {
  return (req as unknown as Observed).smDb;
}

const methodOf = (m: string) => (METHODS.has(m) ? m : '_OTHER');
const routeOf = (req: FastifyRequest) => req.routeOptions?.url ?? '';

/** Installs the hooks; call first in buildApp, so the span covers every other hook. */
export function installHttpObservability(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    const observed = req as unknown as Observed;
    const stats = { statements: 0, ms: 0 };
    observed.smDb = stats;
    if (!tracingEnabled()) return requestDbStats.run(stats, done);
    const method = methodOf(req.method);
    const route = routeOf(req);
    const parent = propagation.extract(context.active(), req.headers);
    const span = tracer().startSpan(
      route ? `${method} ${route}` : method,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': method,
          ...(method === '_OTHER' ? { 'http.request.method_original': req.method.slice(0, 20) } : {}),
          ...(route ? { 'http.route': route } : {}),
          'url.path': req.url.split('?')[0]!.slice(0, 500),
          'url.scheme': req.protocol,
        },
      },
      parent,
    );
    observed.smSpan = span;
    context.with(trace.setSpan(parent, span), () => requestDbStats.run(stats, done));
  });

  app.addHook('onResponse', async (req, reply) => {
    const observed = req as unknown as Observed;
    const status = reply.statusCode;
    duration.observe(
      { http_request_method: methodOf(req.method), http_route: routeOf(req), http_response_status_code: String(status) },
      reply.elapsedTime / 1000,
    );
    const span = observed.smSpan;
    if (!span) return;
    span.setAttribute('http.response.status_code', status);
    if (observed.smDb) {
      span.setAttribute('sm.db.statements', observed.smDb.statements);
      span.setAttribute('sm.db.duration_ms', Math.round(observed.smDb.ms));
    }
    if (status >= 500) {
      span.setAttribute('error.type', String(status));
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
    observed.smSpan = undefined;
  });

  // the client went away before the answer: the span ends here (no status code)
  app.addHook('onRequestAbort', async (req) => {
    const observed = req as unknown as Observed;
    observed.smSpan?.setAttribute('error.type', 'aborted');
    observed.smSpan?.end();
    observed.smSpan = undefined;
  });
}
