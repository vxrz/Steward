# Applications and protection needs

_Applications_ are what your services consist of. People call some of them platforms – _Insights Hub_, _Industrial Edge_ – and some are smaller applications without any interface. Each application can have a **CIA rating**: how much protection it needs for confidentiality, integrity and availability. A service derives its **protection need** from its applications.

- [Applications and platforms](#applications-and-platforms)
- [Create an application](#create-an-application)
- [Map platforms (integrations)](#map-platforms-integrations)
- [Add applications to a service](#add-applications-to-a-service)
- [Rate an application (CIA)](#rate-an-application-cia)
- [The protection need of a service](#the-protection-need-of-a-service)
- [The CIA scale](#the-cia-scale)
- [Documents that apply to an application](#documents-that-apply-to-an-application)
- [Who may do what](#who-may-do-what)
- [Audit, API, evidence packs, migration](#audit-api-evidence-packs-migration)

## Applications and platforms

A **platform** in Steward is an integration: an interface with a base URL, credentials and a connector type, which processes and monitors use. It has no catalogue data and no rating.

An **application** is the catalogue entry: name, description (Markdown), vendor, version, URL, the users and teams responsible for it (`user:dana`, `team:service desk`), criticality (low, medium, high, critical), tags, the CMDB entry (system, ID, link) and links – the same links as on services, both ways.

One application can have several platforms, for example _Insights Hub_ ← _IH tenant prod_ and _IH tenant test_. A platform belongs to one application at most.

## Create an application

1. _Service management → Applications → New application_ (designers and administrators).
2. Enter the name and, if you like, vendor, version, URL, description, criticality, the responsible users and teams, the CMDB entry and tags.
3. _Save_. The application page opens.

Applications are archived, not deleted (_Archive_ on the application page). An archived application no longer counts for the protection need of its services and disappears from the list and the pickers. Its rating, links and history stay. _Show archived applications_ lists them; _Restore_ brings one back.

The list has a search (name, vendor, tag) and filters by service, criticality and protection need (applications with that level in at least one dimension, or _Not rated_).

## Map platforms (integrations)

On the application page, _Integrations → Map platform_, choose the platform and _Save_.

- You can only choose platforms you may see.
- A platform that belongs to another application is refused with the name of that application. Remove it there first.
- Readers who may not see a mapped platform see _A platform you may not see_ – no name, no link.
- The platform page names its application next to the base URL.
- When a platform is deleted, it leaves its application.

## Add applications to a service

On the service page, _Applications → Add application_, choose the application and optionally its **role**:

- _Primary_ – the application the service is built on;
- _Dependency_ – something the service needs;
- _Other_ – describe the role in a few words.

The section shows each application with its role, its CIA rating and – through it – its integrations, with links to the platforms. The pencil changes the role, the bin removes the application from the service. Free links (_Links_) stay as they are.

## Rate an application (CIA)

On the application page, _CIA rating → Rate_. For each dimension choose a level and give a **justification** (required): the damage scenarios that apply. Leave a dimension empty if you have not rated it yet.

Steward stores who rated each dimension and when, and audits every change with the old and the new level.

The default levels are the protection needs of **BSI IT-Grundschutz** (BSI-Standard 200-2):

| Level         | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| **Normal**    | The impact of damage is limited and calculable.                                  |
| **High**      | The impact of damage can be considerable.                                        |
| **Very high** | The impact of damage can reach an existentially threatening, catastrophic level. |

## The protection need of a service

The service page shows, per dimension:

- **Derived:** the highest rating of its applications – the **maximum principle** of BSI-Standard 200-2. Archived applications and ratings that need re-rating do not count. The line says which application gave the level and how many of the applications are rated.
- **Effective:** the derived level, or the override.

An override sets a dimension to another level with a **reason** (_Protection need → Override_). Use it when the maximum principle does not fit:

- **Cumulation effect:** many applications of normal need together, or one failure that hits many plants at once, need more.
- **Distribution effect:** a redundant setup, or data that only leaves a plant aggregated, can need less.

_Use the derived level_ removes the override. Overrides are audited with the derived level at that moment. The services list shows the effective protection need as small badges (C, I, A).

## The CIA scale

_Applications → CIA scale_ shows the levels in use, lowest first. The order decides the maximum principle.

Administrators can change the scale (_Change scale_):

- **BSI default** – normal, high, very high for all three dimensions;
- **Own scale for all three dimensions** – for example four or five levels;
- **Own scale for each dimension** – if your company rates confidentiality, integrity and availability differently.

Each level has a key (stored with the ratings: `a`–`z`, `0`–`9`, `_`), a label, an optional description and a colour from a fixed list. Use the arrows to order the levels.

**Changing the scale never loses a rating.** When a level that is in use disappears from the new scale, the editor lists it with the number of ratings and overrides that use it:

- **map** it to a level of the new scale: the ratings keep their justification and show _Mapped from “Very high” when the scale changed_;
- or **flag for re-rating** (the default): the ratings keep their old level and justification, show _Needs re-rating_ with the old label, and do not count for the protection need until someone rates them again. The service page says how many ratings need re-rating.

Renaming a label or moving a level changes no rating (ratings store the key). Saving the scale asks for a fresh confirmation of your sign-in, because it changes the ratings of every application at once. The change is audited with the old and new levels and what happened to the ratings.

## Documents that apply to an application

A living document (a record type with the workflow _document_) that belongs to a service can name the applications it **applies to** – an ICAM concept for _Insights Hub_, an authorization concept for _Industrial Edge_.

- On the document page, _Applies to → Change_, choose the applications and _Save_ (whoever may edit the document; not for withdrawn documents). Leave it empty when it applies to the whole service.
- _New document_ on the service page offers the applications of the service.
- The service page groups its documents by application, and lists the rest under _Whole service_.
- The application page lists its documents with edition, status and review status.

The scope is not part of the document's content: changing it needs no new edition. It is audited on the record.

## Who may do what

| Action                                                                         | Who                                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| See applications, ratings, protection needs and the scale                      | Everyone who can sign in                                                                  |
| Create applications                                                            | Designers and administrators                                                              |
| Edit, archive, rate an application; map its platforms; change its links        | Designers, administrators and the users and teams responsible for it                      |
| Add applications to a service, change their role, override its protection need | Whoever may edit the service (designers, administrators, its responsible users and teams) |
| Change the CIA scale                                                           | Administrators, with a fresh confirmation (step-up)                                       |
| Change the applications a document applies to                                  | Whoever may edit the record                                                               |

Applications have no access lists, like services: the catalogue is readable for everyone. Only platforms keep their own access lists – an application never shows a platform to someone who may not see it.

## Audit, API, evidence packs, migration

- **Audit log:** `application.created`, `.updated`, `.archived`, `.restored`, `.rated`, `.platform_added`, `.platform_removed`, `.link_added` …; `service.application_added`, `.application_changed`, `.application_removed`, `service.protection_need_overridden`; `record.scope_changed`; `catalogue.cia_scale_changed`.
- **Public API** (read-only, [API.md](API.md)): `GET /api/v1/applications`, `GET /api/v1/applications/{applicationId}` (with integrations and links), `GET /api/v1/applications/{applicationId}/documents`, `GET /api/v1/cia-scale`. Services carry `applications` and `protectionNeed`; the documents of a service carry `applications` (their scope).
- **Evidence packs** of a service hold its protection need (effective, derived, override with reason) and the CIA rating of each application in `index.json` (`catalogue`) and in the summary PDF; packs of a platform hold the rating of its application. See [COMPLIANCE.md](COMPLIANCE.md#protection-needs-cia).
- **Migration packages** ([MIGRATION.md](MIGRATION.md)) carry applications, ratings, integrations, the applications of services, overrides, document scopes and the scale. The responsible users and teams follow the identity mapping; who rated something stays as it was.

Internal API (web UI): `GET/POST /api/applications`, `GET/PUT /api/applications/:id`, `POST /api/applications/:id/archive`, `PUT /api/applications/:id/rating`, `POST /api/applications/:id/platforms`, `DELETE /api/applications/:id/platforms/:platformId`, `POST/PATCH/DELETE /api/applications/:id/links[/:linkId]`, `GET /api/platforms/:id/application`, `PUT/DELETE /api/services/:id/applications/:applicationId`, `PUT /api/services/:id/protection-need`, `GET/PUT /api/catalogue/cia-scale`, `PUT /api/records/:id/applications`.
