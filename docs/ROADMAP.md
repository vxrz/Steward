# Roadmap

Where Steward stands, what it deliberately does not do, and what comes next. Shipped changes are in the [CHANGELOG](../CHANGELOG.md); how it is built is in [ARCHITECTURE.md](ARCHITECTURE.md). Ideas and requests are collected as GitHub issues.

_Last reviewed for 0.4.0 (November 2026)._

## What Steward is for

Steward runs **repeatable, auditable service procedures** for the platforms a service team operates – Siemens Insights Hub, Industrial Edge and any REST API – and keeps the **evidence**: who decided, what was read, what was changed, and that nothing was changed behind the log. Around the procedures it keeps what a service team needs to run them well: a service catalogue, monitors, availability objectives, documents and ticket references, dashboards and reports. It is self-hosted, runs as one process, and works from a laptop (desktop app) up to a shared team server (container, PostgreSQL, single sign-on).

Guiding principles:

1. **Read, decide, write, verify, report.** Every change goes through a dry run and a human decision before it writes; the run re-reads what it changed and leaves a protocol.
2. **Evidence by default.** Every change of state is in the tamper-evident audit log ([ADR 0003](adr/0003-hmac-chained-audit-log.md)); protocols, reports and evidence packs can be verified outside Steward.
3. **People stay in charge.** Automation – schedules, webhooks, AI assistants – proposes and prepares; people approve writes (four-eyes where it matters).
4. **Small footprint.** One process, one database, no cluster; integrations through open standards (OIDC, OpenAPI, OpenTelemetry, Prometheus, MCP, RFC 9457).

## Where it stands (0.3)

| Area                | Today                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Procedures          | Versioned graph flows with dry runs, approvals and selections, four-eyes, manual steps, browser steps, sub-process runs; durable runs that resume after a restart without repeating finished steps; schedules and webhook triggers with one notification policy.       |
| Platforms           | Any REST API with OpenAPI import, connector types, recorded responses, contract checks; key-pair JWT and AWS request signing; Kubernetes, Prometheus, CheckMk, Git hosts, Kafka, MQTT, Snowflake, AWS, Dependency-Track, Gatus.                                        |
| Service catalogue   | Applications, systems, environments, components and tech stack with end-of-life data, CIA rating and protection needs, credentials register, service duties, documents and records with typed links, ticket references (ServiceNow, vendor tickets).                   |
| Operations          | Monitor graphs with root-cause links, **maintenance windows** (0.2.5), **incident reviews** (0.2.5), availability objectives and the service scorecard, **service status pages** (0.2.10), notifications by e-mail, Teams and webhooks, daily summaries.               |
| Compliance          | Control catalogues (including a company's own, proposed by an AI assistant and reviewed by people), mappings, coverage, person access reviews, evidence packs that verify offline.                                                                                     |
| Access              | Local accounts and OIDC / Entra ID single sign-on with claim mapping, SSO-only mode with emergency access, step-up re-authentication, roles, **owning teams** with team settings (0.3.0), access lists, API tokens.                                                    |
| Evidence            | HMAC-chained audit log with signed checkpoints and external anchors, run protocols with a sealed fingerprint, PDF/A reports drawn in a worker thread, evidence packs.                                                                                                  |
| Data and dashboards | Datasets published by procedures, metric history with trends and forecasts, dashboards with KPI, trend, status, table and Vega-Lite widgets, the public REST API `/api/v1` for BI tools.                                                                               |
| AI assistants       | An MCP server with a platform gateway, approved write requests (0.2.10) and OAuth 2.1 sign-in for MCP clients (0.3.0).                                                                                                                                                 |
| Running it          | Desktop executable, installable PWA, signed container image, SQLite or PostgreSQL, backups (local and S3), moving an instance with a migration package, upgrade tests from every release, OpenTelemetry traces, Prometheus metrics, optional Sentry-compatible errors. |

## Non-goals

Steward stays a tool for procedures and their evidence. These are **out of scope** – not "later", but deliberately left to tools that do them well:

- **No on-call or paging.** Steward notifies (e-mail, Teams, webhooks) and links to the run or monitor; rotations, escalation and acknowledgement belong to PagerDuty, Opsgenie or your ITSM tool, which a webhook can feed.
- **No CMDB or discovery.** The service catalogue describes what a team runs, maintained by people and procedures; it does not scan networks or reconcile configuration items. Read your CMDB with a procedure if you need its data.
- **No metrics stack or time-series database.** Monitors check, datasets keep the history a procedure publishes; long-term metrics, PromQL and alerting rules stay in Prometheus, Grafana and friends (Steward reads them and exposes its own `/api/metrics`).
- **No secret storage or rotation for others.** The vault protects the credentials Steward itself needs ([ADR 0004](adr/0004-vault-with-master-passphrase.md)); it is not a secret manager for other applications and does not rotate platform credentials on its own. The credentials register documents where secrets live and when they expire.
- **No full GRC suite.** Control catalogues, mappings, coverage and evidence packs support audits of what Steward runs; risk registers, policy management, vendor questionnaires and audit planning stay in a GRC tool.
- **No AI changes without human approval.** AI assistants may read, propose and prepare (MCP); every write they request is confirmed by a person, and proposals (such as a control catalogue) are reviewed before anything applies. There is no autonomous agent mode.
- **No incident management or ticketing.** Incident reviews document what happened to a service; tickets stay in ServiceNow or the vendor's tool and are referenced, not managed.
- **No horizontal scaling of one installation.** One active process per database ([ADR 0002](adr/0002-single-active-instance-with-lease-lock.md)); several teams share an installation through owning teams.
- **No configuration drift detection against baselines.** Change records document requested changes; they do not describe the allowed state of a platform.

## 0.4.0 – robust to run, easy to start

Themes of this release (details in the CHANGELOG once released):

- **Robust runtime.** One active instance held by a lease lock, background jobs with a clear lifecycle, a clean shutdown.
- **Build and configuration.** The server is compiled for production (no TypeScript loader in the image); every environment variable is validated at start-up and documented from the schema ([CONFIGURATION.md](CONFIGURATION.md)); the internal API answers problem details like `/api/v1`; dropped errors say why or are logged.
- **Audit log and datasets.** Easier to search, export and verify the audit log; datasets that are easier to find and keep fresh.
- **Navigation.** Consistent page templates, a better command palette and the same actions (such as _Duplicate_) wherever they make sense.
- **Getting started.** Onboarding for a new installation, ready-made bundles of procedures, dashboards and monitors, simpler set-up of the integrations.
- **Architecture documentation.** [ARCHITECTURE.md](ARCHITECTURE.md) with C4 diagrams and [decision records](adr/README.md).

## After 0.4.0 – audit-proof changes and more platforms

In this order:

1. **Audit-proof firewall changes** ([#208](https://github.com/vxrz/Steward/issues/208)), opt-in and without becoming a CMDB: network segments (for example shopfloor IoT subnets) as a system kind, the network context of chosen systems, a _Firewall change_ record type with four-eyes approval, evidence and verification, an _Approved firewall rules_ document per segment or system with a yearly review, and a process template for changes made by a provider.
2. **Microsoft Graph / Entra ID** ([#202](https://github.com/vxrz/Steward/issues/202)): a read-only platform for access reviews of groups, directory roles and app roles, guests and stale accounts, and app registrations whose secrets or certificates expire soon (into the credentials register).
3. **Postman export** ([#204](https://github.com/vxrz/Steward/issues/204)): processes and platforms as Postman collections and environments – sign-in, requests and checks as scripts, never a secret; an import of requests and auth later.
4. **IBM PAM** ([#205](https://github.com/vxrz/Steward/issues/205), likely IBM Verify Privilege Vault): who may use which privileged secret, rotation and heartbeat hygiene, links from the credentials register, and secret checkouts as evidence – never the secret values.
5. **Direct SQL databases** ([#203](https://github.com/vxrz/Steward/issues/203)): PostgreSQL, MariaDB/MySQL and SQL Server first, Oracle later; read-only by default, for grant reviews, account hygiene, monitor checks and datasets. The first platform kind that is not HTTP, so a decision record comes first.

## Later

Bigger topics we expect to work on, in no fixed order. Each gets a decision record before it starts.

- **Debugging procedures:** run a single node with sample data, step through a run, compare two runs' decisions and changes.
- **Quiet hours** and digest options for notifications.
- **Approvals from Microsoft Teams** (adaptive cards) for procedure steps and MCP write requests.
- **ITSM integration:** open or update a ServiceNow / Jira ticket from a run and link it back, on top of the ticket references.
- **SCIM provisioning** of users and teams from the identity provider.
- **Audit anchoring with RFC 3161 timestamps** or a transparency log, next to the signed checkpoints.
- **Shared procedure libraries** distributed through Git as signed bundles, building on Git sync.
- **External key management:** wrap the vault keys with a KMS or HSM instead of (or in addition to) the master passphrase.
- **An engine boundary** (start run / signal decision / cancel) that would allow a durable-execution backend such as Temporal for very long or very many runs.

## Ideas parked

Discussed and not planned, with the reason; they come back only with a concrete need.

- **Approved changes put monitors into maintenance automatically.** Maintenance windows exist (0.2.5) and are set on purpose; tying them to change records adds coupling for a rare case – documented changes seldom take platforms offline.
- **Running Steward's procedures on Kestra, Windmill or Node-RED.** They overlap with the engine but lack dry runs, attestation-style decisions and sealed evidence; Steward calls them over HTTP where they already run.

## Standards Steward aligns with

- **ITIL 4:** procedures as standard changes and service request models – approved once, run many times, with evidence.
- **ISO/IEC 27001:2022 Annex A:** evidence for access control and reviews (5.15–5.18), privileged access (8.2), logging and monitoring (8.15–8.16); see [COMPLIANCE.md](COMPLIANCE.md).
- **IEC 62443:** asset inventory, patch and connectivity checks for Industrial Edge.
- **OWASP ASVS 4.0.3 level 2** as the security yardstick ([SECURITY-HARDENING.md](SECURITY-HARDENING.md)).
- **GDPR:** retention periods, minimal datasets, restricted access to protocols ([PRIVACY.md](PRIVACY.md)).
- **Open interfaces:** OIDC, OpenAPI 3.1, RFC 9457 problem details, OpenTelemetry, Prometheus, MCP, CycloneDX/SPDX SBOMs and signed releases.
