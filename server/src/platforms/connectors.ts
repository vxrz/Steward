import { z } from 'zod';
import { fetch, EnvHttpProxyAgent } from 'undici';
import type { ConnectorPackage, PlatformPreset } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, nowIso, parseJson, slugify } from '../util.js';
import { PRESETS } from './presets.js';
import { addSpec, createPlatform, getPlatform, getSecrets, listDocs, listSpecs, getSpecContent, type PlatformInput } from './service.js';
import { platformRequest, resolveBaseUrl } from './http.js';

/**
 * Connector types: a configured platform saved as a reusable template
 * (auth, variables, HTTP options, credential field names, doc links and
 * API specs – never credential values). They can be exported as JSON and
 * imported elsewhere, so adding a new tool is a one-time job.
 */

const packageSchema = z.object({
  format: z.literal('service-manager-connector'),
  version: z.literal(1),
  kind: z.string().min(2).max(64),
  label: z.string().min(1),
  description: z.string().default(''),
  baseUrl: z.string().default(''),
  config: z.any(),
  secretFields: z.array(z.object({ key: z.string(), label: z.string(), help: z.string().optional() })).default([]),
  docs: z.array(z.object({ title: z.string(), url: z.string() })).default([]),
  specs: z.array(z.object({ name: z.string(), content: z.string() })).default([]),
});

function rows(): { kind: string; package: string; created_at: string }[] {
  return db().all('SELECT * FROM platform_types ORDER BY kind');
}

export function listPresets(): PlatformPreset[] {
  const custom = rows().map((r) => {
    const p = parseJson<ConnectorPackage>(r.package, {} as ConnectorPackage);
    return {
      kind: p.kind,
      label: p.label,
      description: p.description,
      baseUrl: p.baseUrl,
      config: p.config,
      secretFields: p.secretFields,
      docs: p.docs,
      custom: true,
      specCount: p.specs.length,
      createdAt: r.created_at,
    } satisfies PlatformPreset;
  });
  return [...PRESETS, ...custom];
}

export function getPackage(kind: string): ConnectorPackage {
  const r = db().get<{ package: string }>('SELECT package FROM platform_types WHERE kind = ?', kind);
  if (!r) throw new HttpError(404, `Connector type "${kind}" not found`);
  return JSON.parse(r.package) as ConnectorPackage;
}

function store(pkg: ConnectorPackage, action: string): PlatformPreset {
  if (db().get('SELECT 1 FROM platform_types WHERE kind = ?', pkg.kind)) {
    throw new HttpError(409, `A connector type "${pkg.kind}" already exists – delete it first or choose another kind`);
  }
  db().tx(() => {
    db().run('INSERT INTO platform_types (kind, package, created_at) VALUES (?, ?, ?)', pkg.kind, JSON.stringify(pkg), nowIso());
    audit({
      action,
      entityType: 'connector',
      entityId: pkg.kind,
      summary: `Connector type "${pkg.label}" (${pkg.kind}) ${action === 'connector.imported' ? 'imported' : 'created'} with ${pkg.specs.length} API spec(s)`,
    });
  });
  return listPresets().find((p) => p.custom && p.kind === pkg.kind)!;
}

export function createTypeFromPlatform(platformId: string, opts: { kind?: string; label?: string; description?: string }): PlatformPreset {
  const p = getPlatform(platformId);
  const secretKeys = Object.keys(getSecrets(platformId));
  const pkg: ConnectorPackage = {
    format: 'service-manager-connector',
    version: 1,
    kind: slugify(opts.kind || p.kind || p.name),
    label: opts.label || p.name,
    description: opts.description ?? p.description,
    baseUrl: p.baseUrl,
    config: { ...p.config, http: { ...p.config.http, caPem: p.config.http?.caPem } },
    secretFields: secretKeys.map((k) => ({ key: k, label: k })),
    docs: listDocs(platformId)
      .filter((d) => d.kind === 'link' && d.url)
      .map((d) => ({ title: d.title, url: d.url! })),
    specs: listSpecs(platformId).map((s) => ({ name: s.name, content: getSpecContent(s.id) })),
  };
  return store(pkg, 'connector.created');
}

export function importType(raw: unknown): PlatformPreset {
  const parsed = packageSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'Not a valid connector file: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const pkg = { ...parsed.data, kind: slugify(parsed.data.kind) } as ConnectorPackage;
  return store(pkg, 'connector.imported');
}

export function deleteType(kind: string): void {
  getPackage(kind);
  db().tx(() => {
    db().run('DELETE FROM platform_types WHERE kind = ?', kind);
    audit({ action: 'connector.deleted', entityType: 'connector', entityId: kind, summary: `Connector type "${kind}" deleted` });
  });
}

/** Create a platform; when based on a custom connector type its API specs are copied. */
export function createPlatformFromType(input: PlatformInput & { typeKind?: string }) {
  const { typeKind, ...rest } = input;
  const pkg = typeKind ? getPackage(typeKind) : undefined;
  const platform = createPlatform({ ...rest, kind: rest.kind || pkg?.kind });
  for (const s of pkg?.specs ?? []) addSpec(platform.id, s.name, s.content);
  return getPlatform(platform.id);
}

const MAX_SPEC_BYTES = 20 * 1024 * 1024;

/** Download a spec. Same-host URLs go through the platform (with its authentication). */
export async function fetchSpec(platformId: string, url: string): Promise<string> {
  const p = getPlatform(platformId);
  const secrets = getSecrets(platformId);
  const base = await resolveBaseUrl(p, secrets).catch(() => '');
  const relative = !/^https?:\/\//i.test(url);
  const sameHost = relative || (base && new URL(url).host === new URL(base).host);
  if (sameHost) {
    const res = await platformRequest(p, secrets, { method: 'GET', url });
    if (!res.ok) throw new HttpError(400, `Download failed: HTTP ${res.status}`);
    return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  }
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)/i.test(url)) throw new HttpError(400, 'Only https URLs are allowed');
  const res = await fetch(url, { dispatcher: new EnvHttpProxyAgent(), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new HttpError(400, `Download failed: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_SPEC_BYTES) throw new HttpError(400, 'Specification is too large');
  return text;
}
