import type { FastifyInstance } from 'fastify';

/**
 * Simulated Zabbix JSON-RPC API (/mock/zabbix/api_jsonrpc.php) for demo mode:
 * `apiinfo.version` (no auth) and `history.push` (Zabbix 7.0+, `Authorization: Bearer <API token>`).
 * Items exist for host "steward-demo" and every key starting with "steward.";
 * other host/key pairs get the per-record error Zabbix returns for unknown items.
 * GET /mock/zabbix/received lists what was pushed (newest last).
 */
export const DEMO_ZABBIX = { token: 'demo-zabbix-api-token', host: 'steward-demo' };

interface Pushed {
  host: string;
  key: string;
  value: string;
  clock: number;
  ns?: number;
}

export async function mockZabbix(app: FastifyInstance): Promise<void> {
  const received: Pushed[] = [];
  const itemIds = new Map<string, string>();
  const itemId = (key: string) => {
    let id = itemIds.get(key);
    if (!id) itemIds.set(key, (id = String(10600 + itemIds.size)));
    return id;
  };

  app.post('/zabbix/api_jsonrpc.php', async (req, reply) => {
    const b = req.body as { jsonrpc?: string; method?: string; params?: unknown; id?: number } | null;
    const id = b?.id ?? null;
    const err = (code: number, message: string, data: string) => reply.send({ jsonrpc: '2.0', error: { code, message, data }, id });
    if (b?.jsonrpc !== '2.0' || !b.method) return err(-32600, 'Invalid request.', 'Invalid JSON-RPC request.');
    if (b.method === 'apiinfo.version') return { jsonrpc: '2.0', result: '7.0.6', id };
    const auth = String(req.headers.authorization ?? '');
    if (auth !== `Bearer ${DEMO_ZABBIX.token}`) return err(-32602, 'Invalid params.', 'Not authorized.');
    if (b.method !== 'history.push') return err(-32601, 'Method not found.', 'Incorrect API "' + b.method + '".');
    const list = (Array.isArray(b.params) ? b.params : [b.params]) as Partial<Pushed & { itemid: string }>[];
    const data = list.map((p) => {
      if (p.host !== DEMO_ZABBIX.host || !String(p.key ?? '').startsWith('steward.')) return { error: 'No permissions to referred object or it does not exist.' };
      received.push({ host: p.host, key: String(p.key), value: String(p.value), clock: Number(p.clock), ns: p.ns });
      if (received.length > 1000) received.shift();
      return { itemid: itemId(String(p.key)) };
    });
    return { jsonrpc: '2.0', result: { response: 'success', data }, id };
  });
  app.get('/zabbix/received', async () => ({ received }));
}
