import { SerializerSelector, type SerializerFactory } from '@fastify/fast-json-stringify-compiler';

type Serializer = ReturnType<ReturnType<SerializerFactory>>;

const build = SerializerSelector();
const built = new Map<string, Serializer>();
const ids = new WeakMap<object, number>();
let nextId = 0;
/** The same object always gets the same number (the shared schemas and options are the same objects in every context). */
const idOf = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return String(v);
  let id = ids.get(v);
  if (id === undefined) ids.set(v, (id = ++nextId));
  return `#${id}`;
};

/**
 * Response serializers, built once per distinct schema (Fastify's `schemaController.compilersFactory.buildSerializer`).
 *
 * Fastify builds a serializer for every route and status that has a response schema – again for the HEAD route of each
 * GET – and every build reads all shared schemas of the public API (`api/v1/schemas.ts`, tens of milliseconds each).
 * That was about half of the start-up time. It also asks for a new compiler in every plugin context, so the serializers
 * are kept here, keyed by the shared schemas (by identity), the options, the status, the content type and the
 * route's schema: a route whose answer is described the same way as one already built (the HEAD route of a GET, a list
 * or problem answer many routes share) gets that serializer.
 */
export const sharedSerializers: SerializerFactory = (externalSchemas, options) => {
  const compile = build(externalSchemas, options);
  const ext =
    externalSchemas && typeof externalSchemas === 'object'
      ? Object.entries(externalSchemas)
          .map(([k, s]) => `${k}=${idOf(s)}`)
          .join(',')
      : '';
  const context = `${ext}\u0000${idOf(options)}`;
  return (route) => {
    const { httpStatus, contentType } = route as typeof route & { contentType?: string };
    const keyOf = () => `${context}\u0000${httpStatus}\u0000${contentType ?? ''}\u0000${JSON.stringify(route.schema)}`;
    const key = keyOf();
    let serializer = built.get(key);
    if (!serializer) {
      serializer = compile(route);
      built.set(key, serializer);
      // the build rewrites parts of the schema in place (the order of `type: [..]`), and the HEAD route of a GET is
      // given the same schema object: keep the serializer under the schema as it is now, too
      built.set(keyOf(), serializer);
    }
    return serializer;
  };
};
