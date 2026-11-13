# Data products

> **Preview, off by default.** An administrator switches the module on under _Settings → Modules → Data products_. This page describes what 0.22.0 builds; parts marked _to come_ are being added in the same release. The design and its reasons are in [ADR 0036](adr/0036-data-products-module.md).

Steward documents data products from the IT service team's side: what a domain offers, which data it holds and how sensitive that data is, what the product is made of on Snowflake, Kafka, SQL databases, APIs and file stores, how data moves through it, and who uses it. Steward keeps a thin model of its own and links out to catalogues (DataHub, OpenMetadata, Collibra) instead of becoming one.

## The model

| Entry            | What it is                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Domain**       | A business domain (_Sales_) or a sub-domain (_Sales → Orders_) – two levels – with owners and owning teams                                                   |
| **Data object**  | What the data **is** – _Customer_, _Order_: a definition, synonyms, key attributes, a CIA rating, a classification, personal data, legal basis and retention |
| **Data product** | What a domain **offers**: a type, owners, a rating, a lifecycle, environments, ports                                                                         |
| **Element**      | A concrete thing on a platform in one environment: a table, a view, a topic, an API, a path                                                                  |
| **Membership**   | An element in a product with a role: _input_, _internal_ or _output_; one element can be part of several products                                            |
| **Port**         | A product's interface (input or output) with a version and its own lifecycle; per environment a **binding** names its elements and its data contract         |
| **Consumer**     | A registration on an output port: who (a team, a user, an application, a service, a product or a text), the purpose, since when, the agreement               |
| **Step**         | How data moves: inputs → a runner → outputs, with transformation notes (documentation only – Steward runs nothing)                                           |

## Data objects

_To come: the full description (WP8)._ A data object has a key, a definition, a lifecycle (draft, active, deprecated, retired), a **CIA rating** on the instance's CIA scale (rated and re-rated exactly as applications: a scale change flags it for re-rating) and a **classification** – _public_, _internal_, _confidential_, _strictly confidential_. Personal data: _none_, _personal_ or _special categories_ (GDPR Art. 9), with categories, data subjects, the legal basis (Art. 6(1)(a)–(f)), purposes, the retention period (an ISO 8601 duration such as `P10Y`, or text) and the deletion rule. The **data owner**, the **stewards** and the **custodians** are responsibilities, not rights: owner and stewards see the object, editing follows its owning teams. Elements **implement** data objects.

## Data products

A product has a key (unique, used by the file format and the ODPS `id`), a name, a description and purpose, a **type** (_source-aligned_, _aggregate_, _consumer-aligned_), a domain, **product owners**, support, a **criticality**, a **support tier**, a version and a business value.

- **The rating floor.** Per dimension a product's CIA rating – and its classification – should be at least the highest of the data objects it exposes (declared on its output ports or implemented by their elements). Lower is allowed with a reason (only aggregated data leaves the product); without one the product page, the list and the scorecard warn. Ratings waiting for a re-rating do not count.
- **Lifecycle:** _proposed_ → _draft_ → _active_ → _deprecated_ → _retired_ (the ODPS statuses), with the date of each change, a sunset date and a successor. _Active_ needs a product owner and an output port, _deprecated_ a sunset date, _retired_ a confirmation while consumers are registered or consuming products are active. Retiring – like every lifecycle change – is done in the app (not with an API token).
- **Environments** come from _Settings → Environments_; production first. A product exists in each environment its members and bindings name (_planned_, _available_, _withdrawn_).

## The element catalogue

An element has a platform (or none for APIs and other things), a **kind** (`snowflake.table`, `kafka.topic`, `sql.view`, `api.openapi`, `files.path`, …), a qualified name unique per platform, kind and environment (case does not matter), a parent (database → schema → table), a layer and a description. Elements are entered, imported or **discovered** (below). Discovered elements keep what people wrote: a new read changes only the technical fields – name, kind flags, parent, external id, OpenLineage dataset – and the readout. An entered element that a discovery source finds again is looked after by that source from then on.

## Discovery

**Discovery sources** read elements from the platforms Steward already connects to – metadata only, with the platform's identity (mark it read-only, [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#read-only-identities-and-the-operation-filter)), as a background job. _API:_ `/api/data-products/discovery-sources` (the page follows with the module's pages).

| Platform                                                             | What a source reads                                                                                                                         | Elements                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Snowflake** ([SNOWFLAKE.md](SNOWFLAKE.md#data-products-discovery)) | the databases and schemas of its scope (`SHOP`, `SHOP.SALES`): the catalogue views and `SHOW … IN DATABASE`                                 | databases, schemas, tables, views (secure and materialized as flags), dynamic tables, streams, tasks, stages, pipes         |
| **Kafka** ([KAFKA.md](KAFKA.md#data-products-discovery))             | the cluster's topics under its prefixes (none: all; internal `_…` topics left out) and the platform's Schema Registry                       | topics with their topic id, partitions, replication, `cleanup.policy`, `retention.ms` and the latest `<topic>-value` schema |
| **Databases** (PostgreSQL, MariaDB/MySQL, SQL Server)                | the platform's **latest schema snapshot** ([DATABASES.md](DATABASES.md#database-schemas)) – no connection of its own; a scope names schemas | schemas, tables, views (column counts only)                                                                                 |

Confluent Cloud clusters are discovered as the Kafka platforms that connect to them.

**A source** has a platform, a **scope**, **include and exclude prefixes** (plain comparisons of the qualified name without case – no patterns; `SHOP.SALES.` keeps the database `SHOP` and the schema `SHOP.SALES` as their containers), **environment rules** (a prefix or suffix of the database, schema or topic → an environment, e.g. suffix `_DEV` → `dev`; the first that matches, else the platform's environment), the Snowflake **mode**, the **identity** it reads with, the **owning teams** of what it finds (default: the platform's) and how often it reads – daily by default, at most hourly, at least weekly. At most 50 sources per instance.

**Who:** the module's managers (designers until module roles exist) and the platform's managers set sources up – if they may use the platform: a source **runs as the person who last saved it**, and that person's use right on the platform and the identity is checked again before every run; a source whose person lost the right stops and says so (_The source runs as …_). Who has a right on the platform sees its sources, unless the owning teams of what they find exclude them. Every change and _Read now_ needs a signed-in session and is in the audit log (`datadiscovery.source_created`, `…_updated`, `…_deleted`, `datadiscovery.run`, `datadiscovery.run_failed`). Owning teams that reach people the platform's teams do not – or none, the whole instance – ask for a confirmation (control point `access.grant`) and are recorded as an access change (`access.owning_teams_changed`). New owning teams apply to the elements the source adds from then on.

**A run** (the job `data-products` every 5 minutes for the sources that are due, one at a time; or _Read now_):

- reads in partitions and writes in batches of 250 elements per transaction, with a turn of the event loop between batches – an unchanged element writes only its readout;
- **renames** an element when the platform's id of it is known under a new name (Snowflake `TABLE_ID` in _account usage_ mode): people's fields, memberships and links stay; in _information schema_ mode a renamed table is a new element and the old one goes missing;
- marks the source's elements it did not find **missing** – only after a **complete** run. A run that stops at 50,000 elements, at the instance's 250,000, after 10 minutes, or reads a cut schema snapshot is _truncated_ and marks nothing. A missing element in no product is removed after 30 days; in a product it stays and is flagged there;
- fills the **OpenLineage** namespace and name of each element (`snowflake://<account>` with `DB.SCHEMA.TABLE`, `kafka://<first bootstrap server>` with the topic, `postgres://<host>:<port>` with `<database>.<schema>.<table>`), for matching run events later;
- keeps the newest 30 runs per source with their counts (added, changed, renamed, unchanged, missing, removed) and why a run failed, stopped early or could not read a part (a Schema Registry: the topics stand without schema versions).

**Metadata only.** Snowflake: `INFORMATION_SCHEMA` (SCHEMATA, TABLES, VIEWS – secure ones), `ACCOUNT_USAGE` (DATABASES, SCHEMATA, TABLES, VIEWS) and `SHOW DYNAMIC TABLES | STREAMS | TASKS | STAGES | PIPES`, of whose output only metadata columns are kept – never a definition; Kafka: the metadata and DescribeConfigs requests, never a consumer group, an offset or a message; the Schema Registry: `GET /subjects` and the latest version of a subject (its id, version and type, not the schema). Names from a scope go into Snowflake statements as a bound `IDENTIFIER(?)` or, for `SHOW`, as a checked and quoted identifier; every other value is a binding. Every request goes through the outbound policy – the account's and the registry's origins are checked first – and connects to the checked address. The tests check the statements and calls against these lists.

## Ports, contracts and consumers

An output port is bound per environment to up to 20 elements of that environment and optionally to a **data contract** (the version it is held to and its ODCS server). Bound elements become members with the port's role. An input port names where its data comes from: another product's output port, an element of a source system, or a text. Consumers register on output ports; deprecating a port tells them (_to come_).

## Checks and health

Steward watches data products with its **monitors** ([MONITORS.md](MONITORS.md)): checks are linked to elements, a product gets a monitor with root causes along its pipeline, and health is read from the stored check states – a page never calls a platform.

### The check type _Data element_

The monitor check type `data-element` reads an element of the catalogue on its platform with the **monitor owner's use right** and the platform's default identity, like every platform check; the owner must see the element. It reads **metadata only** – never a data value, never a `SELECT` on a table (decision 13 of the ADR).

| Mode          | Snowflake                                                                                                                                                                                                                                                                                                                                                                        | Kafka                                                                                                                                                                                                 | SQL database                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **freshness** | table or view: `LAST_ALTERED` of `<db>.INFORMATION_SCHEMA.TABLES`; dynamic table: the data timestamp of its last successful refresh (`DYNAMIC_TABLE_REFRESH_HISTORY`; a failed last refresh is a warning); task: its last successful run (`TASK_HISTORY`, the last 7 days; a failed last run is a warning); schema or database: the newest table (_any_) or the oldest (_every_) | topic: the newest message's time (Kafka 3.0+; else when the end offsets last moved), optionally a consumer group's lag (degraded above `maxLag`); bundle: its topics, the newest (_any_) or every one | – (link a check of your own)             |
| **schema**    | `INFORMATION_SCHEMA.COLUMNS` of the table against the contract                                                                                                                                                                                                                                                                                                                   | the subject `<topic>-value` (latest, or a pinned `schemaVersion`): Avro record fields or JSON Schema properties; Protobuf is not compared (unknown)                                                   | the latest schema snapshot (no new read) |

Fields: `element` (Steward's id), `mode`, `maxAgeMinutes` (default 1440), `each` (`any` or `every`, for a schema, database or bundle), `group` and `maxLag` (a Kafka topic), `schemaVersion` (Kafka schema mode), `failAs` (down or degraded), `warningAs` (degraded or up).

- **Freshness is metadata.** `LAST_ALTERED` also moves on DDL and background maintenance (automatic clustering): the check says _changed_, not _loaded_. For the newest value of a timestamp column, write a `database` check of your own (query mode) and link it to the element.
- **Schema** compares the element with the schema object of the ODCS contract its **output port** is bound to in the element's environment (the binding's version, else the current one) – matched by physical name, else by name, else the contract's only object – with the [contract comparison](DATA-CONTRACTS.md#breaking-changes) on names (case ignored), logical types and required fields: a field of the contract that is missing or of another type family **fails** (`failAs`); required ↔ nullable and columns the contract does not name are **warnings** (`warningAs`). Without a bound contract the check is unknown.
- **Saving or trying** the check needs the editor to see the element and use its platform (one they may not see answers like a missing one: `DATA_ELEMENT_NOT_FOUND`); a mode the element's kind does not support is refused (`DATA_ELEMENT_CHECK_MODE`). The editor offers the type while the module is on.

### Checks linked to an element

An element shows the checks that watch it (`GET /api/data-elements/{id}/checks`), with their stored status:

- **made** by _Create monitor_, **linked** by a person (_Link_ – who may change the element or a product it is part of; at most 100 per element), or **found** – a check whose fields name the element: a `data-element` check, a `snowflake` freshness or tasks check on its name, a `kafka` check on its topic. Found checks are offered until someone links them; _Create monitor_ links them.
- A check of a monitor the reader may not see is shown by **its status only** – _a check you may not see_: no monitor, check name, message or author.

### Health

- **An element:** the worst status of its linked checks that run (an enabled monitor and check; maintenance counts as up); checks the reader may not see count by their status. No running check: **No data** – never OK.
- **A product, per environment:** its monitor's status while that monitor runs (a disabled draft does not count yet); else the worst of its **output-port elements** there, **internal elements at most degrading** (a down internal element makes the product degraded); input elements are other products' or sources'. Nothing linked: **No data**.
- Health is computed **in bulk** from the stored states: a fixed number of statements whatever the number of products (`GET /api/data-products/health?ids=…&environment=…` for a page, `GET /api/data-products/{id}/health` per environment, production first).

### Create monitor and Update monitor

_Create monitor_ on a product (`GET /api/data-products/{id}/monitor` shows the proposal, `POST` applies it; per environment, production first) makes a **disabled draft monitor** for review – Steward never enables it:

- a `data-element` **freshness** check per element that has one: output-port elements are **critical** with the port's freshness objective as maximum age (the binding's objective overrides the port's); the pipeline's internal and input elements only degrade the monitor (`aggregate.rule: critical`), with the smallest output objective (else a day);
- a **schema** check per element of an output binding with a contract, and a `data-contract` check in `findings` mode per contract (while the data contracts module is on);
- elements already watched elsewhere (linked or found) are **not repeated**, elements without a supported kind are left out, elements the person may not see are left out and counted, never named;
- **soft links along the steps**: an element's check → the next checked element downstream (through elements without a check of their own), so a stale raw table is the **root cause** of a stale mart and only the root cause alerts;
- at most 100 checks: beyond, the output ports and the layer before them first; the proposal says what was left out and why.

The product remembers the monitor per environment. **Update monitor** – the same action once the product has a monitor – proposes the checks for elements added since, with soft links to the existing checks, and adds them when a person applies it (it never rewires what is there). It needs the right to change the product and to create (or edit) the monitor; audited as `dataproduct.monitor_created`.

### Contract drafts from an element

A contract draft from an element (`POST /api/data-contracts/draft` with `{ "source": "element", "elementId": … }`; in the app with the port pages, _to come_) is made from a Snowflake table's columns (`INFORMATION_SCHEMA.COLUMNS`, read now, with a `snowflake` server), a Kafka topic's latest `<topic>-value` schema (with a `kafka` server), or a database table's latest schema snapshot – for whoever sees the element and may use its platform.

## Pictures

Three pictures show how data moves – each with a **table** that says the same in words (_Picture_ / _Table_ above it; phones start with the table, the picture is a tap away), a **legend**, a **search** that finds and selects a part, _Fit to screen_, and **export** as SVG or PNG (for documents: the theme's colours, statuses in words, no animation). They follow the conventions of the plant registry's pictures:

- **Pipeline of a product** (`/data-products/{id}/views/pipeline`, the product's _Pipeline_ tab): its elements in columns by role – input ports, internal elements by layer (_source_, _raw_, _staged_, _curated_, _mart_), output ports – inside the product's area, and the elements outside it that its steps read from (upstream, left) or write to (downstream, right), greyed and named with their product. Steps are labelled edges (a step with many inputs and outputs is a node of its own); ports are named on their elements. Switch the **environment** above the picture (production first; `?environment=` in the address).
- **Product map** (`/data-products/map`): the products in their domains and sub-domains, an edge from the product of an output port to every product whose input port consumes it (dashed and red when that port is deprecated or retired). Filter by domain (with its sub-domains), type, lifecycle and environment – the filters are in the address; the products a match depends on or feeds are drawn greyed.
- **Lineage of an element** (`/data-elements/{id}/views/lineage`): the elements 1 to 4 steps upstream and downstream (`?depth=`, 2 by default) across products – products as areas –, the steps between them, and plant registry data collections that write to an element (named where you may see the site).

**Health** on a node comes only from checks linked to the element or the product's monitor; without one it says _No data_ – never OK. It is shown as an icon and a word with its colour, never colour alone.

**Keyboard and screen readers.** Every part is a stop of its own with its kind, name, role, layer and health in words; **Enter** opens its page, **Space** (or a click) selects it and highlights everything upstream and downstream of it – _Show only what is connected_ keeps only that (on the map: what depends on a product and what it depends on) – and **Escape** clears the selection. The moving dashes on the edges show the direction of the data; they stop with your system's _reduce motion_ setting or with _Animation off_, and the arrows stay.

**What you may not see** stays in the picture without a name or an id – _An element you may not see_ – so the picture stays true; a note counts such elements and products.

**Large pictures.** A response holds at most 2,000 elements (the rest are counted). The pipeline's picture draws at most 150 parts: beyond, elements collapse by their parent (_40 elements of STAGED_), then a column becomes one part; the map draws at most 300 products, beyond, each domain becomes one part with its count; a lineage stops at 200 elements (left out counted per direction). The table always lists everything the response holds. Each picture is read with a fixed number of statements whatever its size.

## Who may do what

| Who                                             | Rights                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| Every working role (items without owning teams) | See products, data objects, elements and domains                            |
| Designers                                       | Create and change them; delete, owning teams and retiring (_manage_)        |
| Product owners, domain owners                   | See, change and manage their product or domain                              |
| Data owner and stewards                         | See their data object                                                       |
| With owning teams                               | Only members of those teams (with their roles), auditors and administrators |

Team scope applies everywhere: what a reader may not see is neither listed nor counted nor named (_Part of 1 product you may not see_). Naming an owner from outside the owning teams asks for a confirmation (control point `access.grant`) and is recorded as an access change. Module access and module roles (viewer, contributor, manager) follow with [ADR 0034](adr/0034-module-access.md).

## Links

Documents, records and ticket references link data products and data objects (link kinds _Data product_ and _Data object_), offered while the module is on.

## To come

Costs and the scorecard, the pages (with the discovery page), MCP tools, `/api/v1`, import and export with ODPS – see the work packages of [ADR 0036](adr/0036-data-products-module.md#implementation-plan-phase-1).
