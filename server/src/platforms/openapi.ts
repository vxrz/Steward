import type { ParamSchema } from '@sm/shared';

type Doc = Record<string, unknown>;
type Schema = Record<string, unknown>;

export function resolveRef(doc: Doc, x: unknown): unknown {
  if (x && typeof x === 'object' && '$ref' in x) {
    const ref = String((x as { $ref: string }).$ref);
    if (!ref.startsWith('#/')) return undefined;
    let cur: unknown = doc;
    for (const part of ref.slice(2).split('/')) cur = (cur as Record<string, unknown> | undefined)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    return cur;
  }
  return x;
}

export function paramSchema(doc: Doc, p: Record<string, unknown>): ParamSchema | undefined {
  // OAS3: p.schema; Swagger 2: type/enum/default directly on the parameter
  const s = (resolveRef(doc, p.schema) as Schema | undefined) ?? p;
  const out: ParamSchema = {};
  if (s.type) out.type = String(s.type);
  if (s.format) out.format = String(s.format);
  if (Array.isArray(s.enum)) out.enum = s.enum.slice(0, 100);
  if (s.default !== undefined) out.default = s.default;
  return Object.keys(out).length ? out : undefined;
}

/** Build a representative example value from a JSON schema (refs resolved, recursion limited). */
export function exampleFrom(doc: Doc, schemaIn: unknown, depth = 0, seen: Set<string> = new Set()): unknown {
  if (!schemaIn || typeof schemaIn !== 'object' || depth > 8) return undefined;
  const ref = (schemaIn as { $ref?: string }).$ref;
  if (ref) {
    if (seen.has(ref)) return undefined;
    seen = new Set(seen).add(ref);
  }
  const s = resolveRef(doc, schemaIn) as Schema | undefined;
  if (!s) return undefined;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Array.isArray(s.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const part of s.allOf) {
      const v = exampleFrom(doc, part, depth + 1, seen);
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v);
    }
    return merged;
  }
  for (const k of ['oneOf', 'anyOf'] as const) if (Array.isArray(s[k]) && (s[k] as unknown[]).length) return exampleFrom(doc, (s[k] as unknown[])[0], depth + 1, seen);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (type === 'object' || s.properties) {
    const out: Record<string, unknown> = {};
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(props).slice(0, 40)) {
      const val = exampleFrom(doc, v, depth + 1, seen);
      if (val !== undefined) out[k] = val;
    }
    return out;
  }
  if (type === 'array') {
    const item = exampleFrom(doc, s.items, depth + 1, seen);
    return item === undefined ? [] : [item];
  }
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'string') {
    switch (s.format) {
      case 'date-time':
        return '2026-01-01T00:00:00Z';
      case 'date':
        return '2026-01-01';
      case 'email':
        return 'user@example.com';
      case 'uuid':
        return '00000000-0000-0000-0000-000000000000';
      case 'uri':
        return 'https://example.com';
      default:
        return 'string';
    }
  }
  return undefined;
}

/** Request body info for an operation (OAS3 requestBody or Swagger 2 body parameter). */
export function requestBodyInfo(
  doc: Doc,
  op: Record<string, unknown>,
  params: Record<string, unknown>[],
): { contentType?: string; example?: unknown } {
  const rb = resolveRef(doc, op.requestBody) as { content?: Record<string, { schema?: unknown; example?: unknown; examples?: Record<string, { value?: unknown }> }> } | undefined;
  if (rb?.content) {
    const types = Object.keys(rb.content);
    const ct = types.find((t) => t.includes('json')) ?? types[0];
    if (!ct) return {};
    const media = rb.content[ct]!;
    const ex = media.example ?? Object.values(media.examples ?? {})[0]?.value ?? exampleFrom(doc, media.schema);
    return { contentType: ct, example: ex };
  }
  const body = params.find((p) => p.in === 'body');
  if (body) {
    const consumes = (op.consumes as string[] | undefined) ?? (doc.consumes as string[] | undefined) ?? ['application/json'];
    return { contentType: consumes.find((c) => c.includes('json')) ?? consumes[0], example: exampleFrom(doc, body.schema) };
  }
  return {};
}

export function successStatuses(op: Record<string, unknown>): number[] | undefined {
  const codes = Object.keys((op.responses as Record<string, unknown>) ?? {})
    .map(Number)
    .filter((c) => c >= 200 && c < 400);
  return codes.length ? codes : undefined;
}
