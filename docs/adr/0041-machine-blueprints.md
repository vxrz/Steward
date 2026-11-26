# 0041. Machine blueprints

- **Status:** Proposed
- **Date:** 2026-11-26
- **Since:** 0.30.0 (step 1); step 2 not scheduled
- **Builds on:** [0034](0034-module-access.md) (who may use a module)

## Context

Device profiles describe what one device model delivers ([PLANT.md](../PLANT.md#device-profiles)). Nothing says what a **kind of machine** should deliver. A welding machine, a CNC milling machine or a compressor has data points one can reasonably expect – the energy drawn, the state, a fault code, a part counter – whatever the vendor calls them. Today nobody can ask: "Do we have everything advisable for a welding machine?"

What exists, and why it does not answer the question:

- A device profile has only a free-text `category` (`shared/src/plantData.ts`; `docs/plant/plant-registry-1.schema.json`). Assets have free-text domain, process area, role and tags (`shared/src/plant.ts`); ISA-95 node types are free text. Nothing is a controlled "kind of machine".
- **KPI potential and coverage** ([PLANT.md](../PLANT.md#kpi-coverage), `server/src/plant/potential.ts`) compare an asset with KPI definitions: _Has it_, _Problem_, _Could have it_, _Collected-ready_, _Device delivers, not collected_, _Cannot_, _Not checked_. They start from a KPI, not from a kind of machine, and know nothing of data points no KPI uses.
- The **checks of KPI inputs** ([PLANT.md](../PLANT.md#checks), `server/src/plant/checks.ts`) and the site **Documentation** tab ([PLANT.md](../PLANT.md#documentation-health)) list gaps, but only gaps of documentation and wiring.
- **Profile inheritance** and template profiles ([PLANT.md](../PLANT.md#profile-inheritance)) share data points between profiles. A base says what a profile _has_, not what it _should_ have; an inheritor gets every data point, wanted or not.

The maintainer wants a high-level reference per kind of machine – names and meanings, no data types – to check profiles and concrete assets against. It is advice, not a schema, and not inheritance.

## Decision

Add **machine blueprints** to the plant module: a checklist per kind of machine, compared with profiles and assets. A blueprint never changes a profile or an asset; it only reports what is covered and what is missing.

### Model

A **blueprint** has a name, a description, an optional **reference** (a standard, or "own experience"), a version and a list of **expected signals**. A signal has:

- a **name** and a **meaning** (what it tells; no data type, no unit, no address);
- **why it matters**: any of _quality_, _energy_, _availability_, _maintenance_, _safety_, _traceability_;
- an **importance**: _must_, _should_ or _nice to have_ (decided);
- **known-as names and keywords**, used only for suggestions.

A blueprint may also list **expected KPI definitions** (by id), shown as advice; see step 2.

### Assignment

One or more blueprints per **device profile**; an asset gets them through its profile, and may also have blueprints **directly** (a machine whose profile is generic, or a profile for several kinds). Assignment is advice: it needs no step-up and is not checked against `category`. A template profile can carry blueprints; the flag is not inherited, as `template` is not.

### Matching

Matching is **explicit**: a **mapping** from a blueprint signal to a data point of the profile (resolved, so inherited data points count) or, for an asset-level blueprint, to a data point of the asset's data ([PLANT.md](../PLANT.md#asset-additions)). One signal may map to several data points (three phases), one data point may serve several signals.

Steward **suggests** mappings by name, known-as name and keyword. A suggestion is shown, never counted; only a mapping a person confirmed (or accepted from a proposal) counts. Assistants may later propose mappings through the existing reviewed change sets ([PLANT.md](../PLANT.md#proposals-from-assistants)); they cannot confirm them.

A profile or an asset can mark a signal **not applicable, with a reason** (free text, required). It then does not count as missing, is shown with its reason, author and time, and is audited. A mark on the profile holds for its assets; an asset may add its own.

### Coverage

The profile and asset pages show a coverage line per blueprint, for example "9 of 12 covered, 2 must missing", with the signals grouped by importance and state:

| State                    | Meaning                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Covered                  | mapped to a data point the profile has (asset: and collected, see below)                                                            |
| Profile lacks it         | no mapping; the profile has no matching data point                                                                                  |
| Profile has it, not here | the profile has it, but this asset does not collect it ([KPI coverage](../PLANT.md#kpi-coverage): _Device delivers, not collected_) |
| Not applicable           | marked with a reason                                                                                                                |
| Suggested                | a match exists by name; not yet confirmed (not counted)                                                                             |

The distinction between "the profile lacks it" and "the profile has it, but this asset does not collect it" is the same as in KPI potential and reuses its code. An asset without a profile shows only direct blueprints.

### Exchange

A new **`blueprint:` document kind** in the plant YAML format 1 ([PLANT.md](../PLANT.md#yaml-import-and-export)), next to `device_profile:`, with the signals, importance and keywords; profile documents gain `blueprints:` (ids) and `blueprint_mappings:`, `blueprint_not_applicable:`. The JSON schema (`docs/plant/plant-registry-1.schema.json`) and the Git sync follow profiles: a blueprint is exported, synced and imported like one. Unknown or missing ids give the usual import warnings.

### Access

Blueprints follow device profiles: plant designers and administrators edit them; readers need only plant access. **Team scope** applies as for profiles: owning teams and shares; a reader never sees, counts or is told about a blueprint they may not see. Coverage on a profile or an asset shows only blueprints the reader may see, and a blueprint's counts name only profiles and assets they may see. Widening a blueprint's access needs a step-up and an access-change audit entry, as for profiles. Marking not applicable needs the right to edit the profile or the asset.

### Data model

One additive migration (SQLite and PostgreSQL, appended to the end of the list; `server/src/migrations/`): `plant_blueprints`, `plant_blueprint_signals`, `plant_blueprint_assignments` (profile or asset), `plant_blueprint_mappings` (assignment, signal, data point id) and `plant_blueprint_not_applicable` (assignment, signal, reason, author, time). All are classified in `server/src/migration/tables.ts`. Mappings name data points by id and follow the [id rename](../PLANT.md#changing-ids) like KPI definitions do. Deleting a blueprint is refused while assigned, as a profile in use is.

### Surfaces

- **API:** routes under `/api/plant/blueprints` and on profiles and assets; read-only in `/api/v1/plant`; `docs/openapi.json` regenerated.
- **MCP:** read tools for blueprints and for the coverage of a profile or an asset; no write tools in step 1.
- **Exports:** blueprints are part of the plant export and the Git sync.
- **Texts:** English and German; new error codes get both.
- **Audit:** `blueprint.created`, `.updated`, `.deleted`, `.assigned`, `.mapping_changed`, `.not_applicable_set`.
- **Upgrade fixtures:** an instance of the previous release with sites, profiles, assets and a Git sync, upgraded and checked for unchanged plant pages, exports and coverage (no blueprints, no new lines), on SQLite and PostgreSQL (`test:pg`).

### Phasing

**Step 1 (0.30.0):** blueprints and signals, assignment, mapping with suggestions, not applicable with a reason, coverage on the profile and asset pages, the YAML document kind and API, MCP read tools. Blueprints are written by hand or imported.

**Step 2 (later):** a **site-wide matrix** (assets by blueprint importance, in the style of the KPI coverage matrix); **links to KPI definitions** ("this KPI needs these signals"; KPI potential could then say which blueprint signal is missing); **assistant proposals** for mappings and blueprints; **shipped examples**: a few deliberately generic, high-level blueprints (welding machine, CNC milling machine, injection moulding machine, robot cell, compressor), described as generic starting points to adapt, not as a standard. Invented names only.

## Alternatives considered

- **Free-text `category` plus required tags.** Cheap, but a tag has no meaning, no importance, no reason and no "not applicable"; "required" would be a convention in people's heads and could not be checked or exchanged.
- **Inheritable abstract profiles** (a template that says what must exist). Inheritance copies what a base _has_ into every derived profile, so a signal one device cannot deliver would still appear, and a profile has only one base. Blueprints must be advice that a profile may meet partly, with reasons, and several per profile.
- **Adopt a standard vocabulary as the model** (OPC UA companion specifications, ECLASS, VDMA references). They are precise and widely known, but large, partly licensed or paid, change on their own schedule, and describe more than a high-level checklist needs; adopting one would also tie the model to its structure. We want a light list that a plant designer can write in an hour. A blueprint's **reference** field names the standard it was drawn from, so a team can align by hand, and a later import from an open specification is not ruled out.
- **Status quo.** Profiles stay unchecked against any expectation; gaps are found when a KPI needs a data point.

## Consequences

- Plant designers can write down what they expect of a kind of machine once, and see per profile and per asset what is missing, what is only not collected, and what was decided not to apply. "Not applicable" keeps the list honest instead of teaching people to ignore a red number.
- Suggestions save typing without letting a name match pass as coverage.
- Harder: one more concept next to profiles, KPIs and assets; mappings and marks must follow id renames and deletions; blueprints can drift from reality, so version and reference are shown. Team scope needs a test for every count.
- Not done: inheritance, enforcement (a blueprint never blocks a save), data types and units in blueprints, importing standards, the site matrix and KPI links (step 2).
- Revisit if few blueprints get written (the shipped examples would then move into step 1), or if people ask for enforcement or for a standard vocabulary.
