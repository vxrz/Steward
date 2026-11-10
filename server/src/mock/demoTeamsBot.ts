import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { identityKeys } from '../auth/sso-claims.js';
import { useMockFramework } from '../msteams/framework.js';
import { handleBotRequest } from '../msteams/bot.js';
import { startMockBotConnector, type MockBotConnector } from './mockBotConnector.js';

/**
 * The Teams bot in the demo (SM_DEMO=1, mounted under /mock): the UI tests drive it end to end without Microsoft.
 * `_setup` starts the mock Bot Framework (mockBotConnector.ts) in this process and points the bot at it, adds an Entra
 * sign-in provider that identifies people by tid + oid (no network) and links a user to an object id – what a single
 * sign-on would do. `_activity` hands the bot an activity signed by the mock, as Microsoft's Bot Connector would send it;
 * `_sent` lists what the bot posted. The bot's settings and the assurance approval are made through the API as usual.
 */

export const DEMO_TEAMS_BOT = {
  appId: '3b0c1d2e-0000-4000-8000-00000000b075',
  tenantId: '6f1b2c3d-0000-4000-8000-00000000c0de',
  providerId: 'idp_demo_teams_bot',
} as const;

const setupInput = z.object({ username: z.string().min(1).max(100), oid: z.string().uuid() }).strict();

export async function mockTeamsBot(app: FastifyInstance): Promise<void> {
  let mock: MockBotConnector | null = null;
  const issuer = `https://login.microsoftonline.com/${DEMO_TEAMS_BOT.tenantId}/v2.0`;

  app.post('/teams-bot/_setup', async (req, reply) => {
    const b = setupInput.parse(req.body ?? {});
    if (!mock) {
      mock = await startMockBotConnector({ appId: DEMO_TEAMS_BOT.appId });
      useMockFramework(mock.endpoints);
    }
    const now = new Date().toISOString();
    db().run(
      'INSERT INTO identity_providers (id, config, secret, enabled, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?) ON CONFLICT(id) DO NOTHING',
      DEMO_TEAMS_BOT.providerId,
      JSON.stringify({ type: 'entra', displayName: 'Entra ID (Teams bot demo)', issuer, clientId: 'demo-teams-bot', stableIdClaims: ['tid', 'oid'] }),
      now,
      now,
    );
    const key = identityKeys(DEMO_TEAMS_BOT.providerId, { iss: issuer, tid: DEMO_TEAMS_BOT.tenantId, oid: b.oid }, ['tid', 'oid']).key;
    if (!key || db().run('UPDATE users SET external_id = ? WHERE username = ?', key, b.username).changes !== 1)
      return reply.code(404).send({ error: 'no such user' });
    return { ...DEMO_TEAMS_BOT, connectorUrl: mock.url };
  });

  app.post('/teams-bot/_activity', async (req, reply) => {
    if (!mock) return reply.code(409).send({ error: 'call _setup first' });
    const a = { channelId: 'msteams', serviceUrl: mock.url, recipient: { id: `28:${DEMO_TEAMS_BOT.appId}` }, ...(req.body as object) };
    const r = await handleBotRequest({ 'content-type': 'application/json', authorization: `Bearer ${mock.sign({})}` }, JSON.stringify(a));
    return reply.code(r.status).send(r.body ?? {});
  });

  app.get('/teams-bot/_sent', async () => mock?.sent ?? []);
}
