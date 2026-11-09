# Plant registry (preview)

The plant registry documents the factories of the enterprise an installation serves: its **sites**, how each site is organised (**areas, work centers, work units**), its **buildings**, the **assets** – machines and equipment – in them, **what data each asset's interfaces deliver and which KPIs are computed from it** (device profiles, data points, KPI definitions), and the **OT network** of sites and assets – VLANs, zones and conduits, devices, data paths – with the **live status** of each asset. It is an opt-in module: off by default, and while it is off nothing of it shows and the rest of Steward works as before. The design is recorded in [ADR 0007](adr/0007-plant-registry.md).

> **Preview.** The pages, the API and the import format may still change. Format 1 stays importable; 0.7.0 and 0.8.0 added optional keys to it.

- [Turning it on](#turning-it-on)
- [Concepts and standards](#concepts-and-standards)
- [Sites, hierarchy and buildings](#sites-hierarchy-and-buildings)
- [Assets](#assets)
- [Links to Steward items](#links-to-steward-items)
- [Own fields and display names](#own-fields-and-display-names)
- [Device profiles, data points and KPIs](#device-profiles-data-points-and-kpis)
- [Profile inheritance and asset additions](#profile-inheritance-and-asset-additions)
- [Part 3: OT network](#part-3-ot-network)
- [Security advisories](#security-advisories)
- [Data collections](#data-collections)
- [Visualizations](#visualizations)
- [Map](#map)
- [YAML import and export](#yaml-import-and-export)
- [Changing ids](#changing-ids)
- [Changing many entries at once](#changing-many-entries-at-once)
- [Permissions](#permissions)
- [API](#api)

## Turning it on

_Settings → Modules → Plant registry_ (administrators): **Turn on the plant registry**, give the enterprise's name and save. The sidebar gets the area **Plant** with _Sites_, _Assets_, _Map_, _Device profiles_, _KPI definitions_, _Explore data_, _Checks_ and – for whoever may manage a site – _Import_; documents, tickets, services and applications can link to sites and assets. Each site page leads to its **OT network**.

Turning it off hides the area, the pages and the link kinds again; every route of the module answers `404` with the code `PLANT_MODULE_OFF` (also `/api/v1/plant/…`). The data stays and is back when the module is turned on again. Turning it on or off is audited (`plant.module_enabled`, `plant.module_disabled`) and, since 0.11.0, asks for a fresh confirmation (step-up, control point `modules.switch`), like every module switch ([MODULES.md](MODULES.md)). While it is off, its pages say _This area is switched off_ instead of _Page not found_.

In the demo (`npm run demo`) turning the module on loads an invented enterprise with two sites (`examples/plant/brightwater.plant.yaml`) and invented device profiles, KPI definitions and assignments of some assets (`examples/plant/brightwater-data-points.plant.yaml`) – milling centre 2 has a KPI instance whose OPC UA interface is not set up yet, so _Checks_ has something to show.

## Concepts and standards

The model follows two standards, so that a plant engineer finds the words they know and the data maps to other tools:

- **ISA-95 / IEC 62264-1** (enterprise-control system integration), the role-based equipment hierarchy: _enterprise → site → area → work center → work unit_. Work centers are production lines, production units, process cells or storage zones; work units are units, work cells or storage units. Steward records the kind as an optional **ISA-95 type**.
- **IEC 81346-1** (structuring principles), the separation of **function** and **location**: an area, work center or work unit says _what happens_; a building says _where_. Never fold a hall number into a functional id or name – an area may span several halls, and a hall may hold several areas. The two axes meet through references: a node _names_ its building.

**The innermost building wins.** The building that applies to a node is its own, else its work center's, else its area's. An asset may override it with its own building. The site page shows each node's building (inherited ones in italics), the asset page where its building comes from.

**Stable ids.** Every record has an id of lower-case letters, digits, `.`, `_` and `-` (at most 80) – links, imports and other tools rely on it. It changes only when someone changes it on purpose, and then the old id keeps leading to the record ([Changing ids](#changing-ids)). Site and asset ids are unique in the installation; node and building ids are unique within their site.

**Generic words, the installation's names.** The module's words are generic (_site, area, work center, work unit, building, asset_). An installation gives its own names per language under _Display names_ (for example _Machine_ instead of _Asset_) without changing the model; other tools' ids go into **external references** (system, id, link), site-specific attributes into **own fields**.

## Sites, hierarchy and buildings

A **site** has a code (short, unique, e.g. `RVS`), a name with translations, a description, a position (latitude, longitude, map zoom – shown as a link to OpenStreetMap), contacts, external references and own fields.

On the site page:

- **Hierarchy**: areas (with an optional manufacturing domain), their work centers and work units; add, edit, [move](#move-to) (a work center to another area, a work unit to another work center – its assets follow) and remove (only empty nodes). Each node names its building or inherits it. The areas start open and the work centers folded; the arrow beside a node folds it, _Expand all_ and _Collapse all_ do it for the whole tree. A link to `#node-<id>` opens the path to that node.
- **Buildings**: buildings, halls, floors, rooms and outdoor areas; a floor or room names the building it is in (no cycles). A building that something names cannot be removed.
- The site's assets by status, its links, its access list and owning teams.

### Move to

Since 0.12. **Move to…** in the menu of a work center or work unit in the site's hierarchy, and in the menu of an asset's page, opens a dialog with one searchable choice (keyboard only works too; there is no drag and drop):

- a **work center** moves to another area, a **work unit** to another work center of the same site – with everything below it; it is placed last below its new parent, and the assets in it follow (their area and work center change with it). Areas sit directly below their site and do not move. The server checks the levels, so a node never moves below itself or what is below it (`PLANT_NODE_PARENT`);
- an **asset** moves to any area, work center or work unit of its site, or to the site itself; everything else about it stays.

A move is an ordinary change of the node (`site.node_changed` with `parentId`) or the asset (`asset.updated`), through `PUT /api/plant/sites/:siteId/nodes/:nodeId` and `PUT /api/plant/assets/:assetId`. Many assets move at once with _Edit selected_ → _Place_ in the asset list ([Changing many entries at once](#changing-many-entries-at-once)).

## Assets

An asset has a stable id, name, manufacturer, model and **status** (_planned, commissioning, operational, maintenance, out of service, decommissioned_) and:

- **location**: its site and the innermost place – an area, work center or work unit; the levels above follow from it. A place of another site, or levels that do not belong together, are refused. Optionally its own building;
- **equipment**: the asset it is part of (same site; the equipment hierarchy has no cycles) and the assets that are part of it. Deleting an asset keeps its parts, without a parent;
- **taxonomy**: domain, process area, role; **tags**; **lifecycle**: commissioned, end of support (a badge shows when it has passed);
- description, capabilities, an **image** (PNG, JPEG or WebP, at most 512 KB, never SVG; served with `Content-Security-Policy: sandbox`), external references, own fields, links.

The asset list filters by site, place, domain (the asset's or its area's), status and tag; the filters are part of the address, so links from a site's tree lead to its assets. _Duplicate_ copies an asset's attributes and location – not its external references (their ids belong to the original), its image, links or parts.

## Links to Steward items

`site` and `asset` are link kinds like systems or services – and since 0.12 `device-profile`, `data-collection` (written `<asset>/<collection>`) and `data-sink` (`<asset>/<collection>/<sink>`):

- documents, records, firewall changes, ticket references (as affected items), services and applications link to them;
- an asset links to the **systems** (a PLC gateway server, a network segment), **applications** (a connectivity gateway) and **platforms** it uses; the system page lists the assets under _Linked from_.

The module references Steward items instead of copying them: a gateway stays a Steward application or platform, a network segment stays a system. A reader sees a link's target only when they may see its site – otherwise "not visible", as for every link kind; a device profile, which belongs to no site, everyone who sees the registry. While the module is off, links to plant entries stay but resolve to "not visible".

A changed id ([Changing ids](#changing-ids)) reaches the links: of a profile, and of an asset's collections and sinks (the asset part of `<asset>/<collection>`). Links to a removed entry go with it only with _Also remove what belongs to it_; without it, records that link to a profile or a collection refuse its removal (`PLANT_REMOVE_HAS_ENTRIES` in _Remove selected_ and the import, `PLANT_PROFILE_LINKED` and `PLANT_COLLECTION_LINKED` for a single delete – the collection's dialog asks again and then takes the links along). A sink removed by editing its collection takes the links to it along (the audit entry counts them); a sink an import no longer names keeps them, so a later import that names it again finds them.

## Documents

Since 0.12 sites, assets, device profiles and data collections have a **Documents** panel: the records linked to the entry – living documents with their edition, and other records – with its type, status and number of files. Who may create records has three buttons:

- **New document**: a living document (DOC unless you choose another type) that starts with the link to the entry; its editor opens next;
- **Link existing**: a record you may change gets a link to the entry (the link is the record's: its editors remove it there);
- **Upload file**: a new living document named after the file, linked to the entry, with the file attached through the usual attachment checks ([RECORDS.md](RECORDS.md#attachments)).

Below them, read-only and marked _Inherited_, the panel lists what the entry inherits:

| Page                     | Inherited documents                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| A derived device profile | those of its base profiles, nearest first (_From base profile …_)                                        |
| An asset                 | those of its profile and the profile's bases (_From profile …_), of its data collections and their sinks |
| A data collection        | those of its sinks                                                                                       |

A record is listed once: where the entry has it itself, else under the first entry it comes from. A record the reader may not read is counted (_1 more document you may not read_), not named; a plant viewer reads no records and sees only the counts. `GET /api/plant/documents?kind=site|asset|device-profile|data-collection|data-sink&id=…` answers the panel, with the rights of the page it belongs to.

## Own fields and display names

_Settings → Modules → Plant registry_:

- **Display names**: per record type and language, the word for one and for several.
- **Own fields**: per record type (site, area, work center, work unit, building, asset) a list of fields with a snake_case key, label, kind (_text, number, date, yes/no, choice, link_), options of a choice, and whether it is required. Values are checked on every save and import: unknown keys, wrong kinds and missing required fields are refused with the field's name. Removing a field from the schema keeps stored values (shown by their key).

## Device profiles, data points and KPIs

Part 2 of the registry ([ADR 0007 – Part 2](adr/0007-plant-registry.md#part-2-data-points-and-kpis-070)) records what data an asset's interfaces deliver and which KPIs are computed from it. Two **catalogues** belong to the installation, not to a site; the **assignment** belongs to its asset.

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

On the profile page each interface folds; its header keeps the protocol and the number of data points and groups. A profile with up to three interfaces shows them open, a longer one folded (with _Expand all_ and _Collapse all_). A link to `#iface-<id>` opens that interface.

A data point has its own page: what it is (a Modbus address also says what it reads: “Input registers 13–14 (2) · function code 04”), **which assets deliver it** (the first 20, then _Show all_) and the KPI definitions that read it. _Duplicate_ copies a profile with its interfaces and data points (for the next firmware generation). A profile that an asset has cannot be deleted.

### Assignment of an asset

The asset page has the section **Data and KPIs**:

- its **device profile** and **controller firmware**;
- per interface of the profile whether it is **set up and active** on this asset, its **endpoint** (`opc.tcp://…`, a host and port, a broker, a share) and notes;
- **differences**: data points that differ here (address, unit, data type, update rate) or that this asset does not deliver;
- **publications**: which data point is published where – target system (an IoT platform, a historian), path (an aspect, a topic) and name (a variable), who publishes it;
- its **KPI instances**: the KPI definition, the **job** name (unique per asset), active, the **parameters** and where the result is shown – a Steward **dashboard** (id) and/or **dataset** (key), linked for readers who may see them;
- the **checks** of the asset and the **KPIs it can have**.

Each part folds and shows its count in the header – the interfaces also how many are active and not set up, the differences how many data points are not delivered. A part with entries starts open, an empty one folded; KPI instances with a problem always open.

A data point counts as **delivered** when the profile has it, its interface is listed and active in the assignment, and no difference says the asset lacks it. _Duplicate_ of an asset copies its profile, firmware, interfaces and differences – not the endpoints, publications or KPI instances (they belong to the original).

### KPI definitions

_Plant → KPI definitions_: id, name (with translations), **category** (availability, performance, quality, energy …), type, description and the ISO 22400-2 attributes (formula, unit, range, trend, timing, audience, production methodology); the computing system's **method** and **where its code lives**, and whether its columns vary from run to run.

- **Inputs**: a profile and the data points of it the computation reads (empty profile: whatever profile the asset has), or an _other_ input that is not checked. Since 0.12.0 an input may state the **unit it expects** per data point (UCUM; `kWh` is read as `kW.h`); a data point without one expects the unit it has in the input's profile – for an input that names a base, the base's. See [Units of KPI inputs](#units-of-kpi-inputs). Since 0.13 an input may name **any of several profiles** with a **data point mapping** – see [Any of these profiles](#any-of-these-profiles).
- **Parameters**: name, **aliases** (other spellings a job may use), type (number, whole number, text, yes/no), default, required, lowest and highest value, unit, description.
- **Result columns**: name, **kind** – _sum_ (summed over a longer period), _ratio_ (numerator / denominator × scale, both summed first: the only correct way to combine percentages over a period) or _ignore_ (descriptive) –, scope (which windows it is written for), unit, description.
- **Computation**: a summary, steps (what, why), identities (what always holds between the columns), **limits** (what the computation cannot tell) and a diagram as text.
- **Roll up from parts** (0.13, `rollUp: parts`, off by default): an asset counts as able to have the KPI when one of its parts delivers the inputs – see [KPI coverage](#kpi-coverage).

The page lists the assets with an instance and **the assets that could have it** (they deliver every input but have no instance) – since 0.12.0 each marked _Collected – ready_ or _Not collected_ ([KPI potential](#kpi-coverage)) and, where an input arrives in another unit, _1 unit differs_ (the list on hover); for a KPI that rolls up from parts also the machines whose part could have it, marked _via part …_. _Duplicate_ makes the next version.

#### Any of these profiles

Power meters of different models – say _Meter A100_ (Modbus/TCP) and _Meter B700_ (OPC UA) of two vendors – deliver the same quantities under other ids, and should feed one KPI. Where the models share a base profile ([Extracting a base profile](#extracting-a-base-profile), also across protocols since 0.13), the input names the base. Where they cannot share one, an input names **several profiles** (0.13, _Edit input → Device profiles_, `profiles` in the API and the file format): an asset delivers the input when its profile is, or extends, **one of them** – the first that matches counts. The data points are the **first** profile's; for every other profile a **mapping** says which of its data points stands for each input (`mapping: { meter-b700: { energy_total: ActiveEnergy } }`) – a data point left out has the same id there. The editor suggests the mapping by the matching of _Extract base profile_ (the same id, a known-as name, the name, the unit) and shows why; change a suggestion where it is wrong.

- `profile` stays for one profile: with `profiles` it is the first of them, and a file or API client that writes only `profile` works as before. The export writes `profile` for one profile and `profiles` for several.
- A mapping to a data point the profile lacks is refused (`PLANT_KPI_INVALID`, and a problem in an import's preview), as is a mapping for a profile the input does not name, of a data point the input does not read, or two input data points read from one; the message names the profile. A data point removed from a profile later is a check of the KPI definition, per profile.
- Everything that reads inputs follows the asset's matching profile and the mapping: the checks of a KPI job, _Could have it_, the units, whether the data is collected, the data flow and lineage, the data point pages and "KPIs it can have". Id changes follow too: a renamed profile in `profiles` and the mapping; a data point renamed in one profile updates the mapping to it, and where the input reads it unmapped while other profiles keep the old id, that profile gets a mapping (the input keeps its id).

#### Units of KPI inputs

Since 0.12.0 Steward compares the unit a KPI expects with the unit each asset delivers: the input's unit for the data point, else the data point's unit in the input's profile (0.13: of several profiles the **first** – the computation reads one unit, so a model that delivers Wh where the first delivers kWh is flagged); on the asset, an override's unit, else its model's – of the data point the mapping names for the asset's profile (the message names that data point). Units are compared as UCUM codes (`kWh` = `kW.h`). A difference is the check **`kpi_unit_mismatch`**, which says whether the two units convert by a **pure factor** (W.h and kW.h, J and kW.h, bar and kPa, % and 1, mm/s and m/min – _convertible, differs_: the job has to convert) or **not** (kW and kW.h; °C, K and °F differ by an offset and count as not convertible). Nothing is compared where either unit is empty, or for a data point the asset lacks (that is a missing input).

- On a **KPI job** of an asset the difference is a check of the job: the asset's checks, _Plant → Checks_, and the coverage cell turns _Problem_.
- An asset **without a job** still could have the KPI – the device delivers the data, in another unit: the coverage cell stays _Could have it_ (collected or not) and names the difference, the KPI page and the asset's _KPIs it can have_ mark it. Fix the input's unit, give the asset a difference (`overrides[].unit`) where it really delivers another unit, or let the job convert.

### Checks

Steward checks the data; a problem never stops a save, it is shown on the asset, on the KPI definition, on _Plant → Checks_ and in an import's preview, as a plain sentence:

| On               | Check                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a KPI instance   | the definition exists; **every data point input is delivered** (the asset has a profile, the profile the input names, the data point, its interface is active, no difference says it lacks it)         |
| a KPI instance   | **the parameters are the definition's**: known names or aliases, each once, of their type, within their range; required ones without a default are given                                               |
| a KPI instance   | 0.12.0: **the units are the expected ones** (`kpi_unit_mismatch`: convertible by a factor, or not – [Units of KPI inputs](#units-of-kpi-inputs))                                                       |
| a KPI definition | **a ratio has its numerator and denominator** and they are columns of the definition (unless its columns vary); its inputs name profiles and data points that exist (0.13: in each profile, as mapped) |
| an assignment    | the profile, interfaces and data points it names exist (they are checked on save, too; a data point removed from its profile later shows here)                                                         |

### Search

_Plant → Explore data_: **who delivers a data point** – a text across every profile's data points (id, name, address, description; a plain match, no pattern) with the number of assets that deliver each – and **which KPIs an asset can have**. The asset list filters by device profile and, from a data point, by the data point (`/plant/assets?profile=…&dataPoint=…`).

### Rights

Everyone who sees the plant registry sees the catalogues (the role _Plant viewer_ included); **designers and administrators** manage them (whoever may add sites). An assignment and its KPI instances follow the asset's site: who sees the site sees them, who manages it changes them. Lists, counts, the search, the checks and the data point and KPI pages count and name only assets of sites the reader may see; a profile that only a hidden asset has is “still in use” without a count. Every change is audited (`device_profile.created|updated|deleted`, `kpi_definition.created|updated|deleted`, `asset.assignment_set|assignment_removed`, `*.duplicated`).

## Profile inheritance and asset additions

Since 0.11.0 ([ADR 0007 – Update 0.11](adr/0007-plant-registry.md#update-011-profile-inheritance-and-asset-additions)) a device profile can build on another one, and an asset can have more than its profile.

### Profile inheritance

A device profile may **extend** one base profile (_Edit → Extends_). The base may extend another one, up to 8 profiles in a chain; a profile cannot extend itself or one that extends it (no cycles). The derived profile **inherits** the base's interfaces, data point groups, data points and files, and:

- **adds** its own interfaces, and data points or groups to an inherited interface;
- **changes** fields of an inherited interface (name, direction, port, sign-in, client, version, description, notes – not its protocol, unless the base leaves it open: [Bases across protocols](#bases-across-protocols)) or data point (name, data type, unit, address, access, update rate, values, known-as names, description, notes, usual publications – not its id or group). A field it does not change stays the base's;
- marks an inherited interface or data point as **not present** (the device does not have it). An interface that is not present takes its data points with it.

Manufacturer, model and category that the derived profile leaves empty are the base's. **Changes to a base flow down**: a data point added to the base appears in every profile that extends it. A save of a base is refused when a profile that extends it would then have an id twice; a base that another profile extends **cannot be deleted** (`PLANT_PROFILE_EXTENDED`), like a profile in use. A changed id of a base, or of one of its interfaces or data points, reaches the profiles that extend it and their assets; a new id that the base, a derived profile or a base of it uses already is refused.

The **resolved profile** – the effective model – is computed in one place on the server and used everywhere: the profile page, the data point pages and "which assets deliver it", the assignment and its checks, KPI inputs, coverage, data flow and lineage, and the API. A **KPI input that names a base** reads every profile that extends it, and the data point page of a base lists the assets of the derived profiles that keep the data point. The profile page shows the chain of bases, where each interface and data point comes from (_Inherited from …_, _Changed here (fields)_, _Added here_), the inherited items marked not present (with _Restore_) and the profiles that extend it. On an inherited item the menu offers _Edit_ (an override), _Back to the base's values_ and _Not present on this device_. Changes to items the base no longer has are ignored and named on the page. _Duplicate_ keeps `extends`.

Every data point may also have **known-as names** (`aliases`): names tools commonly use for it, such as a gateway's variable names. The import of data collections matches them ([Data collections](#data-collections)).

#### Bases across protocols

Since 0.13 a base profile may hold an interface of protocol **other** (unspecified) whose data points have **no address** – what devices of several protocols share (the quantities of power meters, say). A profile that extends it **sets the interface's protocol** (_Edit_ on the inherited interface: the protocol is choosable only there; `interfaces[].protocol` of an inherited interface in the file format; `protocol` of an interface override in the API) and gives the data points their addresses as overrides – checked against the protocol it sets, as are data points it adds to the interface. Only an inherited interface whose protocol is _other_ gets one: on any other the protocol stays (refused). A base that later gives such an interface a protocol is refused while a profile that extends it sets another one. Everything that reads profiles reads the resolved one, so an asset sees its device's protocol; a KPI input naming the base reads every profile, whatever its protocol.

**Template profiles** (0.12.0): a profile can be marked _Template – only for other profiles to extend_ (_Edit_, `template: true` in the file format). No asset can have a template: an assignment naming it is refused (`PLANT_PROFILE_TEMPLATE`), as is _Edit selected → Device profile_, an import or a proposal that gives it to an asset. A profile that assets have cannot become a template (`PLANT_PROFILE_TEMPLATE_IN_USE`, with the count when you see every one of them) – give them a profile that extends it first. The flag is not inherited: a profile that extends a template is a device profile. The list shows a _Template_ badge and filters by _Kind_ (templates or device profiles).

#### Extracting a base profile

Two power meters of one vendor – say _Meter A100_ and _Meter A300_ – deliver largely the same quantities, and both profiles were written first (by hand or from proposals). **Extract base profile** (_Plant → Device profiles_, or the menu of a profile without a base) turns what they share into a base profile that each of them extends, so a KPI input can name the base and read both:

1. Choose **two or more profiles** and the **leading** one. The leading profile's data points are listed with their **match** in each other profile: the same id, else a known-as name, else the name (the same unit preferred). Change a match by hand, leave a data point out, or give it another id in the base.
2. Name the base (id, name, description); it is a **template** unless you turn that off.
3. **Interfaces of the base** (0.13): each interface of the leading profile that holds shared data points gets an id in the base (the leading profile's interface id unless you give another – useful when the profiles' interfaces have different protocols: a neutral `meter` instead of `modbus`); each profile's interface that holds them is renamed to it. Where their protocols differ, the dialog says so: the base's interface gets the protocol **other**.
4. **Preview**: the base's interfaces and data points, per profile the ids renamed (with the references that follow), the data points whose fields differ from the base (they stay as the profile's overrides), what stays its own, and its assets (unchanged). Data points that cannot go into the base are refused with the reason.
5. **Extract base profile**: one transaction, audited as `device_profile.base_extracted`.

What it does: a data point whose id differs from the base's is **renamed** in its profile with the [id rename](#changing-ids) (the old id stays an alias; assignments, KPI definitions, data collections and the profiles that extend it follow); an interface holding shared data points gets the leading profile's interface id the same way. The base takes **name, description, data type, unit, access and values** of each data point from the leading profile, and **address, update rate, known-as names, notes and publications** only where every profile agrees (else they are empty in the base); the base's interfaces take the leading profile's fields, a group's description where every profile agrees. **Across protocols** (0.13): where the profiles' interfaces have different protocols, the base's interface has the protocol _other_, its data points no address, and port, version and client only where every profile agrees; each profile then sets its protocol and keeps its addresses as overrides ([Bases across protocols](#bases-across-protocols)). Each profile then **extends the base** and keeps, as overrides, only the fields that differ (an address, a unit, an interface's name); its other interfaces and data points stay its own. **No asset changes**: Steward compares the model of every asset of the profiles (and of every profile that extends one of them) before and after – the same interfaces, groups and data points with the same fields, ids renamed as mapped – and stops when one would differ. Only the order may change (inherited items come first).

Limits: a profile that **extends another already** cannot be included (extract from profiles without a base); a profile that extends one of them must stay within 8 profiles in a chain; a data point is refused when it is in **another group** (an override cannot move a data point – rename the group first), when its interface is split differently between the profiles (or two leading interfaces would get the same id in the base), or when its new id is taken. Since 0.13 an **interface of another protocol** is no longer refused (0.12.0 refused it): the base gets an interface of protocol _other_, and the models of all assets stay the same – the comparison before and after still runs. Needs the right to manage device profiles (designers, administrators). Internal routes: `POST /api/plant/profiles/extract-base/candidates`, `…/extract-base/preview`, `POST /api/plant/profiles/extract-base` (0.13: `interfaces`, the base's interface ids by the leading profile's). The MCP tools read the result like any profile.

**Descriptions** (0.12.0) are optional plain text on a profile, an interface, a data point group, a data point and a file set. A derived profile **inherits** each of them: the profile page shows an inherited description with _Inherited from …_. An editor writes it anew for this profile (_Describe it here_) – stored in the profile's own part like other changed fields – and goes back with _Back to the inherited description_; the next profile in the chain inherits the new text. The profile's own description, a group's and a file set's are inherited while they are empty; an interface's and a data point's are changed fields of their override (so they can also be made empty). The data point page says where its description comes from. Profiles and their items keep their length limit of 8000 characters.

### Asset additions

Next to the **differences** of an assignment, an asset may **add** data points to an interface of its profile and whole **interfaces** of its own (_Data and KPIs → Interfaces_, the menu of an interface: _Add data point_; _Add interface_). They count as **delivered** like the profile's data points – when their interface is listed and active in the assignment (a new interface is added as active) – and appear in the checks, KPI inputs, coverage, data flow and lineage. An added data point needs an id the profile does not have; when the profile gets the same id later, the profile's counts and the asset shows the check _Data point … is added on this asset, but its device profile has it now, too_. _Duplicate_ of an asset copies its additions.

Added data points and interfaces have their own **description**. A note about an inherited data point **on this asset only** ("on this mill: the main spindle") is the _notes_ of its difference (`overrides[].notes` in the file format).

### In the file format

A derived profile names its base with `extends:` and uses **the same keys** as any profile, written with only its own part: an `interfaces` entry whose id is inherited changes that interface – the keys it gives, `present: false`, and in its `groups` (or `data_points`) entries for inherited data points (the keys they give, or `present: false`) and new data points; an entry with a new id is an own interface and needs its `protocol`. The export writes the same, so a file imports back unchanged.

An inherited group's entry with a `description` describes that group anew (it may list no data points); the profile's own `description` is left out of the export while it inherits its base's.

```yaml
version: 1
device_profile:
  id: example-controls-c80-v4
  name: Example Controls C80, firmware 4
  extends: example-controls-c80
  interfaces:
    - id: opc-ua # inherited: only what changes
      default_port: 4841
      groups:
        - name: Machine state
          data_points:
            - { id: prog_name, address: 'ns=3;s=/Channel/ProgramPointer/progName[u1,1]', aliases: [NCProgram] }
            - { id: legacy_alarm, present: false }
            - { id: spindle_load, name: Spindle load, unit: '%', address: 'ns=3;s=/DriveHsa/State/load[u10]' } # new
    - { id: web-ui, present: false }
    - id: mqtt # new
      protocol: mqtt
      data_points:
        - { id: part_count, name: Part count, address: cnc/parts }
---
version: 1
assignment:
  asset: rvs-mill-01
  profile: example-controls-c80-v4
  interfaces:
    - { interface: opc-ua, endpoint: 'opc.tcp://rvs-mill-01.ot.example.com:4841' }
    - { interface: clamp-io, endpoint: '10.20.110.31:502' }
  additions:
    interfaces:
      - id: clamp-io
        protocol: modbus_tcp
        data_points: [{ id: clamp_state, name: Clamp state, address: 'coil:4' }]
    data_points:
      - { interface: opc-ua, group: Pneumatics, id: air_pressure, name: Air pressure, unit: bar, address: 'ns=2;s=/Plc/Air' }
```

## Part 3: OT network

Part 3 of the registry ([ADR 0007 – Part 3](adr/0007-plant-registry.md#part-3-ot-network-080)) documents how the plant's operational-technology network looks and whether an asset is online. It is documentation, **not a CMDB, not an IP address management tool**: Steward checks formats (VLAN IDs, CIDR subnets, addresses, MAC addresses), not overlaps, and reads nothing from switches or firewalls. A **site** holds its VLANs, zones and conduits; an **asset** its devices, data paths and the checks that tell its live status.

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

- a **zone** has a description, a **criticality** (low, medium, high, critical), its **level** in the Purdue model (optional, see below), the **VLANs** of the site in it, an owner, the **SL-T** – with the **risk assessment** that set it (required with SL-T: a document number or link) and its date – and notes. Without SL-T the zone shows _SL-T open_;
- a **conduit** connects **two different zones** of the site, with a **direction** (from the first to the second, the other way, both), its **protocols** (`opc-ua tcp/4840`, `https tcp/443`), its **controls** (firewall, data diode, jump host) and notes.

The **level** says where a zone sits, bottom to top: _Level 0 – field devices_ (`field`), _Level 1 – basic control, cells_ (`control`), _Level 2 – supervisory_ (`supervisory`, SCADA, HMI), _Level 3 – site operations_ (`operations`, MES, historian), _Level 3.5 – industrial DMZ_ (`dmz`), _Level 4–5 – enterprise network_ (`enterprise`) and _External_ (`external`, cloud, vendors) – the levels of the Purdue reference model as ISA-95 and IEC 62443 use them. The [diagram](#ot-network-diagram) draws the zones in this order. A zone without a level gets one derived for the diagram only (nothing is stored).

**Firewall changes link to a conduit**: `conduit` is a link kind (id `<site>/<conduit>`, shown under _Links → Conduit_ while the module is on), so a firewall change (`FWC`) names the conduit it changes besides the affected segments and systems. The conduit lists the records that link to it. A zone that a conduit connects cannot be removed (`PLANT_ZONE_IN_USE`).

### Devices of an asset

On the asset page, section **OT network → Devices** – the network identity of the asset, often a small box next to the machine: **host name and domain**, purpose, **MAC** (EUI-48), serial number; **VLAN** (of the asset's site), **address type** (dynamic, reserved, static) and **address**; **switch, switch port, wall outlet, CMDB port name**; **state** (planned, active, inactive, retired), **flags** (snake_case: `device_ordered`, `port_ordered`, `address_ordered` …) and a **confidence** (high, medium, low: how sure the documentation is); **owner**, the **monitoring** that watches it (text) and its **linked checks**. A device shows a hint when its VLAN does not exist (any more), its address is outside the VLAN's subnets or in a blocked range. _OT network → Devices_ lists the devices of every asset of the site – see [Editing in place](#editing-in-place).

### Data paths of an asset

**OT network → Data paths**: what data leaves the asset – a **subject** (machine state, NC programs), the **devices** it covers, the **collector** (a Steward **application**, **platform** or **process**, or a **job** elsewhere by name, optionally with the Steward **system** it runs on), its **transfers** (protocol, **push or pull**, port, the **peer**: a device of the asset, a Steward system or text) and its **destinations** (a Steward system with a path, a Steward dataset, or text).

**Hosts are Steward systems**, so chains of services – _pull job → file share → archive job_ – can be followed link by link: a data path **continues in** every data path that reads (as a transfer peer or the collector's host) from a system it writes to, and **comes from** those that write to a system it reads from, across assets and sites the reader may see – at most 50 each, with the number of the others ("and 120 more"; `nextMore` and `previousMore` in the API). A device that a data path names cannot be removed (`PLANT_DEVICE_IN_USE`).

### Editing in place

Since 0.12 the site's **Devices** and **Data paths** tabs are where the OT network is kept by hand – Steward is the place where this documentation is maintained, and an import loads or syncs it. Who manages the site:

- **adds** a device or data path with _Add device_ / _Add data path_ (choosing the asset it belongs to when the site has more than one), and **edits** or **removes** one from its row's menu – with the same forms, rules and audit as on the asset's page;
- selects devices and uses **Edit selected** or **Remove selected** ([Changing many entries at once](#changing-many-entries-at-once): state, confidence, owner, flags). Data paths have no bulk change; they are changed one at a time.

Both lists sort by every column, filter (devices by VLAN – or _No VLAN_ –, state and asset, data paths by asset, both with a search) and say how many entries they show. Inactive and retired devices are shown quieter. Identifiers – host names, addresses, MAC addresses, VLANs, switches and ports – never break inside; a wide table scrolls sideways. A device without an address shows its address type alone (_Dynamic (DHCP)_). On a phone the rows are cards.

### Data quality hints

Above the devices, **Data quality (N)** lists what looks wrong in the documentation of the site's devices, open when there is something and folded when all is well (the overview tab shows the count):

- an **IP address**, a **MAC address** or a **host name** (with its domain, without letter case) that two or more devices share;
- a device **without a VLAN**, and a device that names a **VLAN the site does not have**;
- **switch names that differ only by letter case** (`SW-Hall1-01` and `sw-hall1-01`) – most likely one switch written two ways; the hint names the devices not written in the most used spelling.

Retired devices are left out. Each hint names its devices; a device leads to its row (all filters off) and to its asset. Steward computes the hints when the network is read (`dataQuality` in `GET /api/plant/sites/:siteId/network` and `/api/v1`); whoever sees the site sees them, as they see its devices. They are hints: nothing is refused or changed because of them.

### Live status

An asset or device is **online**, **offline** or **unknown** – **only from its linked checks**:

- a **monitor** (by key or id) or **one of its checks** (by check id or key): Gatus endpoints, CheckMk services, the MQTT silent-device check, Kafka and every other check type ([MONITORS.md](MONITORS.md)). _Up_ and _degraded_ are online (degraded with its reason), _down_ is offline; no result yet, blocked, maintenance or a monitor or check that is turned off is unknown;
- the **freshness of a dataset** (the last value of an aspect on an IoT platform, published by a process): optionally only the rows whose **column** has a **value** (the row of this asset or device), the **time column** of the last value and a **maximum age** in minutes (empty: the dataset's own freshness, [DASHBOARDS.md](DASHBOARDS.md)). Newer is online, older offline; no data under the key, no row or no readable time is unknown.

A device is offline when any of its checks says offline, online only when **every** check says online, unknown otherwise. **Nothing linked** is shown as **Not watched** (quiet, no alarm colour; `watched: false` in the API, where `state` stays `unknown`) – _Unknown_ means a linked check has no result. When nothing on a site is watched, its overview and device lists leave out the _Live_ column and say where checks are linked. An asset combines its own checks with those of its devices that have checks (a device without checks says nothing): offline wins, unknown is never shown as online. The status is shown on the asset page, on the **site page** (a card with the counts) and on the site's **overview dashboard** _OT network → Status_ (online, offline, unknown and not watched assets, each with its devices and data paths). It is read when the page is read; Steward stores no status history of its own (the monitors and datasets have theirs).

**An asset's status reveals the state of its linked checks to everyone who sees the asset** – that is why a Plant viewer, who may see no monitor at all, sees the real status. What a reader learns of a check depends on whether they may see what it checks:

- a monitor or dataset **they may see** is named, with its check, the reason and the time; it is linked unless they are a Plant viewer (names only). A dataset is read **as the reader**: only the partitions they may read count (a row on a platform they may not use is "no row" for them);
- one **they may not see** – or that no longer exists, the two read the same – **still counts towards the status**, but shows only as **"a check you may not see"** with _online_, _offline_ or _unknown_: no name, key, id, check, reason, time, value or filter. The [visualizations](#visualizations) follow the same rule, so the two pages tell nothing more together than each alone. When an asset has only that one check, its status is that check's state.

Linking a monitor or a dataset needs the right to see it – in the editor, the API and the YAML import, with the same answer for one that does not exist ("There is no dataset …"). Another check of a linked monitor, or another column, value, time column or maximum age of a linked dataset, is a new link and needs that right too; the columns must be columns of the dataset. A manager who may not see a linked check keeps it as it is (the editor shows it as "a check you may not see") or removes it; the export leaves it out and an import keeps it. A time column is read as a time only between the year 2000 and a year from now (epoch seconds, milliseconds or an ISO 8601 date); anything else is "no readable time".

### Rights

The OT network follows its site ([Permissions](#permissions)): who **sees the site** sees its VLANs, zones, conduits and the devices, data paths and live status of its assets – the role _Plant viewer_ included; who **manages the site** changes them. Status viewers never reach it, and nothing of it is shown on status pages. A site or asset someone may not see answers `404`, in the import too ("There is no site …", "You may not add or change asset …"); a VLAN's other sites (`sites` and `otherSites`, in the internal API, `/api/v1` and the export) and the conduit link targets leave out sites they may not see – a save or an import keeps those, as they cannot name or remove them. Linking a monitor or a dataset as a check, a segment, a collector or a host needs to see it (an item that was linked before may stay); a dataset as a data path's destination is documentation and may be one that is published later. Every change is audited on its site or asset: `site.vlan_added|vlan_changed|vlan_removed`, `site.zone_*`, `site.conduit_*`, `asset.device_added|device_changed|device_removed`, `asset.data_path_*`, `asset.checks_set`; creating a segment from a VLAN is also `system.created`.

## Security advisories

Since 0.14 _Plant → Advisories_ matches **CSAF 2.0 security advisories** of device vendors and CISA to the assets by manufacturer, model and firmware – the asset's own and its device profile's, with the assignment's _controller firmware_: which assets of which sites and zones (with their SL-T) are affected, how badly, and which firmware fixes it. Only an exact (normalised) vendor and model with the firmware in the affected range counts; weaker matches are _possible matches_ that a person confirms or dismisses. Each affected asset has a remediation status (open, planned, mitigated, accepted risk, not affected), a site can mark an advisory not applicable, and new high and critical matches notify the site's managers. Advisories come from sources an administrator adds (none by default) or are uploaded as files – the way for plants without internet access. The asset page has a section _Advisories_. Everything about sources, matching rules, statuses, rights and limits is in [ADVISORIES.md](ADVISORIES.md).

## Data collections

Since 0.11.0 ([ADR 0019](adr/0019-data-collections.md)) an asset documents **what collectors read from it** – a gateway, an ETL job, a Node-RED flow: which addresses, how often, under which name, what they do with the values and where they load them. Asset page → **Collections**.

### Three layers

1. The **profile data point** is the canonical thing: a conventional id and name, an optional default address and **known-as names** (`aliases`: what tools commonly call it).
2. The **asset's address** of it is the assignment's difference (`overrides[].address`); without one, the profile's address. Two assets of the same profile may have the same data point under different addresses.
3. A **collection item** is what the collector reads (its address) and calls it (its **output name**), linked to one data point of the asset's model – or to none: **raw**.

Everywhere both names are shown: the data point's name first, the collector's after it (_Spindle speed · as `Spindle_speedActSP1`_).

### A collection

A **data collection** belongs to an asset and to a **collector** – a Steward application, platform or process, or a job elsewhere by name (as a data path's collector) – and may name a **data path** of the asset. It reads from one **interface** of the asset's model or an unknown one, and has a name, a **mode** (_every interval_, _on change_, _on a trigger_, _other_), an interval and a debounce in ms, **triggers** (name, condition, reference address or data point, reference value) and how they combine, its **sinks** – where the data goes ([Sinks and transformations](#sinks-and-transformations); a collection of 0.11 had one destination, read as its first sink) –, the collector's **access patterns** – what it may read, **write, create and delete** (the last three are shown in red: the collector can change the machine) –, other **settings** (buffering, events, time sync) and its **items**: address, output name and type, the data point, a transform (a note, optionally scale, offset, cast) and notes.

A collection and each of its items may have an optional **description** (plain text, at most 4000 characters; 0.12.0). The table format reads it from a `description` column; a re-import keeps an item's description written in Steward when the file has none.

**Coverage.** A collection counts its **mapped** items, its **raw** items – an address no data point of the asset has (_Add as data point_: an asset addition with the collector's name as known-as name; or on the profile, for whoever may manage profiles) or a data point the asset no longer has – and the data points of its interface (or of the whole model) that **no collection of the asset reads**. Two items mapped to one data point in one collection are allowed and flagged. The asset's **data flow** and a data point's **lineage** run through the collections: interface → collector → each sink. A data point's page lists the collections that read it (and under which names); an application's and a platform's page the collections it runs.

### Import

_Collections → Import_: choose the collector, the format (or let Steward recognise it), the interface and data path if known, the files and optionally a **mapping file**. The **preview** shows every collection (new, changed, unchanged, removed – with _Remove this collector's collections that the files no longer have_) and every item with a suggested data point, its reason and a confidence, in this order:

| Reason                      | Confidence | Means                                                                                         |
| --------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| **Mapping file**            | 100 %      | a line of the mapping file (by gateway name or address), or the table's own `data_point`      |
| **Remembered**              | 100 %      | the pair was confirmed in an earlier import of this collector for this asset                  |
| **Same address**            | 95 %       | the item's address is the asset's address of the data point (80 % when several have it)       |
| **Same name**, **known-as** | 90 %       | the output name is the data point's id, name or a known-as name (case and separators ignored) |
| **Name for this collector** | 85 %       | a name remembered for this collector only                                                     |
| **Similar name**            | up to 80 % | a fuzzy suggestion – **never applied without confirmation**                                   |

Addresses are compared normalised: whitespace removed (`[u1, 1]` is `[u1,1]`), case ignored where the protocol ignores it (Modbus, PLC and CNC variable paths; not OPC UA NodeIds), Modbus spellings read as one (`hr:100` is `holding:100`), and an OPC UA string NodeId also by its identifier alone (`ns=2;s=/Channel/State/progStatus[u1]` is `/Channel/State/progStatus[u1]`).

The person confirms or changes each match – _Accept all exact matches_, _Accept all above_ a confidence – and may, per item: **record the item's address as the asset's address** of the data point (it becomes the assignment's difference; that is how per-asset addresses get documented from real configurations), **remember the name** as a known-as name of the data point (on a profile data point this needs the right to manage profiles) or only for this collector, or **add an unknown address as a data point** (of this asset, or of the profile). A line says what the import will write. Every confirmed pair is remembered for the asset and collector, so a re-import needs no new work. The import is all or nothing and needs the right to manage the asset's site.

A collection's **mapping** downloads as CSV (`gateway_name,address,data_point`) or YAML (`mapping:` with the same keys) and uploads again as a mapping file. Invented examples of every format: [`examples/plant/collections/`](../examples/plant/collections/).

### Formats

Each importer produces collections for one asset and collector. Steward recognises a format by its **structure**, not by product names or the value of a `type` key, and runs nothing it reads.

- **Gateway JSON – datasets of data points** (`example-gateway-datasets.json`): `datasets[]` with `name`, `mode` (`interval` or `onchange`), `interval` and `debounce` (ms), `unavailable`, `new`, `readings`, `triggercomposition`, `triggers[]` (`condition` such as `anychange`, `name`, `referenceDatapoint`, `referenceValue`) and `datapoints[]` (`address`, `name`, `type` – int, float, string, bool). One dataset is one collection. The file's `readPatterns`, `writePatterns`, `createPatterns`, `deletePatterns` and `patterns[]` (`path` with `read`, `write`, `delete`, `create`) are the access patterns of every collection; `type`, `whitelistedAddresses`, `bufferEnabled`, `maxBufferSize`, `plcTimeSync`, `sendEvents` and `eventsToIgnore` its settings. **Sinks** (0.12) are found by structure too: an object – or a list of objects – of the file (for every dataset) or of a dataset (for that one) that names a target object (`topic`, `table`, `bucket`, `measurement`, `queue`, `stream`, `exchange`, `aspect`; `path`, `filename`, `collection` or `index` only beside a host or format key) is a sink, its target the host of `broker`, `host`, `server`, `endpoint`, `url` …, its format `format` or `protocol`, its schedule `interval`, `batchSize`, `qos` and similar keys. A data point's `target`, `targetName`, `field` or `column` is its name in every sink. Addresses are CNC variables (`/Channel/State/progStatus[u1]`, `/Nck/MachineAxis/measPos1[2]`, NC user data `/NC/_N_…/NAME`) or PLC addresses (`DB13.DBX2.0`).
- **Table – CSV or YAML** (`example-table.csv`, `example-table.yaml`): one row per item with the columns `collection`, `mode` (`interval`, `on_change`, `trigger`, `other`), `interval_ms`, `debounce_ms`, `source_address` **or** `data_point`, `output_name`, `output_type`, `transform`, `destination`, `notes` and (0.12) `description`, `sink` and `target`. A row's item goes to the sink named in `sink` (its target the `destination`), else to a sink named after the `destination`; `target` is the item's name there and `transform` also its own transformation in that sink. A CSV needs a header row and may use `;` instead of `,`; a YAML file is a list of entries with the same keys (or `items:` with the list). Rows with the same `collection` are one collection; its first row gives the mode, interval, debounce and destination.
- **Industrial Edge OPC UA connector** – _preview_ (`example-ie-opcua-connector.json`): the connector's exported configuration, `UIConfig.datapoints.OPCUA[]` with one entry per connection (`name`, `OPCUAUrl`, `portNumber`) and its `tags[]` (`name`, `address` – the NodeId –, `dataType`, `acquisitionCycle` in ms, `acquisitionMode` – `Cyclic` or `CyclicOnChange` –, `accessMode` – `r`, `rw` –, `comments`). One collection per connection, cycle and mode; a tag with write access is a write pattern; the sink is the Industrial Edge Databus – with its topic when the connection has a key with "topic" in its name, else marked as unknown. The user, password and certificate passwords of the export are never read. The importer is built from the structure of a public example export and is marked _preview_ until it has seen more.
- **Node-RED flow export** (`example-node-red-flow.json`): a JSON array of nodes (`id`, `type`, `z`, `wires` …). Source nodes – OPC UA items (`item`, `datatype`), S7 in (`variable`), Modbus reads (`dataType`, `adr`, `quantity`, `rate`), MQTT in (`topic`) – are followed along their `wires` to sink nodes – MQTT out, HTTP request, file and database nodes; a `debug` node ends a way. Each sink node is a collection with the sources that reach it as items and itself as the collection's **sink** – its target the host of the config node it uses (a broker, a database server) or of its URL, its object the topic, URL path, file or table. `function`, `change` (with its rules), `template`, `switch`, `range`, `json`, `csv` and `join` nodes on the way become the item's transform note and the sink's **transformation steps**; a `function` node's code is kept as the step's text – **never run**. An `inject` node before a source gives its interval. A node's `credentials` are dropped before any importer looks at the flow: never read, never stored.
- **Mapping file**: CSV with the header `gateway_name,address,data_point` (either name or address per line), or YAML `mapping: [{ gateway_name, address, data_point }]`.

### Sinks and transformations

Since 0.12 a collection documents **where its data goes** after it is loaded – and how it is changed on the way. Collection → **Where the data goes**. A collection has any number of **sinks**:

- **name**, **kind** – a Steward system, platform, application or dataset where one exists, a publication target, or another target as text –, the **target** (the Steward item's id, the dataset's key, or text such as a broker), **where there** (a topic, a table, an asset and aspect, a bucket path), **format or protocol**, **schedule and batching**, an **owner** and a **description**;
- **transformation steps**, in order: _rename_, _scale_, _unit conversion_, _aggregate_ (a window and a function), _filter_, _enrich or join_, _compute_ (an expression or code as text), _format_, _other_ – each with the field it applies to, its expression and a description;
- an **item mapping**: an item's name in the sink and, optionally, a transformation for that item only.

Everything is documentation: Steward runs no step, no expression and no code. Every item goes to every sink; the mapping names it there. The page shows the flow _items → transformation steps → sinks_, per sink its steps and items, and what reads its data **next** as far as Steward knows it: the data paths that read from the sink's Steward system (the next link of a chain, as on the data path page) and the dashboards that show its dataset. A data point's page says per collection where the data point **goes** (sink, target, its name there). The asset's data flow and the data point's lineage draw every sink. Rights: a target, data path or dashboard the reader may not see is not named – a target reads _a target you may not see_, the others are counted.

Importers fill sinks where the format names them (see [Formats](#formats)). A re-import replaces the sinks it wrote earlier and keeps what people added: a sink entered by hand (or from a YAML file) stays, and on a sink of the import the description, owner and item names the file does not have stay. In the [YAML format](#yaml-import-and-export) an asset network takes `collections` (0.12, the collections with their items) and `collection_sinks`.

### Gateway configurations

Since 0.12 each import **keeps the collector's files** – as Steward stores them, **with secrets removed** – one **version** per import of a collector on an asset (_Gateway configuration_ tab of the collection). An import whose files are the same as the last version's makes no new version. Of each file the list shows the name, who imported it when, the SHA-256 of the original (only the hash and size of the original are stored) and how many values were removed, with the paths – never the values. A version **downloads** as `<name>.v<version>.redacted.<json|yaml|csv>`, and two versions are **compared**: JSON and YAML by path (added, removed, changed values), every file line by line. At most 50 versions per asset and collector are kept (the oldest go first); they go with the asset, and with the last collection they belong to. The import's audit entry (`plant.collection_imported`) names the version: its id, the hashes and the number of removed values.

**What is removed before anything is stored** (`server/src/plant/collections-redact.ts`):

| In               | Removed                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JSON and YAML    | at any depth, the value (also a whole object or list) of a key that looks secret: `password`, `passwd`, `pwd`, `passphrase`, anything ending in `password`, `secret`, `token`, `apikey`/`api_key`, `private key`, `credentials`, `auth`, `Authorization`, `Cookie`, `X-Api-Key`, connection strings, client secrets, access keys, key store passwords, `pin` |
| Name/value pairs | the value of a pair whose name is such a key (`{ "key": "Authorization", "value": "Bearer …" }`, Node-RED's HTTP headers)                                                                                                                                                                                                                                    |
| URLs             | the password of `scheme://user:password@host` in any string and any format (the user stays)                                                                                                                                                                                                                                                                  |
| Node-RED         | a node's `credentials`, entirely – dropped before the importer reads the flow; never stored, not even as `[redacted]`                                                                                                                                                                                                                                        |
| CSV              | the values of a column whose header looks secret; the rest is kept as it is                                                                                                                                                                                                                                                                                  |

Keys that name a setting stay (`authenticationMode`, `tokenEndpoint`, `tokenLifetime`). A removed value reads `[redacted]`. YAML is written anew (comments are not kept). The same rules apply to what the importers write into the collections (a sink's target, settings). The files of one import may be at most 4 MB together, as the import itself.

**The gateway configuration document.** Each import also keeps **one living document per collection** up to date: the built-in type **GWC – Gateway configuration** (created with the first import that writes one; no periodic review), titled _Gateway configuration – \<asset\> – \<collector\> – \<collection\>_, linked to the asset and the collection. Its section `## Gateway configuration (generated)` holds a summary – asset, collector, collection, format, items (mapped and raw), collections in the files, sinks, version and date, files with the hash of the original and the number of removed values – and is **rewritten by every import**; the text under the next heading is yours and stays. The kept file is attached (the files of earlier imports are replaced). By the document's status:

| Status          | What the import does                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Draft, revising | updates the generated section and the file                                                                                   |
| Published       | starts the next edition (as _New edition_ does) and updates it; the published edition stays valid until the next is approved |
| In review       | leaves it as it is (the version is kept all the same)                                                                        |
| Withdrawn, gone | writes a new document                                                                                                        |

The document is written with the importer's rights on records: who may import but not create or change records gets the import without it – the import's result says so per collection (`documents[].action`: created, updated, revised, skipped with `forbidden` or `in_review`). Routes: `GET /api/plant/assets/:assetId/collection-sources[?collection=]`, `GET …/collection-sources/:sourceId/file`, `GET …/collection-sources/diff?from=&to=`, `GET …/collections/:collectionId/flow`.

### Rights and API

A changed id of the asset, its data path, an interface or a data point ([Changing ids](#changing-ids)) reaches its collections and remembered names; removing the asset takes them along (with _Also remove what belongs to it_), and a data path a collection belongs to is removed only with it too. Collections follow the asset's site, like its data paths: who sees the site sees them, who manages it changes and imports them; a known-as name or a data point on the profile needs the right to manage profiles. Every change is audited on the asset: `plant.collection_created|updated|deleted|imported` (the import with its counts and the files' SHA-256); what an import writes besides – the asset's addresses and additions (`asset.assignment_set`), known-as names on the profile (`device_profile.updated`) – is audited as well. Internal routes: `GET|POST /api/plant/assets/:assetId/collections`, `GET|PUT|DELETE …/collections/:collectionId`, `GET …/:collectionId/mapping?format=csv|yaml`, `POST …/collections/import/preview`, `POST …/collections/import`, `GET /api/plant/collections?collectorKind=&collectorRef=`, `GET /api/plant/profiles/:profileId/points/:pointId/collections`; public: `GET /api/v1/plant/assets/{assetId}/collections`.

## Visualizations

The registry draws what it **documents**: how a site is structured, where an asset's data goes, which assets deliver a data point, which KPIs are covered and how data crosses the site's OT network. The pictures are documentation, not monitoring:

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

| State                                | Means                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Has it**                           | a KPI job is set up on the asset                                                                                                                          |
| **Problem**                          | a job is set up, and a plant check of it fails                                                                                                            |
| **Could have it**                    | the asset delivers every data point input, but has no job yet – split by KPI potential (0.12.0) into the two states below                                 |
| ↳ **Collected – ready**              | the device delivers every input **and** a data collection of the asset (any collector: gateway, ETL job …) maps an item to each of them – a job can start |
| ↳ **Device delivers, not collected** | every input is delivered, but no data collection of the asset maps all of them yet                                                                        |
| **Cannot**                           | inputs are missing – the cell says which (no profile, another profile, an interface not active, a data point the asset lacks)                             |
| ↳ _via part …_ (0.13)                | a KPI that rolls up from parts: the state comes from a part of the asset (its job, or the inputs it delivers and collects)                                |
| **Not checked**                      | the KPI reads no data points, so Steward cannot tell                                                                                                      |

The **KPI coverage** in per cent is the jobs set up of all the KPIs the assets could have (has + problem over has + problem + could). **KPI potential** (0.12.0): of the cells that could have a KPI, those whose data is collected already (_N ready_) and those that need a data collection (_M need a data collection_) – collections have no state of their own, so every documented collection counts. The summary shows both, a table **per site and area** (when the answer spans more than one) lists jobs, ready, need a collection and cannot; the site overview answer counts them, too (`potential`). A cell whose inputs arrive in another unit names the difference ([Units of KPI inputs](#units-of-kpi-inputs)). The answer keeps the state `could` and adds `collected` to the cell, `potential` and `groups` to the answer (additive). Filters: site, area, device profile (and a KPI, from the KPI page) – part of the address.

**Roll-up from parts** (0.13). Machines often deliver nothing themselves – their **parts** do: a power meter that is part of a press (the asset's _part of_, `parent` in the file format). A KPI definition with **Roll up from parts** (`rollUp: parts`, `roll_up: parts` in the file format) counts such a part for the machine: a machine without a job of the KPI takes the state of a **direct part** – a part's job first (_Has it_ or _Problem_), else, where the machine cannot have the KPI itself, a part that delivers every input (_Collected – ready_ before _Not collected_) – marked _via part …_ (the cell leads to the part). The parts that count are marked _counted for …_ (dashed) and are **not counted again**: the totals, the KPI potential per site and area and the site tiles count the KPI **once per machine**. The asset page of the machine lists the KPI under _KPIs it can have_ with the part (also for a machine without a device profile), the KPI page lists the machine as a candidate. The job stays on the part, whose device delivers the data. Only assets of sites the reader may see take part, and only direct parts (a part of a part counts for the part). The answer adds `via` and `rolledUp` to a cell (additive).

Why it is **off by default**: a part's data does not always stand for the machine – a meter on one feeder measures only that feeder, a sensor of a gripper says nothing about the cell, and a part may be counted for several KPIs in different ways. Counted for the machine without the owner deciding so, the potential would be wrong in both directions (machines that look ready, and parts that disappear from the totals). Turn it on for the KPIs whose inputs a part delivers **for the whole machine**, such as its energy meter. Pointing at a cell explains it; a click opens the asset (its data flow, or its overview where a job is to be added or a check is shown). Phones show a list per asset. One answer holds at most 20,000 cells (at most 2,000 assets); the totals count every asset that matches.

### OT network diagram

![The OT network of Riverside Works in two bands: the zone Production cells on level 1 with its VLANs and the milling centres, the conduit Cells to DMZ as a gate between it and the OT DMZ on level 3.5, and the parties outside the zones on the right](images/plant/ot-network.png)

_OT network → **Diagram**_ (also from a site's **Structure** and its OT network card), drawn from part 3 ([Part 3: OT network](#part-3-ot-network)):

- **Bands by level.** The zones (IEC 62443-3-2) stand in horizontal bands by their [level](#zones-and-conduits) in the Purdue model: field devices and cells at the bottom, then supervisory, site operations, the DMZ, the enterprise network and external parties at the top – data paths run upwards. A zone without a level gets one for the picture: from its name or a VLAN of the type _dmz_ ("DMZ", "SCADA", "MES", "office", "cloud" …), else the zones with assets lowest, a zone reached only past a DMZ on the enterprise side, the rest between. The zone's panel says when a level is derived. Zones that a conduit connects stand above each other where they can.
- **Zones, VLANs, parts.** A zone is an area with its criticality and SL-T (or _SL-T open_) on its border; the **VLANs** (IEEE 802.1Q) in it are areas inside it, with their VID; the **assets** sit on the VLAN of their first device, as small chips. Zoomed out, a chip shows its name only, larger; zoomed in, also its kind, its live status in words and a detail line (devices and data paths of an asset, the kind and host of a collector).
- **Conduits are gates** on the boundary between their two zones, with a short pipe into each zone and arrows in their direction (both ways: arrows at both ends, nothing moves).
- **Data paths** run from where the data comes from (what the collector pulls from – a device is its asset –, else the asset), over the **collector** and the parties it pushes to, to the **destinations**. A **host** (a Steward system named by a data path) is placed on the VLAN whose **network segment** it is a member of – so a way into another zone runs **through the gate** between the two zones; one without a documented conduit is dashed in orange. Collectors, hosts, datasets and other parties outside every zone stand in a column on the right, near what they are connected to. The protocol, port, push or pull of a way show when you point at it, or at a part or data path – not all at once, so they do not cover each other.
- **Fits the frame.** The picture opens with everything in view and fills the screen below the toolbar; _Show everything_ (in the zoom buttons) fits it again. **Full screen** (the button below the zoom buttons) gives it the whole window; Escape leaves it. Zoomed in on a larger site, a **mini map** shows where you are.
- **Find and select.** The search finds an asset, collector, host, other party, dataset, zone, VLAN, conduit or data path and centres it. A click (or Space) **selects** a part: its data paths stay, the rest is dimmed, and a card shows its details with _Open page_; _Clear selection_ above the picture, Escape or a click on an empty spot clear it. A double click or Enter opens the part's page.
- **Filters** narrow the data paths: by zone, by protocol, by live status (online, offline, no data, not watched), _Only paths that cross zones_ and _Only paths without a documented conduit_. What no path of the filter touches is dimmed; the side panel lists only the paths that match.
- **Devices and VLANs on hover or focus**: the card shows an asset's devices (address, VLAN, state, live status), a VLAN's subnets, segment and who manages it, a zone's level, VLANs, owner and risk assessment, a conduit's protocols and controls.
- **The side panel** lists the data paths (pointing at one highlights its way, a click selects it). It folds to a thin strip and stays as you left it (kept per user in this browser); it starts open on wide screens and folded below 1,600 px.
- **The legend** folds into the _Legend_ button (reachable with Tab, Escape closes it).
- **Live status only from linked checks**: an asset is online, offline or _no data_ from the checks linked to it and its devices (monitors – Gatus, CheckMk, the MQTT silent-device and Kafka checks – and dataset freshness). Its data paths are coloured by it: green when online, red and still when offline. An asset nothing watches is drawn neutral (documentation only), with the direction of its paths only. Hosts, collectors and other parties have no live status here. With more than 60 ways only the highlighted ones move; the arrows show the direction of all.
- **Phones** start with the table; the picture is a tap away, fitted to the screen, with pinch zoom; a tap selects a part and shows its details below the picture.
- The table lists every zone (with its level), VLAN, conduit, asset and party with what it is in, its details and its status in words, and every data path with its way. Assets without devices and data paths are not drawn (the page says how many). The export (SVG or PNG) draws the same bands, zones and gates, without the filters or a selection.

### Site overview tiles

![Two site cards with their assets by status, KPI coverage and open checks](images/plant/site-tiles.png)

_Plant → Sites_: every site's card (and a column of the table) shows its assets by status as a small bar, its **KPI coverage**, since 0.13 its **KPI potential** (_N ready · M need a collection_, when there is any), its **open checks** and – where assets link to monitors – their states, with links into the structure and the coverage matrix.

The views read their data again every minute (live status may change; the documentation rarely does). Their internal routes are `GET /api/plant/views/overview`, `GET /api/plant/views/coverage?site=&area=&profile=&kpi=`, `GET /api/plant/sites/:siteId/structure`, `GET /api/plant/assets/:assetId/flow`, `GET /api/plant/profiles/:profileId/points/:pointId/lineage` and `GET /api/plant/sites/:siteId/network/placement` (which VLANs the hosts of the site's data paths are in, through the segments they are members of – hidden hosts and segments place nothing; the diagram draws the rest from `GET /api/plant/sites/:siteId/network`) – with the rights of the pages they picture.

## Map

![The map of sites: the list and the map side by side, pins with their state](images/plant/map.png)

_Plant → Map_ ([ADR 0015](adr/0015-map-of-sites.md)) shows the sites the reader may see as a list and on a map side by side; phones start with the list (_Picture_ / _Table_). The search and the state filter apply to both. **The map is off until an administrator turns it on** – until then the page is the list, and nothing is sent to a map provider.

### Turning it on

_Settings → Modules → Map of sites_ (administrators, shown while the plant registry is on). _OpenStreetMap_ is preselected: **Turn on with OpenStreetMap** is one click, with what each choice sends where in front of you. Every choice:

| Tiles from                     | What it is                                                                                                                                                          | What leaves Steward                                                                                                              | Attribution on the map                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| _Off_ (the default)            | the list only                                                                                                                                                       | nothing                                                                                                                          | –                                                           |
| _OpenStreetMap_                | raster tiles of `tile.openstreetmap.org`, zoom 0–19, dimmed (not inverted) in the dark theme                                                                        | Steward's server asks `tile.openstreetmap.org` for the tiles people look at: the provider sees Steward's address, never a user's | © OpenStreetMap contributors (linked to its copyright page) |
| _Light and dark (OpenFreeMap)_ | vector tiles of [OpenFreeMap](https://openfreemap.org) (OpenStreetMap data, OpenMapTiles schema, no key) in Steward's own light and dark style, following the theme | Steward's server asks `tiles.openfreemap.org`; a donation-funded service without a service level – a choice, not the default     | OpenFreeMap © OpenMapTiles · © OpenStreetMap contributors   |
| _Own tile source_              | a raster URL template (`{z}`, `{x}`, `{y}`) or a [MapLibre style](https://maplibre.org/maplibre-style-spec/) URL, optionally with an API key                        | Steward's server asks the origins the template or style names (shown before saving with _Check the style_)                       | the text you enter (required) and the style's own           |
| _Self-hosted file (PMTiles)_   | a [PMTiles](https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md) v3 file in `<data>/maps/`, raster or vector                                             | nothing                                                                                                                          | the file's metadata, or the text you enter                  |

- **Changing where tiles come from** – a new source, URL, API key or file, or _Read the style again_ – asks you to confirm it is you (**step-up**, control point `plant.mapSource` of the [assurance policy](ASSURANCE.md), on by default) and is audited as `plant.map_settings_changed` with the old and the new origins (never the key). This holds for the own tile source also while another source is chosen – it is what the map uses once it is chosen. Turning the map off never asks and keeps the stored own source, its key and the file as they are; changing only an attribution never asks either.
- **Check the style** reads an own style before saving and shows its origins. Checking a new address is the first step of a new source: it asks for the same step-up. Every check is audited (`plant.map_source_checked`, with the origins, never the key).
- **Own style URL:** Steward reads the style when it is saved (and on _Read the style again_), keeps its raster and vector sources (a [TileJSON](https://github.com/mapbox/tilejson-spec/tree/master/3.0.0) URL is read to its tile template) and the layers on them, its glyphs and sprite – and drops everything else (GeoJSON sources, metadata). The origins of all of these are the source's origins. Templates with `{s}` sub-domains, `{r}` or `{quadkey}` are refused: name one host.
- **API key:** stored in the vault, added by Steward's server as the query parameter or request header you name, never sent to the browser, never shown again (_Remove the stored key_ clears it). A stored key belongs to its address: it is only sent to the stored source's own origins (also by _Check the style_), and a new address on another origin needs the key entered again (`PLANT_MAP_KEY_AGAIN`). It is re-encrypted with the vault's data key on a key rotation.
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
- **Pins follow the map** in the frame it is drawn in, while panning and zooming. Only pins in view are shown and focusable; the sites half a view around it are drawn hidden, so pins do not appear late. Clusters are made anew when the zoom level changes or new sites come near the view.
- **The card**: name, code, state, assets by status, KPI coverage, open checks, and links to the site, its structure and its OT network.
- **Show on map** on the site page (and in the list) opens the map at the site with its own zoom. `prefers-reduced-motion` and _Animation off_ turn the fly-to into a jump.
- **Position picker**: in the site form, a click on the map sets latitude and longitude (typing them stays possible, also with the map off).
- **Dashboard widget _Sites map_**: the same map, small, for readers of the plant registry; others read _Not visible_. Status pages never show it.
- **Without WebGL 2** (some virtual desktops) the page shows the list and says why; when the source fails, the list stays with _The map could not be loaded_ and, for administrators, the reason. A failing tile tells other readers only that the source failed (`PLANT_MAP_SOURCE_FAILED`), never its address.

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

(Three files in one block for brevity; each `---` part is its own file.) Keys: a profile has `id`, `name`, `manufacturer`, `model`, `version`, `category`, `description`, `notes`, `interfaces`; an interface `id`, `name`, `protocol`, `direction`, `description`, `version`, `default_port`, `authentication`, `client`, `notes`, `groups` (`name`, `description`, `data_points`), `data_points`, `file_sets` (`id`, `name`, `description`, `format`, `direction`, `path_pattern`, `produced_per`, `retention`, `encoding`, `notes`); a data point `id`, `name`, `description`, `data_type`, `unit`, `address` (or `node_id` / `modbus_address`), `access`, `update_rate_ms`, `enum_values`, `aliases`, `notes`, `publications` (`target`, `path`, `name`). Since 0.11.0 a profile also has `extends`, and an interface or data point of a derived profile `present` ([Profile inheritance](#in-the-file-format)); since 0.12.0 a profile has `template` and a KPI input `units` (data point → unit, e.g. `units: { active_energy_import: kWh }`); since 0.13 an inherited interface of protocol `other` takes `protocol` ([Bases across protocols](#bases-across-protocols)), a KPI definition `roll_up` (`none`, `parts`) and a KPI input `profiles` (any of these) and `mapping` (profile → input data point → its data point; [Any of these profiles](#any-of-these-profiles)). A KPI definition has `id`, `name`, `names`, `category`, `type`, `description`, `formula`, `unit`, `range` (`min`, `max`), `trend`, `timing`, `audience`, `methodology`, `strategy`, `implementation`, `dynamic_columns`, `inputs` (`kind`, `profile`, `data_points`, `notes`), `parameters` (`name`, `aliases`, `description`, `type`, `default`, `required`, `min`, `max`, `unit`), `columns` (`name`, `kind`, `scope`, `unit`, `numerator`, `denominator`, `scale`, `description`), `computation` (`summary`, `diagram`, `steps` with `name`, `does`, `why`, `identities` with `relation`, `note`, `limits`), `notes`. An assignment has `asset`, `site`, `profile`, `firmware`, `interfaces` (`interface`, `active`, `endpoint`, `notes`), `overrides` (`data_point`, `available`, `address`, `unit`, `data_type`, `update_rate_ms`, `notes`), `additions` (`interfaces`, `data_points` with `interface` and `group`; 0.11.0), `publications` (`data_point`, `target`, `path`, `name`, `published_by`, `notes`), `kpis` (`kpi`, `job`, `active`, `params`, `dashboard`, `dataset`, `notes`), `notes`.

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
        level: control,
        vlans: [rvs-vlan-110],
        sl_t: 2,
        risk_assessment: RA-RVS-2026-01,
        assessed_at: '2026-03-02',
      }
    - { id: rvs-zone-dmz, name: OT DMZ, level: dmz, vlans: [rvs-vlan-900] } # SL-T open
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
  collections: # 0.12: what collectors read from the asset (added and changed by an import, never removed)
    - id: machine-state
      name: Edge gateway – machine state
      collector: { kind: job, ref: rvs-edge-gateway } # required for a new collection
      interface: opc-ua
      mode: on_change # interval (default), on_change, trigger or other
      debounce_ms: 500
      access: { read: ['/Channel/*'] } # write, create, delete: the collector can change the machine
      items:
        - { address: '/Channel/State/progStatus[u1]', output_name: ProgStatus, data_point: program_status, description: For the availability KPI }
        - { address: '/Channel/State/acProg[u1]', output_name: ActiveProgram } # no data_point: raw
  collection_sinks: # 0.12: where the data of a data collection of the asset goes (stored, or in collections above)
    - collection: machine-state
      sinks:
        - id: plant-broker
          name: Plant broker
          ref: mqtt.example.com:8883 # kind: system, platform, application (Steward ids), dataset (a key), publication or other
          object: plant/riverside/mill-01
          format: JSON over MQTT
          schedule: on change, QoS 1
          transforms: # in order; documentation only – never run
            - { kind: rename, field: ProgStatus, expression: program_status }
            - { kind: aggregate, field: SpindleSpeed, window: 1 min, function: avg }
          mappings:
            - { item: ProgStatus, target: program_status }
```

Keys: an OT network has `site`, `vlans`, `zones`, `conduits`; a VLAN `id`, `name`, `vid`, `type`, `owner`, `description`, `subnets` (`cidr`, `gateway`, `description`, `ranges` with `start`, `end`, `type`, `notes`), `restricted`, `managed_by`, `rules_at`, `sites`, `location`, `segment`, `notes`; a zone `id`, `name`, `description`, `criticality`, `level`, `vlans`, `owner`, `sl_t`, `risk_assessment`, `assessed_at`, `notes`; a conduit `id`, `name`, `description`, `zones` (two), `direction`, `protocols`, `controls`, `notes`. An asset network has `asset`, `site`, `checks`, `devices`, `data_paths` and (0.12) `collections` – a data collection's `id`, `name`, `collector` (`kind`, `ref`, `host`; required for a new one), `data_path`, `interface`, `mode`, `interval_ms`, `debounce_ms`, `triggers` (`name`, `condition`, `reference_point`, `reference_value`), `composition`, `access` (`read`, `write`, `create`, `delete`), `settings` (`key`, `value`), `items` (`address`, `output_name`, `output_type`, `data_point`, `transform` with `note`, `scale`, `offset`, `cast`, `description`, `notes`), `description` and `notes`; matched by the asset and id, keys left out keep their values, a list given replaces the list; a data point an item names must be in the asset's model after the import (the same file may add it); an import adds and changes collections but never removes one (remove it on the asset page); the importer and file a collection came from stay as they are – and `collection_sinks` – per data collection its id and all its sinks (`id`, `name`, `kind`, `ref`, `object`, `format`, `schedule`, `owner`, `description`, `transforms` with `kind`, `field`, `expression`, `window`, `function`, `description`, and `mappings` with `item`, `target`, `transform`); the list replaces the collection's sinks; the collection is a stored one or one in `collections` of the files; a device `id`, `hostname`, `domain`, `purpose`, `mac`, `serial`, `vlan`, `address_type`, `address`, `switch`, `switch_port`, `wall_outlet`, `cmdb_port`, `state`, `flags`, `confidence`, `owner`, `monitoring`, `checks`, `notes`; a data path `id`, `subject`, `description`, `devices`, `collector` (`kind`, `ref`, `host`), `transfers` (`protocol`, `mode`, `peer_kind`, `peer`, `port`, `notes`), `destinations` (`kind`, `ref`, `path`, `notes`), `notes`; a check either `monitor` (with `check`) or `dataset` (with `column`, `value`, `time_column`, `max_age_minutes`), and `note`. A VLAN, zone and conduit are matched by their site and id, a device and data path by their asset and id, the checks by their asset. The same rules as an edit apply; in _replace_ with _remove_, a VLAN, zone or device that goes while a record that stays names it stops the import. `examples/plant/brightwater-ot-network.plant.yaml` is an invented OT network of the example enterprise (import it after `brightwater.plant.yaml`).

### Modes

_Plant → Import_ (or `POST /api/plant/import`): choose the files and the mode, look at the preview, then import.

| Mode                          | New records | Records that exist                                                  | Records the file lacks                                                                                                      |
| ----------------------------- | ----------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Add only**                  | added       | left as they are (shown as _skip_)                                  | left alone                                                                                                                  |
| **Add and update**            | added       | get what the file says; keys the file leaves out keep their values  | left alone                                                                                                                  |
| **Replace an earlier import** | added       | written in full: the file is the truth (keys left out become empty) | those **the chosen earlier import wrote** are **removed** or **kept and marked _not in source_** – your choice; others stay |

- Records are matched by their stable ids. Every record remembers the import that wrote it last; replacing an import adopts its records into the new one, so the next replace finds them again. A marked record that comes back into a file loses its mark.
- Records entered by hand are never removed by an import. When they name something that is removed (an asset in a removed work unit, a node in a removed building), they lose that reference – the preview shows it as a change; a node added by hand below a removed node stops the import (add it to the file, or keep and mark). A site that still holds records that stay is marked instead of removed.
- The **preview** lists every record as _add, change, remove, mark, unchanged_ or _skip_, with the fields that change, and the counts per kind. Since 0.12.0 a changed record also shows **what differs**, field by field, with the stored and the new value (`interfaceOverrides[opc].groups[State].description`; lists of entries by their ids; long values shortened; the first 500 changed records). It needs the import's own right (adding sites, or managing one) and names nothing of sites you may not see: an earlier import of such a site counts as not found, a code or asset id taken there gets a message without that site, and its records are left out. **Problems** name the file and the place in it (`sites[0].areas[1].work_centers[0].type: Use one of: production_line, …`); a file with problems imports nothing. The import applies all or nothing, in one transaction.
- Since 0.11.0 an import that removes or renames more than one record asks you to confirm that it is you (step-up, control point `plant.bulkChange` of the [assurance policy](ASSURANCE.md)) – also _replace_ with _remove_; renaming one asks only when `plant.renameId` is turned on. The preview says so.
- Every import is audited (`plant.imported`) with mode, counts, the files with their size and SHA-256, and the SHA-256 of all files together; the import page lists earlier imports.
- Device profiles and KPI definitions need the right to manage the catalogues (designers and administrators), an assignment the manage right on its asset's site; an asset in a site you may not see reads like one you may not change. An assignment names an asset, profile, interfaces, data points and KPI definitions that exist after the import (in the files or in Steward). In _replace_ with _remove_, a profile or KPI definition that goes while an assignment that stays still names it stops the import; an assignment goes with its asset.
- **Checks** of the records in the files – as they will be after the import – are shown in the preview ([Checks](#checks)); they do not stop the import.
- **Limits** (as for the other YAML importers): all files together at most 8 MB, at most 500 files, a bound on the number of keys before parsing, duplicate keys found in linear time (they are errors), nesting at most 12 levels deep, at most 100 aliases.

### Export

_Export YAML_ on the site list (every site you may see, with the device profiles, KPI definitions, the assignments of the assets and their OT networks), on a site page and its OT network (that site, as `site:`, with the assignments of its assets, `ot_network:` and `asset_networks:`), on the profile and KPI lists (`?part=catalogue`: the device profiles and KPI definitions) and on a profile or KPI definition page (`?profile=<id>`, `?kpi=<id>`: one record, as `device_profile:` or `kpi_definition:`), or `GET /api/plant/export[?site=<id>|?part=catalogue|?profile=<id>|?kpi=<id>]`. The export is format 1 and imports back unchanged: exporting, importing the file in _replace_ mode and exporting again gives the same file. It is audited (`plant.exported`).

## Changing ids

Since 0.11.0 an entry can get a new id. Every reference follows in one transaction, and the old id stays an **alias** that still leads to the entry.

**What can be renamed:** sites, buildings, areas, work centers and work units (one id space per site), assets, device profiles with their interfaces and data points, KPI definitions, VLANs, zones and conduits of a site, devices and data paths of an asset. The job name of a KPI instance and the id of a file set have no references; change them by editing the assignment or the profile. Checks of an asset have no id.

**One entry:** on its page (a site, an asset, a device profile, a data point, a KPI definition), _More actions → Change id_. The dialog checks the new id while you type – the same rules as for a new entry: its format, no other entry of the kind (in its site, asset or profile) has it, and it is no old id of another entry – and lists what refers to the entry (assets, nodes, links, assignments …). Whoever may change the entry renames it. The assurance policy point `plant.renameId` (off by default) can ask for a step-up.

**What follows:** the plant tables (the site of nodes, buildings, assets and the OT network; locations, parents, buildings; assignments, KPI inputs and KPI instances; zones' VLANs, conduits' zones, devices' VLANs, data paths' devices and peers), the links of records, services, tickets and applications (`site`, `asset`, `conduit` – `<site>/<conduit>`), owning teams, credentials' _used by_, where copies came from, the sites of earlier imports, the external references and the image. The audit log is history and keeps the old ids. A dataset filter of a live-status check (`value: rvs-mill-01`) names rows of an outside dataset, not the entry, and stays as it is. A KPI input without a device profile names a data point of whatever profile an asset has and keeps its name.

**Old ids keep working:**

- reads of the internal API and of `/api/v1/plant/…` (paths and the filters `site`, `asset`, `profile`, `kpi`) take an old id as the entry; changes name the entry by its id;
- a link or bookmark in the web app opens the entry and its address changes to the new id;
- an import file with an old id updates the entry; the preview notes it under _old ids in the files_.

Chains collapse: after `a → b` and `b → c`, both `a` and `b` lead to `c`; renaming back to an old id removes that alias. A new entry cannot take an old id. _Settings → Modules → Plant registry → Old ids_ lists them for administrators; removing one there frees the id (audited as `plant.id_alias_removed`). When an entry is removed, its aliases go with it and its ids are free again.

**Audit:** `plant.id_changed` with the kind, the old and new id and the number of references updated per kind.

**Since 0.13.0** a rename is a change set of its own ([Change sets](#change-sets)): the preview returns `fingerprint` (send it with the rename to refuse a different result), the entry's history follows the new id, and where a site needs a second person the rename becomes a proposed change set (`202`).

### Renaming many entries with an import

The import page has an optional step _Change ids_: a list of old → new ids, pasted or loaded from a file, and simple rules.

```csv
kind,old,new
asset,rvs-mill-01,rvs-mc-01
hlc-im-01,hlc-moulding-01
```

A line is `kind,old,new` or `old,new` (any kind); YAML works too (`- { kind: asset, old: rvs-mill-01, new: rvs-mc-01 }`). Rules – _replace a prefix_, _add a prefix_, _add a suffix_, _lower case_ – apply to the ids of the chosen kinds (all kinds when none is chosen), after the list. The mapping applies to the ids in the files and to every reference inside them. When a mapped old id is an entry that exists, that entry is **renamed** through the same rename core and then updated from the files, so _export → map → import_ renames many entries at once. In the API: `idMap: { entries: [{ kind, old, new }], rules: [{ type, from, to, kinds }] }` in the body of `POST /api/plant/import[/preview]`.

The preview lists the renames apart from what is added, changed and removed. It refuses: two old ids that would become one new id, an id that is old and new at once (chains and cycles – rename in two imports), a new id another entry has, an old id of another entry, a new id in the wrong format, and an entry you may not change. Renaming more than one entry asks for a step-up (`plant.bulkChange`, on by default). The renames are audited once as `plant.ids_changed` and in `plant.imported`.

## Changing many entries at once

Since 0.11.0. Every bulk change shows a preview first – what changes, what is **skipped** (an entry you may not change) and what is **refused** (a rule or a reference, with the reason) – and applies in one transaction. Removing more than one entry, or editing more than 25, asks for a step-up (`plant.bulkChange`). One audit entry per action, with the entries in its details: `plant.bulk_changed`, `plant.bulk_removed`.

**Since 0.13.0** a bulk change is a change set ([Change sets](#change-sets)): the preview returns `fingerprint`; sent with `POST /api/plant/bulk`, a result that differs is refused (`PLANT_BULK_CHANGED`). Every entry it changes gets its history. Where a touched site needs a second person, the change becomes a proposed change set (`202`).

**In the lists:** the asset, site, device profile and KPI definition lists and a site's devices (0.12) have a checkbox per row (and _Select all shown_). _Edit selected_ sets fields that are safe to set on many entries:

| Kind           | Fields                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset          | status, add or remove tags, manufacturer, model, domain, process area, role, end of support, device profile; building and place (assets of one site) |
| Device profile | category, manufacturer                                                                                                                               |
| KPI definition | category                                                                                                                                             |
| VLAN (API)     | type, managed by, restricted, owner                                                                                                                  |
| Device         | state, confidence, owner, add or remove flags (the site's _OT network → Devices_ tab)                                                                |

A place or building must be one of the asset's site. A new device profile is refused for an asset whose assignment has interface settings for its old profile (change it on the asset's page). Owning teams of many sites are set with `POST /api/owning-teams/bulk` and `resources: [{ kind: site, id }]` (administrators, [TEAMS.md](TEAMS.md)). _Remove selected_ works for every list above.

**With an import:** two ways, both through the same removal core:

- `remove:` in a file – entries by kind and id, with `site` (buildings, nodes, VLANs, zones, conduits) or `asset` (devices, data paths):

  ```yaml
  version: 1
  remove:
    - { kind: asset, id: rvs-old-press }
    - { kind: vlan, site: riverside, id: rvs-vlan-130 }
  ```

  An entry that is not there (any more) is left out, so the same file imports again.

- _Remove entries that are not in the files_ (`removeMissing: true`): within each site the files hold, the entries of the kinds they list there (its buildings, its areas and what is below them, its assets; the VLANs, zones and conduits of an `ot_network`; the devices and data paths of an `asset_network`) that the files do not have. Device profiles and KPI definitions only when a file lists them all (`device_profiles:`, `kpi_definitions:`). Nothing outside: other sites and kinds the files do not list stay. So _export → delete entries → import_ removes them.

An explicit list is easy to review in a diff; the option suits a file that is the truth for its sites. An entry in `remove:` and in the files is a problem.

**What goes with an entry:** only when you choose _Also remove what belongs to it_ (`cascade: true`). Without it, an entry that still has any of these is refused, and the preview says what it has:

- a site: its areas, work centers, work units, buildings, assets and OT network, and the links to it;
- an asset: the assets that are part of it, its assignment and KPI instances, devices, data paths, linked checks and links;
- an area or work center: the nodes below it and the assets in them; a building: its floors and rooms; a zone: its conduits; a conduit: the links to it; a KPI definition: its KPI instances (refused when one is on an asset you may not change).

External references, owning teams and the image always go with their entry. **References from other entries** always refuse a removal unless those entries go too: a node or asset in a building, an assignment of a device profile, a zone or device naming a VLAN, a data path naming a device. A removed id is free again; aliases that led to the entry are removed with it.

## Proposals from assistants

Since 0.12.0 an AI assistant connected through [MCP](MCP.md#plant-registry) can read the registry and **propose** additions and changes: for example a device profile built from a vendor's manual, with a base profile and derived ones, the asset-specific addresses of a line read from a gateway configuration, or the known-as names of its variables. Nothing is written until a person applies it.

**What the assistant sends.** A `title`, a `rationale` (where the information comes from) and a document of the [file format](#yaml-import-and-export) as JSON – the same keys as a file, at most 48 kB. Steward runs the import's preview in mode _update_ with the token owner's rights: a document with problems is refused with the problems, so the assistant can fix it; a document that changes nothing is refused too. The proposal then waits under **AI requests** for up to 14 days.

**Data collections, end to end.** An assistant documents a gateway, an ETL job or a flow with the three layers: the profile's data points with the gateway's variable names as known-as names, the asset's own addresses as overrides of its assignment, and in `asset_networks` the asset's `collections` – each item with its address, its name in the collector and the data point it is (or none: raw) – with their `collection_sinks`: where the data goes, the transformation steps on the way and the item names there. Expressions and code are kept as text and never run.

**No credentials.** A document that holds what looks like a credential is refused with the places: a value under a key such as `password`, `token`, `apiKey`, `secret` or `Authorization` (also as a `key`/`value` setting), and a password in a URL (`opc.tcp://user:password@host`) – the same rules as the redaction of kept gateway configurations ([Gateway configurations](#gateway-configurations)). A value written as `[redacted]` is fine.

**Only adding and changing.** A proposal never removes or renames: `remove:`, removing what the document leaves out, an id mapping and the modes _add only_ and _replace_ are refused when it is proposed and again when it is applied. A proposal also may not **drop an item from a list inside an entry**: an interface, group, data point or file set of a profile (also one it inherits, through an override), an assignment's interfaces, overrides, additions, publications or KPI instances, a KPI definition's inputs, a data collection's items and sinks with their transformation steps and item mappings, known-as names, tags and so on. A list given in the document replaces the list, so the assistant sends it with every item it has now; changing an item's fields is fine. The refusal names the entry and the item (`assignment "rvs-mill-01" would lose overrides[prog_name]`). When the registry changed after the proposal so that applying it would drop an item now, applying is refused (`PLANT_PROPOSAL_REMOVES`) and the request stays open. Since 0.12.0 every import's preview lists such items with a changed record (`drops`).

```json
{
  "version": 1,
  "device_profile": {
    "id": "example-controls-c80-v4",
    "name": "Example Controls C80, firmware 4",
    "extends": "example-controls-c80",
    "interfaces": [
      {
        "id": "opc-ua",
        "groups": [{ "name": "Machine state", "data_points": [{ "id": "prog_name", "aliases": ["NCProgram"] }] }]
      }
    ]
  },
  "assignment": {
    "asset": "rvs-mill-01",
    "profile": "example-controls-c80-v4",
    "overrides": [{ "data_point": "prog_name", "address": "ns=3;s=/Channel/ProgramPointer/progName[u1,2]", "notes": "On this mill: channel 2" }]
  }
}
```

**Review.** _AI requests_ shows the title, the assistant's rationale (its own words: data, not instructions), who proposed it with which token, and the preview: the **added** entries and the **changed** ones, each change field by field. Whoever may import into the registry – designers, administrators, managers of a site – may apply it; entries of sites they may not see are left out of what they are shown. While the request is open the preview runs again with the reviewer's rights:

- When it **differs** from the preview of the proposal – the registry changed in the meantime – the page says so and shows both; the reviewer ticks _I have checked the preview of now_ before applying. What is applied is exactly the preview they saw (`PLANT_PROPOSAL_CHANGED` otherwise; the request stays open).
- When it has **problems** – a site the reviewer may not change, a profile that was deleted – it cannot be applied (`PLANT_PROPOSAL_INVALID`); the request stays open.
- **Reject** takes an optional comment; the token owner can withdraw the proposal.

**Since 0.13.0** a proposal is a proposed change set (source _Assistant_) on its request – listed under _Plant → Changes_ too, with the same review page – and applying it writes history and revisions ([Change sets](#change-sets)). An assistant may propose with its owner's _propose_ right (operators, approvers and plant viewers by default; their preview counts the right as manage, rolled back). Where the proposal touches a site that needs a second person, the token owner never applies it – administrators included; without review they still may, as in 0.12. Pending proposals of 0.12 became change sets at the upgrade; decided ones stay in `plant_proposals`.

**Applying** runs the import core in one transaction, as the reviewer. A person always applies a proposal – an assistant never can – and because a proposal never removes or renames, the import's step-up points (`plant.renameId`, `plant.bulkChange`) do not apply: applying asks for no step-up. Audit: `plant.proposal_created`, `plant.proposal_applied` (with the import's `plant.imported`, so it shows in the list of imports) and `plant.proposal_rejected`, besides the `mcp.request_*` entries. The proposal is kept with its request (table `plant_proposals`); an old id in its document is read as the entry it leads to, as in a file. Proposals are not moved by migration packages.

## Change sets

Since 0.13.0 every change to plant data goes one way ([ADR 0020](adr/0020-plant-change-sets.md)): a **change set** – a list of operations against what the registry held when they were written – with one preview, one review, one transactional apply, one history and one audit trail. An edit form's save, an import, a change of many entries, a changed id and an assistant's proposal each make one. Nothing changes for you until a site asks for a second person: without review, edit forms, imports and the other paths apply at once, as before.

**Revisions.** Every entry – a site, node, building, asset, its assignment and linked checks, device profile, KPI definition, VLAN, zone, conduit, device, data path and data collection – has a `revision` (one more with every change; a write that changes nothing changes nothing). The pages and the API return it with the entry. An edit form sends back the revision it loaded; when someone else changed the entry since, the save is refused with `409 PLANT_ENTRY_CHANGED` and the dialog _Changed by someone else_ shows, per field both of you changed, the value when you opened it, the value now and yours – _Keep mine_ or _Take theirs_. Fields only they changed keep their value, fields only you changed keep yours. A request without `revision` (scripts, clients of 0.12) writes as before. `DELETE` takes it as `?revision=`.

**Operations and sources.** `set` (the fields of an entry, with the base the author saw), `add`, `remove` (with _also remove what belongs to it_), `rename` (the [rename core](#changing-ids)), and the documents `import` and `bulk`, compiled again from their files or body when previewed and applied. A change set's source says where it came from: _Edit_, _Draft_, _Import_, _Many at once_, _Change id_, _Assistant_ or _Revert_.

**Drafts.** Who may **propose** on a site (a new right between _view_ and _manage_, by default for operators, approvers and plant viewers – see [Permissions](#permissions)) keeps drafts: on a site or asset page _Propose a change_ opens the usual form, and what it saves goes into the person's **current draft**. Where a site needs a second person, every edit form – the entry pages, editing in place on the _Devices_ and _Data paths_ tabs, _Move to…_ – saves into the draft, managers' too; the route answers `202` with the entry as it would be and `changeSet`, the draft. The **draft bar** at the bottom of the plant pages (reached by _Skip to your draft_) names the draft, counts its changes, switches between drafts or starts one, and leads to _Review and propose_. A second save of the same entry changes its operation; its base stays what you loaded first. Drafts expire after 30 days without a change.

**Plant → Changes** lists _My drafts_, _To review_ (with a count: proposed change sets you may apply), _Applied_ and _Closed_ (rejected, withdrawn, expired), filtered by site and source. Assistants' proposals show here and under _AI requests_. Site and asset pages show _2 open changes_ and _Changed in your draft_.

**Review page.** What applying the change set **now** would do, grouped into added, changed, renamed and removed entries, field by field (full values, not the shortened ones of the import's preview); entries of sites you may not see are left out. When something changed in Steward after an operation was written, the operation's fields are merged **three ways** – _When drafted_, _Now in Steward_, _This change_: a field only one side changed takes that side, both to the same value is fine, both differently is a **conflict**, shown first with a choice each (a radio group per field; `[` and `]` move between conflicts). The choice is kept with the change set; the preview is computed again and announced. A removed entry is a problem of every operation on it; a renamed one is followed. Imports and bulk changes are compiled again from their document. Actions: _Propose_ (frozen, 14 days to decide), _Apply_, _Reject_ with a comment, _Back to the author_ (proposed → draft), _Withdraw_, _Copy into a new draft_ (a rejected, withdrawn or expired one). On a phone the entries are cards and a field's three values stack.

**Fingerprints.** Applying needs the **fingerprint** of the preview the person saw – what applying writes, entry by entry and field by field. When the registry changed since and the result would differ, applying is refused (`PLANT_CHANGESET_CHANGED`) and the preview shows what it does now. The same holds for the paths of one request: `POST /api/plant/import/preview`, `…/bulk/preview` and `…/ids/rename/preview` return `fingerprint`; sent with the import (`PLANT_IMPORT_CHANGED`), bulk change (`PLANT_BULK_CHANGED`) or rename (`PLANT_RENAME_CHANGED`), a different result is refused. A request without it applies as before.

**A second person.** The assurance policy's control point `plant.changeSet` ([ASSURANCE.md](ASSURANCE.md)) is **off** by default: nothing changes on upgrade. With **optional** each site has the switch _Changes need a second person_ (on the site page, for who manages the site, confirmed like an access grant; never in the import format, so an import cannot turn it off), and _Plant → Changes_ has one for device profiles and KPI definitions (who manages the catalogue). **Required**: every change. A change set that touches several sites needs review if one does. Under review:

- every change goes through a change set that someone **else** applies – the edit forms into the author's draft, an import, bulk change or rename through its route becomes a **proposed** change set (`202` with `changeSet`, also for API tokens: a nightly sync into a reviewed site becomes a proposal instead of failing);
- **no author applies**: the creator, everyone who changed an operation and, for an assistant's proposal, the token owner – administrators included (`PLANT_CHANGESET_OWN`);
- applying needs the rights of everything it touches: _manage_ on every site (who may add sites for a new one), the catalogue's right for profiles and KPI definitions. Reviewers see only the operations of sites they see.

Without review, the author applies their own draft, and a token owner applies their own assistant's proposal, as in 0.12. **Step-up** confirms who applies, by 0.11's rules per source: removing or renaming more than one entry, a bulk change of more than 25 entries or a draft that sets fields on more than 25 entries ask for `plant.bulkChange`, one rename for `plant.renameId`; assistants' proposals ask for none.

**History.** Every applied change set writes one row per entry it touched: the full values of the changed fields before and after, the revision reached, the change set, its author(s) and who applied it; a removal keeps the whole entry. Sites and assets have a **History** tab – the entry and what belongs to it (a site's hierarchy, buildings and OT network; an asset's assignment, checks, devices, data paths and collections), newest first, with the source and a link to the change set; for the time before 0.13 it links the entry's audit entries. History follows renames, survives the archiving of plant audit entries ([ADR 0017](adr/0017-audit-retention.md)) and is moved by migration packages with its entries; the history of a removed entry is deleted after 3 years by the daily clean-up. Values from collector files keep the redaction of [Gateway configurations](#gateway-configurations).

**Revert** – on an applied change set, or on one row of history – writes a **new draft** with the inverse operations, based on now: fields set back, an added entry removed, a rename renamed back (which removes the alias). A field changed again since conflicts instead of being overwritten. It is reviewed and applied like any change set and names the change set it reverts. Removed entries are restored in a later version.

**Import baselines.** Every import records, per entry it wrote, the values it left there (table `plant_import_baselines`). A later version uses them to flag fields changed in Steward since the last import (phase 2 of ADR 0020).

**Limits.** At most 200 operations per change set, 256 kB per operation (an import's files: its own limit), 20 open change sets per person and 8 MB of them together (`PLANT_CHANGESET_LIMIT`, `PLANT_CHANGESET_TOO_LARGE`). Rejected, withdrawn and expired change sets are deleted after 90 days; their audit entries stay.

**Audit.** The actions of before stay and carry `changeSetId` (`asset.updated`, `site.node_changed`, `plant.imported`, `plant.bulk_changed`, `plant.id_changed`, `plant.proposal_applied` …). New: `plant.change_set_created`, `_proposed`, `_returned`, `_resolved`, `_applied`, `_rejected`, `_withdrawn`, `_expired`, `site.review_changed` and `plant.catalogue_review_changed`. `plant.change_set_applied` carries the SHA-256 of the operations (`operationsSha256`) and of the history rows it wrote (`historySha256`, over the rows ordered by kind, scope and id): a history row changed in the database no longer matches the chained audit log.

**API** (internal, `/api/plant/…`):

| Route                                                                                                        | What                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `GET change-sets?box=drafts\|review\|applied\|closed\|mine&site=&source=`                                    | the inbox (`items`, `toReview`)                                                                               |
| `POST change-sets` `{ title, current }`, `GET` / `PATCH change-sets/:id` `{ title, current }`                | a new draft; one change set; rename it, make it the current draft                                             |
| `POST change-sets/:id/operations` (`:id` may be `current`), `PUT` / `DELETE change-sets/:id/operations/:seq` | `{ op: set \| add \| remove \| rename, kind, scope, id, value, revision }` or `{ op: import \| bulk, value }` |
| `POST change-sets/:id/preview`                                                                               | entries, problems, conflicts, `stale`, `fingerprint`, `stepUp`, `applyBlocked`, `review`                      |
| `POST change-sets/:id/propose \| withdraw \| return \| reject \| copy \| revert`                             | `return` and `reject` take `{ comment }`                                                                      |
| `POST change-sets/:id/resolve` `{ choices: [{ seq, path, choice: mine \| theirs }] }`                        | choices for conflicts                                                                                         |
| `POST change-sets/:id/apply` `{ fingerprint }`                                                               | applies (step-up by source)                                                                                   |
| `GET change-sets/open?kind=&scope=&id=` \| `?site=`                                                          | open change sets of an entry or a site                                                                        |
| `GET` / `PUT change-sets/settings` `{ catalogueReview }`                                                     | the policy level and the catalogue's switch                                                                   |
| `PUT sites/:siteId/review` `{ review }`                                                                      | the site's switch (step-up)                                                                                   |
| `GET history?kind=&scope=&id=&children=1`, `POST history/:id/revert`                                         | an entry's history; revert one row                                                                            |

An edit form's route saves into the person's draft when asked with the header `X-SM-Draft: 1` (who may propose but not manage). Change sets are not in `/api/v1` yet (phase 2); the entries there carry `revision`.

## Permissions

Rights are per site; the hierarchy, buildings and assets of a site follow it ([ADR 0006](adr/0006-owning-teams-policy-module.md)):

- **Without owning teams or access list**: every role that works in Steward (viewer, operator, approver, auditor, designer, administrator) sees the site; designers and administrators manage it (change it, its hierarchy, buildings and assets, import into it). Designers and administrators add sites.
- **Access list** (site page → _Access_, for who manages it; adding an entry asks for a step-up like other grants): only its entries get their rights – _view_, _propose_ or _manage_ – plus administrators; auditors always see.
- **Propose** (0.13.0, [Change sets](#change-sets)): keep drafts of changes and propose them – never apply. By default operators, approvers and plant viewers; managing a site includes it. Device profiles and KPI definitions belong to no site: whoever may propose for some site may propose changes to them. An AI assistant may propose with its owner's _propose_ right. `permissions` of a site lists _view_ and _manage_ as before; `canPropose` says whether the person may propose.
- **A second person** (0.13.0): where a site needs one (`plant.changeSet`), no author applies a change set – administrators included.
- **Owning teams**: as for other resources, members of the owning teams have their instance and team roles on the site.
- **Plant viewer** (`plant`): a new instance role that **sees only the plant registry** (sites that are not restricted) and their own profile. For a user whose only working role it is – no other instance role (a _status_ role adds the status pages) and no role in a team – the server refuses every other route (`403 PLANT_VIEWER_ONLY`), the public API answers only `/api/v1/plant/…` and `/api/v1/me`, the MCP endpoint refuses them, and the web app shows the _Plant_ area and the profile only. Linked systems and applications show by name, without a link; records, services and credentials that link to a site or asset are not listed. With another working role, they keep that role's access.
- **Status viewers** never see the module; nothing of it is shown on status pages.
- The **OT network** follows its site: who sees the site sees it, who manages the site changes it ([Rights](#rights-1)).
- **Device profiles and KPI definitions** belong to the installation: everyone who sees the registry sees them, designers and administrators manage them. An asset's **assignment and KPI instances** follow its site ([Rights](#rights)).

A site or asset that you may not see answers `404`, as if it did not exist; a link to it shows as "not visible".

## API

The internal API (the web app) is under `/api/plant/…` (since 0.13.0 also the [change sets](#change-sets) and `history`; entries carry `revision`, and an edit route answers `409 PLANT_ENTRY_CHANGED` for an older `revision` or `202` with `changeSet` where review is required): `sites`, `sites/:siteId` with `nodes`, `buildings`, `links` and `access`, `hierarchy`, `assets`, `assets/:assetId` with `image` and `links`, `import/preview`, `import`, `imports`, `export`, `schema`, `config`; since 0.11.0 `ids/rename/preview` and `ids/rename` (body `{ kind, scope, id, newId }`), `aliases` (`GET`, `DELETE aliases/:kind/:oldId?scope=`, administrators), `bulk/preview` and `bulk` (body `{ kind, action: edit | remove, items: [{ id, scope }], set, cascade }`); `assets/:assetId/assignment` (`GET`, `PUT`, `DELETE`), `profiles`, `profiles/:profileId` with `points/:pointId` and `duplicate`, `kpis`, `kpis/:kpiId` with `duplicate`, `explore/points?q=` and `checks`; `assets` also takes `profile` and `dataPoint`; the [visualizations](#visualizations) `views/overview`, `views/coverage`, `sites/:siteId/structure`, `assets/:assetId/flow`, `profiles/:profileId/points/:pointId/lineage` and `sites/:siteId/network/placement`, and the OT network `sites/:siteId/network` (the whole OT network of a site with every asset's live status and the systems the data paths name – one answer for a diagram), `sites/:siteId/vlans[/:vlanId[/segment]]`, `sites/:siteId/zones[/:zoneId]`, `sites/:siteId/conduits[/:conduitId]`, `assets/:assetId/network`, `assets/:assetId/devices[/:deviceId]`, `assets/:assetId/paths[/:pathId]` and `assets/:assetId/checks`; the switch and settings are `GET`/`PUT /api/settings/plant`.

The public, read-only API ([API.md](API.md), tag _Plant_):

- `GET /api/v1/plant/sites` – sites with counts (paginated);
- `GET /api/v1/plant/sites/{siteId}` – a site with its hierarchy, each node's building, its buildings, contacts, external references, own fields and links;
- `GET /api/v1/plant/assets?site=&node=&domain=&status=&tag=&ref=` – assets with location and external references (paginated); `ref=erp:10004711` finds an asset by another tool's id;
- `GET /api/v1/plant/assets/{assetId}` – an asset with equipment, lifecycle, capabilities and links;
- `GET /api/v1/plant/assets/{assetId}/assignment` – its device profile, firmware, interfaces with endpoints, differences, publications, KPI instances, checks and the KPIs it can have;
- `GET /api/v1/plant/profiles`, `GET /api/v1/plant/profiles/{profileId}` – device profiles with their effective interfaces and data points (inherited ones included, 0.11.0), their bases, assets and the KPI definitions that read them;
- `GET /api/v1/plant/kpis`, `GET /api/v1/plant/kpis/{kpiId}` – KPI definitions with inputs, parameters, columns, computation, checks, instances and candidates;
- `GET /api/v1/plant/assets?profile=&dataPoint=` – the assets that have a profile (and deliver one of its data points);
- `GET /api/v1/plant/checks?site=&asset=&kpi=&kind=` – the problems of [Checks](#checks) (paginated);
- `GET /api/v1/plant/sites/{siteId}/network` – the OT network of a site: VLANs (with the linked segment and the hint), zones, conduits (with the records that link to them), the devices and data paths of its assets and every asset's live status;
- `GET /api/v1/plant/assets/{assetId}/network` – an asset's devices, data paths, own checks and live status;
- `GET /api/v1/plant/assets/{assetId}/collections` – an asset's data collections with their items, mapping and coverage (0.11.0);
- `GET /api/v1/plant/export?site=|part=catalogue|profile=|kpi=&format=yaml|json` – the registry in the import format (with the OT network);
- `GET /api/v1/plant/advisories`, `GET /api/v1/plant/advisories/{advisoryId}`, `GET /api/v1/plant/assets/{assetId}/advisories` – security advisories with their matches at the sites the token owner may see (0.14, [ADVISORIES.md](ADVISORIES.md#api-and-assistants)).

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
