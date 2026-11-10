# 0026. Service cost planning

- **Status:** Accepted
- **Date:** 2026-11-10
- **Since:** 0.16.0

## Context

The Costs module (0.9.0, [COSTS.md](../COSTS.md)) shows what services, applications, teams and platforms **cost per month** – read from AWS, Snowflake, Confluent Cloud, AI gateways and FOCUS files, mapped to applications, with monthly budgets, a forecast of the current month and the rule _who does not see every application of a service sees only the state_. It answers "what does the cloud cost us?". It does not answer what a service team asks once a year: **what do we plan to spend on the systems and solutions we use and on service and support – licences of a historian, a support contract, a hardware refresh – and how does that compare with what we incurred so far in the fiscal year?**

The owner's words: _"The cost tracking should be lightweight and is only service internal tracking, so not meant to include something like man hours or for actual controlling purposes. Services have planned costs for systems, solutions they are using or service/support and wanna know what they occur over a fiscal year / planning period. (Fiscal year may not be calendar year)."_

Two questions were decided by the owner before building:

1. **One fiscal year start for the whole instance** – not per team or per service.
2. **Planning per service only**, with the possibility to **map plan lines and cost entries to an application or system of the service**.

Forces:

- Many of these costs never pass through a cost source: licences, support contracts and hardware are invoiced once or monthly by vendors Steward does not read. They have to be entered – few lines a year, by the service team.
- Some planned costs _are_ read already: the cloud and platform costs the cost model links to the service's applications. Planning them again by hand and ignoring the read figures would show two truths.
- The visibility rule of the cost model must hold: the costs read for a service cover all of its applications, so a reader who does not see every one of them must not get figures from which the hidden ones could be subtracted.
- It must stay small: no workflow, no approvals, no finance system.

## Decision

**Plan lines and cost entries per service and fiscal year, part of the Costs module, set against the costs already read.** `server/src/costs/plans.ts` (service, year view, CSV, team rollup), `shared/src/costPlans.ts` (fiscal year arithmetic, inputs, types), routes in `server/src/costs/routes.ts`, `/api/v1/services/{serviceId}/cost-plan` in `server/src/costs/api-v1.ts`, the web tab `web/src/components/costs/ServicePlan.tsx`.

### Fiscal year

- One setting for the instance: `fiscalYearStartMonth` (1–12, default 1) in the cost settings (_Costs → Settings_, administrators, audited as `cost.settings_changed`). A client that leaves it out keeps the stored value.
- A fiscal year is named by the calendar year it **starts** in: `FY 2026` when it starts in January, `FY 2026/27` otherwise (start October: October 2026 to September 2027). Months are calendar months (`YYYY-MM`) and days calendar dates; _today_ and the current month of the year view are those of the instance's time zone (`TZ`), so an entry dated today counts from local midnight (the costs read keep the cost model's UTC billing months). Helpers: `fiscalYearOf`, `fiscalYearMonths`, `fiscalYearBounds`, `fiscalYearLabel`, `shiftMonth`, `isCalendarDate` – pure string arithmetic, no time zones.

### Data model (migration `costs-002-service-plans`)

- `cost_plan_lines`: `service_id`, `fiscal_year`, `title`, `category` (`licence`, `cloud`, `support`, `hardware`, `other`), what it is for – `target_kind`/`target_id` (an application or system **of the service**, or a platform) and/or `vendor` (free text: vendor or contract) –, `amount` (whole millionths, like the cost model) and `currency`, `cadence` (`yearly` spread evenly over the 12 months so that they add up exactly, `monthly`, `once`) with `once_index` (the position 0–11 of the payment's month in the fiscal year), `renewal_date` (contract end or renewal), `note`, created and updated by and at.
- `cost_entries`: `service_id`, `entry_date`, `amount` (negative for a credit note) and `currency`, `plan_line_id` (none: **unplanned**), `target_kind`/`target_id`, `reference` (invoice or order number), `note`, created and updated by and at.
- Validation: the target must be an application of the service, a system one of its applications runs on, or a platform the person may see; an entry's plan line must belong to the same service, to the fiscal year of the entry's date and have the same currency; a one-off payment's month must lie in the line's fiscal year. Limits: 200 plan lines and 2,000 entries per service and fiscal year. Inputs are strict: unknown fields such as `hours` are refused.
- The person columns are history (`HISTORY_COLUMNS`); both tables move with migration packages.

### The year view

Per line and per currency (never converted):

- **Planned (year)**, **planned to date** (up to and including the current month), **incurred to date** (entries dated up to today, plus the costs read for a matched cloud line), **expected for the year** and the **difference** (expected − planned), shown quietly (a sign and orange text when more is expected than planned).
- **Expected**: for a **monthly** line and for a cloud line matched with the costs read, month by month – what was incurred in the months that are over; for the current month and those to come what is booked for them (a matched cloud line: the current month's forecast of the cost model), else the plan. For a **yearly** or **one-off** line, at least the plan: `max(planned, booked)` – an annual invoice paid in the third month must not be expected a second time over the remaining months.
- **The costs read** (`cloud`): a plan line of category `cloud` for an application or a platform takes the costs the cost model links to it (for a platform: the share of the service's applications). Each cost belongs to one line at most – the oldest line for its application and currency, else the oldest for its platform and currency (`read: matched`; a later line for the same is `taken`). What no line takes is shown as **cloud and platform (read)** per currency, expected as the months that are over, the current month's forecast and the months to come at that rate.
- **Unplanned**: entries without a plan line of the year, per currency.
- A month chart (planned and incurred) with a table twin; lines grouped by category or by application/system; **renewals** of the service's lines in the next 90 days; cards on phones.
- **Copy to the next fiscal year** copies every line (refused when the next year has lines already); a renewal date before the new year moves on by a year; entries are not copied.
- A **team rollup** sums the plans of the team's services per fiscal year and currency; a service of two teams counts for both, marked as such.

### Permissions and visibility

- Who may change the service (its editors, not while it is archived) changes its plan and its entries. Audited: `cost.plan_line_added`, `cost.plan_line_changed` (before and after), `cost.plan_line_removed` (with the entries that became unplanned), `cost.plan_copied`, `cost.entry_added`, `cost.entry_changed`, `cost.entry_removed`.
- **No step-up.** Raising a monthly budget asks for one (control point `cost.budget`), because a budget is what notices and the scorecard measure against. A plan commits nothing, notifies nobody and stops nothing: it is the service team's own planning, changed often in a planning session. A step-up per line would make it heavy without protecting anything a second person relies on; the audit trail records every change.
- Who may see the service reads its plan and entries. Amounts follow _Hide amounts from viewers_ as everywhere in the module.
- **The costs read follow the existing rule**: a reader who does not see every application of the service gets no cloud figures – no read months, no read row, matched lines count their entries only (`read: hidden`) – and only learns that costs were read (`cloud: hidden`). A target the reader may not see is shown without its name.
- Off with the Costs module (its routes, the tab, the dataset, the MCP tool).

### Interfaces

Internal: `GET /api/costs/plans/:serviceId?year=`, `…/export?year=&what=plan|entries` (CSV, formulas defused), `POST …/lines`, `PUT|DELETE …/lines/:lineId`, `POST …/copy`, `POST …/entries`, `PUT|DELETE …/entries/:entryId`, `GET /api/costs/team-plans/:teamId?year=`. Public: `GET /api/v1/services/{serviceId}/cost-plan?year=`. Built-in dataset `costs.plans` (administrators and auditors, like `costs.overview`). MCP tool `get_service_cost_plan`.

### Scope boundaries

- **No person-hours or effort** – nothing in the model counts time; inputs with such fields are refused.
- **No approvals, orders or invoice processing** – an entry is a note that money was spent, with a reference to where the invoice lives.
- **No chargeback** between departments, **no currency conversion** (totals per currency), no controlling: Steward is not the system of record for finance.
- The **monthly budget** of the Costs module is unchanged and independent: it watches what the cost model reads per month; the plan covers everything a service spends per fiscal year.

### Alternatives

- **A FinOps tool** (and Steward only links to it): good for cloud optimisation, but it does not hold licences, support contracts and hardware of a service, and the service team would maintain a second place. Rejected – the Costs module is already _showback, not FinOps_.
- **ERP integration** (read purchase orders and invoices): heavy, different in every organisation, and against "lightweight, service internal". Rejected; a reference field links an entry to the ERP document by hand.
- **Fiscal years per team or per service**: more flexible, but a team rollup and the dataset across services with different years would be meaningless. Rejected by the owner.
- **Plans per application**: applications belong to several services; their costs would be counted per service anyway, and a team plans by service. Rejected by the owner; a line or entry can name an application or system of the service instead.

## Consequences

- A service team sees in one place what it planned for the year, what it spent – including the cloud costs Steward already reads – and what it will likely end up with, and which contracts are due for renewal.
- Changing the fiscal year start later re-reads every plan in the new year boundaries: the lines keep their fiscal year and their position in it; entries fall into the year their date is in. The setting says so; it is best decided once.
- The costs read are matched with simple rules (oldest line per application, then per platform, same currency). Splitting one application's cloud costs between several lines is not possible; a second line for the same application counts only its own entries.
- Tests: `server/test/cost-plans.test.ts` – the fiscal year arithmetic (start months 1, 4, 10, 12, leap years, month boundaries), plan CRUD, limits and copy, the cadences and "expected", entries and unplanned ones, matching the costs read with the forecast, the visibility of the cloud figures, hidden amounts, permissions, audit, CSV, `/api/v1`, MCP, the dataset, the team rollup and the module switch; the new tables on PostgreSQL; `e2e/cost-plans.spec.ts` sets the fiscal year start, adds lines (one mapped to an application) and entries (one unplanned) and checks the year view on a desktop and the cards on a phone.

### Decided while building (conservative choices)

- **Amounts and _Hide amounts from viewers_**: the plan's amounts follow the module's setting (viewers see the lines without amounts while it is on).
- **Hidden cloud costs**: the reader learns only that cloud costs were read for the service (`cloud: hidden`), not how many applications are hidden from them.
- **Yearly and one-off lines expect at least their plan**; monthly lines are projected month by month.
- **System targets are not matched** with the costs read (a system's platform could be, later); platform targets count only the service's applications' share.
- **Deleting a plan line keeps its entries** as unplanned (audited with their number); a line with entries keeps its currency.
- **Copy refuses a fiscal year that has lines** – no merge.
- **The demo** sets the fiscal year start to October; the instance default stays January.

We revisit this if teams need a plan per application across services, a second planning period per year (a forecast round), or currency conversion for totals.
