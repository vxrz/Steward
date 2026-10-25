import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

type OverrideContext = Parameters<NonNullable<NonNullable<Parameters<typeof z.toJSONSchema>[1]>['override']>>[0];

/** zod 3's `isOptional()`, which zod-to-json-schema used for `required` */
function acceptsUndefined(s: z.ZodType): boolean {
  try {
    return s.safeParse(undefined).success;
  } catch {
    return false; // a transform that can't handle undefined
  }
}

/**
 * Keeps the JSON Schema of a zod schema as it was with zod 3 and zod-to-json-schema, so the
 * documented API (docs/openapi.json, MCP tool schemas) and the response serialization stay the same:
 *
 * - `required` lists the properties that don't accept `undefined` (zod 4 also lists `z.unknown()`
 *   fields, and fields with a default when it describes the output). fast-json-stringify refuses
 *   a response without a required property, so this also keeps responses working.
 * - String formats (date-time, email …) are described by `format` alone, without zod's regex.
 * - The safe-integer range `.int()` adds is left out, and so are `propertyNames` of records
 *   (JSON object keys are strings anyway).
 * - A nullable schema carries the description of the schema it wraps, and a nullable integer stays
 *   `anyOf: [{ type: integer }, { type: null }]` (see `legacyLayout`).
 */
function legacy({ zodSchema, jsonSchema: js }: OverrideContext): void {
  const def = zodSchema._zod.def as { type: string; shape?: Record<string, z.ZodType>; checks?: { _zod: { def: { format?: string } } }[] };
  if (def.type === 'object' && def.shape && js.properties) {
    const required = Object.keys(js.properties).filter((k) => def.shape![k] && !acceptsUndefined(def.shape![k]!));
    if (required.length) js.required = required;
    else delete js.required;
  }
  if (typeof js.format === 'string' && js.pattern !== undefined && !(def.checks ?? []).some((c) => c._zod.def.format === 'regex')) delete js.pattern;
  if (js.type === 'integer') {
    if (js.minimum === Number.MIN_SAFE_INTEGER) delete js.minimum;
    if (js.maximum === Number.MAX_SAFE_INTEGER) delete js.maximum;
  }
  if (js.type === 'object' && JSON.stringify(js.propertyNames) === '{"type":"string"}') delete js.propertyNames;
  if (def.type === 'nullable' && js.description === undefined && Array.isArray(js.anyOf)) {
    const inner = js.anyOf.find((s) => (s as JsonSchema).type !== 'null') as JsonSchema | undefined;
    if (inner?.description !== undefined) js.description = inner.description as string;
  }
}

const WRAPPER_KEYS = ['default', 'description'];
/** Keywords whose value maps names to schemas, and keywords whose value is data, not a schema */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const DATA = new Set(['default', 'examples', 'example', 'enum', 'const']);
/**
 * After the overrides: zod 4 folds `anyOf: [{ type: integer }, { type: null }]` into
 * `type: [null, integer]`, and writes the default and description of a wrapper (optional, nullable …)
 * before the keywords of the wrapped schema.
 */
function legacyLayout(v: unknown): void {
  if (Array.isArray(v)) return v.forEach(legacyLayout);
  if (v === null || typeof v !== 'object') return;
  const js = v as JsonSchema;
  if (Array.isArray(js.type) && js.type.length === 2 && js.type.includes('integer') && js.type.includes('null')) {
    delete js.type;
    js.anyOf = [{ type: 'integer' }, { type: 'null' }];
  }
  const keys = Object.keys(js);
  const first = keys.findIndex((k) => !WRAPPER_KEYS.includes(k));
  if (first > 0 && js.type !== 'object') {
    for (const k of WRAPPER_KEYS.filter((k) => keys.slice(0, first).includes(k))) {
      const value = js[k];
      delete js[k];
      js[k] = value;
    }
  }
  for (const [k, value] of Object.entries(js)) {
    if (DATA.has(k)) continue;
    if (SCHEMA_MAPS.has(k) && value !== null && typeof value === 'object') Object.values(value).forEach(legacyLayout);
    else legacyLayout(value);
  }
}

/**
 * zod → JSON Schema (draft 2020-12, the dialect of OpenAPI 3.1 and MCP), inlined (no `$ref`s).
 * `io: 'input'` describes what the schema accepts (query strings, tool arguments), `output` what it
 * produces (response bodies).
 */
export function zodJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const out = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
    reused: 'inline',
    cycles: 'throw',
    override: legacy,
  }) as JsonSchema;
  delete out.$schema;
  legacyLayout(out);
  return out;
}
