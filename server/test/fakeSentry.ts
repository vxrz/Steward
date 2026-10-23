import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';

/** A minimal Sentry-compatible ingestion endpoint that records envelopes (for tests). */
export interface FakeSentry {
  dsn: string;
  origin: string;
  /** Raw envelope bodies. */
  raw: string[];
  /** Parsed items of all envelopes: { header, payload }. */
  items: { type: string; payload: any }[];
  events: () => any[];
  waitForEvents: (n?: number, timeoutMs?: number) => Promise<any[]>;
  close: () => Promise<void>;
}

export async function startFakeSentry(): Promise<FakeSentry> {
  const raw: string[] = [];
  const items: { type: string; payload: any }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      const text = body.toString('utf8');
      raw.push(text);
      // envelope: header line, then (item header line, payload line)*
      const lines = text.split('\n').filter((l) => l.trim());
      for (let i = 1; i + 1 < lines.length; i += 2) {
        try {
          const h = JSON.parse(lines[i]!);
          items.push({ type: h.type, payload: JSON.parse(lines[i + 1]!) });
        } catch {
          /* attachments etc. */
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const events = () => items.filter((i) => i.type === 'event').map((i) => i.payload);
  return {
    dsn: `http://public0key@127.0.0.1:${port}/1`,
    origin: `http://127.0.0.1:${port}`,
    raw,
    items,
    events,
    waitForEvents: async (n = 1, timeoutMs = 10000) => {
      const end = Date.now() + timeoutMs;
      while (events().length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      return events();
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
