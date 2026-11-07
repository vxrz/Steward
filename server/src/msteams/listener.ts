import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { logger } from '../log.js';
import { BOT_BODY_LIMIT, handleBotRequest } from './bot.js';

/**
 * The separate, minimal listener of the Teams bot (ADR 0013 decision 3, SM_TEAMS_BOT_PORT). It serves exactly one
 * route, `POST /teams/bot/messages`: no cookies, no sessions, no web app, no static files, no other API. Publishing this
 * port to the internet cannot expose anything else of Steward, even if a reverse-proxy rule is wrong.
 */

export const BOT_PATH = '/teams/bot/messages';

export async function buildBotApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // a little above the limit, so a larger body is answered 413 by the handler's own check (not a parser error)
    bodyLimit: BOT_BODY_LIMIT + 1024,
    ...(config.tls ? { https: { cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key), minVersion: 'TLSv1.2' as const } } : {}),
  }) as unknown as FastifyInstance;
  // the body is read as text: the handler checks size and JSON itself (415 for anything else)
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });
  app.post(BOT_PATH, async (req, reply) => {
    try {
      const r = await handleBotRequest(req.headers, req.body as string | undefined);
      reply.code(r.status);
      return r.body === undefined ? reply.send() : reply.type('application/json').send(JSON.stringify(r.body));
    } catch (err) {
      logger.warn({ err }, 'Teams bot: the call failed');
      return reply.code(500).send();
    }
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send());
  app.setErrorHandler((err, _req, reply) => reply.code((err as { statusCode?: number }).statusCode === 413 ? 413 : 400).send());
  return app;
}

/** Starts the listener when SM_TEAMS_BOT_PORT is set; returns it (or null). */
export async function startBotListener(): Promise<FastifyInstance | null> {
  if (!config.teamsBotPort) return null;
  const app = await buildBotApp();
  await app.listen({ host: config.teamsBotHost, port: config.teamsBotPort });
  logger.info({ host: config.teamsBotHost, port: config.teamsBotPort, path: BOT_PATH }, 'Teams bot listener started (preview)');
  return app;
}
