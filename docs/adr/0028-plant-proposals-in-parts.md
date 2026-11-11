# 0028. Plant proposals in parts, and sources of data points

- **Status:** Accepted
- **Date:** 2026-11-10
- **Since:** 0.17.0

## Context

Since 0.12 an AI assistant proposes plant registry changes as one document of the import format (`propose_plant_changes`, at most 48 kB – an MCP request is at most 64 kB). Since 0.13 a proposal is a proposed change set ([ADR 0020](0020-plant-change-sets.md)) with one import operation, previewed with the token owner's rights and applied by a person. A gateway's or controller's manual lists hundreds of data points; with their addresses, types and descriptions that is far more than 48 kB – so far several unrelated proposals. Control proposals already come in parts (`more`, `proposalId`), but each of their parts only appends controls to a list. A plant document is a tree: one device profile's interfaces, groups and data points may have to be spread over parts. And the reviewer cannot tell where the assistant read a data point.

## Decision

**Parts are documents of the format, merged by key.** Each part is a valid document by itself and is checked when it comes (its format, credentials, how it combines). Steward combines the parts in order: one-entry keys as their lists, objects key by key, lists whose items all have an id (`id`, `asset`, `site`, `data_point`, a group's `name` …) item by item, lists of plain values as their union. A value given differently in two parts, or a list without ids given differently, refuses the part – a later part never overrides an earlier one, so the result does not depend on how the assistant cut the document (`server/src/plant/proposal-parts.ts`). The import's preview and every proposal rule (only additions and changes, no dropped item, no credentials) run on the combined document when the last part comes.

**An unfinished proposal is no change set yet.** Its parts are kept in the AI request's payload (`documents`); it is not listed for reviewers, nobody is told and nobody can accept it; it expires 24 hours after its last part. The last part creates the change set with the combined document as its one import operation – exactly what a proposal sent at once is – so review, fingerprints, history and apply stay as they are (`server/src/plant/proposals.ts`).

**A source is a field of the data point.** `source: { document, page, section }` is part of the import format and of the stored data point (profiles' `interfaces` and assignments' `additions` are JSON), a field an inherited data point's override may change (`PROFILE_POINT_FIELDS`). The review matches the document against the records linked to the entry (number or title) and otherwise offers to attach it on the Documents panel; it never creates or links a record (`server/src/plant/proposal-sources.ts`).

## Consequences

- A profile of up to about 5,000 data points can arrive as one reviewable proposal (25 parts, 1 MB combined). The preview of the parts so far is answered with each part only while they are small (256 kB), so a large proposal finds some problems only with its last part.
- A part cannot correct an earlier one: a wrong value in part 2 means a new proposal (the unfinished one expires or its owner withdraws it). Replacing a part would make the combined document depend on the order of corrections; we accept the simpler rule.
- Merging by "the first key every item has" is a heuristic over the format, not a schema per list; a list it cannot key must be given whole in one part. A list type that later gets an id key combines better without a change here.
- Sources need no migration: rows written before 0.17.0 read without one. A source is a citation, not a link: a renamed or deleted record does not change it. Uploads through MCP and reading PDFs stay out of scope.
