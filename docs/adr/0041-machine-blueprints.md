# 0041. Machine blueprints

- **Status:** Accepted
- **Date:** 2026-11-26
- **Since:** 0.30.0 (both steps)
- **Builds on:** [0034](0034-module-access.md) (who may use a module)

## Context

Device profiles describe what one device model delivers ([PLANT.md](../PLANT.md#device-profiles)). Nothing says what a **kind of machine** should deliver. A welding machine, a CNC milling machine or a compressor has data points one can reasonably expect – the energy drawn, the state, a fault code, a part counter – whatever the vendor calls them. Today nobody can ask: "Do we have everything advisable for a welding machine?"

What exists, and why it does not answer the question:

- A device profile has only a free-text `category` (`shared/src/plantData.ts`; `docs/plant/plant-registry-1.schema.json`). Assets have free-text domain, process area, role and tags (`shared/src/plant.ts`); ISA-95 node types are free text. Nothing is a controlled "kind of machine".
- **KPI potential and coverage** ([PLANT.md](../PLANT.md#kpi-coverage); the states are computed in `server/src/plant/views.ts`, "is it collected" in `server/src/plant/potential.ts`: `collectedPoints`, `isCollected`) compare an asset with KPI definitions: _Has it_, _Problem_, _Could have it_, _Collected – ready_, _Device delivers, not collected_, _Cannot_, _Not checked_. They start from a KPI, not from a kind of machine, and know nothing of data points no KPI uses.
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

The profile and asset pages (server: `GET /api/plant/profiles/:id/blueprints` and `…/assets/:id/blueprints`; web UI in a second task) show a coverage line per blueprint, for example "9 of 12 covered, 2 must missing", with the signals grouped by importance and state:

| State                    | Meaning                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Covered                  | mapped to a data point the profile has (asset: and collected, see below)                                                            |
| Profile lacks it         | no mapping; the profile has no matching data point                                                                                  |
| Profile has it, not here | the profile has it, but this asset does not collect it ([KPI coverage](../PLANT.md#kpi-coverage): _Device delivers, not collected_) |
| Not applicable           | marked with a reason                                                                                                                |
| Suggested                | a match exists by name; not yet confirmed (not counted)                                                                             |

The distinction between "the profile lacks it" and "the profile has it, but this asset does not collect it" is the same as in KPI potential and reuses its code (`collectedPoints` of `potential.ts`: the data points the asset's data collections map items to). A signal mapped to several data points is covered when every one of them is collected. An asset without a profile shows only direct blueprints.

### Exchange

A new **`blueprint:` / `blueprints:` document kind** in the plant YAML format 1 ([PLANT.md](../PLANT.md#yaml-import-and-export)), next to `device_profile:`, with the signals, importance and keywords; profile documents and an asset's `assignment:` gain `blueprints:` (ids), `blueprint_mappings:` and `blueprint_not_applicable:` (reason, with author and time kept from an export). The JSON schema (`docs/plant/plant-registry-1.schema.json`) and the export follow profiles. The plant registry has **no Git sync of its own** (an earlier draft of this record said so): the Git route is the export – `GET /api/v1/plant/export` – kept in a repository by a job ([PLANT.md](../PLANT.md#fetching-the-registry-from-other-tools)); blueprints are part of that export and import back unchanged. Names that lead nowhere (an unknown or hidden blueprint, signal or data point) give import warnings, not errors. A list given in a file replaces the stored list among the blueprints the importer may see; the others stay.

### Access

Blueprints follow device profiles: plant designers and administrators edit them; readers need only plant access. **Team scope** applies as for profiles: owning teams and shares; a reader never sees, counts or is told about a blueprint they may not see. Coverage on a profile or an asset shows only blueprints the reader may see, and a blueprint's counts name only profiles and assets they may see. Widening a blueprint's access needs a step-up and an access-change audit entry, as for profiles. Marking not applicable needs the right to edit the profile or the asset.

### Data model

One additive migration (`plant-033-blueprints`, SQLite and PostgreSQL, appended to the plant list in `server/src/migrations/plant.ts`): `plant_blueprints`, `plant_blueprint_signals`, `plant_blueprint_assignments` (blueprint, target kind `profile` or `asset`, target id), `plant_blueprint_mappings` (blueprint, target, signal, data point id) and `plant_blueprint_not_applicable` (blueprint, target, signal, reason, author, time). A mapping or mark of an asset holds for a blueprint the asset has directly or through its profile; blueprints are not inherited by profiles that extend one. All are classified in `server/src/migration/tables.ts`. Mappings name data points by id and follow the [id rename](../PLANT.md#changing-ids) of data points, profiles and assets (`server/src/plant/rename.ts`); removing a profile or an asset forgets its blueprint rows. Blueprint ids are not renamable in step 1. Deleting a blueprint is refused while assigned, as a profile in use is.

### Surfaces

- **API:** routes under `/api/plant/blueprints` (and `…/signals`) and on profiles and assets (`/api/plant/profiles/:id/blueprints`, `/api/plant/assets/:id/blueprints`, with `…/:blueprintId/signals/:signalId/mapping` and `…/not-applicable`); read-only in `/api/v1/plant` (`/plant/blueprints[/:id]`, `/plant/profiles/:id/blueprints`, `/plant/assets/:id/blueprints`); `docs/openapi.json` regenerated.
- **MCP:** read tools `list_machine_blueprints`, `get_machine_blueprint` and `get_blueprint_coverage` (a profile or an asset); no write tools in step 1.
- **Exports:** blueprints are part of the plant export (and so of the Git backup built on it).
- **Team scope:** a blueprint is a third catalogue kind (`blueprint`, like `device_profile` and `kpi_definition`) with owning teams, shares and Restricted scope through the shares core; widening it needs the same step-up and access-change entry. Unlike profiles and KPI definitions, hidden blueprints are not even counted (`GET /api/plant/catalogue/hidden` has no count for them).
- **Texts:** English and German; new error codes get both.
- **Audit** (entity type `blueprint`): `blueprint.created`, `.updated`, `.deleted`, `.assigned`, `.unassigned`, `.mapping_changed`, `.not_applicable_set`, `.not_applicable_cleared`.
- **Upgrade fixtures:** an instance of the previous release with sites, profiles, assets and a Git sync, upgraded and checked for unchanged plant pages, exports and coverage (no blueprints, no new lines), on SQLite and PostgreSQL (`test:pg`).

### Phasing

**Step 1 (0.30.0, the server first, the web UI in a second task):** blueprints and signals, assignment, mapping with suggestions, not applicable with a reason, coverage on the profile and asset pages, the YAML document kind and API, MCP read tools. Blueprints are written by hand or imported.

**Step 2 (0.30.0 as well, per the maintainer):** a **site-wide matrix** (assets by blueprint importance, in the style of the KPI coverage matrix); **links to KPI definitions** ("this KPI needs these signals"; KPI coverage then says which blueprint signal is missing); **assistant proposals** for mappings and blueprints; **shipped examples**: a few deliberately generic, high-level blueprints (welding machine, CNC milling machine, injection moulding machine, robot cell, compressor), described as generic starting points to adapt, not as a standard. Invented names only.

What step 2 shipped:

- **Matrix:** `GET /api/plant/views/blueprints` (filters site, area, profile, blueprint), built like `GET /api/plant/views/coverage`: rows are assets that have a blueprint, columns the blueprints, cells the totals per importance, with totals overall, per blueprint, per site and area. It is in the web app (Explore the data, a link on the site tiles) and – like the KPI matrix, which has no public API or MCP tool – not in `/api/v1` or MCP. Team scope: only blueprints, profiles and assets the reader may see are columns, rows or counted.
- **KPI links:** the link is on the **signal** (`plant_blueprint_signals.kpis`, a JSON list of KPI definition ids, additive migration `plant-034-blueprint-signal-kpis`), not on the KPI definition. A KPI definition is an entry with revisions and baselines in change sets, inputs resolved per profile and many readers; a second list there would touch all of them, and it would have to follow blueprint renames and deletions as well. A signal is a flat row we own, one signal feeds several KPIs, and the author of a blueprint knows what a signal is for. Links follow KPI id renames, never make a KPI definition visible to someone who may not see it (a hidden link is not shown, not counted and kept when others save), and are advice: KPI coverage cells that are _cannot_ (or _could_ but not collected) carry `blueprintGaps`, and the KPI page lists the signals that feed it; no state changes.
- **Proposals:** blueprints, signal mappings and KPI links ride in the existing proposal document (the plant import format). The import preview now lists them as entries (`blueprint`, `blueprint_use`), so they count, are shown to the reviewer, belong to the fingerprint, and a blueprint change is a catalogue change under review. Accepting runs the import with the reviewer's rights, so access is checked at accept time. Not-applicable marks and dropping items from lists are refused in proposals; blueprints are no change-set entries (no revisions or baselines), so a draft in Plant → Changes does not track them.

## Alternatives considered

- **Free-text `category` plus required tags.** Cheap, but a tag has no meaning, no importance, no reason and no "not applicable"; "required" would be a convention in people's heads and could not be checked or exchanged.
- **Inheritable abstract profiles** (a template that says what must exist). Inheritance copies what a base _has_ into every derived profile, so a signal one device cannot deliver would still appear, and a profile has only one base. Blueprints must be advice that a profile may meet partly, with reasons, and several per profile.
- **Adopt a standard vocabulary as the model** (OPC UA companion specifications, ECLASS, VDMA references). They are precise and widely known, but large, partly licensed or paid, change on their own schedule, and describe more than a high-level checklist needs; adopting one would also tie the model to its structure. We want a light list that a plant designer can write in an hour. A blueprint's **reference** field names the standard it was drawn from, so a team can align by hand, and a later import from an open specification is not ruled out.
- **Status quo.** Profiles stay unchecked against any expectation; gaps are found when a KPI needs a data point.

## Consequences

- Plant designers can write down what they expect of a kind of machine once, and see per profile and per asset what is missing, what is only not collected, and what was decided not to apply. "Not applicable" keeps the list honest instead of teaching people to ignore a red number.
- Suggestions save typing without letting a name match pass as coverage.
- Harder: one more concept next to profiles, KPIs and assets; mappings and marks must follow id renames and deletions; blueprints can drift from reality, so version and reference are shown. Team scope needs a test for every count.
- Not done: inheritance, enforcement (a blueprint never blocks a save), data types and units in blueprints, importing standards, the matrix in the public API and MCP, blueprints as tracked entries in change-set drafts (a proposal carries them), and a KPI link as a condition (it only informs).
- Revisit if few blueprints get written (the shipped examples would then move into step 1), or if people ask for enforcement or for a standard vocabulary.
