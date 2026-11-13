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

## The pages

_Data_ in the sidebar holds the module's pages while it is on – _Data products_, _Elements_, _Data objects_, _Domains_, _Product map_ and _Discovery_ – with _Data contracts_ beside them (it moves there from _Catalogue_ when both modules are on). Every list is paged by the server (100 at a time, _Load more_), keeps its filters in the address (a filtered list can be shared), shows cards on phones and a table on wider screens, and says what you may not see only as a count.

| Page                                       | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data products** (`/data-products`)       | Name and key, domain, type, lifecycle (with the sunset date), environments, health (in words and an icon), the CIA rating with a warning when it is below its data objects without a reason, classification, value tier. Filters: domain, type, lifecycle, owning team, environment (health in that environment) and health; a text search on name and key. _New data product_ for designers and administrators                                          |
| **A product** (`/data-products/{id}`)      | The header: name, lifecycle, type, maturity, health per environment, domain, key, version and owners; _Lifecycle_, _Edit_, and _Rate_ in the menu. The tabs below, each an address of its own                                                                                                                                                                                                                                                            |
| **Elements** (`/data-elements`)            | The catalogue: qualified name, kind, platform, environment, layer, the products it is part of (others counted) and whether it is missing. Search by the **start** of the qualified name (by index – fast on 250,000 elements) or by a **text** in it (a bounded scan, counts capped at 10,000); filters platform, kind, environment, layer, _In no product_ and _Missing_; _New element_ for what discovery does not read                                |
| **An element** (`/data-elements/{id}`)     | Its readout (rows, size, last change, partitions, retention, schema version), the products it is part of with its role (_1 you may not see_), the data objects it implements (link and unlink), its cost matches, owning teams; the tabs _Lineage_ (the picture and its table) and _Checks_ (linked, made and found checks with their stored status – _Link_ a found one, _Unlink_, _Link a check_ of a monitor you may see). _Draft a contract_ (below) |
| **Data objects** (`/data-objects`)         | The list (domain, lifecycle, classification, personal data, rating, data owner; filters for each) and a page per object: the definition and synonyms, personal data with categories, special categories, subjects, legal basis, purposes, retention and deletion rule, regulatory flags, key attributes, the CIA rating (_Rate_), the roles, the elements that implement it and the products that expose it, owning teams; a _Links_ tab                 |
| **Domains** (`/data-domains`)              | Domains with their sub-domains, owners and owning teams, and links to their products and data objects; the module's managers add, change and delete them                                                                                                                                                                                                                                                                                                 |
| **Product map** (`/data-products/map`)     | The picture of [Pictures](#pictures)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Discovery** (`/data-products/discovery`) | The sources with their platform, scope, last run (status, counts, why it failed – in your language), next run and _Read now_; a page per source with its settings and its newest runs                                                                                                                                                                                                                                                                    |

**The tabs of a product:**

- **Overview** – description and purpose, the data objects it exposes, the rating floor (_Below the rating of Customer (C: very high) – reason: …_), the scorecard with its evidence and the maturity, consumers, value beside last month's costs, the facts (owners, rating, classification, criticality, tier, support, members by role, lifecycle dates, tags, external references) and its **environments** with their state (_planned_, _available_, _withdrawn_) and monitor – add one, change its state, remove an unused one.
- **Ports** – output ports first, then input ports, each with type, version and lifecycle, the data objects it exposes (declared and through its elements), its objectives and – in the environment chosen above (production first) – its **binding**: the elements, the data contract with the version and ODCS server it is held to. _Bind_ picks elements of that environment from the catalogue and a contract you may see. An input port says where its data comes from (another product's output port – flagged when that port is deprecated –, an element, or a text). The registered consumers of an output port open below it (who, purpose, since and until, agreement); consuming products are counted.
- **Pipeline** – the pipeline picture with its table ([Pictures](#pictures)) and the **steps** below: inputs → outputs, kind, runner, schedule; add, change and delete them (who may change the products of a step's outputs).
- **Elements** – the members with role, kind, platform, environment, layer, health and _Missing_; filter by role and environment. _Add elements_ searches the catalogue on the server as you type (the first 20 matches, debounced) and adds up to 500 at a time with a role, _with everything below it_ for a database, schema or bundle, and a note; the row menu changes the role or removes the element (it stays in the catalogue and in other products). _New element_ enters one and adds it.
- **Health** – per environment the product's health and where it comes from, the elements and their checks (those you may not see counted), and **Create monitor** / **Update monitor**: the proposal – checks, soft links, what was left out and why – is shown first; applying it makes a disabled draft (or adds the checks) to review on the monitor's page.
- **Costs** – per month the attributed costs, the lines of a month (platform, match, direct or share with its rule and how many products share the line), the product's own and inherited **matches** (add and remove them), the **shared lines** with their split (equal or by weight – changed by who may manage the platform), and the value beside them; _incomplete_ where a platform's amounts are not yours to see.
- **Access** – the owning teams with _Why do I have access?_, the product owners and who may do what.
- **Links** – documents, change and incident records, ticket references and other entries that link the product (made on those entries).
- **History** – the lifecycle with its dates, who made and last changed the product, and – for auditors and administrators – its entries of the audit log.

**Forms.** Product, data object, domain, element and discovery source; port, binding and consumer; step with runner and transformation notes; the rating with a justification per dimension and – for a product below its data objects – a reason per dimension (only for the dimensions still below with the levels chosen); lifecycle (deprecated asks for the sunset date before the server does; retiring a consumed product asks to confirm). Owners and stewards named from outside the item's owning teams are said before saving and confirmed (`access.grant`). Every form asks before discarding what was typed.

**Settings → Catalogue → Data products** shows the layers (the pipeline's columns), the suggested regulatory flags and the defaults; they are built-in lists in 0.22.0 – a layer or flag typed on an element or a data object is kept as it is.

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

**Discovery sources** read elements from the platforms Steward already connects to – metadata only, with the platform's identity (mark it read-only, [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#read-only-identities-and-the-operation-filter)), as a background job. _Data → Discovery_ in the app; _API:_ `/api/data-products/discovery-sources`.

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

An output port is bound per environment to up to 20 elements of that environment and optionally to a **data contract** (the version it is held to and its ODCS server). Bound elements become members with the port's role. An input port names where its data comes from: another product's output port, an element of a source system, or a text. Consumers register on output ports; deprecating a product or a port tells them ([Notifications](#notifications)).

## Costs

**Showback, not chargeback** ([ADR 0036](adr/0036-data-products-module.md) part 11): a product's costs are an attribution of the cost lines Steward already reads ([COSTS.md](COSTS.md)) – never booked, never part of a cost plan, and the sum over products is not a budget. Platform plans keep their whole bill ([ADR 0032](adr/0032-cost-attribution-platform-plans.md)).

- **Matches** say which lines of a platform a product takes, per environment: by **resource id** (a Confluent cluster `lkc-…` or connector `lcc-…`, an AWS resource), **sub-account** (a Snowflake account, a Confluent environment), **service name**, a **tag** (key and value) or the **application** the lines are mapped to. A match on an **element** – a topic's cluster, a connector that runs a step – is inherited by every product the element is a member of, in the element's environment. Who may change the product (or the element) adds and removes matches, on platforms they may see; at most 1,000 matches per instance.
- **Direct and shared lines.** A line one product matches (in one environment) is its **direct** cost. A line several match is **shared** and split by the **allocation** of its match: **equal** between the products (and environments) that match it, or **by weight** – a percentage per product, split equally between its environments. Weights add up to at most 100 % (`DATA_COST_ALLOCATION`); what no product takes is shown as **not attributed**. When different matches claim one line, the most specific decides (resource, tag, application, service, sub-account). Amounts are split in whole millionths of the currency by the largest remainder, so the parts never add up to more than the line. Splitting by measured use (Snowflake credits per warehouse or query tag, Confluent bytes per topic) is phase 2.
- **Who sets the split:** who may **manage the platform** – splitting a platform's bill is the platform team's statement – in a signed-in session (no API token), audited as `dataproduct.cost_allocation_changed` on the platform with the rule and the weights before and after. No step-up: an allocation grants nobody sight of anything. Weights of products the manager may not see stay as they are; such products are counted, never named.
- **What a reader sees** (ADR 0032's rule): a platform's part only where they see that platform's amounts – its managers and owning teams' members, administrators and auditors, everybody else who may see the platform unless _Hide amounts from viewers_ is on; viewers see no platforms. A part they may not see is left out of the lines and the totals and marks the month **incomplete** (`amountsHidden`) – never a figure from which the hidden part could be computed. Allocation weights and what is not attributed are shown to who sees the platform's amounts. A match on a platform the reader may not see shows neither the platform nor its value.
- **Value beside cost:** the product's value statement, tier and optional yearly amount stand next to its costs – no ratio is computed, nothing is netted.
- **Snowflake** bills per account and service type: in phase 1 a Snowflake-based product has costs through a dedicated account, tagged FOCUS lines, or an equal or weighted share of an account.

`GET /api/data-products/:id/costs?environment=&months=` (production first; 1–24 months, default 12): per month the lines – platform, direct or share, the rule, the share, the amount and the match – totals per currency, the flags, the product's own and inherited matches and its value. `POST /api/data-products/:id/costs/matches`, `DELETE …/matches/:matchId`; `GET|POST /api/data-elements/:id/cost-matches`, `DELETE …/:matchId`; `GET /api/data-products/cost-allocations?platformId=` (shared lines with their products, visible ones named, hidden ones counted) and `PUT /api/data-products/cost-allocations` (`{ platformId, kind, value, tagKey, rule: equal | weight, weights: [{ productId, pct }] }`). The tab costs a fixed number of statements whatever the number of products, matches and lines (one grouped read of the lines per chunk of platforms).

## Scorecard

Computed on read per product and environment (production first), in bulk, never typed (decision 9) – `GET /api/data-products/:id/scorecard?environment=`. Each part has a state – _met_, _partial_, _not met_, _no evidence_, _not applicable_ – and its **evidence** (i18n keys `evidence.<part>.<fact>` with counts and statuses, never the name of a contract, check or product the reader may not see):

| Part               | Met when                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Documented**     | Description, product owner, domain, type and at least one exposed data object                                                                                                                                                                     |
| **Rated**          | All three CIA dimensions rated (none waiting for a re-rating) and at least the floor of the exposed data objects – below with a reason counts                                                                                                     |
| **Ports**          | Every output port has a binding in the environment                                                                                                                                                                                                |
| **Contracted**     | Every output port's binding has a data contract that is lint clean (the version it is held to) and whose last test passed                                                                                                                         |
| **Observed**       | Every element of the output bindings has a linked freshness check                                                                                                                                                                                 |
| **Healthy**        | The product's monitor in the environment is up (degraded: partial); without a monitor, the output elements' worst health                                                                                                                          |
| **Objectives met** | Over the last 30 days, with 30 days of data: the monitor's uptime at least the availability objective; the freshness checks green in at least that share of their hourly samples (99 % without an availability objective). No objectives: not met |
| **Dependencies**   | No input port consumes a deprecated or retired port                                                                                                                                                                                               |
| **Costs known**    | Cost matches exist in the environment (own or inherited)                                                                                                                                                                                          |

**ISO/IEC 25012** dimensions with the evidence Steward has: _currentness_ (the freshness checks' health), _availability_ (the monitor's 30-day uptime against the objective), _compliance_ (the contract tests), _traceability_ (the steps lead each output element back to an input or to data from outside the product, within four steps), _understandability_ (definitions of the exposed data objects), _confidentiality_ (the rating against the floor; access reviews come in phase 2); the other dimensions say _no evidence yet_.

**Maturity** follows: **1** documented and rated, **2** observed, **3** contracted, **4** objectives met for 30 days; each level needs the ones below. Level 5 (_endorsed_) comes with endorsements in phase 2. Health comes from the module's checks (stored check states – a page load never calls a platform).

## Notifications

In the app and by e-mail by default, quiet-hours and digest group _Data products_ ([NOTIFICATIONS.md](NOTIFICATIONS.md#events)); each sent once (the bookkeeping is `dp_notices`). Recipients read only what they may see: who may not see the product is not told about it at all.

| Event                          | Who, when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataproduct.deprecated`       | A product or a port becomes deprecated, or gets a new sunset date while deprecated: the registered consumers of its output ports – the teams and users registered, their contacts, the owners of a registered consuming product – and the owners of the products whose input ports use it. With the sunset date, the successor (a product only where they may see it) and the consuming products they own. Once per product or port and sunset date; leaving _deprecated_ (but for _retired_) forgets it |
| `dataproduct.elements_missing` | A discovery run no longer found elements of a product: its owners (else the members of its owning teams who may change it), once per product and run, naming up to ten elements                                                                                                                                                                                                                                                                                                                          |
| `dataproduct.discovery_failed` | A discovery source starts failing: who it runs as and the platform's managers, each only when they may see the platform (else the administrators) – once per failing period, so once until it succeeds again                                                                                                                                                                                                                                                                                             |

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

A contract draft from an element (`POST /api/data-contracts/draft` with `{ "source": "element", "elementId": … }`; in the app _Draft a contract_ on the element's page – the draft is shown to review and becomes a contract only when you create it) is made from a Snowflake table's columns (`INFORMATION_SCHEMA.COLUMNS`, read now, with a `snowflake` server), a Kafka topic's latest `<topic>-value` schema (with a `kafka` server), or a database table's latest schema snapshot – for whoever sees the element and may use its platform.

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

## File format, import and export

Steward's own format holds domains, data objects, the element catalogue and data products with their ports, members and steps – YAML or JSON in snake_case, `version: 1`, described by the JSON Schema [data-products-1.schema.json](data-products/data-products-1.schema.json) (also at `GET /api/data-products/schema`). A file holds any of `domains`, `data_objects`, `elements` and `data_products`, or a single `domain:`, `data_object:` or `data_product:`; several files are one import.

```yaml
version: 1
elements:
  - { platform: Snowflake (demo), kind: snowflake.table, qualified_name: SHOP.CURATED.ORDERS, environment: prod, layer: curated }
data_products:
  - key: orders
    name: Orders
    type: sourceAligned
    domain: sales
    owners: [user:dana]
    members:
      - element: { platform: Kafka (demo), kind: kafka.topic, qualified_name: orders.v1, environment: prod }
        role: input
    ports:
      - direction: output
        name: orders
        version: v2
        data_objects: [order]
        objectives: { freshness_minutes: 60 }
        bindings:
          - environment: prod
            elements: [{ platform: Snowflake (demo), kind: snowflake.table, qualified_name: SHOP.CURATED.ORDERS, environment: prod }]
            contract: shop-orders # the data contract's ODCS id
        consumers:
          - { kind: team, subject: team:finance, purpose: Monthly close }
    steps:
      - name: Curate orders
        kind: curate
        runner: { kind: tool, tool: dbt }
        inputs: [{ platform: Snowflake (demo), kind: snowflake.table, qualified_name: SHOP.RAW.ORDERS, environment: prod }]
        outputs: [{ platform: Snowflake (demo), kind: snowflake.table, qualified_name: SHOP.CURATED.ORDERS, environment: prod }]
```

**Identity.** Domains, data objects and products by `key`; elements by platform (its name, or `platform_id`), kind, qualified name (case does not matter) and environment; ports by direction, name and version; bindings by environment; consumers by kind and whom they name; steps by name within their product (a step is documented with the product whose element it writes). Platforms, applications, services and processes are named by their names, data contracts by their ODCS id, other products by their key.

**Never in a file:** credentials, platform variables, discovery run-as users, readouts, check states and costs. Owning teams are not part of the format either – a new entry gets the importer's teams, as when it is made on a page.

### Export

_Export_ writes a product (`GET /api/data-products/:id/export`), a domain with its sub-domains (`GET /api/data-products/export?domain=`) or everything you may see (`GET /api/data-products/export`) – optionally for one environment (`?environment=prod`) and as JSON (`?format=json`). Everything means the domains, data objects and products, the elements they name, and the entered and imported elements of the catalogue; discovered elements no product names come back with their discovery. At most 20,000 elements are written (the header `x-steward-elements-left-out` counts the rest). Empty values are left out.

The file holds only what you may see: a domain, successor, data object, contract, consumer or element you may not see is left out of the entry that names it – imported again, the entry keeps what Steward has there.

### Import

`POST /api/data-products/import/preview` shows what an import adds, changes (field by field: `ports[output orders v2].bindings[prod].objectives`), leaves unchanged and skips, and the problems that stop it – the format, names that are not known, and what the services would refuse (the preview runs the same writes in a transaction that is rolled back). `POST /api/data-products/import` imports, in one transaction:

| Mode             | What exists                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add` (Add only) | is skipped; new entries are added                                                                                                                                            |
| `update`         | takes what the files say; **a key a file leaves out keeps Steward's value**, list items (ports, members, consumers, steps …) are matched and added or changed, never removed |

An export imported again changes nothing. _Replace an earlier import_ with removals follows in phase 2.

- **Your rights, the module's rules.** Every write goes through the services of the pages: creating needs the module's contributor or manager role, changing an entry its edit right; the limits, the lifecycle rules (an _active_ product needs an owner and an output port), the bindings' environments and the rating floor apply; naming an owner from outside the owning teams asks for your confirmation (`access.grant`). Lifecycle, rating and successor are written last, after ports and bindings.
- **What you may not see does not exist** for an import: a key, element, platform, contract, application or product you may not see is refused like an unknown one, never named; a key taken by a product you may not see answers _taken_, as on the page.
- **Elements** a file adds are marked _imported_; for elements that exist, an import changes the people's fields (display name, layer, description, type label, API reference) – not the parent, the flags or what discovery reads.
- **Limits** as the other YAML importers: 8 MB and 500 files together, keys bounded before parsing, duplicate keys refused, at most 100 aliases and 12 levels, 20,000 elements per import.
- **No credentials.** A value under a key that looks secret (password, token, API key …) or a password in an address is refused with its place – the value itself is never shown or kept.
- **Session only.** Imports are made by a person signed in (API tokens are refused); the preview's `fingerprint` passed to the import refuses it when the data changed since (`DATA_PRODUCT_IMPORT_CHANGED`).
- **Audit:** each write as on the pages, and `dataproduct.imported` with the mode, the counts and each file's SHA-256.

### ODPS

`GET /api/data-products/:id/odps` (and `GET /api/v1/data-products/{id}/odps` as JSON) exports a product as an [Open Data Product Standard](https://github.com/bitol-io/open-data-product-standard) v1.0.0 document, checked in the tests against the official JSON Schema (vendored with its Apache 2.0 licence in `server/assets/odps/`):

| ODPS                               | From                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`, `version`, `status`  | key, name, version, lifecycle                                                                                                                     |
| `domain`                           | the domain's name (its key under `customProperties`)                                                                                              |
| `description`                      | `purpose` and `usage` (the description)                                                                                                           |
| `team`, `support`                  | owning teams and product owners (`role: productOwner`); the support channel with its address                                                      |
| `outputPorts`                      | name, type, version, description and `contractId` – the bound contract's ODCS id in one environment (production unless `?environment=`)           |
| `inputPorts`                       | input ports that consume an output port with a contract (ODPS requires a `contractId`); the others under `customProperties.inputsWithoutContract` |
| `tags`, `authoritativeDefinitions` | tags, external references                                                                                                                         |
| `managementPorts`                  | the product's page and its `/api/v1` address, where `SM_PUBLIC_URL` is set                                                                        |
| `customProperties`                 | Steward's id, type, rating and classification, criticality, support tier, sunset date, data objects, environments                                 |

ODPS import follows in phase 2.

## Public API and MCP

**`/api/v1`** (read-only, a token of scope _Read only_ is enough; [API.md](API.md)): `GET /data-products` (paged; `domain`, `lifecycle`, `type`, `environment`, `team`), `/data-products/{id}` (ports with bindings and contract ids, objectives, member counts, data objects, health per environment, the scorecard summary), `/data-products/{id}/odps`, `/data-products/{id}/lineage` (the pipeline, or with `?element=` the lineage of one of its elements), `GET /data-elements` (paged; `platformId`, `kind`, `environment`, `prefix`), `/data-elements/{id}`, `GET /data-objects`, `/data-objects/{id}`. 404 while the module is off.

**MCP** ([MCP.md](MCP.md#data-products)): `list_data_products`, `get_data_product`, `search_data_elements`, `get_data_element`, `get_data_lineage`, `get_data_product_health`, `get_data_product_costs`, `list_data_objects`, `get_data_object` – and `list_data_contracts`, `get_data_contract` of the data contracts module.

Both read as the token owner: what they may not see is not listed, counted or named, a product they may not see in a lineage is _a product you may not see_. Lists read a page with a fixed number of statements whatever the size of the catalogue.

## Links

Documents, records and ticket references link data products and data objects (link kinds _Data product_ and _Data object_), offered while the module is on.

## To come

Import and export buttons in the pages, editable layers and regulatory flags, and phase 2 – see [ADR 0036](adr/0036-data-products-module.md#phases).
