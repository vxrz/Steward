# 0034. Who may use a module: module access and module roles

- **Status:** Accepted – the owner accepted every recommendation under _Owner decisions_ (2026-11-12); built in 0.21.0 (phase 1: who may use a module) and 0.23.0 (phase 2: module roles, see _Built in 0.23.0_)
- **Date:** 2026-11-12
- **Since:** 0.21.0 at the earliest (phase 1, see _Phases_); builds on [ADR 0016](0016-module-registry.md) and [ADR 0033](0033-one-access-model.md)

## Context

Since 0.11.0 the optional areas of Steward are **modules** in one registry ([ADR 0016](0016-module-registry.md), `shared/src/modules.ts`, `server/src/modules/registry.ts`): compliance, status pages, scorecard, costs, data contracts, AI models, Teams approvals, libraries, version watch, changedetection.io, the plant registry and its map. An administrator switches a module **on or off for the whole instance**: switched off, its routes answer `404 MODULE_OFF` (`PLANT_MODULE_OFF`), its jobs stop, its sidebar entries, tabs, Home tiles, search results, MCP tools (`visible: () => moduleEnabled(…)`) and datasets go; its data stays.

The owner: _"Not every user or team needs a module even if it is active in an instance."_ More modules are coming – data platform and data mesh integrations, quality management, MES, planning and scheduling, PLM – each seen from the IT service teams that run those systems. In an instance shared by several teams, the plant engineers do not need the costs pages, the finance team not the OT network, and a quality team not the data contracts.

What exists today between "on for everyone" and the rights on single items:

- **The plant registry has its own role.** `plant` (_Plant viewer_, #218) is an instance role: `DEFAULT_PLANT` (`server/src/plant/access.ts`) gives it `view` and `propose` on sites without an access list, like operators and approvers; a user whose only working role it is (`plantOnly` in `server/src/auth/policy.ts`) reaches only `/api/plant/…`, their profile and `/api/v1/plant/…` – every other route answers `403 PLANT_VIEWER_ONLY` (`app.ts`), and MCP refuses them. It is not a team role (`TEAM_ROLES` has no `plant`).
- **The status viewer** (`status`) is the same pattern for the status pages: a user with only that role reaches only the routes marked `statusViewer` (`403 STATUS_VIEWER_ONLY`).
- **Every other module** is used by everyone whose core role reaches its data: costs follow the services and platforms, compliance has its own reader rules per area ([COMPLIANCE.md](../COMPLIANCE.md#who-may-do-what)), data contracts their owning teams.
- **`GET /api/me/visibility`** (`server/src/modules/visibility.ts`) already tells the web app per sidebar area whether the person may see or add anything – but only as a consequence of item rights, not as a decision of its own.

So two special roles solve "this person uses only this area" for two modules, and nothing solves "this team does not use this area". Each new module would add a third role or nothing.

**How others do it.** Products that host many applications separate **access to the application** from **rights inside it**:

- **Atlassian Cloud:** _product access_ per app (Jira, Confluence, …) is given to groups in user management – default access groups open it to new users; inside the product, project and space permissions decide per item. Products declare their own roles (user, admin).
- **ServiceNow:** applications live in **scopes** and declare **roles** (e.g. `itil`, `x_vendor_app.user`); the navigator shows an application's menus and modules only to users with one of its roles, and ACLs decide per table and record. Roles are granted to groups and contain other roles.
- **Microsoft Entra ID:** an enterprise application can require **assignment** (_Assignment required?_); users and groups are assigned with the **app roles** the application declares.

The common shape: the outer gate (may this person use the application at all) is coarse, given to groups, and open by default where licences do not force otherwise; the application declares a few roles; item permissions stay inside. Steward has no licences, so the default can stay open.

## Decision

**Four layers, outermost first: the module is on (exists) → the person may use the module (module access: everyone signed in by default, or selected teams and users) → owning teams and shares decide per item ([ADR 0033](0033-one-access-model.md)) → roles decide what the person may do. A module declares its access and, where it owns items, its module roles – viewer, contributor, manager – mapped onto the core rights and granted per user or per team. The plant registry's own role becomes the plant module's roles; nobody gains or loses access.**

### 1. Module access

- Each module that may be restricted has a **module access** setting (_Settings → Modules → <module> → Who may use it_; German _Wer darf es nutzen_): **Everyone signed in** (the default – so an upgrade changes nothing) or **Selected teams and users**. A module whose setting is _Selected_ is **restricted**.
- **Who uses a restricted module:** the users and teams on its list (a team: its members), **administrators always**, **auditors always** (decision 3). SSO groups reach it through the teams they are mapped to (decision 4).
- **Not restrictable:** the status pages (their purpose is to publish; the status viewer role and the link without sign-in stay as they are) and the map of sites (it follows the plant registry). Every new module declares whether it can be restricted.
- A **module-only user** – one whose working grants are all module grants, no core role in the instance or a team – reaches only those modules' routes, their profile and `/api/v1/me`; this generalises `plantOnly` (`moduleOnly` in `server/src/auth/policy.ts`) and keeps its answer `403 PLANT_VIEWER_ONLY` for the plant registry and a general `MODULE_ONLY_USER` for others.

### 2. What a person who does not use a module sees

The same as a switched-off module, with a code of its own, so the web app can say why and an administrator can tell the two apart in the logs:

- **No sidebar entry, tab, Home tile, settings card, connector in _Add platform_ or built-in dataset** of the module; `capabilities.modules` in `GET /api/auth/status` gives per module `on`, `off` or `notYours`, and `GET /api/me/visibility` leaves the module's areas out.
- **Routes** answer `404 MODULE_NO_ACCESS` (`{ module }`) – the internal API and `/api/v1` – decided in the same `app.ts` hook as `MODULE_OFF`, by the matched route, after authentication and before step-up and the route's own code. Its pages say _You do not use this area – an administrator can give you access_ (_Sie nutzen diesen Bereich nicht – ein Administrator kann Ihnen Zugriff geben_), with no link for others than administrators.
- **MCP:** the module's tools are not listed and refuse a call (`visible` and the call check ask `usesModule(user, id)` besides `moduleEnabled`). The OAuth grant and the token act with their owner's module access, checked on every request, so taking access away works at once.
- **Notifications:** the module's events are not sent to a non-user, in no channel; held messages are checked again at release (as `canSeeResource` is); the daily summary and digests leave out the module's sections. A team's own channel gets the module's messages only while the team uses the module (or the module is open).
- **Search, link pickers, backlinks, _Used by_, Home, the start page counts, CSV and YAML exports by a person and evidence packs** leave out the module's items (an evidence pack says `filtered: true`, as for hidden items). Scheduled S3 exports and backups run as the system, as before.
- **Reports** run with the owner's rights: a section of a module the owner does not use is left out. A recipient who does not use a restricted module gets the report without that module's sections – the schedule form says which recipients are affected (decision 12).
- **Core pages that show module data** – a service's _Costs_, _Scorecard_ and _Responsibilities_ tabs, a monitor's cost or data contract check, an application's _Costs and contracts_ – hide those parts for a non-user. An existing monitor check of a module keeps running; its message to a non-user names no module item.

### 3. Links from core items to module items

A core item a person may see can link to an item of a module they do not use – a record to an asset, a ticket reference to a data contract, a service to a supplier contract's schedule. Such a link is **counted, not named**: _an item of a module you do not use_ (_ein Eintrag eines Moduls, das Sie nicht nutzen_), with no title, id, link or kind beyond the module's name. Saving the core item keeps the link (as for hidden contracts in ADR 0031 and hidden profiles in ADR 0033); the person cannot add one. Links from module items to core items follow the core item's own rules.

### 4. Module roles

- A module **may declare roles** when it owns items that core rights do not already cover (the plant registry: sites, assets, profiles, KPI definitions). The vocabulary is fixed: **viewer**, **contributor**, **manager** (_Leser_, _Mitwirkender_, _Verwalter_ – decision 6); a module may declare fewer, never other names. A module whose data follows core items (costs follow services and platforms, version watch follows applications) declares none.
- A module role **maps onto the module's rights** per kind, as `DEFAULT_PLANT` does today: for the plant registry viewer → `view`, contributor → `view`, `propose`, manager → `view`, `propose`, `manage` and the catalogues.
- **Where a person's module role comes from** – the highest of: their **core roles**, mapped by the module (`fromCoreRoles`, which is today's default table, so nothing changes); **module roles granted** to them, to a team they are in, through a mapped SSO group (part 6). Grants only add, as everywhere (ADR 0006).
- **A team's module role** applies module-wide, like an instance role (decision 5): it names the people of the team, not the team's items. Inside items the team owns, its members' core team roles add what they give, as today.
- **Items still decide** (ADR 0033): a module role is the role defaults of the module's kinds; owning teams and shares on a site or profile narrow and widen as for any item. A share of a module item to someone who does not use the module is refused (`SHARE_SUBJECT_UNSUITABLE`, with the hint that they do not use the module).
- **Module settings:** the manager role may change the settings a module declares as content (the plant registry's labels, own fields and enterprise name; future modules' categories); switching the module, its access, connectors with credentials, retention and anything behind a step-up stay with administrators (decision 11).

### 5. The plant role, migrated

| Today                                                                                          | After the upgrade                                                                                                         | Why nobody gains or loses access                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| The plant registry is used by every working role and the `plant` role                          | module access _Everyone signed in_                                                                                        | status viewers are still stopped by their own gate; everyone else reached it before |
| `DEFAULT_PLANT`: designer `manage`, operator and approver `propose`, auditor and viewer `view` | `fromCoreRoles` of the plant module: designer → manager, operator and approver → contributor, auditor and viewer → viewer | the same table, read through the module                                             |
| The instance role `plant`: `view`, `propose`                                                   | a module grant **contributor** on the plant registry for each user who has it                                             | contributor gives exactly `view` and `propose`                                      |
| `plantOnly(u)`: only the registry, the profile, `/api/v1/plant/…`; no MCP                      | `moduleOnly(u)` with the plant module                                                                                     | the same routes; the code `PLANT_VIEWER_ONLY` stays                                 |
| SSO mappings that give the `plant` role                                                        | mappings give the module grant (the role value stays accepted)                                                            | the sign-in sets the same rights                                                    |
| Owning teams and access lists of sites                                                         | unchanged (ADR 0033 turns the lists into shares)                                                                          | module roles replace only the role defaults                                         |

`plant` stays in `ROLES` and in the API as an alias for one release (decision 8); the user form shows _Plant registry: contributor_ instead. A test compares `explain` for every user on every site before and after, as ADR 0033 does for shares. The status viewer becomes the viewer role of the status pages in a later phase, by the same pattern (decision 9).

### 6. SSO groups

The SSO claim mapping already turns a group into teams and roles, synchronised at each sign-in with _Synchronise roles_. Module access names **teams and users**; an SSO group reaches a module **through the team it is mapped to**, so membership, its audit and the access review stay in one place (_Users → Teams_). A mapping may also give module roles directly (a claim value → `plant: contributor`), synchronised like roles; the test sign-in shows the modules and module roles a person would get.

### 7. Who changes module access, and how it is recorded

- **Administrators**, in a signed-in session (API tokens get `SESSION_REQUIRED`). `PUT /api/settings/modules/:id/access` (`{ mode: 'everyone' | 'selected', grants: [{ subject, role? }] }`) and `POST …/access/preview` – who **gains** and who **loses** use of the module, like the owning-teams preview; the dialog also names teams that own items of the module but would not use it.
- **Widening** – opening a restricted module, adding a subject, raising a module role – asks for the step-up `grantAccess` (control point `access.grant`); narrowing is confirmed in the dialog without a step-up, never silently.
- **Audited as access changes:** `access.module_access_changed` (mode, before and after, `granted`, `removed`, the step-up's proof), in the family of ADR 0033 – so it appears in the assurance report and the evidence packs that include access changes.
- **Access reviews and _Why do I have access?_** name the module layer: _Uses Plant registry through team Plant engineering; contributor through team Plant engineering_. `GET /api/access/shared-with?subject=` (ADR 0033) lists module grants too, for leavers and movers.

### 8. Declared in the registry

`ModuleDef` in `shared/src/modules.ts` gains an `access` part, read by the server and the web app alike:

```ts
access?: {
  /** Whether an administrator may restrict it to selected teams and users (status pages and the map: no) */
  restrictable: boolean;
  /** Its roles, if it owns items: the rights each gives per kind of the module */
  roles?: Partial<Record<'viewer' | 'contributor' | 'manager', Record<string, readonly string[]>>>;
  /** The module role each core role gives by default (today's role defaults) */
  fromCoreRoles?: Partial<Record<Role, 'viewer' | 'contributor' | 'manager'>>;
  /** Settings the manager role may change; all others stay administrators' */
  managerSettings?: readonly string[];
  /** What leaves with access: notification events, MCP tools, report sections, export parts, Home tiles */
  events?: readonly string[];
  mcpTools?: readonly string[];
  reportSections?: readonly string[];
  exportParts?: readonly string[];
};
```

`server/test/modules.test.ts` gains: every event, tool, report section and export part of a module is declared (as routes and jobs are checked today), and a non-user gets `MODULE_NO_ACCESS` on every route of a restricted module and sees none of its parts on the surfaces of part 2.

**Data** (additive migrations): `module_access` (`module_id`, `mode`, `updated_by`, `updated_at`) and `module_grants` (`module_id`, `subject` – `user:` or `team:`, the subject strings used elsewhere, so renames, aliases, pseudonymisation and migration packages work through `USER_REFS` – `role` null or a module role, `created_by`, `created_at`; primary key `(module_id, subject)`). A deleted team stays a grant that matches nobody, so deleting a team never widens a restricted module.

**Code:** `server/src/modules/registry.ts` (`usesModule`, `moduleRole`), `server/src/modules/access.ts` (new: store, preview, audit), `app.ts` (the hook), `server/src/auth/policy.ts` (`moduleOnly`, module role defaults in `decide`), `server/src/plant/access.ts` (`DEFAULT_PLANT` read from the module), `server/src/modules/visibility.ts`, `server/src/mcp/tools.ts`, the notification dispatch and the summary, `server/src/auth/sso-claims.ts`; web `web/src/pages/settings/Modules*.tsx` and the user and team forms.

### 9. The modules to come

Data platform and data mesh integrations, quality management, MES, planning and scheduling and PLM each document the systems an IT service team runs – their instances, interfaces, owners, changes and checks – not the shop-floor work itself. Each declares `access` from the start: restrictable, its roles where it owns items (an MES module's lines and interfaces: viewer, contributor, manager), the core roles that map onto them, its events, tools and report sections. A module that only adds platform kinds and reads stays without roles.

## Alternatives considered

1. **One more special role per module** (_Costs viewer_, _MES viewer_, …) like `plant` and `status`. Rejected: the roles multiply with the modules, they cannot be given to a team, and every role needs its own `…_ONLY` gate.
2. **Module access through owning teams** (a module belongs to teams like an item). Rejected: owning teams are the scope of items; a module is not one, and its items have their own owning teams – two meanings of the same panel.
3. **Hiding modules per person in the UI only** (a personal _Hide this area_). Rejected as access: the routes, `/api/v1`, MCP and notifications would still serve the data. Worth adding later as a convenience, never as a control.
4. **Restricted by default for new modules.** Rejected: an upgrade or a new module would lock out people who use it today; administrators restrict deliberately.
5. **Full application scopes as in ServiceNow** (each module with its own tables, ACLs and role hierarchy). Rejected: Steward's modules share the core's items, policy module and audit; one policy module stays (ADR 0006).

## Consequences

- An instance serves several teams without showing each the areas it does not use: fewer entries, fewer messages, a smaller surface – and the same pattern for every module to come.
- `plant` and, later, `status` stop being special cases in the role list; a team can be made plant contributors in one place.
- Every surface that shows module data must ask `usesModule` as it asks `moduleEnabled` today; the registry and its test make the parts explicit, so a forgotten one is a failing test rather than a leak.
- Links across the boundary show _an item of a module you do not use_; people may ask what it is – the answer is an administrator's.
- Revisit when modules become separate packages (ADR 0016), or when licences or quotas per module are needed.

## Security notes

- **The gate is on the server**, in the route hook before the route's code, by the matched route – the web app's hiding is a convenience. `/api/v1`, MCP, notifications and exports apply the same check.
- **No escalation:** module access only narrows what core roles and item rights give; module roles only give the module's declared rights; administrators keep every module so they cannot lock the instance out.
- **Widening is confirmed and audited** (`access.grant`, `access.module_access_changed`); tokens cannot change module access; deleted teams never widen.
- **Tokens and MCP grants** follow their owner's module access on every request; no token is scoped to modules in the first version (decision 13).
- **Non-users learn nothing** of a module's items through links, counts, search, notifications or unique-id refusals of the module (they reach none of its routes); that the module exists and is on is not a secret.

## Phases

1. **0.21.0 – module access:** the setting for every restrictable module, the route hook and `MODULE_NO_ACCESS`, part 2 on every surface, links (part 3), preview, step-up, audit, access reviews, SSO through teams.
2. **0.22.0 (built in 0.23.0) – module roles:** the framework, the plant registry migrated (part 5), module roles per user and team and in the SSO mapping, `moduleOnly`, manager settings.
3. **Later:** the status viewer as the status pages' viewer role; new modules declare `access` from their first release.

## Built in 0.23.0 (phase 2)

Module roles as decided (parts 4–6, decisions 5–8 and 11). Settled while building:

- **One place, read once.** `server/src/modules/grants.ts` reads the module policy – the modes of `module_access` and every row of `module_grants` – in one statement per request or job run (`modulePolicy`), and answers `usesByPolicy`, `moduleRoleOf` (role, where from, and the role from grants alone) and `grantedModuleRoles`. The policy module asks it in `decide()` (`opts.module`): a granted role counts like an instance role – on items without owning teams, access list or _Restricted_, and on an owning team's items for its members. Deciding every site costs the same number of statements however many grants there are (`server/test/module-roles.test.ts`).
- **Declared in the registry.** `access.roles` names the rights per kind (`site`, `device_profile`, `kpi_definition`, `registry` for the plant registry; `costs`; the four data product kinds and `module`), `fromCoreRoles` the defaults, `managerSettings` the content settings. `DEFAULT_PLANT` and `DEFAULT_PLANT_CATALOGUE` are computed from it (`coreRoleDefaults`); tests compare them per module with the tables before 0.23.0 and every user's rights, routes and sidebar before and after the conversion of the role `plant`. The Costs module declares only **manager** (the costs managers of ADR 0035, designers by default); the data products declare all three (ADR 0036 part 12; their team roles keep giving their defaults, as in 0.22.0).
- **Grants.** `module_grants` gained `source` (`modules-003-grant-source`): null for an administrator's grant (the access dialog or the user form edit the same rows), `sso` for one synchronised at sign-in. On a restricted module every grant means "uses it"; open to everyone, only grants with a role are kept. Widening (a new role or a higher one) asks for `access.grant`; every change is `access.module_access_changed` with `roles` and `via` (`userForm`, `sso`, `roleAlias`).
- **The role `plant`** is converted in code once the vault is open (and after a migration package is imported): `convertDeprecatedRoles` reads the roles as JSON, gives a contributor grant (synchronised for accounts of a provider that synchronises roles) and audits each account – an account the restricted plant registry leaves out keeps the role (release review 0.23.0: a grant would put it on the module's list). To keep everyone's rights, `role:plant` entries of access lists and shares, and the catalogue names a plant page shows, still count for whoever is granted contributor or more (`formerRolesOf`). The API accepts the role in `POST`/`PUT /api/users` and SSO mappings with a `Deprecation` header.
- **Manager settings follow a granted manager role only** – a manager role from core roles (designers) gives the module's items, not its settings, so nobody gained settings at the upgrade. The plant registry's are at `GET`/`PUT /api/plant/settings` (signed-in session); the switch stays at `/api/settings/plant`.
- **Module-only users** (`moduleOnlyModules` in `server/src/auth/policy.ts`) generalise the plant viewer: `PLANT_VIEWER_ONLY` for the plant registry, `MODULE_ONLY_USER` otherwise; a status role beside a module role keeps both (`statusOnly`).
- **Not yet:** `GET /api/access/shared-with?subject=` does not list module grants (the shares helper's area); the status viewer as the status pages' viewer role stays phase 3.

## Owner decisions (accepted as recommended)

1. **The default for every module, new ones included.** _Recommendation:_ _Everyone signed in_ – an upgrade and a new module change nothing; administrators restrict deliberately.
2. **Administrators.** _Recommendation:_ always use every module – they switch it and give access; hiding a module from oneself is a personal UI choice, not access.
3. **Auditors.** _Recommendation:_ always use every module as viewers, not configurable – evidence must not depend on who was given a module, and auditors already view every item.
4. **SSO groups.** _Recommendation:_ through teams – the existing claim mapping puts people into teams, and module access names the team; direct module roles from a claim as a shortcut, synchronised at sign-in. No separate group subject.
5. **What a team's grant means.** _Recommendation:_ module-wide, like an instance role – the team names people; inside the team's own items its members' core team roles add as today.
6. **Role names.** _Recommendation:_ viewer, contributor, manager (_Leser_, _Mitwirkender_, _Verwalter_) for every module; a module may declare fewer.
7. **Module roles and core roles together.** _Recommendation:_ the highest of both counts; core roles keep giving today's defaults through `fromCoreRoles`, so nothing changes until someone grants a module role.
8. **The `plant` instance role.** _Recommendation:_ migrated to module grants (contributor) at the upgrade; `plant` stays accepted in the API and SSO mappings for one release, then is removed.
9. **The status viewer.** _Recommendation:_ the same pattern in a later phase – the status pages' viewer role – keeping `STATUS_VIEWER_ONLY`; status pages themselves stay unrestrictable.
10. **Narrowing module access.** _Recommendation:_ confirmed in the dialog with the preview of who loses it, audited, no step-up; widening asks for the step-up.
11. **Module managers and settings.** _Recommendation:_ the manager role changes only the settings a module declares as content; switching, access, connectors with credentials, retention and anything behind a step-up stay with administrators.
12. **Report recipients who do not use a restricted module.** _Recommendation:_ they get the report without that module's sections (one more rendering at most per run); e-mail addresses outside Steward count as not using it; the schedule form names who is affected.
13. **Tokens limited to modules.** _Recommendation:_ not in the first version – a token acts with its owner's module access; revisit when integrations ask for it.
14. **Which modules can be restricted.** _Recommendation:_ every switchable module except the status pages; the map of sites follows the plant registry.
15. **Shares of module items to non-users.** _Recommendation:_ refused with a hint (`SHARE_SUBJECT_UNSUITABLE`); giving module access stays an administrator's decision.
