import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

export interface TestServer {
  app: FastifyInstance;
  base: string;
  api: <T = any>(method: string, url: string, body?: unknown) => Promise<T>;
  waitRun: (id: string, statuses?: string[]) => Promise<any>;
  dataDir: string;
}

export async function startTestServer(): Promise<TestServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  process.env.SM_DATA_DIR = dataDir;
  process.env.SM_PORT = String(port);
  process.env.SM_DEMO = '1';
  await import('../src/bootstrap.js');
  const { ensureDataDirs } = await import('../src/config.js');
  ensureDataDirs();
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp();
  await app.listen({ host: '127.0.0.1', port });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + '/api' + url, {
      method,
      headers: { 'x-sm-client': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null;
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text}`);
    return data;
  };
  const waitRun = async (id: string, statuses = ['succeeded', 'failed', 'cancelled', 'waiting']) => {
    for (let i = 0; i < 300; i++) {
      const r = await api('GET', `/runs/${id}`);
      if (statuses.includes(r.status)) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`Run ${id} did not reach ${statuses}`);
  };
  return { app, base, api, waitRun, dataDir };
}
