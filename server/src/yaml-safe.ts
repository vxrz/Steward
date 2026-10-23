import YAML, { isScalar, YAMLParseError, type Document, type DocumentOptions, type ParseOptions, type SchemaOptions, type ToJSOptions } from 'yaml';
import { HttpError } from './util.js';

/**
 * YAML from users, Git repositories and platforms. The YAML library checks duplicate keys by comparing
 * every new key of a mapping with all earlier ones – quadratic: 40 000 keys took 20 seconds. Here
 * the text is capped (bytes and an upper bound of its keys) before parsing, the library's check is
 * switched off and duplicate keys are found in linear time instead (they are still errors).
 */

export const YAML_LIMITS = {
  /** Default upper bound of mapping keys (every implicit key needs a ':' and every explicit one a '?'). */
  maxKeys: 100_000,
};

/** OpenAPI specifications can be large (several MB, many keys over many mappings). */
export const SPEC_YAML = { maxBytes: 16 * 1024 * 1024, maxKeys: 2_000_000 };

export type SafeYamlOptions = ParseOptions &
  DocumentOptions &
  SchemaOptions & {
    /** Largest text accepted (UTF-8 bytes) */
    maxBytes: number;
    /** Most ':' and '?' characters accepted (an upper bound of the keys); default YAML_LIMITS.maxKeys */
    maxKeys?: number;
  };

function keyBound(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 58 || c === 63) n++;
  }
  return n;
}

/** Checks the limits before parsing (413 YAML_TOO_LARGE, 400 YAML_TOO_MANY_KEYS). */
export function checkYamlLimits(text: string, o: { maxBytes: number; maxKeys?: number }): void {
  if (Buffer.byteLength(text) > o.maxBytes)
    throw new HttpError(413, `The YAML text is too large (at most ${Math.floor(o.maxBytes / 1024)} KB)`, 'YAML_TOO_LARGE', {
      kb: Math.floor(o.maxBytes / 1024),
    });
  const max = o.maxKeys ?? YAML_LIMITS.maxKeys;
  if (keyBound(text) > max) throw new HttpError(400, `The YAML text has too many keys (at most ${max})`, 'YAML_TOO_MANY_KEYS', { max });
}

/** Duplicate scalar keys of every mapping, in linear time; the first one is added to doc.errors. */
function findDuplicateKeys(doc: Document.Parsed): void {
  YAML.visit(doc, {
    Map(_key, map) {
      const seen = new Set<string>();
      for (const pair of map.items) {
        const k = pair.key as unknown;
        const id = k === null || k === undefined ? 'null:' : isScalar(k) ? `${typeof k.value}:${String(k.value)}` : null;
        if (id === null) continue; // complex keys (rare): not compared
        if (seen.has(id)) {
          const range = isScalar(k) && k.range ? k.range : map.range;
          doc.errors.push(new YAMLParseError([range?.[0] ?? 0, range?.[1] ?? 0], 'DUPLICATE_KEY', 'Map keys must be unique'));
          return YAML.visit.BREAK;
        }
        seen.add(id);
      }
      return undefined;
    },
  });
}

/** Like YAML.parseDocument, within limits; duplicate keys are reported in doc.errors. */
export function parseYamlDocument(text: string, o: SafeYamlOptions): Document.Parsed {
  checkYamlLimits(text, o);
  const { maxBytes: _b, maxKeys: _k, ...options } = o;
  const doc = YAML.parseDocument(text, { ...options, uniqueKeys: false });
  if (!doc.errors.length) findDuplicateKeys(doc);
  return doc;
}

/** Like YAML.parse, within limits: throws the first error (a YAMLParseError, or an HttpError for the limits). */
export function parseYaml(text: string, o: SafeYamlOptions & Pick<ToJSOptions, 'maxAliasCount'>): unknown {
  const { maxAliasCount, ...rest } = o;
  const doc = parseYamlDocument(text, rest);
  if (doc.errors.length) throw doc.errors[0];
  return doc.toJS({ maxAliasCount: maxAliasCount ?? 100 });
}
