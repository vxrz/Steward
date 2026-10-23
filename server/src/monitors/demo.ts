import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';
import { config } from '../config.js';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { createPlatform } from '../platforms/service.js';
import { DEMO_ZABBIX } from '../mock/mockZabbix.js';
import { DEMO_IOT_ASSETS } from '../mock/mockIot.js';
import * as svc from './service.js';
import { parseYaml } from '../yaml-safe.js';
import { createGateway, gatewayRow } from './gateways.js';
import type { GatewayRow } from './model.js';

/**
 * Demo mode: example monitors for machines with PowerMeters (from
 * examples/monitors, with hosts and ports pointing to this server), a Zabbix
 * platform (simulated API), and an "IoT gateway simulator" that reports
 * heartbeats through the real batch endpoint – except for the PowerMeter of
 * machine 18, which stopped reporting 25 minutes ago, so the UI shows a
 * realistic root cause.
 */
export const DEMO_GATEWAY_NAME = 'IoT gateway (demo simulator)';
const SIM_INTERVAL_MS = 30000;

const examplesDir = () => path.join(process.env.SM_EXAMPLES_DIR ?? path.join(config.templatesDir, '..'), 'monitors');

/** The examples describe a real plant; in the demo the PowerMeters and Steward are this server. */
function demoize(text: string): string {
  return text
    .replace(/host: 10\.20\.\d+\.\d+/g, 'host: 127.0.0.1')
    .replace(/fallbackPort: 502/g, `fallbackPort: ${config.port}`)
    .replace(/http:\/\/127\.0\.0\.1:4310/g, `http://127.0.0.1:${config.port}`);
}

export async function setupMonitorDemo(): Promise<number> {
  const names = new Set(
    db()
      .all<{ name: string }>('SELECT name FROM platforms')
      .map((r) => r.name),
  );
  if (!names.has('Zabbix (demo)')) {
    createPlatform({
      name: 'Zabbix (demo)',
      kind: 'zabbix',
      environment: 'demo',
      description: 'Simulated Zabbix 7 JSON-RPC API (history.push) served by the built-in mock. A real Zabbix also accepts the trapper protocol on port 10051.',
      baseUrl: `http://127.0.0.1:${config.port}/mock/zabbix`,
      config: {
        auth: { type: 'bearer' },
        variables: { host: DEMO_ZABBIX.host, apiPath: '/api_jsonrpc.php', trapperHost: '127.0.0.1', trapperPort: '10051' },
        http: { proxy: 'none' },
      },
      secrets: { token: DEMO_ZABBIX.token },
    });
  }
  if (!db().get('SELECT 1 FROM monitor_gateways WHERE name = ?', DEMO_GATEWAY_NAME)) {
    createGateway({
      name: DEMO_GATEWAY_NAME,
      description: 'Simulates the plant IoT gateway: reports PowerMeter and machine data every 30 s (machine 18 PowerMeter: stopped).',
      enabled: true,
      authMode: 'token',
      allowedCidrs: [],
      allowedKeys: ['m17.*', 'm18.*'],
      rateLimitPerMinute: 120,
    });
  }
  const have = new Set(
    db()
      .all<{ key: string }>('SELECT key FROM monitors')
      .map((r) => r.key),
  );
  let created = 0;
  const dir = examplesDir();
  for (const f of fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((x) => /\.ya?ml$/.test(x))
        .sort()
    : []) {
    const text = demoize(fs.readFileSync(path.join(dir, f), 'utf8'));
    const key = (parseYaml(text, { maxBytes: svc.MONITOR_YAML_BYTES }) as { key?: string }).key;
    if (key && have.has(key)) continue;
    try {
      await svc.importMonitor(text);
      created++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, file: f }, 'demo monitor not imported');
    }
  }
  // outputs to the simulated Zabbix (API) and Gatus (external endpoint) on the PowerMeter monitor
  const pm = db().get<{ id: string; definition: string; version: number }>(
    'SELECT id, definition, version FROM monitors WHERE key = ?',
    'machine-17-powermeter',
  );
  if (pm) {
    const def = JSON.parse(pm.definition) as { outputs: { id: string }[] };
    if (!def.outputs.some((o) => o.id === 'zabbix')) {
      def.outputs.push(
        { id: 'zabbix', type: 'zabbix', platform: 'Zabbix (demo)', via: 'api', on: 'every', minIntervalSeconds: 60 } as never,
        { id: 'gatus', type: 'gatus', platform: 'Gatus (demo)', endpointKey: 'steward_machine-monitors', include: 'monitor' } as never,
      );
      await svc.updateMonitor(pm.id, { definition: def }).catch((err) => logger.warn({ err: (err as Error).message }, 'demo outputs not added'));
    }
  }
  // machine 18 from the template
  if (!have.has('machine-18-powermeter')) {
    const t = db().get<{ id: string }>('SELECT id FROM monitors WHERE key = ? AND is_template = 1', 'powermeter-machine');
    if (t) {
      await svc
        .instantiateTemplate(t.id, [
          {
            key: 'machine-18-powermeter',
            params: {
              title: 'Machine 18 – PowerMeter',
              machine: 'm18',
              pmHost: '127.0.0.1',
              pmPort: config.port,
              pmAssetId: DEMO_IOT_ASSETS.pm18.assetId,
              machineAssetId: DEMO_IOT_ASSETS.machine18.assetId,
            },
          },
        ])
        .then(() => created++)
        .catch((err) => logger.warn({ err: (err as Error).message }, 'demo template instance not created'));
    }
  }
  startGatewaySimulator();
  // the stopped PowerMeter of machine 18 reported for the last time 25 minutes ago
  void simulateOnce(true);
  return created;
}

// ---------- IoT gateway simulator ----------

let simTimer: NodeJS.Timeout | undefined;
let tick = 0;

function demoGateway(): GatewayRow | undefined {
  const g = db().get<{ id: string }>('SELECT id FROM monitor_gateways WHERE name = ?', DEMO_GATEWAY_NAME);
  return g ? gatewayRow(g.id) : undefined;
}

async function simulateOnce(first = false): Promise<void> {
  if (!vault().unlocked) return;
  const g = demoGateway();
  if (!g || !g.enabled) return;
  const now = Date.now();
  tick++;
  const reports: Record<string, unknown>[] = [
    { key: 'm17.powermeter', ts: new Date(now).toISOString(), value: Math.round((44 + Math.random() * 10) * 10) / 10, data: { unit: 'kW', voltage: 400 } },
    { key: 'm18.machine', ts: new Date(now).toISOString(), value: 1380 + Math.round(Math.random() * 60), data: { unit: 'rpm' } },
  ];
  // machine 17 reports on change only: every few minutes
  if (first || tick % 6 === 0)
    reports.push({
      key: 'm17.machine',
      ts: new Date(now).toISOString(),
      value: 1450 + Math.round(Math.random() * 100),
      data: { unit: 'rpm', state: 'running' },
    });
  if (first) reports.push({ key: 'm18.powermeter', ts: new Date(now - 25 * 60000).toISOString(), value: 51.2, data: { unit: 'kW' } });
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/monitors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${vault().decrypt<string>(g.secret_enc)}` },
      body: JSON.stringify({ reports }),
      signal: AbortSignal.timeout(10000),
    });
    await res.text();
    if (res.status >= 400) logger.debug({ status: res.status }, 'demo gateway report rejected');
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'demo gateway report failed');
  }
}

/** Runs in demo mode only, once the demo gateway exists (also after a restart). */
export function startGatewaySimulator(): void {
  if (!config.demo || simTimer || process.env.SM_MONITOR_DEMO_SIMULATOR === '0') return;
  simTimer = setInterval(() => void simulateOnce(), SIM_INTERVAL_MS);
  simTimer.unref();
}

export function stopGatewaySimulator(): void {
  if (simTimer) clearInterval(simTimer);
  simTimer = undefined;
}
