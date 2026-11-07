import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * A demo changedetection.io (#242) under /mock/changedetection: the read endpoints Steward uses, in the shape of the
 * real API (docs/api-spec.yaml 0.1.9) – the watch list with tag UUIDs and unix seconds, a watch with its settings
 * (including a notification URL and request headers that Steward must strip), the snapshot times, the tags and
 * systeminfo – plus a plain diff page for the links. Requests need the demo API key (x-api-key); a wrong key answers
 * 403 like changedetection.io. Vendors and hosts are invented. Tests change a watch (setDemoWatch) and reset.
 */

export const DEMO_CHANGEDETECTION = { apiKey: 'demo-changedetection-api-key' };

interface DemoWatch {
  uuid: string;
  title: string;
  url: string;
  tags: string[];
  paused: boolean;
  /** Hours ago (null: never) */
  checkedHoursAgo: number | null;
  /** Hours ago of every snapshot, oldest first: the first is the initial fetch, the others are changes */
  snapshotsHoursAgo: number[];
  error: string | null;
}

const TAGS: Record<string, string> = {
  '3f0a6b52-6c1d-4f7e-9a21-0b6e1c2d3a01': 'vendor-terms',
  '3f0a6b52-6c1d-4f7e-9a21-0b6e1c2d3a02': 'pricing',
  '3f0a6b52-6c1d-4f7e-9a21-0b6e1c2d3a03': 'release-notes',
  '3f0a6b52-6c1d-4f7e-9a21-0b6e1c2d3a04': 'status-page',
  '3f0a6b52-6c1d-4f7e-9a21-0b6e1c2d3a05': 'docs',
};
const tagId = (name: string) => Object.entries(TAGS).find(([, n]) => n === name)![0];

const seed = (): DemoWatch[] => [
  {
    uuid: '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e01',
    title: 'Zentrova Cloud – Terms of service',
    url: 'https://zentrova.example.com/legal/terms',
    tags: ['vendor-terms'],
    paused: false,
    checkedHoursAgo: 0.2,
    snapshotsHoursAgo: [24 * 60, 24 * 21, 3],
    error: null,
  },
  {
    uuid: '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e02',
    title: 'Zentrova Cloud – Pricing',
    url: 'https://zentrova.example.com/pricing',
    tags: ['pricing'],
    paused: false,
    checkedHoursAgo: 0.5,
    snapshotsHoursAgo: [24 * 60, 24 * 9],
    error: null,
  },
  {
    uuid: '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e03',
    title: 'Halvex Edge – Release notes',
    url: 'https://docs.halvex.example.com/edge/release-notes',
    tags: ['release-notes', 'docs'],
    paused: false,
    checkedHoursAgo: 1,
    snapshotsHoursAgo: [24 * 45, 24 * 12, 30],
    error: null,
  },
  {
    uuid: '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e04',
    title: 'Paylumen – Status page',
    url: 'https://status.paylumen.example.com/',
    tags: ['status-page'],
    paused: false,
    checkedHoursAgo: 0.1,
    snapshotsHoursAgo: [24 * 30],
    error: 'Received HTTP 503 from the server, check the URL or try again later',
  },
  {
    uuid: '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e05',
    title: 'Corvana Maps – API documentation',
    url: 'https://developer.corvana.example.com/maps/api',
    tags: ['docs'],
    paused: true,
    checkedHoursAgo: 24 * 14,
    snapshotsHoursAgo: [24 * 90, 24 * 40],
    error: null,
  },
  {
    uuid: '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e06',
    title: 'Mailbrook – Data processing agreement',
    url: 'https://mailbrook.example.com/legal/dpa',
    tags: ['vendor-terms'],
    paused: false,
    checkedHoursAgo: 2,
    snapshotsHoursAgo: [24 * 120],
    error: null,
  },
];

let watches = seed();
export function resetChangedetection(): void {
  watches = seed();
}
/** Changes a demo watch (tests): e.g. { error: '…' } or { snapshotsHoursAgo: [100, 1] }. */
export function setDemoWatch(uuid: string, patch: Partial<Omit<DemoWatch, 'uuid'>>): void {
  const w = watches.find((x) => x.uuid === uuid);
  if (w) Object.assign(w, patch);
}

/** Deletes a demo watch (tests): it disappears from the list like a watch deleted in changedetection.io. */
export function removeDemoWatch(uuid: string): void {
  watches = watches.filter((x) => x.uuid !== uuid);
}

const secondsAgo = (hours: number) => Math.floor(Date.now() / 1000 - hours * 3600);

/** The fields of GET /api/v1/watch (changedetectionio/api/Watch.py, CreateWatch.get). */
const summary = (w: DemoWatch) => ({
  last_changed: w.snapshotsHoursAgo.length > 1 ? secondsAgo(w.snapshotsHoursAgo.at(-1)!) : 0,
  last_checked: w.checkedHoursAgo === null ? 0 : secondsAgo(w.checkedHoursAgo),
  last_error: w.error ?? false,
  link: w.url,
  notification_muted: false,
  open_link: w.url,
  page_title: w.title,
  paused: w.paused,
  processor: 'text_json_diff',
  tags: w.tags.map(tagId),
  title: w.title,
  url: w.url,
  viewed: true,
});

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.headers['x-api-key'] === DEMO_CHANGEDETECTION.apiKey) return true;
  void reply.code(403).send('Invalid access - API key invalid.');
  return false;
}

export async function mockChangedetection(app: FastifyInstance): Promise<void> {
  const P = '/changedetection/api/v1';
  const find = (req: FastifyRequest) => watches.find((w) => w.uuid === (req.params as { uuid: string }).uuid);

  app.post('/changedetection/reset', async () => {
    resetChangedetection();
    return { ok: true };
  });
  app.get(`${P}/systeminfo`, async (req, reply) => {
    if (!authorized(req, reply)) return;
    return {
      queue_size: 0,
      overdue_watches: [],
      watch_count: watches.length,
      tag_count: Object.keys(TAGS).length,
      all_paused: false,
      all_muted: false,
      uptime: '12 days',
      version: '0.50.10',
    };
  });
  app.get(`${P}/tags`, async (req, reply) => {
    if (!authorized(req, reply)) return;
    return Object.fromEntries(Object.entries(TAGS).map(([uuid, title]) => [uuid, { uuid, title, notification_urls: [], notification_muted: false }]));
  });
  app.get(`${P}/watch`, async (req, reply) => {
    if (!authorized(req, reply)) return;
    const q = req.query as { tag?: string; with_errors?: string };
    const list = watches.filter((w) => !q.tag || w.tags.some((t) => t.toLowerCase() === q.tag!.toLowerCase())).filter((w) => q.with_errors !== '1' || w.error);
    return Object.fromEntries(list.map((w) => [w.uuid, summary(w)]));
  });
  app.get(`${P}/watch/:uuid`, async (req, reply) => {
    if (!authorized(req, reply)) return;
    const w = find(req);
    if (!w) return reply.code(404).send({ message: `No watch exists with the UUID of ${(req.params as { uuid: string }).uuid}` });
    // the full watch carries its settings – a notification URL with a token and request headers (Steward strips them)
    return {
      ...summary(w),
      uuid: w.uuid,
      history_n: w.snapshotsHoursAgo.length,
      check_count: 240,
      fetch_backend: 'html_requests',
      method: 'GET',
      headers: { Authorization: 'Bearer demo-watched-site-token' },
      body: null,
      notification_urls: ['posts://steward.example.com/api/hooks/wht_demo?+X-Steward-Token=demo-not-a-real-secret'],
      time_between_check: { hours: 1 },
    };
  });
  app.get(`${P}/watch/:uuid/history`, async (req, reply) => {
    if (!authorized(req, reply)) return;
    const w = find(req);
    if (!w) return reply.code(404).send({ message: 'No watch exists with that UUID' });
    return Object.fromEntries(w.snapshotsHoursAgo.map((h) => [String(secondsAgo(h)), `/datastore/${w.uuid}/${secondsAgo(h)}.txt.br`]));
  });
  // the human page a diff link opens (changedetection.io's own UI; not part of the API)
  app.get('/changedetection/diff/:uuid', async (req, reply) => {
    const w = find(req);
    const title = (w?.title ?? 'Unknown watch').replace(/[<>&"]/g, '');
    return reply
      .type('text/html')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Diff – ${title}</title></head><body><h1>${title}</h1><p>The simulated changedetection.io shows no page contents.</p></body></html>`,
      );
  });
}
