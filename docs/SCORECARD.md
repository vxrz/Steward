# Availability objectives and the service scorecard

Is a service in good shape? The _scorecard_ answers it in one place, per service, in four parts: are its **duties** met, is its **availability** on target, is its **documentation** current, and is its **protection need** rated. _Availability objectives_ say what "on target" means for each Gatus endpoint of a service.

- [Availability objectives](#availability-objectives)
- [Define an objective](#define-an-objective)
- [Status of an objective](#status-of-an-objective)
- [Hourly samples and breaches](#hourly-samples-and-breaches)
- [The scorecard](#the-scorecard)
- [Expected documents (rules on the CIA rating)](#expected-documents-rules-on-the-cia-rating)
- [Rollup and trend](#rollup-and-trend)
- [Where you see it](#where-you-see-it)
- [Who may do what](#who-may-do-what)
- [Audit, API, reports, migration](#audit-api-reports-migration)

## Availability objectives

Uptime targets differ per endpoint, and some assets rightly have a lower uptime. An objective names **one Gatus endpoint** and a target for each window you want to judge:

| Window  | Gatus uptime API                      |
| ------- | ------------------------------------- |
| 1 h     | `/api/v1/endpoints/{key}/uptimes/1h`  |
| 24 h    | `/api/v1/endpoints/{key}/uptimes/24h` |
| 7 days  | `/api/v1/endpoints/{key}/uptimes/7d`  |
| 30 days | `/api/v1/endpoints/{key}/uptimes/30d` |

Each window is optional, for example "24 h ≥ 99 %, 30 days ≥ 99.5 %". Targets have at most two decimals, as Gatus' figures do. An objective belongs to a service and, if you like, to one of its applications ([APPLICATIONS.md](APPLICATIONS.md)).

The values are **Gatus' own uptime figures**. Steward does not calculate service hours or production schedules and makes no extra call to Gatus: the metrics mode of a Gatus platform reads the figures once an hour when _Also read Gatus' uptime figures_ is on ([GATUS.md](GATUS.md)). Turn it on for every Gatus platform you use for objectives.

## Define an objective

1. Open the service: _Service management → Services → (service)_.
2. In _Availability objectives_, choose _Add objective_.
3. Choose the Gatus platform and the endpoint. The list shows the platforms with metrics mode that you may see, and the endpoints Gatus reported to them.
4. Check the name (it starts as the endpoint's name), set the targets, and choose the application if the objective is about one.
5. Tick _Send a message when it falls below target_ if the owners should hear about it.
6. _Save_.

_Edit_ (pencil) changes an objective; _Delete_ (bin) removes it with its samples and breaches. The scorecard history keeps what it was.

## Status of an objective

Per window with a target:

| Status           | Meaning                                |
| ---------------- | -------------------------------------- |
| **Met**          | Gatus' value is at or above the target |
| **Below target** | Gatus' value is below the target       |
| **No data**      | There is no value for the window       |

The objective is _below target_ when any window is below; else _no data_ when any window has no value; else _met_. The card says why there is no data:

- the platform has no metrics mode, or it is off;
- Gatus' uptime figures are not read (_Also read Gatus' uptime figures_ is off);
- the figures were last read more than 3 hours ago;
- Gatus does not report the endpoint any more;
- Gatus reported no value for a window.

## Hourly samples and breaches

Once an hour, Steward stores a **sample** of each objective: the values it had read from Gatus and the status. Samples are kept for **90 days**; the objective's page (API: `/api/v1/objectives/{objectiveId}/samples`) shows them.

A **breach** starts with the first sample below target and ends with the first sample that meets every target again. _No data_ neither starts nor ends a breach. Ended breaches are kept for 400 days.

With _Send a message …_ on, the service owners (administrators when it has none) get **one message per breach** – not one per sample (notification event `objective.breached`, in-app by default; route it to e-mail, Teams or a webhook in _Settings → Notifications_, see [NOTIFICATIONS.md](NOTIFICATIONS.md)).

## The scorecard

Each part has its own status. There is **no weighting** and no score:

| Status           | Meaning                                                    |
| ---------------- | ---------------------------------------------------------- |
| **OK**           | Everything that counts is met                              |
| **Attention**    | Something that counts is not met                           |
| **Open**         | Nothing failed, but something is still open or has no data |
| Nothing to judge | The part has nothing to judge (no duties, no objectives)   |

A service shows **Attention needed** when any part has the status _Attention_.

| Part                | Attention when …                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Duties**          | a **mandatory** duty was not met in its last closed period (missed or failed). _Open_ while a current period is still due ([DUTIES.md](DUTIES.md))                             |
| **Availability**    | an objective is below target. _Open_ when one has no data                                                                                                                      |
| **Documentation**   | no living document is released, a review is overdue, or an expected document is missing ([RECORDS.md](RECORDS.md))                                                             |
| **Protection need** | it is not rated: the service has no applications, a dimension has no level, applications are not rated or must be re-rated after a scale change, or the CIA scale is not valid |

Details:

- **Duties** are read from the stored periods of [service duties](DUTIES.md): met means done, late or skipped (an approved exception). **Recommended** duties are counted separately and never set _Attention needed_; **optional** duties are only shown.
- **Documentation** counts the living documents linked to the service (either way) and those that apply to its applications. A document counts as present once it has an approved edition and is not withdrawn; drafts do not.
- **Protection need** follows the maximum principle of [APPLICATIONS.md](APPLICATIONS.md): a level from an override is enough; a derived level needs every application rated in that dimension.

Archived services have no scorecard.

## Expected documents (rules on the CIA rating)

Administrators can say which document types an application needs because of its protection need, for example: _applications rated confidentiality **high** or above should have an authorization concept_. A rule names

- a **document type** – a record type with the living-document workflow ([RECORDS.md](RECORDS.md));
- a **dimension** – confidentiality, integrity or availability;
- a **minimum level** of that dimension's CIA scale.

For each application of a service rated at least that level (a valid rating; ratings to re-rate do not count), the scorecard expects a **released** document of the type that applies to the application – or that is linked to the service and not limited to other applications. A missing one sets _Attention_ for documentation.

The list **starts empty**: document types differ per installation, and a rule that names a type you do not have would only produce noise. A sensible first rule, after you created a record type `AUTHZ` (_Authorization concept_, workflow _living document_):

| Document type | Dimension       | From level |
| ------------- | --------------- | ---------- |
| `AUTHZ`       | Confidentiality | High       |

_Service management → Scorecard → Expected documents → Add rule_. A rule can be turned off. A rule whose type was archived or whose level is no longer on the scale is kept but not applied (shown as _Not applied_).

## Rollup and trend

The _Scorecard_ page shows

- the **rollup** of all services: how many need attention, and per part;
- the rollup **per owner** – each user and team that owns services; a service with two owners counts for both, services without owners are a group of their own;
- the **trend**: how many services needed attention on each stored day.

Once an hour, Steward stores **today's scorecard of every service** (a _snapshot_). A day is written during that day only and never after, so the trend shows what the scorecard said then – it does not recompute history from data that changed later. Snapshots are kept for **730 days**. The service page shows the last 90 stored days of the service.

## Where you see it

- **Service page**: the _Scorecard_ section (four parts with details and the stored days) and the _Availability objectives_ section.
- **Service management → Scorecard**: rollup, trend, every service with its parts, the rules. _Attention needed only_ and the owner filter narrow the list.
- **Start page**: the tile _Services needing attention_. Administrators, designers and auditors see every service, everyone else the services they own; people who own no service do not get the tile.
- **Scheduled reports**: the section _Service scorecard_ (see below).

## Who may do what

| Action                                  | Who                                                                 |
| --------------------------------------- | ------------------------------------------------------------------- |
| See the scorecard, objectives and rules | Everyone who can sign in (like services and duties)                 |
| Define, change and delete objectives    | Whoever may edit the service: administrators, designers, its owners |
| Choose the platform and the endpoint    | Only Gatus platforms the author may see (use or manage)             |
| Change the expected-document rules      | Administrators                                                      |

Only what you may see counts and shows:

- People who may not see an objective's Gatus platform see its name, status and values, but **not** the platform or the endpoint – as duties hide the names of processes you may not view. A platform you may not see is "not found" when you define an objective, so platform ids cannot be probed. Such an editor can still change the name and targets; the endpoint stays.
- Documents you may not read are neither listed nor counted. A stored day whose documentation relied on a document you may not read shows that part as _Hidden_ (and it does not count for that day's _Attention needed_).

## Audit, API, reports, migration

- **Audit**: `objective.created`, `objective.updated`, `objective.deleted`, `objective.breached`, `objective.recovered` (by `system`), `scorecard.rule_created`, `scorecard.rule_updated`, `scorecard.rule_deleted`.
- **Public API** (read-only, [API.md](API.md)): `GET /api/v1/scorecard`, `/api/v1/scorecard/trend`, `/api/v1/services/{serviceId}/scorecard`, `/api/v1/objectives`, `/api/v1/objectives/{objectiveId}/samples`.
- **Scheduled reports** ([REPORTS.md](REPORTS.md)): the section _Service scorecard_ lists every service with its parts and _Attention needed_, the trend of the stored days in the report period, and the objectives with their status at the end of the period and the breaches that started in it. For a report period that has ended, the services come from the snapshot of its last day, so a report made later shows the same.
- **Migration packages** ([MIGRATION.md](MIGRATION.md)): objectives, rules, samples, breaches and snapshots move; the owners stored with a snapshot follow the identity mapping.
