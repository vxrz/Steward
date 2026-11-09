# 0019. Data collections: what a collector reads, mapped to data points

- **Status:** Accepted
- **Date:** 2026-11-08
- **Since:** 0.11.0 – part of the plant registry (preview, [0007](0007-plant-registry.md))

## Context

The plant registry documents what an asset's interfaces deliver (device profiles, data points, assignments) and where its data goes (data paths). What is missing is the layer in between: **what a gateway or ETL job actually reads** from an asset – which addresses, how often, under which name, with which transformation, and where it loads the result. That knowledge lives in the configuration files of the collectors (a gateway's JSON, an Industrial Edge connector export, a Node-RED flow, a spreadsheet). People want to keep it next to the asset, see which documented data points are collected and which are not, and find out what a collector may write to a machine.

Two facts shape the model:

- A **gateway's variable names are free-form** (`Spindle_speedActSP1`, `NCProgram`), while the profile's data points follow conventional ids and names.
- **Addresses cannot be the key on the profile level.** Two assets of the same kind may deliver the same data point (the NC program name) under different addresses.

Steward's job here is documentation. It does not read devices or run collectors.

## Decision

**Three layers, kept apart.**

1. The **profile data point** is the canonical thing: a conventional id and name, an optional default address, and **known-as names** (`aliases`: names tools commonly use for it).
2. The **asset's binding** is the concrete address of that data point on this asset: the assignment's override (`overrides[].address`). An asset's **resolved address** of a data point is the override's address, else the profile's.
3. The **collection item** is what the collector calls the value (its output name) and the address it reads, **linked explicitly** to one data point of the asset's model (`dataPoint`), or left unmapped – documented as **raw** and flagged in the coverage.

**A data collection** (table `plant_collections`, migration `plant-006-collections`, additive) belongs to an asset and to a **collector** – a Steward application, platform or process, or a job elsewhere by name, as a data path's collector – and optionally to a data path of the asset. It reads from one interface of the asset's model (or an unknown interface) and has a name, a **mode** (`interval`, `on_change`, `trigger`, `other`), interval and debounce (ms), **triggers** (name, condition, reference data point, reference value) and a composition note, a **destination** (a Steward system with a path, a Steward dataset, a publication target, or text), the collector's **access patterns** (read, write, create, delete address patterns – write, create and delete are shown prominently: they are what the collector may change on the machine), buffering and other settings as key/values, and **items**: the address read, the output name and type, the linked data point (or none), an optional transform (a note, plus optional structured `scale`, `offset`, `cast`) and notes. The importer's name and the source file's name are kept for the record.

**Mapping on import**, per asset and collector, in this order; each suggestion carries its reason and a confidence and is shown in the preview:

1. a line of an uploaded **mapping file** (`gateway_name` or `address` → `data_point`);
2. a **remembered mapping** from an earlier import of this collector for this asset (table `plant_collection_mappings`: confirmed `gateway name → data point` pairs per asset and collector; a pair stored for the collector without an asset is a **collector alias**, valid for every asset the collector reads);
3. the item's address equals the **asset's resolved address** of a data point – both normalised: whitespace removed, `[u1, 1]` read as `[u1,1]`, case ignored where the protocol ignores it (Modbus, PLC and CNC variable paths; not OPC UA NodeIds, whose string identifiers are also compared on their own);
4. the gateway name equals the data point's id, name or one of its known-as names, or a collector alias (case and separators ignored);
5. a **fuzzy** name suggestion – never applied without confirmation.

The person confirms or changes each match in the preview, with bulk actions (accept every exact match; accept everything above a confidence). Confirming can also, as boxes in the preview with a summary of what they write:

- record the item's address as the **asset's address** of the data point (the assignment's override), where the asset has none or another one – this is how per-asset addresses get documented from real gateway configurations;
- remember the gateway name as a **known-as name** of the profile's data point (needs the right to manage device profiles) or only as a **collector alias**;
- for an unknown address, **add it as an asset addition** (0.11.0, [0007 – Update 0.11](0007-plant-registry.md#update-011-profile-inheritance-and-asset-additions)), with the gateway name as a known-as name and a conventional id to fill in.

Every confirmed pair is remembered for the asset and collector, so a re-import needs no new work. A **mapping file** in CSV or YAML can be uploaded with an import, and a collection's page exports its current mapping in that format.

**Coverage.** A collection's page counts **mapped** items (linked to a data point of the asset's model), **raw** items (no link: an unknown address, or a data point that no longer exists) and the data points of its interface (or of the whole model) that **no collection of the asset reads**. Two items mapped to one data point within one collection are allowed and flagged. A data point's lineage and the asset's data flow run through the collections: data point → collection (collector) → destination.

**Importers** (`server/src/plant/collections-import.ts`), each producing collections for one asset and one collector, previewed before they are applied, recognised by **structure**, never by product names or the value of a `type` key:

- **Gateway JSON – datasets of data points:** `datasets[]` with `datapoints[]` that have addresses; one dataset is one collection; the access patterns, whitelisted addresses and buffer and event settings become the collector's access patterns and settings.
- **Generic CSV or YAML:** one row (or entry) per item with `collection, mode, interval_ms, debounce_ms, source_address | data_point, output_name, output_type, transform, destination, notes`.
- **Industrial Edge OPC UA connector** (preview): the connector's exported configuration (`UIConfig.datapoints.OPCUA[]` with `tags[]`: name, address, data type, acquisition cycle and mode, access mode); one collection per connection, cycle and mode; the Databus is the destination. Sign-in data in the export (user, password, certificate passwords) is never read.
- **Node-RED flow export:** source nodes (OPC UA, S7, Modbus, MQTT in, inject with a read node) are followed along their `wires` to sink nodes (MQTT out, HTTP request, database and file nodes; `debug` is ignored); every source → sink chain becomes items of a collection, and `function`, `change` and `template` nodes on the way become transform notes (their names, and the rules of a `change` node) – code is never run. Node-RED credentials are never imported.

**Rights and audit as for data paths.** Collections follow the asset's site: who sees the site sees its collections; who manages it changes and imports them. A known-as name on a profile needs the catalogue right. Every change is audited (`plant.collection_created|updated|deleted|imported`, with the counts of what an import wrote); the public API reads them like data paths (`GET /api/v1/plant/assets/{assetId}/collections`).

## Consequences

- An asset's page answers "what does the gateway read, and what does it call it", the collector's page "which collections does it run", a data point's page "who reads it, under which name".
- Per-asset addresses get documented as a side effect of importing real configurations, without touching the profile.
- A remembered mapping can go stale when a gateway renames a variable; the next import shows it as unknown and asks again.
- The importers read what their files say; a format that changes (the Industrial Edge export especially) may need an importer update. The Industrial Edge importer stays _preview_ until it has seen more exports than the public example it was built from.
- Steward does not check that a collector really reads what is documented; that would need access to the collector and is out of scope.

## Update 0.12: proposals from assistants

**Since:** 0.12.0.

- An AI assistant can read an asset's collections, their items and coverage through MCP, and propose changes to the registry for a person to apply ([ADR 0007 – Update 0.12](0007-plant-registry.md#update-012-inherited-descriptions-and-proposals-from-assistants)). For collections it proposes the profile layer and the asset layer of the three layers: known-as names of data points (a gateway's names) and the asset's addresses (overrides). Collections themselves are not part of the plant import format yet; they are still imported by a person from the collector's configuration.
- Collections are planned to join the format, and with it assistants' proposals, in 0.12, after the work on documents, gateway sources and sinks of collections. The same rules will apply: a person applies, nothing is removed or renamed, no item is dropped.
- A collection and each of its items have an optional description (migration `plant-008-collection-description`); the table format reads a `description` column.
