<p align="center"><img src="docs/logo.svg" width="96" alt="Steward logo"></p>

<h1 align="center">Steward</h1>

<p align="center"><em>Repeatable, auditable service procedures for your platforms.</em><br>
Open source under the <a href="LICENSE">Apache License 2.0</a> · Made in Erlangen, Germany</p>


Steward is a local tool for running standard service and platform procedures against **Siemens Insights Hub**, **Industrial Edge Management** and any other REST platform. Examples are onboarding users, access reviews and housekeeping, attribute-consumption optimization, health checks and status tests. Each procedure becomes a repeatable, versioned process. You can run it on demand or on a schedule, a person can approve or select items where needed, and every run leaves a tamper-evident protocol.

- **Platform-agnostic.** You add platforms (base URL, credentials, OpenAPI specs, documentation). Processes refer to *connection slots*, so the same process runs against test and production tenants. A configured platform can be saved as a reusable **connector type**, exported and imported, so adding a new tool is a one-time job.
- **Flow editor (Node-RED style).** Drag nodes from a palette onto a canvas and wire them together. Node types: API call (with pagination and OpenAPI operation picker), set variables, for each, if, user task / approval, check, report, browser automation, wait, fail, comment. Outputs are labelled (true/false, each item/done, approved/rejected, error). You can also edit the YAML source directly.
- **Single sign-on.** Sign in with Microsoft Entra ID or any OpenID Connect provider (Okta, Keycloak, Google, ADFS …). Roles and teams can be assigned from Entra app roles or groups.
- **Users and access control.** Sign-in with roles (admin, designer, operator, approver, auditor, viewer) and teams. Per-process and per-platform access lists narrow who may view, run, edit, approve or manage, e.g. only the Service Desk team may use the production tenant. Decisions can be assigned to people, teams or roles, with an optional four-eyes rule.
- **Human in the loop.** A run can pause and ask you to pick items from a list, e.g. "untick the users who still need access", or to approve a change. The decision, who made it and when are all recorded.
- **Dry runs.** Read calls run, write calls (POST/PUT/PATCH/DELETE) are only recorded. You see exactly what *would* change.
- **Scheduling.** Cron schedules with time zones. Scheduled runs that need a decision wait in *My tasks*.
- **Webhook triggers.** An inbound URL with its own secret (static token or HMAC signature) starts a process with inputs mapped from the request, e.g. a [Gatus](docs/GATUS.md) alert starts a diagnosis runbook. Runs use the owner's rights; calls are rate-limited, de-duplicated and audited.
- **Monitors.** Composable, dependency-aware health checks: ping, TCP, HTTP, platform API calls, data freshness in Insights Hub (cadence or maximum age), Gatus endpoints, sub-monitors and **heartbeats pushed by an IoT gateway** (one call per check or one batch call). Links between checks name the root cause and keep follow-up alerts quiet, without making one check depend on another. Status goes to notifications, runbooks, webhooks, Gatus, **Zabbix** (trapper protocol or `history.push`), Prometheus, dashboards and the public API (incl. Zabbix low-level discovery). Templates with CSV import for many machines, maintenance windows, a status wall. See [docs/MONITORS.md](docs/MONITORS.md).
- **Auditability.** There is a hash-chained, HMAC-signed audit log and a per-run protocol (HTML/JSON) with inputs, every request, decisions, checks, reports and screenshots. Each protocol has a sealed fingerprint, so later changes are detected.
- **PDF reports for the archive.** Branded PDF/A-2b reports of finished runs (what was done, when, results, decisions, comments) and periodic summaries, ready to be archived and signed later. Every PDF is stored unchanged and its SHA-256 is recorded in the audit log. See [PDF reports](#pdf-reports).
- **Dashboards.** Flows publish datasets: a snapshot of rows with a status per row, plus metric history. Dashboards show them as KPI tiles, trends, status distributions and tables, with no live API calls when someone opens a dashboard.
- **Example library.** [`examples/`](examples/README.md) contains service-management and housekeeping procedures for Insights Hub and Industrial Edge, plus dashboards, all importable.
- **Sub-processes and parallel loops.** A *Run sub-process* node calls another process as a reusable building block (inputs in, outputs back, linked child runs). *For each* can process items in parallel. Platform calls retry on 429/5xx with backoff and honour `Retry-After`.
- **Editor help.** Expression autocomplete with a live preview using the data of the last run, a *Last run* inspector per node, undo/redo, copy/paste between processes, and a YAML diff between versions.
- **Notifications.** In-app notification centre, plus e-mail (SMTP), Microsoft Teams and generic webhooks for decisions waiting, failed runs and checks, stale dashboard data and skipped schedules. Optional browser notifications.
- **Automation API.** Personal API tokens (read-only or full) for scripts and CI.
- **Public REST API.** A versioned, read-only API under `/api/v1` with an OpenAPI 3.1 description and an optional Swagger UI (`/api/docs/`): processes and versions, runs with steps, logs, decisions and checks, tasks, schedules, platform metadata (never credentials), dashboard datasets, the audit log, users and teams. Token-only, rate-limited, cursor pagination, RFC 9457 errors. E.g. `curl -H "Authorization: Bearer smt_…" http://127.0.0.1:4310/api/v1/runs`. See [docs/API.md](docs/API.md).
- **Observability.** Structured JSON logs, optional OpenTelemetry tracing, Prometheus metrics (`/api/metrics`), readiness probe (`/api/ready`).
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

   All of them have the password `Demo-password-1`. Olivia and Adam are in the team *Service Desk*.
3. Open **Processes → "Insights Hub – Access review 1"** and click *Run*. Keep *Dry run* on the first time.

## Ways to run it

- **Desktop executable:** download, double-click; it opens as an app window. `npm run build && npm run build:exe` builds it yourself.
- **Installed web app:** in Edge/Chrome choose *Install* (or *Install app* in the user menu).
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

| Variable | Default | Purpose |
| --- | --- | --- |
| `SM_PORT` | `4310` | HTTP port |
| `SM_HOST` | `127.0.0.1` | Bind address. Keep it local unless you know what you are doing. |
| `SM_DATA_DIR` | `./data` | Data directory |
| `SM_DATABASE_URL` | – (SQLite in the data directory) | Use PostgreSQL: `postgres://user:password@host:5432/database`. Not available in the desktop executable. See [Database](docs/INSTALL.md#5-database-sqlite-or-postgresql). |
| `SM_DATABASE_SCHEMA` | `public` | PostgreSQL schema (created if missing) |
| `SM_DATABASE_CA` | – | CA certificate (PEM file) for verifying the PostgreSQL server's TLS certificate |
| `SM_MASTER_PASSPHRASE` | – | Unlock automatically at start-up, so schedules run after a reboot. |
| `SM_ALLOWED_HOSTS` | – | Extra allowed `Host` headers (comma-separated), e.g. the machine's DNS name when colleagues use it |
| `SM_TLS_CERT` / `SM_TLS_KEY` | – | Paths to a certificate and key. Serves HTTPS, which is recommended when others connect over the network. |
| `SM_PUBLIC_URL` | – | External URL (e.g. `https://steward.corp.example`) when running behind a reverse proxy. It is used for the single sign-on redirect URI. |
| `SM_CHROMIUM_PATH` | – | Use a specific Chromium/Chrome binary for browser steps |
| `HTTPS_PROXY` / `NO_PROXY` | – | Corporate proxy, used for platform calls unless a platform overrides it |
| `SM_DEMO` | – | `1` mounts the mock platforms under `/mock` |
| `SM_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. Logs are JSON lines on stdout. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | Turns on OpenTelemetry tracing (OTLP/HTTP). Standard `OTEL_*` variables apply, e.g. `OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_HEADERS`. |
| `SM_OTEL_PROPAGATE` | `1` | `0` stops adding `traceparent` headers to platform calls |
| `SM_SENTRY_DSN` | – | Report unexpected errors to Sentry, GlitchTip or Bugsink (off by default; scrubbed, no personal data). More variables and exactly what is sent: [docs/ERROR-REPORTING.md](docs/ERROR-REPORTING.md) |
| `SM_METRIC_RETENTION_DAYS` | `400` | How long dashboard metric history is kept |
| `SM_METRICS_PUBLIC` | – | `1` serves `/api/metrics` without sign-in (otherwise admins, auditors or an API token) |
| `SM_API_V1` | `on` | `off` turns the public REST API (`/api/v1`) and its documentation off |
| `SM_API_DOCS` | – | Who may open the API documentation (`/api/docs/`, `openapi.json` without a token): `off`, `authenticated` (signed-in users, the default) or `public`. Overrides the setting under **Settings → REST API**. |
| `SM_API_RATE_LIMIT` | `600` | Requests per minute and API token on `/api/v1`; `0` = unlimited |

Retention of runs and notifications, and the notification channels, are set under **Settings**.

## Concepts

| | |
| --- | --- |
| **Platform** | One instance of a system: an Insights Hub tenant, an IEM, any REST API. It holds the base URL, authentication, non-secret variables (tenant, region, API paths), encrypted credentials, OpenAPI specs (searchable operations, used by the editor and the API explorer; import by file, paste or URL) and docs (notes, links, files). |
| **Connector type** | A reusable template for a kind of platform: auth, variables, HTTP options, credential field names, doc links and API specs, but never credential values. Create one from a configured platform with *Save as connector type*. Export it as JSON to share, import it elsewhere, and new platforms created from it get the specs automatically. |
| **Process** | A versioned flow of nodes and wires. It declares connection slots (e.g. `hub`, kind `insights-hub`), inputs (number, text, list, CSV table, …) and constants (e.g. group bundles). Every save creates a new version with author, comment and hash. |
| **Run** | One execution of a pinned process version, manual or scheduled, real or dry. It has a full step journal, logs, decisions, checks, reports and evidence. |
| **Task** | A decision a run is waiting for: select items or approve/reject. Tasks are listed in **My tasks** and on the run page. |
| **Schedule** | Cron plus time zone, with preset inputs and connections. It skips a new run while the previous one is still waiting, unless overlap is allowed. |
| **Webhook trigger** | `POST /api/hooks/<id>` with a secret starts a process as the trigger's owner; inputs are mapped from the JSON body, allow-listed headers and the query with JSONata. See [docs/GATUS.md](docs/GATUS.md#webhook-trigger-reference). |
| **Monitor** | A graph of checks (ping, TCP, HTTP, platform API, data freshness, heartbeat, Gatus, sub-monitor) with soft or hard links. Every check runs on its own interval; links explain failures (root cause) and suppress follow-up alerts. See [docs/MONITORS.md](docs/MONITORS.md). |
| **Audit log** | Everything that changed anything, attributed to the signed-in user: sign-ins, user/role/access changes, platform/credential changes, process versions, runs, every write call, skipped (dry-run) writes, decisions, failed checks, screenshots, exports. |

## Users, roles and access

| Role | Default rights |
| --- | --- |
| admin | Everything: users and teams, platforms and credentials, settings, all processes, unlocking the vault. |
| designer | Create processes. Edit and run all processes unless an access list says otherwise. |
| operator | Run and schedule processes. |
| approver | Decide approvals and user tasks. |
| auditor | Read-only access to everything, including the audit log and all protocols. |
| viewer | Read processes and their runs. |

- **Process access list.** Rights are `view`, `run` (start, schedule, make selection decisions), `edit`, `approve` and `manage` (change access, archive). An empty list means the role defaults apply. As soon as entries exist, only the listed `user:…`, `team:…` or `role:…` subjects get the listed rights. Admins and the process owner (its creator) always keep full rights.
- **Platform access list.** Rights are `use` (bind it in runs; read-only explorer calls) and `manage` (configuration, credentials, access, write calls in the explorer). Use this to restrict e.g. the production tenant to one team.
- **Decisions.** A user task can name `assignees` (users, teams, roles). Otherwise everyone with `run` or `approve` on the process may decide. With `fourEyes: true`, the person who started the run may not decide.
- **Schedules.** A schedule runs with the rights of its owner (the person who created it). If the owner loses the rights or is deactivated, the run is skipped and recorded in the audit log.
- **Webhook triggers** follow the same rules as schedules: creating one needs run rights on the process, runs use the owner's rights (checked on every call), and the owner, an admin or a process manager can change it.
- New accounts get a temporary password and must change it at first sign-in. Passwords are hashed with scrypt. Five failed sign-ins lock the account for five minutes.

### Single sign-on (Microsoft Entra ID / OpenID Connect)

Sign-in uses the OpenID Connect authorization code flow with PKCE, through the [openid-client](https://github.com/panva/openid-client) library. Tokens are checked for issuer, audience, signature (JWKS), expiry, nonce and state. The client secret is stored encrypted with the master passphrase.

**Set it up in Microsoft Entra ID:**

1. **Register the app.** In the Entra admin center go to *App registrations → New registration*. Name it e.g. "Steward" and choose single tenant.
2. **Add the redirect URI.** Platform *Web*. Copy the exact value from **Users & teams → Single sign-on**; it looks like `https://<your host>/api/auth/oidc/callback`. For purely local use, `http://localhost:4310/api/auth/oidc/callback` works, because Entra only allows plain http for `localhost`. In that case open the tool via `http://localhost:4310`.
3. **Create a client secret.** Under *Certificates & secrets*, create a new client secret and copy its value.
4. **Define app roles.** Under *App roles*, create e.g. `SM.Admins`, `SM.Designers`, `SM.Operators`, `SM.Approvers`, `SM.Auditors`, `SM.Viewers`, with member types *Users/Groups*.
5. **Assign people.** Under *Enterprise applications → Steward → Users and groups*, assign users or groups to these roles. Optionally set *Assignment required = Yes* so that only assigned people can sign in at all.
6. **Add the provider in Steward.** Go to **Users & teams → Single sign-on → Add provider → Microsoft Entra ID**. Enter the tenant ID, client ID and secret, then click *Test discovery*.
7. **Map the role values.** Map each app role to Steward roles and teams (claim `roles`). Alternatively let Entra emit the `groups` claim and map group object IDs; tokens carry at most 200 groups, so app roles are the better choice.

**How accounts are handled:**

- **Auto-provision.** New users get an account on their first sign-in.
- **Role sync.** Roles, and the teams named in the mappings, are updated from the token at every sign-in.
- **Mapping required.** Users without a mapped role are rejected.
- **Pre-created accounts.** An account with the same user name (e.g. the UPN) is linked on its first SSO sign-in.
- **No passwords.** SSO accounts have no password in Steward.
- **SSO only.** Under **Settings → Sign-in**, password sign-in can be limited to administrators. Local admin accounts stay as break-glass access, e.g. to unlock the vault after a restart.

Any other OIDC provider works the same way with the *Generic OIDC* preset: issuer URL, client ID and secret (or a public client with PKCE), and claim names. In demo mode a simulated Entra ID is preconfigured. Its accounts (Max Admin, Erik Engineer, Oskar Operator, Sofia Approver, Nina Nobody) show the mappings in action.

### Using it as a team

It still runs locally. Make it reachable on your network:

1. Set `SM_HOST=0.0.0.0` and `SM_ALLOWED_HOSTS=<machine name>`.
2. Provide a certificate with `SM_TLS_CERT` / `SM_TLS_KEY`, or run it behind your reverse proxy.
3. Create accounts under **Users & teams**.

One person (an admin) unlocks the vault after a restart, or you set `SM_MASTER_PASSPHRASE` for unattended start-up.

### Supported authentication

`none`, `basic`, `bearer`, `apiKey` (header or query), `oauth2_client_credentials` (e.g. Insights Hub service credentials), and `token_request`. `token_request` is a configurable login call whose response contains a token, e.g. the IEM `/portal/api/v1/login/direct` or the Insights Hub Technical Token Manager. Per platform you can also set a proxy, a custom CA, *accept self-signed certificates* (common for on-prem IEM), a timeout and default headers.

## Dashboards

1. **Publish data from a flow.** Add a **Publish to dashboard** node. Give it a dataset key such as `iem.devices`, the rows (an expression), optionally compact `columns`, a `status` expression per row (good / warning / serious / critical / unknown), a reason text, and `metrics` (numbers kept as history).
2. **What a run stores.** Every run replaces the dataset snapshot and appends the metrics.
3. **Keep it fresh.** Schedule the publishing flow, e.g. hourly inventories or a health check every 15 minutes. `staleAfterMinutes` marks old data on the dashboards.
4. **Build the dashboard.** *Dashboards → New / From template / Import YAML*. Widget types:
   - `kpi`: value, change and sparkline;
   - `trend`: up to three metrics;
   - `status`: distribution of row statuses;
   - `table`: rows with status, search and a problems-only filter;
   - `checks`: the latest checks of a process;
   - `freshness`;
   - `markdown`.
5. **Refresh.** *Refresh data* re-runs the feeding processes with the inputs of their last run, provided you have run rights.

Who can see what: a dataset is visible to everyone who may view the process that publishes it.

## Bundled templates

| Template | What it does |
| --- | --- |
| Insights Hub – Access review 1: flag inactive users | Lists users and finds those inactive for N days, with an exempt list. You confirm the selection, then they are added to a review group. |
| Insights Hub – Access review 2: decide and clean up | Lists the review group. You tick who still needs access (recently active users are preselected). Kept users are un-flagged; for the rest, after a final approval, all memberships are removed or the user is deleted. |
| Insights Hub – Onboard users with group bundles | Takes a CSV of users and a *bundle* per user (e.g. Operator → StandardUser + Operators group). It checks that all groups exist, asks for approval, creates missing users and adds only the missing memberships. |
| Insights Hub – Asset attribute optimization check | Counts attributes per asset type, samples the latest time-series records and reports variables that never get data, assets without data and stale aspects, with the potential attribute savings. |
| Insights Hub – Platform health check | Calls the core services and records pass/fail checks with latency limits. |
| Industrial Edge – Device status check | Flags devices that are not online and reports a device overview. |
| Browser – Portal login and status screenshot | Signs in to a portal, reads a status text, checks it and stores a screenshot as evidence. |
| Generic – Endpoint availability check | Calls a list of endpoints and records one check per endpoint. |

Templates are YAML files in [`examples/processes/`](examples/README.md); example dashboards are in `examples/dashboards/`. Adding a file there makes it available in *From template*. The examples README lists the whole library, including privileged-access review, offboarding, group hygiene, inventories, data freshness, firmware and app compliance, stale device clean-up and a weekly service report. Check files with `npm run validate`, which runs in CI too.

**Gatus.** Steward works alongside the [Gatus](https://github.com/TwiN/gatus) uptime monitor instead of re-implementing monitoring: Gatus monitors Steward's `/api/health` and `/api/ready`, Steward shows the Gatus endpoint status on the *Uptime* dashboard, pushes its own check results to Gatus external endpoints, and a Gatus alert can start a runbook through a webhook trigger. Configuration snippets and security notes: [docs/GATUS.md](docs/GATUS.md).

For the bigger picture (standards, UX ideas, Kestra/Temporal, observability, roadmap) see [`docs/ROADMAP.md`](docs/ROADMAP.md).

### Notes on the Siemens APIs (please verify on your tenant)

- **Domain migration.** Insights Hub is moving from `gateway.{region}.mindsphere.io` (`/api/{service}/v3`) to the Xcelerator gateway `api.{region}.siemens.app` with tenant-specific paths (`/api/identitymanagement-{coreTenantId}/v3`). The templates therefore read their API paths from platform variables (`idmPath`, `assetPath`, `tsPath`) and fall back to the classic paths. Set these variables on the platform when you move.
- **Last login.** The Identity Management user list returns `resources` (lowercase), `totalResults` and paging via `startIndex`/`count`. The last-login attribute `lastLogonTime` is used by Siemens' own `mdsp` CLI but is **not part of the official spec**. Do a dry run of *Access review 1* first and check the *List all users* step output.
- **Asset attributes.** These are billed per asset: the asset type's variables plus the variables of its aspects. The optimization template estimates potential from sampled latest values. Cross-check with the Asset Manager attribute calculator before changing models.
- **IEM device fields.** Field names for connection state differ between IEM versions, so the device template takes the field name and the "online" value as inputs. Use the platform's **API explorer** to look at a real response.
- Import the official OpenAPI specs from the Siemens developer portal into each platform. The editor's *Pick from API spec* and the explorer then list all operations.

## PDF reports

Steward creates PDF reports without a browser, also in the desktop executable.

- **Run report.** On a run page, open *PDF reports → Generate PDF report* (or *Protocol → Generate PDF report…*). Choose English or German and add a reviewer comment if you like. The report contains:
  - a summary: process, version and definition hash, who started the run, when and how, the time zone, the status and a prominent *dry run* banner;
  - the platforms used (names and kinds only, never credentials) and the inputs;
  - every step in order, the write operations (simulated ones are marked), decisions and approvals (who, when, selection, comment, four-eyes rule), checks, the process's own report sections, evidence with thumbnails and errors;
  - the reviewer comment, an integrity section with the sealed protocol hash and the run's audit trail, and a sign-off block (*Prepared / Reviewed / Approved by*) with empty digital signature fields.
- **Interim reports.** Runs that wait for a decision can be reported too. These reports are marked *interim*.
- **Summary report.** *Runs → Summary report* lists all runs of one or more processes in a period, e.g. "Access reviews Q3", with totals.
- **Automatic reports.** In the process editor, *Settings → PDF report* (YAML: `report: { auto: true, lang: de }`) generates the report whenever a run finishes, e.g. for scheduled reviews.
- **Branding.** *Settings → Report branding* (administrators) sets the company name, logo (PNG/JPEG, max. 1 MB; default: the Steward logo), accent colour, default classification (e.g. *Internal*) and a footer note, with a sample preview.

**Archiving and signing.** The files are PDF/A-2b with embedded fonts and metadata (run ID, process, protocol hash, content hash), validated with veraPDF (PDF/A-2b). They are written once to `data/reports/<run>/<report>.pdf` and never overwritten; generating again creates a new version. Each generation is recorded as `report.generated` with the file's SHA-256 in the audit log, and data retention removes a run's reports together with the run. The signature fields can be signed later in Adobe Acrobat or another PDF signing tool.

**Verifying a copy.** *Audit log → Verify PDF report* (or `POST /api/reports/verify`) checks a file against the audit log. It also recognizes signed copies: a signature is appended as an incremental update, so the first bytes of a signed copy are still the original report.

API: `POST /api/runs/:id/reports` `{ lang, comment, classification, timeZone }`, `GET /api/runs/:id/reports`, `GET /api/reports/:id/download`, `POST /api/reports/summary` `{ processIds, from, to, lang, comment, title }`. `GET /api/runs/:id/report.pdf?lang=de` generates, stores and returns a report in one step. Generating and downloading needs view rights on the process; branding needs the *settings* capability.

## Writing processes

Processes are built on the canvas or as YAML (*Source* tab, or *Import YAML*).

**How a flow runs.** Execution starts at the *Start* node and follows the wires, depth first. When an output has several wires, the targets run one after another, top to bottom as placed on the canvas.

- **Outputs.** A node fires one of its outputs:
  - *if* fires `true` or `false`.
  - *for each* runs everything wired to `each item` once per item, then continues on `done`. Leave the last node of the loop body unconnected.
  - An approval fires `approved` or `rejected`. If `rejected` is not connected, a rejection fails the run.
  - API call and browser nodes fire `error` instead of failing the run if that output is connected.
- **Joins and cycles.** A node reached from both branches of an *if* runs once. Wires may not form cycles; use *for each* for repetition.
- **Skipped nodes.** A node whose *Only run when* condition is false is skipped and passes the flow on.
- **Restarts.** Every executed node is journaled, so runs survive restarts.

Stored processes use `nodes` and `wires`:

```yaml
nodes:
  - { id: start, type: start, x: 0, y: 0 }
  - { id: check, type: if, condition: "inputs.days > 30", x: 250, y: 0 }
  - { id: warn, type: log, level: warn, message: "long period", x: 500, y: -60 }
wires:
  - { from: start, port: out, to: check }
  - { from: check, port: "true", to: warn }
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
      inactive: "{{ vars.users.body[$daysSince(lastLogonTime) > $inputs.days][] }}"
  - id: pick
    type: userTask
    mode: select
    title: "Remove {{ $count(vars.inactive) }} users from group X?"
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
        path: "/api/identitymanagement/v3/Groups/<groupId>/members/{{ vars.user.id }}"
```

### Expressions and templates

- Expressions use **[JSONata](https://jsonata.org)**. Fields such as *condition*, *items* or *rows* take an expression. Text fields accept templates of the form `{{ expression }}`. A field that contains only `{{ … }}` keeps the value's type (list, object, number).
- In scope: `inputs.*`, `vars.*` (step results, `saveAs`), `const.*` (process constants), `run.*` (`id`, `dryRun`, `actor`), and `conn.<slot>.*` (`name`, `baseUrl`, `vars`).
- Inside filters `[...]` a plain name refers to the current item. Use `$inputs`, `$vars` and `$const` there instead.
- Extra functions:
  - `$daysSince(ts)`
  - `$daysAgo(n)`
  - `$ts(ts)`
  - `$uuid()`
  - `$pvar(slot, name, default)` reads a platform variable.
  - `$secret(slot, key)` reads a credential for use in a request to *its own platform* (e.g. a custom auth header or a portal login). The value is redacted everywhere in logs (including base64/URL-encoded forms) and may only be sent to the platform's allowed origins — a step that would send it elsewhere fails. See the security model below.
- Append `[]` to force a list, e.g. `vars.users.body[active][]`.
- Per-item fields (task columns, preselect, report columns) are evaluated against the item, which is also available as `$item`.

### Node types

| Type | Outputs | Use |
| --- | --- | --- |
| `start` | out | Entry point (exactly one). |
| `http` | out, error | API call on a connection. `query`, `headers` and `body` are templated. `expectStatus` sets the accepted status codes. `paginate` modes: `scim` (startIndex/count), `page` (page/size + `page.totalPages`), `offset`, `nextLink`. The result is `{status, headers, body, durationMs}`; with pagination, `body` is the concatenated item list. Writes are skipped in dry runs. *Pick from API spec* fills method, path, parameters and an example body from the platform's OpenAPI spec. |
| `set` | out | Compute variables (evaluated in order). |
| `forEach` | each item, done | Loop over a list (`as` names the item variable, `<as>Index` holds the index). Supports `delayMs` and a `maxItems` safety limit. |
| `if` | true, false | Branch on a condition. |
| `userTask` | out / approved, rejected | `select` lets someone pick items; the result has `selected`, `unselected`, `comment`, `decidedBy`. `approve` asks for approval. Optional `assignees` and `fourEyes`. |
| `check` | out | Pass/fail with a severity. Shown on the dashboard and in the protocol. `failRun` stops the run. |
| `report` | out | Text (markdown subset) and/or a table section in the protocol. |
| `browser` | out, error | Playwright actions: `goto`, `click`, `fill`, `press`, `select`, `check`, `waitFor`, `expectText`, `extract`, `screenshot`, `wait`, `evaluate`. The session is shared across browser nodes of a run, and a failure screenshot is captured automatically. Mark it `mutating` so it is skipped in dry runs. |
| `wait`, `log` | out | Self-explanatory. |
| `fail` | – | Stops the run with a message. |
| `note` | – | Comment on the canvas, not executed. |

Common options for all nodes:

- `when` (condition)
- `saveAs`
- `onError: continue`
- `retry: { attempts, delayMs }`

Tip: `npx playwright codegen https://your-portal` records clicks and gives you selectors.

## Security model

- Everyone signs in. Sessions are HttpOnly, SameSite=Strict cookies (12 h idle timeout). Every API call is checked against roles and access lists on the server.
- Credentials are encrypted at rest (AES-256-GCM). The key is derived with scrypt from your master passphrase and only kept in memory. The API never returns secret values, and they are redacted from logs, protocols and audit entries.
- Platform credentials only go to the platform: the auth header, API keys and default headers are attached when a request targets the origin of the platform's base URL (or an origin listed under *Trusted origins*). An API call with an absolute URL to any other host is sent without them. Redirects are followed manually (max 5 hops): credentials — including custom-named API-key headers and any header that carries a secret value — are dropped the moment a hop leaves the allowed origins, and an `https → http` downgrade that would carry credentials is refused.
- Secrets stay inside the platform they belong to. `$secret(slot, key)` is available to process authors with `use` (it is needed for legitimate custom auth, e.g. a per-endpoint token or a portal login), but a resolved secret value may only leave Steward towards that platform's own allowed origins. Before every process-controlled request the URL, headers and body are scanned for any bound platform's secret value (also base64- and URL-encoded), and the step fails if a secret would reach an origin the platform does not allow. Secrets are also masked in their encoded forms in logs and protocols. This is why `use` does not require `manage`: the confidentiality boundary is enforced on egress, not by hiding `$secret`.
- **Outbound access policy (SSRF).** Requests a process or monitor controls — the `http` node, pagination, browser navigation and its sub-requests, OpenAPI import by URL, and the monitor **http/tcp/ping checks** and **webhook/Zabbix outputs** — are limited to an allow policy, set under *Settings → Outbound access*: `platforms` (default — the origins of configured platforms and their trusted origins, plus an admin allow-list of origins, host globs or CIDRs), `allowList` (only the allow-list) or `open` (any host, for labs, with a warning). Cloud-metadata and link-local addresses (`169.254.0.0/16`, `100.100.100.200`, `fd00:ec2::254`, `fe80::/10`) and the Steward server's own API port are always blocked, and the resolved IP is pinned for the connection so a name cannot be rebound after the check. `SM_OUTBOUND_POLICY` overrides the stored policy. Admin-configured notification webhooks are not process-controlled and keep working. On-prem platforms on private IPs are reached normally — only the metadata ranges are denied, not RFC1918. A monitor that checks an internal host by raw address — e.g. a plant PowerMeter on `10.20.0.5` — needs that IP (or a CIDR such as `10.20.0.0/16`) on the allow-list; raw `host:port` checks are not inferred from platform origins, so they cannot be used to port-scan a platform host. Monitor http checks follow redirects manually and drop their custom headers on any cross-origin redirect, and a check's error message never echoes the upstream response body.
- Datasets published to dashboards are owned by the process that first published a key; another process cannot overwrite it or take over its dashboard visibility (an administrator deletes the dataset to reset ownership).
- The audit log is HMAC-chained with a key derived from the master key. *Audit log → Verify chain* detects modified, removed or re-ordered entries. Each finished run stores a fingerprint of its protocol in the chain, and the protocol shows whether it is still intact.
- By default the server listens on `127.0.0.1` only. It rejects foreign `Host` headers (DNS rebinding) and can serve HTTPS (`SM_TLS_CERT` / `SM_TLS_KEY`). Every state-changing request needs a custom header that browsers cannot send cross-site (CSRF). Pages cannot be framed.
- Dry runs, approval steps and the explorer's "I understand this changes data" confirmation guard against accidental changes. Dry runs skip steps marked *changes data*; a browser step can be set *read-only in dry runs* so that clicks/fills are skipped while navigation and reads still run.
- Every process expression is evaluated under guard rails — a per-expression time limit (`SM_EXPR_TIMEOUT_MS`, default 5 s), a stack-depth and a sequence-size limit (`SM_EXPR_MAX_DEPTH`, `SM_EXPR_MAX_SEQUENCE`), a heap watchdog, and regular expressions that cannot backtrack catastrophically — and long evaluations yield to the event loop, so no single expression can freeze the server.
- The public REST API (`/api/v1`) is read-only and accepts only API tokens (no session cookies, no tokens in URLs). Tokens are stored as hashes, act with their owner's rights and are rate-limited. Responses are serialised from strict schemas, so credentials, secret variables, password hashes and tokens never leave the server. See [docs/API.md](docs/API.md#security-notes).
- Webhook triggers (`/api/hooks/…`) are the only state-changing routes without a session: they authenticate with a per-trigger secret (constant-time comparison or HMAC-SHA256 signature), accept at most 64 KB of JSON, can be limited to source CIDRs, are rate-limited and de-duplicated, and answer unknown, disabled and address-blocked triggers with the same 404. Secrets are shown once and stored encrypted.
- Reporting vulnerabilities: see [SECURITY.md](SECURITY.md). The CI security and supply-chain checks (secret scanning, dependency and container scans, SAST, SBOMs) are described in [docs/SECURITY-PIPELINE.md](docs/SECURITY-PIPELINE.md).

## Development

```bash
npm install
npm run dev:demo   # API with auto-reload + Vite UI on http://127.0.0.1:5173 (with mock platforms)
npm test           # end-to-end tests against the mock platforms (incl. browser + crash/resume)
npm run test:pg    # the same suite on PostgreSQL (SM_TEST_DATABASE_URL, default postgres://postgres@127.0.0.1:5432/postgres)
npm run typecheck
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
