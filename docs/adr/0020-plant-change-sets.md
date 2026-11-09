# 0020. Plant change sets: one path for every change to plant data

- **Status:** Proposed
- **Date:** 2026-11-09
- **Since:** 0.13.0 (planned) – part of the plant registry (preview, [0007](0007-plant-registry.md))

## Context

Steward is the **source of truth** for plant data: people maintain it mostly by hand in Steward, and imports are loads and syncs into it (owner decision for 0.13). The theme of 0.13 is **one change path**. Today plant data changes in six ways, each with its own preview, rules and audit:

| Path                                                                           | Preview                                                                                                 | Apply                                                                              | Step-up                                                                          | Audit                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Edit form of an entry (`PUT /api/plant/assets/:id` and the other entry routes) | none                                                                                                    | at once, last write wins; a hand edit keeps the entry's `import_id` (`keepSource`) | none                                                                             | per kind (`asset.updated`, `site.vlan_changed` …) with the changed top-level fields and their old and new values |
| File import (`import.ts`)                                                      | a dry run in a rolled-back transaction (`dryRun`); since 0.12 field by field (`diff.ts`)                | **computed again** from the files: nothing ties it to the preview the person saw   | `plant.bulkChange` for more than one removal or rename, `plant.renameId` for one | `plant.imported`: mode, counts, files and SHA-256, at most 200 ids per action – no values                        |
| Bulk change (`bulk.ts`)                                                        | changed, skipped, refused                                                                               | computed again                                                                     | `plant.bulkChange` for more than one removal or more than 25 edits               | `plant.bulk_changed` / `plant.bulk_removed`: the set values and up to 150 entries – no old values                |
| Change id (`rename.ts`)                                                        | references counted in a dry run                                                                         | the rename core                                                                    | `plant.renameId` (off by default)                                                | `plant.id_changed`, `plant.ids_changed`                                                                          |
| Assistant's proposal (`proposals.ts`, 0.12)                                    | the import's preview, stored with a **fingerprint**; the reviewer confirms a preview that changed since | the import core, refused when the fingerprint differs (`PLANT_PROPOSAL_CHANGED`)   | none (a proposal never removes or renames)                                       | `plant.proposal_created`, `_applied`, `_rejected` with counts and the document's SHA-256                         |
| Collection import (`collections-import.ts`)                                    | its own preview                                                                                         | its own transaction                                                                | none                                                                             | `plant.collection_imported`                                                                                      |

What follows from that:

- **No concurrency control.** Two people editing the same asset overwrite each other silently. An import or bulk change applies what it computes at that moment, not what was previewed. Only proposals check (by fingerprint, for the whole document).
- **Only managers can change anything.** Rights are `view` and `manage` per site (`PLANT_PERMISSIONS`). People who know the data best – on the shop floor, in maintenance – cannot suggest a correction; even an assistant may only propose for a token owner who manages a site (`plantManagesSome`).
- **No review by a second person.** Assistants' proposals are reviewed, but the token owner may apply their own assistant's proposal (`mayAccept` does not exclude them). People's changes are never reviewed. The assurance policy knows four-eyes ([ASSURANCE.md](../ASSURANCE.md)), but no plant control point uses it.
- **Imports cannot tell an edit in Steward from stale data.** A record remembers only the last import that wrote it (`import_id`, kept on hand edits), not which fields were edited since. An _update_ import silently overwrites a correction made in Steward – the opposite of "Steward is the source of truth".
- **History is scattered and incomplete.** Single edits carry old and new values in the audit log; imports, bulk changes and proposals carry ids and counts only. Audit entries of the plant registry may leave the database after archiving ([ADR 0017](0017-audit-retention.md)), the diff of 0.12 is cut for display (`PLANT_DIFF_LIMITS`: 500 characters, 50 differences per entry), and nothing can be undone.

## Decision

### 1. One change-set pipeline

A **change set** is a list of operations against a base, with one preview, one review, one transactional apply, one history and one audit trail. Every path above produces one; what differs is only where the operations come from.

**Operations** (one entry each, addressed by kind, scope and id as in `PlantEntryRef`):

- `set` – fields of an existing entry: per path (the paths of `fieldDiff`: `description`, `overrides[prog_name].address`, lists keyed by `id`, `interface`, `dataPoint` …) the **base** value seen when the operation was made and the new value, plus the entry's **base version**;
- `add` – a new entry with its full values;
- `remove` – an entry, with `cascade` as in the removal core;
- `rename` – an entry and its new id, through the rename core;
- `mark` – _not in source_ (from _Replace an earlier import_).

An operation is **authored** (a person or an edit form made it: its intent is the field values) or **derived** (compiled from a document – import files, an assistant's proposal: its intent is the document). This is what decides what happens when the base changes (section 3).

**States:** `draft` (its authors change it freely; nothing is checked but the format) → `proposed` (frozen; reviewers see it) → `applied`, or `rejected`, `withdrawn`, `expired`. A rejected change set can be copied into a new draft. Stale is not a state: it is the result of a preview (section 3).

**One apply core** (`server/src/plant/changesets/apply.ts`, new): in one transaction it checks rights and versions, runs the model rules the edit forms and the import use today, writes through the existing upserts (which bump the version), calls the removal and rename cores, writes the history rows (section 4), and writes the audit entries. The preview is the same code in a rolled-back transaction (`dryRun`), as today.

**How the existing paths map onto it:**

| Path                 | What stays                                                                                                                            | What changes                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit forms           | The routes, bodies and per-kind audit actions                                                                                         | Each save is a change set of one operation, created and applied in one request (source `edit`) – or written into a draft when review is required (section 2). The body may carry the entry's `version` (section 3).                                             |
| File import          | Format 1, modes, the id mapping, `remove:`, the limits, `plant.imported`                                                              | `compute()` returns operations instead of `Write` closures; `applyWrites` becomes the apply core. `POST /api/plant/import` takes the preview's `fingerprint` and refuses a different result (`PLANT_IMPORT_CHANGED`); without it (scripts) it applies as today. |
| Bulk change          | The fields that may be set on many entries, skipped and refused items, the audit actions                                              | Compiles into `set` and `remove` operations; same fingerprint rule.                                                                                                                                                                                             |
| Change id            | The rename core, aliases, `plant.id_changed`                                                                                          | A `rename` operation; the id mapping of an import produces them too.                                                                                                                                                                                            |
| Assistant's proposal | The MCP tool `propose_plant_changes`, its refusals (no removal, rename, dropped item or credential), the AI requests inbox, the audit | Stored as a proposed change set (source `assistant`) linked to its MCP request instead of `plant_proposals`; the fingerprint check becomes the general one. Pending proposals are converted once at upgrade.                                                    |
| Collection import    | Its importers, mapping and kept configurations                                                                                        | Phase 2: its writes become operations too.                                                                                                                                                                                                                      |

Every existing audit action stays and gains `changeSetId` in its details; `plant.change_set_*` entries are new. Readers of the audit log (reports, datasets) see what they saw before.

**API** (internal, `/api/plant/…`; the public API reads them in phase 2):

| Route                                                            | What                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET change-sets?state=&site=&source=&mine=1`                    | The change sets the reader may see (only the operations of sites they see)                                                                                  |
| `POST change-sets`                                               | A new draft: `{ title, description }`, optionally `from: { import \| bulk \| rename }` with the body those routes take today                                |
| `GET change-sets/:id`, `PATCH change-sets/:id`                   | Header, operations, authors; title and description                                                                                                          |
| `POST change-sets/:id/operations`, `PUT …/:seq`, `DELETE …/:seq` | Edit a draft's operations                                                                                                                                   |
| `POST change-sets/:id/preview`                                   | The preview of now: the 0.12 diff, problems, checks, drops, staleness and conflicts, who may apply it, whether applying asks for a step-up, the fingerprint |
| `POST change-sets/:id/propose`, `…/withdraw`                     | Freeze and hand over; take back                                                                                                                             |
| `POST change-sets/:id/resolve`                                   | Per conflicting field: `mine`, `theirs` or a value (section 3)                                                                                              |
| `POST change-sets/:id/apply`                                     | `{ fingerprint }` – applied only if the preview of now has that fingerprint; step-up and four-eyes as in section 2                                          |
| `POST change-sets/:id/reject`                                    | `{ comment }`                                                                                                                                               |
| `POST change-sets/:id/revert`                                    | A new draft that undoes an applied change set (section 4)                                                                                                   |
| `GET history?kind=&scope=&id=`                                   | An entry's history (section 4)                                                                                                                              |

The existing routes stay as shortcuts that create and apply in one request. Where review is required they answer `202` with the change set they created instead (also for API tokens: a nightly sync into a reviewed site becomes a proposal, it does not fail).

**Options considered.**

- **A. Operations as the one model; documents compiled into them (recommended).** One apply core, one history, one concurrency rule. Cost: the largest refactor (`import.ts` is 1,535 lines of closures).
- **B. Generalise the 0.12 proposal: store the input (files, bulk body, form values) and recompute at preview and apply, guarded by a fingerprint.** Least code, but a person's draft of 30 field edits would be recomputed from its form bodies, field-level merging is impossible, and history still has no values.
- **C. Keep the paths, add a shared review inbox on top.** Fast, but every path keeps its own rules; it does not reach "one change path".

We recommend **A**, built in steps: phase 1 converts edits, bulk changes, renames, proposals and imports; the collection import follows.

### 2. Drafts and proposals by people; four-eyes; step-up

**Who may propose.** A new site permission `propose` between `view` and `manage` (`PLANT_PERMISSIONS`: `view`, `propose`, `manage`). It lets a person keep drafts and propose them for the sites it holds – never apply. Device profiles and KPI definitions belong to no site: whoever may propose for some site may propose changes to them; designers and administrators apply them as today. MCP proposals then need `propose` instead of `manage` (`mayPropose`).

| Option                                                                           | For                                         | Against                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| a. `propose` by default for operators, approvers and plant viewers (recommended) | the people who know the data can correct it | plant viewers get a write-like action (they still change nothing alone) |
| b. Everyone who sees a site may propose                                          | simplest                                    | auditors and viewers too                                                |
| c. Only through a site's access list                                             | nothing changes until someone grants it     | nobody uses it without set-up                                           |

**Review by a second person.** A new control point `plant.changeSet` in the assurance policy (group `catalogue`, four-eyes levels `off` / `optional` / `required`, no step-up of its own; default `off`, so nothing changes on upgrade). With `optional` each site has its own switch _Changes need a second person_ (a site column `review`, set by who manages the site, with a step-up as for access grants; never in the import format, so an import cannot switch it off), and the catalogue has one in the plant settings. With `required` every site and the catalogue need it. A change set touching several sites needs review if one of them does.

When review is needed, **everybody's** changes on that site go through a draft – managers' too; that is what four-eyes means. The edit forms then save into the person's current draft.

**Who may apply their own change set?** "Own" means: its creator, everyone who added or changed an operation, and for an assistant's proposal the token owner – as for records, where owner, author, submitter and content authors never approve their own record (`record.approve`).

| Option                                                                                                                                | For                                                               | Against                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| a. Without review: anyone who manages every site touched. With review: nobody who is an author, administrators included (recommended) | clear; matches `record.approve`; today's behaviour without review | a site with one manager is stuck with review on – the settings page warns when fewer than two people may apply |
| b. As a, but administrators may apply their own                                                                                       | no deadlock                                                       | the second person is optional exactly for the most powerful role                                               |
| c. Small change sets (only `set`, at most N fields) may be self-applied even with review                                              | less friction                                                     | a threshold invites splitting                                                                                  |

Applying needs `manage` on every site touched (and the catalogue right for profiles and KPI definitions), as importing does today. Reviewers see only the operations of sites they see (as `forReader` does for proposals); one they may not see makes the change set unappliable for them.

**Step-up.** A step-up confirms the person who **applies**, at apply time, from the stored operations (route config `stepUp.when`, as the import does with `importPointsOf`). It is separate from four-eyes: a reviewer may need both.

| Option                                                                                                                                                                                                                                                                                                       | For                                                           | Against                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------- |
| a. Keep 0.11's rules per source (recommended for 0.13): removing or renaming more than one entry → `plant.bulkChange`, one rename → `plant.renameId`; a bulk-style change set (source `bulk`, or a draft that sets fields on more than 25 entries) also → `plant.bulkChange`; assistants' proposals as today | a refactor changes no control; token-run imports keep working | the rule depends on the source                       |
| b. One rule: only more than one removal or rename                                                                                                                                                                                                                                                            | simple                                                        | loosens bulk edits (today more than 25 ask)          |
| c. One rule including more than 25 changed entries                                                                                                                                                                                                                                                           | strict                                                        | every large sync asks; token imports fail with `403` |

### 3. Conflicts and staleness

**A version per entry.** Every entry table gets `version INTEGER NOT NULL DEFAULT 1` (the 14 tables from `plant_sites` to `plant_collections`; sinks are a column of a collection). Every write through the upserts in `model.ts`, `data-model.ts`, `network-model.ts` and `collections-model.ts` adds one; a no-op write (`changedKeys` empty) does not.

| Option                           | For                                                                      | Against                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| a. Version counter (recommended) | exact; cheap to compare; one `UPDATE … WHERE version = ?` guards a write | a column on 14 tables; every write path must bump it (one helper, a test that checks it)     |
| b. `updated_at` as the token     | no migration                                                             | an import writes many entries with the same time; ISO strings to the millisecond can collide |
| c. Hash of the entry's values    | no migration; ignores a change that was changed back                     | needs a canonical form per kind; costs a hash per entry per preview                          |

**Edit forms.** The entry's JSON carries `version`; a form sends it back. When it differs, the save is refused with `409 PLANT_ENTRY_CHANGED` and, per field, the value the form loaded, the value now and the person's value; the form offers _Keep mine_, _Take theirs_ per field. A body without `version` (scripts) writes as today.

**A change set whose base changed.** The preview compares each operation's base version with now:

- **Authored operations** are merged field by field, three ways – **base** (what the author saw), **theirs** (now in Steward), **mine** (the operation): a field only mine changed is applied; only theirs, kept; both to the same value, fine; both differently, a **conflict**. A removed entry conflicts with every operation on it; a renamed entry is followed (old ids are aliases). Conflicts are resolved in the draft or by the reviewer (`resolve`), and each resolution is recorded with the change set.
- **Derived operations** are compiled again from their document – the document is the intent; this is what the 0.12 proposal does today.
- Either way the **fingerprint** of the preview changes, and applying needs the fingerprint of the preview the applier saw (as `PLANT_PROPOSAL_CHANGED` today, now `PLANT_CHANGESET_CHANGED`). The page shows both previews and asks to confirm the new one.

Several open drafts may touch the same entry; nothing is locked. The entry page shows that drafts exist (section 5), and whichever is applied second is merged as above.

**Imports versus edits in Steward.** The import preview flags, per field, **changed in Steward since the last import** – when Steward's value differs from what the last import wrote there – and offers per field (and for all at once) _Keep Steward's_ or _Take the file's_. That needs per-field provenance: the value an import last wrote for each field.

| Option                                                                                                                                                                                                                   | Storage and cost                                                                                                                                                                                                                                                                                                                                                                                                                     | For                                                                                                                                     | Against                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| a. **One table** `plant_import_baselines (kind, scope, entry_id, values, import_id, updated_at, PRIMARY KEY (kind, scope, entry_id))`; `values` maps each path an import wrote to the value and the import (recommended) | One row per imported entry, about the size of the imported data (a site of 2,000 assets: a few MB). SQLite: one indexed read per kind for the preview, one upsert per written entry in the import's transaction. PostgreSQL: the same; text over 2 kB is compressed out of line (TOAST); reads and writes batched per kind, because every statement crosses the PG bridge ([ADR 0001](0001-synchronous-db-layer-with-pg-bridge.md)). | One migration; only imported entries pay; lists (`SELECT * FROM plant_assets`) do not read it; shows the base value in a real three-way | The rename and removal cores must maintain it – the rename test that walks the schema (`REFERENCES` in `rename.ts`) makes forgetting it fail |
| b. A JSON column `imported` on each of the 14 entry tables                                                                                                                                                               | Adding a column with a constant default is a schema change only on SQLite and on PostgreSQL 11 and later (Steward needs 12). Every row read carries it.                                                                                                                                                                                                                                                                              | No join; renames and removals need nothing                                                                                              | Widens every list query; 14 columns to maintain                                                                                              |
| c. As a, but a hash per path instead of the value                                                                                                                                                                        | Some 16 bytes per path                                                                                                                                                                                                                                                                                                                                                                                                               | Smallest                                                                                                                                | Can flag, but not show what the file said last time                                                                                          |

Which value wins by default for a flagged field is an owner decision (question 5); we recommend _Keep Steward's_, as Steward is the source of truth. Unflagged fields follow the mode as today.

### 4. History and undo

**History per entry.** A new table `plant_entry_history (id, kind, scope, entry_id, version, change_set_id, op, at, by, applied_by, before, after)` gets one row per entry an applied change set touched: the **full** values of the changed fields before and after (not the shortened display values), the version reached, the change set, its author and who applied it. A removal keeps the whole entry (and what went with it), so it can be restored later. The diff on screen is computed from `before` and `after` with `fieldDiff`. The entry columns follow renames (listed in `REFERENCES`); the values stay as they were – history.

The entry page gets a **History** tab: when, who (author and reviewer), which change set (with a link and its title), the source (edit, import with its files, bulk, rename, assistant, revert) and the fields that changed. Before 0.13 there is no history; the tab links the audit entries of the entry for that time (the audit log keeps old ids; aliases lead to them).

**Undo never rewrites history.** _Revert_ on an applied change set, or on one row of an entry's history, creates a **new draft** with the inverse operations: `set` back to the before values (based on now, so later edits conflict instead of being overwritten), `add` from a removal's snapshot (phase 2), `rename` back (which removes the alias, as renaming back does today), `remove` of an added entry. It is reviewed and applied like every change set and records which change set it reverts.

**Tamper evidence.** `plant.change_set_applied` carries the SHA-256 of the operations and of the history rows it wrote, so a history row changed in the database no longer matches the chained audit log ([ADR 0003](0003-hmac-chained-audit-log.md)).

**What the audit log already holds, and what is new.** The audit log keeps who did what and when for every path, and old and new values of single edits' top-level fields. New: field-level before and after for imports, bulk changes and proposals; versions; one change set tying together a draft, its review and its apply; author and reviewer as different people; an undo; and a history that stays when audit entries are archived and deleted (plant entries are not among those kept, `KEPT_ON_DELETE_SQL`).

**Retention.** History rows stay while their entry exists; those of removed entries are deleted by the daily clean-up after a period (default 3 years, a plant setting). Change sets that were rejected, withdrawn or expired are deleted after 90 days; their audit entries stay. Baselines go with their entry.

### 5. UI and UX

- **Where drafts live.** _Plant → Changes_: _My drafts_, _To review_ (with a count), _Applied_, _Closed_. Assistants' proposals show there and stay under _AI requests_ – both open the same review page. A site page and an entry page show a chip _2 open changes_ that lists them; an entry in the person's own draft shows _Changed in your draft_. Options: one inbox in AI requests for everything (one place, but people's work is not an AI request), or only the per-site indicator (no overview for reviewers). We recommend the Plant inbox plus the indicators.
- **Editing in a draft.** When review is required, or the person may propose but not manage, the edit forms (also the edit-in-place forms of 0.12 where they exist) save into the **current draft**: a bar at the bottom of plant pages names it, counts its changes and offers _Review and propose_; a person can switch drafts or start one. Pages show the draft's values with a marker and a switch _As in Steward / With my draft_. _Edit selected_ in the lists and the import's last step offer _Add to draft_ or _Propose_ instead of _Apply_.
- **Review page.** The 0.12 preview grouped into added, changed, renamed and removed entries, each field with before and after; when stale, three columns _When drafted_, _Now in Steward_, _This change_, conflicts first, each with a choice. _Apply_ (with the fingerprint shown), _Reject_ with a comment, _Back to the author_ (returns a proposed change set to draft).
- **Keyboard and screen readers.** Every action is a button or link in reading order; a conflict's choice is a radio group with its field path as legend; differences carry words and signs (_added_, _removed_, _changed_), never colour alone; a new preview after a resolution is announced (`aria-live="polite"`); the draft bar is a labelled region and is reached by a skip link; `[` and `]` move between conflicts.
- **Phones.** Reviewing, resolving and applying work on a phone: changes are cards (as the 0.12 preview), the three values of a field stack. Building large drafts is a desktop task; the draft bar folds to its count.

### 6. Out of scope, risks, migration, tests, delivery

**Out of scope (later, if needed).** Applying part of a change set; scheduling an apply (for example in a maintenance window); comments on single fields; change sets for other areas than the plant registry; deciding in Microsoft Teams (a card cannot show a field diff, [ADR 0013](0013-teams-approvals.md)); Steward writing back to Git or another source; locking entries; offline editing.

**Risks.**

- The refactor of `import.ts` and `bulk.ts` from closures to operations can change results. Mitigation below (tests).
- Every import writes versions, history rows and baselines: about three times the statements per entry. Batched writes per kind; measured on SQLite and PostgreSQL before release.
- Drafts versus direct edits can confuse. The draft bar and the markers make the mode visible; without review nothing looks different.
- Review on a site with a single manager blocks it; the settings page warns.
- History keeps values people removed (a wrong address, a name). It holds no more than the audit log already does for single edits; it is covered by the personal-data export (`HISTORY_COLUMNS`) and moves with migration packages; open change sets do not move, as MCP requests do not.

**Migration (all additive).**

- `plant-012-versions`: `version INTEGER NOT NULL DEFAULT 1` on the 14 entry tables – a schema change only on SQLite and PostgreSQL 12+; every existing entry starts at 1, which is a valid base.
- `plant-013-change-sets`: `plant_change_sets` (state, source, title, authors, sites, MCP request, import, reverted change set, fingerprint, counts, dates), `plant_change_ops` (change set, sequence, operation, kind, scope, entry id, base version, base and new values, origin; an index on kind, scope and entry id for the indicators), `plant_change_sources` (the files or document of a proposed change set), `plant_entry_history`, `plant_import_baselines`, and `review` on `plant_sites`.
- Once: pending rows of `plant_proposals` become proposed change sets linked to the same MCP request; `plant_proposals` stays readable for decided ones and is dropped in a later release.
- No backfill of history or baselines. The first import after the upgrade flags whole entries that were edited by hand after their last import (`updated_at` later than the import's `created_at`, the field unknown) and records baselines; later imports flag fields.

**Tests.**

- **Equivalence while refactoring:** the import, bulk and rename tests run against the old and the new core on the same fixtures (the example enterprise, the OT network and the collection examples) and compare the database and the audit details; _export → replace import → export_ stays identical.
- **Merge:** property tests that applying `fieldDiff(a, b)` to `a` gives `b` for keyed lists; three-way cases (mine only, theirs only, both, removed, renamed).
- **Concurrency:** two saves with one base – the second gets `409`; a stale draft merges or conflicts; a changed fingerprint refuses the apply.
- **Rights:** the matrix of `view` / `propose` / `manage`, access lists, owning teams and the four-eyes levels; authors never apply under review; the step-up points per source; the route matrix and `modules.test.ts` for the new routes.
- **Schema:** the rename test lists the new columns; the upgrade fixtures of 0.11 and 0.12 on SQLite and PostgreSQL; the docs lists (notification events for _proposed_ and _decided_).
- **End to end:** draft → propose → a second person applies; conflict resolution; keyboard only; a phone viewport.

**Delivery.**

- **0.13, phase 1:** versions and `409` on the edit forms; the change-set tables, API and apply core; edits, bulk changes, renames, imports and assistants' proposals through it, with the fingerprint check; `propose`, drafts and the Changes inbox; the control point `plant.changeSet` and the site switch; history rows and the History tab; _Revert_ for `set`, `add` and `rename`; field-level merge for authored operations; **baselines recorded** with every import.
- **Phase 2 (0.13.x or 0.14):** the import preview's _changed in Steward since the last import_ flags with per-field choice; restoring removed entries; the collection import as operations; change sets in `/api/v1` (read, and proposals from CI); the retention setting in the UI.

## Consequences

- One preview, one review, one apply, one history for every change; adding a new way to change plant data means compiling it into operations.
- People without the manage right can contribute; a site can require a second person for every change, assistants' included.
- Lost updates end: an edit form or a change set can no longer overwrite what someone else changed since.
- Imports become syncs into a registry people maintain: in phase 2 they show and respect edits made in Steward.
- Every entry has a history that survives audit retention, and changes can be reverted by a reviewed change set.
- The cost: five new tables, a column on 14, more writes per import, and a large refactor of the import and bulk code. Plant routes that write gain a `202` answer where review is required; scripts that write into a reviewed site get a change set to apply instead of a result.
- Revisit when other areas (the catalogue of services, records' links) want the same review model – the change-set core could move out of the plant module then – or when partial apply or scheduled apply are asked for.

## Open questions for the owner

1. Who may propose by default: **operators, approvers and plant viewers (recommended)**, everyone who sees the site, or only those an access list names?
2. Default of `plant.changeSet` for new installations: **off (recommended)**, optional (each site decides) or required?
3. With review on, may an administrator apply their own change set: **no (recommended)** or yes?
4. Without review, may a token owner keep applying their own assistant's proposals (as in 0.12): **yes (recommended)** or always a second person for assistants?
5. A field changed in Steward since the last import: by default **keep Steward's (recommended)**, take the file's, or follow the import mode?
6. Step-up for change sets: **0.11's rules per source (recommended)**, only more than one removal or rename, or also more than 25 changed entries for every source?
7. Expiry: drafts after **30 days without a change (recommended)**, 90 days or never; proposed change sets after **14 days, as AI requests (recommended)** or 30?
8. History of removed entries: kept **3 years (recommended)**, as long as the audit retention, or forever?
9. On sites without review, do edit forms **apply at once as today (recommended)**, or always go through a draft?
10. Assistants' proposals: in **both AI requests and Plant → Changes (recommended)**, or only in Plant → Changes?
11. The import flags of section 3: **baselines recorded in phase 1, flags in phase 2 (recommended)**, or both in phase 1?
12. Migration packages: move the history and baselines **with the entries (recommended)**, or leave them behind?
