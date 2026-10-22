# UI/UX review

A review of the Steward web UI in October 2026, what was changed because of it, and what is left to do.

## How the review was done

- The app ran in demo mode (`SM_DEMO=1`) with the demo data plus extra runs, an open approval task, three credentials (OK, due soon, overdue), a service, three records, a report schedule and a webhook trigger. A second, empty installation showed the first-run experience and the empty states.
- Every main page, the detail pages, the command palette and the _New record_ dialog were captured with Playwright at 1440 px and 390 px, in light and dark mode, and looked at one by one.
- The pages were checked against Nielsen's 10 usability heuristics, WCAG 2.2 AA and the usual Mantine/Material conventions (page header with the primary action on the right, empty states with guidance and an action, breadcrumbs on detail pages, one colour vocabulary for status).

Severity: **High** – blocks or seriously hinders a task, or fails WCAG AA. **Medium** – slows people down or confuses them. **Low** – polish.

## Findings

| #   | Severity | Page                                                                                                                                    | Issue                                                                                                                                                                                                                | Recommendation                                                                                                             | Status          |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | High     | Run detail, Credentials, every page with a long title (390 px)                                                                          | The page header squeezed the title into a column of about 80 px. On a run the _Cancel_ button covered the title and the status badges were cut to "W" and "D." (WCAG 1.4.10 Reflow).                                 | Let the actions wrap below the title on narrow screens.                                                                    | Fixed           |
| 2   | High     | Runs list, recent runs on the start page, start-page tiles, process, platform and dashboard cards, "last run" on Schedules and Triggers | Clickable rows and cards only had a mouse `onClick`. The runs list had no link at all, so a keyboard user could not open a run from it (WCAG 2.1.1 Keyboard).                                                        | Put a real link in every clickable row or card; keep the larger click target for the mouse.                                | Fixed           |
| 3   | Medium   | Sidebar                                                                                                                                 | 16 entries in one flat list, daily pages mixed with administration, no landmark name. On a 900 px high screen _Settings_ needed scrolling. (Heuristic 6: recognition rather than recall, 8: minimalist design.)      | Group into sections, order by frequency of use, allow folding sections and the whole sidebar.                              | Fixed           |
| 4   | Medium   | Run, record, record editor, record types, monitor, monitor editor, service, dashboard, process editor, system status                    | No way back to the list other than the sidebar or the browser; only the platform page had "← Platforms" (Heuristic 3: user control, 7: efficiency).                                                                  | Breadcrumb above the title of every detail page.                                                                           | Fixed           |
| 5   | Medium   | Runs, Schedules, Triggers, Monitors, Records, Services, Credentials, Reports, My tasks                                                  | Empty lists showed one grey sentence and no action; Platforms, Processes and Dashboards each had a different design (Heuristic 4: consistency, 10: help).                                                            | One empty-state component: icon, title, one or two sentences of guidance, the primary action for users who may use it.     | Fixed           |
| 6   | Medium   | All list pages                                                                                                                          | While loading, most lists showed nothing; when the request failed, the page stayed blank (Heuristic 1: visibility of system status, 9: recover from errors).                                                         | Skeleton rows while loading, an error message with _Try again_.                                                            | Fixed for lists |
| 7   | Medium   | Command palette                                                                                                                         | Covered pages, processes, dashboards and platforms, but not monitors, services, records or credentials; the only "create" action was _New process_; status wall, record types, system status and About were missing. | Add the newer entities as search results, add "New …" actions that open the create dialogs, add the missing pages.         | Fixed           |
| 8   | Medium   | Start page                                                                                                                              | The 3-step "Get started" hint disappeared as soon as one platform existed. Monitors, credentials, reports, users and the API/MCP had no first-run guidance (Heuristic 10).                                           | A checklist for administrators that tracks real progress and links each step to its create dialog.                         | Fixed           |
| 9   | Medium   | Credentials (390 px)                                                                                                                    | Seven filter fields filled the whole first screen before the first entry.                                                                                                                                            | Fold filters behind a _Filters_ button on phones, with the number of active filters.                                       | Fixed           |
| 10  | Medium   | 24 places (delete, archive, rotate, revoke, lock vault …)                                                                               | Destructive actions use the browser's `confirm()`: unthemed, no red destructive button, no room for consequences, inconsistent with the Mantine dialogs used elsewhere.                                              | A `confirmDanger()` helper on `@mantine/modals`; migrate the call sites and their UI tests.                                | Backlog (P1)    |
| 11  | Medium   | Runs and Records tables (390 px)                                                                                                        | Six columns; process names wrap word by word and the table scrolls sideways. Services already switches to cards on phones.                                                                                           | Card list on narrow screens, like Services.                                                                                | Backlog (P1)    |
| 12  | Medium   | Create dialogs (e.g. _New record_)                                                                                                      | The primary button stays disabled until the form is valid without saying what is missing (Heuristic 9).                                                                                                              | Keep the button enabled and show inline errors on submit, or a hint next to the disabled button.                           | Backlog (P1)    |
| 13  | Medium   | Lists in general                                                                                                                        | No sorting anywhere; Runs stops at 200 entries without telling; filters sit in the header on Runs but below it on Records and Credentials.                                                                           | A shared table with sortable columns, a "showing 200 of N / load more" footer and one filter bar position.                 | Backlog (P2)    |
| 14  | Low      | Start page, run detail                                                                                                                  | Failed-check severities were loud filled badges on the start page and plain text in the run's checks table.                                                                                                          | One `SeverityBadge` in the light variant.                                                                                  | Fixed           |
| 15  | Low      | Runs, monitors, credentials, checks                                                                                                     | Four separate colour maps. The meaning was mostly the same, but nothing kept it that way.                                                                                                                            | One documented vocabulary (`TONE` in `web/src/components/common.tsx`).                                                     | Fixed           |
| 16  | Low      | Narrow tables                                                                                                                           | Run status badges were cut to "SU…".                                                                                                                                                                                 | Badges never shrink below their text.                                                                                      | Fixed           |
| 17  | Low      | Credentials                                                                                                                             | Empty filter selects without a placeholder, unlike Records ("All types").                                                                                                                                            | "All types", "All statuses", "All platforms".                                                                              | Fixed           |
| 18  | Low      | Unknown address                                                                                                                         | Showed the bare text "Page not found".                                                                                                                                                                               | Empty state with a link to the start page.                                                                                 | Fixed           |
| 19  | Low      | Monitors vs. everything else                                                                                                            | Monitor status badges are filled, all other status badges are light.                                                                                                                                                 | Keep it on purpose (a monitor's state is the main signal of the page) but write the rule down; see "Status colours" below. | Documented      |
| 20  | Low      | Record detail (decision records)                                                                                                        | Template sections without content show an empty bullet ("•") and "1.".                                                                                                                                               | Hide empty list items in the preview, or show the template hint in grey.                                                   | Backlog (P3)    |
| 21  | Low      | Start page                                                                                                                              | No tiles for monitors that are down or credentials that are due; on phones the five tiles leave one alone in the last row.                                                                                           | Add "Monitors down" and "Credentials due" tiles (six tiles fill 2 and 3 columns).                                          | Backlog (P2)    |
| 22  | Low      | Keyboard                                                                                                                                | Ctrl/⌘ K is the only shortcut and nothing lists it except the search button.                                                                                                                                         | A `?` help dialog with shortcuts; optional `g r` (runs), `g m` (monitors) …                                                | Backlog (P2)    |
| 23  | Low      | MCP, public API, IoT gateway                                                                                                            | Only reachable through Profile → API tokens, Settings and the Monitors → Gateways tab.                                                                                                                               | Linked from the checklist now; later a _Help / What's new_ menu in the header.                                             | Partly fixed    |
| 24  | Low      | Every page                                                                                                                              | The two-line footer takes space on every page, also on phones.                                                                                                                                                       | One line, or only on the About page and the sign-in page.                                                                  | Backlog (P3)    |
| 25  | Low      | Record and monitor detail                                                                                                               | The page actions (Edit, Propose, Check now) sit in a row below the header, on other detail pages they sit on the right of the title.                                                                                 | Move them into the header's `actions` (they wrap on phones now).                                                           | Backlog (P3)    |

Checked without findings: dark mode on all captured pages (contrast holds, the axe checks are clean), the user menu, the notification centre, the run dialog, Settings and Users & teams.

## What was implemented

### Grouped, foldable sidebar

The sidebar has sections, ordered by how often a service team needs them:

| Section            | Pages                                              |
| ------------------ | -------------------------------------------------- |
| (top)              | Dashboard, My tasks                                |
| Operate            | Runs, Monitors, Dashboards                         |
| Automate           | Processes, Schedules, Triggers                     |
| Service management | Services, Platforms, Credentials, Records, Reports |
| Administration     | Audit log, Users & teams, Settings                 |

- Click a section heading to fold it. The browser remembers it. A folded section still opens when it holds the current page.
- The button at the bottom folds the whole sidebar to icons (desktop only; tooltips name the pages; the open-task count shows as a dot). The phone drawer always shows the full sidebar.
- The sidebar is the landmark _Main navigation_. Entries are a little more compact, so the whole sidebar fits on a 900 px high screen.
- Pages without the right are left out, as before; a section without pages disappears.
- Code: `web/src/components/AppNav.tsx` (`NAV_GROUPS`).

![Grouped sidebar](images/ux/nav-after.png)

Before: [nav-before.png](images/ux/nav-before.png).

### Page header, breadcrumbs, 404

- `PageHeader` takes `back` (a sidebar page key, a link, or several). Detail pages show it as a _Breadcrumb_ navigation above the title: Run, record, record editor (Records › CR-2026-0001), record types, monitor, monitor editor, service, dashboard, process editor, platform, system status.
- The title keeps at least 18 rem; the actions wrap below it on narrow screens instead of covering it.

| Before                                                      | After                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| ![Run detail before](images/ux/run-detail-phone-before.png) | ![Run detail after](images/ux/run-detail-phone-after.png) |

### Empty, loading and error states

- `EmptyState`: icon, title, guidance, the primary action for users who may use it (`compact` inside a card). Used on Runs, My tasks, Schedules, Triggers, Monitors, Records, Services, Credentials, Reports, Processes, Dashboards, Platforms and for unknown addresses.
- Filtered lists without matches keep a short "No … match the filter" line, so people do not mistake a filter for an empty register.
- `QueryState`: skeleton rows while a list loads, an error message with _Try again_ when it fails.

| Before                                                  | After                                                 |
| ------------------------------------------------------- | ----------------------------------------------------- |
| ![Monitors before](images/ux/empty-monitors-before.png) | ![Monitors after](images/ux/empty-monitors-after.png) |

### Getting-started checklist

Administrators see a checklist on the start page until every step is done or they hide it (remembered per browser): add a platform, create a process, start a dry run, schedule a process, watch a system with a monitor, document credentials, invite the team, send a summary report. Each step links to the page or straight to its create dialog. A line below points to API tokens for scripts and AI assistants (MCP), the monitor status wall and Ctrl/⌘ K. On an empty demo installation the _Load demo platforms & processes_ button sits inside the checklist.

`GET /api/dashboard` returns the counts (`setup`) only to administrators; other users still see the simple 3-step hint while there is no platform.

![Getting-started checklist](images/ux/getting-started.png)

### Command palette

- Pages show their sidebar section; new pages: monitor status wall, record types, system status (auditors and administrators), About.
- New actions: _New monitor_, _New record_, _New credential entry_, _New service_, _New schedule_ (each only for users who may create it). They open the page with `?new=1`; the page opens its create dialog and removes the parameter.
- New search results: monitors, services, records (number and title) and credential entries (opens the entry).

### Keyboard access

Runs, process, platform and dashboard names, the start-page tiles and the "last run" cells are real links now, so every list can be used with the keyboard.

### Status colours

One colour vocabulary, `TONE` in `web/src/components/common.tsx`, used by runs, tasks, monitors, credentials and check severities (`SeverityBadge`). The label always names the status, so colour is never the only signal.

| Tone      | Colour | Used for                                  |
| --------- | ------ | ----------------------------------------- |
| ok        | green  | succeeded, completed, up, OK              |
| bad       | red    | failed, down, expired, error              |
| attention | orange | interrupted, blocked, overdue, warning    |
| soon      | yellow | degraded, due soon, dry run               |
| active    | blue   | running, maintenance                      |
| person    | violet | waiting for a decision, open task         |
| neutral   | gray   | queued, cancelled, skipped, unknown, info |

Variants: status of a list entry or a lifecycle (runs, tasks, credentials, records) – `light`; a monitor's current state, the main signal on monitor pages – `filled`; a draft or a neutral tag – `outline`. Record statuses keep their own map in `shared/src/records.ts` (also used by the PDFs).

### Tests

- `e2e/navigation.spec.ts`: sections and folding (remembered, opens on its own pages), the icon-only sidebar (with an axe check), breadcrumbs, the 404 page, palette pages, monitor search and "New record", a viewer's sections and actions, the checklist on an empty installation (progress, a step opening its dialog, hiding) and the empty states of nine pages.
- `e2e/mobile.spec.ts`: filters folded on phones; Records, Services and Triggers added to the "no horizontal scroll" checks.
- `server/test/dashboard-setup.test.ts`: the setup counts, and that only administrators get them.

## Backlog

Ordered by value for the effort.

**P1**

1. `confirmDanger()` on `@mantine/modals` instead of `window.confirm()` (finding 10). Update the UI tests that accept the browser dialog.
2. Card layout for the Runs and Records tables on phones (finding 11).
3. Inline validation messages in create dialogs instead of a silently disabled button (finding 12).
4. `QueryState` on detail pages (run, monitor, record, service already show an error but no skeleton).

**P2**

5. A shared data table: sortable columns, "showing N of M / load more", one filter bar position; use `FilterPanel` on Records and Runs too (finding 13).
6. Start-page tiles for monitors down and credentials due (finding 21).
7. A `?` shortcut help dialog and `g`-shortcuts (finding 22).
8. Help / What's new menu in the header: docs, MCP, public API, gateway (finding 23).

**P3**

9. Move record and monitor detail actions into the page header (finding 25).
10. Hide empty template bullets in record previews (finding 20).
11. A one-line footer (finding 24).
