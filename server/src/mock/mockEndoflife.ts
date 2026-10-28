import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { assetPath } from '../reports/pdf/assets.js';

/**
 * Simulated endoflife.date API v1 for demo mode and tests, mounted at /mock/endoflife. It answers for every product
 * of the bundled list (server/assets/endoflife/products.json) with its real release cycles and made-up dates relative
 * to today, so the demo always shows every state:
 *   - the newest cycle: supported (end of life in two years; long-term support for even cycle numbers),
 *   - the second newest: ending (end of life in 45 days),
 *   - older cycles: past their end of life (one more year back for each).
 * GET /api/v1/products/{product}  – the product with its releases (the shape of the real API, schema 1.2)
 * GET /api/v1/products            – the product names
 * Unknown products answer 404, like the real API.
 */

interface Product {
  id: string;
  label: string;
  category: string;
  aliases: string[];
  cycles: string[];
}

let products: Map<string, Product> | null = null;
function load(): Map<string, Product> {
  if (!products) {
    const data = JSON.parse(fs.readFileSync(assetPath('endoflife/products.json'), 'utf8')) as { products: Product[] };
    products = new Map(data.products.map((p) => [p.id, p]));
  }
  return products;
}

const DAY = 86_400_000;
const date = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

function releases(p: Product) {
  return p.cycles.map((cycle, i) => {
    const eolOffset = i === 0 ? 730 : i === 1 ? 45 : -365 * (i - 1);
    const eolFrom = date(eolOffset);
    const isLts = i === 0 && /^\d*[02468]$/.test(cycle.split('.')[0] ?? '');
    return {
      name: cycle,
      codename: null,
      label: isLts ? `${cycle} (LTS)` : cycle,
      releaseDate: date(eolOffset - 3 * 365),
      isLts,
      ltsFrom: isLts ? date(eolOffset - 3 * 365 + 180) : null,
      isEoas: eolOffset - 180 <= 0,
      eoasFrom: date(eolOffset - 180),
      isEol: eolOffset <= 0,
      eolFrom,
      isMaintained: eolOffset > 0,
      latest: { name: `${cycle}.4`, date: date(Math.min(eolOffset, 0) - 30), link: null },
    };
  });
}

export async function mockEndoflife(app: FastifyInstance): Promise<void> {
  const meta = () => ({ schema_version: '1.2.0', generated_at: new Date().toISOString(), last_modified: new Date().toISOString() });
  app.get('/endoflife/api/v1/products', async () => {
    const list = [...load().values()];
    return {
      ...meta(),
      total: list.length,
      result: list.map((p) => ({ name: p.id, label: p.label, aliases: p.aliases, category: p.category, tags: [], uri: `/api/v1/products/${p.id}` })),
    };
  });
  app.get('/endoflife/api/v1/products/:product', async (req, reply) => {
    const p = load().get((req.params as { product: string }).product);
    if (!p) return reply.code(404).send({ message: 'Product not found' });
    return {
      ...meta(),
      result: {
        name: p.id,
        label: p.label,
        aliases: p.aliases,
        category: p.category,
        tags: [],
        identifiers: [],
        labels: { eoas: 'Active Support', eol: 'Security Support', discontinued: null, eoes: null },
        links: { icon: null, html: `https://endoflife.date/${p.id}`, releasePolicy: null },
        releases: releases(p),
      },
    };
  });
}
