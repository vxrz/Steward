import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * A simulated CSAF 2.0 trusted provider for demo mode and tests (docs/ADVISORIES.md), mounted at /mock/csaf. It serves
 * the invented advisories of examples/plant/advisories (vendors and products of the demo enterprise) the way CSAF 2.0
 * section 7 distributes them:
 *
 *   /.well-known/csaf/provider-metadata.json        requirement 7: a ROLIE feed and a directory distribution
 *   /.well-known/csaf/white/feed-tlp-white.json     requirement 15: the ROLIE feed with self, hash and signature links
 *   /.well-known/csaf/white/<year>/<file>.json      the documents; <file>.json.sha256 and .sha512 (requirement 18)
 *   /.well-known/csaf/white/index.txt, changes.csv  requirements 12 and 13
 *
 * Links are relative, so the provider works under any base path. Test hooks: `?tamper=1` on a document answers a changed
 * file (its hash no longer matches); /mock/csaf/test/* answer what a broken provider would.
 */

const DIR = () => path.join(config.examplesDir, 'plant', 'advisories');

interface Doc {
  file: string;
  year: string;
  body: Buffer;
  id: string;
  title: string;
  current: string;
  initial: string;
}

function docs(): Doc[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(DIR())
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
  return names.map((file) => {
    const body = fs.readFileSync(path.join(DIR(), file));
    const d = JSON.parse(body.toString('utf8')) as {
      document: { title: string; tracking: { id: string; current_release_date: string; initial_release_date: string } };
    };
    return {
      file,
      year: d.document.tracking.initial_release_date.slice(0, 4),
      body,
      id: d.document.tracking.id,
      title: d.document.title,
      current: d.document.tracking.current_release_date,
      initial: d.document.tracking.initial_release_date,
    };
  });
}

const hash = (algo: 'sha256' | 'sha512', b: Buffer) => crypto.createHash(algo).update(b).digest('hex');

export async function mockCsaf(app: FastifyInstance): Promise<void> {
  const base = '/csaf/.well-known/csaf';
  app.get(`${base}/provider-metadata.json`, async () => ({
    canonical_url: 'https://psirt.example.com/.well-known/csaf/provider-metadata.json',
    distributions: [{ rolie: { feeds: [{ summary: 'Invented TLP:WHITE advisories for the demo', tlp_label: 'WHITE', url: 'white/feed-tlp-white.json' }] } }],
    last_updated: new Date().toISOString(),
    list_on_CSAF_aggregators: true,
    metadata_version: '2.0',
    mirror_on_CSAF_aggregators: true,
    publisher: { category: 'coordinator', name: 'Example PSIRTs (demo)', namespace: 'https://psirt.example.com' },
    role: 'csaf_trusted_provider',
  }));
  // the same provider, distributed as a directory only (requirements 11–13)
  app.get('/csaf/directory/provider-metadata.json', async () => ({
    canonical_url: 'https://psirt.example.com/directory/provider-metadata.json',
    distributions: [{ directory_url: '../.well-known/csaf/white/' }],
    last_updated: new Date().toISOString(),
    list_on_CSAF_aggregators: true,
    metadata_version: '2.0',
    mirror_on_CSAF_aggregators: true,
    publisher: { category: 'coordinator', name: 'Example PSIRTs (demo, directory)', namespace: 'https://psirt.example.com' },
    role: 'csaf_provider',
  }));
  app.get('/csaf/aggregator.json', async () => ({
    aggregator: { category: 'lister', name: 'Example aggregator (demo)', namespace: 'https://aggregator.example.com' },
    aggregator_version: '2.0',
    canonical_url: 'https://aggregator.example.com/.well-known/csaf-aggregator/aggregator.json',
    csaf_providers: [
      { metadata: { last_updated: new Date().toISOString(), publisher: { name: 'Example PSIRTs (demo)' }, url: '.well-known/csaf/provider-metadata.json' } },
    ],
    last_updated: new Date().toISOString(),
  }));
  app.get(`${base}/white/feed-tlp-white.json`, async () => ({
    feed: {
      id: 'example-psirts-tlp-white',
      title: 'Example PSIRTs (demo) – TLP:WHITE',
      link: [{ rel: 'self', href: 'feed-tlp-white.json' }],
      category: [{ scheme: 'urn:ietf:params:rolie:category:information-type', term: 'csaf' }],
      updated: new Date().toISOString(),
      entry: docs().map((d) => ({
        id: d.id,
        title: d.title,
        link: [
          { rel: 'self', href: `${d.year}/${d.file}` },
          { rel: 'hash', href: `${d.year}/${d.file}.sha256` },
          { rel: 'signature', href: `${d.year}/${d.file}.asc` },
        ],
        published: d.initial,
        updated: d.current,
        content: { type: 'application/json', src: `${d.year}/${d.file}` },
        format: { schema: 'https://docs.oasis-open.org/csaf/csaf/v2.0/csaf_json_schema.json', version: '2.0' },
      })),
    },
  }));
  app.get(`${base}/white/index.txt`, async (_req, reply) =>
    reply.type('text/plain').send(
      docs()
        .map((d) => `${d.year}/${d.file}`)
        .join('\n'),
    ),
  );
  app.get(`${base}/white/changes.csv`, async (_req, reply) =>
    reply.type('text/csv').send(
      docs()
        .sort((a, b) => b.current.localeCompare(a.current))
        .map((d) => `"${d.year}/${d.file}","${d.current}"`)
        .join('\n'),
    ),
  );
  app.get(`${base}/white/:year/:file`, async (req, reply) => {
    const { year, file } = req.params as { year: string; file: string };
    const q = req.query as { tamper?: string };
    const algo = file.endsWith('.sha256') ? 'sha256' : file.endsWith('.sha512') ? 'sha512' : null;
    const name = algo ? file.slice(0, -7) : file;
    const d = docs().find((x) => x.year === year && x.file === name);
    if (!d) return reply.code(404).send({ error: 'not found' });
    if (algo) return reply.type('text/plain').send(`${hash(algo, d.body)}  ${d.file}\n`);
    return reply
      .type('application/json')
      .send(q.tamper === '1' ? Buffer.from(d.body.toString('utf8').replace('"status": "final"', '"status": "interim"')) : d.body);
  });
  // a provider whose document was changed after its hash file was written
  app.get('/csaf/test/tampered-feed.json', async () => {
    const d = docs()[0]!;
    return {
      feed: {
        id: 'tampered',
        title: 'Tampered',
        updated: new Date().toISOString(),
        entry: [
          {
            id: d.id,
            link: [{ rel: 'hash', href: `../.well-known/csaf/white/${d.year}/${d.file}.sha256` }],
            updated: d.current,
            content: { src: `../.well-known/csaf/white/${d.year}/${d.file}?tamper=1` },
          },
        ],
      },
    };
  });
  // a provider that sends Steward elsewhere (the outbound policy checks every redirect hop)
  app.get('/csaf/test/redirect-feed.json', async (_req, reply) => reply.redirect('https://csaf-elsewhere.example.invalid/feed.json'));
}
