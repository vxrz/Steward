/**
 * JSON-RPC 2.0 message handling for the Model Context Protocol – the small part of it Steward needs:
 * message classification, error codes and result envelopes. Hand-written on purpose (see docs/MCP.md,
 * "Why no SDK"): the server answers a fixed set of read-only methods and never sends requests itself.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  { jsonrpc: '2.0'; id: JsonRpcId; result: Record<string, unknown> } | { jsonrpc: '2.0'; id?: JsonRpcId | null; error: JsonRpcError };

/** Standard JSON-RPC codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** Codes the MCP specification defines (2026-07-28). */
export const HEADER_MISMATCH = -32020;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/**
 * Steward's own codes for refusals at the HTTP layer, outside the JSON-RPC reserved range as the MCP
 * specification recommends for application-defined errors.
 */
export const STEWARD_ERRORS = {
  disabled: -31000,
  unauthorized: -31001,
  forbidden: -31003,
  tooLarge: -31013,
  rateLimited: -31029,
  unavailable: -31503,
} as const;

/** Error with a JSON-RPC code and the HTTP status to answer with. */
export class McpError extends Error {
  constructor(
    public code: number,
    message: string,
    public httpStatus = 200,
    public data?: unknown,
  ) {
    super(message);
  }
}

export type Classified =
  | { kind: 'request'; msg: JsonRpcRequest }
  | { kind: 'notification'; msg: JsonRpcNotification }
  | { kind: 'response' }
  | { kind: 'invalid'; id: JsonRpcId | null; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Sorts a parsed body into request / notification / response, or says why it is not a valid message. */
export function classify(body: unknown): Classified {
  if (Array.isArray(body)) return { kind: 'invalid', id: null, message: 'Batches are not supported – send one JSON-RPC message per request' };
  if (!isObject(body)) return { kind: 'invalid', id: null, message: 'The body must be a JSON-RPC 2.0 object' };
  const rawId = body.id;
  const id = typeof rawId === 'string' || (typeof rawId === 'number' && Number.isFinite(rawId)) ? rawId : null;
  if (body.jsonrpc !== '2.0') return { kind: 'invalid', id, message: 'jsonrpc must be "2.0"' };
  if (typeof body.id === 'string' && body.id.length > 200) return { kind: 'invalid', id: null, message: 'id is too long' };
  if (!('method' in body)) {
    if ('result' in body || 'error' in body) return { kind: 'response' };
    return { kind: 'invalid', id, message: 'Missing method' };
  }
  if (typeof body.method !== 'string' || !body.method || body.method.length > 100) return { kind: 'invalid', id, message: 'method must be a non-empty string' };
  if (body.params !== undefined && !isObject(body.params)) return { kind: 'invalid', id, message: 'params must be an object' };
  const params = body.params as Record<string, unknown> | undefined;
  if (!('id' in body)) return { kind: 'notification', msg: { jsonrpc: '2.0', method: body.method, params } };
  if (id === null) return { kind: 'invalid', id: null, message: 'id must be a string or a number (not null)' };
  return { kind: 'request', msg: { jsonrpc: '2.0', id, method: body.method, params } };
}

export const resultResponse = (id: JsonRpcId, result: Record<string, unknown>): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
export const errorResponse = (id: JsonRpcId | null | undefined, e: JsonRpcError): JsonRpcResponse =>
  id === null || id === undefined ? { jsonrpc: '2.0', error: e } : { jsonrpc: '2.0', id, error: e };

/** `Mcp-Name` / `Mcp-Param-*` values may be Base64-encoded as =?base64?…?= (2026-07-28 transport). */
export function decodeHeaderValue(v: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return Buffer.from(m[1]!, 'base64').toString('utf8');
  } catch {
    return null;
  }
}
