/**
 * OpenAPI description of the changedetection.io endpoints Steward reads (#242), written from changedetection.io's
 * docs/api-spec.yaml (API 0.1.9) and changedetectionio/api/Watch.py on master as of 2026-11. Only the read endpoints the
 * platform kind allows (platforms/deniedPaths.ts) – no write, no snapshot, no diff – so the editor's operation picker
 * and the API explorer offer nothing that would be refused.
 */
export function changedetectionSpec(): Record<string, unknown> {
  const uuid = { name: 'uuid', in: 'path', required: true, description: 'The watch’s UUID', schema: { type: 'string', format: 'uuid' } };
  const json = (schema: unknown, description = 'OK') => ({
    '200': { description, content: { 'application/json': { schema } } },
    '403': { description: 'Invalid API key (Settings → API in changedetection.io)' },
  });
  return {
    openapi: '3.0.3',
    info: {
      title: 'changedetection.io API (read endpoints used by Steward)',
      version: '0.1.9',
      description:
        'Read-only part of the changedetection.io REST API (https://changedetection.io/docs/api_v1/, Apache-2.0). The API key goes in the header x-api-key. Steward never reads snapshots or diffs (page contents) and never writes; those endpoints are refused for this platform kind.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
      schemas: {
        WatchSummary: {
          type: 'object',
          properties: {
            title: { type: 'string', nullable: true, description: 'Title entered in changedetection.io' },
            page_title: { type: 'string', nullable: true, description: 'The page’s HTML title' },
            url: { type: 'string', description: 'The raw URL (may contain Jinja2 markup)' },
            link: { type: 'string', description: 'The rendered URL' },
            tags: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'Tag UUIDs (names: GET /tags)' },
            paused: { type: 'boolean' },
            notification_muted: { type: 'boolean' },
            last_checked: { type: 'integer', description: 'Unix seconds of the last check (0: never)' },
            last_changed: { type: 'integer', description: 'Unix seconds of the newest change (0: none since the first snapshot)' },
            last_error: { description: 'false, or the text of the last check’s error' },
            viewed: { type: 'boolean' },
          },
        },
        Tag: { type: 'object', properties: { uuid: { type: 'string', format: 'uuid' }, title: { type: 'string' } } },
      },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/watch': {
        get: {
          operationId: 'listWatches',
          summary: 'List all watches (metadata)',
          parameters: [
            { name: 'tag', in: 'query', description: 'Only watches with this tag name', schema: { type: 'string' } },
            { name: 'with_errors', in: 'query', description: '1: only watches whose last check failed', schema: { type: 'string', enum: ['1'] } },
          ],
          responses: json({ type: 'object', additionalProperties: { $ref: '#/components/schemas/WatchSummary' } }, 'Watch UUID → watch'),
        },
      },
      '/watch/{uuid}': {
        get: {
          operationId: 'getWatch',
          summary: 'One watch with its settings (credentials in its settings are removed by Steward)',
          parameters: [uuid],
          responses: { ...json({ $ref: '#/components/schemas/WatchSummary' }), '404': { description: 'No such watch' } },
        },
      },
      '/watch/{uuid}/history': {
        get: {
          operationId: 'getWatchHistory',
          summary: 'Snapshot times of a watch',
          description:
            'Unix seconds → path of the snapshot file on the changedetection.io server. The first snapshot is the initial fetch; every later one is a change.',
          parameters: [uuid],
          responses: { ...json({ type: 'object', additionalProperties: { type: 'string' } }), '404': { description: 'No such watch' } },
        },
      },
      '/tags': {
        get: {
          operationId: 'listTags',
          summary: 'All tags (groups)',
          responses: json({ type: 'object', additionalProperties: { $ref: '#/components/schemas/Tag' } }, 'Tag UUID → tag'),
        },
      },
      '/search': {
        get: {
          operationId: 'searchWatches',
          summary: 'Find watches by URL or title',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'tag', in: 'query', schema: { type: 'string' } },
            { name: 'partial', in: 'query', schema: { type: 'string', enum: ['true', '1'] } },
          ],
          responses: json({ type: 'object', additionalProperties: { $ref: '#/components/schemas/WatchSummary' } }),
        },
      },
      '/systeminfo': {
        get: {
          operationId: 'getSystemInfo',
          summary: 'Version, number of watches and tags, queue',
          responses: json({
            type: 'object',
            properties: {
              version: { type: 'string' },
              watch_count: { type: 'integer' },
              tag_count: { type: 'integer' },
              queue_size: { type: 'integer' },
              overdue_watches: { type: 'array', items: { type: 'string' } },
              all_paused: { type: 'boolean' },
              all_muted: { type: 'boolean' },
            },
          }),
        },
      },
    },
  };
}
