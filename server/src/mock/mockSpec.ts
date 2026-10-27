/** Small OpenAPI description of the simulated Insights Hub identity API (demo mode). */
export function mockIdentitySpec(): Record<string, unknown> {
  const scimList = (item: string) => ({
    type: 'object',
    properties: {
      resources: { type: 'array', items: { $ref: `#/components/schemas/${item}` } },
      totalResults: { type: 'integer' },
      itemsPerPage: { type: 'integer' },
      startIndex: { type: 'integer' },
    },
  });
  const paging = [
    { name: 'filter', in: 'query', description: 'SCIM filter, e.g. userName eq "a@b.com"', schema: { type: 'string' } },
    { name: 'startIndex', in: 'query', schema: { type: 'integer', default: 1 } },
    { name: 'count', in: 'query', schema: { type: 'integer', default: 100 } },
  ];
  const ok = (schema: unknown) => ({ '200': { description: 'OK', content: { 'application/json': { schema } } } });
  return {
    openapi: '3.0.3',
    info: { title: 'Identity Management (demo)', version: '3.0.0', description: 'Subset of the Insights Hub Identity Management API served by the demo mock.' },
    servers: [{ url: '/api/identitymanagement/v3' }],
    paths: {
      '/api/identitymanagement/v3/Users': {
        get: { operationId: 'listUsers', tags: ['Users'], summary: 'List users', parameters: paging, responses: ok(scimList('User')) },
        post: {
          operationId: 'createUser',
          tags: ['Users'],
          summary: 'Create a user',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewUser' } } } },
          responses: { '201': { description: 'Created' } },
        },
      },
      '/api/identitymanagement/v3/Users/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        get: { operationId: 'getUser', tags: ['Users'], summary: 'Get a user', responses: ok({ $ref: '#/components/schemas/User' }) },
        delete: { operationId: 'deleteUser', tags: ['Users'], summary: 'Delete a user', responses: { '200': { description: 'Deleted' } } },
      },
      '/api/identitymanagement/v3/Groups': {
        get: { operationId: 'listGroups', tags: ['Groups'], summary: 'List groups and roles', parameters: paging, responses: ok(scimList('Group')) },
      },
      '/api/identitymanagement/v3/Groups/{id}/members': {
        parameters: [{ name: 'id', in: 'path', required: true, description: 'Group id', schema: { type: 'string' } }],
        get: {
          operationId: 'listGroupMembers',
          tags: ['Groups'],
          summary: 'List members of a group',
          responses: ok({ type: 'array', items: { $ref: '#/components/schemas/Member' } }),
        },
        post: {
          operationId: 'addGroupMember',
          tags: ['Groups'],
          summary: 'Add a member to a group',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Member' } } } },
          responses: { '201': { description: 'Added' }, '409': { description: 'Already a member' } },
        },
      },
      '/api/identitymanagement/v3/Groups/{id}/members/{memberId}': {
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'memberId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        delete: {
          operationId: 'removeGroupMember',
          tags: ['Groups'],
          summary: 'Remove a member from a group',
          responses: { '200': { description: 'Removed' } },
        },
      },
    },
    components: {
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            userName: { type: 'string', format: 'email' },
            name: { type: 'object', properties: { givenName: { type: 'string' }, familyName: { type: 'string' } } },
            active: { type: 'boolean' },
            lastLogonTime: {
              type: ['string', 'integer', 'null'],
              description:
                'Not in the official spec. An ISO 8601 date-time or epoch milliseconds, depending on the tenant; missing or null when the user never signed in.',
            },
            groups: {
              type: 'array',
              items: {
                type: 'object',
                properties: { display: { type: 'string' }, value: { type: 'string' }, type: { type: 'string', enum: ['DIRECT', 'INDIRECT'] } },
              },
            },
          },
        },
        NewUser: {
          type: 'object',
          required: ['userName'],
          properties: {
            userName: { type: 'string', format: 'email' },
            name: { type: 'object', properties: { givenName: { type: 'string' }, familyName: { type: 'string' } } },
            active: { type: 'boolean', default: true },
          },
        },
        Group: { type: 'object', properties: { id: { type: 'string' }, displayName: { type: 'string' }, description: { type: 'string' } } },
        Member: { type: 'object', properties: { type: { type: 'string', enum: ['USER', 'GROUP'] }, value: { type: 'string' } } },
      },
    },
  };
}
