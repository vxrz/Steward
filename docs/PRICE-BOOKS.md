# Price books, calculators and estimates

What will a pipeline, a topic or a new SaaS cost per month – with the prices that apply to you? Steward keeps **price books** of item prices in versions, **calculators** that turn typed inputs into quantities, and **estimates** of a service or a platform that price those quantities exactly and become plan lines when a person confirms them ([ADR 0035](adr/0035-price-books-and-calculators.md), phase 1 in 0.21.0). Everything here belongs to the Costs module: switched off, the pages, routes, API endpoints and MCP tools go with it.

- [Items, drivers and units](#items-drivers-and-units)
- [Price books](#price-books)
- [Calculators](#calculators)
- [Estimates](#estimates)
- [Who sees and changes what](#who-sees-and-changes-what)
- [API, MCP and limits](#api-mcp-and-limits)
- [Not yet](#not-yet)

## Items, drivers and units

A book entry is an **item** with its price: an id unique in the book (the provider's SKU where there is one), optionally a price id when one SKU has several prices, a name, service and category, the **driver** (what is counted) with its **unit**, the **charge** (_usage_, _recurring_ per month, _one-off_), a **price per block** of 1, 1,000 or 1,000,000 units with up to 12 decimals – in an ISO 4217 currency **or in credits** of another item of the same book – optional **tiers** (graduated: each band at its price; volume: the whole quantity at the band reached), an **included** quantity and a **minimum** per month, a validity (_valid from_, _valid to_), attributes and a source note.

- **Units** are UCUM codes: `By` with SI and binary prefixes (`GBy` and `GiBy` differ), `bit`, `s`, `min`, `h`, `d`, `wk`, `mo`, `a`, `1`; counted things in braces (`{request}`, `{msg}`, `{credit}`, `{eCKU}`); products with `.` and one `/`: `GBy.mo`, `MBy/s`, `{msg}/s`, `{eCKU}.h`. A quantity converts only within its dimension: prefixes (decimal and binary apart) and time with **730 hours per month** (the convention of the cloud price lists, stated on every estimate). Annotations never convert – a quantity whose unit cannot become the item's is refused (`COST_PRICE_UNIT_MISMATCH`). The forms suggest drivers and units; any other may be used.
- **Prices in credits**: _warehouse M_ costs 4 `{credit}` per `h` of the item _compute-credit_, which has a money price. At most two steps, never a loop, the credit item in the same book (`COST_PRICE_CHAIN`). A step of a chain applies the credit item's tiers, not its included quantity or minimum (those belong to the account's whole use).
- **Exact arithmetic**: quantities are millionths of their unit, prices 10⁻¹² of their currency, everything whole numbers (`BigInt`); included quantity first, then tiers, then the block, then the minimum (only when anything is used); the amount is rounded half away from zero to millionths once, at the end, and shown with the currency's minor units. The same functions run in the browser and on the server (`shared/src/costPrices.ts`).

## Price books

_Costs → Price books_ lists the books you may see; a book's page has its items (500 per page, searchable), **Add item**, **Import CSV**, **Mark as checked**, its **versions** with _What changed_ and its owning teams.

- **Kinds**: **list** (published prices – everyone using Costs reads them) and **contracted** (the prices of one contract – only its readers). A contracted book may belong to a **platform** (its managers maintain it, who sees the platform's amounts reads it) or name a supplier contract. A book names its supplier and contract only to readers who may see them, and accepts only ones its author may see; saving a book keeps the supplier and contract its editor may not see.
- **Versions**: every change – an item added, changed or removed, a CSV import – writes a new, immutable version with the SHA-256 of its normalised entries and its **difference** to the one before (items added and removed, prices changed with before, after and the change in percent, other fields changed). An unchanged save writes nothing. Fifty versions are kept per book, and every version an estimate uses. Every version is audited (`cost.price_book_version_added`) with the prices changed, before and after.
- **CSV import**: a header row, comma, semicolon or tab, up to 5 MB and 20,000 rows; map the columns (item, name, unit, price are required; price id, service, category, driver, charge, block, currency or one currency for the file, credit item, tiers as `0:0.10;1000:0.08`, included, minimum, valid from and to, source), choose the decimal separator, _Replace the book_ or _Add to the book_, **Preview** (nothing stored: rows read, problems by line, what would change) and **Import** – all or nothing: a file with problems is refused with the first of them (`COST_PRICE_IMPORT`). One pass over the characters, no regular expression on the content, every count and size capped.
- **Review reminder**: a book kept by hand or from CSV has _review every … days_ (default 90). When the time since it was made or last checked is up, its maintainers get **Prices to review** in the app (`cost.price_review_due`, once per book and due date; administrators only when nobody else maintains it). _Mark as checked_ records the check without a new version (`cost.price_book_checked`).
- **The Snowflake fallback's price per credit** lives in the platform's contracted book since 0.21.0: the upgrade moved every price per credit set on a Snowflake cost source into the item `compute-credit` of a contracted book of that platform (version 1, source _Upgrade_). The fallback (`METERING_DAILY_HISTORY` credits × price per credit) reads it from there – the price valid today – with the same arithmetic as before; the cost source's form still sets it (a new version of that book).
- **Shipped examples**: `examples/costs/price-books/` holds the **technical factors** only – the credits per hour of the Snowflake warehouse sizes (checked 2026-11-12) and the items the Confluent calculator names – with no money prices (decision 19). The demo's books are invented and say so.

## Calculators

_Costs → Calculators_: templates of typed inputs, named intermediate values and lines that each name an item (provider and SKU) and a **JSONata expression for its quantity – never money**. Steward prices each line with the book an estimate uses, so one calculator serves list prices, contracted prices and internal rates.

```yaml
kind: costCalculator
id: snowflake-pipeline
name: Snowflake pipeline
inputs:
  - { key: size, label: Warehouse size, type: select, options: [XS, S, M, L, XL], default: S }
  - { key: minutes, label: Runtime per run, type: number, unit: min, default: 12, min: 0, max: 1440 }
  - { key: runs, label: Runs per day, type: integer, default: 24, min: 0, max: 1440 }
let:
  hours: inputs.minutes / 60 * inputs.runs * const.hoursPerMonth / 24
lines:
  - { key: compute, item: { provider: Snowflake, sku: "{{ 'warehouse-' & inputs.size }}" }, quantity: let.hours, unit: h }
```

- **Inputs**: `number`, `integer`, `select`, `boolean` and `table` (rows of columns – one line per row with `each:`), each with a label, unit, default, bounds and help. A `number` or `integer` may be given as a **range** – low, expected, high – unless it says `range: false`.
- **Expressions** see `inputs`, `let` (the named values before), `const` (`hoursPerMonth` 730, `daysPerMonth`), `row` (in a line with `each`) and `$attr(provider, sku, key)` (an attribute of an item of the estimate's book). SKU, provider and unit may be templates (`{{ … }}`). `when:` leaves a line out.
- **Sandbox**: the engine's guard rails, tightened – 500 ms per calculation, sequences of at most 10,000, at most 200 resulting lines, quantities finite and not below zero; no clock (`$now`, `$millis`), randomness, platform variables, secrets, datasets or network. A broken formula answers `COST_CALCULATOR_FORMULA` with its line; a quantity that is not a number, below zero or too large `COST_CALCULATOR_OUTPUT`.
- **Versions**: the editor keeps a **draft**, tried with **Calculate** (the dry run, nothing stored – only for who may write calculators, as it runs formulas); **Publish** makes a new, immutable version. **Export YAML** for Git; **Git sync** brings `kind: costCalculator` files in like processes ([GIT-SYNC.md](GIT-SYNC.md#files-and-formats)): accepting an update publishes a new version. Libraries do not carry calculators.
- **Examples** (`examples/costs/calculators/`): _Snowflake pipeline_, _Confluent topic and cluster_ (eCKU- or CKU-hours, ingress and egress from the throughput, storage from throughput × retention × the copies billed, partitions, connector tasks and throughput) and _Throughput × price_ (one line per row: provider, SKU, a rate per s, min, h or d, the hours a day – the generic calculator for anything else).

## Estimates

An estimate belongs to a **service or a platform** (the owners of cost plans) and is optionally for an application or system of the service, or a platform. Its plan's tab lists them (_Estimates_, _New estimate_); its page has the inputs, lines by hand, the books, ad-hoc adjustments, the result, the 36 months ahead, _Compare_ and the plan lines.

- **Prices**: per provider the book the estimate chose, else the **contracted book** the calculating person may see (the estimate's platform's first), else the **list book**. Each line says how its price was found (_Contracted prices: Snowflake (demo) – contracted prices (v3)_), its unit price per block, the credits it took, the exchange rate where converted.
- **Lines by hand**: an item of a visible book and a quantity – anything with a price can be estimated without a formula.
- **Ranges**: with ranged inputs the estimate is calculated three times – all inputs at low, at expected, at high – and every line and total shows low, expected and high (low the smallest and high the largest of the three, expected the expected run). A span of the inputs, not a probability; the expected figures drive plan lines (`COST_RANGE_ORDER` when low ≤ expected ≤ high does not hold).
- **Ad-hoc adjustments** (_Anpassung_): on the whole estimate or one line, a **percentage** (−90 to +500 %) or, for a line, a **fixed unit price** (block and currency), each with a **reason** (up to 200 characters). Applied last, after the conversion; shown on the line beside the price found; the totals say _with ad-hoc adjustments_; never written back. A line's own adjustment replaces the estimate's. A fixed price whose price found has moved since it was set is flagged (_Fixed – the book now says …_).
- **Exchange rates**: an estimate has one currency; a price in another is converted with the **manual rate** of the latest date on or before the calculation (direct, else the inverse of the opposite pair), set by the costs managers under _Costs → Price books → Exchange rates_ (`cost.fx_rate_set`). The rate, its date and source are on every converted line and stored with the result (`COST_FX_RATE_MISSING` without one). Only estimates convert.
- **The result** is stored and never recomputed on read: per line the quantity, the book and version, the unit price, the amount; totals **per month** (usage and recurring) and **one-off**; and, when a price changes within them (a valid-from ahead), **per month over the next 36 months** – a chart with its low–high band and a table. The book versions used are kept.
- **Recalculate with current prices** keeps the new result beside the current one (_New prices: +8 %_) until **Accept new prices** (`cost.estimate_accepted`); a change of inputs calculates at once. The last 20 results stay as the history.
- **Compare**: up to four more variants of the inputs with the same prices – a dry run, nothing stored – as bars with their low–high span and a table: per month and one-off, the difference to the first, the lines that make it, the cheapest.
- **Plan lines** (proposed per fiscal year, confirmed by a person): usage and recurring amounts as a monthly line per calculator group from the start month – one line per stretch of equal months where a price changes in the year – and one-off amounts as a once line, category _Cloud_ by default; the line remembers the estimate and what it was made from, says _with ad-hoc adjustments_ where it is so, and shows **Estimate changed** in the plan when the estimate no longer proposes the same. **Update lines** brings the lines up to date; a line changed by hand keeps its amount. An estimate priced with contracted rates asks first: _Readers of this plan will see these amounts_ (`COST_ESTIMATE_HIDDEN_RATES`). Removing an estimate keeps its plan lines.

## Who sees and changes what

| Action                                                                  | Who (phase 1)                                                                                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Read a list book, a calculator; run the dry run with stored calculators | everyone who uses the Costs module                                                                                                             |
| Maintain a book or calculator without owning teams; set exchange rates  | the **costs managers**: administrators and designers (until the Costs module's manager role of ADR 0034)                                       |
| Maintain a book or calculator with owning teams                         | the designers among the owning teams' members; a designer's new book or calculator gets their team                                             |
| Maintain a platform's contracted book                                   | who may manage the platform and its owning teams' members                                                                                      |
| Read a contracted book                                                  | a platform's: who sees the platform's amounts; another: its owning teams' members, administrators, auditors and who sees the contract it names |
| Try a calculator's draft (formulas)                                     | who may write calculators                                                                                                                      |
| Create, change, recalculate, accept an estimate; plan lines from it     | who may change the owner's cost plan                                                                                                           |
| Read an estimate                                                        | who may read the owner's cost plan; amounts by _Hide amounts from viewers_                                                                     |

- **Contracted prices stay with their readers.** A reader of an estimate who may not see a book it used sees that line **at the list price**, marked _Priced with rates you may not see – shown at list price_ (`priceHidden`), the totals as _at list price for some lines_, the 36-month projection left out and the book not named; without a list price the line's amount is left out and the total marked incomplete. Nothing is derived from a hidden price – also not by division.
- Every write needs a signed-in session; API tokens and MCP read. Audited: `cost.price_book_added|changed|removed`, `cost.price_book_version_added`, `cost.price_book_checked`, `cost.calculator_added|changed|published|removed`, `cost.estimate_added|changed|accepted|removed` (adjustments with their reason, before and after), `cost.estimate_lines_added|updated`, `cost.fx_rate_set`. Owning teams of books and calculators are set in their pages' _Owning teams_ panel (owned kinds `cost_price_book`, `cost_calculator`).

## API, MCP and limits

- **Internal**: `/api/costs/price-books[/:bookId[/entries|/versions/:n|/import/preview|/import|/check]]`, `/api/costs/calculators[/:calculatorId[/export|/versions/:n]]`, `POST /api/costs/calculate` (the dry run: up to five variants with a comparison), `/api/costs/estimates?ownerKind=&ownerId=`, `…/:estimateId[/recalculate|/accept|/proposals|/update-lines]`, `/api/costs/fx-rates`.
- **Public, read-only** ([API.md](API.md)): `GET /api/v1/price-books`, `…/{bookId}`, `…/{bookId}/items`, `GET /api/v1/cost-estimates` (`serviceId`, `platformId`), `…/{estimateId}`; the cost plans' lines carry `estimate`.
- **MCP** ([MCP.md](MCP.md)): `list_price_books`, `get_price_book`, `list_cost_calculators`, `get_cost_calculator`, `list_cost_units`, `list_cost_estimates`, `get_cost_estimate` and the dry run **`calculate_cost_estimate`** – up to five variants with ranges, books and adjustments, compared with the first; it stores nothing, takes stored calculators only, and is limited to 30 calculations a minute per token (each variant counts).
- **Limits**: 500 books; 20,000 entries per version; 50 versions kept per book (and those in use); 200 calculators; 50 inputs, 100 lines and 50 named values per calculator, 4,000 characters per expression, 64 KB per definition; 200 lines and 50 adjustments per estimate; 200 estimates per owner; 20 results kept per estimate; 5 variants per dry run; 2,000 exchange rates.
- **Performance**: lists and pages read stored results and never calculate; a book's page and an estimate's page take a fixed number of statements whatever their size; a calculation reads each book once per round of credit items.

## Not yet

Phase 2 (0.22.0): the Snowflake rate sheet and Confluent's observed rates as sources, conditions on supplier contracts (percent off list, negotiated prices, commitments), derived books for providers with a fee on top and internal rate cards, shares of books and calculators, recalculation in the background with _Estimate changed_ notifications, ECB rates, _Size a volume_, estimate against actual. Later: Azure, AWS and Databricks price lists, Infracost import, measured inputs.
