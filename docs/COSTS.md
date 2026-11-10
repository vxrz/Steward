# Platform costs

What do the services, applications and teams a team runs cost per month? Steward collects the costs from the platforms it already reads – **AWS, Snowflake, Confluent Cloud, AI gateways** – and from **FOCUS files** of every other provider, keeps them in one cost model and shows them per service, application, team and platform: the last 12 months, the current month so far, a trend and a forecast, monthly budgets with notices, a monitor check for unusual increases, a scorecard part, a report section, a dataset and read endpoints of the public API.

**Showback, not FinOps.** Steward shows costs where people already look after their services. Invoices, chargeback between departments, commitment and rightsizing optimisation stay in a FinOps tool ([ROADMAP.md](ROADMAP.md), _not planned_).

- [The cost model (FOCUS)](#the-cost-model-focus)
- [Sources](#sources)
- [Mapping to applications, services and teams](#mapping)
- [Late and corrected figures](#late-and-corrected-figures)
- [What people see](#what-people-see)
- [Budgets](#budgets)
- [Monitor check](#monitor-check)
- [Scorecard, reports, dashboards and the API](#dashboards-and-the-api)
- [Planning per service](#planning-per-service)
- [Who sees costs](#who-sees-costs)
- [Decisions](#decisions)
- [Demo and tests](#demo-and-tests)

## The cost model (FOCUS)

Every cost line is a row of the **FinOps Open Cost and Usage Specification (FOCUS)** of the FinOps Foundation, version 1.x – the column ids are FOCUS's own, so a FOCUS file and Steward's model speak the same language ([focus.finops.org](https://focus.finops.org/focus-specification/)):

| FOCUS column                                | In Steward                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `BillingPeriodStart`, `BillingPeriodEnd`    | The billing period (the calendar month of the charge when a file has none)                                           |
| `ChargePeriodStart`, `ChargePeriodEnd`      | The charge period – a day (Snowflake, Confluent, AI, FOCUS rows of an hour or a day) or a month (AWS)                |
| `BilledCost`                                | What is invoiced                                                                                                     |
| `EffectiveCost`                             | What it cost after discounts and amortisation – **what Steward shows** (`BilledCost` where a source has no other)    |
| `BillingCurrency`                           | ISO 4217 code of both amounts                                                                                        |
| `ProviderName` (`ServiceProviderName`, 1.3) | AWS, Snowflake, Confluent, AI gateway, or the file's provider                                                        |
| `ServiceName`, `ServiceCategory`            | e.g. _Amazon Relational Database Service_ / _Databases_, `WAREHOUSE_METERING` / _Analytics_, `KAFKA` / _Integration_ |
| `ResourceId`, `ResourceName`                | Confluent cluster or connector, AI model, the file's resource                                                        |
| `SubAccountId`                              | Snowflake account, Confluent environment, the file's sub account                                                     |
| `ChargeCategory`                            | `Usage`, `Credit`, `Adjustment`, … as the source says                                                                |
| `Tags`                                      | A JSON object of key–value pairs (string values; at most 50)                                                         |

Steward adds its **links**: the platform the cost belongs to, the component and the application ([mapping](#mapping)); services and owning teams follow from the application when costs are shown, so a change in the catalogue is reflected at once.

**Amounts are decimals with their currency.** They are kept as whole millionths of the currency unit (an integer, never a binary float; rounding half away from zero at the sixth decimal) and travel as decimal strings (`"1840.00"`). **Nothing is converted between currencies**: every total, chart, budget and check is per currency. A scope with costs in USD and EUR shows two sections.

## Sources

Each platform's costs are set up on its **Source** tab (_Costs → Platforms → the platform → Source_, or _Costs_ on the platform page) by whoever may manage the platform. A source is read with the rights of who last saved it (they must still be allowed to use the platform); every call goes through the platform's client and the outbound policy like every platform call.

| Source              | How                                                                                                                                                                                                           | Granularity | Read                               | Re-reads           | Permissions                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS**             | Cost Explorer `GetCostAndUsage`, `UnblendedCost`, grouped by the application tag **and** by service in one request series ([AWS.md](AWS.md))                                                                  | month       | once a day (each request is $0.01) | the last 12 months | `ce:GetCostAndUsage`; the tag activated as cost allocation tag                                                                                     |
| **Snowflake**       | `SNOWFLAKE.ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY` (`USAGE_IN_CURRENCY`, `CURRENCY`, `SERVICE_TYPE`, `BILLING_TYPE`) of the platform's account, through the SQL API ([SNOWFLAKE.md](SNOWFLAKE.md))        | day         | once a day                         | the last 35 days   | the organisation's usage views (`GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE`, an account with ORGANIZATION_USAGE; not for reseller contracts) |
| ↳ fallback          | `SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY` `CREDITS_BILLED` × the **price per credit** set on the source                                                                                                | day         | once a day                         | the last 35 days   | the ACCOUNT_USAGE views (as for the database readouts)                                                                                             |
| **Confluent Cloud** | The Costs API `GET /billing/v1/costs?start_date=&end_date=` – daily lines per resource, product and line type, US dollars, at most one month per request, up to three days ago ([CONFLUENT.md](CONFLUENT.md)) | day         | once a day                         | the last 35 days   | the Cloud API key's service account needs **OrganizationAdmin** or **BillingAdmin**                                                                |
| **AI gateways**     | The usage log's costs (the prices per 1,000 tokens set on the models) per day, model and process ([AI.md](AI.md))                                                                                             | day         | every hour (local, no call)        | the last 35 days   | – (the currency is set on the source, else _Cost settings → Currency of AI prices_)                                                                |
| **FOCUS files**     | A CSV file in FOCUS, uploaded with a preview or pushed from CI ([below](#focus-files))                                                                                                                        | row's       | when imported                      | the file's days    | who may manage the platform                                                                                                                        |

The first read of a connector reads 12 months back (as far as the source has them); later reads re-read the last 35 days (AWS: the 12 months it always reads). The job `costs` decides every few minutes which sources are due; _Read now_ reads one at once – AWS keeps to its daily read, as Cost Explorer charges every request. The read's outcome, its note (e.g. _ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY_) and an error are shown on the Source tab.

The **AWS** component readouts (cloud accounts of applications) and the cost model use the same read: the account is read once a day, now with one request series grouped by the tag and the service instead of two – the readout still shows its last six months.

Later, optional: Kubernetes through OpenCost (per namespace), Azure Cost Management.

### FOCUS files

AWS (Data Exports, FOCUS 1.0), Azure (Cost Management exports, FOCUS), Google Cloud (the FOCUS BigQuery view) and other providers export FOCUS. On a platform's Source tab, **Import a file** reads the CSV and shows a **preview** – nothing is stored yet: rows and cost lines, the period, totals per currency, the providers, how many lines link to an application, ignored columns, rows that are left out and why, whether the same file was imported before. The preview counts a line as linked only when you may see its application – a line of an application hidden from you counts as unassigned, like a name no application has. Then **Import**:

- **Replace these days** (default): lines of earlier imports of this platform for the file's days are replaced – a corrected file. Changed figures of closed days are audited as corrections.
- **Add**: earlier lines stay – for files of other accounts for the same days.

Reading: comma, semicolon or tab separated (from the header line), RFC 4180 quoting, a byte order mark, CRLF/LF/CR; one pass over the characters, no regular expression on the content. Required columns: `BilledCost`, `BillingCurrency`, `ChargePeriodStart`, `ChargePeriodEnd` (ids are matched case-insensitively). Limits: 25 MB, 500,000 rows, 300 columns, 16,000 characters per cell. Rows of an hour or a day are summed per day, provider, service, category, resource, sub account, charge category and tags. `Tags` must be a JSON object; keys that could change an object's prototype (`__proto__`, `constructor`, `prototype`) are dropped. The **same file** (its SHA-256) is refused a second time for a platform. Every import is audited (`cost.imported`) with the file name, SHA-256, size, rows, period, mode and totals; the list on the Source tab shows them. A large file is read and linked in chunks, so the server keeps answering other requests meanwhile; the lines are then written in one transaction.

### Push from CI

A **push token** belongs to one platform and can do nothing but send FOCUS files for it – the push-token pattern of database schemas ([DATABASES.md](DATABASES.md#tbls-from-ci)):

```sh
curl -sS -f -X POST "https://steward.example.com/api/hooks/costs/<platform id>?fileName=focus.csv&mode=replace" \
  -H "Authorization: Bearer $STEWARD_COST_TOKEN" \
  -H 'Content-Type: text/csv' \
  --data-binary @focus.csv
```

- Created on the Source tab (_Push from CI → New push token_) by who may manage the platform; shown **once**, only its SHA-256 is stored; optional expiry, allowed addresses (CIDR) and rate limit (6 a minute by default). Rotate and revoke there. Creating and rotating need a signed-in session (API tokens get `403 SESSION_REQUIRED`); revoking works with an API token too.
- It works only while its creator is active and may still manage the platform; its lines link with the creator's rights ([Mapping](#mapping)). API tokens and sign-in sessions are refused; a token of another platform, a revoked or expired one and a refused address all get the same `401`. The token is checked from the headers **before** the body is read.
- `mode` (`replace` or `add`) and `fileName` come from the query string. The answer names the import, the lines written and replaced and the corrections. Creating, rotating, revoking and every push are audited.

## Mapping

Each line is linked when it is written, and again once a day (a new component, a renamed application). In this order:

1. **Confluent Cloud**: the cluster (`ResourceId` `lkc-…`) names the **Kafka platform** whose variable `confluentClusterId` is that id – the cost belongs to that platform (_Kafka (demo)_ in the demo); failing that, the environment (`SubAccountId` `env-…`) and a Kafka platform with `confluentEnvironmentId` (and no cluster id). Its application is the one all **Kafka topic components** on that platform belong to, else the platform's own application.
2. **The tag** – the cost source's _tag that names the application_ (default `application`; for AWS the account's variable `tagKey`) – names a **component on the platform** (an AWS cloud account's name is its tag value) or else an **application by its name** (case-insensitive; a name two applications share links neither). A **FOCUS file** is written by a person, not read from the provider: its tag links by name only to an application **the importer may change** (for a push: the token's creator; the daily linking uses each import's importer with their rights of today) or one **tied to the platform** (the platform's own application, or one with a component on it). Any other name leaves the line unassigned – nobody books costs on another team's application.
3. **The platform's own application** (_Catalogue → application → integrations_).
4. Otherwise the line is **unassigned** – shown per platform (_Unassigned_ on the platform, its column in the platform list).

A **service** has the costs of its applications (an application in two services counts fully for each – the services' totals are not added up). A **team** has the costs of the applications it owns (its own owning teams, or for an application without, its services' teams) and the unassigned costs of the platforms it owns. A **platform** has every line that belongs to it.

## Late and corrected figures

A source re-reads its window and replaces what it read before: a line that comes again replaces the stored one, a stored line of the window that does not come again is removed. **AWS and Snowflake values change for up to 72 hours and until the month is closed**, Confluent's lines are complete after 72 hours. A line whose charge period had ended before it was last read and whose amount changes (or that goes away) is a **correction**: it is marked and audited (`cost.corrected`, per month and currency, before and after, the number of lines). A line of a period still running (the current month so far, a day not over) simply changes.

## What people see

**Catalogue → Costs**: services, applications, teams or platforms – one row per scope and currency with _this month so far_, the _forecast_, the _last month_, the _change_ (forecast against the last month) and the _budget_ (platforms: what is unassigned). Table or cards, sortable, searchable; platforms without costs or a cost source are left out. Totals per currency for the platforms (services and teams overlap, so they have none). The service, application and platform pages have a _Costs_ button.

One scope shows per currency:

- the **12 complete months and the current one so far** as bars (the current month hatched; a table twin with `EffectiveCost` and `BilledCost`);
- the **forecast** of the current month: each platform's amount so far ÷ the days its lines cover × the days of the month, added up (sources lag by different times); from the 3rd day of a month;
- the **trend**: the Theil–Sen line through the complete months (the trend functions of the dashboards) – change per month, in percent of the average month, _steady_ or _uneven_; from five months;
- the **budget** and its state, the costs **by provider and service**, the **applications** (of a service, team or platform) or **platforms** (of an application) behind them, what is **unassigned** (platforms), and the sources with their last read.

## Budgets

A **monthly budget** per service, application or team, in one currency (_Set budget_ on the costs page):

- Who may change the service or application sets it (a team's: administrators); every change is audited (`cost.budget_changed`, before and after, the comment).
- **Raising** a budget – a higher amount, another currency, or no budget any more – needs a **step-up**: the control point `cost.budget` of the [assurance policy](ASSURANCE.md), on by default, like the AI budgets; lowering one never asks.
- A budget covers the **whole** service or team, also the applications a reader may not see. So whoever does not see every application of the service or team sees **only the budget's state** – _within budget_, _80 % reached_, _budget reached_ – and no use, percentage or forecast (the costs page, the list, the scorecard, the report section, `/api/v1` with `stateOnly: true`, the notice): the use minus what they see would be the costs of the others. Who sees every application (administrators, auditors, owners of a service whose applications they all see) gets the figures.
- At **80 %** and **100 %** of the month's budget a notice goes out once per budget, month and level – event **Cost budget** (`cost.budget`, in the app and by e-mail by default, [NOTIFICATIONS.md](NOTIFICATIONS.md)) – to the named owners and the members of the owning teams (of a team: its members), else to the administrators; a recipient who does not see every application reads the state only. A raised budget may notify again in the month.
- A budget stops nothing – it is showback.

## Monitor check

**Cost change** (`type: cost`, [MONITORS.md](MONITORS.md)): the costs of a scope against the period before.

```yaml
checks:
  - id: shop-costs
    name: Shop costs not rising
    type: cost
    scope: application # service, application, team or platform
    target: app_shop # its id
    period: month # month: last month against the month before; monthToDate: this month so far against the same share of the month before
    maxIncreasePct: 20 # up by more than 20 % …
    maxIncrease: '500' # … or by more than 500 (in the currency compared)
    currency: USD # empty: the one with the highest costs
    failAs: degraded
    noData: unknown
```

It runs with the monitor owner's rights – also on its schedule, when no one is signed in: the scope must be one they (and whoever saves the monitor) may see, and a service or team counts only the applications they may see. Everybody who may see the monitor reads its message and value, so amounts appear there only when the owner may see them **and** _Hide amounts from viewers_ is off; with the setting on, the check reports the change in percent only (a limit `maxIncrease` still applies: "more than the amount allowed").

## Dashboards and the API

- **Scorecard**: the part **Costs** – _attention_ when the month's costs reached the service's budget, _open_ at 80 % or with a forecast above it, _OK_ below; shown only once a service has a budget ([SCORECARD.md](SCORECARD.md)). A reader who does not see every application of the service gets the state only ([Budgets](#budgets)).
- **Report section _Costs_** of [report schedules](REPORTS.md) – per service, application, team or platform the costs of the report period against the period before, per currency, with the budget (platforms: unassigned); a monthly schedule is the monthly cost report. Collected with the owner's rights.
- **Built-in dataset _Costs_** (`costs.overview`): one row per scope and currency with this month, last month, forecast, change, unassigned, budget percentage and state; metrics `thisMonth`, `lastMonth`, `forecast` of the platforms in the currency with the highest costs. Published by the job at most hourly. Its rows name every scope, so **administrators and auditors** see it (like the AI usage) – also through `/api/v1/datasets/costs.overview`.
- **Public API** (read-only, [API.md](API.md)): `GET /api/v1/costs?scope=service|application|team|platform` (paginated) and `GET /api/v1/costs/{scope}/{id}` – with the token owner's rights.
- **Internal API**: `GET /api/costs`, `GET /api/costs/:scope/:id`, `PUT /api/costs/budgets`, `GET|PUT /api/costs/settings`, `GET|PUT /api/costs/platform/:id/source`, `POST /api/costs/platform/:id/read`, the imports and push tokens below `/api/costs/platform/:id/…`, and the push `POST /api/hooks/costs/:platformId`.

## Planning per service

Beside what the platforms cost per month, a service team plans **what it will spend in a fiscal year** on the systems and solutions it uses and on service and support – licences, cloud, support contracts, hardware – and records what it incurred ([ADR 0026](adr/0026-service-cost-planning.md)). Lightweight and internal to the service: **no person-hours or effort, no approvals, orders or invoice processing, no chargeback, no currency conversion**. The [monthly budget](#budgets) stays as it is and is independent: it watches the costs read per month; the plan covers everything a service spends per fiscal year.

**The fiscal year** starts in one month for the whole instance – _Costs → Settings → Fiscal year starts in_ (administrators, default January, audited as `cost.settings_changed`). A fiscal year is named by the calendar year it starts in: _FY 2026_ when it starts in January, _FY 2026/27_ when it starts in, say, October (October 2026 to September 2027). Changing the start month later reads every plan in the new boundaries (a line keeps its year and its position in it; an entry counts in the year its date falls in) – decide it once.

**Where:** _Catalogue → the service → Costs_ (with the Costs module on). Pick the fiscal year; _Add plan line_, _Add cost entry_, _Copy to FY …_, _Export (CSV)_ of the lines or the entries.

**Plan lines** – per service and fiscal year, at most 200:

| Field                | What                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title                | e.g. _Historian licences_                                                                                                                                                                |
| Category             | Licences, Cloud, Service and support, Hardware, Other                                                                                                                                    |
| For                  | Optional: an **application of the service**, a **system** one of its applications runs on, or – for a cloud line – a **platform** you may see; plus free text for the vendor or contract |
| Amount, currency     | A decimal with its ISO 4217 code                                                                                                                                                         |
| Cadence              | **Yearly** (the year's amount, spread evenly over the 12 months), **monthly** (every month), **once** (in one month of the year)                                                         |
| Contract end/renewal | Optional; shown under _Renewals in the next 90 days_                                                                                                                                     |
| Note                 | Free text                                                                                                                                                                                |

**Cost entries** – a date, an amount (negative for a credit note) and a currency, optionally a plan line of the same fiscal year and currency (without one the entry is **unplanned**), an application or system of the service, a **reference** (invoice or order number) and a note. At most 2,000 per service and fiscal year.

**The year view**, per currency (amounts are never converted) and per line:

- **Planned (year)** and **planned to date** (up to and including the current month);
- **incurred to date**: entries dated up to today – and, for a matched cloud line, the costs read;
- **expected (year)**: for a _monthly_ line month by month – the months that are over as incurred, the current month and those to come as booked if something is booked for them, else as planned; for a _yearly_ or _one-off_ line at least the plan (what is booked counts against it – an annual invoice paid early is not expected again for the remaining months);
- the **difference** (expected − planned): with a sign, in a quiet orange when more is expected than planned;
- a **month chart** of planned and incurred with a table twin, the lines **by category** or **by application or system**, **renewals** in the next 90 days and the **unplanned** entries. On a phone the lines and entries are cards.

**The costs read.** The cloud and platform costs the cost model already links to the service's applications appear as **cloud and platform (read)** per month. A plan line of category **Cloud** for an **application** or a **platform** takes those costs: the months that are over count as incurred, the current month with its [forecast](#what-people-see), the months to come as planned. Each cost belongs to one line at most – the oldest line for its application and currency, else the oldest for its platform and currency (a platform: the share of the service's applications); a second line for the same shows _Costs read: other line_ and counts only its entries. What no line takes stays in the row _cloud and platform (read)_, expected at the current month's forecast for the months to come. A line for a system is not matched.

**Copy to the next fiscal year** copies every line (refused when the next year already has lines); a renewal date before the new year moves on by a year, a one-off payment keeps its month in the year; entries are not copied.

**Who:** who may change the service (its editors, not while it is archived) changes its plan and entries; who may see the service reads them. Every change is audited – `cost.plan_line_added`, `cost.plan_line_changed`, `cost.plan_line_removed` (its entries stay, as unplanned), `cost.plan_copied`, `cost.entry_added`, `cost.entry_changed`, `cost.entry_removed`. **No step-up**: unlike raising a budget (which notices and the scorecard measure against), a plan commits nothing, notifies nobody and stops nothing – it is the team's own planning, often changed line by line in one session; the audit trail records each change. Amounts follow _Hide amounts from viewers_. **The costs read follow the rule of the module**: a reader who does not see every application of the service gets no cloud figures – only a note that costs were read – and matched lines show their entries only.

**Team rollup:** a team's costs page (_Costs → Teams → the team_) sums the plans of the team's services per fiscal year and currency. A service of two teams counts for both (marked _also another team's_), so the teams' sums are not added up.

**Elsewhere:** scheduled exports write every service's plan lines and entries of a fiscal year as CSV to S3 ([EXPORTS.md](EXPORTS.md)); `GET /api/v1/services/{serviceId}/cost-plan?year=` ([API.md](API.md)); the built-in dataset **Cost plans** (`costs.plans`: one row per service and currency of the current fiscal year with planned, to date, incurred, expected, difference and unplanned; status _warning_ when more is expected than planned; administrators and auditors, published at most hourly); the MCP tool `get_service_cost_plan` ([MCP.md](MCP.md)); internal routes `GET /api/costs/plans/:serviceId?year=`, `GET …/export?year=&what=plan|entries`, `POST …/lines`, `PUT|DELETE …/lines/:lineId`, `POST …/copy`, `POST …/entries`, `PUT|DELETE …/entries/:entryId`, `GET /api/costs/team-plans/:teamId?year=`.

## Who sees costs

- A scope is only reachable for those who may see it: a hidden service, application, team or platform answers like a missing one; lists, breakdowns, reports and the check neither name nor count it. A service or team covers only the applications you may see – one you may not see is left out of its totals; a platform's total is its bill, so there the applications (or, for an application, the platforms) you may not see are one row _Others you may not see_ without a name; sources you may not see are left out. Budgets always use the whole service or team – so a reader who does not see all of it gets only the budget's state, never its figures ([Budgets](#budgets)); the totals never reveal hidden applications by subtraction.
- **Amounts**: administrators and auditors; the named **owners** and the members of the **owning teams** of a service or application; the members of a team; who may manage a platform or is a member of its owning teams. Everybody else who may see the scope sees the amounts too – unless an administrator turns on **Hide amounts from viewers** (_Costs → Settings_): then they see percentages and budget states only. Changing the setting is audited (`cost.settings_changed`).
- Viewers see no platforms (as everywhere); auditors see every platform's costs.

## Decisions

The open questions of #226, decided for 0.9.0:

- **Costs without a tag or link are shown as _unassigned_ per platform** – not left out: a platform's total is its bill, and what nobody claims is visible where it can be fixed (a tag, a component, the platform's application).
- **No currency conversion in this step.** Totals are per currency; a later step may add fixed monthly rates set by an administrator.

## Demo and tests

The demo starts the fiscal year in October and gives _Online shop (demo)_ and _Plant monitoring (demo)_ a plan for the current fiscal year with a few entries – a cloud line for the webshop matched with the AWS costs read, a payment licence, a cluster support subscription for the system _k8s-shop-01 (demo)_, historian licences and support, an edge gateway refresh, and unplanned entries; products and vendors are invented.

The demo turns on the cost sources of _AWS (demo)_ (Cost Explorer by tag `application` and service: _Webshop_ and _CRM_, the rest untagged), _Snowflake (demo)_ (`USAGE_IN_CURRENCY_DAILY`; the fallback answers too), _Confluent Cloud (demo)_ (a new demo platform: the Costs API with the cluster `lkc-demo1` – variable `confluentClusterId` of _Kafka (demo)_ – a connector and Stream Governance) and _LLM gateway (demo)_ (the usage log), and reads them once. The mocks answer like the real APIs (`server/src/mock/mockAws.ts`, `mockSnowflake.ts`, `mockConfluent.ts`) and use `req.originalUrl` where they check signatures, so they work below a base path.

Tests: `server/test/costs.test.ts` (decimals, the CSV reader, FOCUS import, preview, replace with corrections, rights, push tokens), `server/test/costs-sources.test.ts` (each connector against its mock, corrections, the job), `server/test/costs-budgets.test.ts` (budgets and their step-up and notices, the scorecard part, the check, the report section, the dataset, `/api/v1/costs`), `server/test/costs-access.test.ts` (an owner who may not see every application: the scheduled check, linking by name in imports and pushes, budgets as state only, amounts in the check, a large file); `server/test/cost-plans.test.ts` (planning per service: fiscal years, lines, cadences, entries, the costs read, visibility, CSV, `/api/v1`, MCP, the dataset, the team rollup); `e2e/costs.spec.ts` and `e2e/cost-plans.spec.ts` on a desktop and a phone with axe.
