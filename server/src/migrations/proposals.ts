import type { NamedMigration } from '../db.js';

/**
 * Control catalogue and mapping proposals of AI assistants (#74): the proposal itself on the MCP request, and on a
 * mapping who proposed and accepted it.
 */
export const PROPOSAL_MIGRATIONS: NamedMigration[] = [
  {
    name: 'proposals-001',
    sql: `
      ALTER TABLE mcp_requests ADD COLUMN payload TEXT;
      ALTER TABLE control_tags ADD COLUMN suggestion TEXT;
    `,
  },
];
