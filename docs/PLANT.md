# Plant registry (preview)

The plant registry documents the factories of the enterprise an installation serves: its **sites**, how each site is organised (**areas, work centers, work units**), its **buildings**, the **assets** – machines and equipment – in them, since 0.7.0 **what data each asset's interfaces deliver and which KPIs are computed from it** (device profiles, data points, KPI definitions), and since 0.8.0 the **OT network** of sites and assets – VLANs, zones and conduits, devices, data paths – with the **live status** of each asset. It is an opt-in module: off by default, and while it is off nothing of it shows and the rest of Steward works as before. The design is recorded in [ADR 0007](adr/0007-plant-registry.md).

> **Preview.** The pages, the API and the import format may still change. Format 1 stays importable; 0.7.0 (#219) and 0.8.0 (#220) added optional keys to it.

- [Turning it on](#turning-it-on)
- [Concepts and standards](#concepts-and-standards)
- [Sites, hierarchy and buildings](#sites-hierarchy-and-buildings)
- [Assets](#assets)
- [Links to Steward items](#links-to-steward-items)
- [Own fields and display names](#own-fields-and-display-names)
- [Device profiles, data points and KPIs](#device-profiles-data-points-and-kpis)
- [Part 3: OT network](#part-3-ot-network)
- [Visualizations](#visualizations)
- [Map](#map)
- [YAML import and export](#yaml-import-and-export)
- [Permissions](#permissions)
- [API](#api)

## Turning it on

_Settings → Modules → Plant registry_ (administrators): **Turn on the plant registry**, give the enterprise's name and save. The sidebar gets the area **Plant** with _Sites_, _Assets_, _Map_ (since 0.10.0), _Device profiles_, _KPI definitions_, _Explore data_, _Checks_ and – for whoever may manage a site – _Import_; documents, tickets, services and applications can link to sites and assets. Each site page leads to its **OT network** (since 0.8.0).

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

## Part 3: OT network

Part 3 of the registry (#220, [ADR 0007 – Part 3](adr/0007-plant-registry.md#part-3-ot-network-080)) documents how the plant's operational-technology network looks and whether an asset is online. It is documentation, **not a CMDB, not an IP address management tool**: Steward checks formats (VLAN IDs, CIDR subnets, addresses, MAC addresses), not overlaps, and reads nothing from switches or firewalls. A **site** holds its VLANs, zones and conduits; an **asset** its devices, data paths and the checks that tell its live status.

### Standards

| What               | Standard                                                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VLANs              | **IEEE 802.1Q**: the VLAN identifier (VID) is 1–4094                                                                                                                                                                                                                  |
| Subnets, addresses | **CIDR** notation (RFC 4632) for IPv4 and IPv6 (`10.20.110.0/24`, `2001:db8::/48`); addresses IPv4 (RFC 791) or IPv6 (RFC 4291 text forms)                                                                                                                            |
| MAC addresses      | **EUI-48** (IEEE 802): any usual spelling is accepted (`ac:de:48:00:00:80`, `acde.4800.0080`) and stored in IEEE 802 notation `AC-DE-48-00-00-80`                                                                                                                     |
| Zones and conduits | **IEC 62443-3-2** (security risk assessment for system design): a _zone_ groups assets with the same security requirements; a _conduit_ connects two zones; the **target security level SL-T** (1–4) of a zone is set by a risk assessment – until then it stays open |
| Host names         | DNS names (RFC 1123 labels)                                                                                                                                                                                                                                           |

### VLANs and network segments

_Plant → Sites → a site → OT network → VLANs_: a VLAN has a stable id, a name, its **VID**, a type (production, management, DMZ …), an owner, a description, **subnets** (CIDR, an optional gateway inside the subnet, **ranges** from a first to a last address of the type _blocked_, _dynamic_ or _static_), whether access is **restricted**, who **manages** it, **where its access rules are kept**, other **sites** it reaches and its **location**.

A VLAN can be **linked to a Steward network segment** (a system of kind _Network segment_, [FIREWALL-CHANGES.md](FIREWALL-CHANGES.md#network-segments)): pick an existing one, or use **Create segment from this VLAN** in the VLAN's menu – Steward creates the segment with the VLAN's VID, subnets, the zones it is in and the site's name, with the catalogue's own rights and audit, and links it. **Nothing becomes a segment on its own.** When a linked pair differs – another VID, subnets only one of them has (compared in canonical form, so `10.1.2.3/24` and `10.1.2.0/24` are the same) – the VLAN shows a **hint** with the difference; Steward changes neither.

A VLAN that zones or devices name cannot be removed (`PLANT_VLAN_IN_USE`).

### Zones and conduits

_OT network → Zones and conduits_:

- a **zone** has a description, a **criticality** (low, medium, high, critical), the **VLANs** of the site in it, an owner, the **SL-T** – with the **risk assessment** that set it (required with SL-T: a document number or link) and its date – and notes. Without SL-T the zone shows _SL-T open_;
- a **conduit** connects **two different zones** of the site, with a **direction** (from the first to the second, the other way, both), its **protocols** (`opc-ua tcp/4840`, `https tcp/443`), its **controls** (firewall, data diode, jump host) and notes.

**Firewall changes link to a conduit**: `conduit` is a link kind (id `<site>/<conduit>`, shown under _Links → Conduit_ while the module is on), so a firewall change (`FWC`) names the conduit it changes besides the affected segments and systems. The conduit lists the records that link to it. A zone that a conduit connects cannot be removed (`PLANT_ZONE_IN_USE`).

### Devices of an asset

On the asset page, section **OT network → Devices** – the network identity of the asset, often a small box next to the machine: **host name and domain**, purpose, **MAC** (EUI-48), serial number; **VLAN** (of the asset's site), **address type** (dynamic, reserved, static) and **address**; **switch, switch port, wall outlet, CMDB port name**; **state** (planned, active, inactive, retired), **flags** (snake_case: `device_ordered`, `port_ordered`, `address_ordered` …) and a **confidence** (high, medium, low: how sure the documentation is); **owner**, the **monitoring** that watches it (text) and its **linked checks**. A device shows a hint when its VLAN does not exist (any more), its address is outside the VLAN's subnets or in a blocked range. _OT network → Devices_ lists the devices of every asset of the site, with a search.

### Data paths of an asset

**OT network → Data paths**: what data leaves the asset – a **subject** (machine state, NC programs), the **devices** it covers, the **collector** (a Steward **application**, **platform** or **process**, or a **job** elsewhere by name, optionally with the Steward **system** it runs on), its **transfers** (protocol, **push or pull**, port, the **peer**: a device of the asset, a Steward system or text) and its **destinations** (a Steward system with a path, a Steward dataset, or text).

**Hosts are Steward systems**, so chains of services – _pull job → file share → archive job_ – can be followed link by link: a data path **continues in** every data path that reads (as a transfer peer or the collector's host) from a system it writes to, and **comes from** those that write to a system it reads from, across assets and sites the reader may see – at most 50 each, with the number of the others ("and 120 more"; `nextMore` and `previousMore` in the API). A device that a data path names cannot be removed (`PLANT_DEVICE_IN_USE`).

### Live status

An asset or device is **online**, **offline** or **unknown** – **only from its linked checks**:

- a **monitor** (by key or id) or **one of its checks** (by check id or key): Gatus endpoints, CheckMk services, the MQTT silent-device check, Kafka and every other check type ([MONITORS.md](MONITORS.md)). _Up_ and _degraded_ are online (degraded with its reason), _down_ is offline; no result yet, blocked, maintenance or a monitor or check that is turned off is unknown;
- the **freshness of a dataset** (the last value of an aspect on an IoT platform, published by a process): optionally only the rows whose **column** has a **value** (the row of this asset or device), the **time column** of the last value and a **maximum age** in minutes (empty: the dataset's own freshness, [DASHBOARDS.md](DASHBOARDS.md)). Newer is online, older offline; no data under the key, no row or no readable time is unknown.

A device is offline when any of its checks says offline, online only when **every** check says online, unknown otherwise – and **unknown when nothing is linked**. An asset combines its own checks with those of its devices that have checks (a device without checks says nothing): offline wins, unknown is never shown as online. The status is shown on the asset page, on the **site page** (a card with the counts) and on the site's **overview dashboard** _OT network → Status_ (online, offline and unknown assets, each with its devices and data paths). It is read when the page is read; Steward stores no status history of its own (the monitors and datasets have theirs).

**An asset's status reveals the state of its linked checks to everyone who sees the asset** – that is why a Plant viewer, who may see no monitor at all, sees the real status. What a reader learns of a check depends on whether they may see what it checks:

- a monitor or dataset **they may see** is named, with its check, the reason and the time; it is linked unless they are a Plant viewer (names only). A dataset is read **as the reader**: only the partitions they may read count (a row on a platform they may not use is "no row" for them);
- one **they may not see** – or that no longer exists, the two read the same – **still counts towards the status**, but shows only as **"a check you may not see"** with _online_, _offline_ or _unknown_: no name, key, id, check, reason, time, value or filter. The [visualizations](#visualizations) follow the same rule, so the two pages tell nothing more together than each alone. When an asset has only that one check, its status is that check's state.

Linking a monitor or a dataset needs the right to see it – in the editor, the API and the YAML import, with the same answer for one that does not exist ("There is no dataset …"). Another check of a linked monitor, or another column, value, time column or maximum age of a linked dataset, is a new link and needs that right too; the columns must be columns of the dataset. A manager who may not see a linked check keeps it as it is (the editor shows it as "a check you may not see") or removes it; the export leaves it out and an import keeps it. A time column is read as a time only between the year 2000 and a year from now (epoch seconds, milliseconds or an ISO 8601 date); anything else is "no readable time".

### Rights

The OT network follows its site ([Permissions](#permissions)): who **sees the site** sees its VLANs, zones, conduits and the devices, data paths and live status of its assets – the role _Plant viewer_ included; who **manages the site** changes them. Status viewers never reach it, and nothing of it is shown on status pages. A site or asset someone may not see answers `404`, in the import too ("There is no site …", "You may not add or change asset …"); a VLAN's other sites (`sites` and `otherSites`, in the internal API, `/api/v1` and the export) and the conduit link targets leave out sites they may not see – a save or an import keeps those, as they cannot name or remove them. Linking a monitor or a dataset as a check, a segment, a collector or a host needs to see it (an item that was linked before may stay); a dataset as a data path's destination is documentation and may be one that is published later. Every change is audited on its site or asset: `site.vlan_added|vlan_changed|vlan_removed`, `site.zone_*`, `site.conduit_*`, `asset.device_added|device_changed|device_removed`, `asset.data_path_*`, `asset.checks_set`; creating a segment from a VLAN is also `system.created`.

## Visualizations

Since 0.8.0 (#230) the registry draws what it **documents**: how a site is structured, where an asset's data goes, which assets deliver a data point, which KPIs are covered and how data crosses the site's OT network. The pictures are documentation, not monitoring:

- **Live status only where it is real.** Colour, "failing" marks and status words come only from Steward items that are linked to the part: a **monitor** the asset links to (its status: _Up, Degraded, Down, Maintenance, Blocked_), the **dataset** a KPI instance names (its freshness: _Fresh, Due, Stale_) and the **plant checks** ([Checks](#checks)). A part without such a link is drawn neutral. A linked item without data – a dataset that has no rows yet, or one the reader may not see – says **No data**, never OK. A linked monitor the reader may not see counts as on the OT network ([Live status](#live-status)): "a check you may not see" with _online_, _offline_ or _unknown_ only (a degraded or maintained monitor is not told apart), without name or link. Every view has a small legend that says which parts have live status.
- **Motion means direction.** The edges of a graph move in the direction of the documented flow; a path that is highlighted moves faster; a node whose live status changes pulses once. With the system setting _reduce motion_ (`prefers-reduced-motion`) nothing moves and arrows show the direction; the switch **Animation off** does the same for whoever wants it (remembered in the browser).
- **A table for every picture.** _Picture_ or _Table_ above each view (phones start with the table): the same parts and their status in words. Nodes are focusable and labelled (Tab moves through them, Enter opens the part's page), statuses carry an icon and a word, never colour alone; light and dark themes.
- **Export.** Every picture downloads as **SVG** or **PNG** (the download button above it), for documents and presentations.
- **The same rights as the pages.** Only assets of sites the reader may see are drawn or counted; monitors, datasets and dashboards follow their own rights (a hidden dashboard is drawn as "not visible", without its name). The Plant viewer sees the pictures, without monitors and datasets.

### Site structure

![The structure of a site: the areas of Riverside Works as a treemap, each tile with its assets and a status ring](images/plant/structure.png)

Site page → **Structure**: the ISA-95 hierarchy (areas → work centers → work units) as a **zoomable treemap**. Each tile is sized by the assets in it and shows their number, a **status ring** (the assets' documented status – planned, commissioning, operational, maintenance, out of service, decommissioned) and – where assets link to monitors – an inner ring and counts of their monitors' states. Inside a tile its parts are drawn small, with a strip of their status and a square per asset. A click (or Enter) opens a part with a short zoom, the path above goes back (Escape too); the innermost level lists its assets. **Group by** switches to the **buildings** – the location aspect of IEC 81346 instead of the function aspect of ISA-95. Large sites stay fast: only one level is drawn at a time, at most 5,000 assets are listed (the counts cover all).

### Data flow of an asset

![The data flow of milling centre 2: its interfaces, the inactive OPC UA server and the KPI job whose input is missing, drawn dashed](images/plant/data-flow.png)

Asset page → **Data flow**: from the part-2 assignment – the asset → its **interfaces** (protocol, endpoint) → the **collector** (who publishes the data, else the client the interface needs) → the **target systems** of its publications (with their paths) → the **KPI jobs** that read the data → the **datasets** and **dashboards** that show their result. The numbers on the edges are the data points that take the way. An interface that is not set up or not active is drawn **dashed** with _Not active_; a KPI input that is not delivered (a failing plant check) is dashed in red with _Check fails_ and the problem on the job. The list beside the picture names every data point: pointing at one highlights its way end to end, a click keeps it and zooms to it. Without an assignment the page says what to add.

### Lineage of a data point

![The lineage of the program status: the assets of the profile, where they publish it and the KPI that reads it](images/plant/lineage.png)

A data point's page ends with its **lineage**: the same flow, fanned out from the point – every asset with the profile (dashed when it does not deliver the point), where each publishes it and the KPI definitions that read it, with their jobs' results. With more than 24 assets the picture draws one node per site (how many of them deliver); the list and the table still name every asset.

### KPI coverage

![The KPI coverage matrix: assets of Riverside Works against the KPI definitions, with the state of each](images/plant/coverage.png)

_Plant → Explore data → KPI coverage_ and the KPI page (**Coverage**): assets × KPI definitions, each cell one of

| State             | Means                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Has it**        | a KPI job is set up on the asset                                                                                              |
| **Problem**       | a job is set up, and a plant check of it fails                                                                                |
| **Could have it** | the asset delivers every data point input, but has no job yet                                                                 |
| **Cannot**        | inputs are missing – the cell says which (no profile, another profile, an interface not active, a data point the asset lacks) |
| **Not checked**   | the KPI reads no data points, so Steward cannot tell                                                                          |

The **KPI coverage** in per cent is the jobs set up of all the KPIs the assets could have (has + problem over has + problem + could). Filters: site, area, device profile (and a KPI, from the KPI page) – part of the address. Pointing at a cell explains it; a click opens the asset (its data flow, or its overview where a job is to be added or a check is shown). Phones show a list per asset. One answer holds at most 20,000 cells (at most 2,000 assets); the totals count every asset that matches.

### OT network diagram

![The OT network of Riverside Works: the zone Production cells with its VLANs and the milling centres on them, the conduit to the DMZ and the data paths across it](images/plant/ot-network.png)

_OT network → **Diagram**_ (also from a site's **Structure** and its OT network card), drawn from part 3 ([Part 3: OT network](#part-3-ot-network)):

- **Zones** after IEC 62443-3-2 are areas, with their criticality and SL-T (or _SL-T open_) on the border; the **VLANs** (IEEE 802.1Q) in a zone are areas inside it, with their VID; the **assets** sit on the VLAN of their first device. **Conduits** connect the zones as wide pipes in their direction (both ways: arrows at both ends, nothing moves).
- **Data paths** run from where the data comes from (what the collector pulls from – a device is its asset –, else the asset), over the **collector** and the parties it pushes to, to the **destinations**; the edges carry the protocol, port and push or pull. A **host** (a Steward system named by a data path) is placed on the VLAN whose **network segment** it is a member of – so a way into another zone runs **through the conduit** between the two zones; one without a documented conduit is dashed in orange and says so. Collectors, hosts, datasets and other parties outside every zone stand beside the zones.
- **Devices and VLANs on hover or focus**: the panel beside the picture shows an asset's devices (address, VLAN, state, live status), a VLAN's subnets, segment and who manages it, a zone's VLANs, owner and risk assessment, a conduit's protocols and controls.
- **Live status only from #220's linked checks**: an asset is online, offline or _no data_ from the checks linked to it and its devices (monitors – Gatus, CheckMk, the MQTT silent-device and Kafka checks – and dataset freshness). Its data paths are coloured by it: green and moving when online, red and still when offline. An asset nothing watches is drawn neutral (documentation only), with the direction of its paths only. Hosts, collectors and other parties have no live status here.
- The table lists every zone, VLAN, conduit, asset and party with what it is in, its details and its status in words, and every data path with its way. Assets without devices and data paths are not drawn (the page says how many).

### Site overview tiles

![Two site cards with their assets by status, KPI coverage and open checks](images/plant/site-tiles.png)

_Plant → Sites_: every site's card (and a column of the table) shows its assets by status as a small bar, its **KPI coverage**, its **open checks** and – where assets link to monitors – their states, with links into the structure and the coverage matrix.

The views read their data again every minute (live status may change; the documentation rarely does). Their internal routes are `GET /api/plant/views/overview`, `GET /api/plant/views/coverage?site=&area=&profile=&kpi=`, `GET /api/plant/sites/:siteId/structure`, `GET /api/plant/assets/:assetId/flow`, `GET /api/plant/profiles/:profileId/points/:pointId/lineage` and `GET /api/plant/sites/:siteId/network/placement` (which VLANs the hosts of the site's data paths are in, through the segments they are members of – hidden hosts and segments place nothing; the diagram draws the rest from `GET /api/plant/sites/:siteId/network`) – with the rights of the pages they picture.

## Map

![The map of sites: the list and the map side by side, pins with their state](images/plant/map.png)

Since 0.10.0 (#234, [ADR 0015](adr/0015-map-of-sites.md)) _Plant → Map_ shows the sites the reader may see as a list and on a map side by side; phones start with the list (_Picture_ / _Table_). The search and the state filter apply to both. **The map is off until an administrator turns it on** – until then the page is the list, and nothing is sent to a map provider.

### Turning it on

_Settings → Modules → Map of sites_ (administrators, shown while the plant registry is on). _OpenStreetMap_ is preselected: **Turn on with OpenStreetMap** is one click, with what each choice sends where in front of you. Every choice:

| Tiles from                     | What it is                                                                                                                                                          | What leaves Steward                                                                                                              | Attribution on the map                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| _Off_ (the default)            | the list only                                                                                                                                                       | nothing                                                                                                                          | –                                                           |
| _OpenStreetMap_                | raster tiles of `tile.openstreetmap.org`, zoom 0–19, dimmed (not inverted) in the dark theme                                                                        | Steward's server asks `tile.openstreetmap.org` for the tiles people look at: the provider sees Steward's address, never a user's | © OpenStreetMap contributors (linked to its copyright page) |
| _Light and dark (OpenFreeMap)_ | vector tiles of [OpenFreeMap](https://openfreemap.org) (OpenStreetMap data, OpenMapTiles schema, no key) in Steward's own light and dark style, following the theme | Steward's server asks `tiles.openfreemap.org`; a donation-funded service without a service level – a choice, not the default     | OpenFreeMap © OpenMapTiles · © OpenStreetMap contributors   |
| _Own tile source_              | a raster URL template (`{z}`, `{x}`, `{y}`) or a [MapLibre style](https://maplibre.org/maplibre-style-spec/) URL, optionally with an API key                        | Steward's server asks the origins the template or style names (shown before saving with _Check the style_)                       | the text you enter (required) and the style's own           |
| _Self-hosted file (PMTiles)_   | a [PMTiles](https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md) v3 file in `<data>/maps/`, raster or vector                                             | nothing                                                                                                                          | the file's metadata, or the text you enter                  |

- **Changing where tiles come from** – a new source, URL, API key or file, or _Read the style again_ – asks you to confirm it is you (**step-up**, control point `plant.mapSource` of the [assurance policy](ASSURANCE.md), on by default) and is audited as `plant.map_settings_changed` with the old and the new origins (never the key). Turning the map off and changing only an attribution never ask.
- **Own style URL:** Steward reads the style when it is saved (and on _Read the style again_), keeps its raster and vector sources (a [TileJSON](https://github.com/mapbox/tilejson-spec/tree/master/3.0.0) URL is read to its tile template) and the layers on them, its glyphs and sprite – and drops everything else (GeoJSON sources, metadata). The origins of all of these are the source's origins. Templates with `{s}` sub-domains, `{r}` or `{quadkey}` are refused: name one host.
- **API key:** stored in the vault, added by Steward's server as the query parameter or request header you name, never sent to the browser, never shown again (_Remove the stored key_ clears it). It is re-encrypted with the vault's data key on a key rotation.
- **Vector styles:** Steward's own light and dark styles for the OpenMapTiles schema (OpenFreeMap, many own servers) and – generated with `@protomaps/basemaps` (`npm run map:styles`) – for the Protomaps schema of PMTiles files. They name no glyphs URL and no sprite: MapLibre draws the labels with the browser's own fonts, so a self-hosted file needs nothing else.

### Offline: a self-hosted PMTiles file

For networks without internet access (neither the server nor the browsers), put a PMTiles file into the folder `maps` of Steward's data folder (`SM_DATA_DIR`, the settings card shows the path) and choose it under _Self-hosted file_. Steward lists the `*.pmtiles` files it finds there, with their kind (raster, or vector in the Protomaps or OpenMapTiles schema) and size; a file it cannot draw is listed with the reason. The file is not uploaded through the browser – a regional extract is often hundreds of megabytes – and the browser never downloads it: Steward reads single tiles from it with byte ranges.

A regional extract of a Protomaps planet build (see the Protomaps documentation for where builds are published), with the [pmtiles CLI](https://docs.protomaps.com/pmtiles/cli):

```sh
# the area around your sites (west,south,east,north), up to zoom 15 – from a downloaded build or its URL
pmtiles extract planet.pmtiles plants.pmtiles --bbox=8.9,50.6,12.2,52.6 --maxzoom=15
# on Steward's machine (or volume): the data folder's maps/ folder
cp plants.pmtiles /var/lib/steward/data/maps/
```

Do this on a machine with internet access and copy the file over. Mind the data's licence (OpenStreetMap: ODbL, attribution required) – the attribution from the file's metadata is shown, or the one you enter.

### Privacy and the tile usage policy

- **Tiles come through Steward.** The browser loads the style, the tiles, glyphs and sprites only from Steward (`/api/plant/map/…`); the content security policy does not change and names no map provider. A provider sees Steward's server address and the area tiles were asked for – never a user's address, and never a user's name.
- **OpenStreetMap's [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)** is met: Steward sends its own `User-Agent` (`Steward/<version> (+https://github.com/vxrz/steward)`), caches tiles as their caching headers allow (and asks again with their `ETag`), never prefetches or bulk-downloads (each user may load at most 600 tiles a minute; at most 2 parallel requests to `tile.openstreetmap.org`), and the attribution _© OpenStreetMap contributors_ is always on the map, linked to [the copyright page](https://www.openstreetmap.org/copyright). The tile servers are meant for light use, with no service level: for more than a few people looking at maps, use an own source or a PMTiles file.
- **Exact positions** are visible to whoever sees the site, as on the site page – the map adds no right. A site that must not be located is restricted with its access list; the sites answer is filtered by the site rights, so a hidden site gives no pin, no count in a cluster and no tile request.
- **Cache:** `<data>/cache/map/`, least recently used out, at most `SM_MAP_CACHE_MB` (default 256; `0` keeps nothing on disk). Tiles up to zoom 12 are shared between users; above zoom 12 every user has their own entries, so nobody can time answers to learn where others looked closely. Backups and migration packages leave the cache and the `maps` folder out.

### Pins, clusters and the card

- **Pins** are buttons in list order (Tab moves through them, Enter opens the card) with an icon and an accessible name that says the state (_Riverside Works, RVS, 1 check failing_); never colour alone. A legend under the map names every state.
- **State of a site**: the worst of its assets' linked monitors and its failing plant checks – _Offline_ wins, then _Warning_ (a degraded monitor or a failing check), _Unknown_ (never shown as online), _Online_; a site nothing watches is _Not watched_ (neutral).
- **Clusters** when sites are closer than about 56 px, also buttons (_2 sites, worst: Warning – zoom in_), counting only the sites the reader sees. At most 2,000 positions are drawn; the list names all.
- **The card**: name, code, state, assets by status, KPI coverage, open checks, and links to the site, its structure and its OT network.
- **Show on map** on the site page (and in the list) opens the map at the site with its own zoom. `prefers-reduced-motion` and _Animation off_ turn the fly-to into a jump.
- **Position picker**: in the site form, a click on the map sets latitude and longitude (typing them stays possible, also with the map off).
- **Dashboard widget _Sites map_**: the same map, small, for readers of the plant registry; others read _Not visible_. Status pages never show it.
- **Without WebGL 2** (some virtual desktops) the page shows the list and says why; when the source fails, the list stays with _The map could not be loaded_ and, for administrators, the reason.

### Map API

Internal routes: `GET|PUT /api/settings/plant/map` and `POST /api/settings/plant/map/check` (administrators, browser session), `GET /api/plant/map/sites` (the sites the reader may see, with position, state and counts), `GET /api/plant/map/status`, `GET /api/plant/map/style.json?theme=light|dark&lang=en|de`, `GET /api/plant/map/tiles/:layer/:z/:x/:y`, `…/glyphs/:fontstack/:range`, `…/sprites/:sprite` (signed-in browser sessions only – API tokens are refused; rate-limited per user). While the module is off they answer `404 PLANT_MODULE_OFF`, while the map is off `404 PLANT_MAP_OFF`. In the demo the built-in sources are a made-up tile source of the demo server (`/mock/map/…`) and the maps folder has a small raster file, so nothing real is fetched.

## YAML import and export

The format is YAML (or JSON) in snake_case, **version 1**, described by a JSON Schema 2020-12 document: [`docs/plant/plant-registry-1.schema.json`](plant/plant-registry-1.schema.json) (also `GET /api/plant/schema`). Editors that understand `# yaml-language-server: $schema=…` check a file while it is written; the export writes that line.

A file holds

- a whole tree – `sites:` with every site, its buildings, areas and assets;
- one site – `site:` (a file per site);
- or only assets – `assets:`, each naming its site in `location.site` (a file per asset);
- since 0.8.0 the **OT network** (optional keys): `ot_networks:` or `ot_network:` (the VLANs, zones and conduits of a site, a file per site) and `asset_networks:` or `asset_network:` (the devices, data paths and checks of an asset, a file per asset);
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

### OT network

```yaml
version: 1
ot_network:
  site: riverside
  vlans:
    - id: rvs-vlan-110
      name: Machining cells
      vid: 110 # IEEE 802.1Q
      type: production
      subnets:
        - cidr: 10.20.110.0/24
          gateway: 10.20.110.1
          ranges:
            - { start: 10.20.110.1, end: 10.20.110.9, type: blocked }
            - { start: 10.20.110.10, end: 10.20.110.99, type: static }
      restricted: true
      managed_by: OT network team
      rules_at: Firewall FW-RVS-1, rule set "machining"
      segment: sys_… # optional: the Steward network segment
  zones:
    - {
        id: rvs-zone-cells,
        name: Production cells,
        criticality: high,
        vlans: [rvs-vlan-110],
        sl_t: 2,
        risk_assessment: RA-RVS-2026-01,
        assessed_at: '2026-03-02',
      }
    - { id: rvs-zone-dmz, name: OT DMZ, vlans: [rvs-vlan-900] } # SL-T open
  conduits:
    - {
        id: rvs-cdt-cells-dmz,
        name: Cells to DMZ,
        zones: [rvs-zone-cells, rvs-zone-dmz],
        direction: a_to_b,
        protocols: [opc-ua tcp/4840],
        controls: [firewall FW-RVS-1],
      }
---
version: 1
asset_network:
  asset: rvs-mill-01
  site: riverside # optional, checked
  checks: # the asset's own live-status checks
    - { dataset: iot.last-values, column: asset, value: rvs-mill-01, time_column: ts, max_age_minutes: 15 }
  devices:
    - id: rvs-mill-01-ipc
      hostname: rvs-mill-01-ipc
      domain: ot.example.com
      mac: 00-00-5E-00-53-11
      vlan: rvs-vlan-110
      address_type: static
      address: 10.20.110.21
      switch: rvs-sw-h1-a1
      switch_port: Gi1/0/12
      flags: [port_ordered]
      confidence: high
      checks: [{ monitor: rvs-ot, check: mill-01-ipc }]
  data_paths:
    - id: machine-state
      subject: Machine state and spindle values
      devices: [rvs-mill-01-ipc]
      collector: { kind: job, ref: rvs-edge-collector } # or application, platform, process (Steward ids), with host: <system id>
      transfers:
        - { protocol: opc-ua, mode: pull, peer_kind: device, peer: rvs-mill-01-ipc, port: 4840 }
      destinations:
        - { ref: IoT platform, path: rvs-mill-01/state } # kind: system (a Steward system id), dataset (a key) or other
```

Keys: an OT network has `site`, `vlans`, `zones`, `conduits`; a VLAN `id`, `name`, `vid`, `type`, `owner`, `description`, `subnets` (`cidr`, `gateway`, `description`, `ranges` with `start`, `end`, `type`, `notes`), `restricted`, `managed_by`, `rules_at`, `sites`, `location`, `segment`, `notes`; a zone `id`, `name`, `description`, `criticality`, `vlans`, `owner`, `sl_t`, `risk_assessment`, `assessed_at`, `notes`; a conduit `id`, `name`, `description`, `zones` (two), `direction`, `protocols`, `controls`, `notes`. An asset network has `asset`, `site`, `checks`, `devices`, `data_paths`; a device `id`, `hostname`, `domain`, `purpose`, `mac`, `serial`, `vlan`, `address_type`, `address`, `switch`, `switch_port`, `wall_outlet`, `cmdb_port`, `state`, `flags`, `confidence`, `owner`, `monitoring`, `checks`, `notes`; a data path `id`, `subject`, `description`, `devices`, `collector` (`kind`, `ref`, `host`), `transfers` (`protocol`, `mode`, `peer_kind`, `peer`, `port`, `notes`), `destinations` (`kind`, `ref`, `path`, `notes`), `notes`; a check either `monitor` (with `check`) or `dataset` (with `column`, `value`, `time_column`, `max_age_minutes`), and `note`. A VLAN, zone and conduit are matched by their site and id, a device and data path by their asset and id, the checks by their asset. The same rules as an edit apply; in _replace_ with _remove_, a VLAN, zone or device that goes while a record that stays names it stops the import. `examples/plant/brightwater-ot-network.plant.yaml` is an invented OT network of the example enterprise (import it after `brightwater.plant.yaml`).

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

_Export YAML_ on the site list (every site you may see, with the device profiles, KPI definitions, the assignments of the assets and their OT networks), on a site page and its OT network (that site, as `site:`, with the assignments of its assets, `ot_network:` and `asset_networks:`), on the profile and KPI lists (`?part=catalogue`: the device profiles and KPI definitions) and on a profile or KPI definition page (`?profile=<id>`, `?kpi=<id>`: one record, as `device_profile:` or `kpi_definition:`), or `GET /api/plant/export[?site=<id>|?part=catalogue|?profile=<id>|?kpi=<id>]`. The export is format 1 and imports back unchanged: exporting, importing the file in _replace_ mode and exporting again gives the same file. It is audited (`plant.exported`).

## Permissions

Rights are per site; the hierarchy, buildings and assets of a site follow it ([ADR 0006](adr/0006-owning-teams-policy-module.md)):

- **Without owning teams or access list**: every role that works in Steward (viewer, operator, approver, auditor, designer, administrator) sees the site; designers and administrators manage it (change it, its hierarchy, buildings and assets, import into it). Designers and administrators add sites.
- **Access list** (site page → _Access_, for who manages it; adding an entry asks for a step-up like other grants): only its entries get their rights – _view_ or _manage_ – plus administrators; auditors always see.
- **Owning teams**: as for other resources, members of the owning teams have their instance and team roles on the site.
- **Plant viewer** (`plant`): a new instance role that **sees only the plant registry** (sites that are not restricted) and their own profile. For a user whose only working role it is – no other instance role (a _status_ role adds the status pages) and no role in a team – the server refuses every other route (`403 PLANT_VIEWER_ONLY`), the public API answers only `/api/v1/plant/…` and `/api/v1/me`, the MCP endpoint refuses them, and the web app shows the _Plant_ area and the profile only. Linked systems and applications show by name, without a link; records, services and credentials that link to a site or asset are not listed. With another working role, they keep that role's access.
- **Status viewers** never see the module; nothing of it is shown on status pages.
- The **OT network** (#220) follows its site: who sees the site sees it, who manages the site changes it ([Rights](#rights-1)).
- **Device profiles and KPI definitions** (#219) belong to the installation: everyone who sees the registry sees them, designers and administrators manage them. An asset's **assignment and KPI instances** follow its site ([Rights](#rights)).

A site or asset that you may not see answers `404`, as if it did not exist; a link to it shows as "not visible".

## API

The internal API (the web app) is under `/api/plant/…`: `sites`, `sites/:siteId` with `nodes`, `buildings`, `links` and `access`, `hierarchy`, `assets`, `assets/:assetId` with `image` and `links`, `import/preview`, `import`, `imports`, `export`, `schema`, `config`; since 0.7.0 `assets/:assetId/assignment` (`GET`, `PUT`, `DELETE`), `profiles`, `profiles/:profileId` with `points/:pointId` and `duplicate`, `kpis`, `kpis/:kpiId` with `duplicate`, `explore/points?q=` and `checks`; `assets` also takes `profile` and `dataPoint`; since 0.8.0 the [visualizations](#visualizations) `views/overview`, `views/coverage`, `sites/:siteId/structure`, `assets/:assetId/flow`, `profiles/:profileId/points/:pointId/lineage` and `sites/:siteId/network/placement`, and the OT network `sites/:siteId/network` (the whole OT network of a site with every asset's live status and the systems the data paths name – one answer for a diagram), `sites/:siteId/vlans[/:vlanId[/segment]]`, `sites/:siteId/zones[/:zoneId]`, `sites/:siteId/conduits[/:conduitId]`, `assets/:assetId/network`, `assets/:assetId/devices[/:deviceId]`, `assets/:assetId/paths[/:pathId]` and `assets/:assetId/checks`; the switch and settings are `GET`/`PUT /api/settings/plant`.

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
- `GET /api/v1/plant/sites/{siteId}/network` – the OT network of a site: VLANs (with the linked segment and the hint), zones, conduits (with the records that link to them), the devices and data paths of its assets and every asset's live status (#220);
- `GET /api/v1/plant/assets/{assetId}/network` – an asset's devices, data paths, own checks and live status;
- `GET /api/v1/plant/export?site=|part=catalogue|profile=|kpi=&format=yaml|json` – the registry in the import format (with the OT network).

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
