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

Health and _Create monitor_, costs and the scorecard, the discovery page, the pages and pictures, MCP tools, `/api/v1`, import and export with ODPS – see the work packages of [ADR 0036](adr/0036-data-products-module.md#implementation-plan-phase-1).
