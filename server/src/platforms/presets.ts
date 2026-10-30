import type { PlatformPreset } from '@sm/shared';
import { gatusOpenApiSpec } from './gatusSpec.js';
import { forgejoSpec, githubSpec, gitlabSpec } from './gitSpecs.js';
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
    kind: 'checkmk',
    label: 'CheckMk (monitoring)',
    description:
      'CheckMk site (REST API 1.0, CheckMk 2.2+): monitors read the current state of hosts and services, processes read metric history for trend summaries. Base URL: https://<host>/<site>/check_mk/api/1.0. Create an automation user in CheckMk (Setup → Users, role "Guest user" or a read-only role is enough) and enter it with its secret, separated by a space, as the token: "automation MySecret" – it is sent as Authorization: Bearer <user> <secret>. Alerting on raw metrics stays in CheckMk. See docs/CHECKMK.md.',
    baseUrl: 'https://checkmk.example.com/mysite/check_mk/api/1.0',
    config: {
      auth: { type: 'bearer' },
      variables: { site: 'mysite' },
      http: {},
      testPath: '/version',
    },
    secretFields: [{ key: 'token', label: 'Automation user and secret', help: 'User name, a space, then the automation secret, e.g. "steward-reader 8f2…"' }],
    docs: [
      { title: 'CheckMk REST API', url: 'https://docs.checkmk.com/latest/en/rest_api.html' },
      { title: 'CheckMk automation users', url: 'https://docs.checkmk.com/latest/en/wato_user.html#automation' },
    ],
  },
  {
    kind: 'prometheus',
    label: 'Prometheus (PromQL)',
    description:
      'A Prometheus-compatible query API: Prometheus, Thanos, Mimir (base URL with its prefix, e.g. …/prometheus) or VictoriaMetrics. Monitors run PromQL queries against WARN and CRIT levels (the worst series counts), and availability objectives can take their figures from a query with [$window]. Only GET /api/v1/query is used. Authentication: none, basic, or a bearer token (e.g. a Grafana Cloud or Mimir token; set auth to bearer). See docs/MONITORS.md.',
    baseUrl: 'https://prometheus.example.com',
    config: { auth: { type: 'none' }, variables: {}, http: {}, testPath: '/api/v1/status/buildinfo' },
    secretFields: [
      { key: 'username', label: 'Username (basic auth)' },
      { key: 'password', label: 'Password (basic auth)' },
      { key: 'token', label: 'Bearer token' },
    ],
    docs: [
      { title: 'Prometheus HTTP API', url: 'https://prometheus.io/docs/prometheus/latest/querying/api/' },
      { title: 'PromQL basics', url: 'https://prometheus.io/docs/prometheus/latest/querying/basics/' },
    ],
  },
  {
    kind: 'kubernetes',
    label: 'Kubernetes cluster (read-only)',
    description:
      'A Kubernetes API server (also OpenShift, Rancher, AKS, EKS, GKE): application components of type "Kubernetes namespace" name it, and Steward reads their deployments and images (tech stack and end of life), pods that are not well and cert-manager certificates; monitors check deployments. Use a service account with the read-only role from docs/KUBERNETES.md and put its token into the credential token. For a private CA, add it under the platform\'s HTTP settings.',
    baseUrl: 'https://k8s-api.example.com:6443',
    config: { auth: { type: 'bearer' }, variables: {}, http: {}, testPath: '/version' },
    secretFields: [
      { key: 'token', label: 'Service account token', help: 'kubectl create token steward-reader -n steward --duration=8760h, or a long-lived token secret' },
    ],
    docs: [
      { title: 'Kubernetes API concepts', url: 'https://kubernetes.io/docs/reference/using-api/api-concepts/' },
      { title: 'Service account tokens', url: 'https://kubernetes.io/docs/concepts/security/service-accounts/' },
    ],
  },
  {
    kind: 'github',
    label: 'GitHub (repositories, read-only)',
    description:
      'GitHub or GitHub Enterprise Server (base URL https://HOST/api/v3): application components of type "Repository" name it and the repository (owner/repo), and Steward reads the default branch and its workflow runs, the latest release, open Dependabot alerts, container packages, deploy keys and the tech stack from the repository files; monitors check the pipeline; access reviews read organisation members and repository collaborators. Use a fine-grained token with read-only rights (docs/GIT-PLATFORMS.md).',
    baseUrl: 'https://api.github.com',
    config: { auth: { type: 'bearer' }, variables: {}, http: {}, testPath: '/rate_limit' },
    secretFields: [
      {
        key: 'token',
        label: 'Access token (read-only)',
        help: 'Fine-grained personal access token or GitHub App installation token; see docs/GIT-PLATFORMS.md for the rights',
      },
    ],
    docs: [
      { title: 'GitHub REST API', url: 'https://docs.github.com/en/rest' },
      {
        title: 'Fine-grained personal access tokens',
        url: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
      },
    ],
  },
  {
    kind: 'gitlab',
    label: 'GitLab (projects, read-only)',
    description:
      'GitLab.com or a self-managed GitLab (base URL https://HOST/api/v4): application components of type "Repository" name it and the project path (group/project), and Steward reads the default branch and its pipeline, the latest release, container repositories and packages, deploy keys, deploy and access tokens and the tech stack from the repository files; monitors check the pipeline; access reviews read project or group members. Use a token with read_api (docs/GIT-PLATFORMS.md).',
    baseUrl: 'https://gitlab.com/api/v4',
    config: { auth: { type: 'bearer' }, variables: {}, http: {}, testPath: '/version' },
    secretFields: [
      { key: 'token', label: 'Access token (read_api)', help: 'Group, project or personal access token with the scope read_api and the role Reporter or more' },
    ],
    docs: [
      { title: 'GitLab REST API', url: 'https://docs.gitlab.com/api/rest/' },
      { title: 'GitLab access tokens', url: 'https://docs.gitlab.com/security/tokens/' },
    ],
  },
  {
    kind: 'forgejo',
    label: 'Forgejo / Gitea (repositories, read-only)',
    description:
      'Forgejo, Codeberg or Gitea (base URL https://HOST/api/v1): application components of type "Repository" name it and the repository (owner/repo), and Steward reads the default branch and its commit status (Forgejo/Gitea Actions, Woodpecker), the latest release, packages, deploy keys and the tech stack from the repository files; monitors check the pipeline; access reviews read collaborators or organisation teams. Use a token with read rights (docs/GIT-PLATFORMS.md).',
    baseUrl: 'https://forgejo.example.com/api/v1',
    config: { auth: { type: 'bearer' }, variables: {}, http: {}, testPath: '/version' },
    secretFields: [
      {
        key: 'token',
        label: 'Access token (read)',
        help: 'Settings → Applications → Generate token, with read access to repository, organization, package and user',
      },
    ],
    docs: [
      { title: 'Forgejo API', url: 'https://forgejo.org/docs/latest/user/api-usage/' },
      { title: 'Gitea API', url: 'https://docs.gitea.com/development/api-usage' },
    ],
  },
  {
    kind: 'kafka',
    label: 'Kafka cluster (Confluent, read-only)',
    description:
      'A Kafka cluster (Confluent Cloud or Platform, Apache Kafka, Redpanda, MSK, Event Hubs): application components of type "Kafka topic" name it, and Steward reads topic settings, partitions, the newest message\'s time, consumer groups and their lag, and the schema version from the Schema Registry; monitors check new messages, lag and stuck consumer groups. Variable bootstrap: the bootstrap servers (host:port, comma-separated); sasl: plain (Confluent API key), scram-sha-256, scram-sha-512, oauthbearer or none; tls: true. Credential username/password: the service account\'s API key and secret. The base URL is the Schema Registry (optional; its own key in registryKey/registrySecret). peek = on lets platform managers read a few recent messages (sensitive fields hidden, audited). See docs/KAFKA.md.',
    baseUrl: 'https://psrc-xxxxx.europe-west3.gcp.confluent.cloud',
    config: {
      // basic: the Schema Registry's key (registryKey / registrySecret) – username/password are the SASL credentials
      auth: { type: 'basic' },
      variables: { bootstrap: 'pkc-xxxxx.europe-west3.gcp.confluent.cloud:9092', sasl: 'plain', tls: 'true', peek: 'off' },
      http: {},
      testPath: '/subjects',
    },
    secretFields: [
      { key: 'username', label: 'API key (SASL username)', help: 'The Kafka API key of a service account with read-only rights (docs/KAFKA.md)' },
      { key: 'password', label: 'API secret (SASL password)' },
      { key: 'registryKey', label: 'Schema Registry API key (optional)' },
      { key: 'registrySecret', label: 'Schema Registry API secret (optional)' },
      { key: 'clientId', label: 'OAuth client id (sasl = oauthbearer, optional)' },
      { key: 'clientSecret', label: 'OAuth client secret (sasl = oauthbearer, optional)' },
    ],
    docs: [
      {
        title: 'Confluent Cloud API keys',
        url: 'https://docs.confluent.io/cloud/current/security/authenticate/workload-identities/service-accounts/api-keys/overview.html',
      },
      { title: 'Confluent Schema Registry API', url: 'https://docs.confluent.io/platform/current/schema-registry/develop/api.html' },
      { title: 'Kafka ACLs', url: 'https://kafka.apache.org/documentation/#security_authz' },
    ],
  },
  {
    kind: 'mqtt',
    label: 'MQTT broker (monitor checks)',
    description:
      'An MQTT broker (Mosquitto, EMQX, HiveMQ, AWS IoT, Azure Event Grid …) for monitor checks of type "MQTT topics": messages on a topic within N minutes, devices that went silent, connected clients. Steward keeps one listening connection per broker a check uses and stores only when each topic last had a message and how many – never the content. Variable url: mqtt://, mqtts://, ws:// or wss://host:port. Credentials username/password, or certificate/privateKey (PEM) for a client certificate; a private CA under the HTTP settings. See docs/MQTT.md.',
    baseUrl: '',
    config: { auth: { type: 'none' }, variables: { url: 'mqtts://broker.example.com:8883' }, http: {} },
    secretFields: [
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password' },
      { key: 'certificate', label: 'Client certificate (PEM, optional)' },
      { key: 'privateKey', label: 'Client private key (PEM, optional)' },
    ],
    docs: [
      { title: 'MQTT 3.1.1 topics and wildcards', url: 'https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html#_Toc398718106' },
      { title: 'Mosquitto $SYS topics', url: 'https://mosquitto.org/man/mosquitto-8.html' },
    ],
  },
  {
    kind: 'teams',
    label: 'Microsoft Teams channel (Workflows)',
    description:
      'A Teams channel that monitor outputs post Adaptive Cards to (format "Teams card"). In Teams: … next to the channel → Workflows → "Post to a channel when a webhook request is received", then copy the URL into the credential webhookUrl – it is stored encrypted like every credential and never shown again. The base URL is only shown; the outbound policy must allow the URL\'s host. One platform per channel; its access list decides who may post there. See docs/MONITORS.md.',
    baseUrl: 'https://prod-00.westeurope.logic.azure.com',
    config: { auth: { type: 'none' }, variables: {}, http: {} },
    secretFields: [{ key: 'webhookUrl', label: 'Workflows URL', help: 'The URL of the Teams workflow "Post to a channel when a webhook request is received"' }],
    docs: [
      {
        title: 'Teams Workflows: post to a channel',
        url: 'https://support.microsoft.com/office/creating-a-workflow-from-a-channel-in-teams-242eb8f2-f328-45be-b81f-9817b51a5f0e',
      },
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
  // the read-only endpoints Steward uses (#107); the hosts' full specifications can be added to the platform
  github: () => [{ name: 'GitHub REST API (subset)', content: JSON.stringify(githubSpec(), null, 2) }],
  gitlab: () => [{ name: 'GitLab REST API (subset)', content: JSON.stringify(gitlabSpec(), null, 2) }],
  forgejo: () => [{ name: 'Forgejo / Gitea API (subset)', content: JSON.stringify(forgejoSpec(), null, 2) }],
};
