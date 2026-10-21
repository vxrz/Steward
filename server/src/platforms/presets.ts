import type { PlatformPreset } from '@sm/shared';

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
    docs: [
      { title: 'Industrial Edge documentation', url: 'https://docs.eu1.edge.siemens.cloud/' },
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
