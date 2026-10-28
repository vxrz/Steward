import type { PlatformPreset } from '@sm/shared';
import { gatusOpenApiSpec } from './gatusSpec.js';
import { readAsset } from '../reports/pdf/assets.js';

/**
 * Starting points for new platforms. Everything is editable afterwards –
 * the tool itself is platform agnostic; presets just pre-fill auth and URLs.
 */
export const PRESETS: PlatformPreset[] = [
  {
    kind: 'insights-hub',
    label: 'Siemens Insights Hub (service credentials)',
    description:
      'Insights Hub (formerly MindSphere) REST APIs via the regional gateway, authenticated with service credentials (OAuth2 client credentials issued in Settings → Service Credentials / Developer Cockpit).',
    baseUrl: 'https://gateway.{{ vars.region }}.mindsphere.io',
    config: {
      auth: {
        type: 'oauth2_client_credentials',
        tokenUrl: 'https://{{ vars.tenant }}.piam.{{ vars.region }}.mindsphere.io/oauth/token',
        clientAuth: 'basic',
      },
      variables: { tenant: 'mytenant', region: 'eu1' },
      http: {},
      testPath: '/api/identitymanagement/v3/Users?count=1',
      portalUrl: 'https://{{ vars.tenant }}.{{ vars.region }}.mindsphere.io',
    },
    secretFields: [
      { key: 'clientId', label: 'Client ID', help: 'Service credential client id' },
      { key: 'clientSecret', label: 'Client secret' },
      { key: 'username', label: 'Portal user (optional, browser automation)' },
      { key: 'password', label: 'Portal password (optional, browser automation)' },
    ],
    docs: [
      { title: 'Insights Hub API reference', url: 'https://documentation.mindsphere.io/MindSphere/apis/index.html' },
      {
        title: 'Identity Management API',
        url: 'https://documentation.mindsphere.io/MindSphere/apis/core-identitymanagement/api-identitymanagement-overview.html',
      },
      {
        title: 'Asset Management API',
        url: 'https://documentation.mindsphere.io/MindSphere/apis/advanced-assetmanagement/api-assetmanagement-overview.html',
      },
    ],
  },
  {
    kind: 'insights-hub',
    label: 'Siemens Insights Hub (technical token manager / app credentials)',
    description:
      'Insights Hub using application credentials and the Technical Token Manager (X-SPACE-AUTH-KEY). Use when your automation is registered as an application.',
    baseUrl: 'https://gateway.{{ vars.region }}.mindsphere.io',
    config: {
      auth: {
        type: 'token_request',
        request: {
          method: 'POST',
          url: '/api/technicaltokenmanager/v3/oauth/token',
          headers: {
            'X-SPACE-AUTH-KEY': "{{ 'Basic ' & $base64encode(secrets.clientId & ':' & secrets.clientSecret) }}",
          },
          body: {
            appName: '{{ vars.appName }}',
            appVersion: '{{ vars.appVersion }}',
            hostTenant: '{{ vars.tenant }}',
            userTenant: '{{ vars.tenant }}',
          },
          bodyType: 'json',
        },
        tokenPath: 'access_token',
        expiresInPath: 'expires_in',
        headerName: 'Authorization',
        headerValue: 'Bearer {{ token }}',
      },
      variables: { tenant: 'mytenant', region: 'eu1', appName: 'myapp', appVersion: 'v1.0.0' },
      http: {},
      testPath: '/api/identitymanagement/v3/Users?count=1',
    },
    secretFields: [
      { key: 'clientId', label: 'App credential client id' },
      { key: 'clientSecret', label: 'App credential client secret' },
    ],
    docs: [
      {
        title: 'Technical Token Manager',
        url: 'https://documentation.mindsphere.io/MindSphere/apis/exchange-technicaltokenmanager/api-technicaltokenmanager-overview.html',
      },
    ],
  },
  {
    kind: 'industrial-edge-management',
    label: 'Siemens Industrial Edge Management (IEM)',
    description:
      'On-premise / cloud Industrial Edge Management portal API. Authenticates with a user login and uses the returned token. Self-signed certificates are common – enable "accept self-signed certificates" or add the CA.',
    baseUrl: 'https://iem.example.local',
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
      http: { insecureTls: false },
      testPath: '/portal/api/v1/devices?limit=1',
    },
    secretFields: [
      { key: 'username', label: 'IEM user (e-mail)' },
      { key: 'password', label: 'Password' },
    ],
    docs: [{ title: 'Industrial Edge documentation', url: 'https://docs.eu1.edge.siemens.cloud/' }],
  },
  {
    kind: 'gatus',
    label: 'Gatus (status monitoring)',
    description:
      'Gatus uptime monitor (github.com/TwiN/gatus): read endpoint statuses and uptime, push results to external endpoints. Gatus protects its status API only with HTTP Basic auth (security.basic) – pick "basic" and set username/password if configured; OIDC is browser-only. Use "bearer" only when a reverse proxy in front of Gatus expects a token. The token for pushing results is per external endpoint (credential externalToken). See docs/GATUS.md.',
    baseUrl: 'https://status.example.com',
    config: {
      auth: { type: 'none' },
      variables: {},
      http: {},
      testPath: '/api/v1/endpoints/statuses?pageSize=1',
    },
    secretFields: [
      { key: 'username', label: 'Username (security.basic)', help: 'Only when Gatus has security.basic configured' },
      { key: 'password', label: 'Password (security.basic)' },
      { key: 'token', label: 'Bearer token (reverse proxy)', help: 'Only for a proxy in front of Gatus that expects a bearer token' },
      { key: 'externalToken', label: 'External endpoint token', help: 'external-endpoints[].token, used by "Gatus – report Steward check to Gatus"' },
    ],
    docs: [
      { title: 'Gatus README', url: 'https://github.com/TwiN/gatus#readme' },
      { title: 'Gatus external endpoints', url: 'https://github.com/TwiN/gatus#external-endpoints' },
      { title: 'Gatus custom alerts (webhook to Steward)', url: 'https://github.com/TwiN/gatus#configuring-custom-alerts' },
    ],
  },
  {
    kind: 'endoflife-date',
    label: 'endoflife.date (end-of-life dates)',
    description:
      'The public endoflife.date API (no login): release cycles, end of support and end of life of operating systems, runtimes, databases and frameworks. Steward reads it once a day for the products in the tech stacks of application components (Applications → End of life). The outbound policy must allow endoflife.date. See docs/APPLICATIONS.md.',
    baseUrl: 'https://endoflife.date',
    config: {
      auth: { type: 'none' },
      variables: {},
      http: {},
      testPath: '/api/v1/products/nodejs',
    },
    secretFields: [],
    docs: [
      { title: 'endoflife.date API v1', url: 'https://endoflife.date/docs/api/v1/' },
      { title: 'endoflife.date products', url: 'https://endoflife.date/' },
    ],
  },
  {
    kind: 'zabbix',
    label: 'Zabbix (monitor outputs)',
    description:
      'Zabbix server or proxy as a target of monitor outputs. "sender" pushes values to trapper items over TCP (port 10051, variables trapperHost/trapperPort); "api" uses the JSON-RPC method history.push (Zabbix 7.0+) with an API token (credential token, sent as Authorization: Bearer). The variable "host" is the Zabbix host name the items belong to. See docs/MONITORS.md.',
    baseUrl: 'https://zabbix.example.com',
    config: {
      auth: { type: 'bearer' },
      variables: { host: 'steward', trapperHost: 'zabbix.example.com', trapperPort: '10051', apiPath: '/api_jsonrpc.php' },
      http: {},
    },
    secretFields: [{ key: 'token', label: 'API token (history.push)', help: 'Only needed for the "api" mode: Users → API tokens in Zabbix' }],
    docs: [
      { title: 'Zabbix sender protocol', url: 'https://www.zabbix.com/documentation/current/en/manual/appendix/protocols/zabbix_sender' },
      { title: 'Zabbix API history.push', url: 'https://www.zabbix.com/documentation/current/en/manual/api/reference/history/push' },
      { title: 'Zabbix trapper items', url: 'https://www.zabbix.com/documentation/current/en/manual/config/items/itemtypes/trapper' },
    ],
  },
  {
    kind: 'generic',
    label: 'Generic REST API',
    description: 'Any HTTP API. Pick the auth type and add an OpenAPI specification for operation lookup.',
    baseUrl: 'https://api.example.com',
    config: { auth: { type: 'none' }, variables: {}, http: {} },
    secretFields: [
      { key: 'token', label: 'Bearer token' },
      { key: 'apiKey', label: 'API key' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password' },
      { key: 'clientId', label: 'OAuth client id' },
      { key: 'clientSecret', label: 'OAuth client secret' },
    ],
    docs: [],
  },
];

/** API specifications attached to platforms created from a built-in preset of this kind. */
export const PRESET_SPECS: Record<string, () => { name: string; content: string }[]> = {
  gatus: () => [{ name: 'Gatus API', content: JSON.stringify(gatusOpenApiSpec(), null, 2) }],
  // the official description from github.com/endoflife-date/endoflife.date (MIT), bundled in server/assets
  'endoflife-date': () => [{ name: 'endoflife.date API', content: readAsset('endoflife/openapi.yml').toString('utf8') }],
};
