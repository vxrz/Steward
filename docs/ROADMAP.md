# Roadmap

Where Steward stands, what it deliberately does not do, and what comes next. Shipped changes are in the [CHANGELOG](../CHANGELOG.md); how it is built is in [ARCHITECTURE.md](ARCHITECTURE.md). Ideas and requests are collected as GitHub issues.

_Last reviewed for 0.8.0 (November 2026)._

## What Steward is for

Steward runs **repeatable, auditable service procedures** for the platforms a service team operates – Siemens Insights Hub, Industrial Edge and any REST API – and keeps the **evidence**: who decided, what was read, what was changed, and that nothing was changed behind the log. Around the procedures it keeps what a service team needs to run them well: a service catalogue, monitors, availability objectives, documents and ticket references, dashboards and reports. It is self-hosted, runs as one process, and works from a laptop (desktop app) up to a shared team server (container, PostgreSQL, single sign-on).

Guiding principles:

1. **Read, decide, write, verify, report.** Every change goes through a dry run and a human decision before it writes; the run re-reads what it changed and leaves a protocol.
2. **Evidence by default.** Every change of state is in the tamper-evident audit log ([ADR 0003](adr/0003-hmac-chained-audit-log.md)); protocols, reports and evidence packs can be verified outside Steward.
3. **People stay in charge.** Automation – schedules, webhooks, AI assistants – proposes and prepares; people approve writes (four-eyes where it matters).
4. **Small footprint.** One process, one database, no cluster; integrations through open standards (OIDC, OpenAPI, OpenTelemetry, Prometheus, MCP, RFC 9457).

## Where it stands (0.8)

| Area                | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Procedures          | Versioned graph flows with dry runs, approvals and selections, four-eyes, manual steps, browser steps, sub-process runs; durable runs that resume after a restart without repeating finished steps; schedules and webhook triggers with one notification policy.                                                                                                                                                                                                                              |
| Platforms           | Any REST API with OpenAPI import, connector types, recorded responses, contract checks; key-pair JWT and AWS request signing; Kubernetes, Prometheus, CheckMk, Git hosts, Kafka, MQTT, Snowflake, AWS, Dependency-Track, Gatus.                                                                                                                                                                                                                                                               |
| Databases           | **PostgreSQL, MariaDB/MySQL and SQL Server** (0.7.0), read-only in three layers (read-only account, read-only session, statement check): a query step, catalog queries for access reviews and account hygiene, a monitor check, datasets; since 0.8.0 **database schemas**: snapshots, breaking changes, a tbls import pushed from CI, DBML and SQL DDL export.                                                                                                                               |
| Service catalogue   | Applications, systems, environments, components and tech stack with end-of-life data, CIA rating and protection needs, credentials register, service duties, documents and records with typed links, ticket references (ServiceNow, vendor tickets).                                                                                                                                                                                                                                          |
| Operations          | Monitor graphs with root-cause links, **maintenance windows** (0.2.5), **incident reviews** (0.2.5), availability objectives and the service scorecard, **service status pages** (0.2.10), notifications by e-mail, Teams and webhooks, daily summaries.                                                                                                                                                                                                                                      |
| Compliance          | Control catalogues (including a company's own, proposed by an AI assistant and reviewed by people), mappings, coverage, person access reviews, evidence packs that verify offline.                                                                                                                                                                                                                                                                                                            |
| Access              | Local accounts and OIDC / Entra ID single sign-on with claim mapping, SSO-only mode with emergency access, step-up re-authentication, roles, **owning teams** with team settings (0.3.0), access lists, API tokens.                                                                                                                                                                                                                                                                           |
| Evidence            | HMAC-chained audit log with signed checkpoints and external anchors, run protocols with a sealed fingerprint, PDF/A reports drawn in a worker thread, evidence packs.                                                                                                                                                                                                                                                                                                                         |
| Data and dashboards | Datasets published by procedures, metric history with trends and forecasts, dashboards with KPI, trend, status, table and Vega-Lite widgets, the public REST API `/api/v1` for BI tools.                                                                                                                                                                                                                                                                                                      |
| AI assistants       | An MCP server with a platform gateway, approved write requests (0.2.10) and OAuth 2.1 sign-in for MCP clients (0.3.0).                                                                                                                                                                                                                                                                                                                                                                        |
| AI models           | **LLM gateways** (0.6.0) in four request formats, the process step _Ask an AI model_ with per-call limits, token budgets per day and month, a usage log and the _AI usage_ dataset; answers are marked as AI-generated.                                                                                                                                                                                                                                                                       |
| Plant registry      | Opt-in module (0.6.0, preview): sites with their ISA-95 hierarchy and buildings, assets, links to systems and applications, YAML import and export with a JSON Schema; since 0.7.0 device profiles with data points, KPI definitions, KPI instances and their checks; since 0.8.0 the **OT network** (VLANs, IEC 62443-3-2 zones and conduits, devices, data paths, live status from linked checks) and **visualizations** of structure, data flow, lineage, KPI coverage and the OT network. |
| Running it          | Desktop executable, installable PWA, signed container image, SQLite or PostgreSQL, backups (local and S3), moving an instance with a migration package, upgrade tests from every release, OpenTelemetry traces, Prometheus metrics, optional Sentry-compatible errors.                                                                                                                                                                                                                        |

## Non-goals

Steward stays a tool for procedures and their evidence. These are **out of scope** – not "later", but deliberately left to tools that do them well:

- **No on-call or paging.** Steward notifies (e-mail, Teams, webhooks) and links to the run or monitor; rotations, escalation and acknowledgement belong to PagerDuty, Opsgenie or your ITSM tool, which a webhook can feed.
- **No CMDB or discovery.** The service catalogue and the plant registry describe what a team runs, maintained by people, procedures and imports; they do not scan networks or reconcile configuration items. Read your CMDB with a procedure if you need its data.
- **No metrics stack or time-series database.** Monitors check, datasets keep the history a procedure publishes; long-term metrics, PromQL and alerting rules stay in Prometheus, Grafana and friends (Steward reads them and exposes its own `/api/metrics`).
- **No secret storage or rotation for others.** The vault protects the credentials Steward itself needs ([ADR 0004](adr/0004-vault-with-master-passphrase.md)); it is not a secret manager for other applications and does not rotate platform credentials on its own. The credentials register documents where secrets live and when they expire.
- **No full GRC suite.** Control catalogues, mappings, coverage and evidence packs support audits of what Steward runs; risk registers, policy management, vendor questionnaires and audit planning stay in a GRC tool.
- **No AI changes without human approval.** AI assistants may read, propose and prepare (MCP); every write they request is confirmed by a person, and proposals (such as a control catalogue) are reviewed before anything applies. There is no autonomous agent mode.
- **No incident management or ticketing.** Incident reviews document what happened to a service; tickets stay in ServiceNow or the vendor's tool and are referenced, not managed.
- **No horizontal scaling of one installation.** One active process per database ([ADR 0002](adr/0002-single-active-instance-with-lease-lock.md)); several teams share an installation through owning teams.
- **No configuration drift detection against baselines.** Change records document requested changes; they do not describe the allowed state of a platform.
- **No FinOps suite.** Platform costs (#226) are showback for what a team runs; invoices, chargeback between departments and commitment or rightsizing optimisation stay in a FinOps tool.

## 0.4.0 – robust to run, easy to start

Themes of this release (details in the CHANGELOG once released):

- **Robust runtime.** One active instance held by a lease lock, background jobs with a clear lifecycle, a clean shutdown.
- **Build and configuration.** The server is compiled for production (no TypeScript loader in the image); every environment variable is validated at start-up and documented from the schema ([CONFIGURATION.md](CONFIGURATION.md)); the internal API answers problem details like `/api/v1`; dropped errors say why or are logged.
- **Audit log and datasets.** Easier to search, export and verify the audit log; datasets that are easier to find and keep fresh.
- **Navigation.** Consistent page templates, a better command palette and the same actions (such as _Duplicate_) wherever they make sense.
- **Getting started.** Onboarding for a new installation, ready-made bundles of procedures, dashboards and monitors, simpler set-up of the integrations.
- **Architecture documentation.** [ARCHITECTURE.md](ARCHITECTURE.md) with C4 diagrams and [decision records](adr/README.md).

## Shipped since 0.4.0

- **0.5.0:** audit-proof firewall changes ([#208](https://github.com/vxrz/Steward/issues/208)), Microsoft Graph / Entra ID ([#202](https://github.com/vxrz/Steward/issues/202)), the Postman export ([#204](https://github.com/vxrz/Steward/issues/204)), IBM Verify Privilege Vault ([#205](https://github.com/vxrz/Steward/issues/205)) and the assurance policy ([#210](https://github.com/vxrz/Steward/issues/210)).
- **0.6.0:** AI models through LLM gateways ([#216](https://github.com/vxrz/Steward/issues/216)) and part 1 of the plant registry ([#218](https://github.com/vxrz/Steward/issues/218), [ADR 0007](adr/0007-plant-registry.md)).
- **0.7.0:** plant registry part 2 – device profiles, data points and KPI definitions ([#219](https://github.com/vxrz/Steward/issues/219)) – and direct SQL database platforms ([#203](https://github.com/vxrz/Steward/issues/203), [ADR 0008](adr/0008-database-platforms.md)).
- **0.8.0:** plant registry part 3 – the OT network ([#220](https://github.com/vxrz/Steward/issues/220)) – with visualizations ([#230](https://github.com/vxrz/Steward/issues/230)), database schemas step 1 ([#222](https://github.com/vxrz/Steward/issues/222)) and the DynamoDB freshness check ([#233](https://github.com/vxrz/Steward/issues/233)).

## Next – 0.9.0

1. **Platform identities** ([#228](https://github.com/vxrz/Steward/issues/228)): several credentials per platform, each with its own access list, MCP mode, read-only flag and optional operation filter.
2. **Platform costs** ([#226](https://github.com/vxrz/Steward/issues/226)): one cost model in FinOps FOCUS for AWS, Snowflake, Confluent Cloud, AI gateways and FOCUS file imports – showback per service, application and team, budgets and checks.
3. **Data contracts** ([#221](https://github.com/vxrz/Steward/issues/221)): contracts in the Open Data Contract Standard (ODCS v3) with versions and breaking-change detection, drafts from API schemas, datasets and tables, tests through the datacontract API as a platform and a monitor check.
4. **Kafka Connect and Debezium** ([#223](https://github.com/vxrz/Steward/issues/223)): connectors and tasks of an existing Kafka Connect watched like other platforms – Steward does not capture changes itself.
5. **Version watch for the tech stack** ([#241](https://github.com/vxrz/Steward/issues/241)): the newest version of every known component from endoflife.date, Dependency-Track, package and container registries and Git releases – how far behind, end of life, a monitor check and a scorecard part.
6. **changedetection.io** ([#242](https://github.com/vxrz/Steward/issues/242)), run separately: a platform preset, its watches as components, a check for changed or failing watches, and a webhook example that starts a process – for vendor pages without an API.
7. **Outbound policy on every redirect** ([#243](https://github.com/vxrz/Steward/issues/243)): every redirect target is checked against the outbound policy like the first request; same-host redirects and the platform's trusted origins keep working.

## Then – 0.10.0

Each gets a decision record before it starts.

1. **Debugging procedures** ([#235](https://github.com/vxrz/Steward/issues/235)): run a single node with sample data, step through a run, compare two runs' decisions and changes.
2. **Quiet hours** ([#236](https://github.com/vxrz/Steward/issues/236)) and digest options for notifications.
3. **Approvals from Microsoft Teams** ([#237](https://github.com/vxrz/Steward/issues/237)) (adaptive cards) for procedure steps and MCP write requests.
4. **Shared procedure libraries** ([#238](https://github.com/vxrz/Steward/issues/238)) distributed through Git as signed bundles, building on Git sync.
5. **A map of sites** in the plant registry ([#234](https://github.com/vxrz/Steward/issues/234)): OpenStreetMap by default, light and dark vector styles, an own tile source or a self-hosted PMTiles file for networks without internet access, or off.
6. **An engine boundary** ([#239](https://github.com/vxrz/Steward/issues/239)) (start run / signal decision / cancel) that would allow a durable-execution backend such as Temporal for very long or very many runs.

## Later

- **Postman import** (rest of [#204](https://github.com/vxrz/Steward/issues/204)): requests and sign-in from a collection.

## Ideas parked

Discussed and not planned, with the reason; they come back only with a concrete need.

- **ITSM integration** (open or update a ServiceNow / Jira ticket from a run): ticket references cover linking today; parked until a team needs Steward to write tickets.
- **SCIM provisioning** of users and teams: SSO with claim mapping covers sign-in and roles; parked.
- **Audit anchoring with RFC 3161 timestamps** or a transparency log: the signed checkpoints cover tamper evidence for now; parked.
- **External key management** (KMS or HSM for the vault keys): the master passphrase stays; parked.
- **Approved changes put monitors into maintenance automatically.** Maintenance windows exist (0.2.5) and are set on purpose; tying them to change records adds coupling for a rare case – documented changes seldom take platforms offline.
- **Running Steward's procedures on Kestra, Windmill or Node-RED.** They overlap with the engine but lack dry runs, attestation-style decisions and sealed evidence; Steward calls them over HTTP where they already run.

## Standards Steward aligns with

- **ITIL 4:** procedures as standard changes and service request models – approved once, run many times, with evidence.
- **ISO/IEC 27001:2022 Annex A:** evidence for access control and reviews (5.15–5.18), privileged access (8.2), logging and monitoring (8.15–8.16); see [COMPLIANCE.md](COMPLIANCE.md).
- **IEC 62443:** asset inventory, patch and connectivity checks for Industrial Edge.
- **OWASP ASVS 4.0.3 level 2** as the security yardstick ([SECURITY-HARDENING.md](SECURITY-HARDENING.md)).
- **GDPR:** retention periods, minimal datasets, restricted access to protocols ([PRIVACY.md](PRIVACY.md)).
- **Open interfaces:** OIDC, OpenAPI 3.1, RFC 9457 problem details, OpenTelemetry, Prometheus, MCP, CycloneDX/SPDX SBOMs and signed releases.
