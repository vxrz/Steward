# Insights Hub tenant usage and licence check

The example process **Insights Hub – Tenant usage and licence check** (`examples/processes/32-ih-tenant-usage.yaml`) and the dashboard **Tenant usage** (`examples/dashboards/50-tenant-usage.yaml`) show how much of your Insights Hub licence you use: users, assets, agents, credits, time series storage, file storage and API calls. A figure turns **warning** from 80 % and **critical** from 95 % of its limit.

## What you get

- **Dataset `ih.usage`.** One row per figure: used, limit, unit, used in %, source and a status (good, warning, critical, or unknown when no limit is known).
- **Metrics with history.** `usersPercent`, `assetsPercent`, `agentsPercent`, `creditsPercent`, `storagePercent`, `maxPercent`, the raw counts (`users`, `assets`, `credits`, `storageGb`) and the number of figures at `warning` and `critical` level. The dashboard draws trends from them.
- **Alerts.** Two checks fail when a figure reaches a level: _No limit reached critical level_ (severity error) and _No limit above the warning level_ (severity warning). A failed check sends the **check failed** notification to the person who started the run, the schedule owner and the process owner – in the app and, when set up, by e-mail or Teams (_Settings → Notifications_). The run itself still succeeds, so the dataset is always updated.

## Set it up

1. Import the process (_Processes → From template_) and the dashboard (_Dashboards → From template_). Demo mode does both and schedules the process daily.
2. Start a dry run against your Insights Hub platform. All calls are reads.
3. Open the run and check the four HTTP steps: _Count users_, _Count assets_, _Count agents_ and _Aggregated usage of the month_.
4. Set the inputs in a schedule (_Schedules → New schedule_, daily is enough):

| Input             | Meaning                                                                                       | Default  |
| ----------------- | --------------------------------------------------------------------------------------------- | -------- |
| `warnPercent`     | Warning from this percentage of a limit                                                       | 80       |
| `criticalPercent` | Critical from this percentage                                                                 | 95       |
| `userLimit`       | Licensed users from your contract (0 = not checked)                                           | 25       |
| `assetLimit`      | Licensed assets (0 = not checked)                                                             | 15       |
| `agentLimit`      | Licensed agents (0 = not checked)                                                             | 10       |
| `creditLimit`     | Credits per month (0 = the limit the usage service reports)                                   | 0        |
| `storageLimitGb`  | IoT time series storage in GB (0 = the limit the usage service reports)                       | 0        |
| `utsPath`         | Path of the aggregated usage of the Usage Transparency Service – **verify it on your tenant** | see YAML |

The defaults of the user, asset and agent limits only fit the simulated demo tenant. Use the figures of your contract.

## Rights of the technical user

The platform's service credentials need read access to Identity Management (users), Asset Management (assets), Agent Management (agents) and the Usage Transparency Service. Without a right the step fails: the users and assets steps stop the run, the agents and usage steps continue (`onError: continue`) and their figures are left out. The check _The usage service answered_ (severity info) tells you when the usage figures are missing.

## Which APIs it uses – verify on your tenant

The Siemens developer documentation could not be reached from the build environment of this example (October 2026). The table says what is based on the documented APIs and what is an assumption. Check the assumptions with a dry run and the platform's **API explorer**, and import the official OpenAPI specifications into the platform.

| Figure                      | Call                                                                                                                      | Status                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users                       | `GET /api/identitymanagement/v3/Users?count=1` → `totalResults`                                                           | Documented (SCIM list response). Used by the other examples too.                                                                                                                                                                               |
| Assets                      | `GET /api/assetmanagement/v3/assets?size=1` → `page.totalElements`                                                        | Documented (HAL paging). Used by the inventory example.                                                                                                                                                                                        |
| Agents                      | `GET /api/agentmanagement/v3/agents?size=1` → `totalElements`                                                             | The Agent Management API exists; the paging field at the top level is an **assumption** – check it.                                                                                                                                            |
| Credits, storage, API calls | `GET /api/usagetransparency/v3/usages/aggregated?from=YYYY-MM&to=YYYY-MM` → `usages[]` with `resource`, `amount`, `limit` | **Assumed.** The Usage Transparency Service (v3) offers aggregated monthly usage of a tenant, but its exact path, parameters and response fields are not confirmed. Adapt `utsPath` and the expressions in the _Compare with the limits_ step. |

The resource names the process looks for are `credits`, `iot-timeseries-storage`, `file-storage` and `api-calls`. If your tenant reports other names, change them in the _Compare with the limits_ step (`$uts('…')`).

Like the other examples, the API paths come from platform variables when they are set: `idmPath`, `assetPath` and the new `agentPath`. This matters on the `api.{region}.siemens.app` gateway with tenant-specific paths.

## Simulated data

The Insights Hub mock (`server/src/mock/mockUsage.ts`) serves the two assumed endpoints with demo figures: 9 agents, credits close to the limit (critical), time series storage at about 85 % (warning) and growing figures over the month, so the trend charts move. Users (15) and assets (12) come from the existing mock tenant.
