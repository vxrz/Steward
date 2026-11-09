# 0007. The plant registry as an opt-in module

- **Status:** Accepted; its module switch is superseded in part by [0016](0016-module-registry.md) (one registry for every optional area, a step-up to switch)
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

## Part 2: data points and KPIs (0.7.0)

**Since:** 0.7.0 (#219). It extends the decision above; nothing of part 1 changes.

**Context.** Installations want to know what data each asset's interfaces deliver – and which KPIs are computed from it – to answer "which assets deliver data point X", "which KPIs can this asset have" and "why is this KPI empty for that machine". Device types repeat across sites; the same controller model has the same interfaces and data points everywhere, while endpoints, publications and computation jobs are per machine.

**Decision.**

- **Two catalogues of the installation, one assignment per asset.** A **device profile** (manufacturer, model, version, category; interfaces with protocol, direction, port, sign-in and the client they need; data point groups and data points; the files of a file-transfer interface) and a **KPI definition** (inputs, parameters with aliases, result columns of kind _sum_, _ratio_ or _ignore_, the computation and its limits) belong to no site. An asset's **assignment** names its profile and firmware, per interface whether it is set up and where, the data points that differ on it, where its data points are published (target system, path, name) and its **KPI instances** (definition, job, parameters, the dashboard or dataset that shows the result – existing Steward items, referenced, not copied).
- **Standards, as they are:** OPC UA NodeId notation and built-in data types (IEC 62541-3/-6), the Modbus Application Protocol's four tables and function codes, IEC 61131-3 elementary data types, UCUM unit codes (shown with their symbol), ISO 22400-2 attributes of a KPI (formula, unit, range, trend, timing, audience, production methodology). Addresses are checked against the interface's protocol on every save; usual spellings of other tools (`OPC-UA`, `float[]`, `kWh`) are read as their standard value.
- **A record each, JSON inside.** A profile and a KPI definition are aggregates edited and imported whole (as a site's contacts in part 1): tables `plant_profiles`, `plant_kpis` and `plant_assignments` (migration `plant-002-data-points`, additive), the interfaces, data points, parameters, columns and KPI instances as JSON columns. Lookups across them (who delivers a data point) are done in memory over a few thousand records; no core table changes.
- **Rules refuse, checks report.** What a record may not hold is refused on save and import (ids twice, an address that does not fit its protocol, a reference to a profile, interface, data point or KPI definition that does not exist). What may drift later – a data point removed from its profile, a ratio without its denominator, a parameter outside its definition, a KPI instance whose input the asset does not deliver – is a **check**: shown on the asset, the KPI definition, _Plant → Checks_ and in the import preview, never blocking. A data point counts as delivered when its interface is listed and active in the assignment and no difference says the asset lacks it.
- **Rights.** The catalogues: everyone who sees the registry sees them, whoever may add sites manages them (designers and administrators). An assignment follows its asset's site. Every list, count, search result and check names only assets of sites the reader may see.
- **Format.** Format 1 gets optional top-level keys `device_profiles`/`device_profile`, `kpi_definitions`/`kpi_definition`, `assignments`/`assignment`; files of 0.6.0 stay valid and the JSON Schema is regenerated from the same zod schema. The import modes, preview, identity (`id`, the asset for an assignment) and audit are part 1's; the export writes the catalogues and assignments and imports back unchanged.
- **Read endpoints** `/api/v1/plant/profiles[/{id}]`, `/api/v1/plant/kpis[/{id}]` and `/api/v1/plant/assets/{id}/assignment`.

**Not decided here.** Steward does not run KPI computations or read devices; it documents and checks them. Live values and the OT network are part 3 (#220).

## Part 3: OT network (0.8.0)

**Since:** 0.8.0 (#220). It extends the decisions above; nothing of parts 1 and 2 changes.

**Context.** Installations want to know how the OT network of a plant looks – which VLANs and subnets there are, which IEC 62443 zones and conduits separate them, which devices an asset has on the network, where its data goes – and whether an asset is online right now. Most of this lives in spreadsheets next to the firewall change process; Steward already has network segments, firewall changes (#208), monitors and datasets.

**Decision.**

- **Documentation, not a CMDB or IPAM.** Formats are checked as the standards define them – IEEE 802.1Q VIDs (1–4094), CIDR subnets and IPv4/IPv6 addresses, EUI-48 MAC addresses in IEEE 802 notation, DNS host names – overlaps are not, and Steward reads nothing from switches or firewalls.
- **Per site: VLANs, zones, conduits; per asset: devices, data paths, checks.** VLANs (subnets with typed ranges, restricted, who manages them, where their rules are kept, other sites, location), **IEC 62443-3-2** zones (criticality, VLANs, owner, **SL-T** – open until a risk assessment sets it, so SL-T requires the assessment's reference) and conduits (two different zones, direction, protocols, controls) are keyed by site and id; devices (the asset's network identity) and data paths (subject, devices, collector, transfers, destinations) by asset and id. Tables `plant_vlans`, `plant_zones`, `plant_conduits`, `plant_devices`, `plant_data_paths`, `plant_asset_checks` (migration `plant-003-ot-network`, additive); sub-lists as JSON, as in part 2. Removing a site or asset removes its OT network.
- **Steward items are referenced, never copied or created on their own.** A VLAN may name a **network segment** (a system of kind network) – picked, or created on request from the VLAN through the catalogue's own `createSystem` (its rights, its audit). Differences between a linked pair are shown as a hint, never synchronised. Collectors are Steward applications, platforms or processes (or a job elsewhere by name); hosts of transfers and destinations are Steward systems, which makes chains (_pull job → file share → archive job_) computable: a path continues in every path that reads from a system it writes to. **Conduits are a link kind** (`conduit`, id `<site>/<conduit>`), so firewall change records name the conduit they change; no core table changes.
- **Live status only from linked checks.** A device or asset is online, offline or unknown from monitors (a whole monitor or one of its checks – Gatus, CheckMk, MQTT silent-device, Kafka …) and dataset freshness (a row per device or asset, a time column, a maximum age). Offline wins; online only when every linked check says so; nothing linked or no result is unknown – **unknown is never shown as online**. The status is computed when read (no own history). It is a fact about the asset, so a reader who sees the site sees it, while the monitor or dataset behind it is named only for readers who may see that item (a plant viewer: names, no links). One rule for the OT network and the visualizations (0.8.0 security review): a check the reader may not see – or that no longer exists – still counts, but shows only its state (online, offline, unknown), never its name, key, check, reason, time or filter; a dataset is read as the reader where they may see it. We accept that an asset's status tells everyone who sees the asset the combined state of its checks – with a single check, that check's state. Linking a monitor or dataset, or changing what a linked check reads, needs the right to see it.
- **Rights and audit as in part 1.** The OT network follows the site through `decide()`; status viewers never reach it and status pages never show it; previews, lists and link searches leave out what the reader may not see. Every change is audited on the site or asset.
- **Format.** Format 1 gets the optional top-level keys `ot_network`/`ot_networks` and `asset_network`/`asset_networks`; earlier files stay valid, the JSON Schema is regenerated from the same zod schemas, an imported record goes through the same input schema and rules as an edit, and the export writes them back unchanged. The modes, preview, identity and audit are part 1's.
- **Read endpoints** `/api/v1/plant/sites/{siteId}/network` and `/api/v1/plant/assets/{assetId}/network`. The internal `GET /api/plant/sites/:siteId/network` answers with everything a diagram needs (zones, conduits, VLANs, devices, data paths with resolved collectors and hosts, live status) in one response.

**Not decided here.** Steward does not discover devices, scan subnets or push rules; a status history and alerts stay with the monitors.

## Update 0.11: profile inheritance and asset additions

**Since:** 0.11.0. It extends part 2; nothing else changes.

**Context.** Controller generations and variants share most of their interfaces and data points; copying a profile (_Duplicate_) left every copy to be kept in step by hand. Single machines often have a few data points or a whole interface (an extra I/O module) that their kind does not.

**Decision.**

- **One base, several levels.** A profile may extend one base profile (`extends`, column `base_id`); chains are at most 8 profiles, cycles and a profile extending itself are refused. The derived profile stores only its own part: its own interfaces, **overrides** of inherited interfaces (the fields it changes, data points and files it adds, `present: false`) and of inherited data points (the fields it changes, `present: false`) – columns `interface_overrides` and `point_overrides` (migration `plant-005-profile-extends`, additive).
- **Resolution in one place.** `server/src/plant/resolve.ts` computes the **resolved profile** – the effective model with the origin of every interface and data point (own, inherited, overridden) – and every reader uses it (`allProfiles()`, `resolvedProfile()`): data point pages, who delivers what, assignments, checks, KPI inputs, coverage, data flow, lineage and the API. Only the editor and the export read the own part. A KPI input naming a base reads every profile that extends it.
- **Rules refuse, drift is shown.** On save and import: the base exists, no cycle, no own interface with an inherited id, no id twice in the effective model (for the profile and for every profile that extends it, so a base save that would break a derived profile is refused), addresses fit their protocol. A base that is extended is not deleted (`PLANT_PROFILE_EXTENDED`). An override of an item the base no longer has changes nothing and is named on the profile page.
- **Asset additions.** An assignment may add data points to an interface of its profile and whole interfaces (column `additions` of `plant_assignments`). The asset's model is its resolved profile with them; they count as delivered by the same rule as the profile's data points. An added data point the profile later gets too is the profile's (check `addition_shadowed`).
- **Format.** Format 1 gets the optional keys `extends`, `present` (interfaces and data points of a derived profile), `aliases` (data points) and `additions` (assignments); a derived profile is written with the same keys as any profile, only its own part, and the export imports back unchanged. Files of earlier versions stay valid.

**Consequences.** A base change reaches every derived profile at once – that is the point, and also why a base save checks its derived profiles. The effective model is computed on read (a few thousand profiles, in memory), not stored.

## Update 0.12: inherited descriptions and proposals from assistants

**Since:** 0.12.0. It extends the update of 0.11; nothing else changes.

**Context.** Descriptions are what a reader of a profile needs first, and a derived profile mostly describes the same device as its base. AI assistants read manuals and gateway configurations well and are asked to fill the registry from them; the registry must stay what people decided.

**Decision.**

- **Descriptions are inherited like other fields.** The resolved profile carries the description of the base when the derived profile has none, and `descriptionFrom` – the profile whose description is in effect – for the profile and every interface, group, data point and file set (`origins.groups`, `origins.fileSets` are new). A derived profile describes an item anew in its own part: as a field of an interface or data point override, as the description of an override group of an inherited group's name, or of a file set of the same id; an empty group or file set description inherits. The export still writes only the own part.
- **Assistants propose, people apply.** Through MCP an assistant reads the registry with its owner's rights and proposes a document of format 1. Steward runs the import's preview (a dry run) and stores the proposal (`plant_proposals`) in the AI requests inbox. A person who may import applies it through the import core; the preview runs again with their rights, and what is applied is the preview they saw (a fingerprint). A proposal only adds and changes: no removals, no renames, no other modes, and no item dropped from a list inside an entry – checked when proposed and when applied.

**Consequences.** A derived profile without a description now shows its base's. An assistant can describe a whole profile family and the asset-specific addresses of a line, and nothing reaches the registry without a person; a proposal that would drop something must be sent with the full lists, which makes it larger but never silently loses data. Data collections join format 1 in the same release ([ADR 0019](0019-data-collections.md#update-012-proposals-from-assistants)).
