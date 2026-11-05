# 0007. The plant registry as an opt-in module

- **Status:** Accepted
- **Date:** 2026-11-05
- **Since:** 0.6.0 (#217, part 1: #218) – marked _preview_

## Context

Installations that run IoT or manufacturing services need one place for the factories (sites) of their enterprise, how each factory is organised, which assets stand where, and later which data each asset delivers and how its OT network looks (#219, #220). Today this often lives in YAML files in Git with a small app on top. The information is about _plants_, not about _services_: most installations of Steward do not have it, and none of the service core (processes, platforms, monitors, the catalogue, records) may depend on it.

Two standards describe the domain well and are used as they are:

- **ISA-95 / IEC 62264-1** (enterprise-control system integration) defines the role-based equipment hierarchy: enterprise → site → area → work center (production line, production unit, process cell, storage zone) → work unit (unit, work cell, storage unit).
- **IEC 81346-1** (structuring principles) separates the _function_ aspect (what happens) from the _location_ aspect (where). A hall number never goes into a functional id: an area may span several halls, and a hall may hold several areas.

## Decision

**A module of its own, off by default.** _Settings → Modules → Plant registry_ turns it on per installation (internal setting `plant.settings`, administrators; audited). While it is off, every route of the module answers **404 `PLANT_MODULE_OFF`** – the internal API (`/api/plant/…`), its read endpoints in `/api/v1/plant/…` and the duplicate route of assets – the sidebar has no _Plant_ area, the link pickers offer no site or asset, links to them resolve to "not visible", and nothing else changes. Turning it off keeps the data; turning it on brings it back.

**Its own code, tables and routes.** `server/src/plant/` (model rules, services, import and export, routes, the public API), `web/src/pages/Plant*.tsx` and `web/src/components/plant/`, the tables `plant_sites`, `plant_nodes`, `plant_buildings`, `plant_assets`, `plant_asset_images`, `plant_refs` and `plant_imports` (migration `plant-001-registry`, additive). No core table gets a column.

**The core is used through its stable interfaces only:**

| Interface                                        | Used for                                                                                                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in, route access (`auth/access.ts`)         | Every route is a signed-in route; status viewers are refused like everywhere ([0005](0005-route-access-declared-on-routes.md)).                                                                                              |
| Rights and owning teams (`auth/policy.ts`)       | A site is a resource kind (`site` in `OWNED_KINDS`); its rights are decided by `decide()` with the module's role defaults and the site's access list ([0006](0006-owning-teams-policy-module.md)). Assets follow their site. |
| Audit log (`audit()`)                            | Every change, every import (with counts and the files' SHA-256) and every export ([0003](0003-hmac-chained-audit-log.md)).                                                                                                   |
| Links (`records/links.ts`)                       | `site` and `asset` are link kinds and link sources (`registerLinkKind`); documents, records, tickets, services and applications name them, an asset names systems, applications and platforms.                               |
| Duplicate (`duplicate/`)                         | Assets can be duplicated (attributes, not the external references).                                                                                                                                                          |
| Step-up / assurance policy (`auth/assurance.ts`) | A site's access list is a grant: control point `access.grant`, like the access lists of processes and platforms.                                                                                                             |

Later phases read monitors, checks and datasets (live status) through the same interfaces – read-only.

**Data model.**

- **Site** (stable id, code, name with translations, description, position, contacts, external references, own fields, access list).
- **Hierarchy nodes** of a site: `area` (optional domain), `work_center` (below an area; optional ISA-95 type), `work_unit` (below a work center; optional type). Ids are unique per site.
- **Buildings** of a site, the spatial axis: building, hall, floor, room, outdoor area; a building part names the building it is in (no cycles). A node _names_ a building; the building that applies to a node is its own, else its parents' – **the innermost one wins**. An asset may override it.
- **Asset** (stable id, unique in the installation): name, manufacturer, model, status, location (site and the innermost node; the levels above are derived, a level that does not contain it is refused), optional building override, parent asset (same site, **no cycles**), taxonomy (domain, process area, role), tags, lifecycle (commissioned, end of support), description, capabilities, image (PNG/JPEG/WebP, served inert), external references, own fields.
- **External references** (system, id, URL) hold the ids of other tools; `GET /api/v1/plant/assets?ref=erp:4711` finds an asset by them.
- **Own fields** per record type and **display names** per installation and language (`asset` → "Machine") are settings: generic words in the model, the installation's words on the screen.

**Import identity and replace rules.** The import format is versioned (`version: 1`), YAML or JSON in snake_case, published as a JSON Schema 2020-12 document (`docs/plant/plant-registry-1.schema.json`, generated from the zod schema the import checks). A file holds a whole tree (`sites:`), one site (`site:`) or only assets (`assets:`, naming their site); several files are imported together. Records are matched by their stable ids (a site by its id, a node or building by site and id, an asset by its id). Every record remembers the import that wrote it last (`import_id`). Modes:

- _add_: only records that are not there; existing ones are left alone (shown as skipped);
- _update_: add, and overwrite what the file says – keys the file leaves out keep their values;
- _replace_ an earlier import: the file is written in full, and the records **that earlier import wrote** and the file no longer has are **removed** or **kept and marked "not in source"** (the person's choice). Records entered by hand are never removed; records that stay but name something that goes lose that reference (shown in the preview); a site that still holds such records is marked instead of removed.

Every import shows its preview first (add, change, remove, mark, unchanged, skip per record, with the fields that change), and applies all or nothing in one transaction. Problems name the file and the place in it (`sites[0].areas[2].id`). Limits as for the other YAML importers: 8 MB for all files, a bound on keys before parsing, linear duplicate-key check, nesting depth 12, alias count 100.

**Permissions.** View and manage per site. Without owning teams or an access list: every role that works in Steward sees a site (as the catalogue), designers and administrators manage it. An access list restricts a site to its entries (plus administrators; auditors always see). With owning teams, their members have their roles there. A new instance role **Plant viewer** (`plant`) sees only the plant registry: a user whose only working role it is reaches nothing else – the server refuses the other routes (as for status viewers), the web app shows the Plant area and the profile; linked systems and applications show by name only. Nothing of the module is shown on status pages.

## Why not a separate app, and why not the system catalogue

- **A separate app** would need its own sign-in, rights, audit log and links into Steward – the parts that make the registry trustworthy – and could not link documents, tickets and services to an asset or (later) derive an asset's status from Steward's monitors. The module boundary gives the same independence (own tables, routes, pages; off by default) without a second identity and audit trail.
- **The system catalogue** (`systems`) holds the IT a service runs on: servers, clusters, network segments. Assets have another life cycle, another hierarchy (ISA-95 location, equipment parent and child), other owners (the plant, not a service team) and much larger numbers. Folding them in would give every system ISA-95 fields and every service view plant data. Instead an asset _links_ to the systems, applications and platforms it uses – a gateway stays a Steward application or platform, a network segment (0.5.0) stays a system and is linked to a VLAN of the registry in part 3; nothing becomes one automatically.

## Consequences

- Installations that never turn the module on see no change: no navigation, no link kinds, no routes; the tables exist but stay empty.
- The import format is a contract: later versions add optional keys (device profiles, data points, OT network – #219, #220) without changing version 1; a breaking change gets version 2 and its own schema file.
- Ids are stable by design: renaming a site or asset changes its name, never its id. An id that has to change is a remove and an add (an import in replace mode shows both).
- The module is marked _preview_ in 0.6.0: its pages and API may still change in 0.7.0 and 0.8.0.
