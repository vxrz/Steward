# Teams and owning teams

One Steward can serve several teams: members of a team see and change their team's resources, while administrators and auditors see everything. You don't have to set anything up for this. **A resource without an owning team behaves exactly as before**, so an upgraded instance keeps its visibility until an administrator assigns teams.

## The model

- A **role** says what someone may do: viewer, operator, designer, approver, auditor or administrator.
- A role applies to the **instance** (the roles on the user) or to a **team** (the roles a member has in that team, set on the team in _Users → Teams_). Within a team's resources, a member has their instance roles _and_ their team roles; the higher one wins.
- A resource's **owning teams** are its scope. A resource can have several owning teams.
- **Allowed** means one of these grants it: an instance role on a resource without owning teams (unless it is Restricted), a role in one of the resource's owning teams, or a share ([below](#sharing-the-access-tab)). Rights only add up, and there are no deny rules.
- Administrators may do everything. Auditors may view everything – platforms too since 0.23.0 ([ADR 0033](adr/0033-one-access-model.md) decision 8). A resource's own owner (the owner of a process, monitor or dashboard, a document's owner, the named owners of a service or credential, a ticket's responsibles) keeps their rights on it. Naming an owner or responsible from outside the owning teams is a grant across teams: it asks for the step-up ([below](#named-owners-and-responsibles)).

Everyone else does not see a team-owned resource. It answers like one that does not exist (404), and it is left out of lists, search, link pickers, backlinks, start page tiles, the daily summary, reports, evidence packs, the scorecard, the public API and MCP tools. Names are unique, so a new or renamed service, application or supplier cannot take the name of one you may not see: Steward then says only that the name cannot be used (`SERVICE_NAME_TAKEN`, `APPLICATION_NAME_TAKEN`, `SUPPLIER_NAME_TAKEN`), without naming or linking it.

## What can have owning teams

| Resource                              | Without owning teams                                                  | With owning teams, for members                                    |
| ------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Process (with its schedules and runs) | roles, unless Restricted; shares add                                  | team roles; shares add exceptions for others                      |
| Platform (and its identities)         | roles, unless Restricted; shares add                                  | team roles; shares add exceptions for others                      |
| Monitor                               | roles, unless Restricted; shares add                                  | team roles; shares add exceptions for others                      |
| Service, application, system          | everybody sees it; designers and owners change it; shares add         | designers among the members change it; shares add                 |
| Record, living document               | everybody sees it; editors and the owner change it; approvers approve | editors change it, approvers approve it (four-eyes still applies) |
| Credential                            | readers by role; editors and owners change it                         | members with a reading or editing role                            |
| Dashboard                             | everybody sees it; its owner changes it; shares add                   | members see it, designers among them edit it (0.23.0); shares add |
| Ticket reference                      | everybody sees it; editors and responsibles change it                 | editors change it                                                 |
| Plant registry site (with its assets) | everybody sees it; designers manage it, unless Restricted; shares add | designers among the members manage it; shares add more            |
| Device profile, KPI definition        | everyone who sees the plant registry; designers manage it             | members see it, designers among them manage it; shares add more   |

**Child objects follow their parent.** Components, duties, objectives and CIA ratings follow their service or application; editions, reviews, attachments and links follow their record; schedules and runs follow their process.

**An application without owning teams of its own** belongs to the teams of the services it is part of. If those services belong to two teams, it belongs to both. If it is also part of a service of the whole instance, it belongs to the whole instance. To keep such an application to one team anyway, give it its own owning team: its own teams always win over the ones it would inherit from its services.

### New resources

**New resources** get their creator's teams, but only teams that already own something. A team that owns nothing does not use team scopes yet, so after an upgrade new resources stay the whole instance's. Administrators' new resources get no owning team.

**Suppliers are the exception** (0.18.0, [ADR 0031](adr/0031-supplier-contracts-and-contacts-scope.md)): a new supplier gets no owning team, whoever creates it – the company record is shared by the instance, and the setting below does not apply to it. Each team keeps its own **contracts** with the supplier instead: a new contract's owners are its creator and the creator's teams for new resources, and a team-owned contract is seen only by its owners, the readers of the services it covers, administrators and auditors ([SUPPLIERS.md](SUPPLIERS.md#contracts-and-the-services-they-cover)). An administrator can still restrict a supplier on its _Owning teams_ panel; changing its owning teams there shows a preview first and protects its contracts and contacts ([SUPPLIERS.md](SUPPLIERS.md#shared-suppliers-merging-and-opening)).

**Device profiles and KPI definitions** (0.21.0, [ADR 0033](adr/0033-one-access-model.md) decision 9) are the same: a new one gets no owning team, whoever adds it – they describe device models every site may use. A team keeps one to itself deliberately (the _Owning teams_ panel on its _Access_ tab, administrators); an asset that uses a profile its reader may not see still shows the interfaces and data points it delivers, without the profile's name ([PLANT.md](PLANT.md#rights)). A **copy** – _Duplicate_, or a base extracted from profiles (the leading profile's) – gets its original's owning teams, and is Restricted when the original is, never the whole instance's when the original was not; shares are not copied, and who reaches the original only through a share cannot make a copy they would not see (`PLANT_COPY_NOT_VISIBLE`).

Each team can change that in its settings (_Users → Teams_ → settings → _New resources_): **Once the team owns something** (the default, as above), **Always** (from the start, so a new team can begin with its members' own resources) or **Never** (the team only owns what administrators give it).

A member of several teams can choose **one** of them for their new resources in their profile (_Owning team of new resources_); the profile shows which teams new resources get now and whether that is their choice, their teams' default or the whole instance. A team set to _Never_ cannot be chosen, and a choice ends when the member leaves the team. Administrators can choose a team the same way; without a choice their new resources stay the whole instance's.

### Duplicating

_Duplicate_ on monitors, processes, dashboards, credentials register entries, applications, services, schedules, report schedules, maintenance windows, access checks and status pages makes a copy with the same rules everywhere (`POST /api/<kind>/:id/duplicate`):

- **The copy is yours**: it gets your default owning teams (above), whoever owned the original. Duplicating needs the right to see the original and to create that kind.
- **Access settings only for managers**: the original's access list, owners and owning teams are copied only when you may manage the original (_Copy the access settings_; it needs a step-up like granting access). So duplicating never widens anyone's access.
- **No secrets**: heartbeat secrets, webhook trigger secrets, platform credentials, status page links, secret schedule inputs and MCP tokens are never copied – the copy gets new ones (a monitor's heartbeat checks, shown once) or none.
- **New name and key**: suggested (`… (copy)`, `…-copy`, `…-copy-2`) and checked before anything is saved.
- **Nothing of the past**: history, runs, results and the audit trail stay with the original. Schedules, report schedules, maintenance windows and access checks start **disabled**.
- **Where it came from**: the copy shows _Copied from …_ (the original's name only for who may see it), and the audit log has `<entity>.duplicated` with the original's id.

Applications take options: their components (the stack entered by hand; what was read from SBOMs, clusters or repositories is not copied), _runs on_ systems and the documents that apply to them (each document you may change). Services take their applications and the documents they link to. Platform mappings are never copied: a platform belongs to one application.

## Setting it up

1. In _Users → Teams_, create a team per service team, add its members, and give each member their roles in the team (e.g. _designer_ in team Orders, _viewer_ in team Payments).
2. Open a resource and choose its owning teams in the _Owning teams_ panel. It is on the _Access_ tab for processes, platforms, monitors, documents, services, suppliers, device profiles and KPI definitions, and on the page itself for applications, systems (with their shares below it), credentials, dashboards and ticket references.
3. To move a whole service at once, use **Owning teams for the whole service** on the service's _Access_ tab (or `POST /api/owning-teams/bulk` with `service`). It covers the service, its applications, the records and ticket references linked to them, and the credentials that belong to them. Preview it first (`preview: true` in the API): for every resource it lists who **gains** and who **loses** visibility, and changes nothing.

Only administrators change owning teams. Adding a team, and removing every team (the resource then belongs to the whole instance), is confirmed with a step-up, like other grants – also in a bulk change. Every change is audited as `access.owning_teams_changed`, and a bulk change audits each resource. A **supplier** in a bulk change gets the same protections as on its own panel: its contracts keep their teams and its contacts their readers ([SUPPLIERS.md](SUPPLIERS.md#shared-suppliers-merging-and-opening)).

**Deleting a team** removes it from owner lists, but an entry that restricts who sees something stays as an entry that matches nobody: shares and the owners of supplier contracts keep it, so deleting a team never widens anyone's access ([USERS.md](USERS.md)). A new team that takes a deleted team's name – created with it or renamed to it – does not inherit what the deleted team was given: its leftover shares and module grants are removed first, each audited as an access change (`access.share_removed`, `access.module_access_changed`, reason `teamNameReused`); they matched nobody, so nobody loses anything. The same holds for owning teams (0.20.0): a team that owns items together with other teams is just removed from them, but a team that is the **only owning team** of items is not deleted – Steward answers _The team … is the only owning team of n item(s)_ (`TEAM_OWNS_RESOURCES`) – until you name the team they move to (`DELETE /api/teams/{id}?moveTo={teamId}`; `GET /api/teams/{id}/deletion` counts them per kind) or give them other owning teams first. Moving them to a team with members grants those members sight and asks for the step-up of granting access; a team without members keeps them with administrators (and auditors, named owners and access lists where the kind allows). Each moved item is audited as an access change (`access.owning_teams_changed`); a supplier keeps the protections of opening it (its contracts and contacts stay with who saw them).

**Why do I have access?** On every owning-teams panel, this button shows your rights and where each one comes from, for example "designer in team Orders", "Shared with team Payments – View, use", "Named owner (user:vic): view, edit", "Named responsible (team:payments): view, edit" or "Auditor: view". Administrators and auditors can ask the same for any user. Access reviews use the same explanation.

## Sharing: the Access tab

Owning teams are the scope of a resource; **shares** are the exceptions (0.21.0, [ADR 0033](adr/0033-one-access-model.md)). A share gives one subject – a user (`user:dana`), a team (`team:payments`) or, on a Restricted resource, everyone with a role (`role:operator`) – a **level** on one resource:

| Level                    | What it gives                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| **View** (_Ansehen_)     | see the item and everything that follows it                                                  |
| **Edit** (_Bearbeiten_)  | View, and change the item and its children                                                   |
| **Manage** (_Verwalten_) | Edit, and change its shares and name owners from outside its owning teams (only Manage does) |

Kinds with **action rights** offer them beside the level (`use` on a platform, `run` and `approve` on a process, `acknowledge` on a monitor, `propose` on a site, `test` on a data contract) – using a production tenant is not editing it. A share may have an **end date** (at most a year ahead): it stops counting at once when the date has passed, the job removes it (`access.share_expired`), and whoever manages the item is reminded seven days before. Shares only add; there are no deny rules.

The **Access** tab (_Zugriff_) of a resource shows, from top to bottom:

- its **owning teams** with _Why do I have access?_,
- its **scope**: the whole instance, its owning teams, or **Restricted** – no owning team, and roles in the instance give nothing on it: only its shares, its owners, administrators and auditors reach it, and – as on a team's item – only who may change it puts it on a status page or plans its maintenance. Administrators switch it; switching it off asks for the step-up,
- **Shared with** (_Geteilt mit_): the shares, each with its level, action rights and end date; a share whose user or team no longer exists stays as an entry that matches nobody and is marked so,
- the **implied shares** of owners: an owner has _Owner – Edit (implied)_, computed from the owner field and never stored; it is not removable there – removing the owner removes it.

**Who sees the list:** who manages the item, administrators and auditors. Everyone else who sees the item finds only their own reasons in _Why do I have access?_ (for example _Shared with team Payments – View_). A manager who may not list users and teams (a viewer given Manage) sees only their own subjects; the others are **counted, not named** (_And 2 shares with users or teams you may not see_) and kept when the list is saved.

**Changing shares** needs Manage. Nobody shares more than they hold (administrators excepted): a share cannot carry a level or action right its author lacks. Before saving, the tab says **who gains and who loses what** (`POST /api/access/:kind/:id/preview`); a change that gives anyone a right they did not have – a new share, a higher level, a new action right, a later end date, Restricted switched off – asks for the step-up `grantAccess` (control point `access.grant`), and narrowing never does. API tokens cannot change shares at all: share lists name people and are read and changed in the app. **Which kinds:** records and living documents, credentials and ticket references (an owner or responsible implies Edit; Manage by role: designers among the members of a record, designers and operators of a credential, the editors of a ticket reference), dashboards (its owner implies Manage), data contracts (with _test_ and _relax the breaking-change rule_ – the former `manage`, decision 12 – beside the level; Manage by role: designers among the members), processes (with _run_ and _approve_ beside the level), platforms (View or Manage, with _use_), platform identities (View with _use_, changed by who manages the platform, never Restricted), monitors (with _acknowledge_) and plant sites (View or Manage, with _propose_) – 0.23.0, [below](#access-lists-became-shares); services, applications, systems and suppliers, device profiles and KPI definitions (0.21.0; the plant catalogues with the action right _propose_ beside the level, and a Plant viewer reaches the tab of an entry they see – [PLANT.md](PLANT.md#owning-teams-and-shares)). A supplier's share opens its company record, not its team-owned contracts or the contacts scoped to them ([SUPPLIERS.md](SUPPLIERS.md#sharing-a-supplier)). Their children – components, duties, objectives, CIA ratings, links, "runs on" – follow their item. An application without owning teams of its own inherits its services' teams, but **not their shares or scope**. Upgrading changes nobody's access: no share is stored and nothing is Restricted at the upgrade, owners keep exactly their rights through the implied share.

Every change is audited in the access family – `access.share_added`, `access.share_changed`, `access.share_removed`, `access.scope_changed` – with the step-up's proof, so it appears in the assurance report and the evidence packs.

### Access lists became shares

Until 0.22 processes, platforms, platform identities, monitors and plant sites had an **access list** of their own (0.23.0, [ADR 0033](adr/0033-one-access-model.md) phase 2). The upgrade turns every list into shares and changes nobody's rights – a test compares every user's rights on every item before and after, per kind:

- **One share per subject** with exactly the rights of its entries (several entries of one subject add up; entries without rights and `role:admin` entries are dropped – administrators have every right anyway): a process entry `view`, `run` becomes _View + run_, `edit` becomes _Edit_; a monitor's `manage` becomes _Manage + acknowledge_ (it included them); a site's `propose` _View + propose_, its `manage` _Manage_; a platform's `use` _View + use_, its `manage` _Manage + use_; an identity's `use` _View + use_.
- An entry no level and action rights express – a process entry with `manage` but without `edit` – keeps exactly its rights as **Custom** (_Individuell_); the tab shows it so until someone changes the share.
- **An item that had a list is Restricted**: without owning teams a list kept instance roles out, which is what Restricted means; with owning teams nothing changes until the teams are removed, and then it behaves as the list did. Identities stay closed by default.
- The owner of a process or monitor keeps every right, shown as _Owner – Manage (implied)_; who manages the item changes the owner on the same tab (a new owner asks for the step-up).
- A platform gains the right **view** (its page and health): any right on it includes it, as seeing it did before.
- **Who may change it** is who manages it, as before – but, as on every kind, nobody shares more than they hold, a widening asks for the step-up (sites no longer ask when a list only narrows), and changes are session-only. Changes are audited in the access family; `process.access_changed`, `platform.access_changed`, `platform.identity_access_changed`, `monitor.access_changed` and `site.access_changed` are no longer written (the old entries stay).
- The `acl` columns stay as they were and are no longer read; a migration package of an older version gets its lists turned into shares on import the same way.
- **Deprecated for one release:** `PUT /api/processes/:id/access`, `/api/platforms/:id/access`, `/api/platforms/:id/identities/:identityId/access`, `/api/monitors/:id/access` and `/api/plant/sites/:siteId/access` keep their bodies and write shares (a non-empty list makes the item Restricted, an empty one opens it again), answer with a `Deprecation` header and a `Link` to `/api/access/:kind/:id/shares`, and take signed-in sessions only; the `acl` in responses is computed from the shares and shown only to who manages the item. Processes and monitors take `{ owner }` alone there to change the owner. **Automation that sends the whole list:** a body replaces every share of the item – a share given on the _Access_ tab that the list leaves out is removed; a subject that keeps a share keeps its end date (a list cannot say one), so sending back the list a GET answered changes nothing.

**Not every subject can be given a share:** status viewers get none, plant viewers only on the plant registry, and a share of a module's item goes only to users and teams who use that module (`SHARE_SUBJECT_UNSUITABLE` – giving module access stays an administrator's decision, [ADR 0034](adr/0034-module-access.md)).

## Named owners and responsibles

The people who change a team's item can name a `user:` or `team:` as its owner or responsible – also one from **outside the owning teams**, for example a contact person in another team. That subject then sees the item and changes it: a grant across teams without an administrator. It stays possible, but it is as deliberate as changing an access list (0.19.0, #195):

- **Covered** subjects need nothing: a member of one of the item's owning teams, or one of those teams itself.
- An item **without owning teams** belongs to the whole instance: naming anyone there grants nothing new, so nothing is asked – unless it is **Restricted** (services, applications, systems and suppliers since 0.21.0): then every new owner gains access and is asked for.
- On services, applications, systems, suppliers (0.21.0), records, credentials and ticket references (0.23.0) an owner or responsible is an **implied Edit share** ([ADR 0033](adr/0033-one-access-model.md)): it is shown on the _Access_ tab and in _Why do I have access?_ as _Owner – Edit (implied)_, and only who **manages** the item (designers among the members, administrators, Manage shares) names one from outside the owning teams (`FORBIDDEN`, context `nameOutside`, for others). An owner named from outside gets Edit, not Manage, so they cannot name further outsiders.
- **Adding** an uncovered subject asks for the **step-up** (_Name an owner or responsible from outside the owning teams_, the baseline control point `access.grant` – [SECURITY-HARDENING.md](SECURITY-HARDENING.md#step-up-re-authentication), [ASSURANCE.md](ASSURANCE.md)). **Removing** one, or keeping one already named, never asks.
- It is audited as an **access change**: `access.named_subjects_granted` on the item, with the field, who was granted (`granted`), what they may do (`rights`) and the owning teams they are outside of (`owningTeams`), and the step-up's proof (`assurance`) – so it appears in the assurance report and the evidence packs that include it. The ordinary change entry (`credential.updated`, `service.updated` …) is written as before.
- **API tokens** cannot confirm, so they are refused (`SESSION_REQUIRED`), as for access lists; a change that only names covered subjects works with a token as before. Every other path – duplicates, suggestions turned into findings, a merge of suppliers – asks the same in the service before it writes anything, so nothing is granted without a confirmation. The public API (`/api/v1`) is read-only.
- The forms say it **before saving**: "user:vic is not in the owning teams (Orders) and will see and change this item" (`POST /api/access/named-outside`, for who may change the item).

| Field                                                          | The item's owning teams                                                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential: _Owners in Steward_                                | the credential's (a new one: those it gets from its creator)                                                                                                               |
| Ticket reference: _Responsible_                                | the ticket reference's (a new one: its creator's)                                                                                                                          |
| Service, application, system: _Owners_                         | the item's; an application without its own: those of its services (a new one: its creator's)                                                                               |
| Supplier: _Owners_                                             | the supplier's (a new supplier has none); also the owners chosen when suppliers are merged                                                                                 |
| Supplier contract: _Owners_                                    | the teams among the contract's owners; without one, the supplier's (a new contract: its creator's teams for new resources, else the supplier's)                            |
| Supplier contract: a covered platform (0.19.0)                 | the teams among the contract's owners (a contract without a team among its owners: nothing to confirm) – the platform's owning teams and `manage` entries are the subjects |
| Document (record): its owner (hand-over)                       | the record's (`PUT /api/records/:id` with `owner`)                                                                                                                         |
| Measure of an incident review: _Owners_                        | the review's                                                                                                                                                               |
| Duty: _Owners_                                                 | the service's                                                                                                                                                              |
| Corrective action: the finding's owner and the actions' owners | the finding's service's (an incident finding's actions: the review's); a finding without a service belongs to the whole instance                                           |

**Covering a platform** (security review 0.19.0, M1): a platform a team-owned contract covers lets its owning teams' members who see it read the contract and the subjects of its `manage` entries change it. Adding a platform whose owning teams or `manage` entries are outside the contract's teams is therefore a named grant like the others: _Add a platform_ says who will see the contract, adding it asks for the step-up, and it is audited as `access.named_subjects_granted` with field `platforms` (and `platformId`). Payment schedules, plan lines and entries, the CSV import of entries and _Replaced by…_ never add such a platform on the side (`SUPPLIER_CONTRACT_PLATFORM_GRANT`).

The hint for a **new item** (`POST /api/access/named-outside` without `id`) answers only who may create such an item – a supplier contract: who may add one to the supplier; others get `FORBIDDEN` (security review 0.19.0, L6).

Not affected: the statement of applicability and maintenance windows have no owning teams (their owners and responsibles are the whole instance's); a new owner of a process or monitor and every share already ask for the step-up on their _Access_ tab; a dashboard's owner is its creator.

## Example: one team per service

- Teams _Orders_ and _Payments_, each with its developers (team role _designer_) and its on-call engineers (team role _operator_).
- Bulk change with `service: <Order intake>` and `teamIds: [Orders]`, and the same for _Payments_.
- A shared _Intranet_ service stays without an owning team, so everybody keeps seeing it, along with applications that are part of it.
- Platforms used by both teams stay the whole instance's, or get both teams.

## The team's own channel

A team can have its own Teams or webhook channel (_Users → Teams_ → settings): messages about its resources go there, besides the instance channel or instead of it. A team can also set a daily summary for its members and its own report branding. See [SETTINGS.md](SETTINGS.md#team-settings).

Microsoft Teams also reaches people one by one: with the Teams bot on, each person can choose messages that come to their own chat with the Steward app instead of by e-mail (_Profile → Teams (personal)_, [TEAMS-APPROVALS.md](TEAMS-APPROVALS.md#personal-notifications-in-the-chat-preview), [ADR 0025](adr/0025-personal-teams-notifications.md)). A team cannot set this for its members: it is each person's choice.

## Single sign-on

An SSO claim mapping can set team memberships (_Teams_) and, beside them, the **roles in these teams**. On each sign-in with _Synchronise roles_, the member's team roles follow the mapping: they are added, changed, or removed when the mapping no longer gives any.

### Modules through teams

Who may use a restricted module ([MODULES.md](MODULES.md#who-may-use-a-module), [ADR 0034](adr/0034-module-access.md)) names **teams and users**, never SSO groups. A group reaches a module through the team it is mapped to – so membership, its audit trail and the access review stay in one place:

1. _Users → Single sign-on → provider → Groups and roles_: map the group (for example the claim value `plant-engineering`) to a team, `Invented plant engineering`, with _Synchronise roles_ on.
2. _Settings → Modules → Plant registry → Who may use it_: **Selected teams and users**, add the team `Invented plant engineering`. The preview shows who gains and who loses the module before you save.
3. Check it with the provider's **test sign-in**: its preview lists the restricted modules and whether the person would use each (_Uses Plant registry through team Invented plant engineering_).

When the group leaves the token, the next sign-in removes the team membership and with it the module. A deleted team stays on a module's list as an entry that matches nobody, so deleting a team never opens a restricted module. A team that owns items of a module but is not on its list is named in the preview: its members keep their rights on those items but cannot open them.

### Module roles of a team

Since 0.23.0 a team can be given a **module role** – viewer, contributor or manager – in a module that declares them (the plant registry, Costs, data products; [MODULES.md](MODULES.md#module-roles)): _Settings → Modules → <module> → Who may use it_, the role beside the team. It applies to the team's members **across the whole module**, like an instance role – _Invented plant engineering_ as managers of the plant registry manage every site without owning teams or an access list, and the sites their team owns; owning teams, access lists and shares of other items still decide there. The highest of a person's module roles counts (their core roles' default, their own, their teams', single sign-on's). Giving a team a role or a higher one asks for the step-up (`access.grant`) and is an access change in the audit log; leaving the team ends it at once. A single sign-on group reaches a team's module role through the team it is mapped to, or a mapping gives the module role directly ([SSO.md](SSO.md#groups-and-roles)). A deleted team's module role matches nobody, and a new team with its name does not inherit it.

## Upgrade and migration

- The upgrade only adds columns (`team_members.roles`, `team_members.new_resources`) and tables (`resource_teams`, `team_settings`). No owning team is set and every team starts with the defaults above, so every installation keeps its visibility.
- Migration packages carry team roles, owning teams, team settings and members' choice of team for new resources through the identity mapping.
- 0.23.0 turns the access lists of processes, platforms, identities, monitors and sites into shares (`access-001-acl-shares`, [above](#access-lists-became-shares)) – nobody gains or loses a right.

## API

|                                        |                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /api/owning-teams/:kind/:id`      | the owning teams (for whoever can see the resource)                                                                 |
| `PUT /api/owning-teams/:kind/:id`      | `{ teamIds }`: set them (administrators)                                                                            |
| `POST /api/owning-teams/bulk`          | `{ teamIds, mode: set\|add\|remove, resources?: [{kind,id}], service?, preview? }`                                  |
| `GET /api/access/explain?kind&id&user` | the rights of a user and where they come from                                                                       |
| `GET /api/access/:kind/:id/shares`     | the Access tab: scope, owning teams, shares (Manage, administrators, auditors), implied shares, what you may change |
| `PUT /api/access/:kind/:id/shares`     | `{ shares: [{ subject, level, actions?, expiresAt? }] }`: replace them (Manage; a widening asks for the step-up)    |
| `PUT /api/access/:kind/:id/scope`      | `{ restricted }`: switch Restricted (administrators; switching it off asks for the step-up)                         |
| `POST /api/access/:kind/:id/preview`   | `{ shares?, restricted? }`: who would gain and who would lose what, nothing stored                                  |
| `POST /api/access/named-outside`       | `{ kind, id?, supplierId?, subjects }`: which are outside the item's owning teams                                   |
| `GET/PUT /api/me/new-resource-teams`   | the owning teams of your new resources and your choice (`{ teamId \| null }`)                                       |

The deprecated access-list routes are listed [above](#access-lists-became-shares). `kind` is one of `process`, `platform`, `service`, `application`, `system`, `record`, `credential`, `monitor`, `dashboard` and `ticket`. Report schedules keep their own rule (owner, recipients, auditors and administrators) and have no owning teams.
