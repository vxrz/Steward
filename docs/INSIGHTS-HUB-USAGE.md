# Insights Hub tenant usage and licence check

The example process **Insights Hub – Tenant usage and licence check** (`examples/processes/32-ih-tenant-usage.yaml`) and the dashboard **Tenant usage** (`examples/dashboards/50-tenant-usage.yaml`) show how much of your Insights Hub licence you use: users, assets, agents, asset attributes (per asset type) and, optionally, one KPI of the Usage Transparency Service. A figure turns **warning** from 80 % and **critical** from 95 % of its limit.

## What you get

- **Dataset `ih.usage`.** One row per figure: used, limit, unit, used in %, source and a status – good, warning, critical, or **unknown** when the figure could not be read. Without a limit a figure is counted only (status good, _counted, no limit set_).
- **Dataset `ih.usage-attributes`.** One row per asset type with assets: number of assets, attributes per asset (variables of the type and of its aspects) and attributes in total.
- **Metrics with history.** `usersPercent`, `assetsPercent`, `agentsPercent`, `attributesPercent`, `kpiPercent`, `maxPercent`, the counts (`users`, `assets`, `agents`, `attributes`, `kpi`), the number of figures at `warning` and `critical` level and `unread` (figures that could not be read). The dashboard draws trends from them.
- **Alerts.** Three checks: _All figures were read_ (warning), _No limit reached critical level_ (error) and _No limit above the warning level_ (warning). A failed check sends the **check failed** notification to the person who started the run, the schedule owner and the process owner – on change, as set in the schedule. The run itself still succeeds, so the datasets are always updated.

## Set it up

1. Import the process (_Processes → From template_) and the dashboard (_Dashboards → From template_). Demo mode does both and schedules the process daily with the limits of the simulated tenant.
2. Start a dry run against your Insights Hub platform. All calls are reads.
3. Open the run and check the HTTP steps: _Count users_, _List asset types_, _List assets_, _Count agents_ and – when set up – _Usage Transparency KPI of the month_.
4. Set the inputs in a schedule (_Schedules → New schedule_, daily is enough):

| Input             | Meaning                                                                             | Default |
| ----------------- | ----------------------------------------------------------------------------------- | ------- |
| `warnPercent`     | Warning from this percentage of a limit                                             | 80      |
| `criticalPercent` | Critical from this percentage                                                       | 95      |
| `userLimit`       | Licensed users from your contract (0 = count only)                                  | 0       |
| `assetLimit`      | Licensed assets (0 = count only)                                                    | 0       |
| `agentLimit`      | Licensed agents (0 = count only)                                                    | 0       |
| `attributeLimit`  | Licensed asset attributes (0 = count only)                                          | 0       |
| `utsProvider`     | Usage Transparency: tenant ID of the provider of the application (empty = no KPI)   | empty   |
| `utsApplication`  | Usage Transparency: name of the application registered on the gateway               | empty   |
| `utsKpi`          | Usage Transparency: name of the KPI registered for the application (empty = no KPI) | empty   |
| `utsKpiLimit`     | Limit of the KPI in the month (0 = count only)                                      | 0       |

The limits are part of your contract; Insights Hub does not report them. Without limits the process still counts everything, which is a good first run.

## Why a figure is unknown

Each call continues when it fails (`onError: continue`), so one missing right does not hide the other figures. The figure is published as **unknown** with _could not be read – see the step "…" in the run_, the check _All figures were read_ fails, and the failed step of the run shows the HTTP status and the platform's answer, e.g. `HTTP 403 … Forbidden` or, for the usage service, `HTTP 404 … mdsp.core.generic.noMatch`.

## Rights of the technical user

The platform's service credentials need read access to Identity Management (users), Asset Management (asset types and assets) and Agent Management (agents). For the KPI the technical user needs the Usage Transparency scope `uts.r`.

## Which APIs it uses

| Figure           | Call                                                                                                                                | Notes                                                                                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users            | `GET /api/identitymanagement/v3/Users?count=1` → `totalResults`                                                                     | SCIM list response. Used by the other examples too.                                                                                                                                                                        |
| Assets           | `GET /api/assetmanagement/v3/assets` (paged) → number of assets                                                                     | HAL paging, 500 per page. Used by the inventory example.                                                                                                                                                                   |
| Asset attributes | `GET /api/assetmanagement/v3/assettypes?exploded=true` (paged) and the assets                                                       | Per asset type: variables of the type plus the variables of its aspects, times the assets of the type. An estimate in the same way as the attribute optimization example – compare it once with the Asset Manager figures. |
| Agents           | `GET /api/agentmanagement/v3/agents?size=1` → `totalElements`                                                                       | Spring paging.                                                                                                                                                                                                             |
| KPI (optional)   | `GET /api/usagetransparency/v3/aggregatedMonthlyConsumerUsage?month=October&year=2026&provider=…&application=…&KPIName=…` → `value` | Usage Transparency API 3.2.0. All five parameters are required; the month is the English month name. Answers with the aggregated value of one KPI of your tenant for the month (`KPIDisplayName` names the row).           |

The Usage Transparency API reports what applications sent as usage and aggregated as KPIs; it has no call for a tenant's overall consumption and reports no limits. Earlier versions of this example called a `usages/aggregated` path, which the API does not have (the call failed with HTTP 500) – it was removed in 0.2.4. For more KPIs, copy the _Usage Transparency KPI of the month_ step and add a row in _Compare with the limits_.

Like the other examples, the API paths come from platform variables when they are set: `idmPath`, `assetPath`, `agentPath` and `utsPath`. This matters on the `api.{region}.siemens.app` gateway with tenant-specific paths.

## Simulated data

The Insights Hub mock (`server/src/mock/mockUsage.ts`) serves the agents and the Usage Transparency call as in the specification – a missing parameter is a 400 and an unknown KPI a 404 in its error format. The demo provider `demoprovider` has the application `steward-demo` with the KPIs `monthly-credits` (close to the demo limit of 10 000 – critical) and `active-users`; the value grows over the month, so the trend charts move. Users (15), assets (12) and asset types come from the existing mock tenant; the demo schedule sets limits of 25 users, 15 assets (warning), 10 agents (warning) and 500 attributes.
