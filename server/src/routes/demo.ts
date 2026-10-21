import { config } from '../config.js';
import { db } from '../db.js';
import { createPlatform } from '../platforms/service.js';
import { createFromTemplate, listTemplates } from '../processes/service.js';
import { DEMO_CREDENTIALS } from '../mock/mockPlatform.js';
import { audit } from '../audit.js';

/** Creates demo platforms (pointing to the built-in mock) and imports all templates. */
export function setupDemo(): { platforms: number; processes: number } {
  const base = `http://127.0.0.1:${config.port}/mock`;
  const existing = new Set(db().all<{ name: string }>('SELECT name FROM platforms').map((r) => r.name));
  let platforms = 0;
  if (!existing.has('Insights Hub (demo)')) {
    createPlatform({
      name: 'Insights Hub (demo)',
      kind: 'insights-hub',
      environment: 'demo',
      description: 'Simulated Insights Hub tenant served by the built-in mock.',
      baseUrl: `${base}/ih`,
      config: {
        auth: { type: 'oauth2_client_credentials', tokenUrl: `${base}/ih/oauth/token`, clientAuth: 'basic' },
        variables: {
          tenant: 'demotenant',
          region: 'eu1',
          idmPath: '/api/identitymanagement/v3',
          assetPath: '/api/assetmanagement/v3',
          tsPath: '/api/iottimeseries/v3',
        },
        http: { proxy: 'none' },
        testPath: '/api/identitymanagement/v3/Users?count=1',
      },
      secrets: { clientId: DEMO_CREDENTIALS.client.id, clientSecret: DEMO_CREDENTIALS.client.secret },
    });
    platforms++;
  }
  if (!existing.has('Industrial Edge Management (demo)')) {
    createPlatform({
      name: 'Industrial Edge Management (demo)',
      kind: 'industrial-edge-management',
      environment: 'demo',
      description: 'Simulated IEM served by the built-in mock. Also hosts a small web portal for the browser demo.',
      baseUrl: `${base}/iem`,
      config: {
        auth: {
          type: 'token_request',
          request: {
            method: 'POST',
            url: '/portal/api/v1/login/direct',
            body: { username: '{{ secrets.username }}', password: '{{ secrets.password }}' },
            bodyType: 'json',
          },
          tokenPath: 'data.access_token',
          headerName: 'Authorization',
          headerValue: 'Bearer {{ token }}',
        },
        variables: {},
        http: { proxy: 'none' },
        testPath: '/portal/api/v1/devices',
        portalUrl: `${base}/portal`,
      },
      secrets: { username: DEMO_CREDENTIALS.iem.username, password: DEMO_CREDENTIALS.iem.password },
    });
    platforms++;
  }
  const have = new Set(db().all<{ id: string }>('SELECT id FROM processes WHERE archived = 0').map((r) => r.id));
  let processes = 0;
  for (const t of listTemplates()) {
    if (have.has(t.id.replace(/^\d+-/, ''))) continue;
    createFromTemplate(t.id);
    processes++;
  }
  audit({ action: 'demo.setup', entityType: 'settings', summary: `Demo data loaded (${platforms} platforms, ${processes} processes)` });
  return { platforms, processes };
}
