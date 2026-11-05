# Plant registry (preview)

The plant registry documents the factories of the enterprise an installation serves: its **sites**, how each site is organised (**areas, work centers, work units**), its **buildings**, the **assets** – machines and equipment – in them, and since 0.7.0 **what data each asset's interfaces deliver and which KPIs are computed from it** (device profiles, data points, KPI definitions). It is an opt-in module: off by default, and while it is off nothing of it shows and the rest of Steward works as before. The design is recorded in [ADR 0007](adr/0007-plant-registry.md).

> **Preview.** The pages, the API and the import format may still change in 0.8.0 (OT network and live status, #220). Format 1 stays importable; 0.7.0 added optional keys to it (#219).

- [Turning it on](#turning-it-on)
- [Concepts and standards](#concepts-and-standards)
- [Sites, hierarchy and buildings](#sites-hierarchy-and-buildings)
- [Assets](#assets)
- [Links to Steward items](#links-to-steward-items)
- [Own fields and display names](#own-fields-and-display-names)
- [Device profiles, data points and KPIs](#device-profiles-data-points-and-kpis)
- [YAML import and export](#yaml-import-and-export)
- [Permissions](#permissions)
- [API](#api)

## Turning it on

_Settings → Modules → Plant registry_ (administrators): **Turn on the plant registry**, give the enterprise's name and save. The sidebar gets the area **Plant** with _Sites_, _Assets_, _Device profiles_, _KPI definitions_, _Explore data_, _Checks_ and – for whoever may manage a site – _Import_; documents, tickets, services and applications can link to sites and assets.

Turning it off hides the area, the pages and the link kinds again; every route of the module answers `404` with the code `PLANT_MODULE_OFF` (also `/api/v1/plant/…`). The data stays and is back when the module is turned on again. Turning it on or off is audited (`plant.module_enabled`, `plant.module_disabled`).

In the demo (`npm run demo`) turning the module on loads an invented enterprise with two sites (`examples/plant/brightwater.plant.yaml`) and invented device profiles, KPI definitions and assignments of some assets (`examples/plant/brightwater-data-points.plant.yaml`) – milling centre 2 has a KPI instance whose OPC UA interface is not set up yet, so _Checks_ has something to show.

## Concepts and standards

The model follows two standards, so that a plant engineer finds the words they know and the data maps to other tools:

- **ISA-95 / IEC 62264-1** (enterprise-control system integration), the role-based equipment hierarchy: _enterprise → site → area → work center → work unit_. Work centers are production lines, production units, process cells or storage zones; work units are units, work cells or storage units. Steward records the kind as an optional **ISA-95 type**.
- **IEC 81346-1** (structuring principles), the separation of **function** and **location**: an area, work center or work unit says _what happens_; a building says _where_. Never fold a hall number into a functional id or name – an area may span several halls, and a hall may hold several areas. The two axes meet through references: a node _names_ its building.

**The innermost building wins.** The building that applies to a node is its own, else its work center's, else its area's. An asset may override it with its own building. The site page shows each node's building (inherited ones in italics), the asset page where its building comes from.

**Stable ids.** Every record has an id of lower-case letters, digits, `.`, `_` and `-` (at most 80) that never changes – links, imports and other tools rely on it. Site and asset ids are unique in the installation; node and building ids are unique within their site.

**Generic words, the installation's names.** The module's words are generic (_site, area, work center, work unit, building, asset_). An installation gives its own names per language under _Display names_ (for example _Machine_ instead of _Asset_) without changing the model; other tools' ids go into **external references** (system, id, link), site-specific attributes into **own fields**.

## Sites, hierarchy and buildings

A **site** has a code (short, unique, e.g. `RVS`), a name with translations, a description, a position (latitude, longitude, map zoom – shown as a link to OpenStreetMap), contacts, external references and own fields.

On the site page:

- **Hierarchy**: areas (with an optional manufacturing domain), their work centers and work units; add, edit, move (a work center to another area, a work unit to another work center – its assets follow) and remove (only empty nodes). Each node names its building or inherits it.
- **Buildings**: buildings, halls, floors, rooms and outdoor areas; a floor or room names the building it is in (no cycles). A building that something names cannot be removed.
- The site's assets by status, its links, its access list and owning teams.

## Assets

An asset has a stable id, name, manufacturer, model and **status** (_planned, commissioning, operational, maintenance, out of service, decommissioned_) and:

- **location**: its site and the innermost place – an area, work center or work unit; the levels above follow from it. A place of another site, or levels that do not belong together, are refused. Optionally its own building;
- **equipment**: the asset it is part of (same site; the equipment hierarchy has no cycles) and the assets that are part of it. Deleting an asset keeps its parts, without a parent;
- **taxonomy**: domain, process area, role; **tags**; **lifecycle**: commissioned, end of support (a badge shows when it has passed);
- description, capabilities, an **image** (PNG, JPEG or WebP, at most 512 KB, never SVG; served with `Content-Security-Policy: sandbox`), external references, own fields, links.

The asset list filters by site, place, domain (the asset's or its area's), status and tag; the filters are part of the address, so links from a site's tree lead to its assets. _Duplicate_ copies an asset's attributes and location – not its external references (their ids belong to the original), its image, links or parts.

## Links to Steward items

`site` and `asset` are link kinds like systems or services:

- documents, records, firewall changes, ticket references (as affected items), services and applications link to them;
- an asset links to the **systems** (a PLC gateway server, a network segment), **applications** (a connectivity gateway) and **platforms** it uses; the system page lists the assets under _Linked from_.

The module references Steward items instead of copying them: a gateway stays a Steward application or platform, a network segment stays a system. A reader sees a link's target only when they may see its site – otherwise "not visible", as for every link kind. While the module is off, links to sites and assets stay but resolve to "not visible".

## Own fields and display names

_Settings → Modules → Plant registry_:

- **Display names**: per record type and language, the word for one and for several.
- **Own fields**: per record type (site, area, work center, work unit, building, asset) a list of fields with a snake_case key, label, kind (_text, number, date, yes/no, choice, link_), options of a choice, and whether it is required. Values are checked on every save and import: unknown keys, wrong kinds and missing required fields are refused with the field's name. Removing a field from the schema keeps stored values (shown by their key).

## Device profiles, data points and KPIs

Part 2 of the registry (#219, [ADR 0007 – Part 2](adr/0007-plant-registry.md#part-2-data-points-and-kpis-070)) records what data an asset's interfaces deliver and which KPIs are computed from it. Two **catalogues** belong to the installation, not to a site; the **assignment** belongs to its asset.

### Standards

| What             | Standard                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OPC UA addresses | **IEC 62541-6** (OPC UA mappings) NodeId string notation: `ns=<index>;i=<number>`, `ns=…;s=<string>`, `ns=…;g=<guid>`, `ns=…;b=<base64>`, or `nsu=<namespace URI>;…` – checked on every save                                                                                                                                                                                                           |
| Data types       | **IEC 62541-3/-6** built-in data types (`Boolean`, `SByte` … `UInt64`, `Float`, `Double`, `String`, `DateTime`, `ByteString`, the abstract `Number`, `Integer`, `UInteger` …) and the **IEC 61131-3** elementary types of PLCs (`BOOL`, `INT`, `DINT`, `REAL`, `LREAL`, `TIME`, `STRING` …); `[]` marks an array. `int`, `float`, `bool`, `string` are read as `Integer`, `Float`, `Boolean`, `String` |
| Modbus addresses | **Modbus Application Protocol 1.1b3**: the four tables and the function code that reads them – `coil:<address>` (FC 01), `discrete:<address>` (FC 02), `input:<address>[,<count>]` (FC 04), `holding:<address>[,<count>]` (FC 03); 0-based PDU addresses, the count in registers (also `c`, `di`, `ir`, `hr`, `i`, `h`)                                                                                |
| Units            | **UCUM** case-sensitive codes (`kW.h`, `Cel`, `/min`, `%`, `V.A`), shown with their symbol (kWh, °C, 1/min); usual spellings such as `kWh`, `°C` or `rpm` are read as their code. Units UCUM lacks (`var`) are kept as written                                                                                                                                                                         |
| KPI attributes   | **ISO 22400-2** (KPIs for manufacturing operations management): name, description, formula, unit of measure, range, trend, timing, audience, production methodology, notes (and the effect diagram as the computation's diagram)                                                                                                                                                                       |
| Equipment        | **ISA-95 / IEC 62264-1**, as for part 1: a profile describes a kind of equipment, an asset is the equipment                                                                                                                                                                                                                                                                                            |

### Device profiles

_Plant → Device profiles_: a kind of controller or device – **manufacturer, model, version** (the firmware or product version it describes), **category**, description and notes – with its **interfaces**:

- **protocol** (_OPC UA, Modbus/TCP, MQTT, Web (HTTP), SMB file share, WebDAV, SFTP, FTP, other_), **direction** (read, write, read and write – seen from whoever reads the device), **default port**, **sign-in** (none, user name and password, certificate, token, other), the **client it needs** (a gateway, a driver, a browser, “manual”), version, description and notes;
- **data point groups** (machine state, energy …) and **data points**: a stable id (unique in the profile; capitals allowed, as devices name them), name, **data type**, **unit**, **address** (OPC UA NodeId, Modbus address, an MQTT topic, a file path or column …), **access**, **update rate** (ms), the **values** of a state or code, notes and where it is usually published;
- **files** of a file-transfer interface (id, name, format, path pattern, one per …, retention, encoding).

A data point has its own page: what it is (a Modbus address also says what it reads: “Input registers 13–14 (2) · function code 04”), **which assets deliver it** and the KPI definitions that read it. _Duplicate_ copies a profile with its interfaces and data points (for the next firmware generation). A profile that an asset has cannot be deleted.

### Assignment of an asset

The asset page has the section **Data and KPIs**:

- its **device profile** and **controller firmware**;
- per interface of the profile whether it is **set up and active** on this asset, its **endpoint** (`opc.tcp://…`, a host and port, a broker, a share) and notes;
- **differences**: data points that differ here (address, unit, data type, update rate) or that this asset does not deliver;
- **publications**: which data point is published where – target system (an IoT platform, a historian), path (an aspect, a topic) and name (a variable), who publishes it;
- its **KPI instances**: the KPI definition, the **job** name (unique per asset), active, the **parameters** and where the result is shown – a Steward **dashboard** (id) and/or **dataset** (key), linked for readers who may see them;
- the **checks** of the asset and the **KPIs it can have**.

A data point counts as **delivered** when the profile has it, its interface is listed and active in the assignment, and no difference says the asset lacks it. _Duplicate_ of an asset copies its profile, firmware, interfaces and differences – not the endpoints, publications or KPI instances (they belong to the original).

### KPI definitions

_Plant → KPI definitions_: id, name (with translations), **category** (availability, performance, quality, energy …), type, description and the ISO 22400-2 attributes (formula, unit, range, trend, timing, audience, production methodology); the computing system's **method** and **where its code lives**, and whether its columns vary from run to run.

- **Inputs**: a profile and the data points of it the computation reads (empty profile: whatever profile the asset has), or an _other_ input that is not checked.
- **Parameters**: name, **aliases** (other spellings a job may use), type (number, whole number, text, yes/no), default, required, lowest and highest value, unit, description.
- **Result columns**: name, **kind** – _sum_ (summed over a longer period), _ratio_ (numerator / denominator × scale, both summed first: the only correct way to combine percentages over a period) or _ignore_ (descriptive) –, scope (which windows it is written for), unit, description.
- **Computation**: a summary, steps (what, why), identities (what always holds between the columns), **limits** (what the computation cannot tell) and a diagram as text.

The page lists the assets with an instance and **the assets that could have it** (they deliver every input but have no instance). _Duplicate_ makes the next version.

### Checks

Steward checks the data; a problem never stops a save, it is shown on the asset, on the KPI definition, on _Plant → Checks_ and in an import's preview, as a plain sentence:

| On               | Check                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a KPI instance   | the definition exists; **every data point input is delivered** (the asset has a profile, the profile the input names, the data point, its interface is active, no difference says it lacks it) |
| a KPI instance   | **the parameters are the definition's**: known names or aliases, each once, of their type, within their range; required ones without a default are given                                       |
| a KPI definition | **a ratio has its numerator and denominator** and they are columns of the definition (unless its columns vary); its inputs name profiles and data points that exist                            |
| an assignment    | the profile, interfaces and data points it names exist (they are checked on save, too; a data point removed from its profile later shows here)                                                 |

### Search

_Plant → Explore data_: **who delivers a data point** – a text across every profile's data points (id, name, address, description; a plain match, no pattern) with the number of assets that deliver each – and **which KPIs an asset can have**. The asset list filters by device profile and, from a data point, by the data point (`/plant/assets?profile=…&dataPoint=…`).

### Rights

Everyone who sees the plant registry sees the catalogues (the role _Plant viewer_ included); **designers and administrators** manage them (whoever may add sites). An assignment and its KPI instances follow the asset's site: who sees the site sees them, who manages it changes them. Lists, counts, the search, the checks and the data point and KPI pages count and name only assets of sites the reader may see; a profile that only a hidden asset has is “still in use” without a count. Every change is audited (`device_profile.created|updated|deleted`, `kpi_definition.created|updated|deleted`, `asset.assignment_set|assignment_removed`, `*.duplicated`).

## YAML import and export

The format is YAML (or JSON) in snake_case, **version 1**, described by a JSON Schema 2020-12 document: [`docs/plant/plant-registry-1.schema.json`](plant/plant-registry-1.schema.json) (also `GET /api/plant/schema`). Editors that understand `# yaml-language-server: $schema=…` check a file while it is written; the export writes that line.

A file holds

- a whole tree – `sites:` with every site, its buildings, areas and assets;
- one site – `site:` (a file per site);
- or only assets – `assets:`, each naming its site in `location.site` (a file per asset);
- since 0.7.0 also (optional keys; files of 0.6.0 stay valid) **device profiles** – `device_profiles:` or `device_profile:` (a file per profile), **KPI definitions** – `kpi_definitions:` or `kpi_definition:`, and **assignments** of assets – `assignments:` or `assignment:` (a file per asset).

Several files are imported together, so a repository with one hierarchy file per site and one file per asset is one import.

```yaml
# yaml-language-server: $schema=https://github.com/vxrz/Steward/blob/main/docs/plant/plant-registry-1.schema.json
version: 1
enterprise:
  name: Brightwater Components
site:
  id: riverside
  code: RVS
  name: Riverside Works
  names: { de: Werk Riverside }
  geo: { lat: 52.3512, lon: 9.0531, zoom: 16 }
  contacts:
    - { name: Plant office, role: Site management, email: plant-office@example.com }
  external_refs:
    - { system: erp, id: PLANT-1000 }
  buildings: # the spatial axis
    - { id: rvs-hall-1, name: Hall 1, kind: hall }
    - { id: rvs-hall-2, name: Hall 2, kind: hall }
    - { id: rvs-hall-2-mezzanine, name: 'Hall 2, mezzanine', kind: floor, parent: rvs-hall-2 }
  areas: # the functional axis
    - id: rvs-machining
      name: Machining
      domain: machining
      work_centers:
        - id: rvs-mill-line-1
          name: Milling line 1
          type: production_line
          building: rvs-hall-1 # its work units inherit it
          work_units:
            - { id: rvs-mill-line-1-cell-1, name: Milling cell 1, type: work_cell }
  assets:
    - id: rvs-mill-01
      name: Milling centre 1
      manufacturer: Example Machine Tools
      model: VMC 800
      status: operational
      location: { work_unit: rvs-mill-line-1-cell-1 } # area and work center follow
      taxonomy: { domain: machining, process_area: milling, role: machining-centre }
      tags: [cnc, milling]
      lifecycle: { commissioned: '2019-03-01', end_of_support: '2031-12-31' }
      capabilities: [5-axis simultaneous milling]
      external_refs:
        - { system: cmms, id: EQ-2231, url: https://cmms.example.com/equipment/EQ-2231 }
      fields: { cost_center: '4711' } # own fields, defined in the settings
    - id: rvs-mill-01-meter
      name: Power meter of milling centre 1
      parent: rvs-mill-01 # equipment hierarchy (children: [...] on the parent works as well)
      location: { work_unit: rvs-mill-line-1-cell-1 }
```

An asset file on its own:

```yaml
version: 1
assets:
  - id: rvs-compressor-01
    name: Compressed air station
    location: { site: riverside, area: rvs-utilities, building: rvs-yard }
```

Keys: a site has `id`, `code`, `name`, `names`, `description`, `geo`, `contacts`, `external_refs`, `fields`, `buildings`, `areas`, `assets`; a building `id`, `name`, `names`, `kind` (_building, hall, floor, room, outdoor, other_), `parent`, `description`, `fields`; an area `id`, `name`, `names`, `domain`, `building`, `description`, `fields`, `work_centers`; a work center and a work unit `id`, `name`, `names`, `type`, `building`, `description`, `fields` (and `work_units`); an asset `id`, `name`, `manufacturer`, `model`, `status`, `location` (`site`, `area`, `work_center`, `work_unit`, `building`), `parent`, `children`, `taxonomy` (`domain`, `process_area`, `role`), `tags`, `lifecycle` (`commissioned`, `end_of_support`), `description`, `capabilities`, `image` (the image's file name; the image itself is uploaded in Steward), `external_refs`, `fields`. Unknown keys are errors, so a typo never goes unnoticed. Translate your own files into this form once (for example `asset_id` → `id`, `manufacturing_domain` → `taxonomy.domain`, `external_ids` → `external_refs`).

### Device profiles, KPI definitions and assignments

```yaml
version: 1
device_profile:
  id: example-meters-pm200
  name: Example Meters PM 200 power meter
  manufacturer: Example Meters
  model: PM 200
  version: any
  category: Power meter
  interfaces:
    - id: modbus-tcp
      protocol: modbus_tcp # also written OPC-UA, Modbus/TCP, SMB/CIFS …
      default_port: 502
      client: Modbus gateway
      groups:
        - name: Power and energy
          data_points:
            - { id: active_power_total, name: Active power, data_type: Float, unit: kW, address: 'input:65,2', update_rate_ms: 10000 }
            - { id: active_energy_import, name: Active energy, data_type: Double, unit: kW.h, address: 'input:801,4' }
      data_points: [] # data points without a group
---
version: 1
kpi_definition:
  id: energy-consumption
  name: Energy consumption
  category: Energy
  unit: kW.h
  trend: lower_is_better # ISO 22400-2
  inputs:
    - { profile: example-meters-pm200, data_points: [active_energy_import] }
  parameters:
    - { name: closest_point_max_distance_ms, aliases: [max_distance_ms], type: integer, default: 900000, min: 0 }
  columns:
    - { name: energy, kind: sum, unit: kW.h }
    - { name: duration_hours, kind: sum, unit: h }
    - { name: mean_power, kind: ratio, unit: kW, numerator: energy, denominator: duration_hours }
---
version: 1
assignment:
  asset: rvs-mill-01-meter
  site: riverside # optional, checked
  profile: example-meters-pm200
  firmware: '2.0'
  interfaces:
    - { interface: modbus-tcp, active: true, endpoint: 'rvs-mill-01-meter.ot.example.com:502' }
  overrides:
    - { data_point: power_factor, available: false }
  publications:
    - { data_point: active_power_total, target: iot-platform, path: rvs-mill-01/energy, name: ActivePower, published_by: gateway }
  kpis:
    - { kpi: energy-consumption, job: rvs-mill-01-energy, active: true, params: { closest_point_max_distance_ms: 600000 }, dataset: plant.energy }
```

(Three files in one block for brevity; each `---` part is its own file.) Keys: a profile has `id`, `name`, `manufacturer`, `model`, `version`, `category`, `description`, `notes`, `interfaces`; an interface `id`, `name`, `protocol`, `direction`, `description`, `version`, `default_port`, `authentication`, `client`, `notes`, `groups` (`name`, `description`, `data_points`), `data_points`, `file_sets` (`id`, `name`, `description`, `format`, `direction`, `path_pattern`, `produced_per`, `retention`, `encoding`, `notes`); a data point `id`, `name`, `description`, `data_type`, `unit`, `address` (or `node_id` / `modbus_address`), `access`, `update_rate_ms`, `enum_values`, `notes`, `publications` (`target`, `path`, `name`). A KPI definition has `id`, `name`, `names`, `category`, `type`, `description`, `formula`, `unit`, `range` (`min`, `max`), `trend`, `timing`, `audience`, `methodology`, `strategy`, `implementation`, `dynamic_columns`, `inputs` (`kind`, `profile`, `data_points`, `notes`), `parameters` (`name`, `aliases`, `description`, `type`, `default`, `required`, `min`, `max`, `unit`), `columns` (`name`, `kind`, `scope`, `unit`, `numerator`, `denominator`, `scale`, `description`), `computation` (`summary`, `diagram`, `steps` with `name`, `does`, `why`, `identities` with `relation`, `note`, `limits`), `notes`. An assignment has `asset`, `site`, `profile`, `firmware`, `interfaces` (`interface`, `active`, `endpoint`, `notes`), `overrides` (`data_point`, `available`, `address`, `unit`, `data_type`, `update_rate_ms`, `notes`), `publications` (`data_point`, `target`, `path`, `name`, `published_by`, `notes`), `kpis` (`kpi`, `job`, `active`, `params`, `dashboard`, `dataset`, `notes`), `notes`.

Values are read in their usual spellings: protocols `OPC-UA`, `Modbus/TCP`, `SMB/CIFS`, `HTTP`; sign-in `username-password`; data types `int`, `float[]`, `bool`; units `kWh`, `°C`, `rpm`; an input kind `datapoint`. Files of other tools import after renaming their keys, for example `profile_id`/`kpi_id` → `id`, `display_name` → `name`, `type` (of an interface) → `protocol`, `requires_client` → `client`, `datapoint_groups` → `groups`, `group` → `name`, `datapoints` → `data_points`, `type` (of a data point) → `data_type`, `opc_node_id` → `node_id`, `typical_update_rate_ms` → `update_rate_ms`, `params` → `parameters`, `variables` → `data_points`, `arity` → `scope`; in an assignment `asset_id` → `asset`, `controller_profile` → `profile`, `controller_firmware` → `firmware`, `connectivity` → `interfaces`, `interface_id` → `interface`, `endpoint_url` → `endpoint`, `datapoint_overrides` → `overrides`, publications' `datapoint` → `data_point`, `aspect` → `path`, `variable` → `name`, `job_name` → `job`; attributes of the asset itself (its tags, its name) go into the asset, not the assignment. A profile and a KPI definition are matched by their `id`, an assignment by its asset.

### Modes

_Plant → Import_ (or `POST /api/plant/import`): choose the files and the mode, look at the preview, then import.

| Mode                          | New records | Records that exist                                                  | Records the file lacks                                                                                                      |
| ----------------------------- | ----------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Add only**                  | added       | left as they are (shown as _skip_)                                  | left alone                                                                                                                  |
| **Add and update**            | added       | get what the file says; keys the file leaves out keep their values  | left alone                                                                                                                  |
| **Replace an earlier import** | added       | written in full: the file is the truth (keys left out become empty) | those **the chosen earlier import wrote** are **removed** or **kept and marked _not in source_** – your choice; others stay |

- Records are matched by their stable ids. Every record remembers the import that wrote it last; replacing an import adopts its records into the new one, so the next replace finds them again. A marked record that comes back into a file loses its mark.
- Records entered by hand are never removed by an import. When they name something that is removed (an asset in a removed work unit, a node in a removed building), they lose that reference – the preview shows it as a change; a node added by hand below a removed node stops the import (add it to the file, or keep and mark). A site that still holds records that stay is marked instead of removed.
- The **preview** lists every record as _add, change, remove, mark, unchanged_ or _skip_, with the fields that change, and the counts per kind. It needs the import's own right (adding sites, or managing one) and names nothing of sites you may not see: an earlier import of such a site counts as not found, a code or asset id taken there gets a message without that site, and its records are left out. **Problems** name the file and the place in it (`sites[0].areas[1].work_centers[0].type: Use one of: production_line, …`); a file with problems imports nothing. The import applies all or nothing, in one transaction.
- Every import is audited (`plant.imported`) with mode, counts, the files with their size and SHA-256, and the SHA-256 of all files together; the import page lists earlier imports.
- Device profiles and KPI definitions need the right to manage the catalogues (designers and administrators), an assignment the manage right on its asset's site; an asset in a site you may not see reads like one you may not change. An assignment names an asset, profile, interfaces, data points and KPI definitions that exist after the import (in the files or in Steward). In _replace_ with _remove_, a profile or KPI definition that goes while an assignment that stays still names it stops the import; an assignment goes with its asset.
- **Checks** of the records in the files – as they will be after the import – are shown in the preview ([Checks](#checks)); they do not stop the import.
- **Limits** (as for the other YAML importers): all files together at most 8 MB, at most 500 files, a bound on the number of keys before parsing, duplicate keys found in linear time (they are errors), nesting at most 12 levels deep, at most 100 aliases.

### Export

_Export YAML_ on the site list (every site you may see, with the device profiles, KPI definitions and the assignments of the assets), on a site page (that site, as `site:`, with the assignments of its assets), on the profile and KPI lists (`?part=catalogue`: the device profiles and KPI definitions) and on a profile or KPI definition page (`?profile=<id>`, `?kpi=<id>`: one record, as `device_profile:` or `kpi_definition:`), or `GET /api/plant/export[?site=<id>|?part=catalogue|?profile=<id>|?kpi=<id>]`. The export is format 1 and imports back unchanged: exporting, importing the file in _replace_ mode and exporting again gives the same file. It is audited (`plant.exported`).

## Permissions

Rights are per site; the hierarchy, buildings and assets of a site follow it ([ADR 0006](adr/0006-owning-teams-policy-module.md)):

- **Without owning teams or access list**: every role that works in Steward (viewer, operator, approver, auditor, designer, administrator) sees the site; designers and administrators manage it (change it, its hierarchy, buildings and assets, import into it). Designers and administrators add sites.
- **Access list** (site page → _Access_, for who manages it; adding an entry asks for a step-up like other grants): only its entries get their rights – _view_ or _manage_ – plus administrators; auditors always see.
- **Owning teams**: as for other resources, members of the owning teams have their instance and team roles on the site.
- **Plant viewer** (`plant`): a new instance role that **sees only the plant registry** (sites that are not restricted) and their own profile. For a user whose only working role it is – no other instance role (a _status_ role adds the status pages) and no role in a team – the server refuses every other route (`403 PLANT_VIEWER_ONLY`), the public API answers only `/api/v1/plant/…` and `/api/v1/me`, the MCP endpoint refuses them, and the web app shows the _Plant_ area and the profile only. Linked systems and applications show by name, without a link; records, services and credentials that link to a site or asset are not listed. With another working role, they keep that role's access.
- **Status viewers** never see the module; nothing of it is shown on status pages.
- **Device profiles and KPI definitions** (#219) belong to the installation: everyone who sees the registry sees them, designers and administrators manage them. An asset's **assignment and KPI instances** follow its site ([Rights](#rights)).

A site or asset that you may not see answers `404`, as if it did not exist; a link to it shows as "not visible".

## API

The internal API (the web app) is under `/api/plant/…`: `sites`, `sites/:siteId` with `nodes`, `buildings`, `links` and `access`, `hierarchy`, `assets`, `assets/:assetId` with `image` and `links`, `import/preview`, `import`, `imports`, `export`, `schema`, `config`; since 0.7.0 `assets/:assetId/assignment` (`GET`, `PUT`, `DELETE`), `profiles`, `profiles/:profileId` with `points/:pointId` and `duplicate`, `kpis`, `kpis/:kpiId` with `duplicate`, `explore/points?q=` and `checks`; `assets` also takes `profile` and `dataPoint`; the switch and settings are `GET`/`PUT /api/settings/plant`.

The public, read-only API ([API.md](API.md), tag _Plant_):

- `GET /api/v1/plant/sites` – sites with counts (paginated);
- `GET /api/v1/plant/sites/{siteId}` – a site with its hierarchy, each node's building, its buildings, contacts, external references, own fields and links;
- `GET /api/v1/plant/assets?site=&node=&domain=&status=&tag=&ref=` – assets with location and external references (paginated); `ref=erp:10004711` finds an asset by another tool's id;
- `GET /api/v1/plant/assets/{assetId}` – an asset with equipment, lifecycle, capabilities and links;
- `GET /api/v1/plant/assets/{assetId}/assignment` – its device profile, firmware, interfaces with endpoints, differences, publications, KPI instances, checks and the KPIs it can have;
- `GET /api/v1/plant/profiles`, `GET /api/v1/plant/profiles/{profileId}` – device profiles with their interfaces, data points, assets and the KPI definitions that read them;
- `GET /api/v1/plant/kpis`, `GET /api/v1/plant/kpis/{kpiId}` – KPI definitions with inputs, parameters, columns, computation, checks, instances and candidates;
- `GET /api/v1/plant/assets?profile=&dataPoint=` – the assets that have a profile (and deliver one of its data points);
- `GET /api/v1/plant/checks?site=&asset=&kpi=&kind=` – the problems of [Checks](#checks) (paginated);
- `GET /api/v1/plant/export?site=|part=catalogue|profile=|kpi=&format=yaml|json` – the registry in the import format.

They answer `404` while the module is off.

### Fetching the registry from other tools

Create an API token with the scope _Read only_ (_Profile → API tokens_). The token sees what its owner sees: sites they may not see, and their assets, are never in an answer; device profiles and KPI definitions belong to the installation and are always there. A Plant viewer's token works, too.

```sh
TOKEN=smt_…   # better: read it from your secret store
BASE=https://steward.example.com/api/v1

# the assets of a site, 200 at a time
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/plant/assets?site=riverside&limit=200"

# the problems Steward finds, of one KPI definition and its instances
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/plant/checks?kpi=machine-state-time"
```

Lists are paginated: an answer has `items` and `nextCursor`; while `nextCursor` is not `null`, send it back unchanged as `cursor` (with the same filters) for the next page – the `Link` header (`rel="next"`) has that URL, too ([API.md](API.md#pagination)). `limit` is 1–200 (default 50).

```sh
cursor=""
while :; do
  page=$(curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/plant/checks?limit=200${cursor:+&cursor=$cursor}")
  echo "$page" | jq -c '.items[] | {kind, asset: .asset.id, job, message}'
  cursor=$(echo "$page" | jq -r '.nextCursor // empty')
  [ -z "$cursor" ] && break
done
```

**Backups in Git.** `GET /api/v1/plant/export` gives the same file as _Export YAML_ in the web app (format 1, [Export](#export)): it imports back unchanged, so a nightly job can keep the registry in a repository and show each change as a diff. A YAML export starts with two comment lines, the second with the time of the export; leave them out (`tail -n +3`), or use `format=json` (no comments):

```sh
curl -sS -f -H "Authorization: Bearer $TOKEN" "$BASE/plant/export" | tail -n +3 > plant/registry.plant.yaml
curl -sS -f -H "Authorization: Bearer $TOKEN" "$BASE/plant/export?part=catalogue&format=json" > plant/catalogue.plant.json
git -C plant add -A && git -C plant commit -qm "plant registry $(date -u +%F)" || true   # nothing changed: no commit
```

Each export is recorded in the audit log (`plant.exported`, with `via: "api"` and the token's id). Errors are problem details (`application/problem+json`): `404` for a site, profile or KPI definition that does not exist or that the token's owner may not see, `400` for a wrong parameter or cursor.
