import { context, propagation, SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, type SpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { config } from './config.js';

/**
 * Optional OpenTelemetry tracing. Enabled when an OTLP endpoint is configured
 * (OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, standard
 * OTEL_* variables such as OTEL_EXPORTER_OTLP_HEADERS and OTEL_SERVICE_NAME apply).
 * Spans: one per run, one per executed node, one per platform HTTP call.
 * Without configuration the API calls below are no-ops.
 */

let provider: NodeTracerProvider | undefined;

export function tracingEnabled(): boolean {
  return !!provider;
}

export function initTelemetry(opts: { exporter?: SpanExporter; simple?: boolean } = {}): boolean {
  if (provider) return true;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!opts.exporter && !endpoint) return false;
  const exporter = opts.exporter ?? new OTLPTraceExporter();
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'service-manager',
      'service.version': config.version,
    }),
    spanProcessors: [opts.simple ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter)],
  });
  provider.register();
  return true;
}

export async function shutdownTelemetry(): Promise<void> {
  await provider?.shutdown().catch(() => undefined);
}

export const tracer = () => trace.getTracer('service-manager', config.version);

/** Run fn inside a new active span; records errors and ends the span. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  const attrs = Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;
  return tracer().startActiveSpan(name, { kind, attributes: attrs }, async (span) => {
    try {
      const out = await fn(span);
      return out;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message?.slice(0, 300) });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Adds W3C trace context headers (traceparent) to outgoing platform calls when tracing is on. */
export function injectTraceHeaders(headers: Record<string, string>): void {
  if (!provider || process.env.SM_OTEL_PROPAGATE === '0') return;
  propagation.inject(context.active(), headers);
}

/** Trace/span id of the active span (for log correlation). */
export function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && sc.traceId !== '00000000000000000000000000000000' ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
}

export { SpanKind, SpanStatusCode };
