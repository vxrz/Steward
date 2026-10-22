<p align="center"><img src="docs/logo.svg" width="96" alt="Steward logo"></p>

<h1 align="center">Steward</h1>

<p align="center"><em>Repeatable, auditable service procedures for your platforms.</em><br>
Open source under the <a href="LICENSE">Apache License 2.0</a> · Made in Erlangen, Germany</p>

Steward is a local tool for running standard service and platform procedures against **Siemens Insights Hub**, **Industrial Edge Management** and any other REST platform. Examples are onboarding users, access reviews and housekeeping, attribute-consumption optimization, health checks and status tests. Each procedure becomes a repeatable, versioned process. You can run it on demand or on a schedule, a person can approve or select items where needed, and every run leaves a tamper-evident protocol.

- **Platform-agnostic.** You add platforms (base URL, credentials, OpenAPI specs, documentation). Processes refer to _connection slots_, so the same process runs against test and production tenants. A configured platform can be saved as a reusable **connector type**, exported and imported, so adding a new tool is a one-time job.
- **Flow editor (Node-RED style).** Drag nodes from a palette onto a canvas and wire them together. Node types: API call (with pagination and OpenAPI operation picker), set variables, for each, if, user task / approval, check, report, browser automation, wait, fail, comment. Outputs are labelled (true/false, each item/done, approved/rejected, error). You can also edit the YAML source directly.
- **Single sign-on.** Sign in with Microsoft Entra ID or any OpenID Connect provider (Okta, Keycloak, Google, ADFS …). Roles and teams can be assigned from Entra app roles or groups.
- **Users and access control.** Sign-in with roles (admin, designer, operator, approver, auditor, viewer) and teams. Per-process and per-platform access lists narrow who may view, run, edit, approve or manage, e.g. only the Service Desk team may use the production tenant. Decisions can be assigned to people, teams or roles, with an optional four-eyes rule.
- **Human in the loop.** A run can pause and ask you to pick items from a list, e.g. "untick the users who still need access", or to approve a change. The decision, who made it and when are all recorded.
- **Dry runs.** Read calls run, write calls (POST/PUT/PATCH/DELETE) are only recorded. You see exactly what _would_ change.
- **Scheduling.** Cron schedules with time zones. Scheduled runs that need a decision wait in _My tasks_.
- **Webhook triggers.** An inbound URL with its own secret (static token or HMAC signature) starts a process with inputs mapped from the request, e.g. a [Gatus](docs/GATUS.md) alert starts a diagnosis runbook. Runs use the owner's rights; calls are rate-limited, de-duplicated and audited.
- **Monitors.** Composable, dependency-aware health checks: ping, TCP, HTTP, platform API calls, data freshness in Insights Hub (cadence or maximum age), Gatus endpoints, sub-monitors and **heartbeats pushed by an IoT gateway** (one call per check or one batch call). Links between checks name the root cause and keep follow-up alerts quiet, without making one check depend on another. Status goes to notifications, runbooks, webhooks, Gatus, **Zabbix** (trapper protocol or `history.push`), Prometheus, dashboards and the public API (incl. Zabbix low-level discovery). Templates with CSV import for many machines, maintenance windows, a status wall. See [docs/MONITORS.md](docs/MONITORS.md).
- **Auditability.** There is a hash-chained, HMAC-signed audit log and a per-run protocol (HTML/JSON) with inputs, every request, decisions, checks, reports and screenshots. Each protocol has a sealed fingerprint, so later changes are detected.
- **PDF reports for the archive.** Branded PDF/A-2b reports of finished runs (what was done, when, results, decisions, comments) and periodic summaries, ready to be archived and signed later. Every PDF is stored unchanged and its SHA-256 is recorded in the audit log. **Scheduled reports** (daily, weekly, monthly) cover availability and SLA of monitors and Gatus endpoints, the credentials register and runs, and are sent to their recipients. See [PDF reports](#pdf-reports) and [docs/REPORTS.md](docs/REPORTS.md).
- **Credentials register.** Document the credentials your services use – API clients, technical users, tokens, certificates, agent certificates – without storing a secret: where they are kept (e.g. the KeePass entry), who owns and uses them, expiry, rotation and review dates. Certificates are read from the uploaded public certificate; owners get reminders before anything expires or is due. See [docs/CREDENTIALS.md](docs/CREDENTIALS.md).
- **Dashboards.** Flows publish datasets: a snapshot of rows with a status per row, plus metric history. Dashboards show them as KPI tiles, trends, status distributions and tables, with no live API calls when someone opens a dashboard.
- **Example library.** [`examples/`](examples/README.md) contains service-management and housekeeping procedures for Insights Hub and Industrial Edge, plus dashboards, all importable.
- **Sub-processes and parallel loops.** A _Run sub-process_ node calls another process as a reusable building block (inputs in, outputs back, linked child runs). _For each_ can process items in parallel. Platform calls retry on 429/5xx with backoff and honour `Retry-After`.
- **Editor help.** Expression autocomplete with a live preview using the data of the last run, a _Last run_ inspector per node, undo/redo, copy/paste between processes, and a YAML diff between versions.
- **Notifications.** In-app notification centre, plus e-mail (SMTP), Microsoft Teams and generic webhooks for decisions waiting, failed runs and checks, stale dashboard data and skipped schedules. Optional browser notifications.
- **Automation API.** Personal API tokens (read-only, full, or MCP client) for scripts, CI and AI assistants.
- **Public REST API.** A versioned, read-only API under `/api/v1` with an OpenAPI 3.1 description and an optional Swagger UI (`/api/docs/`): processes and versions, runs with steps, logs, decisions and checks, tasks, schedules, webhook triggers, platform metadata (never credentials), dashboard datasets, the audit log, users and teams. Token-only, rate-limited, cursor pagination, RFC 9457 errors. E.g. `curl -H "Authorization: Bearer smt_…" http://127.0.0.1:4310/api/v1/runs`. See [docs/API.md](docs/API.md).
- **AI assistants (MCP).** A read-only [Model Context Protocol](https://modelcontextprotocol.io) server at `/api/mcp` (off by default) lets Claude Desktop, VS Code and other MCP clients search processes, runs, monitors, schedules, dashboards and the audit log with the rights of the person's own _MCP client_ token; a stdio bridge (`steward mcp`) serves desktop clients. Per platform, an administrator can open a read-only **gateway** to the platform's API: GET operations from its OpenAPI specification, called by Steward with the stored credentials and audited. See [docs/MCP.md](docs/MCP.md).
- **Semantic model.** Steward's data model as an [Apache Ossie](https://github.com/apache/ossie) (formerly OSI) semantic model at `/api/v1/semantic-model` (JSON or YAML): datasets, fields, relationships and metrics such as the run success rate and monitor availability, for BI tools, catalogs and AI agents. See [docs/SEMANTIC-MODEL.md](docs/SEMANTIC-MODEL.md).
- **Observability.** Structured JSON logs, optional OpenTelemetry tracing, Prometheus metrics (`/api/metrics`), readiness probe (`/api/ready`), and a **System status** page for administrators (components, integrations, runtime, health-check URLs).
- **Your look.** Administrators set the primary and accent colour, default colour scheme, corner radius, a display name such as "ACME Steward" and a header logo, for everyone and already on the sign-in page. Contrast is kept at WCAG AA automatically. An **About** page shows version, build, licences and links. See [docs/BRANDING.md](docs/BRANDING.md#theming-settings--appearance).
- **Runs anywhere.** A single-file desktop executable (no Node.js needed), an installable web app (PWA), Node.js, or a container. See [docs/INSTALL.md](docs/INSTALL.md).
- **Durable.** Runs are journaled step by step. If the app stops while a run waits for a decision, it resumes after a restart without repeating finished steps.
- **Local and safe.** The server binds to `127.0.0.1` and stores credentials AES-256-GCM encrypted with your master passphrase. It has CSRF and DNS-rebinding protection.

## Quick start (demo with simulated platforms)

Requirements: **Node.js 24 (LTS)** (it uses the built-in SQLite). Windows, macOS and Linux are supported.

```bash
npm install
npx playwright install chromium   # only needed for browser automation
npm run demo
```

Then:

1. Open <http://127.0.0.1:4310>. Choose a master passphrase and create the first administrator account.
2. Click **Load demo platforms & processes** on the dashboard. This adds a simulated Insights Hub tenant, a simulated Industrial Edge Management, all templates, and demo users:
   - `dana` (designer)
   - `olivia` (operator)
   - `adam` (approver)
   - `audrey` (auditor)
   - `vera` (viewer)

   All of them have the password `Demo-password-1`. Olivia and Adam are in the team _Service Desk_.

3. Open **Processes → "Insights Hub – Access review 1"** and click _Run_. Keep _Dry run_ on the first time.

## Ways to run it

- **Desktop executable:** download, double-click; it opens as an app window. `npm run build && npm run build:exe` builds it yourself.
- **Installed web app:** in Edge/Chrome choose _Install_ (or _Install app_ in the user menu).
- **Node.js:** see below.
- **Container:** `docker compose up -d`.

Details, autostart for schedules and code-signing notes are in [docs/INSTALL.md](docs/INSTALL.md). Naming ideas and how to rebrand are in [docs/BRANDING.md](docs/BRANDING.md). Languages (English, German) and how to add one: [docs/I18N.md](docs/I18N.md).

## Everyday use

```bash
npm install
npm run build      # builds the web UI once (again after updates)
npm start          # http://127.0.0.1:4310
```

All data lives in `./data`: the SQLite database, encrypted credentials, screenshots, uploaded docs and the vault file. Back it up. Use `SM_DATA_DIR` to keep it somewhere else. A shared installation can keep the database in PostgreSQL instead; see [Database](docs/INSTALL.md#5-database-sqlite-or-postgresql).

| Variable                                         | Default                          | Purpose                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SM_PORT`                                        | `4310`                           | HTTP port                                                                                                                                                                                                                                                                                                                       |
| `SM_HOST`                                        | `127.0.0.1`                      | Bind address. Keep it local unless you know what you are doing.                                                                                                                                                                                                                                                                 |
| `SM_DATA_DIR`                                    | `./data`                         | Data directory                                                                                                                                                                                                                                                                                                                  |
| `SM_DATABASE_URL`                                | – (SQLite in the data directory) | Use PostgreSQL: `postgres://user:password@host:5432/database`. Not available in the desktop executable. See [Database](docs/INSTALL.md#5-database-sqlite-or-postgresql).                                                                                                                                                        |
| `SM_DATABASE_SCHEMA`                             | `public`                         | PostgreSQL schema (created if missing)                                                                                                                                                                                                                                                                                          |
| `SM_DATABASE_CA`                                 | –                                | CA certificate (PEM file) for verifying the PostgreSQL server's TLS certificate                                                                                                                                                                                                                                                 |
| `SM_MASTER_PASSPHRASE_FILE`                      | –                                | File with the master passphrase: unlock automatically at start-up, so schedules run after a reboot. Use a Docker secret, a systemd credential or a file only the service account can read.                                                                                                                                      |
| `SM_MASTER_PASSPHRASE`                           | –                                | The same, as a variable (prefer the file). Both are removed from the environment at start, so child processes never see them.                                                                                                                                                                                                   |
| `SM_ALLOWED_HOSTS`                               | –                                | Extra allowed `Host` headers (comma-separated), e.g. the machine's DNS name when colleagues use it                                                                                                                                                                                                                              |
| `SM_TLS_CERT` / `SM_TLS_KEY`                     | –                                | Paths to a certificate and key. Serves HTTPS, which is recommended when others connect over the network.                                                                                                                                                                                                                        |
| `SM_PUBLIC_URL`                                  | –                                | External URL (e.g. `https://steward.corp.example`) when running behind a reverse proxy. It is used for the single sign-on redirect URI; an `https://` URL also makes the session cookie `Secure` and turns on HSTS.                                                                                                             |
| `SM_TRUST_PROXY`                                 | – (off)                          | Behind a reverse proxy: the proxies' addresses/CIDRs (`10.0.0.5,10.1.0.0/16`, `loopback`) or the number of proxies (`1`, only for a proxy on a loopback/private address) whose `X-Forwarded-For/-Proto/-Host` are believed. Client addresses in the audit log, sign-in lockouts and webhook CIDR checks then are the real ones. |
| `SM_TLS_CIPHERS`                                 | modern list                      | OpenSSL cipher list for TLS 1.2 with the built-in HTTPS (TLS 1.3 suites are always on; TLS 1.0/1.1 are off)                                                                                                                                                                                                                     |
| `SM_AUDIT_ANCHOR` / `SM_AUDIT_ANCHOR_FILE`       | –                                | A signed audit checkpoint kept outside Steward (or a file with one, e.g. on a write-once share). Every verification fails if the log is shorter than it or differs. See [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md#audit-log-as-evidence).                                                                         |
| `SM_AUDIT_CHECKPOINT_MINUTES`                    | `60`                             | Interval of signed audit checkpoints                                                                                                                                                                                                                                                                                            |
| `SM_CHROMIUM_SANDBOX`                            | auto                             | `1`/`0` forces Chromium's sandbox for browser steps on/off (default: on, except as root)                                                                                                                                                                                                                                        |
| `SM_CHROMIUM_PATH`                               | –                                | Use a specific Chromium/Chrome binary for browser steps                                                                                                                                                                                                                                                                         |
| `HTTPS_PROXY` / `NO_PROXY`                       | –                                | Corporate proxy, used for platform calls unless a platform overrides it                                                                                                                                                                                                                                                         |
| `SM_DEMO`                                        | –                                | `1` mounts the mock platforms under `/mock`                                                                                                                                                                                                                                                                                     |
| `SM_LOG_LEVEL`                                   | `info`                           | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. Logs are JSON lines on stdout.                                                                                                                                                                                                                                            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                    | –                                | Turns on OpenTelemetry tracing (OTLP/HTTP). Standard `OTEL_*` variables apply, e.g. `OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_HEADERS`.                                                                                                                                                                                       |
| `SM_OTEL_PROPAGATE`                              | `1`                              | `0` stops adding `traceparent` headers to platform calls                                                                                                                                                                                                                                                                        |
| `SM_SENTRY_DSN`                                  | –                                | Report unexpected errors to Sentry, GlitchTip or Bugsink (off by default; scrubbed, no personal data). More variables and exactly what is sent: [docs/ERROR-REPORTING.md](docs/ERROR-REPORTING.md)                                                                                                                              |
| `SM_METRIC_RETENTION_DAYS`                       | `400`                            | How long dashboard metric history is kept                                                                                                                                                                                                                                                                                       |
| `SM_METRICS_PUBLIC`                              | –                                | `1` serves `/api/metrics` without sign-in (otherwise admins, auditors or an API token)                                                                                                                                                                                                                                          |
| `SM_SESSION_IDLE_MINUTES`                        | `30`                             | A session ends after this many minutes without a request (an open Steward tab keeps it alive)                                                                                                                                                                                                                                   |
| `SM_SESSION_MAX_HOURS`                           | `12`                             | A session ends this many hours after sign-in, used or not (OWASP ASVS level 2)                                                                                                                                                                                                                                                  |
| `SM_API_V1`                                      | `on`                             | `off` turns the public REST API (`/api/v1`) and its documentation off                                                                                                                                                                                                                                                           |
| `SM_API_DOCS`                                    | –                                | Who may open the API documentation (`/api/docs/`, `openapi.json` without a token): `off`, `authenticated` (signed-in users, the default) or `public`. Overrides the setting under **Settings → REST API**.                                                                                                                      |
| `SM_API_RATE_LIMIT`                              | `600`                            | Requests per minute and API token on `/api/v1`; `0` = unlimited                                                                                                                                                                                                                                                                 |
| `SM_MCP`                                         | –                                | `off` turns the MCP server (`/api/mcp`) off, whatever **Settings → MCP server** says                                                                                                                                                                                                                                            |
| `SM_MCP_RATE_LIMIT`, `SM_MCP_GATEWAY_RATE_LIMIT` | `120`, `30`                      | MCP requests per minute and token; platform gateway calls per minute, user and platform                                                                                                                                                                                                                                         |
| `SM_MCP_ALLOWED_ORIGINS`                         | –                                | Origins of browser-based MCP clients allowed to call `/api/mcp` (comma-separated)                                                                                                                                                                                                                                               |

Retention of runs and notifications, and the notification channels, are set under **Settings**.

## Concepts

|                     |                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform**        | One instance of a system: an Insights Hub tenant, an IEM, any REST API. It holds the base URL, authentication, non-secret variables (tenant, region, API paths), encrypted credentials, OpenAPI specs (searchable operations, used by the editor and the API explorer; import by file, paste or URL) and docs (notes, links, files).          |
| **Connector type**  | A reusable template for a kind of platform: auth, variables, HTTP options, credential field names, doc links and API specs, but never credential values. Create one from a configured platform with _Save as connector type_. Export it as JSON to share, import it elsewhere, and new platforms created from it get the specs automatically. |
| **Process**         | A versioned flow of nodes and wires. It declares connection slots (e.g. `hub`, kind `insights-hub`), inputs (number, text, list, CSV table, …) and constants (e.g. group bundles). Every save creates a new version with author, comment and hash.                                                                                            |
| **Run**             | One execution of a pinned process version, manual or scheduled, real or dry. It has a full step journal, logs, decisions, checks, reports and evidence.                                                                                                                                                                                       |
| **Task**            | A decision a run is waiting for: select items or approve/reject. Tasks are listed in **My tasks** and on the run page.                                                                                                                                                                                                                        |
| **Schedule**        | Cron plus time zone, with preset inputs and connections. It skips a new run while the previous one is still waiting, unless overlap is allowed.                                                                                                                                                                                               |
| **Webhook trigger** | `POST /api/hooks/<id>` with a secret starts a process as the trigger's owner; inputs are mapped from the JSON body, allow-listed headers and the query with JSONata. See [docs/GATUS.md](docs/GATUS.md#webhook-trigger-reference).                                                                                                            |
| **Monitor**         | A graph of checks (ping, TCP, HTTP, platform API, data freshness, heartbeat, Gatus, sub-monitor) with soft or hard links. Every check runs on its own interval; links explain failures (root cause) and suppress follow-up alerts. See [docs/MONITORS.md](docs/MONITORS.md).                                                                  |
| **Audit log**       | Everything that changed anything, attributed to the signed-in user: sign-ins, user/role/access changes, platform/credential changes, process versions, runs, every write call, skipped (dry-run) writes, decisions, failed checks, screenshots, exports.                                                                                      |

## Users, roles and access

| Role     | Default rights                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------- |
| admin    | Everything: users and teams, platforms and credentials, settings, all processes, unlocking the vault. |
| designer | Create processes. Edit and run all processes unless an access list says otherwise.                    |
| operator | Run and schedule processes.                                                                           |
| approver | Decide approvals and user tasks.                                                                      |
| auditor  | Read-only access to everything, including the audit log and all protocols.                            |
| viewer   | Read processes and their runs.                                                                        |

- **Process access list.** Rights are `view`, `run` (start, schedule, make selection decisions), `edit`, `approve` and `manage` (change access, archive). An empty list means the role defaults apply. As soon as entries exist, only the listed `user:…`, `team:…` or `role:…` subjects get the listed rights. Admins and the process owner (its creator) always keep full rights.
- **Platform access list.** Rights are `use` (bind it in runs; read-only explorer calls) and `manage` (configuration, credentials, access, write calls in the explorer). Use this to restrict e.g. the production tenant to one team.
- **Decisions.** A user task can name `assignees` (users, teams, roles). Otherwise everyone with `run` or `approve` on the process may decide. With `fourEyes: true`, the person who started the run may not decide.
- **Schedules.** A schedule runs with the rights of its owner (the person who created it). If the owner loses the rights or is deactivated, the run is skipped and recorded in the audit log.
- **Webhook triggers** follow the same rules as schedules: creating one needs run rights on the process, runs use the owner's rights (checked on every call), and the owner, an admin or a process manager can change it.
- New accounts get a temporary password and must change it at first sign-in. Passwords are hashed with scrypt. Five failed sign-ins lock the account for five minutes.
- Forgotten admin password: `steward admin reset-password <user>` on the server (needs the master passphrase; audited). To reset a demo, delete its data folder. See [docs/INSTALL.md](docs/INSTALL.md#resetting-a-demo-and-recovering-access).

### Single sign-on (Microsoft Entra ID / OpenID Connect)

Sign-in uses the OpenID Connect authorization code flow with PKCE, through the [openid-client](https://github.com/panva/openid-client) library. Tokens are checked for issuer, audience, signature (JWKS), expiry, nonce and state. The client secret is stored encrypted with the master passphrase.

**Set it up in Microsoft Entra ID:**

1. **Register the app.** In the Entra admin center go to _App registrations → New registration_. Name it e.g. "Steward" and choose single tenant.
2. **Add the redirect URI.** Platform _Web_. Copy the exact value from **Users & teams → Single sign-on**; it looks like `https://<your host>/api/auth/oidc/callback`. For purely local use, `http://localhost:4310/api/auth/oidc/callback` works, because Entra only allows plain http for `localhost`. In that case open the tool via `http://localhost:4310`.
3. **Create a client secret.** Under _Certificates & secrets_, create a new client secret and copy its value.
4. **Define app roles.** Under _App roles_, create e.g. `SM.Admins`, `SM.Designers`, `SM.Operators`, `SM.Approvers`, `SM.Auditors`, `SM.Viewers`, with member types _Users/Groups_.
5. **Assign people.** Under _Enterprise applications → Steward → Users and groups_, assign users or groups to these roles. Optionally set _Assignment required = Yes_ so that only assigned people can sign in at all.
6. **Add the provider in Steward.** Go to **Users & teams → Single sign-on → Add provider → Microsoft Entra ID**. Enter the tenant ID, client ID and secret, then click _Test discovery_.
7. **Map the role values.** Map each app role to Steward roles and teams (claim `roles`). Alternatively let Entra emit the `groups` claim and map group object IDs; tokens carry at most 200 groups, so app roles are the better choice.

**How accounts are handled:**

- **Auto-provision.** New users get an account on their first sign-in.
- **Role sync.** Roles, and the teams named in the mappings, are updated from the token at every sign-in.
- **Mapping required.** Users without a mapped role are rejected.
- **Pre-created accounts.** An account with the same user name (e.g. the UPN) is linked on its first SSO sign-in.
- **No passwords.** SSO accounts have no password in Steward.
- **SSO only.** Under **Settings → Sign-in**, password sign-in can be limited to administrators. Local admin accounts stay as break-glass access, e.g. to unlock the vault after a restart.

Any other OIDC provider works the same way with the _Generic OIDC_ preset: issuer URL, client ID and secret (or a public client with PKCE), and claim names. In demo mode a simulated Entra ID is preconfigured. Its accounts (Max Admin, Erik Engineer, Oskar Operator, Sofia Approver, Nina Nobody) show the mappings in action.

### Using it as a team

It still runs locally. Make it reachable on your network:

1. Set `SM_HOST=0.0.0.0` and `SM_ALLOWED_HOSTS=<machine name>`.
2. Provide a certificate with `SM_TLS_CERT` / `SM_TLS_KEY`, or run it behind your reverse proxy.
3. Create accounts under **Users & teams**.

One person (an admin) unlocks the vault after a restart, or you provide the passphrase in a file (`SM_MASTER_PASSPHRASE_FILE`) for unattended start-up. Before using it at work, go through [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md).

### Supported authentication

`none`, `basic`, `bearer`, `apiKey` (header or query), `oauth2_client_credentials` (e.g. Insights Hub service credentials), and `token_request`. `token_request` is a configurable login call whose response contains a token, e.g. the IEM `/portal/api/v1/login/direct` or the Insights Hub Technical Token Manager. Per platform you can also set a proxy, a custom CA, _accept self-signed certificates_ (common for on-prem IEM), a timeout and default headers.

## Dashboards

1. **Publish data from a flow.** Add a **Publish to dashboard** node. Give it a dataset key such as `iem.devices`, the rows (an expression), optionally compact `columns`, a `status` expression per row (good / warning / serious / critical / unknown), a reason text, and `metrics` (numbers kept as history).
2. **What a run stores.** Every run replaces the dataset snapshot and appends the metrics.
3. **Keep it fresh.** Schedule the publishing flow, e.g. hourly inventories or a health check every 15 minutes. `staleAfterMinutes` marks old data on the dashboards.
4. **Build the dashboard.** _Dashboards → New / From template / Import YAML_. Widget types:
   - `kpi`: value, change and sparkline;
   - `trend`: up to three metrics;
   - `status`: distribution of row statuses;
   - `table`: rows with status, search and a problems-only filter;
   - `checks`: the latest checks of a process;
   - `freshness`;
   - `markdown`.
5. **Refresh.** _Refresh data_ re-runs the feeding processes with the inputs of their last run, provided you have run rights.

Who can see what: a dataset is visible to everyone who may view the process that publishes it.

## Bundled templates

| Template                                            | What it does                                                                                                                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Insights Hub – Access review 1: flag inactive users | Lists users and finds those inactive for N days, with an exempt list. You confirm the selection, then they are added to a review group.                                                                               |
| Insights Hub – Access review 2: decide and clean up | Lists the review group. You tick who still needs access (recently active users are preselected). Kept users are un-flagged; for the rest, after a final approval, all memberships are removed or the user is deleted. |
| Insights Hub – Onboard users with group bundles     | Takes a CSV of users and a _bundle_ per user (e.g. Operator → StandardUser + Operators group). It checks that all groups exist, asks for approval, creates missing users and adds only the missing memberships.       |
| Insights Hub – Asset attribute optimization check   | Counts attributes per asset type, samples the latest time-series records and reports variables that never get data, assets without data and stale aspects, with the potential attribute savings.                      |
| Insights Hub – Platform health check                | Calls the core services and records pass/fail checks with latency limits.                                                                                                                                             |
| Industrial Edge – Device status check               | Flags devices that are not online and reports a device overview.                                                                                                                                                      |
| Browser – Portal login and status screenshot        | Signs in to a portal, reads a status text, checks it and stores a screenshot as evidence.                                                                                                                             |
| Generic – Endpoint availability check               | Calls a list of endpoints and records one check per endpoint.                                                                                                                                                         |

Templates are YAML files in [`examples/processes/`](examples/README.md); example dashboards are in `examples/dashboards/`. Adding a file there makes it available in _From template_. The examples README lists the whole library, including privileged-access review, offboarding, group hygiene, inventories, data freshness, firmware and app compliance, stale device clean-up and a weekly service report. Check files with `npm run validate`, which runs in CI too.

**Gatus.** Steward works alongside the [Gatus](https://github.com/TwiN/gatus) uptime monitor instead of re-implementing monitoring: Gatus monitors Steward's `/api/health` and `/api/ready`, Steward shows the Gatus endpoint status on the _Uptime_ dashboard, pushes its own check results to Gatus external endpoints, and a Gatus alert can start a runbook through a webhook trigger. In **metrics mode** Steward scrapes Gatus' Prometheus endpoint and keeps its own history (uptime, outages, response times, certificate expiry) for monitors, scheduled reports and the credentials register. Configuration snippets and security notes: [docs/GATUS.md](docs/GATUS.md).

For the bigger picture (standards, UX ideas, Kestra/Temporal, observability, roadmap) see [`docs/ROADMAP.md`](docs/ROADMAP.md). The current UI/UX review, its fixes and the UX backlog are in [`docs/UX-REVIEW.md`](docs/UX-REVIEW.md).

### Notes on the Siemens APIs (please verify on your tenant)

- **Domain migration.** Insights Hub is moving from `gateway.{region}.mindsphere.io` (`/api/{service}/v3`) to the Xcelerator gateway `api.{region}.siemens.app` with tenant-specific paths (`/api/identitymanagement-{coreTenantId}/v3`). The templates therefore read their API paths from platform variables (`idmPath`, `assetPath`, `tsPath`) and fall back to the classic paths. Set these variables on the platform when you move.
- **Last login.** The Identity Management user list returns `resources` (lowercase), `totalResults` and paging via `startIndex`/`count`. The last-login attribute `lastLogonTime` is used by Siemens' own `mdsp` CLI but is **not part of the official spec**. Do a dry run of _Access review 1_ first and check the _List all users_ step output.
- **Asset attributes.** These are billed per asset: the asset type's variables plus the variables of its aspects. The optimization template estimates potential from sampled latest values. Cross-check with the Asset Manager attribute calculator before changing models.
- **IEM device fields.** Field names for connection state differ between IEM versions, so the device template takes the field name and the "online" value as inputs. Use the platform's **API explorer** to look at a real response.
- Import the official OpenAPI specs from the Siemens developer portal into each platform. The editor's _Pick from API spec_ and the explorer then list all operations.

## PDF reports

Steward creates PDF reports without a browser, also in the desktop executable.

- **Run report.** On a run page, open _PDF reports → Generate PDF report_ (or _Protocol → Generate PDF report…_). Choose English or German and add a reviewer comment if you like. The report contains:
  - a summary: process, version and definition hash, who started the run, when and how, the time zone, the status and a prominent _dry run_ banner;
  - the platforms used (names and kinds only, never credentials) and the inputs;
  - every step in order, the write operations (simulated ones are marked), decisions and approvals (who, when, selection, comment, four-eyes rule), checks, the process's own report sections, evidence with thumbnails and errors;
  - the reviewer comment, an integrity section with the sealed protocol hash and the run's audit trail, and a sign-off block (_Prepared / Reviewed / Approved by_) with empty digital signature fields.
- **Interim reports.** Runs that wait for a decision can be reported too. These reports are marked _interim_.
- **Summary report.** _Runs → Summary report_ lists all runs of one or more processes in a period, e.g. "Access reviews Q3", with totals.
- **Automatic reports.** In the process editor, _Settings → PDF report_ (YAML: `report: { auto: true, lang: de }`) generates the report whenever a run finishes, e.g. for scheduled reviews.
- **Branding.** _Settings → Report branding_ (administrators) sets the company name, logo (PNG/JPEG, max. 1 MB; default: the Steward logo), accent colour, default classification (e.g. _Internal_) and a footer note, with a sample preview.

- **Scheduled reports.** _Reports → New report schedule_: availability and SLA per monitor and Gatus endpoint, credentials that expired or are due, runs per process – daily, weekly, monthly or on your own cron schedule, generated with the owner's rights, archived like every report and sent to users, teams and e-mail addresses. See [docs/REPORTS.md](docs/REPORTS.md).

**Archiving and signing.** The files are PDF/A-2b with embedded fonts and metadata (run ID, process, protocol hash, content hash), validated with veraPDF (PDF/A-2b). They are written once to `data/reports/<run>/<report>.pdf` and never overwritten; generating again creates a new version. Each generation is recorded as `report.generated` with the file's SHA-256 in the audit log, and data retention removes a run's reports together with the run. The signature fields can be signed later in Adobe Acrobat or another PDF signing tool.

**Verifying a copy.** _Audit log → Verify PDF report_ (or `POST /api/reports/verify`) checks a file against the audit log. It also recognizes signed copies: a signature is appended as an incremental update, so the first bytes of a signed copy are still the original report.

API: `POST /api/runs/:id/reports` `{ lang, comment, classification, timeZone }`, `GET /api/runs/:id/reports`, `GET /api/reports/:id/download`, `POST /api/reports/summary` `{ processIds, from, to, lang, comment, title }`. `GET /api/runs/:id/report.pdf?lang=de` generates, stores and returns a report in one step. Generating and downloading needs view rights on the process; branding needs the _settings_ capability.

## Records and services

_Records_ holds the team's **change requests** and **decision records** (ADR, DR, SDR), numbered per type and year (`CR-2026-0001`):

- a workflow per type (change: draft → submitted → approved/rejected → implemented → closed; decision: draft → proposed → accepted/rejected → superseded/deprecated), with four-eyes approval by approvers;
- versions with a diff; leaving the draft status freezes the content and records its SHA-256 – changes need an audited new revision;
- Markdown text (rendered without HTML), structured fields, comments, attachments (documents and e-mails, content-checked) and links to processes, runs, monitors, platforms, dashboards, services and external pages, shown on both sides;
- import of existing ADRs from Markdown (MADR, Nygard, YAML frontmatter) and export back to Markdown;
- a PDF/A-2b document with signature blocks and empty digital signature fields for people outside Steward; the signed PDF is uploaded back and checked to be derived from the generated one (structure only, not a cryptographic validation).

_Services_ is a minimal service catalogue: contacts, criticality, the entry in your CMDB and links. See [docs/RECORDS.md](docs/RECORDS.md).

_Tickets_ documents tickets that live elsewhere – incidents users reported through ServiceNow and cases opened with vendors: source, number and link, status, who looks after it on our side, and the affected services, platforms, credentials and records. No workflow, just tracking with a history, optional "not checked for N days" reminders, a report section and a badge of open vendor tickets in the service catalogue. See [docs/TICKETS.md](docs/TICKETS.md).

## Writing processes

Processes are built on the canvas or as YAML (_Source_ tab, or _Import YAML_).

**How a flow runs.** Execution starts at the _Start_ node and follows the wires, depth first. When an output has several wires, the targets run one after another, top to bottom as placed on the canvas.

- **Outputs.** A node fires one of its outputs:
  - _if_ fires `true` or `false`.
  - _for each_ runs everything wired to `each item` once per item, then continues on `done`. Leave the last node of the loop body unconnected.
  - An approval fires `approved` or `rejected`. If `rejected` is not connected, a rejection fails the run.
  - API call and browser nodes fire `error` instead of failing the run if that output is connected.
- **Joins and cycles.** A node reached from both branches of an _if_ runs once. Wires may not form cycles; use _for each_ for repetition.
- **Skipped nodes.** A node whose _Only run when_ condition is false is skipped and passes the flow on.
- **Restarts.** Every executed node is journaled, so runs survive restarts.

Stored processes use `nodes` and `wires`:

```yaml
nodes:
  - { id: start, type: start, x: 0, y: 0 }
  - { id: check, type: if, condition: 'inputs.days > 30', x: 250, y: 0 }
  - { id: warn, type: log, level: warn, message: 'long period', x: 500, y: -60 }
wires:
  - { from: start, port: out, to: check }
  - { from: check, port: 'true', to: warn }
```

For hand-written YAML the compact sequential format is easier to read. It is converted into a graph (with automatic layout) on import:

```yaml
name: List inactive users
connections:
  - slot: hub
    kind: insights-hub
inputs:
  - { name: days, type: number, default: 90 }
steps:
  - id: users
    type: http
    connection: hub
    method: GET
    path: /api/identitymanagement/v3/Users
    paginate: { mode: scim, pageSize: 100 }
    saveAs: users
  - id: inactive
    type: set
    values:
      inactive: '{{ vars.users.body[$daysSince(lastLogonTime) > $inputs.days][] }}'
  - id: pick
    type: userTask
    mode: select
    title: 'Remove {{ $count(vars.inactive) }} users from group X?'
    items: vars.inactive
    itemKey: id
    columns: [{ label: User, value: userName }]
    saveAs: decision
  - id: remove
    type: forEach
    items: vars.decision.selected
    as: user
    steps:
      - id: del
        type: http
        connection: hub
        method: DELETE
        path: '/api/identitymanagement/v3/Groups/<groupId>/members/{{ vars.user.id }}'
```

### Expressions and templates

- Expressions use **[JSONata](https://jsonata.org)**. Fields such as _condition_, _items_ or _rows_ take an expression. Text fields accept templates of the form `{{ expression }}`. A field that contains only `{{ … }}` keeps the value's type (list, object, number).
- In scope: `inputs.*`, `vars.*` (step results, `saveAs`), `const.*` (process constants), `run.*` (`id`, `dryRun`, `actor`), and `conn.<slot>.*` (`name`, `baseUrl`, `vars`).
- Inside filters `[...]` a plain name refers to the current item. Use `$inputs`, `$vars` and `$const` there instead.
- Extra functions:
  - `$daysSince(ts)`
  - `$daysAgo(n)`
  - `$ts(ts)`
  - `$uuid()`
  - `$pvar(slot, name, default)` reads a platform variable.
  - `$secret(slot, key)` reads a credential for use in a request to _its own platform_ (e.g. a custom auth header or a portal login). The value is redacted everywhere in logs (including base64/URL-encoded forms) and may only be sent to the platform's allowed origins — a step that would send it elsewhere fails. See the security model below.
- Append `[]` to force a list, e.g. `vars.users.body[active][]`.
- Per-item fields (task columns, preselect, report columns) are evaluated against the item, which is also available as `$item`.

### Node types

| Type          | Outputs                  | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`       | out                      | Entry point (exactly one).                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `http`        | out, error               | API call on a connection. `query`, `headers` and `body` are templated. `expectStatus` sets the accepted status codes. `paginate` modes: `scim` (startIndex/count), `page` (page/size + `page.totalPages`), `offset`, `nextLink`. The result is `{status, headers, body, durationMs}`; with pagination, `body` is the concatenated item list. Writes are skipped in dry runs. _Pick from API spec_ fills method, path, parameters and an example body from the platform's OpenAPI spec. |
| `set`         | out                      | Compute variables (evaluated in order).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `forEach`     | each item, done          | Loop over a list (`as` names the item variable, `<as>Index` holds the index). Supports `delayMs` and a `maxItems` safety limit.                                                                                                                                                                                                                                                                                                                                                        |
| `if`          | true, false              | Branch on a condition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `userTask`    | out / approved, rejected | `select` lets someone pick items; the result has `selected`, `unselected`, `comment`, `decidedBy`. `approve` asks for approval. Optional `assignees` and `fourEyes`.                                                                                                                                                                                                                                                                                                                   |
| `check`       | out                      | Pass/fail with a severity. Shown on the dashboard and in the protocol. `failRun` stops the run.                                                                                                                                                                                                                                                                                                                                                                                        |
| `report`      | out                      | Text (markdown subset) and/or a table section in the protocol.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `browser`     | out, error               | Playwright actions: `goto`, `click`, `fill`, `press`, `select`, `check`, `waitFor`, `expectText`, `extract`, `screenshot`, `wait`, `evaluate`. The session is shared across browser nodes of a run, and a failure screenshot is captured automatically. Mark it `mutating` so it is skipped in dry runs.                                                                                                                                                                               |
| `wait`, `log` | out                      | Self-explanatory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fail`        | –                        | Stops the run with a message.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `note`        | –                        | Comment on the canvas, not executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Common options for all nodes:

- `when` (condition)
- `saveAs`
- `onError: continue`
- `retry: { attempts, delayMs }`

Tip: `npx playwright codegen https://your-portal` records clicks and gives you selectors.

## Security model

- Everyone signs in. Sessions are HttpOnly, SameSite=Strict cookies (`__Host-` prefixed over HTTPS; they end after 30 minutes without use and 12 hours after sign-in) **bound to a per-session key**: the web app keeps it in `localStorage` of its own origin and sends it with every request, so a cookie that leaks to another program on the same host (cookies are not isolated by port) is useless on its own. Every API call is checked against roles and access lists on the server; `server/test/route-matrix.test.ts` calls every route with every role. API tokens cannot manage users, teams, single sign-on, sign-in settings or the master passphrase.
- Credentials are encrypted at rest (AES-256-GCM) with a random data key. The vault file wraps it (and the audit, integrity and signing keys) with a key derived by scrypt (N=2^17) from your master passphrase; keys are only kept in memory. The passphrase can be changed, optionally rotating the data key. The API never returns secret values, and they are redacted from logs, protocols and audit entries. Process inputs of type _secret_ are stored encrypted and shown as `***`.
- Platform credentials only go to the platform: the auth header, API keys and default headers are attached when a request targets the origin of the platform's base URL (or an origin listed under _Trusted origins_). An API call with an absolute URL to any other host is sent without them. The connection settings themselves are sealed (HMAC with a vault key): changed directly in the database, the platform is refused until an administrator confirms them.
- Secrets stay inside the platform they belong to. `$secret(slot, key)` is available to process authors with `use` (it is needed for legitimate custom auth, e.g. a per-endpoint token or a portal login), but a resolved secret value may only leave Steward towards that platform's own allowed origins. Before every process-controlled request the URL, headers and body are scanned for any bound platform's secret value (also base64- and URL-encoded), and the step fails if a secret would reach an origin the platform does not allow. Secrets are also masked in their encoded forms in logs and protocols. This is why `use` does not require `manage`: the confidentiality boundary is enforced on egress, not by hiding `$secret`.
- **Outbound access policy (SSRF).** Requests a process or monitor controls — the `http` node, pagination, browser navigation and its sub-requests, OpenAPI import by URL, and the monitor **http/tcp/ping checks** and **webhook/Zabbix outputs** — are limited to an allow policy, set under _Settings → Outbound access_: `platforms` (default — the origins of configured platforms and their trusted origins, plus an admin allow-list of origins, host globs or CIDRs), `allowList` (only the allow-list) or `open` (any host, for labs, with a warning). Cloud-metadata and link-local addresses (`169.254.0.0/16`, `100.100.100.200`, `fd00:ec2::254`, `fe80::/10`) and the Steward server's own API port are always blocked, and the resolved IP is pinned for the connection so a name cannot be rebound after the check. `SM_OUTBOUND_POLICY` overrides the stored policy. Admin-configured notification webhooks are not process-controlled and keep working. On-prem platforms on private IPs are reached normally — only the metadata ranges are denied, not RFC1918. A monitor that checks an internal host by raw address — e.g. a plant PowerMeter on `10.20.0.5` — needs that IP (or a CIDR such as `10.20.0.0/16`) on the allow-list; raw `host:port` checks are not inferred from platform origins, so they cannot be used to port-scan a platform host. Monitor http checks follow redirects manually and drop their custom headers on any cross-origin redirect, and a check's error message never echoes the upstream response body.
- The audit log is HMAC-chained. _Audit log → Verify chain_ detects modified, removed, inserted or re-ordered entries. Every hour, on each verification and before each export a checkpoint of the chain is **signed with the installation's Ed25519 key** and kept outside the database (log line for your SIEM, file in the data folder, optional e-mail): with it, removing entries at the end or rewriting the log is detected too, and an export can be checked offline (`npm run audit:verify-export`). Each finished run seals a fingerprint of its protocol in the chain; PDF reports are registered with their SHA-256, and only authentic entries count when a PDF or a protocol is verified.
- By default the server listens on `127.0.0.1` only. It rejects foreign `Host` headers (DNS rebinding) and can serve HTTPS (`SM_TLS_CERT` / `SM_TLS_KEY`, TLS 1.2+, forward-secret ciphers). Behind a reverse proxy set `SM_TRUST_PROXY` and an `https://` `SM_PUBLIC_URL`. Every state-changing request needs a custom header that browsers cannot send cross-site (CSRF). Pages cannot be framed; API responses are not cached.
- Dry runs, approval steps and the explorer's "I understand this changes data" confirmation guard against accidental changes. Dry runs skip steps marked _changes data_; a browser step can be set _read-only in dry runs_ so that clicks/fills are skipped while navigation and reads still run.
- Datasets published to dashboards are owned by the process that first published a key; another process cannot overwrite it or take over its dashboard visibility (an administrator deletes the dataset to reset ownership).
- Every process expression is evaluated under guard rails — a per-expression time limit (`SM_EXPR_TIMEOUT_MS`, default 5 s), a stack-depth and a sequence-size limit (`SM_EXPR_MAX_DEPTH`, `SM_EXPR_MAX_SEQUENCE`), a heap watchdog, and regular expressions that cannot backtrack catastrophically — and long evaluations yield to the event loop, so no single expression can freeze the server.
- The public REST API (`/api/v1`) is read-only and accepts only API tokens (no session cookies, no tokens in URLs). Tokens are stored as hashes, act with their owner's rights and are rate-limited. Responses are serialised from strict schemas, so credentials, secret variables, password hashes and tokens never leave the server. See [docs/API.md](docs/API.md#security-notes).
- The MCP server (`/api/mcp`, off by default) is read-only and accepts only tokens with the scope _MCP client_, which work nowhere else. Tools run with the token owner's rights, results are size-capped JSON that clients should treat as untrusted data, requests with a foreign `Origin` are refused, and every call is logged. The per-platform gateway only allows GET/HEAD operations from the platform's API specification (or allow-listed path prefixes), goes through the outbound policy, never follows redirects, masks credentials in responses and audits every call. See [docs/MCP.md](docs/MCP.md#security-model).
- Webhook triggers (`/api/hooks/…`) are the only state-changing routes without a session: they authenticate with a per-trigger secret (constant-time comparison or HMAC-SHA256 signature), accept at most 64 KB of JSON, can be limited to source CIDRs, are rate-limited and de-duplicated, and answer unknown, disabled and address-blocked triggers with the same 404. Secrets are shown once and stored encrypted.
- Running it at work: follow the checklist in [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md). Personal data and retention: [docs/PRIVACY.md](docs/PRIVACY.md).
- Reporting vulnerabilities: see [SECURITY.md](SECURITY.md). The CI security and supply-chain checks (secret scanning, dependency and container scans, SAST, SBOMs, enforced install-script allow-list, signed build provenance) are described in [docs/SECURITY-PIPELINE.md](docs/SECURITY-PIPELINE.md). Woodpecker CI pipelines for a self-hosted Forgejo mirror with Harbor and Dependency-Track: [docs/WOODPECKER.md](docs/WOODPECKER.md).

## Development

```bash
npm install
npm run dev:demo   # API with auto-reload + Vite UI on http://127.0.0.1:5173 (with mock platforms)
npm test           # end-to-end tests against the mock platforms (incl. browser + crash/resume)
npm run test:pg    # the same suite on PostgreSQL (SM_TEST_DATABASE_URL, default postgres://postgres@127.0.0.1:5432/postgres)
npm run typecheck
npm run lint       # ESLint; npm run format formats the code with Prettier
npm run test:ui    # Playwright browser tests (after npm run build), see docs/TESTING.md
```

Code layout:

```
shared/   process model (zod schemas), step metadata for the editor, API types
server/   Fastify API, SQLite (node:sqlite) or PostgreSQL (server/src/database), engine, platforms, audit, scheduler, reports, mock platforms, templates
web/      React + Mantine UI
```

Where things live:

- **Engine:** `server/src/engine/runner.ts`. Every node execution is journaled in `run_steps` (key = loop scope + node id), so a resumed run replays finished nodes from the journal instead of calling the APIs again.
- **Access control:** `server/src/auth/`.
- **Process model, conversion and validation:** `shared/src/process.ts` and `shared/src/graph.ts`.

### Ideas for next steps

- SCIM provisioning (deactivate accounts automatically when people leave).
- Import a Postman collection as a platform spec.
- See [docs/ROADMAP.md](docs/ROADMAP.md).

Public REST API: the OpenAPI document [`docs/openapi.json`](docs/openapi.json) is generated from the route schemas with `npm run openapi`; `npm run openapi -- --check` fails when it is outdated (run it in CI). Details in [docs/API.md](docs/API.md).

Contract checks against a sandbox tenant (for CI): `STEWARD_TOKEN=smt_… npm run contract -- --url http://127.0.0.1:4310 --platform <id>` calls every documented GET operation without required parameters and compares the responses with the OpenAPI spec. Pass the token via `STEWARD_TOKEN` (or `--token-file`) rather than `--token`, so it does not end up in your shell history.

The command-line tools (`npm run validate`, `npm run contract`, the desktop executable, `npm run build:exe`) all take `--help`, exit with `0` (ok), `1` (failure or findings) or `2` (usage error), and `validate`/`contract` print machine-readable results with `--json` (use `npm run --silent …` to keep npm's own header out of the output).

## Contributing

Contributions are welcome – see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions (Conventional Commits, squash merges) and checks. Changes are listed in [CHANGELOG.md](CHANGELOG.md). Security issues: [SECURITY.md](SECURITY.md).

## License

Copyright 2026 uebelacker.io. Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).

Insights Hub and Industrial Edge are products of Siemens AG. Steward is an independent project and is not affiliated with or endorsed by Siemens.
