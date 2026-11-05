# Plant registry (preview)

The plant registry documents the factories of the enterprise an installation serves: its **sites**, how each site is organised (**areas, work centers, work units**), its **buildings**, and the **assets** – machines and equipment – in them. It is an opt-in module: off by default, and while it is off nothing of it shows and the rest of Steward works as before. The design is recorded in [ADR 0007](adr/0007-plant-registry.md).

> **Preview in 0.6.0.** The pages, the API and the import format may still change in 0.7.0 (data points and KPI definitions, #219) and 0.8.0 (OT network and live status, #220). Format 1 stays importable.

- [Turning it on](#turning-it-on)
- [Concepts and standards](#concepts-and-standards)
- [Sites, hierarchy and buildings](#sites-hierarchy-and-buildings)
- [Assets](#assets)
- [Links to Steward items](#links-to-steward-items)
- [Own fields and display names](#own-fields-and-display-names)
- [YAML import and export](#yaml-import-and-export)
- [Permissions](#permissions)
- [API](#api)

## Turning it on

_Settings → Modules → Plant registry_ (administrators): **Turn on the plant registry**, give the enterprise's name and save. The sidebar gets the area **Plant** with _Sites_, _Assets_ and – for whoever may manage a site – _Import_; documents, tickets, services and applications can link to sites and assets.

Turning it off hides the area, the pages and the link kinds again; every route of the module answers `404` with the code `PLANT_MODULE_OFF` (also `/api/v1/plant/…`). The data stays and is back when the module is turned on again. Turning it on or off is audited (`plant.module_enabled`, `plant.module_disabled`).

In the demo (`npm run demo`) turning the module on loads an invented enterprise with two sites (`examples/plant/brightwater.plant.yaml`).

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

## YAML import and export

The format is YAML (or JSON) in snake_case, **version 1**, described by a JSON Schema 2020-12 document: [`docs/plant/plant-registry-1.schema.json`](plant/plant-registry-1.schema.json) (also `GET /api/plant/schema`). Editors that understand `# yaml-language-server: $schema=…` check a file while it is written; the export writes that line.

A file holds

- a whole tree – `sites:` with every site, its buildings, areas and assets;
- one site – `site:` (a file per site);
- or only assets – `assets:`, each naming its site in `location.site` (a file per asset).

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

### Modes

_Plant → Import_ (or `POST /api/plant/import`): choose the files and the mode, look at the preview, then import.

| Mode                          | New records | Records that exist                                                  | Records the file lacks                                                                                                      |
| ----------------------------- | ----------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Add only**                  | added       | left as they are (shown as _skip_)                                  | left alone                                                                                                                  |
| **Add and update**            | added       | get what the file says; keys the file leaves out keep their values  | left alone                                                                                                                  |
| **Replace an earlier import** | added       | written in full: the file is the truth (keys left out become empty) | those **the chosen earlier import wrote** are **removed** or **kept and marked _not in source_** – your choice; others stay |

- Records are matched by their stable ids. Every record remembers the import that wrote it last; replacing an import adopts its records into the new one, so the next replace finds them again. A marked record that comes back into a file loses its mark.
- Records entered by hand are never removed by an import. When they name something that is removed (an asset in a removed work unit, a node in a removed building), they lose that reference – the preview shows it as a change; a node added by hand below a removed node stops the import (add it to the file, or keep and mark). A site that still holds records that stay is marked instead of removed.
- The **preview** lists every record as _add, change, remove, mark, unchanged_ or _skip_, with the fields that change, and the counts per kind. **Problems** name the file and the place in it (`sites[0].areas[1].work_centers[0].type: Use one of: production_line, …`); a file with problems imports nothing. The import applies all or nothing, in one transaction.
- Every import is audited (`plant.imported`) with mode, counts, the files with their size and SHA-256, and the SHA-256 of all files together; the import page lists earlier imports.
- **Limits** (as for the other YAML importers): all files together at most 8 MB, at most 500 files, a bound on the number of keys before parsing, duplicate keys found in linear time (they are errors), nesting at most 12 levels deep, at most 100 aliases.

### Export

_Export YAML_ on the site list (every site you may see) or on a site page (that site, as `site:`), or `GET /api/plant/export[?site=<id>]`. The export is format 1 and imports back unchanged: exporting, importing the file in _replace_ mode and exporting again gives the same file. It is audited (`plant.exported`).

## Permissions

Rights are per site; the hierarchy, buildings and assets of a site follow it ([ADR 0006](adr/0006-owning-teams-policy-module.md)):

- **Without owning teams or access list**: every role that works in Steward (viewer, operator, approver, auditor, designer, administrator) sees the site; designers and administrators manage it (change it, its hierarchy, buildings and assets, import into it). Designers and administrators add sites.
- **Access list** (site page → _Access_, for who manages it; adding an entry asks for a step-up like other grants): only its entries get their rights – _view_ or _manage_ – plus administrators; auditors always see.
- **Owning teams**: as for other resources, members of the owning teams have their instance and team roles on the site.
- **Plant viewer** (`plant`): a new instance role that sees the plant registry (sites that are not restricted) and nothing of the automation: no processes, platforms or monitors.
- **Status viewers** never see the module; nothing of it is shown on status pages.

A site or asset that you may not see answers `404`, as if it did not exist; a link to it shows as "not visible".

## API

The internal API (the web app) is under `/api/plant/…`: `sites`, `sites/:siteId` with `nodes`, `buildings`, `links` and `access`, `hierarchy`, `assets`, `assets/:assetId` with `image` and `links`, `import/preview`, `import`, `imports`, `export`, `schema`, `config`; the switch and settings are `GET`/`PUT /api/settings/plant`.

The public, read-only API ([API.md](API.md), tag _Plant_):

- `GET /api/v1/plant/sites` – sites with counts (paginated);
- `GET /api/v1/plant/sites/{siteId}` – a site with its hierarchy, each node's building, its buildings, contacts, external references, own fields and links;
- `GET /api/v1/plant/assets?site=&node=&domain=&status=&tag=&ref=` – assets with location and external references (paginated); `ref=erp:10004711` finds an asset by another tool's id;
- `GET /api/v1/plant/assets/{assetId}` – an asset with equipment, lifecycle, capabilities and links.

They answer `404` while the module is off.
