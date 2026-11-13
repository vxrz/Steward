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

_To come: discovery from Snowflake, Kafka and SQL schema snapshots (WP2)._ An element has a platform (or none for APIs and other things), a **kind** (`snowflake.table`, `kafka.topic`, `sql.view`, `api.openapi`, `files.path`, …), a qualified name unique per platform, kind and environment (case does not matter), a parent (database → schema → table), a layer and a description. Discovered elements keep what people wrote: a new read changes only the technical fields and the readout.

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

Discovery, health and _Create monitor_, costs and the scorecard, the pages and pictures, MCP tools, `/api/v1`, import and export with ODPS – see the work packages of [ADR 0036](adr/0036-data-products-module.md#implementation-plan-phase-1).
