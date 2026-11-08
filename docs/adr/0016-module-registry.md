# 0016. One module registry: optional areas an administrator switches off

- **Status:** Accepted
- **Date:** 2026-11-08
- **Since:** 0.11.0 – replaces the plant-only switch of [ADR 0007](0007-plant-registry.md) as the general pattern; the plant registry keeps its own setting

## Context

Steward grew from audited procedures into many areas: costs, data contracts, compliance evidence, status pages, a scorecard, Teams approvals, AI models, libraries, a version watch, changedetection.io and the plant registry. Every administrator saw every area. A team that only runs procedures for one platform still got the FinOps pages, the ODCS editor and the scorecard in its sidebar, and the background jobs of all of them ran (cost readers, version lookups, objective samples).

Only the plant registry could be switched off ([ADR 0007](0007-plant-registry.md): off by default, routes answer 404, no sidebar area, _Settings → Modules_). The same pattern was needed for the other areas, without copying it into every module.

The areas also differ a lot in how far they are. The engine and the audit log are tested broadly; most connectors were only tested against Steward's own mock servers. Users could not tell the two apart (review 0.10, P1).

## Decision

**One registry, shared by server and web app.** `shared/src/modules.ts` lists every optional area as a module: id, English name, maturity (`stable`, `beta`, `preview`), whether it is on by default, the module it needs (the map needs the plant registry), its sidebar entries, its web pages (address prefixes), its server routes (route prefixes as registered) and its background jobs. It also holds the maturity of every built-in platform kind and whether it was checked against a real system or only against a mock. [MODULES.md](../MODULES.md) is the table for readers.

**The modules of 0.11.0:** compliance and evidence, status pages, scorecard, costs, data contracts, AI models, approvals in Microsoft Teams, shared procedure libraries, version watch and end of life, changedetection.io, plant registry, map of sites. They are areas a team can do without and that other areas do not need to work. Not modules: processes, runs, platforms, monitors, notifications, the catalogue, documents, credentials, ticket references, duties, the audit log and users – they are the core, or too many other areas link to them. The other connectors (Kubernetes, Kafka, MQTT, …) are not modules either: they are platform kinds, nothing of them runs or shows until someone adds a platform of that kind, and their maturity label covers the honesty part.

**Stored as one internal setting** (`modules.settings`) that names the modules switched **off**. A module missing there is on, so new installations, upgraded installations and modules added later start on. The plant registry keeps its switch in `plant.settings` and the map its tile source in `plant.map` – both off until an administrator turns them on, as before.

**Switched off, a module is gone for everyone, and its data stays** (`server/src/modules/registry.ts`):

- Its routes answer `404 MODULE_OFF` (`PLANT_MODULE_OFF` for the plant registry) – the internal API and its `/api/v1` endpoints. One hook in `app.ts` decides by the matched route, after authentication (a caller who is not signed in learns nothing about the modules) and before step-up and the route's own code.
- Its background jobs are not started (`jobs/registry.ts`); _Run now_ answers `409 MODULE_OFF`, System status shows them as switched off.
- Its connectors are not offered when adding a platform; existing platforms of that kind stay. Its built-in datasets are hidden. The AI step refuses to run, the Teams bot answers 404 and offers no decisions.
- The web app learns the state in `GET /api/auth/status` (`capabilities.modules`): the sidebar, the tabs, Home, the command palette and the settings leave it out; its pages show "This area is switched off – an administrator can turn it on in Settings → Modules" instead of a bare "page not found".
- Nothing is deleted or changed. Switched on again, the data is back as it was.

**Switching is the administrators', in a signed-in session, with a step-up**: `PUT /api/settings/modules/:id`, control point `modules.switch` (on by default, like the other system settings), audited as `module.enabled` / `module.disabled` (the plant registry keeps `plant.module_enabled` / `plant.module_disabled`). Turning the plant registry on or off in its own card asks for the same step-up. No MCP tool belongs to a module today; a tool added to a module later must be left out the same way.

**What a person may see** is decided by the server too (`GET /api/me/visibility`, `server/src/modules/visibility.ts`): per sidebar area, whether the person may see an item or add one, and whether items exist they may not see. The sidebar hides an area with nothing for the person; an empty list says "nothing here you may see" instead of "nothing yet". The answer holds two booleans per area – no counts, no names.

## Consequences

- An installation can be narrowed to what a team uses: fewer entries, fewer jobs, a smaller attack and upgrade surface. A later release can retire an area by switching it off first.
- A new optional area declares itself in the registry once: its routes, jobs and pages follow. `server/test/modules.test.ts` checks that every route prefix matches a real route and that a switched-off module answers 404 everywhere.
- A module's route prefixes must not overlap with the core; a route of the core under a module's prefix would disappear with it. The route matrix (`server/test/route-matrix.test.ts`) runs with every module on.
- Parts of other pages that show a module's data (a tab of a service, a button, a monitor check kind) are hidden in the web app one by one; a monitor check of a switched-off kind that already exists keeps running.
- Maturity is a statement of the maintainers. It is conservative: a connector only tested against a mock is at most beta, areas from 0.9.0 on are preview. It changes when real use or tests show more.
- Revisit when modules need their own tables to be removed on uninstall, or when they move into separate packages (the plant registry, review P10).
