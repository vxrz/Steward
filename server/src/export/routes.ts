import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { validateProcess, type Platform } from '@sm/shared';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { HttpError } from '../util.js';
import * as processes from '../processes/service.js';
import * as platforms from '../platforms/service.js';
import { contentDisposition } from '../records/attachments.js';
import { ZipWriter } from '../compliance/zip.js';
import { platformToPostman, processToPostman, type PostmanExport, type SlotBinding } from './postman.js';
import { params } from '../routes/params.js';

/**
 * Postman export (#204): GET /api/processes/:id/export/postman and GET /api/platforms/:id/export/postman. Who may see
 * the process or the platform may export it – the export holds what its page shows, without any secret. A ZIP with
 * the collection and the environment (both Postman's own files, ready for Import or `newman run -e`), or one of them
 * as JSON (?file=collection|environment). Every export is audited.
 */
const fileQuery = z.enum(['collection', 'environment']).optional();
const processQuery = z.object({
  version: z.coerce.number().int().min(1).optional(),
  /** slot:platformId,slot:platformId – the platforms to export the connections for (the run dialog's last choice) */
  bindings: z
    .string()
    .max(4000)
    .regex(/^([A-Za-z_][A-Za-z0-9_]*:[^,:]{1,200})?(,[A-Za-z_][A-Za-z0-9_]*:[^,:]{1,200})*$/, 'slot:platformId, separated by commas')
    .optional(),
  file: fileQuery,
});
const platformQuery = z.object({ file: fileQuery });

const options = () => ({ stewardVersion: config.version, exportedAt: new Date().toISOString() });

/** A platform the current user has some right on (the export shows what its page shows); undefined otherwise. */
function visible(id: string): Platform | undefined {
  try {
    const p = platforms.getPlatform(id);
    return p.permissions.length ? p : undefined;
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) return undefined;
    throw e;
  }
}

async function send(reply: FastifyReply, out: PostmanExport, file: 'collection' | 'environment' | undefined) {
  const collectionName = `${out.fileBase}.postman_collection.json`;
  const environmentName = `${out.fileBase}.postman_environment.json`;
  if (file) {
    reply.header('content-disposition', contentDisposition(file === 'collection' ? collectionName : environmentName));
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(file === 'collection' ? out.collection : out.environment, null, 2));
  }
  // a folder of its own (mkdtemp: unique, mode 0700), removed right after
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-postman-'));
  try {
    const zipFile = path.join(dir, 'export.zip');
    const zip = await ZipWriter.create(zipFile);
    try {
      await zip.add(collectionName, Buffer.from(JSON.stringify(out.collection, null, 2)), { compress: true });
      await zip.add(environmentName, Buffer.from(JSON.stringify(out.environment, null, 2)), { compress: true });
      await zip.finish();
    } catch (e) {
      await zip.abort();
      throw e;
    }
    const data = fs.readFileSync(zipFile);
    reply.header('content-disposition', contentDisposition(`${out.fileBase}.postman.zip`));
    return reply.type('application/zip').send(data);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function postmanExportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/processes/:id/export/postman', async (req, reply) => {
    const id = params(req).id!;
    if (!processes.permissionsFor(id).includes('view')) throw new HttpError(404, `Process ${id} not found`);
    const q = processQuery.parse(req.query ?? {});
    const p = processes.getProcess(id, q.version);
    const definition = validateProcess(p.definition).definition ?? p.definition;
    const asked = new Map((q.bindings ? q.bindings.split(',') : []).map((pair) => pair.split(':') as [string, string]));
    const all = platforms.listPlatforms().filter((x) => x.permissions.length > 0);
    const bindings: Record<string, SlotBinding> = {};
    for (const c of definition.connections ?? []) {
      const wanted = asked.get(c.slot);
      if (wanted) {
        const platform = visible(wanted);
        bindings[c.slot] = platform ? { platform, how: 'as chosen for the export' } : { how: 'the chosen platform is not available' };
        continue;
      }
      const matching = c.kind ? all.filter((x) => x.kind === c.kind) : [];
      if (matching.length === 1) bindings[c.slot] = { platform: matching[0]!, how: `the only platform of kind ${c.kind} you can see` };
    }
    const version = q.version ?? p.currentVersion;
    const out = processToPostman({ id, name: definition.name || p.name, version, definition }, bindings, options());
    audit({
      action: 'process.exported_postman',
      entityType: 'process',
      entityId: id,
      summary: `Process "${p.name}" (version ${version}) exported for Postman`,
      details: {
        version,
        file: q.file ?? 'zip',
        platforms: Object.fromEntries(Object.entries(bindings).map(([slot, b]) => [slot, b.platform?.id ?? null])),
      },
    });
    return send(reply, out, q.file);
  });

  app.get('/platforms/:id/export/postman', async (req, reply) => {
    const id = params(req).id!;
    const p = visible(id);
    if (!p) throw new HttpError(404, `Platform ${id} not found`);
    const q = platformQuery.parse(req.query ?? {});
    const operations = platforms.listOperations(id);
    const out = platformToPostman(p, operations, options());
    audit({
      action: 'platform.exported_postman',
      entityType: 'platform',
      entityId: id,
      summary: `Platform "${p.name}" exported for Postman (${operations.length} operation(s))`,
      details: { operations: operations.length, file: q.file ?? 'zip' },
    });
    return send(reply, out, q.file);
  });
}
