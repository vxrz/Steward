import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Locale } from '@sm/shared';
import { t } from '../i18n/index.js';
import { escHtml } from '../notifications/look.js';
import * as engine from '../monitors/engine.js';
import { unsubscribeRecipient, unsubscribeValid } from '../monitors/unsubscribe.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { ACCESS } from '../auth/access.js';

/**
 * Unsubscribing for e-mail addresses outside Steward (0.29.0, monitors/unsubscribe.ts), without sign-in:
 *
 *   GET  /unsubscribe/<token>   a page that asks to confirm (a mail scanner opening the link changes nothing)
 *   POST /unsubscribe/<token>   removes the address; also the one-click POST of RFC 8058 (List-Unsubscribe-Post)
 *
 * The page is plain HTML in English or German by the browser's language. The answer is the same for a wrong, a used
 * and a made-up token, and says nothing about the monitor, the output or the address.
 */

const localeOf = (req: FastifyRequest): Locale => {
  const first = String(req.headers['accept-language'] ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  return first?.startsWith('de') ? 'de' : 'en';
};

function page(locale: Locale, body: string): string {
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escHtml(t(locale, 'unsubscribePage.title'))}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">${body}</body></html>`;
}

const html = (reply: FastifyReply, status: number, locale: Locale, body: string) =>
  reply.code(status).header('cache-control', 'no-store').header('content-language', locale).type('text/html; charset=utf-8').send(page(locale, body));

export async function unsubscribeRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scoped) => {
    // the one-click POST of RFC 8058 sends "List-Unsubscribe=One-Click" as a form: nothing in it is used
    scoped.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, (_req, _body, done) => done(null, {}));
    const config = { access: ACCESS.public, rateLimit: ROUTE_LIMITS.action };
    scoped.get<{ Params: { token: string } }>('/unsubscribe/:token', { config }, async (req, reply) => {
      const locale = localeOf(req);
      const token = req.params.token;
      if (!unsubscribeValid(token)) return html(reply, 404, locale, `<p>${escHtml(t(locale, 'unsubscribePage.invalid'))}</p>`);
      return html(
        reply,
        200,
        locale,
        `<h1 style="font-size:1.4rem">${escHtml(t(locale, 'unsubscribePage.title'))}</h1><p>${escHtml(t(locale, 'unsubscribePage.question'))}</p><form method="post" action="${escHtml(
          req.url.split('?')[0]!,
        )}"><button type="submit" style="font:inherit;padding:.5rem 1rem">${escHtml(t(locale, 'unsubscribePage.button'))}</button></form>`,
      );
    });
    scoped.post<{ Params: { token: string } }>('/unsubscribe/:token', { config, bodyLimit: 1024 }, async (req, reply) => {
      const locale = localeOf(req);
      const monitorId = unsubscribeRecipient(req.params.token);
      if (!monitorId) return html(reply, 404, locale, `<p>${escHtml(t(locale, 'unsubscribePage.invalid'))}</p>`);
      engine.reloadMonitor(monitorId);
      return html(reply, 200, locale, `<p>${escHtml(t(locale, 'unsubscribePage.done'))}</p>`);
    });
  });
}
