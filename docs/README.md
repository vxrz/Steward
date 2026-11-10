# Documentation

Every page of Steward's documentation, grouped by what you want to do. New here? Read the [README](../README.md) for what Steward is, then [Getting started](GETTING-STARTED.md) to set up an installation.

- [Evaluate](#evaluate)
- [Install and operate](#install-and-operate)
- [Administer](#administer)
- [Build procedures](#build-procedures)
- [Use day to day](#use-day-to-day)
- [Integrations by platform](#integrations-by-platform)
- [Security and compliance](#security-and-compliance)
- [Develop and contribute](#develop-and-contribute)
- [Decisions](#decisions)
- [Reviews](#reviews)

## Evaluate

| Page                         | What it covers                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| [README](../README.md)       | What Steward is, the core idea, a quick start with simulated platforms                           |
| [ROADMAP.md](ROADMAP.md)     | Where Steward stands, what it deliberately does not do, and what comes next                      |
| [RELEASES.md](RELEASES.md)   | Versioning, which versions get fixes, how releases are tested and verified                       |
| [CHANGELOG](../CHANGELOG.md) | Every change per release, with what to check before updating                                     |
| [GLOSSARY.md](GLOSSARY.md)   | The terms Steward uses: services, applications, systems, platforms, documents, monitors and more |

## Install and operate

| Page                                     | What it covers                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| [GETTING-STARTED.md](GETTING-STARTED.md) | From installation to a usable instance, step by step, for administrators              |
| [INSTALL.md](INSTALL.md)                 | Desktop app, PWA, Node.js, container, database, updates, reverse proxy, health checks |
| [CONFIGURATION.md](CONFIGURATION.md)     | Every environment variable with its default (generated)                               |
| [BACKUPS.md](BACKUPS.md)                 | Encrypted backups to S3, retention, restore tests and restoring                       |
| [MIGRATION.md](MIGRATION.md)             | Moving an instance, e.g. from the desktop app to a server, with a user mapping        |
| [ERROR-REPORTING.md](ERROR-REPORTING.md) | Sending unexpected errors to Sentry, GlitchTip or Bugsink                             |
| [METRICS.md](METRICS.md)                 | Prometheus metrics, the shipped alert rules and the renamed metric names              |

## Administer

| Page                                     | What it covers                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [MODULES.md](MODULES.md)                 | The optional areas an administrator can switch off, and the maturity of each area and connector |
| [USERS.md](USERS.md)                     | Roles, access lists, decisions, passwords, single sign-on in short, a team instance             |
| [SSO.md](SSO.md)                         | Single sign-on with OpenID Connect: providers, claims, account linking, test sign-in            |
| [TEAMS.md](TEAMS.md)                     | Several teams in one instance: owning teams and what members see                                |
| [SETTINGS.md](SETTINGS.md)               | Where each setting is: personal, per team, for the instance                                     |
| [NOTIFICATIONS.md](NOTIFICATIONS.md)     | Events, channels, policies, daily summary, quiet hours and digests                              |
| [TEAMS-APPROVALS.md](TEAMS-APPROVALS.md) | Deciding from Microsoft Teams cards, and the optional Teams bot                                 |
| [BRANDING.md](BRANDING.md)               | The product name, colours, logo and display name of an installation                             |

## Build procedures

| Page                                                                               | What it covers                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [PROCESSES.md](PROCESSES.md)                                                       | Writing processes: how a flow runs, expressions, every node type, templates                    |
| [PLATFORMS.md](PLATFORMS.md)                                                       | Platforms and connector types, API specs and path prefixes, recorded responses and test runs   |
| [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md)                                         | Every way Steward signs in to a platform: tokens, OAuth, JWT, AWS signing, client certificates |
| [DEBUGGING.md](DEBUGGING.md)                                                       | Run one node, step through a run, compare with the last good run                               |
| [MANUAL-STEPS.md](MANUAL-STEPS.md)                                                 | Manual steps and manual procedures with checklists, evidence and a second person               |
| [AI.md](AI.md)                                                                     | AI models through LLM gateways: the process step, budgets and the usage log                    |
| [GIT-SYNC.md](GIT-SYNC.md)                                                         | Keeping processes, dashboards and monitors in Git and reviewing changes before they apply      |
| [LIBRARIES.md](LIBRARIES.md)                                                       | Signed, versioned procedure libraries from a publisher you trust                               |
| [libraries/steward-library-1.schema.json](libraries/steward-library-1.schema.json) | JSON Schema of a library manifest                                                              |
| [POSTMAN.md](POSTMAN.md)                                                           | Exporting processes and platforms as Postman collections and environments                      |

## Use day to day

| Page                                                                     | What it covers                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [MONITORS.md](MONITORS.md)                                               | Dependency-aware health checks, check types, heartbeats from gateways, outputs              |
| [DASHBOARDS.md](DASHBOARDS.md)                                           | Publishing datasets, widgets, sources, trends and forecasts, Vega-Lite charts               |
| [REPORTS.md](REPORTS.md)                                                 | PDF/A run, summary and scheduled reports, branding, archiving and verification              |
| [RECORDS.md](RECORDS.md)                                                 | Documents: change requests, decision records, incident reviews, living documents; services  |
| [APPLICATIONS.md](APPLICATIONS.md)                                       | Applications, systems, components, tech stack, end of life, version watch, protection needs |
| [CREDENTIALS.md](CREDENTIALS.md)                                         | The credentials register: where credentials are kept, owners, expiry and rotation           |
| [DUTIES.md](DUTIES.md)                                                   | Recurring tasks a service must have done, judged by the real runs                           |
| [SCORECARD.md](SCORECARD.md)                                             | Availability objectives and the service scorecard                                           |
| [COSTS.md](COSTS.md)                                                     | Platform costs per service, application and team (showback, FinOps FOCUS)                   |
| [TICKETS.md](TICKETS.md)                                                 | Ticket references to incidents and vendor cases that live in other systems                  |
| [DATA-CONTRACTS.md](DATA-CONTRACTS.md)                                   | Data contracts in ODCS v3: schema, quality rules, tests and their evidence                  |
| [STATUS-PAGES.md](STATUS-PAGES.md)                                       | Service status pages for people outside the service team                                    |
| [PLANT.md](PLANT.md)                                                     | The plant registry (preview): sites, assets, device profiles, KPIs, OT network              |
| [ADVISORIES.md](ADVISORIES.md)                                           | Security advisories (CSAF 2.0) for OT devices, matched to assets by model and firmware      |
| [plant/plant-registry-1.schema.json](plant/plant-registry-1.schema.json) | JSON Schema of the plant registry import format                                             |

## Integrations by platform

| Page                                             | What it covers                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [AWS.md](AWS.md)                                 | AWS accounts: tagged resources, costs, IAM access keys, DynamoDB checks, AWS calls    |
| [CHANGEDETECTION.md](CHANGEDETECTION.md)         | changedetection.io for pages without an API: vendor changelogs, terms, status pages   |
| [CHECKMK.md](CHECKMK.md)                         | Reading CheckMk states and metrics into monitors and datasets                         |
| [CONFLUENT.md](CONFLUENT.md)                     | Confluent Cloud: clusters, connectors, schemas, API keys, access reviews, costs       |
| [DATABASES.md](DATABASES.md)                     | PostgreSQL, MariaDB/MySQL and SQL Server, read-only: queries, access reviews, schemas |
| [DEPENDENCY-TRACK.md](DEPENDENCY-TRACK.md)       | Vulnerabilities and policy violations of an application's components                  |
| [ENTRA.md](ENTRA.md)                             | Microsoft Graph and Entra ID, read-only: users, groups, roles, app credentials        |
| [GATUS.md](GATUS.md)                             | Working alongside the Gatus uptime monitor, webhook triggers from Gatus alerts        |
| [GIT-PLATFORMS.md](GIT-PLATFORMS.md)             | GitHub, GitLab and Forgejo/Gitea, read-only                                           |
| [IBM-PAM.md](IBM-PAM.md)                         | IBM Security Verify Privilege Vault as a source of evidence                           |
| [INSIGHTS-HUB-USAGE.md](INSIGHTS-HUB-USAGE.md)   | The Insights Hub tenant usage and licence check with its dashboard                    |
| [KAFKA.md](KAFKA.md)                             | Kafka topics, consumer groups, schemas, Kafka Connect and Debezium                    |
| [KUBERNETES.md](KUBERNETES.md)                   | Kubernetes and OpenShift clusters, read-only                                          |
| [MQTT.md](MQTT.md)                               | MQTT brokers in monitor checks: topics, silent devices, connected clients             |
| [PROMETHEUS.md](PROMETHEUS.md)                   | PromQL checks and objectives against Prometheus, Thanos, Mimir or VictoriaMetrics     |
| [SNOWFLAKE.md](SNOWFLAKE.md)                     | Snowflake accounts: databases, access reviews, costs                                  |
| [API.md](API.md)                                 | Steward's read-only REST API `/api/v1` for reports, BI tools and monitoring           |
| [openapi.json](openapi.json)                     | The OpenAPI 3.1 description of `/api/v1` (generated)                                  |
| [MCP.md](MCP.md)                                 | The MCP server for AI assistants, the platform gateway and approved writes            |
| [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md)           | Steward's data as an Apache Ossie semantic model for BI tools and catalogs            |
| [EXTERNAL-DASHBOARDS.md](EXTERNAL-DASHBOARDS.md) | Steward's data in Streamlit and Grafana                                               |

## Security and compliance

| Page                                           | What it covers                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| [SECURITY-MODEL.md](SECURITY-MODEL.md)         | How Steward protects sessions, credentials, platforms, the audit log and its APIs    |
| [SECURITY-HARDENING.md](SECURITY-HARDENING.md) | The checklist for a work deployment, audit log as evidence, verifying downloads      |
| [SECURITY.md](../SECURITY.md)                  | Reporting a vulnerability, supported versions                                        |
| [PRIVACY.md](PRIVACY.md)                       | Which personal data Steward stores, for how long, and erasure requests               |
| [ASSURANCE.md](ASSURANCE.md)                   | Where four-eyes and step-up are enforced, and the assurance report                   |
| [COMPLIANCE.md](COMPLIANCE.md)                 | Access governance evidence: access changes, reconciliation, controls, evidence packs |
| [FIREWALL-CHANGES.md](FIREWALL-CHANGES.md)     | Documenting firewall changes and network segments                                    |

## Develop and contribute

| Page                                               | What it covers                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| [CONTRIBUTING.md](../CONTRIBUTING.md)              | Set-up, conventions, checks, changelog entries, releasing                    |
| [ARCHITECTURE.md](ARCHITECTURE.md)                 | C4 diagrams, the module map of `server/src`, the engine boundary             |
| [TESTING.md](TESTING.md)                           | Test layers, manual checks per role, a sandbox tenant plan, upgrade fixtures |
| [I18N.md](I18N.md)                                 | Languages and translations, adding a language, checks for hard-coded texts   |
| [ci/SECURITY-PIPELINE.md](ci/SECURITY-PIPELINE.md) | The security and supply-chain checks in CI and how to run them locally       |
| [ci/WOODPECKER.md](ci/WOODPECKER.md)               | Woodpecker CI on a Forgejo mirror with Harbor and Dependency-Track           |

## Decisions

[adr/README.md](adr/README.md) lists the architecture decision records: why the database layer, the single active instance, the audit chain, the vault and the other main parts are built the way they are.

## Reviews

Dated reviews. They describe the state of their date; what they changed is in the CHANGELOG.

| Page                                                   | What it covers                                               |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| [reviews/REVIEW-2026-10.md](reviews/REVIEW-2026-10.md) | Security and best-practice review, October 2026              |
| [reviews/UX-REVIEW.md](reviews/UX-REVIEW.md)           | UI/UX review of October 2026, its fixes and the backlog then |
