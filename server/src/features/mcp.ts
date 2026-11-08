import { MCP_OAUTH_MIGRATIONS } from '../migrations/mcp-oauth.js';
import { defineFeature } from './define.js';

/** The MCP server and its OAuth sign-in (routes in app.ts: they live outside the internal API's scope). */
export default defineFeature({
  name: 'mcp',
  migrations: [MCP_OAUTH_MIGRATIONS],
});
