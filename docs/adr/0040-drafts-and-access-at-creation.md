# 0040. Drafts and access at creation

- **Status:** Proposed (part 1 decided, part 2 for review)
- **Date:** 2026-11-25
- **Since:** 0.29.0 (part 1); part 2 not scheduled
- **Builds on:** [0034](0034-module-access.md) (who may use a module)

## Context

Two things go wrong when someone creates a process, a monitor or a dashboard.

1. **Version 1 is only a skeleton.** `createProcess` (`server/src/processes/service.ts`) writes version 1 from the dialog's choice: start-only, the manual-steps template or a gallery template. The real work – steps, owners, rules – follows, and `saveProcess` writes a new immutable version whenever the hash changes. Almost every process therefore has a version 2 before anyone runs it, and the history starts with a version nobody meant. Monitors are created with version 1 and bump it in place on every update. Records start from their type's template plus the workflow's initial status; cost calculators, price books and data contracts are versioned too. Dashboards are not versioned. There is no draft state anywhere.
2. **Access can only be set after creation.** Owning teams live in `resource_teams` (`server/src/auth/policy.ts`). `newResourceTeams` gives a new item the creator's profile team, else the teams set to "always" or "auto"; administrators get none unless they choose one. An item with no owning team and no share falls back to the instance roles' default rights, so a new item is visible to everyone with the matching role until someone restricts it. Restricting is a second step in the _Access_ tab, through `PUT /owning-teams/:kind/:id` (step-up when widening, audit `access.owning_teams_changed`) and the share routes. No create route accepts access fields. The process dialog sends the owning teams in a second request after the process exists; if that fails, the user only sees a notice, and the item stays open.

Duplicating an item already copies its access (`server/src/duplicate/common.ts`), so the rules for carrying access along exist.

## Decision

### 1. Access at creation (decided, built first)

The create routes for processes, monitors and dashboards accept an optional `access` object: `owningTeams`, `restricted` and `shares`, in the shapes the existing routes use. The service applies it **in the same transaction** as the creation, so an item is never visible wider than requested, not even briefly, and a failure rolls the creation back instead of leaving an open item and a notice.

- **Same rules as today:** narrowing (fewer teams, restricted, fewer shares than the default) needs no step-up; widening beyond the defaults needs one, checked by the shared code behind `scope-routes.ts` and `share-routes.ts`, not a copy of it. An `access.owning_teams_changed` entry is written when the result differs from the default for the creator. No `access` object means today's behaviour (`newResourceTeams`).
- **Dialogs:** the _New process_, _New monitor_ and _New dashboard_ dialogs get a compact _Access_ section, pre-filled from `newResourceTeams`, with the same team picker as the _Access_ tab. The second request in `NewProcessModal.tsx` goes away.
- **No migration, no new table.** Other creatable kinds follow later if wanted.

### 2. Drafts, then publish (proposed)

New processes and monitors start as **drafts**; dashboards too, with _Publish_ instead of a version. A draft is not runnable, not schedulable, not evaluated and not referenceable by other items, and is visible only to its creator, the owning teams and the shares. It can be edited freely without counting versions. **Publish** creates version 1 – complete, with access already right. An optional instance setting, _New items start restricted_ (off by default), makes the creator's own teams the only readers until publish.

**Data model.** Add `status` (`draft` | `published`) and `published_at` to the item row, and keep the working copy of a draft in a nullable `draft_definition` column on that row. Alternatives: a draft **version row** (`version = 0`, mutable) would put a mutable row into tables whose rows are immutable, and every reader of the version history, hash check, export and diff would need a filter. A separate drafts table would duplicate the access tables. A column keeps the immutable history untouched: a draft has no version rows at all, and publish writes version 1 from `draft_definition` and clears it. Monitors have no version rows (the version bumps in place), so for them the column is the only option. Later, editing a published item could reuse the same column for "unpublished changes"; that is not part of this decision.

**What drafts do:**

- **Lists, search, counts:** shown to those who may see them, marked _Draft_, with a filter; everyone else does not see, count or learn of them (team scope rule).
- **API and MCP:** `/api/v1` and MCP list drafts only for callers who may see them and return `status`; execution and evaluation endpoints answer `409 draft` (new error code, English and German texts).
- **Export, Git sync, import:** drafts are not exported and not synced; an import creates published items unless the file says `status: draft`. Duplicating a published item creates a draft.
- **References:** a schedule, trigger, monitor output, sub-process call, dashboard widget or dependency that points at a draft is refused when saved (`409 draft`) and is skipped with an audit note if a published item is unpublished. There is no _unpublish_ in this decision; deleting a draft is allowed while nothing references it.
- **Scheduler and monitor engine:** select `status = 'published'` only.
- **Audit:** `process.published`, `monitor.published`, `dashboard.published`, with the version created; draft edits are audited as updates, as today.
- **Who may publish:** whoever may edit the item. Publish never widens access, so it needs no step-up.

**Upgrade.** Every existing item becomes `published`, with `published_at` set to its creation time; `draft_definition` is null. Fixtures: an instance from the previous release with items of each kind, upgraded and checked for unchanged lists, runs and exports, on SQLite and PostgreSQL (`test:pg`). The migration is additive and classified in `server/src/migration/tables.ts`.

**Effort.** Part 1: about two to three days (routes, shared service helper, three dialogs, tests). Part 2: about two to three weeks, mostly the places that must filter on `status` (lists, engine, scheduler, API, MCP, sync, import), the reference checks and the UI.

## Alternatives considered

- **Amend version 1 until the first run.** Saves the extra versions without a new state, but "before the first run" is invisible to the user, other items can already reference the item, schedules and monitors may fire, and the history would be mutable for a while. It also does not help access.
- **Restricted by default only.** Fixes the visibility gap and is cheap (the setting in part 2 and part 1 cover it), but leaves the skeleton version 1 and the version 2 untouched.
- **Status quo.** Creation stays a skeleton and access stays a second step; the gap and the failed second request remain.

## Consequences

- New items are never visible wider than the creator chose, and a failed access step can no longer leave an open item (part 1).
- With part 2, version histories start at a version someone meant, and half-built items cannot run, fire or be referenced.
- Harder: every reader of these tables must know about `status`; a missed filter would show or run a draft, so each place gets a test with a draft in it. Users meet one more state and one more click.
- Not done: _unpublish_, drafts for edits of published items, and drafts for records, cost calculators, price books and data contracts, whose templates already give a usable version 1.
- Revisit part 2 if the filters prove too many to keep right, or if amending the first version turns out to be enough for users.
