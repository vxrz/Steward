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

Discovery, health and _Create monitor_, the pages and pictures, MCP tools, `/api/v1`, import and export with ODPS – see the work packages of [ADR 0036](adr/0036-data-products-module.md#implementation-plan-phase-1).
