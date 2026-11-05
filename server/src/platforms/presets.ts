import type { PlatformPreset } from '@sm/shared';
import { gatusOpenApiSpec } from './gatusSpec.js';
import { forgejoSpec, githubSpec, gitlabSpec } from './gitSpecs.js';
import { prometheusSpec } from './prometheusSpec.js';
import { graphSpec } from './graphSpec.js';
import { pvaultSpec } from './pvaultSpec.js';
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
      { key: 'username', label: 'Username (security.basic)', help: 'Only when Gatus has security.basic configured', auth: 'basic' },
      { key: 'password', label: 'Password (security.basic)', auth: 'basic' },
      { key: 'token', label: 'Bearer token (reverse proxy)', help: 'Only for a proxy in front of Gatus that expects a bearer token', auth: 'bearer' },
      { key: 'externalToken', label: 'External endpoint token', help: 'external-endpoints[].token, used by "Gatus – Report a Steward check to Gatus"' },
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
      'A Prometheus-compatible query API: Prometheus, Thanos, Mimir (base URL with its prefix, e.g. …/prometheus) or VictoriaMetrics. Monitors run PromQL queries against WARN and CRIT levels (the worst series counts), and availability objectives can take their figures from a query with [$window]. Queries are sent as POST /api/v1/query. Authentication: none, basic (username/password) or bearer (a token, e.g. Grafana Cloud or Mimir) – filling in the fields below picks it; a multi-tenant Mimir/Cortex needs the default header X-Scope-OrgID. See docs/PROMETHEUS.md.',
    baseUrl: 'https://prometheus.example.com',
    config: { auth: { type: 'none' }, variables: {}, http: {}, testPath: '/api/v1/status/buildinfo' },
    secretFields: [
      { key: 'username', label: 'Username (basic auth)', auth: 'basic' },
      { key: 'password', label: 'Password (basic auth)', auth: 'basic' },
      { key: 'token', label: 'Bearer token', auth: 'bearer' },
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
    kind: 'aws',
    label: 'Amazon Web Services (AWS account, read-only)',
    description:
      'One AWS account: application components of type "Cloud account" name it, with the value of the application tag as their name (variable tagKey, default application: application=shop). Steward reads the resources with that tag in the regions of the variable regions (Resource Groups Tagging API), the costs per month (Cost Explorer, once a day) and the IAM users with the tag and the age and last use of their access keys (for the credentials register). Sign-in: AWS request signing with an access key or – recommended – a role to assume (role ARN, external ID); the base URL stays the STS endpoint of the region. The read-only policy is in docs/AWS.md.',
    baseUrl: 'https://sts.eu-central-1.amazonaws.com',
    config: {
      auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 'sts' } },
      variables: { regions: 'eu-central-1', tagKey: 'application' },
      http: {},
    },
    secretFields: [
      { key: 'accessKeyId', label: 'Access key ID', help: 'Of an IAM user (or the user that assumes the role) with the read-only policy of docs/AWS.md' },
      { key: 'secretAccessKey', label: 'Secret access key' },
      { key: 'sessionToken', label: 'Session token (temporary keys only, optional)' },
    ],
    docs: [
      { title: 'Resource Groups Tagging API', url: 'https://docs.aws.amazon.com/resourcegroupstagging/latest/APIReference/API_GetResources.html' },
      { title: 'Cost Explorer GetCostAndUsage', url: 'https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html' },
      { title: 'IAM ListAccessKeys', url: 'https://docs.aws.amazon.com/IAM/latest/APIReference/API_ListAccessKeys.html' },
    ],
  },
  {
    kind: 'snowflake',
    label: 'Snowflake (SQL API, read-only)',
    description:
      'A Snowflake account through the SQL API with key-pair authentication: application components of type "Snowflake database" name it and the database, and Steward reads its tables (size, last change), failing tasks and the credits of the warehouses used, from SNOWFLAKE.ACCOUNT_USAGE (up to two hours behind). Access reviews read the roles of users or who reaches a database, schema or table; monitors check the freshness of a table, failing tasks and warehouse credits. Variables: account – the account identifier as in the JWT (ORGNAME-ACCOUNTNAME or the account locator), user, role (with IMPORTED PRIVILEGES on the SNOWFLAKE database) and warehouse. Base URL https://<account identifier>.snowflakecomputing.com. See docs/SNOWFLAKE.md.',
    baseUrl: 'https://myorg-myaccount.snowflakecomputing.com',
    config: {
      auth: {
        type: 'jwt',
        jwt: {
          alg: 'RS256',
          lifetimeSeconds: 3600,
          claims: {
            iss: "{{ $uppercase(vars.account) & '.' & $uppercase(vars.user) & '.' & publicKeyFingerprint }}",
            sub: "{{ $uppercase(vars.account) & '.' & $uppercase(vars.user) }}",
          },
        },
      },
      variables: { account: 'MYORG-MYACCOUNT', user: 'STEWARD_READER', role: 'STEWARD_READ', warehouse: 'STEWARD_WH' },
      http: { defaultHeaders: { 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT' } },
    },
    secretFields: [
      {
        key: 'privateKey',
        label: 'Private key (PEM, PKCS#8)',
        help: 'openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt; give the user the public key with ALTER USER … SET RSA_PUBLIC_KEY',
      },
      { key: 'privateKeyPassphrase', label: 'Passphrase of the private key (optional)' },
    ],
    docs: [
      { title: 'Snowflake SQL API', url: 'https://docs.snowflake.com/en/developer-guide/sql-api/index' },
      { title: 'Key-pair authentication', url: 'https://docs.snowflake.com/en/user-guide/key-pair-auth' },
      { title: 'ACCOUNT_USAGE views', url: 'https://docs.snowflake.com/en/sql-reference/account-usage' },
    ],
  },
  {
    kind: 'dependency-track',
    label: 'Dependency-Track (vulnerabilities, read-only)',
    description:
      'OWASP Dependency-Track: application components name their project there (name@version, name@latest or the UUID), and Steward reads the open findings by severity – not those analysed as not affected or false positive, nor suppressed ones –, the policy violations and the most severe findings with their fixed version and EPSS. The scorecard shows them as the part Vulnerabilities, monitors check them. Base URL: the API server; variable frontendUrl: the UI, for links. API key of a team with VIEW_PORTFOLIO, VIEW_VULNERABILITY and VIEW_POLICY_VIOLATION (docs/DEPENDENCY-TRACK.md).',
    baseUrl: 'https://dtrack-api.example.com',
    config: {
      auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'X-Api-Key' },
      variables: { frontendUrl: 'https://dtrack.example.com' },
      http: {},
      testPath: '/api/v1/project?pageNumber=1&pageSize=1',
    },
    secretFields: [
      {
        key: 'apiKey',
        label: 'API key',
        help: 'Administration → Access Management → Teams: a team with VIEW_PORTFOLIO, VIEW_VULNERABILITY, VIEW_POLICY_VIOLATION',
      },
    ],
    docs: [{ title: 'Dependency-Track REST API', url: 'https://docs.dependencytrack.org/integrations/rest-api/' }],
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
    kind: 'confluent-cloud',
    label: 'Confluent Cloud API (access reviews)',
    description:
      'The Confluent Cloud API (https://api.confluent.cloud) for access reviews: an access check of source "Confluent" snapshots the role bindings of an organisation, environment or cluster (IAM v2, by CRN) and – with the variables kafkaRestUrl (the cluster\'s REST endpoint, https://pkc-….confluent.cloud:443) and clusterId (lkc-…) and the cluster\'s own API key – its Kafka ACLs; users are named by their e-mail address, so person reviews include Confluent. Credentials: a Cloud API key and secret (not a cluster key) of a service account with a role that may list role bindings, users and service accounts. Read-only. For topics, consumer lag and schemas use a "Kafka cluster" platform. See docs/CONFLUENT.md.',
    baseUrl: 'https://api.confluent.cloud',
    config: {
      auth: { type: 'basic' },
      variables: { kafkaRestUrl: '', clusterId: '' },
      http: {},
      testPath: '/iam/v2/users?page_size=1',
    },
    secretFields: [
      { key: 'username', label: 'Cloud API key', help: 'A Cloud API key (resource "Cloud resource management"), not a Kafka cluster key' },
      { key: 'password', label: 'Cloud API secret' },
      { key: 'clusterApiKey', label: 'Kafka cluster API key (optional, for ACLs)' },
      { key: 'clusterApiSecret', label: 'Kafka cluster API secret (optional, for ACLs)' },
    ],
    docs: [
      { title: 'Confluent Cloud IAM role bindings API', url: 'https://docs.confluent.io/cloud/current/api.html#tag/Role-Bindings-(iamv2)' },
      { title: 'Confluent Cloud users and service accounts API', url: 'https://docs.confluent.io/cloud/current/api.html#tag/Users-(iamv2)' },
      { title: 'Kafka REST API v3: ACLs', url: 'https://docs.confluent.io/cloud/current/api.html#tag/ACL-(v3)' },
    ],
  },
  {
    kind: 'microsoft-graph',
    label: 'Microsoft Graph (Entra ID, read-only)',
    description:
      'One Entra ID tenant through Microsoft Graph, read-only: an access check of source "Entra ID" snapshots users (by user principal name, e-mail addresses as other names, so person reviews include Entra ID), guests, disabled accounts, group memberships (also nested) and owners, directory roles (active and, with Entra ID P2, eligible through PIM) and app role assignments; templates review guests, privileged roles, stale accounts and groups and list app secrets and certificates that expire; monitors check expiring app credentials and Microsoft 365 service health. Register an app in Entra ID with the application permissions User.Read.All, Group.Read.All, Directory.Read.All, AuditLog.Read.All, RoleManagement.Read.Directory and Application.Read.All (optionally ServiceHealth.Read.All) and grant admin consent. Variable tenantId: the directory (tenant) id; credential clientId and either clientSecret or – recommended – certificate and privateKey (sign-in with a client assertion). National clouds: change the base URL (e.g. https://graph.microsoft.us) and the variable loginUrl (https://login.microsoftonline.us). See docs/ENTRA.md.',
    baseUrl: 'https://graph.microsoft.com',
    config: {
      auth: {
        type: 'oauth2_client_credentials',
        tokenUrl: '{{ vars.loginUrl }}/{{ vars.tenantId }}/oauth2/v2.0/token',
        scope: '{{ baseUrl }}/.default',
        clientAuth: 'body',
      },
      variables: { tenantId: '00000000-0000-0000-0000-000000000000', loginUrl: 'https://login.microsoftonline.com' },
      // Graph throttles with 429 and Retry-After: a few more retries, waiting as long as it asks (up to a minute)
      http: { retry: { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 60000 } },
      testPath: '/v1.0/organization?$select=id,displayName',
    },
    secretFields: [
      { key: 'clientId', label: 'Application (client) ID', help: 'Entra admin center → App registrations → the app → Overview' },
      {
        key: 'clientSecret',
        label: 'Client secret (or use a certificate)',
        help: 'The secret’s value (not its secret id); leave empty when signing in with a certificate',
      },
      {
        key: 'certificate',
        label: 'Certificate (PEM, public part)',
        help: 'The certificate uploaded to the app registration (Certificates & secrets) – Steward sends its thumbprint',
      },
      { key: 'privateKey', label: 'Private key of the certificate (PEM, PKCS#8)', help: 'Signs the client assertion; it never leaves Steward' },
      { key: 'privateKeyPassphrase', label: 'Passphrase of the private key (optional)' },
    ],
    docs: [
      {
        title: 'Register an application',
        url: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app',
      },
      {
        title: 'Client credentials flow',
        url: 'https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow',
      },
      {
        title: 'Certificate credentials (client assertion)',
        url: 'https://learn.microsoft.com/entra/identity-platform/certificate-credentials',
      },
      { title: 'Microsoft Graph permissions reference', url: 'https://learn.microsoft.com/graph/permissions-reference' },
      { title: 'Graph throttling', url: 'https://learn.microsoft.com/graph/throttling' },
      { title: 'National cloud deployments', url: 'https://learn.microsoft.com/graph/deployments' },
    ],
  },
  {
    kind: 'mqtt',
    label: 'MQTT broker (monitor checks)',
    description:
      'An MQTT broker (Mosquitto, EMQX, HiveMQ, AWS IoT, Azure Event Grid …) for monitor checks of type "MQTT topics": messages on a topic within N minutes, devices that went silent, connected clients. Steward keeps one listening connection per broker a check uses and stores only when each topic last had a message and how many – never the content. Variable url: the broker with the scheme mqtts or wss (TLS; mqtt and ws without), host and port. Credentials username/password, or certificate/privateKey (PEM) for a client certificate; a private CA under the HTTP settings. See docs/MQTT.md.',
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
    kind: 'privilege-vault',
    label: 'IBM Verify Privilege Vault (privileged access, read-only)',
    description:
      'IBM Security Verify Privilege Vault 12 (Delinea Secret Server under the IBM name), on premises or in the cloud, as a source of evidence: access reviews read who may use which secret and folder – directly, through a group or a role, with the permission (List, View, Edit, Owner); the hygiene template, dashboard and monitor check find failed heartbeats, passwords not rotated within N days or expired, automatic changing turned off, secrets without an owner and privileged secrets without checkout or approval; credentials register entries can link their vault secret; the privileged-use template reads views, checkouts and access requests for evidence packs. Steward never reads a secret value: the value endpoints are refused for this kind. Base URL: the application root – https://HOST/SecretServer on premises, https://TENANT.secretservercloud.com in the cloud. Sign-in: a service account (an application account is best) with user name and password; variable domain for a directory account; variables privilegedFolders and privilegedTemplates (comma-separated) name what evidence packs read the privileged use of. For a private CA, add it under the HTTP settings. Minimum permissions and how to check that the account cannot view values: docs/IBM-PAM.md.',
    baseUrl: 'https://pam.example.local/SecretServer',
    config: {
      auth: {
        type: 'token_request',
        request: {
          method: 'POST',
          url: '/oauth2/token',
          body: {
            grant_type: 'password',
            username: '{{ secrets.username }}',
            password: '{{ secrets.password }}',
            // only sent when the variable is set (a directory account)
            domain: "{{ vars.domain != '' ? vars.domain }}",
          },
          bodyType: 'form',
        },
        tokenPath: 'access_token',
        expiresInPath: 'expires_in',
        headerName: 'Authorization',
        headerValue: 'Bearer {{ token }}',
        refresh: {
          tokenPath: 'refresh_token',
          request: { method: 'POST', url: '/oauth2/token', body: { grant_type: 'refresh_token', refresh_token: '{{ refreshToken }}' }, bodyType: 'form' },
        },
      },
      // privilegedFolders / privilegedTemplates (comma-separated): what evidence packs read the privileged use of
      variables: { domain: '', privilegedFolders: '', privilegedTemplates: '' },
      http: {},
      testPath: '/api/v1/users/current',
    },
    secretFields: [
      { key: 'username', label: 'Service account (user name)', help: 'An application account or a local user with the read-only role of docs/IBM-PAM.md' },
      { key: 'password', label: 'Password' },
    ],
    docs: [
      { title: 'Verify Privilege Vault: APIs and scripting', url: 'https://ibm.docs.delinea.com/online-help/isvp-vault/api-scripting/index.htm' },
      {
        title: 'Script authentication using tokens',
        url: 'https://ibm.docs.delinea.com/online-help/isvp-vault/api-scripting/authentication/script-token-auth/index.htm',
      },
      { title: 'Developer resources (11.6)', url: 'https://ibm.docs.delinea.com/online-help/isvp-vault-11-6-x/developer-resources/index.htm' },
    ],
  },
  {
    kind: 'llm-gateway',
    label: 'LLM gateway (AI models)',
    description:
      'An LLM gateway – or any OpenAI-compatible API – for the process step "Ask an AI model": a predefined question with the context the step chooses, answered as text or as JSON checked against a schema. One base URL can serve several request formats; the format belongs to each model: OpenAI Chat Completions (POST /v1/chat/completions, also OpenAI-compatible APIs and other providers behind the gateway), OpenAI Responses (/v1/responses), Anthropic Messages (/v1/messages, with anthropic-version) and Bedrock Converse (/v1/bedrock/model/{modelId}/invoke). Sign-in: an API key in a header – x-api-key by default; change the header name (api-key, Authorization) under the sign-in settings, or use a bearer token. A second region is another platform with its own base URL. After the connection test, add the models under AI models (read from GET /v1/models or by hand), with their context size, maximum output and optional prices, and say which data the gateway may be sent. Budgets per day and month, the usage and the limits: docs/AI.md.',
    baseUrl: 'https://llm-gateway.example.com',
    config: {
      auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' },
      variables: {},
      // a model can take minutes for a long answer (Steward never streams)
      http: { timeoutMs: 300_000 },
      testPath: '/v1/models',
    },
    secretFields: [
      { key: 'apiKey', label: 'API key', help: 'Sent in the header named under the sign-in settings (x-api-key by default)', auth: 'apiKey' },
      { key: 'token', label: 'Bearer token (instead of an API key)', help: 'Sent as Authorization: Bearer <token>', auth: 'bearer' },
    ],
    docs: [
      { title: 'OpenAI Chat Completions API', url: 'https://platform.openai.com/docs/api-reference/chat/create' },
      { title: 'OpenAI Responses API', url: 'https://platform.openai.com/docs/api-reference/responses/create' },
      { title: 'Anthropic Messages API', url: 'https://docs.anthropic.com/en/api/messages' },
      { title: 'Amazon Bedrock Converse API', url: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html' },
    ],
  },
  // Database platforms (0.7.0, #203, docs/DATABASES.md): direct SQL, read-only
  {
    kind: 'database',
    label: 'PostgreSQL (read-only)',
    description:
      'A PostgreSQL database (also Amazon RDS / Aurora PostgreSQL, Azure Database for PostgreSQL, Cloud SQL), read directly with SQL: access reviews of roles and grants, account hygiene, monitor checks (connection, replication lag, a query whose value is judged) and datasets. Every statement runs in a read-only transaction that is rolled back, with time, row and size limits; only one SELECT at a time is accepted. Set host, port, database and TLS under Platform → Database after creating it; credentials username and password of a read-only role (the GRANT statements are in docs/DATABASES.md). The outbound policy must allow host:port unless it is "platforms".',
    baseUrl: '',
    config: {
      auth: { type: 'none' },
      variables: {},
      http: {},
      database: { dialect: 'postgresql', host: 'db.example.internal', port: 5432, database: 'postgres', tls: { mode: 'verify' }, limits: {}, auth: 'password' },
    },
    secretFields: [
      { key: 'username', label: 'User name', help: 'A read-only role (docs/DATABASES.md): pg_read_all_stats, SELECT on what processes read' },
      { key: 'password', label: 'Password' },
    ],
    docs: [
      { title: 'PostgreSQL: GRANT', url: 'https://www.postgresql.org/docs/current/sql-grant.html' },
      { title: 'PostgreSQL: predefined roles', url: 'https://www.postgresql.org/docs/current/predefined-roles.html' },
      { title: 'PostgreSQL: pg_stat_replication', url: 'https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW' },
    ],
  },
  {
    kind: 'database',
    label: 'MariaDB / MySQL (read-only)',
    description:
      'A MariaDB or MySQL database (also Amazon RDS / Aurora MySQL, Azure Database for MySQL), read directly with SQL: access reviews of users, roles and grants, account hygiene (locked and expired accounts, password age, default accounts), monitor checks (connection, replica lag, a query whose value is judged) and datasets. Every statement runs in START TRANSACTION READ ONLY and is rolled back, with time, row and size limits; only one SELECT at a time is accepted. Set host, port, database and TLS under Platform → Database after creating it; credentials username and password of a read-only account (docs/DATABASES.md).',
    baseUrl: '',
    config: {
      auth: { type: 'none' },
      variables: {},
      http: {},
      database: { dialect: 'mysql', host: 'db.example.internal', port: 3306, database: 'mysql', tls: { mode: 'verify' }, limits: {}, auth: 'password' },
    },
    secretFields: [
      { key: 'username', label: 'User name', help: 'A read-only account (docs/DATABASES.md): SELECT on the mysql tables Steward reads, REPLICATION CLIENT' },
      { key: 'password', label: 'Password' },
    ],
    docs: [
      { title: 'MariaDB: GRANT', url: 'https://mariadb.com/kb/en/grant/' },
      { title: 'MySQL: privileges provided', url: 'https://dev.mysql.com/doc/refman/8.4/en/privileges-provided.html' },
      { title: 'MySQL: SHOW REPLICA STATUS', url: 'https://dev.mysql.com/doc/refman/8.4/en/show-replica-status.html' },
    ],
  },
  {
    kind: 'database',
    label: 'Microsoft SQL Server (read-only)',
    description:
      'A Microsoft SQL Server database (2016 or later, also Azure SQL Managed Instance and Amazon RDS for SQL Server), read directly with SQL: access reviews of logins, users, roles and permissions, account hygiene (sysadmins, disabled, locked and expired logins, password age, sa), monitor checks (connection, availability group lag, a query whose value is judged) and datasets. SQL Server has no read-only transaction: every statement runs in a transaction that is rolled back and the login must be read-only (db_datareader, VIEW SERVER STATE, VIEW ANY DEFINITION – docs/DATABASES.md). Only one SELECT at a time is accepted. Sign-in with a SQL login (user name and password); set host, port, database and TLS under Platform → Database.',
    baseUrl: '',
    config: {
      auth: { type: 'none' },
      variables: {},
      http: {},
      database: { dialect: 'sqlserver', host: 'db.example.internal', port: 1433, database: 'master', tls: { mode: 'verify' }, limits: {}, auth: 'password' },
    },
    secretFields: [
      {
        key: 'username',
        label: 'Login (SQL authentication)',
        help: 'A read-only login (docs/DATABASES.md): db_datareader, VIEW SERVER STATE, VIEW ANY DEFINITION',
      },
      { key: 'password', label: 'Password' },
    ],
    docs: [
      { title: 'SQL Server: permissions', url: 'https://learn.microsoft.com/sql/relational-databases/security/permissions-database-engine' },
      {
        title: 'SQL Server: sys.dm_hadr_database_replica_states',
        url: 'https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-hadr-database-replica-states-transact-sql',
      },
    ],
  },
  {
    kind: 'generic',
    label: 'Generic REST API',
    description: 'Any HTTP API. Pick the auth type and add an OpenAPI specification for operation lookup.',
    baseUrl: 'https://api.example.com',
    config: { auth: { type: 'none' }, variables: {}, http: {} },
    secretFields: [
      { key: 'token', label: 'Bearer token', auth: 'bearer' },
      { key: 'apiKey', label: 'API key', auth: 'apiKey' },
      { key: 'username', label: 'Username', auth: 'basic' },
      { key: 'password', label: 'Password', auth: 'basic' },
      { key: 'clientId', label: 'OAuth client id' },
      { key: 'clientSecret', label: 'OAuth client secret' },
      { key: 'privateKey', label: 'Private key (PEM, key-pair JWT)' },
      { key: 'privateKeyPassphrase', label: 'Private key passphrase (optional)' },
      { key: 'accessKeyId', label: 'AWS access key id' },
      { key: 'secretAccessKey', label: 'AWS secret access key' },
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
  // PromQL through the MCP gateway and in process steps (v0.3.1)
  prometheus: () => [{ name: 'Prometheus HTTP API (read endpoints)', content: JSON.stringify(prometheusSpec(), null, 2) }],
  // Entra ID read endpoints (v0.5.0)
  'microsoft-graph': () => [{ name: 'Microsoft Graph (Entra ID read endpoints)', content: JSON.stringify(graphSpec(), null, 2) }],
  // metadata only, no value endpoint (#205); the value endpoints are refused for the kind (deniedPaths.ts)
  'privilege-vault': () => [{ name: 'IBM Verify Privilege Vault REST API (metadata)', content: JSON.stringify(pvaultSpec(), null, 2) }],
};
