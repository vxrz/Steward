import { db } from '../db.js';
import { audit } from '../audit.js';
import { nowIso } from '../util.js';

/**
 * Ends OAuth connections of MCP clients (#12) for good: of one person (deactivated, or their password reset by an
 * administrator) or of everyone (OAuth sign-in turned off). Their tokens are refused from then on, and turning the
 * account or OAuth back on does not bring them back – the person connects the client again (one consent).
 * MCP and API tokens are not touched: they are named, listed and revoked by their owner or an administrator.
 * Kept apart from oauth.ts, which needs the user module: the user module calls this.
 */
export function revokeOAuthGrants(scope: { userId: string; username: string } | 'all', why: string): number {
  const ts = nowIso();
  const n =
    scope === 'all'
      ? db().run('UPDATE oauth_grants SET revoked_at = ? WHERE revoked_at IS NULL', ts).changes
      : db().run('UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', ts, scope.userId).changes;
  if (n)
    audit({
      action: 'mcp.oauth_grants_revoked',
      entityType: scope === 'all' ? 'settings' : 'user',
      entityId: scope === 'all' ? 'mcp' : scope.userId,
      summary: `${n} MCP client connection(s) ${scope === 'all' ? 'of everyone' : `of "${scope.username}"`} revoked: ${why}`,
      details: { count: n, reason: why },
    });
  return n;
}
