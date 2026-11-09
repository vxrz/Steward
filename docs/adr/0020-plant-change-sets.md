# 0020. Plant change sets: one path for every change to plant data

- **Status:** Accepted – **Phase 1 implemented in 0.13.0** (see [Phase 1 as implemented](#phase-1-as-implemented-0130)); phase 2 open
- **Date:** 2026-11-09
- **Since:** 0.13.0 – part of the plant registry (preview, [0007](0007-plant-registry.md))

## Context

Steward is the **source of truth** for plant data: people maintain it mostly by hand in Steward, and imports are loads and syncs into it (owner decision for 0.13). The theme of 0.13 is **one change path**. Today plant data changes in six ways, each with its own preview, rules and audit:

| Path                                                                                                                                                                                | Preview                                                                                     | Apply                                                                              | Step-up                                                                          | Audit                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Edit forms: entry pages, and since 0.12 in place on the site's _Devices_ and _Data paths_ tabs and _Move to…_ – all through the entry's `PUT` route (`PUT /api/plant/assets/:id` …) | none                                                                                        | at once, last write wins; a hand edit keeps the entry's `import_id` (`keepSource`) | none                                                                             | per kind (`asset.updated`, `site.node_changed` …) with the changed fields' old and new values |
| File import (`import.ts`)                                                                                                                                                           | a dry run in a rolled-back transaction (`dryRun`); since 0.12 field by field (`diff.ts`)    | **computed again** from the files: nothing ties it to the preview the person saw   | `plant.bulkChange` for more than one removal or rename, `plant.renameId` for one | `plant.imported`: mode, counts, files and SHA-256, at most 200 ids per action – no values     |
| Bulk change (`bulk.ts`; since 0.12 also _Edit selected_ on the site's _Devices_ tab)                                                                                                | changed, skipped, refused                                                                   | computed again                                                                     | `plant.bulkChange` for more than one removal or more than 25 edits               | `plant.bulk_changed` / `plant.bulk_removed`: the set values and up to 150 entries             |
| Change id (`rename.ts`)                                                                                                                                                             | references counted in a dry run                                                             | the rename core                                                                    | `plant.renameId` (off by default)                                                | `plant.id_changed`, `plant.ids_changed`                                                       |
| Assistant's proposal (`proposals.ts`, 0.12)                                                                                                                                         | the import's preview, stored with a **fingerprint**; a changed preview needs a confirmation | the import core, refused when the fingerprint differs (`PLANT_PROPOSAL_CHANGED`)   | none (a proposal never removes or renames)                                       | `plant.proposal_created`, `_applied`, `_rejected` with counts and the document's SHA-256      |
| Collection import (`collections-import.ts`)                                                                                                                                         | its own preview                                                                             | its own transaction                                                                | none                                                                             | `plant.collection_imported`                                                                   |

What follows from that:

- **No concurrency control.** Two people editing the same device overwrite each other silently; an import or bulk change applies what it computes at that moment, not what was previewed.
- **Only managers can change anything.** Rights are `view` and `manage` per site. People who know the data best cannot suggest a correction; even an assistant may only propose for a token owner who manages a site (`plantManagesSome`).
- **No second person.** The token owner may apply their own assistant's proposal (`mayAccept` does not exclude them); people's changes are never reviewed. The assurance policy knows four-eyes ([ASSURANCE.md](../ASSURANCE.md)), but no plant control point uses it.
- **Imports cannot tell an edit in Steward from stale data.** A record remembers only the last import that wrote it (`import_id`, kept on hand edits). An _update_ import silently overwrites a correction made in Steward.
- **History is scattered.** Single edits carry old and new values in the audit log; imports, bulk changes and proposals carry ids and counts. Plant audit entries may leave the database after archiving ([ADR 0017](0017-audit-retention.md)), the 0.12 diff is shortened for display (`PLANT_DIFF_LIMITS`), and nothing can be undone.

## Decision

### 1. One change-set pipeline

A **change set** is a list of operations against a base, with one preview, one review, one transactional apply, one history and one audit trail. Every path above produces one; only the source of the operations differs.

**Operations**, one entry each (kind, scope, id as in `PlantEntryRef`): `set` – fields of an entry, per path of `fieldDiff` (`description`, `overrides[prog_name].address`) the **base** value seen and the new value, plus the entry's **base version**; `add` – a new entry; `remove` – with `cascade` as in the removal core; `rename` – through the rename core; `mark` – _not in source_. An operation is **authored** (a person or a form made it; its intent is the field values) or **derived** (compiled from import files or an assistant's document; its intent is the document). This decides what happens when the base changes (section 3).

**States:** `draft` (its authors change it freely) → `proposed` (frozen, reviewers see it) → `applied`, `rejected`, `withdrawn` or `expired`. A rejected change set can be copied into a new draft. Drafts expire after 30 days without a change, proposed change sets after 14 days, as AI requests do.

**One apply core** (`server/src/plant/changesets/`, new): in one transaction it checks rights and versions, runs the model rules of the edit forms and the import, writes through the existing upserts (which bump the version), calls the removal and rename cores, and writes history (section 4) and audit. The preview is the same code in a rolled-back transaction (`dryRun`).

**The existing paths:**

- **Edit forms** – the entry pages, the in-place forms of the _Devices_ and _Data paths_ tabs and _Move to…_ – keep their routes, bodies and audit actions. Each save becomes a change set of one operation, created and applied in one request (source `edit`), or written into a draft where review is required (section 2). On sites without review they apply at once, as today.
- **File import:** format 1, modes, id mapping, `remove:`, limits and `plant.imported` stay. `compute()` returns operations instead of `Write` closures; `applyWrites` becomes the apply core. `POST /api/plant/import` takes the preview's `fingerprint` and refuses a different result (`PLANT_IMPORT_CHANGED`); without it (scripts) it applies as today.
- **Bulk change** (lists and the _Devices_ tab): compiles into `set` and `remove`; the same fingerprint rule.
- **Change id:** a `rename` operation; an import's id mapping produces them too.
- **Assistants' proposals:** the MCP tool and its refusals (no removal, rename, dropped item or credential) stay. A proposal is stored as a proposed change set (source `assistant`) linked to its MCP request instead of `plant_proposals`, and shows both under _AI requests_ and under _Plant → Changes_. Pending proposals are converted once at the upgrade.
- **Collection import:** phase 2.

Every existing audit action stays and gains `changeSetId`; `plant.change_set_*` entries are new. Readers of the audit log see what they saw before.

**API** (internal, `/api/plant/…`): `GET change-sets?state=&site=&source=&mine=1`; `POST change-sets` (a draft, optionally `from: { import | bulk | rename }` with today's bodies); `GET` / `PATCH change-sets/:id`; `POST …/operations`, `PUT` / `DELETE …/operations/:seq`; `POST …/preview` (the 0.12 diff, problems, checks, drops, staleness, conflicts, who may apply, whether a step-up is due, the fingerprint); `…/propose`, `…/withdraw`, `…/resolve` (per conflicting field `mine`, `theirs` or a value), `…/apply` (`{ fingerprint }`), `…/reject` (`{ comment }`), `…/revert`; `GET history?kind=&scope=&id=`. The existing write routes stay as shortcuts that create and apply in one request; where review is required they answer `202` with the change set – also for API tokens, so a nightly sync into a reviewed site becomes a proposal instead of failing.

**Options considered.** (A, chosen) Operations as the one model, documents compiled into them: one apply core, history and concurrency rule; cost: the largest refactor (`import.ts` is 1,535 lines of closures). (B) Generalise the 0.12 proposal – store the input and recompute, guarded by a fingerprint: little code, but no field-level merge for people's drafts and no values in history. (C) A shared review inbox on top of the existing paths: fast, but every path keeps its own rules.

### 2. Drafts and proposals by people; four-eyes; step-up

**Who may propose.** A new site permission `propose` between `view` and `manage` (`PLANT_PERMISSIONS`: `view`, `propose`, `manage`), by default for **operators, approvers and plant viewers**; access lists and owning teams change it as for the other rights. It lets a person keep drafts and propose them – never apply. Device profiles and KPI definitions belong to no site: whoever may propose for some site may propose changes to them; designers and administrators apply them. An assistant may propose with `propose` instead of `manage`. Rejected: everyone who sees a site (auditors and viewers too); only through access lists (nobody would use it without set-up).

**A second person.** A new control point `plant.changeSet` in the assurance policy (group `catalogue`, four-eyes `off` / `optional` / `required`, **default off**: nothing changes on upgrade). With `optional` each site has its own switch _Changes need a second person_ (column `review` on `plant_sites`, set by who manages the site with a step-up as for access grants, never in the import format – an import cannot switch it off), and the catalogue has one in the plant settings. A change set touching several sites needs review if one does. Where review is needed, **everybody's** changes go through a draft, managers' too.

**Who may apply.** Applying needs `manage` on every site touched (and the catalogue right for profiles and KPI definitions), as importing does today. Reviewers see only the operations of sites they see (as `forReader` does for proposals). Under review, no **author** applies: the creator, everyone who changed an operation and, for an assistant's proposal, the token owner – **administrators included**, as for records (`record.approve`). Without review, a token owner keeps applying their own assistant's proposals, as in 0.12. The settings page warns when a site with review has fewer than two people who may apply. Rejected: letting administrators apply their own (the second person would be optional for the most powerful role); self-applying small change sets under review (a threshold invites splitting).

**Step-up.** It confirms the person who **applies**, computed at apply time from the stored operations (route config `stepUp.when`, as the import does with `importPointsOf`); it is separate from four-eyes. 0.13 **keeps 0.11's rules per source**: removing or renaming more than one entry → `plant.bulkChange`; one rename → `plant.renameId`; a bulk-style change set (source `bulk`, or a draft that sets fields on more than 25 entries) → `plant.bulkChange`; assistants' proposals as today. A refactor changes no control, and token imports keep working. Rejected for now: one rule "more than one removal or rename" (loosens bulk edits); one rule including more than 25 changed entries (every large sync would ask, token imports would fail with `403`).

### 3. Conflicts and staleness

**A version per entry.** The 14 entry tables (`plant_sites` to `plant_collections`; sinks are a column of a collection) get `version INTEGER NOT NULL DEFAULT 1`. Every write through the upserts of `model.ts`, `data-model.ts`, `network-model.ts` and `collections-model.ts` adds one; a write that changes nothing does not. Rejected: `updated_at` as the token (an import writes many entries with the same time); a hash of the entry's values (needs a canonical form per kind and a hash per entry per preview).

**Edit forms.** The entry carries `version`; a form sends it back. When it differs, the save is refused with `409 PLANT_ENTRY_CHANGED` and, per field, the loaded value, the value now and the person's value; the form offers _Keep mine_ or _Take theirs_ per field. A body without `version` (scripts) writes as today.

**A change set whose base changed.** The preview compares each operation's base version with now. **Authored operations** merge field by field, three ways – **base** (what the author saw), **theirs** (now), **mine**: a field only one side changed takes that side; both to the same value is fine; both differently is a **conflict**, resolved in the draft or by the reviewer and recorded with the change set. A removed entry conflicts with every operation on it; a renamed one is followed (old ids are aliases). **Derived operations** are compiled again from their document, as the 0.12 proposal does. Either way the fingerprint changes, and applying needs the fingerprint of the preview the applier saw (`PLANT_CHANGESET_CHANGED`). Nothing is locked: several drafts may touch one entry; the entry page shows them, and the second applied is merged as above.

**Imports versus edits in Steward.** The import preview flags, per field, **changed in Steward since the last import** – Steward's value differs from what the last import wrote there – and offers _Keep Steward's_ (the **default**: Steward is the source of truth) or _Take the file's_, per field and for all. Unflagged fields follow the mode as today. This needs the value an import last wrote per field, kept in **one table** `plant_import_baselines (kind, scope, entry_id, values, import_id, updated_at, PRIMARY KEY (kind, scope, entry_id))`, `values` mapping each path an import wrote to the value and the import:

- **Cost.** One row per imported entry, about the size of the imported data (a site of 2,000 assets: a few MB). SQLite: one indexed read per kind for a preview, one upsert per written entry in the import's transaction. PostgreSQL: the same; text over 2 kB is compressed out of line (TOAST); reads and writes are batched per kind, because every statement crosses the PG bridge ([ADR 0001](0001-synchronous-db-layer-with-pg-bridge.md)). Lists (`SELECT * FROM plant_assets`) never read it.
- **Upkeep.** The rename and removal cores maintain it; the rename test that walks the schema (`REFERENCES` in `rename.ts`) fails when a column is forgotten.
- **Rejected:** a JSON column on each of the 14 tables (no join, and adding it is a schema change only on SQLite and PostgreSQL 11+, but every list query carries it and 14 columns need upkeep); a hash per path (smallest, but cannot show what the file said last time).

Baselines are **recorded from phase 1**; the flags come in phase 2.

### 4. History and undo

**History per entry.** A new table `plant_entry_history (id, kind, scope, entry_id, version, change_set_id, op, at, by, applied_by, before, after)` gets one row per entry an applied change set touched: the **full** values of the changed fields before and after (not the shortened display values), the version reached, the change set, its author and who applied it. A removal keeps the whole entry and what went with it. The screen diff is computed with `fieldDiff`. The entry columns follow renames (listed in `REFERENCES`); the values stay as they were.

The entry page gets a **History** tab: when, author and reviewer, the change set (title, link), the source (edit, import with its files, bulk, rename, assistant, revert) and the fields that changed. For the time before 0.13 it links the entry's audit entries (old ids are aliases).

**Undo never rewrites history.** _Revert_ on an applied change set, or on one history row, creates a **new draft** with the inverse operations, based on now – later edits conflict instead of being overwritten: `set` back to the before values, `remove` of an added entry, `rename` back (which removes the alias, as today), `add` from a removal's snapshot (phase 2). It is reviewed and applied like any change set and names the change set it reverts.

**Tamper evidence.** `plant.change_set_applied` carries the SHA-256 of the operations and of the history rows written, so a history row changed in the database no longer matches the chained audit log ([ADR 0003](0003-hmac-chained-audit-log.md)).

**New compared with the audit log:** field-level before and after for imports, bulk changes and proposals; versions; one change set tying draft, review and apply together; author and reviewer apart; undo; and history that stays when plant audit entries are archived and deleted (they are not in `KEPT_ON_DELETE_SQL`).

**Retention.** History stays while its entry exists; that of removed entries is deleted by the daily clean-up after **3 years** (a plant setting). Rejected, withdrawn and expired change sets are deleted after 90 days; their audit entries stay. Baselines go with their entry. History and baselines move with their entries in migration packages; open change sets do not, as MCP requests do not.

### 5. UI and UX

- **Where changes live.** _Plant → Changes_: _My drafts_, _To review_ (with a count), _Applied_, _Closed_. Assistants' proposals are there and under _AI requests_; both open the same review page. Site and entry pages show a chip _2 open changes_; an entry in the person's own draft shows _Changed in your draft_. Rejected: everything in _AI requests_ (people's work is not an AI request); only the per-site chip (no overview for reviewers).
- **Editing in a draft.** Where review is required, or the person may propose but not manage, every edit form saves into the **current draft**: the entry pages' forms, the in-place forms on the site's _Devices_ and _Data paths_ tabs and _Move to…_. A bar at the bottom of plant pages names the draft, counts its changes and offers _Review and propose_; the person can switch drafts or start one. Pages show the draft's values with a marker and a switch _As in Steward / With my draft_. _Edit selected_ (the lists and the _Devices_ tab) and the import's last step offer _Add to draft_ or _Propose_ instead of _Apply_.
- **Review page.** The 0.12 preview grouped into added, changed, renamed and removed entries, field by field; when stale, three columns _When drafted_, _Now in Steward_, _This change_, conflicts first with a choice each. _Apply_, _Reject_ with a comment, _Back to the author_ (proposed → draft).
- **Keyboard and screen readers.** Every action is a button or link in reading order; a conflict is a radio group with its field path as legend; differences carry words and signs, never colour alone; a new preview after a resolution is announced (`aria-live="polite"`); the draft bar is a labelled region reached by a skip link; `[` and `]` move between conflicts.
- **Phones.** Reviewing, resolving and applying work on a phone: changes are cards (as the 0.12 preview), a field's three values stack. Building large drafts is a desktop task; the draft bar folds to its count.

### 6. Scope, risks, migration, tests, delivery

**Out of scope.** Applying part of a change set; scheduled apply (for example in a maintenance window); comments on single fields; change sets outside the plant registry; deciding in Microsoft Teams (a card cannot show a field diff, [ADR 0013](0013-teams-approvals.md)); writing back to Git or another source; locks; offline editing.

**Risks.** The refactor of `import.ts` and `bulk.ts` can change results (equivalence tests below). An import writes versions, history and baselines – about three times the statements per entry; writes are batched per kind and measured on SQLite and PostgreSQL before release. Drafts versus direct edits can confuse; the draft bar and markers show the mode, and without review nothing looks different. Review on a single-manager site blocks it; the settings page warns. History keeps values people removed – no more than the audit log keeps for single edits; it is in the personal-data export (`HISTORY_COLUMNS`).

**Migration (additive).** `plant-013-revisions`: `revision` on the 14 entry tables – a schema change only on SQLite and PostgreSQL 12+; every entry starts at 1, a valid base. `plant-014-change-sets`: `plant_change_sets` (state, source, title, authors, sites, MCP request, import, reverted change set, fingerprint, counts, dates), `plant_change_ops` (change set, sequence, operation, kind, scope, entry id, base version, base and new values, origin; indexed by entry for the chips), `plant_change_sources` (the files or document of a proposed change set), `plant_entry_history`, `plant_import_baselines`, and `review` on `plant_sites`. Once: pending `plant_proposals` become proposed change sets on the same MCP request; the table stays readable and is dropped later. No backfill of history or baselines: the first import after the upgrade flags whole entries edited by hand after their last import (`updated_at` later than the import's `created_at`) and records baselines.

**Tests.** _Equivalence_: the import, bulk and rename tests run against the old and the new core on the same fixtures (the example enterprise, its OT network, the collection examples) and compare database and audit details; _export → replace import → export_ stays identical. _Merge_: property tests that applying `fieldDiff(a, b)` to `a` gives `b` for keyed lists; the three-way cases. _Concurrency_: two saves on one base – the second gets `409`; a stale draft merges or conflicts; a changed fingerprint refuses the apply. _Rights_: `view` / `propose` / `manage` with access lists, owning teams and the four-eyes levels; authors never apply under review; the step-up per source; the route matrix and `modules.test.ts`. _Schema_: the rename test lists the new columns; the 0.11 and 0.12 upgrade fixtures on SQLite and PostgreSQL; the notification events for _proposed_ and _decided_ in the docs. _End to end_: draft → propose → a second person applies, conflict resolution, the in-place device forms in a draft, keyboard only, a phone viewport.

**Delivery.** **0.13, phase 1:** versions and `409` on every edit form; the change-set tables, API and apply core; edits (including editing in place and _Move to…_), bulk changes, renames, imports and assistants' proposals through it, with the fingerprint check; `propose`, drafts and _Plant → Changes_; `plant.changeSet` and the site switch; history and the History tab; _Revert_ for `set`, `add` and `rename`; the field-level merge; baselines recorded with every import. **Phase 2 (0.13.x or 0.14):** the import's _changed in Steward since the last import_ flags; restoring removed entries; the collection import as operations; change sets in `/api/v1` (read, and proposals from CI); the retention setting in the UI.

## Phase 1 as implemented (0.13.0)

What 0.13.0 ships of the delivery's phase 1, and where it differs from the text above (the text above is kept as decided):

- **Names.** The column is `revision`, not `version` (the API field too): `plant_profiles.version` is the device profile's own (vendor) version. The migrations are `plant-013-revisions` and `plant-014-change-sets` (`plant-012` was taken by profile templates). `plant_entry_history` stores `author`, `applied_by`, `before_values`, `after_values` and `removed_at` (for the retention); `plant_import_baselines` stores `field_values` (`by` and `values` are SQL keywords). The 14 entry tables: sites, nodes, buildings, assets, assignments, asset checks, device profiles, KPI definitions, VLANs, zones, conduits, devices, data paths, data collections.
- **Revisions and history are computed by the apply core, not in the upserts.** One tracker (`changesets/track.ts`) reads the entries a change can reach before and after it, in its transaction, compares their values (the camelCase values of the forms and the import, so the history and the three-way merge speak the same paths as `fieldDiff`), raises the revision of what changed and writes the history; renames are followed (the rename core reports them). Every write path of the registry runs through it, so no upsert needed changing, and the import's, bulk change's and rename's own code stays as it was – the equivalence the tests asked for holds by construction. Region (what is read before and after): what the change's service can write – an edit the entry (an asset with its child assets, a hierarchy node its site, an asset's part the asset's parts), an addition or removal its site or the catalogue with every assignment, a bulk edit the entries it names, an import that adds and changes only the kinds its files hold (up to 1 MB of files); removals in bulk, renames, _replace_ and larger imports the whole registry. Rows are compared as stored and turned into values only where they differ; revisions, history rows and baselines are written 200 at a time (see [Performance](#performance)).
- **Documents are compiled again, not stored as operations.** `compute()` of the import keeps its `Write` closures: an import, a bulk change and an assistant's proposal are one operation of their change set (`import` / `bulk`, the files or body in `plant_change_sources`), compiled again when previewed and applied – as the text says for derived operations. Their entries, field by field, are what the preview (a dry run through the tracker) shows; the fingerprint is the SHA-256 of that result. The import's own preview fingerprint of 0.12 stays for proposals decided under _AI requests_.
- **Edit forms keep their routes and answers.** The 409 carries `entryChanged` (the base read back from the history, the values now, the person's, the conflicting paths); the web app's API layer asks once and sends again. A save that would be refused anyway (a rule, a right) is refused as such before the 409. Where review is required the route answers `202` with its usual answer as it would be with the change (computed in a rolled-back transaction) plus `changeSet`. Who may only propose saves through the same routes with the header `X-SM-Draft: 1`: in 0.13.0 the site and asset forms offer it (_Propose a change_); the other forms save into a draft where review is required. With `plant.changeSet` off, a person without _manage_ still gets `403` from the routes, as in 0.12 (no change on upgrade).
- **"Add to draft" for imports and bulk changes** is the API (`POST change-sets/current/operations` with `op: import | bulk`); the web app's import and _Edit selected_ propose through their routes where review is required (a proposed change set of their own).
- **Pages with the draft applied** (_As in Steward / With my draft_) are not in 0.13.0: a save into a draft answers with the entry as it would be, the draft bar and _Changed in your draft_ mark it, and the review page shows it.
- **The History tab** is on sites and assets (with what belongs to them); device profiles and KPI definitions show theirs through the API (`GET /api/plant/history?kind=profile&id=`) and their change sets.
- **The retention** of the history of removed entries is fixed at 3 years (the setting in the UI is phase 2).
- **Assistants' proposals** stay MCP requests (the AI requests inbox decides them, both inboxes show them); `plant_proposals` keeps the proposals decided in 0.12.
- **`permissions`** of a site keep listing _view_ and _manage_; the new right is `canPropose` (clients of 0.12 compare that list).
- **Collection imports** are tracked (history and revisions), as one change set of source _import_; as operations of their own in phase 2.

### Performance

Measured before the release with `server/test/plant-perf.test.ts` (`SM_PLANT_PERF=1`; it runs on the code of 0.12.0 too): a generated plant of 3 sites, 5,000 assets, 10,000 devices, 5,000 data paths, 1,000 data collections and 40 device profiles with 10,000 data points (6.2 MB of import files), on SQLite and PostgreSQL 16, on a shared 4-core machine (load 5–14: best of 4 runs on SQLite, 2 on PostgreSQL; single runs vary by ±30 %). Milliseconds; _merged_ is phase 1 as first merged, _0.13.0_ after these changes:

| Operation                           | SQLite 0.12.0 | merged | 0.13.0 | PostgreSQL 0.12.0 | merged | 0.13.0 |
| ----------------------------------- | ------------: | -----: | -----: | ----------------: | -----: | -----: |
| Full import: preview                |        11,025 | 13,030 | 11,960 |            37,125 | 34,377 | 39,229 |
| Full import: apply                  |        22,070 | 26,710 | 24,654 |            81,908 | 82,531 | 65,477 |
| Re-import, 5 % changed: preview     |        14,275 | 18,139 | 17,615 |            42,098 | 33,966 | 31,661 |
| Re-import, 5 % changed: apply       |        33,092 | 36,103 | 30,878 |            74,954 | 72,552 | 66,270 |
| Bulk change of 500 assets: preview  |         19–36 |  1,088 |  52–64 |           195–336 |  1,844 |    487 |
| Bulk change of 500 assets: apply    |         28–32 |  1,121 |  59–68 |           457–643 |  2,234 |    488 |
| Edit form save: asset               |             3 |     52 |      5 |                15 |    110 |     21 |
| Edit form save: device              |            80 |    155 |     62 |                90 |    303 |     80 |
| Edit form save: device profile      |           117 |    339 |     97 |               124 |    457 |    128 |
| Assistant's proposal of 500: review |           349 |    358 |    304 |               714 |    902 |    831 |
| Assistant's proposal of 500: apply  |           694 |  2,010 |    723 |             2,375 |  3,661 |  1,783 |

As merged, every change read its whole region twice (an asset's save read the asset's site; bulk changes, imports and proposals the whole registry), turned every entry into values, saved it twice (the edit routes read their answer again for the revision) and wrote history, revisions and baselines one statement per entry. Now the region is what the service can write (see _Revisions and history_ above), rows are compared as stored, an edit route's answer gets the new revisions placed instead of being read again, the bulk preview runs once, and history rows, revisions and baselines are written 200 at a time. Imports, edits and proposals take about as long as in 0.12; a bulk change of 500 entries is still 2–3 times slower in relative terms (under 0.1 s on SQLite, 0.6 s on PostgreSQL), because its preview runs the change in a rolled-back transaction for the fingerprint and applying writes 500 history rows.

**Database growth.** One history row per entry a change writes (about 820 bytes on SQLite with indexes, 650 on PostgreSQL; an import's full values) and one baseline per entry an import writes (about 690 / 510 bytes). The full import above: history 25,314 rows (20.8 MB on SQLite, 16.2 MB on PostgreSQL), baselines 25,314 rows (17.4 / 12.9 MB); the SQLite file 51.6 MB instead of 13.3 MB, the PostgreSQL schema 46.4 MB instead of 24.6 MB. The re-import adds 790 history rows (4.4 MB) and rewrites the baselines (on PostgreSQL their dead rows double the table until autovacuum). At the end of all operations: SQLite 58.1 MB (0.12.0: 13.7 MB), PostgreSQL 72.6 MB (36.0 MB).

### Security

- **Rights at apply, not at proposal.** Operations run through the routes' services as the person who applies, so every rule and right of the edit forms and the import applies again; a proposer's preview counts their _propose_ right as _manage_ only inside a transaction that is always rolled back (`asProposer` refuses to run outside one) and audits nothing (`withoutAudit`, so the audit chain's memory never runs ahead of the log).
- **Four-eyes by identity.** Under review no author applies – the creator, everyone who changed an operation, the token owner of an assistant's proposal, compared by identity (former names, linked single sign-on), administrators included; the check runs again inside the apply transaction against the sites the result really touches (an import may reach a site with review).
- **What was reviewed is what is applied.** Apply needs the fingerprint of the preview the person saw; a different result rolls the transaction back.
- **Who sees what.** Drafts are visible to their authors only; reviewers see the operations and entries of sites they may see (counted, not named, otherwise); a change set of a site someone may not see answers `404`.
- **Bounded.** 200 operations per change set, 256 kB per operation, 20 open change sets and 8 MB per person, the import's own size limits for its files, rate limits per route; open change sets expire, closed ones are deleted after 90 days.
- **No secrets in history.** Values of data collections are kept with the redaction of kept gateway configurations (0.12); assistants' documents with a credential-looking value are refused as before.
- **Tamper evidence.** `plant.change_set_applied` carries the SHA-256 of the operations and of the history rows written (ordered by kind, scope and id), inside the HMAC-chained audit log.
- **Switches.** A site's review switch is set by who manages the site with a step-up (as access grants), never by the import format; the catalogue's by who manages the catalogue, with a step-up.

## Owner decisions

Taken on 2026-11-09, each the recommended answer:

1. **Who may propose by default:** operators, approvers and plant viewers (not everyone who sees a site, not only through access lists).
2. **`plant.changeSet` for new installations:** off; an administrator sets it to optional (each site decides) or required.
3. **Under review, administrators** never apply their own change set.
4. **Without review**, a token owner may keep applying their own assistant's proposals, as in 0.12.
5. **A field changed in Steward since the last import** keeps Steward's value by default; the file's value is one choice away.
6. **Step-up:** 0.11's rules per source.
7. **Expiry:** drafts after 30 days without a change; proposed change sets after 14 days.
8. **History of removed entries** is kept 3 years.
9. **On sites without review**, edit forms apply at once, as today.
10. **Assistants' proposals** show under _AI requests_ and _Plant → Changes_.
11. **Import flags:** baselines are recorded in phase 1, the flags come in phase 2.
12. **Migration packages** move history and baselines with their entries.

## Consequences

- One preview, review, apply and history for every change; a new way to change plant data compiles into operations.
- People without the manage right contribute; a site can require a second person for every change, assistants' included.
- Lost updates end: no form or change set overwrites what someone changed since.
- Imports become syncs into a registry people maintain; from phase 2 they show and respect edits made in Steward.
- Every entry has a history that survives audit retention, and changes are reverted by a reviewed change set.
- The cost: five new tables, a column on 14, more writes per import, a large refactor of the import and bulk code, and a `202` answer of the write routes where review is required (scripts get a change set instead of a result).
- Revisit when other areas (the catalogue of services, records' links) want the same review model – the core could then leave the plant module – or when partial or scheduled apply are asked for.
