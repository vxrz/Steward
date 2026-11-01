/**
 * Request body limits (bytes) of the web app's API.
 *
 * - Every route accepts at most DEFAULT_BODY_LIMIT (1 MB, set on the Fastify instance in app.ts). A form
 *   or editor payload is far below that, and a route that needs no more can't be made to buffer and
 *   parse more.
 * - Routes that carry the content of a file in a JSON body – imports, process and dashboard
 *   definitions, API specifications, a logo or a report as base64 – get a larger limit from
 *   LARGE_BODIES. Each one is sized from the route's own content limit, so a body that fits the
 *   content limit always fits the body limit.
 * - Multipart uploads (attachments, signed PDFs, logos, migration packages) are not counted here:
 *   @fastify/multipart streams the file, and each route sets its own file size limit.
 * - Machine endpoints (webhooks, heartbeats, Git sync, MCP) and sign-in set smaller limits of their own.
 *
 * The route permission matrix test checks that only the routes named in LARGE_BODIES accept more than
 * the default, so a new route stays at 1 MB unless it is added here.
 */
import { COMPONENT_LIMITS, RECORDING_LIMITS, REPORT_LOGO_MAX_BYTES } from '@sm/shared';
import { LIMITS as CATALOGUE_LIMITS } from './compliance/controls.js';
import { MONITOR_IMPORT_LIMITS } from './monitors/model.js';
import { IMPORT_LIMITS as RECORD_IMPORT_LIMITS } from './records/markdown-io.js';
import { HttpError, MAX_DEFINITION_TEXT } from './util.js';

const KIB = 1024;
const MIB = 1024 * 1024;

/** Every route without an entry in LARGE_BODIES. */
export const DEFAULT_BODY_LIMIT = MIB;

/** The limit every route had before 1 MB became the default; kept for exports without a content limit of their own. */
const PREVIOUS_LIMIT = 25 * MIB;

/** A text of `chars` characters in a JSON body: UTF-8 and JSON escaping (quotes, line breaks) can double it, plus room for the other fields. */
const jsonText = (chars: number, rest = 64 * KIB): number => chars * 2 + rest;
/** A file of `bytes` bytes as base64 in a JSON body, plus room for the other fields. */
const base64 = (bytes: number, rest = 16 * KIB): number => Math.ceil((bytes * 4) / 3) + rest;

export interface LargeBody {
  /** The routes ("METHOD /api/path", as registered) that use this limit */
  routes: readonly string[];
  /** The body limit in bytes */
  bytes: number;
}

/** The only routes that accept bodies above DEFAULT_BODY_LIMIT. Routes pass `bodyLimit: LARGE_BODIES.<name>.bytes`. */
export const LARGE_BODIES = {
  /** A recorded platform response (#105): RECORDING_LIMITS.bodyBytes (1 MB) as JSON, with headers and match */
  recordings: { routes: ['POST /api/platforms/:id/recordings', 'PUT /api/platforms/:id/recordings/:recId'], bytes: jsonText(RECORDING_LIMITS.bodyBytes) },
  /** Markdown files of records: RECORD_IMPORT_LIMITS.totalBytes (2 MB) together */
  recordsImport: { routes: ['POST /api/records/import'], bytes: jsonText(RECORD_IMPORT_LIMITS.totalBytes) },
  /** A control catalogue (JSON, CSV or YAML): CATALOGUE_LIMITS.importBytes (1 MB) */
  catalogueImport: { routes: ['POST /api/compliance/catalogues/import'], bytes: jsonText(CATALOGUE_LIMITS.importBytes, 16 * KIB) },
  /** A monitor file (YAML): MONITOR_IMPORT_LIMITS.yamlChars (512 KB) – line breaks are escaped in JSON */
  monitorImport: { routes: ['POST /api/monitors/import', 'POST /api/monitors/import/preview'], bytes: jsonText(MONITOR_IMPORT_LIMITS.yamlChars) },
  /** Instances of a monitor template from a CSV file: MONITOR_IMPORT_LIMITS.csvChars (1 MB) */
  monitorInstances: { routes: ['POST /api/monitors/:id/instances'], bytes: jsonText(MONITOR_IMPORT_LIMITS.csvChars) },
  /**
   * A process or dashboard definition, as YAML/JSON text or as the parsed definition: MAX_DEFINITION_TEXT
   * (2 MB). Saving, validating and converting take the same definitions as creating (importing) them.
   */
  definitions: {
    routes: [
      'POST /api/processes',
      'PUT /api/processes/:id',
      'POST /api/processes/validate',
      'POST /api/processes/to-yaml',
      'POST /api/dashboards',
      'PUT /api/dashboards/:id',
    ],
    bytes: jsonText(MAX_DEFINITION_TEXT),
  },
  /**
   * An API specification pasted or read from a file: up to 20 MB (MAX_SPEC_BYTES in platforms/connectors.ts,
   * as when fetched from a URL);
   * the previous limit leaves room for the escaped quotes and line breaks of a JSON or YAML text.
   */
  apiSpec: { routes: ['POST /api/platforms/:id/specs'], bytes: PREVIOUS_LIMIT },
  /**
   * Exports of a whole installation: a bundle of processes and dashboards (up to 10,000 of each), a
   * connector type with its API specifications (up to 100). Their item counts are limited, their size is
   * not – they keep the previous limit, which every export so far was made for.
   */
  exports: { routes: ['POST /api/bundle/import', 'POST /api/platform-types/import'], bytes: PREVIOUS_LIMIT },
  /** The report logo as base64 (the web app sends multipart; team logos, #136, base64 only): REPORT_LOGO_MAX_BYTES (1 MB) */
  reportLogo: { routes: ['POST /api/reports/branding/logo', 'POST /api/teams/:id/settings/logo'], bytes: base64(REPORT_LOGO_MAX_BYTES) },
  /**
   * A report PDF as base64, for scripts (the web app sends multipart, up to 50 MB): the previous limit,
   * a PDF of about 18 MB.
   */
  reportVerify: { routes: ['POST /api/reports/verify'], bytes: PREVIOUS_LIMIT },
  /** An SBOM (CycloneDX or SPDX JSON) as text or parsed: COMPONENT_LIMITS.sbomBytes (10 MB) */
  sbom: {
    routes: [
      'POST /api/applications/:id/components/:componentId/sbom/preview',
      'POST /api/applications/:id/components/:componentId/sbom',
      'POST /api/systems/:id/sbom/preview',
      'POST /api/systems/:id/sbom',
    ],
    bytes: jsonText(COMPONENT_LIMITS.sbomBytes, 16 * KIB),
  },
} as const satisfies Record<string, LargeBody>;

/** The answer to a body above the route's limit: 413 BODY_TOO_LARGE (or _KIB below 1 MB), with the limit. */
export function bodyTooLarge(limit: number | undefined): HttpError {
  const bytes = limit ?? DEFAULT_BODY_LIMIT;
  if (bytes < MIB) {
    const maxKib = Math.floor(bytes / KIB);
    return new HttpError(413, `The request is too large (at most ${maxKib} KB)`, 'BODY_TOO_LARGE_KIB', { maxKib });
  }
  const maxMb = Math.floor((bytes / MIB) * 10) / 10;
  return new HttpError(413, `The request is too large (at most ${maxMb} MB)`, 'BODY_TOO_LARGE', { maxMb });
}
