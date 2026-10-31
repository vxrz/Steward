import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BRAND, THEME_COLOR_SCHEMES, THEME_LOGO_MAX_BYTES, THEME_RADII } from '@sm/shared';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { HttpError } from '../util.js';
import * as theme from './service.js';
import { ACCESS, withCapability } from '../auth/access.js';

/**
 * Theme routes (registered at the root, full paths):
 *   GET    /api/theme                 public: colours, scheme, radius, name, logo URL (ETag, revalidated)
 *   GET    /api/theme/logo            public: the header logo (immutable with ?v=<hash>)
 *   GET    /manifest.webmanifest      web app manifest with the theme colour and display name
 *   GET    /api/settings/theme        administrators: stored settings incl. logo details
 *   PUT    /api/settings/theme        administrators: change colours, scheme, radius, name
 *   POST   /api/settings/theme/reset  administrators: back to the Steward defaults
 *   POST   /api/settings/theme/logo   administrators: upload PNG/JPEG/WebP (≤ 512 KB)
 *   DELETE /api/settings/theme/logo   administrators: remove the logo
 */

const admin = (what: string) => withCapability('manageSettings', what);

const hex = z.string().max(16);
const themeBody = z
  .object({
    primaryColor: hex.optional(),
    accentColor: hex.optional(),
    colorScheme: z.enum(THEME_COLOR_SCHEMES).optional(),
    radius: z.enum(THEME_RADII).optional(),
    appName: z.string().max(200).optional(),
  })
  .strict();

const MANIFEST_BASE = {
  description: BRAND.tagline,
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#ffffff',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

/** The manifest of the web build (icons, shortcuts) with the configured name and theme colour. */
function manifest(): string {
  let base: Record<string, unknown> = MANIFEST_BASE;
  try {
    base = JSON.parse(fs.readFileSync(path.join(config.webDist, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>;
  } catch {
    /* no web build: the built-in defaults */
  }
  const t = theme.publicTheme();
  const name = t.appName || BRAND.name;
  return JSON.stringify(
    { ...below(base, config.basePath), name, short_name: t.appName ? name.slice(0, 30) : BRAND.shortName, theme_color: t.primaryColor },
    null,
    2,
  );
}

/** The manifest's own URLs (start_url, scope, icons, shortcuts) below the base path (SM_BASE_PATH). */
function below(m: Record<string, unknown>, basePath: string): Record<string, unknown> {
  if (!basePath) return m;
  const at = (u: unknown) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? basePath + u : u);
  const list = (v: unknown, key: string) =>
    Array.isArray(v)
      ? v.map((x) => (x && typeof x === 'object' ? { ...(x as Record<string, unknown>), [key]: at((x as Record<string, unknown>)[key]) } : x))
      : v;
  return {
    ...m,
    start_url: at(m.start_url),
    scope: at(m.scope),
    ...(m.icons ? { icons: list(m.icons, 'src') } : {}),
    ...(m.shortcuts ? { shortcuts: list(m.shortcuts, 'url') } : {}),
  };
}

async function readUpload(req: FastifyRequest): Promise<Buffer> {
  if (req.isMultipart()) {
    const file = await req.file({ limits: { fileSize: THEME_LOGO_MAX_BYTES + 1, files: 1 } });
    if (!file) throw new HttpError(400, 'No file', 'THEME_LOGO_EMPTY');
    const data = await file.toBuffer().catch(() => {
      throw new HttpError(400, `The logo is too large (max. ${THEME_LOGO_MAX_BYTES / 1024} KB)`, 'THEME_LOGO_TOO_LARGE');
    });
    if (file.file.truncated) throw new HttpError(400, `The logo is too large (max. ${THEME_LOGO_MAX_BYTES / 1024} KB)`, 'THEME_LOGO_TOO_LARGE');
    return data;
  }
  const b = z.object({ contentBase64: z.string().min(1) }).safeParse(req.body ?? {});
  if (!b.success) throw new HttpError(400, 'Upload a PNG, JPEG or WebP image', 'THEME_LOGO_TYPE');
  if (b.data.contentBase64.length > Math.ceil((THEME_LOGO_MAX_BYTES * 4) / 3) + 16) {
    throw new HttpError(400, `The logo is too large (max. ${THEME_LOGO_MAX_BYTES / 1024} KB)`, 'THEME_LOGO_TOO_LARGE');
  }
  return Buffer.from(b.data.contentBase64, 'base64');
}

export async function themeRoutes(app: FastifyInstance): Promise<void> {
  // ---------- public ----------
  app.get('/api/theme', { config: { access: ACCESS.public } }, async (req, reply) => {
    const body = JSON.stringify(theme.publicTheme());
    const etag = theme.etagOf(body);
    // cacheable, but always revalidated: a theme change reaches every browser on its next poll
    reply.header('cache-control', 'public, no-cache');
    reply.header('etag', etag);
    if (theme.notModified(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(body);
  });

  app.get('/api/theme/logo', { config: { access: ACCESS.public } }, async (req, reply) => {
    const l = theme.logoFile();
    if (!l) throw new HttpError(404, 'No logo configured');
    const etag = `"${l.sha256.slice(0, 32)}"`;
    const v = (req.query as { v?: string }).v;
    reply.header('etag', etag);
    reply.header('cache-control', v && l.sha256.startsWith(v) ? 'public, max-age=31536000, immutable' : 'public, no-cache');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-disposition', `inline; filename="logo.${l.mime.split('/')[1]}"`);
    // an image needs nothing else; this also keeps the response inert when opened directly
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    if (theme.notModified(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.type(l.mime).send(l.data);
  });

  app.get('/manifest.webmanifest', async (req, reply) => {
    const body = manifest();
    const etag = theme.etagOf(body);
    reply.header('cache-control', 'public, no-cache');
    reply.header('etag', etag);
    if (theme.notModified(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.type('application/manifest+json; charset=utf-8').send(body);
  });

  // ---------- administrators ----------
  app.get('/api/settings/theme', { config: { access: ACCESS.admin } }, async () => {
    admin('view the theme settings');
    return theme.getThemeSettings();
  });

  app.put('/api/settings/theme', { config: { access: ACCESS.admin } }, async (req) => {
    const u = admin('change the theme');
    const b = themeBody.parse(req.body ?? {});
    const { settings, changed } = theme.updateTheme(b, u.username);
    if (Object.keys(changed).length) {
      audit({
        action: 'theme.updated',
        entityType: 'settings',
        entityId: 'theme',
        summary: `Theme changed (${Object.keys(changed).join(', ')})`,
        details: changed,
      });
    }
    return settings;
  });

  app.post('/api/settings/theme/reset', { config: { access: ACCESS.admin } }, async () => {
    admin('change the theme');
    const before = theme.getThemeSettings();
    const after = theme.resetTheme();
    audit({
      action: 'theme.reset',
      entityType: 'settings',
      entityId: 'theme',
      summary: 'Theme reset to the defaults',
      details: {
        from: {
          primaryColor: before.primaryColor,
          accentColor: before.accentColor,
          colorScheme: before.colorScheme,
          radius: before.radius,
          appName: before.appName,
          logo: before.logo?.sha256 ?? null,
        },
      },
    });
    return after;
  });

  app.post('/api/settings/theme/logo', { config: { access: ACCESS.admin } }, async (req) => {
    admin('change the theme');
    const data = await readUpload(req);
    const after = theme.setLogo(data);
    audit({
      action: 'theme.logo_uploaded',
      entityType: 'settings',
      entityId: 'theme',
      summary: `Header logo uploaded (${after.logo!.mime}, ${after.logo!.width}×${after.logo!.height}, ${data.length} bytes)`,
      details: { sha256: after.logo!.sha256, size: data.length, mime: after.logo!.mime, width: after.logo!.width, height: after.logo!.height },
    });
    return after;
  });

  app.delete('/api/settings/theme/logo', { config: { access: ACCESS.admin } }, async () => {
    admin('change the theme');
    const before = theme.getThemeSettings();
    const after = theme.removeLogo();
    if (before.logo)
      audit({
        action: 'theme.logo_removed',
        entityType: 'settings',
        entityId: 'theme',
        summary: 'Header logo removed',
        details: { sha256: before.logo.sha256 },
      });
    return after;
  });
}
