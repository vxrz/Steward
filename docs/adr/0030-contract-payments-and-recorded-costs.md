# 0030. Contract payments, commitments and recorded costs

- **Status:** Accepted (owner decision 2026-11-11) – the scope was set by the owner and every open question was taken as recommended (see _Decided (November 2026)_). To be built in 0.18.0
- **Date:** 2026-11-11
- **Since:** 0.18.0 ([ROADMAP.md](../ROADMAP.md#next))

## Context

Since 0.16.0 a service plans what it will spend in a fiscal year and records what it incurred ([ADR 0026](0026-service-cost-planning.md), [COSTS.md](../COSTS.md#planning-per-service)): plan lines with a cadence – _yearly_ (spread over the 12 months), _monthly_ (every month), _once_ (in one month) – and cost entries entered one by one. Since 0.17.0 suppliers have contracts with a term, a notice period, a renewal, SLA and RTO/RPO, and a plan line can name the contract it pays for (`cost_plan_lines.supplier_contract_id`, [ADR 0029](0029-iso-27001-support.md), [SUPPLIERS.md](../SUPPLIERS.md#contracts-and-the-notice-by-date)).

What service teams run into with real contracts:

- **Multi-year contracts do not fit one fiscal year.** A three-year support contract from February, billed monthly, with +3 % from the second contract year, touches four fiscal years when the year starts in October – the first and the last only in part. Today a monthly line always counts all twelve months, so the team plans by hand with _once_ lines or wrong totals, and repeats it every year.
- **"Copy to next fiscal year" continues what has ended.** It copies every line, also those of a contract that ends in March.
- **Nobody sees what is already owed.** The plan shows a year; it does not say what the contracts commit the service to until they end, nor that a notice-by date passes before the next year is planned – after it, the next term is owed whether planned or not.
- **Prepaid multi-year licences** are paid in one year and cover three; the plan has no place to say so, and the next years look unplanned.
- **Entering incurred costs is tedious.** Invoices arrive as lists from the ERP or the supplier's portal; entering 40 rows one by one is where planning stops being used. A monthly contract invoice is the same amount every month, yet it is typed again each time. And an entry cannot say which supplier or contract it was for.

The owner's boundaries are those of ADR 0026, unchanged: **lightweight and internal to the service** – no person-hours, no approvals or purchase orders, no invoice processing, no chargeback, no currency conversion, no accounting. Steward is not the system of record for finance.

## Decision

**A contract gets payment schedules; from them Steward proposes the plan lines of each fiscal year the contract covers, a person confirms them, and Steward shows what is still owed. Plan lines can cover part of a year. Incurred costs can be imported from CSV or booked from a plan line in one step – always by a person.** All of it belongs to the Costs module; contracts stay core records of suppliers.

Code: `shared/src/costPlans.ts` (part-year months, the quarterly cadence), a new `shared/src/costContracts.ts` (schedule arithmetic: payment dates, contract years, proposals per fiscal year, commitments – pure functions, no time zones, like the fiscal-year helpers), `shared/src/costs.ts` (the minor-unit table); `server/src/costs/plans.ts` (lines, entries, copy, book), new `server/src/costs/schedules.ts` (schedules, proposals, _Update lines_), `server/src/costs/commitments.ts` (the commitments read, the dataset, the export part), `server/src/costs/entry-import.ts` (the CSV import on the reader of `server/src/costs/csv.ts`); web `web/src/components/costs/ServicePlan.tsx`, new `ContractPayments.tsx`, `Commitments.tsx`, `EntryImport.tsx`, and the contract dialog of `web/src/pages/SupplierDetail.tsx`.

### 1. Plan lines for part of a year (all lines)

- Every **monthly**, **quarterly** and **yearly** line gets an optional **from month** and **to month** within its fiscal year (_Only part of the year_ in the form; none: the whole year). Stored as positions 0–11 in the fiscal year (`from_index`, `to_index`), like the month of a one-off payment – so a line keeps its position when the fiscal-year start changes, as ADR 0026 decided for `once_index`.
- **Monthly**: the amount in each month from–to. **Yearly**: the amount is what the line costs in this fiscal year, spread evenly over the months from–to (not a twelve-month price cut down – the person, or the proposal, enters the amount for the months the line covers). **Once**: unchanged (its month).
- A new cadence **quarterly**: the amount every third month, starting at the from month (default the first month of the year), up to the to month. Needed for quarterly billing; useful for hand-made lines too.
- _Planned_, _planned to date_ and _expected_ follow the months: a part-year monthly or quarterly line is projected month by month as today, with nothing planned outside its months (an entry booked there still counts).
- Existing lines are unchanged: no from and to means the whole year.

### 2. Payment schedules on contracts

A contract gets up to 20 **payment schedules** (_Payments_ in the contract dialog; German _Zahlungsplan_). Each one:

| Field                    | What                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title                    | e.g. _Base fee_, _Setup_, _Additional users_                                                                                                                                                                                                                            |
| Paying service           | **One service** whose cost plan gets the lines. A contract paid by two services has a schedule per service, each with its own amount – no shares, no splitting                                                                                                          |
| Category, for            | As on plan lines (default _Service and support_); optionally an application or system of the paying service                                                                                                                                                             |
| Amount, currency         | The amount per payment in contract year 1, an ISO 4217 currency – the currency of every line made from it                                                                                                                                                               |
| Billing                  | **Monthly**, **quarterly**, **yearly**, **once**, or **dated payments** (a list of date, amount and optionally _covers until_)                                                                                                                                          |
| First payment            | A date (default: the start); later payments fall on the same day every 1, 3 or 12 months – on the last day of a shorter month                                                                                                                                           |
| Start, end               | Default: the contract's start, and the end **follows the contract** – its end date; for an automatic renewal it runs on term by term. An own end date (_planned until_) caps it; for a contract with a fixed end, never past that end                                   |
| Amount per contract year | Optional amounts for contract years 2–10 (a year without one takes the year before). Contract years count from the start in twelve-month steps. The form fills them from _+ x % per year_, rounded to the currency's minor units; what is stored is what the line shows |
| Note                     | Free text                                                                                                                                                                                                                                                               |

A payment counts in the **month of its date** – no pro rata for part months (a supplier that bills the first month pro rata is entered with dated payments). A schedule's amounts are what the contract says; Steward computes payment dates and amounts from them, nothing else.

**Example.** Monthly 1,000.00 EUR from 1 February 2026 to 31 January 2029, +3 % per contract year, fiscal year from October: FY 2025/26 gets one monthly line February–September at 1,000.00; FY 2026/27 two lines, October–January at 1,000.00 and February–September at 1,030.00; FY 2027/28 October–January at 1,030.00 and February–September at 1,060.90; FY 2028/29 October–January at 1,060.90.

### 3. Contract lines in the cost plan

- **Proposed, confirmed by a person, per fiscal year.** _Service → Cost plan_ for a fiscal year lists the payment schedules of the service with payments in that year and no lines for it yet (_Contract payments to plan_), with the lines each would add. _Add to plan_ adds the selected ones in one step. Nothing is created without a person.
- **What a proposal adds**, per schedule and fiscal year – one line per contract-year part, so a price change inside the fiscal year gives two lines: monthly billing → a monthly line with from and to; quarterly → a quarterly line; yearly → a _once_ line in the month of the payment (the invoice is paid then, see part 4); once → a _once_ line; dated payments → one _once_ line per payment in the year. Title _contract – schedule_, the schedule's category and target, the supplier and the contract, the amount and currency. The line remembers its schedule (`schedule_id`) and the months it was made from (`schedule_basis`).
- **Kept in sync, never silently.** When the contract or the schedule changes later – an end date, a renewal, an amount, the fiscal-year start – Steward compares the proposal now with the months the lines were made from. Lines of the current and later fiscal years whose proposal changed show _Contract changed_ (_Vertrag geändert_) with the difference; _Update lines_ shows each line before and after and applies the selected changes in one step (a part that is gone removes its line – its entries become unplanned, listed first; a new part adds one). Fiscal years that are over are never offered: history stays as planned. A line changed by hand keeps its schedule; _Update lines_ shows the hand-made value as _before_. _Unlink from contract_ makes it an ordinary line without hints.
- **Copy to next fiscal year** works with contracts: a line made from a schedule is not copied – the schedule's proposal for the new year is added instead (if it has payments there and is not planned there yet); a line that names a contract without a schedule (0.17 style) is left out when the contract ends before the new year, copied with _to month_ set to the end's month (monthly and quarterly lines) or copied and marked _Contract ends …_ (yearly and one-off lines) when it ends inside it, and copied as today otherwise. Copy is refused only when the next year has lines that were not made from a schedule – confirming a contract's next year early must not block it. The result lists what was copied, proposed, shortened and left out.
- **Renewals** of a contract line are the contract's notice-by date and term end, not the line's own _renewal_ field (hidden for contract lines).
- **Double planning**: a contract with a schedule and a hand-made line for the same contract in the same year shows _Two lines for this contract_ – a hint, not a block.

### 4. Prepaid payments

A payment that covers more than its month – a yearly or one-off payment of a schedule, a dated payment with _covers until_, or any _once_ line with the new optional **covers from/to** dates – is planned and counted **in the fiscal year it is paid**, with a note _Covers 1 Feb 2026 – 31 Jan 2029_. In the later fiscal years it covers, the cost plan shows it as a quiet row _Prepaid in FY 2025/26_ with its amount, not counted in planned, incurred or expected – so the team sees why nothing is planned there. **No amortisation, no accruals**: Steward shows cash by the year it leaves, as the plan always has.

### 5. Commitments

**What is owed** (German _Verpflichtungen_), per schedule, from the schedule's payments dated **today or later** (instance time zone):

- **to contract end**: until the schedule's end – its own end date, else the contract's end date; for a contract that renews automatically or has no end date, until the earliest exit (no later end is agreed);
- **to earliest exit**: until the end of the term that follows the next notice-by date (`contractDates(…).termEnd` of `shared/src/suppliers.ts`) – for a contract with a fixed end or renewed by agreement its end date; for a contract without an end date today plus its notice period. Both are capped by the schedule's end.

Entries are not subtracted: a commitment is what the contract says is still to pay, not what is unbooked. Both figures are shown per fiscal year and in total, per currency. With the example of the supplier documentation (ends 31 January 2027, 90 days' notice, renews by 12 months), a schedule of 1,000.00 EUR on the first of each month until 31 January 2029 owes on 11 November 2026 26,000.00 EUR to contract end and 14,000.00 EUR to the earliest exit (31 January 2028, notice by 2 November 2027).

**Notice warning:** _Notice by 2 Nov 2027 – FY 2027/28 not planned yet_ when a contract's next notice-by date is ahead and the fiscal year in which its next term would start has no plan lines of the paying service – once that date passes, the next term is owed whether planned or not. Orange within 90 days, like the supplier's notice state.

**Where:**

- **Service → Cost plan**, section _Contracts_: the contracts the service pays, per schedule the billing, the next payment, owed this fiscal year (remaining), later years, to contract end and to earliest exit, the notice-by date with its warning, _Contract changed_ hints and the months _Not booked_ (part 6). _Add payments_ opens the schedule dialog with the service filled in.
- **Costs → Commitments** (`/costs/commitments`, a view beside services, teams and platforms): every schedule of the services the reader may see, grouped by supplier, service or team, columns for the current and the next four fiscal years and _later_, totals per currency, the warnings first; filters team, service, supplier, _ending within … days_; CSV export.
- **The supplier page**: per contract its schedules and what they owe (services the reader may see), and the supplier's total per currency; and what was incurred per fiscal year from entries that name the supplier (part 6), as sums – entries are not listed under _Used by_.

### 6. Recording incurred costs

**Supplier and contract on cost entries.** An entry gets a supplier and contract picker; on a plan line both default to the line's. Same rules as plan lines: a supplier the reader may not see is shown without its name, a linked one is kept on save, an archived one cannot be chosen again.

**Book** (_Buchen_) on a plan line with a planned amount in a month – monthly, quarterly and one-off lines and contract lines; not yearly lines, whose months are a spread, not a payment. One action opens a prefilled entry: the month (default the current one, or an earlier month of the year without an entry on the line), the date (the schedule's payment date in that month, else today for the current month and the month's last day for an earlier one), the planned amount and currency, the line, its supplier, contract and target; reference and note optional; Enter saves. A line with an entry in that month already asks first (_Already booked for October: 1,000.00 EUR – book again?_). The plan marks payments of the months that are over and of the current month with no entry on their line as _Not booked_. **No automatic booking**: an entry says money was spent, and that is a person's statement.

**A reminder instead**: a new notification event `cost.booking_due`, **off by default**, opted in per person like every event: on the third day of a month, to the owners of a service who opted in, the contract payments of the previous month that have no entry yet – one message per service, at most once a month.

**CSV import of entries** (_Import entries (CSV)_ on the cost plan, German _Kostenbuchungen importieren (CSV)_) for invoice lists and ERP exports:

1. **Upload** a CSV file: UTF-8 (a byte-order mark is fine), separator comma, semicolon or tab (detected as for FOCUS files), a header row.
2. **Map columns**: date, amount, currency (or one currency for the file), reference, note; optionally plan line (title or id), supplier (name or a spelling), contract (title or number), application or system (name). The **date format** is chosen, not guessed – `YYYY-MM-DD`, `DD.MM.YYYY`, `DD/MM/YYYY` or `MM/DD/YYYY` – and the **decimal separator** (`.` or `,`; the other one is read as a thousands separator). The last mapping of the service is offered again.
3. **Preview**: every row with what it becomes – the fiscal year, the plan line (named, or the only line of the named contract in that year and currency, else _unplanned_), the supplier and contract – and its **problems**: no or impossible date, not a number, more decimals than the currency has, unknown currency, a plan line of another year or currency, a supplier or target that is unknown or that the person may not see, over a limit, a **duplicate**. The preview stores nothing; the server reads the file again on import.
4. **Import** the rows without problems (duplicates are left out unless ticked one by one) – in one transaction, all or nothing, within the limit of 2,000 entries per service and fiscal year. The import is kept as a record (file name, SHA-256, rows, mapping, who and when); its entries carry it; _Remove import_ removes those of its entries that are still there, in one step. A file with the same SHA-256 imported before says so in the preview.

**Duplicate rule:** a row is a duplicate when the service has an entry – or an earlier row of the file has one – with the same **reference** (letter case and surrounding spaces aside, not empty), **date**, **amount** and **currency**. A row without a reference cannot be checked and is marked _No reference_, not left out.

### Amounts and currencies

- **Minor units.** 0.18.0 adds the ISO 4217 minor units to `shared/src/costs.ts` (`CURRENCY_MINOR_UNITS`: 0 for JPY, KRW, ISK and the others without cents; 3 for BHD, JOD, KWD, OMR, TND and the others with three; 2 otherwise). Amounts are shown with their currency's decimals (the review follow-up _currencies without cents_). Everything this record computes – amounts per contract year from a percentage, the spread of a yearly line, proposals, _Book_ – is rounded half away from zero to the currency's minor units, and a spread adds up to the line's amount exactly in minor units. Amounts are still stored as whole millionths; the cost model keeps reading fractional costs.
- **Currency**: one currency per schedule; every line made from it and every booking from such a line has that currency. A contract billed in two currencies has two schedules. **No conversion**, as in ADR 0026: totals are per currency.

### Data model (additive migrations)

`server/src/migrations/costs.ts`, on SQLite and PostgreSQL; existing rows keep their meaning:

- `costs-003-contract-payments`:
  - `cost_schedules`: `id`, `contract_id`, `service_id`, `title`, `category`, `target_kind`, `target_id`, `amount` (micros), `currency`, `billing` (`monthly`, `quarterly`, `yearly`, `once`, `dates`), `first_payment_on`, `starts_on` (null: the contract's start), `ends_on` (null: follows the contract), `year_amounts` (JSON, contract years 2–10, micros), `payments` (JSON for `dates`: date, amount, covers until), `note`, created and updated by and at. Indexes on `contract_id` and `service_id`.
  - `cost_plan_lines`: `from_index`, `to_index` (null: the whole year), `schedule_id`, `schedule_part` (the contract year or payment the line stands for), `schedule_basis` (JSON: the twelve month amounts it was made from), `covers_from`, `covers_to`. The cadence `quarterly` needs no column.
- `costs-004-entry-imports`:
  - `cost_entries`: `supplier_id`, `supplier_contract_id`, `import_id`; an index on `(service_id, reference)` for the duplicate check.
  - `cost_entry_imports`: `id`, `service_id`, `file_name`, `sha256`, `rows`, `added`, `skipped` (JSON, by reason), `mapping` (JSON), created by and at, removed by and at.
  - `cost_booking_reminders`: service, month, sent at – sent once.

Person columns are history (`HISTORY_COLUMNS`); the new tables move with migration packages and backups. Removing a contract removes its schedules (the dialog lists the paying services first); lines made from them keep their amounts and supplier and become ordinary lines. Merging suppliers moves contracts with their schedules. Archiving a supplier keeps them – the money is still owed.

### Permissions, visibility and audit

| Action                                         | Who                                                                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| See a schedule, contract lines and commitments | who may see the paying service (Costs module on); amounts by _Hide amounts from viewers_                                            |
| Add, change, remove a payment schedule         | who may change the contract (designers, administrators, the supplier's owners), or may edit the paying service and see the supplier |
| Confirm proposals, _Update lines_, copy        | who may change the service (its editors, not while it is archived)                                                                  |
| Book, import entries, remove an import         | who may change the service                                                                                                          |

- **Visibility**: a schedule exists for a reader only through its paying service – lists, totals and the supplier page neither name nor count schedules of services the reader may not see. A reader who sees the service but not the supplier sees the schedule as _a contract of a supplier you may not see_ – amounts, no supplier, contract title or dates. Team scope applies to services and suppliers as before.
- **Sessions**: schedules, _Add to plan_, _Update lines_, _Book_ and the import are new writes for people and need a signed-in session, like supplier writes (ADR 0029 decision 9). The existing entry and line routes keep accepting API tokens, as in 0.16.
- **No step-up**, as ADR 0026 decided for plans: a schedule commits nothing Steward enforces; the audit trail records every change.
- **Audit**: `cost.schedule_added`, `cost.schedule_changed` (before and after), `cost.schedule_removed` (also when its contract goes) – on the service, naming supplier and contract; `cost.contract_lines_added` (the lines of a confirmed proposal), `cost.contract_lines_updated` (before and after per line); `cost.plan_copied` with what was copied, proposed, shortened and left out; `cost.entry_added` with `via: "book"` for a booking; `cost.entries_imported` (file name, SHA-256, mapping, rows read, added, skipped by reason, sums per currency – one entry per import, not per row); `cost.import_removed`. Existing actions are unchanged.

### Interfaces

- **Internal**: `GET|POST /api/costs/schedules?contractId=|serviceId=`, `PUT|DELETE /api/costs/schedules/:id`; `GET /api/costs/plans/:serviceId/proposals?fiscalYear=`, `POST …/proposals` (confirm), `POST …/contract-updates` (_Update lines_), `POST …/lines/:lineId/book`, `POST …/entries/import/preview`, `POST …/entries/import`, `GET …/imports`, `DELETE …/imports/:importId`; `GET /api/costs/commitments?teamId=&serviceId=&supplierId=`, `…/export`.
- **Public, read-only**: `GET /api/v1/services/{serviceId}/cost-plan` gains the lines' `fromMonth`, `toMonth`, `quarterly`, `coversFrom`, `coversTo`, `schedule` (id, contract, `changed`), the entries' `supplier`, `supplierContract` and `importId`, and the service's commitments; `GET /api/v1/cost-commitments` (paged; filters `serviceId`, `teamId`, `supplierId`, `currency`); `GET /api/v1/suppliers/{supplierId}` gains per contract its `paymentSchedules` (services the reader may see; amounts by the module's rule).
- **MCP**, read-only: `get_service_cost_plan` with the same fields, a new `list_cost_commitments`. Assistants do not book, import or confirm.
- **Dataset** `costs.commitments`: one row per schedule of a service that is not archived, with owed this fiscal year, next fiscal year, to contract end and to earliest exit, the notice-by date, status _warning_ while the notice warning applies; administrators and auditors, published at most hourly, like `costs.plans`.
- **Scheduled exports** ([ADR 0027](0027-backup-contents-and-exports.md)): the part _Cost plans_ gains the new line and entry columns and a file `commitments.csv` (formulas defused).
- **The ISMS summary** stays as it is: it lists notice-by dates already, and amounts do not belong in an ISMS report.
- **German texts** in formal _Sie_; terms: _Zahlungsplan_, _Verpflichtungen_, _frühester Ausstieg_, _Buchen_, _Nicht gebucht_, _Vertrag geändert_, _Positionen aktualisieren_, _Vorausbezahlt in GJ …_, _Kostenbuchungen importieren (CSV)_.

### Limits

20 schedules per contract and 200 per service; 10 contract years with own amounts; 120 dated payments per schedule; a schedule spans at most 10 years (proposals and commitments look no further). Proposed lines count against the 200 plan lines per service and fiscal year – a proposal that would pass it is refused with the number. CSV import: 5 MB, 5,000 rows, 100 columns, cells as for FOCUS files, at most 2,000 entries per service and fiscal year as before; 100 imports kept per service (older records keep their entries, lose _Remove import_).

### Delivery

1. **Foundations**: the minor-unit table and its display; from and to months, the quarterly cadence and _covers_ on plan lines; supplier and contract on entries; _Book_ with _Not booked_.
2. **Payment schedules** on contracts; proposals per fiscal year; _Contract changed_ and _Update lines_; copy to the next fiscal year with contracts; prepaid rows.
3. **Commitments**: the service's _Contracts_ section, _Costs → Commitments_, the supplier page, the notice warning; `/api/v1`, MCP, the dataset, the export part.
4. **CSV import** of entries with mapping, preview, problems, duplicates and _Remove import_.
5. **The reminder** `cost.booking_due`; docs ([COSTS.md](../COSTS.md), [SUPPLIERS.md](../SUPPLIERS.md), [API.md](../API.md), [MCP.md](../MCP.md), [EXPORTS.md](../EXPORTS.md), [NOTIFICATIONS.md](../NOTIFICATIONS.md)) and demo data (the payment licence of _Online shop (demo)_ as a three-year contract with monthly billing and +3 %, a prepaid historian licence, an import file in `examples/`).

### Tests

- `shared/test/costContracts.test.ts`: payment dates (the 31st in shorter months, 29 February, monthly, quarterly, yearly, dated), contract years against fiscal years with start months 1, 4, 10 and 12, partial first and last years, price changes inside a year, proposals of the example above, minor units (EUR, JPY, KWD) and spreads that add up, earliest exit for each renewal kind and without an end date, commitments as of a day.
- `server/test/cost-contracts.test.ts`: schedules and their rights (contract editors, service editors who see the supplier, neither), proposals confirmed per year and the line limit, _Contract changed_ after each kind of change and _Update lines_ (also with a hand-changed line, a part that goes with entries, a year that is over), the fiscal-year start changed, copy with schedule lines, 0.17 contract lines ending before and inside the new year, prepaid rows, the notice warning, commitments with a hidden service, a hidden supplier, hidden amounts and team scope, removing a contract, merging suppliers, `/api/v1`, MCP, the dataset, the export part, the module switch, session-only writes, audit.
- `server/test/cost-entry-import.test.ts`: separators, BOM, each date format, decimal comma with thousands points, every row problem, duplicates against stored entries and within the file, the import with and without ticked duplicates, all or nothing, limits, the same file twice, _Remove import_, audit; _Book_ (defaults, booked twice, yearly lines refused) and the reminder sent once per service and month.
- The new columns and tables on PostgreSQL; the upgrade test from the v0.17.0 fixture (lines without from and to are whole years, 0.17 contract lines unchanged); `e2e/cost-contracts.spec.ts` (a schedule with a price change, confirm a year, change the contract, update lines, the commitments page) and `e2e/cost-entry-import.spec.ts` (map, preview with a problem and a duplicate, import, remove) on a desktop and a phone with axe; the German texts in the locale tests.

### Considered and not chosen

- **Amortisation and accruals** (spreading a prepaid three-year licence over the years it covers): accounting, and it makes the plan disagree with what left the account in a year. The plan stays cash by the year paid; the _covers_ note and the _Prepaid_ rows say the rest.
- **Automatic booking** of planned contract payments (a monthly job, or an option per line): an entry would then say money was spent when nobody checked an invoice – the plan would confirm itself. A person books in one step; the optional reminder points at what is missing.
- **Purchase orders and approvals** for contracts or bookings: a workflow ADR 0026 excluded; the reference field links to the ERP document.
- **Currency conversion** of commitments or totals: as ADR 0026 – per currency; revisit with fixed rates set by an administrator if teams ask.
- **Invoice OCR** (reading PDFs to entries): heavy, error-prone, and invoices often hold personal data; CSV covers the lists that ERPs and supplier portals already export.
- **Chargeback** of shared contracts between services or departments: out, as before; a shared contract has one schedule per paying service with that service's own amount.
- **Lines created automatically from a schedule** (and rewritten when the contract changes): the plan is the team's statement; silent lines and silent rewrites would make it Steward's. Proposed and confirmed instead.
- **Day-level pro rata** for part months: invites rounding disputes for cents; the month of the payment date is what a plan needs, and dated payments cover exact first invoices.

## Decided (November 2026)

The owner took the recommended answer to every open question ("go with the recommendations"), decided on 2026-11-11:

1. **From and to months are a general plan-line feature** – on monthly, quarterly and yearly lines, not only contract lines: part-year lines exist without contracts too (a licence bought in March), and one model is simpler than two.
2. **A quarterly cadence is added** for plan lines – quarterly billing is common and otherwise needs four one-off lines a year.
3. **Contract lines are proposed and confirmed by a person, one step per fiscal year** – never created automatically; the plan stays the team's.
4. **A changed contract shows _Contract changed_ with _Update lines_** (before and after, selectable), never a silent rewrite; years that are over are left alone – a plan is history once its year is over.
5. **Amounts per contract year are stored amounts** (years 2–10), filled from _+ x %_ in the form – index clauses are rarely an exact percentage, and what is stored is what is planned.
6. **Payments count in the month of their date, no pro rata** – the month is the plan's unit; exact first invoices are dated payments.
7. **Rounding to the currency's minor units**, half away from zero, with a minor-unit table in 0.18 – amounts no currency can pay are noise, and JPY has no cents.
8. **Contract currency = line currency**, one per schedule, no conversion – as ADR 0026.
9. **One paying service per schedule**; several schedules per contract – shared contracts and setup fees without shares or splitting rules.
10. **Committed = scheduled payments dated today or later, to contract end and to earliest exit, both shown**; entries not subtracted – the first is what the team plans to pay, the second what it cannot avoid; the difference is the decision a notice-by date asks for.
11. **Notice warning** when the notice-by date is ahead and the fiscal year of the next term has no plan lines – that is when a renewal gets owed before anyone planned it.
12. **Copy to the next fiscal year** proposes schedule lines instead of copying them, does not continue 0.17 contract lines past the contract end, and is not blocked by contract lines confirmed early – copying must not plan what a contract no longer owes.
13. **Prepaid payments in the fiscal year paid**, with _covers_ and quiet _Prepaid_ rows in the years covered – no amortisation.
14. **Commitments live in three places**: the service's cost plan (its contracts), _Costs → Commitments_ across the services the reader may see, and the supplier page – where planners, budget owners and supplier owners already look.
15. **Supplier and contract on entries**, defaulting from the plan line – the supplier page can then say what was spent with a supplier.
16. **_Book_ on lines with a payment in the month**, not on yearly lines; asks before booking a month twice – one step, still a person's statement.
17. **No automatic booking; an opt-in reminder `cost.booking_due`**, off by default, monthly per service – a person stays in the loop without noise for those who do not want it.
18. **CSV import format**: UTF-8, detected separator, header row, explicit date format and decimal separator, a mapping remembered per service; 5 MB, 5,000 rows, 100 columns – ERP exports differ, so nothing ambiguous is guessed.
19. **Duplicates by reference, date, amount and currency** against stored entries and within the file, left out unless ticked; rows without a reference are marked, not dropped – the reference is the only stable key an invoice has.
20. **Imports are all or nothing for the chosen rows, kept as a record, removable as a whole** – a wrong mapping is undone in one step.
21. **Who may**: schedules by who may change the contract, or edit the paying service and see the supplier; proposals, _Book_ and import by the service's editors – the existing rights, no new role.
22. **New writes need a session**; existing entry and line routes keep accepting API tokens – conveniences are for people; nothing that works today is taken away.
23. **Audit actions** as listed above; one entry per import, not per row – a readable trail, with the file's SHA-256 to find the source.
24. **API and MCP read-only**: the cost plan and supplier responses grow, plus `/api/v1/cost-commitments` and `list_cost_commitments` – assistants read and explain, people book.
25. **Exports and datasets**: new columns and `commitments.csv` in the _Cost plans_ part, the dataset `costs.commitments`; **the ISMS summary is unchanged** – it has the notice-by dates and no place for amounts.
26. **Migrations are additive** (`costs-003`, `costs-004`); existing lines without from and to are whole years, 0.17 contract lines keep working without a schedule.
27. **Costs module**: schedules, proposals, commitments, booking and import switch off with it; contracts stay core.
28. **Limits** as above – generous for a service, bounded for pages and exports.

## Consequences

- A multi-year contract is entered once, on the contract; each fiscal year's lines follow from it with one confirmation, including part years and price changes, and the plan no longer continues contracts that end.
- A team, a budget owner and a supplier owner see what is already owed and until when, and which notice-by date decides the next term before the year is planned.
- Recording costs takes an import or a click instead of retyping; entries know their supplier and contract.
- The cost plan gets more concepts – part-year lines, quarterly lines, contract lines with hints, prepaid rows, commitments. The form keeps them out of the way (_Only part of the year_ folded, contract fields only on contract lines); the docs explain them with the example above.
- **Risks**: double planning (a schedule and a hand-made line for the same contract) – hinted, not blocked; a contract changed without anyone updating the lines – the hint stays until someone decides; misread CSV dates – the format is explicit and the preview shows every row; commitments that look like accounting – they are labelled as scheduled payments, not liabilities; a commitment total that reveals hidden services – schedules of hidden services are neither named nor counted; computing schedules on every read – bounded by the limits, the dataset at most hourly.
- Revisit if teams need shares of one schedule across services, fixed exchange rates for totals, posting entries from an ERP on a schedule, or cancellation terms richer than notice period and renewal.
