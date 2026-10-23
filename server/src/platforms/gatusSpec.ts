/**
 * OpenAPI description of the Gatus endpoints used by Steward (written from the
 * Gatus README and api/*.go, Gatus v5.37 / master as of 2026-10). Gatus itself
 * publishes no OpenAPI document; this one only covers what Steward calls, so
 * the editor's operation picker and the API explorer know them.
 */
export function gatusOpenApiSpec(): Record<string, unknown> {
  const key = {
    name: 'key',
    in: 'path',
    required: true,
    description:
      'Endpoint key: <group>_<name>, lower case, with " ", "/", "_", ",", ".", "#", "+" and "&" replaced by "-" (e.g. core_frontend, _frontend without a group)',
    schema: { type: 'string' },
  };
  const duration = (values: string[]) => ({ name: 'duration', in: 'path', required: true, schema: { type: 'string', enum: values } });
  const paging = [
    {
      name: 'page',
      in: 'query',
      description: 'Page of the results of each endpoint (1 = newest). Endpoints themselves are not paged.',
      schema: { type: 'integer', default: 1, minimum: 1 },
    },
    {
      name: 'pageSize',
      in: 'query',
      description: 'Results per endpoint. Page 1 is capped at storage.maximum-number-of-results (default 100).',
      schema: { type: 'integer', default: 50, minimum: 1 },
    },
  ];
  const json = (schema: unknown) => ({ '200': { description: 'OK', content: { 'application/json': { schema } } } });
  const text = (schema: unknown, description: string) => ({
    '200': { description, content: { 'text/plain': { schema } } },
    '400': { description: 'Unsupported duration' },
    '404': { description: 'Unknown endpoint key' },
  });
  return {
    openapi: '3.0.3',
    info: {
      title: 'Gatus API (subset used by Steward)',
      version: '5.37',
      description:
        'Read-only status API plus external endpoint results of Gatus (https://github.com/TwiN/gatus). The status routes require authentication when Gatus has `security.basic` configured (OIDC protects them with a browser session only, which automation cannot use).',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        basic: { type: 'http', scheme: 'basic', description: 'security.basic of the Gatus configuration' },
        externalToken: { type: 'http', scheme: 'bearer', description: 'external-endpoints[].token of the pushed endpoint' },
      },
      schemas: {
        EndpointStatus: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            group: { type: 'string' },
            key: { type: 'string' },
            results: { type: 'array', description: 'Oldest first; the last entry is the latest check', items: { $ref: '#/components/schemas/Result' } },
            events: {
              type: 'array',
              items: {
                type: 'object',
                properties: { type: { type: 'string', enum: ['START', 'HEALTHY', 'UNHEALTHY'] }, timestamp: { type: 'string', format: 'date-time' } },
              },
            },
          },
        },
        Result: {
          type: 'object',
          properties: {
            status: { type: 'integer', description: 'HTTP status (omitted for non-HTTP checks)' },
            hostname: { type: 'string' },
            duration: { type: 'integer', format: 'int64', description: 'Duration of the check in nanoseconds' },
            errors: { type: 'array', items: { type: 'string' } },
            conditionResults: { type: 'array', items: { type: 'object', properties: { condition: { type: 'string' }, success: { type: 'boolean' } } } },
            success: { type: 'boolean' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    paths: {
      '/api/v1/endpoints/statuses': {
        get: {
          operationId: 'listEndpointStatuses',
          tags: ['Status'],
          summary: 'Status and recent results of all endpoints',
          security: [{ basic: [] }, {}],
          parameters: paging,
          responses: json({ type: 'array', items: { $ref: '#/components/schemas/EndpointStatus' } }),
        },
      },
      '/api/v1/endpoints/{key}/statuses': {
        parameters: [key],
        get: {
          operationId: 'getEndpointStatus',
          tags: ['Status'],
          summary: 'Status, recent results and events of one endpoint',
          security: [{ basic: [] }, {}],
          parameters: paging,
          responses: { ...json({ $ref: '#/components/schemas/EndpointStatus' }), '404': { description: 'Unknown endpoint key' } },
        },
      },
      '/api/v1/endpoints/{key}/uptimes/{duration}': {
        parameters: [key, duration(['1h', '24h', '7d', '30d'])],
        get: {
          operationId: 'getEndpointUptime',
          tags: ['Raw data'],
          summary: 'Uptime as a fraction between 0 and 1 (text/plain, e.g. 0.958333)',
          responses: text({ type: 'string', example: '0.958333' }, 'Uptime fraction'),
        },
      },
      '/api/v1/endpoints/{key}/response-times/{duration}': {
        parameters: [key, duration(['1h', '24h', '7d', '30d'])],
        get: {
          operationId: 'getEndpointResponseTime',
          tags: ['Raw data'],
          summary: 'Average response time in milliseconds (text/plain)',
          responses: text({ type: 'string', example: '153' }, 'Average response time (ms)'),
        },
      },
      '/api/v1/endpoints/{key}/external': {
        parameters: [key],
        post: {
          operationId: 'pushExternalEndpointResult',
          tags: ['External endpoints'],
          summary: 'Push a result for an external endpoint (Authorization: Bearer <external-endpoints[].token>)',
          security: [{ externalToken: [] }],
          parameters: [
            { name: 'success', in: 'query', required: true, schema: { type: 'string', enum: ['true', 'false'] } },
            { name: 'error', in: 'query', description: 'Reason of a failed check (ignored when success=true)', schema: { type: 'string' } },
            { name: 'duration', in: 'query', description: 'Go duration string, e.g. 150ms or 1.5s', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Stored' },
            '400': { description: 'Missing/invalid success or invalid duration' },
            '401': { description: 'Missing or wrong token' },
            '404': { description: 'Unknown external endpoint' },
          },
        },
      },
      '/health': {
        get: {
          operationId: 'gatusHealth',
          tags: ['Status'],
          summary: 'Health of Gatus itself',
          responses: json({ type: 'object', properties: { status: { type: 'string' } } }),
        },
      },
    },
  };
}
