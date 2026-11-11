# Modules and maturity

Steward has a core and optional areas, the **modules**. An administrator switches a module off in _Settings → Modules_. This page lists the modules, what switching one off does, and how mature each area and each connector is. The decision behind it: [ADR 0016](adr/0016-module-registry.md).

## Switching a module off

- Everything is on in a new installation and after an upgrade. Only the plant registry and its map are off until an administrator turns them on.
- Switched off, a module is gone for everyone: its sidebar entries, tabs and pages, its settings, its connectors in _Add platform_, its search results and its Home tiles. Its pages say _This area is switched off_; administrators get a link to _Settings → Modules_.
- Its routes answer `404` with the code `MODULE_OFF` (`PLANT_MODULE_OFF` for the plant registry), in the internal API and in the public API (`/api/v1`).
- Its background jobs do not run. _System status_ shows them as _Module switched off_.
- Its data stays. Switched on again, everything is back as it was.
- Switching needs an administrator in a signed-in session and a fresh confirmation (step-up, control point `modules.switch` in the [assurance policy](ASSURANCE.md)). Every switch is in the audit log (`module.enabled`, `module.disabled`).
- The plant registry is switched in its own card on the same page ([PLANT.md](PLANT.md)); the map of sites is on while the registry is on and a map source is chosen.

API: `GET /api/settings/modules` lists the modules, `PUT /api/settings/modules/:id` with `{ "enabled": false }` switches one. Both are for administrators; the switch needs a session (no API token).

## Modules

| Module                        | Id                | What goes when it is off                                                                                                                                                                                                                                                                                                                                                                                                                                         | Maturity | On by default |
| ----------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| Compliance and evidence       | `compliance`      | Controls, access changes, access reconciliation, person reviews, evidence packs, corrective actions (preview, its job `corrective-actions` and dataset `compliance.correctiveActions`), the statement of applicability and the _Responsibilities_ tab of services (preview, its job `soa` and dataset `compliance.soa`), the report section _ISMS summary_ and the export parts _Corrective actions_ and _Statement of applicability_; the findings tile on Home | stable   | yes           |
| Status pages                  | `statusPages`     | Status pages and their secret links; status viewers see "switched off"                                                                                                                                                                                                                                                                                                                                                                                           | beta     | yes           |
| Scorecard                     | `scorecard`       | The scorecard and availability objectives (tabs of Services); its job and Home tile                                                                                                                                                                                                                                                                                                                                                                              | beta     | yes           |
| Costs                         | `costs`           | Costs (a tab of Services), budgets, service cost plans, cost readers and their job, the cost check of monitors                                                                                                                                                                                                                                                                                                                                                   | preview  | yes           |
| Data contracts                | `dataContracts`   | Data contracts, their tests, the data contract connector and monitor check                                                                                                                                                                                                                                                                                                                                                                                       | preview  | yes           |
| AI models                     | `ai`              | The AI usage log and budgets, the _Ask an AI model_ step (it fails while off), the LLM gateway connector                                                                                                                                                                                                                                                                                                                                                         | beta     | yes           |
| Approvals in Microsoft Teams  | `teamsBot`        | The Teams bot settings; the bot answers 404 and offers no decisions ([TEAMS-APPROVALS.md](TEAMS-APPROVALS.md))                                                                                                                                                                                                                                                                                                                                                   | preview  | yes           |
| Shared procedure libraries    | `libraries`       | Libraries, trusted publishers and releases ([LIBRARIES.md](LIBRARIES.md))                                                                                                                                                                                                                                                                                                                                                                                        | preview  | yes           |
| Version watch and end of life | `versionWatch`    | Version lookups, end-of-life refresh and their jobs, the "versions behind" check                                                                                                                                                                                                                                                                                                                                                                                 | beta     | yes           |
| changedetection.io            | `changedetection` | The connector, its watches and job, the page watch check ([CHANGEDETECTION.md](CHANGEDETECTION.md))                                                                                                                                                                                                                                                                                                                                                              | preview  | yes           |
| Plant registry                | `plant`           | Sites, assets, profiles, KPIs, OT network ([PLANT.md](PLANT.md))                                                                                                                                                                                                                                                                                                                                                                                                 | preview  | no            |
| Map of sites                  | `plantMap`        | The map ([ADR 0015](adr/0015-map-of-sites.md)); needs the plant registry                                                                                                                                                                                                                                                                                                                                                                                         | preview  | no            |

The core is not a module: processes, runs, schedules, triggers, platforms, monitors, dashboards, reports, notifications, the catalogue (services, applications, systems), documents, credentials, ticket references, duties, the audit log, users and teams. Monitor checks that already exist keep running when their module is switched off.

## Maturity

- **stable** – used and tested broadly; changes are announced in the change log.
- **beta** – complete, but little used so far. Expect rough edges.
- **preview** – new; it may still change in ways that need you to act.

For connectors, _verified against_ says what the tests talk to: a **real** system of that product, only Steward's own **mock** of it (`server/src/mock/`), or **none** (the connector talks to no product of its own). A connector tested only against a mock is at most beta. Connectors and areas added in 0.9.0 or later are preview. _Settings → Modules_, _Add platform_ and the platform page show the label; the tooltip says what it means.

| Connector (platform kind)                         | Kind                          | Maturity | Verified against |
| ------------------------------------------------- | ----------------------------- | -------- | ---------------- |
| Any HTTP API (OpenAPI)                            | `generic`                     | stable   | none             |
| Databases (PostgreSQL, MariaDB/MySQL, SQL Server) | `database`                    | stable   | real (CI)        |
| Insights Hub                                      | `insights-hub`                | beta     | mock             |
| Industrial Edge Management                        | `industrial-edge-management`  | beta     | mock             |
| MQTT                                              | `mqtt`                        | beta     | mock             |
| Gatus                                             | `gatus`                       | beta     | mock             |
| Checkmk                                           | `checkmk`                     | beta     | mock             |
| Prometheus                                        | `prometheus`                  | beta     | mock             |
| Zabbix                                            | `zabbix`                      | beta     | mock             |
| AWS                                               | `aws`                         | beta     | mock             |
| Kubernetes                                        | `kubernetes`                  | beta     | mock             |
| Snowflake                                         | `snowflake`                   | beta     | mock             |
| Kafka                                             | `kafka`                       | beta     | mock             |
| Microsoft Graph (Entra ID)                        | `microsoft-graph`             | beta     | mock             |
| GitHub, GitLab, Forgejo                           | `github`, `gitlab`, `forgejo` | beta     | mock             |
| Dependency-Track                                  | `dependency-track`            | beta     | mock             |
| endoflife.date                                    | `endoflife-date`              | beta     | mock             |
| Container registries                              | `container-registry`          | beta     | mock             |
| IBM Verify Privilege Vault                        | `privilege-vault`             | beta     | mock             |
| LLM gateways                                      | `llm-gateway`                 | beta     | mock             |
| Kafka Connect                                     | `kafka-connect`               | preview  | mock             |
| Confluent Cloud                                   | `confluent-cloud`             | preview  | mock             |
| Data contract service                             | `datacontract`                | preview  | mock             |
| InfluxDB                                          | `influxdb`                    | preview  | mock             |
| changedetection.io                                | `changedetection`             | preview  | mock             |
| Microsoft Teams (bot)                             | `teams`                       | preview  | mock             |

Connector types you import or define yourself have no label. The maturity is part of each kind's descriptor in `shared/src/platformKinds.ts` (`PLATFORM_KINDS`); change both together.

## What a person sees

The sidebar shows an area only when the person may see something there or may add something. The server decides this with the same rights as the pages (`GET /api/me/visibility`). An empty list says _Nothing here you may see_ when entries exist that the person has no access to; it never says how many or which. A dashboard widget whose data the person may not read says so instead of _No data yet_.
