import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';
import { config, env, loopbackUrl } from '../config.js';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { createPlatform } from '../platforms/service.js';
import { DEMO_ZABBIX } from '../mock/mockZabbix.js';
import { DEMO_IOT_ASSETS, demoPm17Pipeline } from '../mock/mockIot.js';
import { simulateReads } from '../mock/delaySimulation.js';
import { delayIdentity, encodeDelayState } from './delay.js';
import { parseDefinition } from './model.js';
import * as svc from './service.js';
import * as engine from './engine.js';
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

const examplesDir = () => path.join(config.examplesDir, 'monitors');

/** The examples describe a real plant; in the demo the PowerMeters and Steward are this server. */
function demoize(text: string): string {
  return text
    .replace(/host: 10\.20\.\d+\.\d+/g, 'host: 127.0.0.1')
    .replace(/fallbackPort: 502/g, `fallbackPort: ${config.port}`)
    .replace(/http:\/\/127\.0\.0\.1:4310/g, loopbackUrl());
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
      baseUrl: `${loopbackUrl()}/mock/zabbix`,
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
      allowedKeys: ['m17.*', 'm18.*', 'gw-hall2.*', 'l5.*', 'm6.*'],
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
  created += await setupStatesDemo();
  seedObservedDelay();
  startGatewaySimulator();
  // the stopped PowerMeter of machine 18 reported for the last time 25 minutes ago
  void simulateOnce(true);
  return created;
}

// ---------- states (0.13, ADR 0021): a machine that is off, and one whose checks contradict each other ----------

/**
 * Lathe 5 is switched off: its PowerMeter does not answer and none of its data arrives – every check agrees, so it is
 * grey and quiet (Off). Mill 6's PowerMeter does not answer either, but its data still arrives: a contradiction, red,
 * with the PowerMeter check as the root cause (the closest state is Running). Both require the gateway of hall 2.
 */
const statesDemo = (key: string, name: string, prefix: string, description: string): string =>
  [
    'kind: monitor',
    `key: ${key}`,
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    'tags: [hall-2, demo-states]',
    'intervalSeconds: 60',
    'failuresBeforeDown: 2',
    'checks:',
    '  - { id: pm-reachable, name: PowerMeter reachable, type: tcp, host: 127.0.0.1, port: 1, x: 0, y: 0 }',
    `  - { id: pm-data, name: PowerMeter data reported by the gateway, type: heartbeat, key: ${prefix}.powermeter, mode: cadence, expectedIntervalSeconds: 60, downAfterMissed: 4, x: -160, y: 160 }`,
    `  - { id: pm-energy, name: Energy data reported by the gateway, type: heartbeat, key: ${prefix}.energy, mode: cadence, expectedIntervalSeconds: 60, downAfterMissed: 6, x: 0, y: 160 }`,
    '  - { id: gateway, name: Gateway Hall 2 alive, type: monitor, monitor: gateway-hall-2, x: 160, y: 0 }',
    'links:',
    '  - { from: gateway, to: pm-data }',
    '  - { from: gateway, to: pm-energy }',
    'states:',
    '  cases:',
    '    - { id: running, name: Running, when: { pm-reachable: up }, expect: { gateway: up, pm-data: up, pm-energy: up } }',
    '    - { id: off, name: Off, status: off, when: { pm-reachable: down }, requires: [gateway], expect: { pm-data: down, pm-energy: down } }',
    '',
  ].join('\n');

export const STATES_DEMO = {
  off: { key: 'lathe-5-powermeter', prefix: 'l5' },
  contradiction: { key: 'mill-6-powermeter', prefix: 'm6' },
} as const;

async function setupStatesDemo(): Promise<number> {
  if (!db().get('SELECT 1 FROM monitors WHERE key = ?', 'gateway-hall-2')) return 0;
  let created = 0;
  const items = [
    { ...STATES_DEMO.off, name: 'Lathe 5 – PowerMeter', description: 'Switched off for the night: every check agrees, so it is Off – grey and quiet.' },
    {
      ...STATES_DEMO.contradiction,
      name: 'Mill 6 – PowerMeter',
      description: 'The PowerMeter does not answer, but its data still arrives: a contradiction – the PowerMeter check or its path is broken.',
    },
  ];
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString();
  for (const it of items) {
    if (db().get('SELECT 1 FROM monitors WHERE key = ?', it.key)) continue;
    try {
      const { monitor } = await svc.importMonitor(statesDemo(it.key, it.name, it.prefix, it.description));
      created++;
      // the night so far: the PowerMeter has not answered for two hours, the state has been Off since and is settled
      db().run(
        `UPDATE monitor_checks SET status = 'down', since = ?, consecutive_failures = 3, last_checked_at = ?, last_result = ? WHERE monitor_id = ? AND check_id = 'pm-reachable'`,
        iso(now - 2 * 3600000),
        iso(now),
        JSON.stringify({ ts: iso(now), status: 'down', message: 'connection refused', durationMs: 1 }),
        monitor.id,
      );
      // Mill 6: its data arrives (the gateway simulator keeps reporting it)
      if (it.prefix === 'm6') {
        for (const cid of ['pm-data', 'pm-energy'])
          db().run(
            `UPDATE monitor_checks SET status = 'up', since = ?, last_checked_at = ?, last_ok_at = ?, last_push_at = ?, last_push = ?, last_result = ? WHERE monitor_id = ? AND check_id = ?`,
            iso(now - 3 * 3600000),
            iso(now),
            iso(now),
            iso(now),
            JSON.stringify({ value: 12.4, ts: iso(now) }),
            JSON.stringify({ ts: iso(now), status: 'up', message: 'Newest report is 0 s old, expected every 60 s', durationMs: null }),
            monitor.id,
            cid,
          );
      }
      if (it.prefix === 'l5') {
        for (const cid of ['pm-data', 'pm-energy'])
          db().run(
            `UPDATE monitor_checks SET status = 'down', since = ?, consecutive_failures = 3, last_checked_at = ?, last_push_at = ?, last_push = ?, last_result = ? WHERE monitor_id = ? AND check_id = ?`,
            iso(now - 2 * 3600000 + 5 * 60000),
            iso(now),
            iso(now - 2 * 3600000),
            JSON.stringify({ value: 0, ts: iso(now - 2 * 3600000) }),
            JSON.stringify({ ts: iso(now), status: 'down', message: 'Newest report is 2.0 h old, expected every 60 s', durationMs: null }),
            monitor.id,
            cid,
          );
      }
      db().run(
        `INSERT INTO monitor_state (monitor_id, status, since, root_causes, last_evaluated_at, state_id, state_since, settle_until, state_detail)
         VALUES (?, 'off', ?, '[]', ?, 'off', ?, ?, ?) ON CONFLICT (monitor_id) DO UPDATE SET state_id = excluded.state_id, state_since = excluded.state_since,
           settle_until = excluded.settle_until, state_detail = excluded.state_detail`,
        monitor.id,
        iso(now - 2 * 3600000),
        iso(now),
        iso(now - 2 * 3600000),
        iso(now - 2 * 3600000 + 20 * 60000),
        JSON.stringify({ changes: [], offChecks: [], info: null }),
      );
      await engine.recompute(monitor.id);
    } catch (err) {
      logger.warn({ err: (err as Error).message, monitor: it.key }, 'demo states monitor not created');
    }
  }
  return created;
}

/**
 * The PowerMeter of machine 17 uploads every 5 minutes (mockIot.ts): its Insights Hub check shows the observed delay
 * of the last week right away – simulated reads of the same data path, every minute, ending now.
 */
function seedObservedDelay(): void {
  const row = db().get<{ id: string; definition: string }>('SELECT id, definition FROM monitors WHERE key = ?', 'machine-17-powermeter');
  const def = row ? parseDefinition(row.definition) : undefined;
  const c = def?.checks.find((x) => x.id === 'pm-ih');
  const identity = c ? delayIdentity(c) : null;
  if (!row || !c || c.type !== 'freshness' || !identity) return;
  const have = db().get<{ observed_delay: string | null }>('SELECT observed_delay FROM monitor_checks WHERE monitor_id = ? AND check_id = ?', row.id, c.id);
  if (!have || have.observed_delay) return;
  const now = Date.now();
  const state = simulateReads(demoPm17Pipeline(now), {
    identity,
    variables: c.variables ?? [],
    from: now - 7 * 86400000,
    to: now - 60000,
    intervalSeconds: c.intervalSeconds ?? def!.intervalSeconds,
  });
  db().run(
    'UPDATE monitor_checks SET observed_delay = ? WHERE monitor_id = ? AND check_id = ? AND observed_delay IS NULL',
    encodeDelayState(state!),
    row.id,
    c.id,
  );
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
    // the gateway's own heartbeat (states: Off is only trusted while the gateway is alive)
    { key: 'gw-hall2.alive', ts: new Date(now).toISOString(), value: 1 },
    // Mill 6: its PowerMeter does not answer, but its data still arrives (the states demo's contradiction)
    { key: 'm6.powermeter', ts: new Date(now).toISOString(), value: 12.4, data: { unit: 'kW' } },
    { key: 'm6.energy', ts: new Date(now).toISOString(), value: 8812.5, data: { unit: 'kWh' } },
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
    const res = await fetch(`${loopbackUrl()}/api/hooks/monitors`, {
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
  if (!config.demo || simTimer || !env.SM_MONITOR_DEMO_SIMULATOR) return;
  simTimer = setInterval(() => void simulateOnce(), SIM_INTERVAL_MS);
  simTimer.unref();
}

export function stopGatewaySimulator(): void {
  if (simTimer) clearInterval(simTimer);
  simTimer = undefined;
}
