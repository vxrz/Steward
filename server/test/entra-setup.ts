import type { TestServer } from './helpers.js';
import { setup, startTestServer } from './helpers.js';

/**
 * The shared start of the Entra ID tests (v0.5.0): a test server with the demo data and a Microsoft Graph platform on
 * the simulated tenant (mock/mockGraph.ts), signed in with the client secret.
 */

export interface EntraEnv {
  s: TestServer;
  mock: typeof import('../src/mock/mockGraph.js');
  platformId: string;
  preset: any;
  /** Another Graph platform on the simulated tenant (other credentials or variables) */
  createGraphPlatform: (name: string, secrets: Record<string, string>, variables?: Record<string, string>) => Promise<string>;
  /** Forget the platform's token (the next request signs in again) */
  invalidate: (id: string) => Promise<void>;
}

export async function startEntra(): Promise<EntraEnv> {
  process.env.SM_GATUS_AUTOSTART = '0';
  process.env.SM_MONITOR_AUTOSTART = '0';
  process.env.SM_MONITOR_DEMO_SIMULATOR = '0';
  const s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const mock = await import('../src/mock/mockGraph.js');
  const preset = (await s.api('GET', '/platform-presets')).find((p: any) => p.kind === 'microsoft-graph');
  const createGraphPlatform = async (name: string, secrets: Record<string, string>, variables: Record<string, string> = {}) =>
    (
      await s.api('POST', '/platforms', {
        name,
        kind: 'microsoft-graph',
        baseUrl: `${s.base}/mock/graph`,
        config: {
          ...preset.config,
          variables: { ...preset.config.variables, tenantId: mock.DEMO_GRAPH.tenantId, loginUrl: `${s.base}/mock/graph/login`, ...variables },
          http: { ...preset.config.http, proxy: 'none' },
        },
        secrets,
      })
    ).id as string;
  const platformId = await createGraphPlatform('Entra ID', { clientId: mock.DEMO_GRAPH.clientId, clientSecret: mock.DEMO_GRAPH.clientSecret });
  const invalidate = async (id: string) => (await import('../src/platforms/http.js')).invalidatePlatformCaches(id);
  return { s, mock, platformId, preset, createGraphPlatform, invalidate };
}
