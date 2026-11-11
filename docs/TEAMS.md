# Teams and owning teams

One Steward can serve several teams: members of a team see and change their team's resources, while administrators and auditors see everything. You don't have to set anything up for this. **A resource without an owning team behaves exactly as before**, so an upgraded instance keeps its visibility until an administrator assigns teams.

## The model

- A **role** says what someone may do: viewer, operator, designer, approver, auditor or administrator.
- A role applies to the **instance** (the roles on the user) or to a **team** (the roles a member has in that team, set on the team in _Users → Teams_). Within a team's resources, a member has their instance roles _and_ their team roles; the higher one wins.
- A resource's **owning teams** are its scope. A resource can have several owning teams.
- **Allowed** means one of these grants it: an instance role on a resource without owning teams, a role in one of the resource's owning teams, or an access list entry. Rights only add up, and there are no deny rules.
- Administrators may do everything. Auditors may view everything. A resource's own owner (the owner of a process, monitor or dashboard, a document's owner, the named owners of a service or credential, a ticket's responsibles) keeps their rights on it. Naming an owner or responsible from outside the owning teams is a grant across teams: it asks for the step-up ([below](#named-owners-and-responsibles)).

Everyone else does not see a team-owned resource. It answers like one that does not exist (404), and it is left out of lists, search, link pickers, backlinks, start page tiles, the daily summary, reports, evidence packs, the scorecard, the public API and MCP tools.

## What can have owning teams

| Resource                              | Without owning teams                                                  | With owning teams, for members                                    |
| ------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Process (with its schedules and runs) | roles and the access list                                             | team roles; the access list adds exceptions for others            |
| Platform                              | roles and the access list                                             | team roles; the access list adds exceptions for others            |
| Monitor                               | roles and the access list                                             | team roles; the access list adds exceptions for others            |
| Service, application, system          | everybody sees it; designers and owners change it                     | designers among the members change it                             |
| Record, living document               | everybody sees it; editors and the owner change it; approvers approve | editors change it, approvers approve it (four-eyes still applies) |
| Credential                            | readers by role; editors and owners change it                         | members with a reading or editing role                            |
| Dashboard                             | everybody sees it; its owner changes it                               | members see it                                                    |
| Ticket reference                      | everybody sees it; editors and responsibles change it                 | editors change it                                                 |
| Plant registry site (with its assets) | everybody sees it; designers manage it; an access list restricts it   | designers among the members manage it; the access list adds more  |

**Child objects follow their parent.** Components, duties, objectives and CIA ratings follow their service or application; editions, reviews, attachments and links follow their record; schedules and runs follow their process.

**An application without owning teams of its own** belongs to the teams of the services it is part of. If those services belong to two teams, it belongs to both. If it is also part of a service of the whole instance, it belongs to the whole instance. To keep such an application to one team anyway, give it its own owning team: its own teams always win over the ones it would inherit from its services.

### New resources

**New resources** get their creator's teams, but only teams that already own something. A team that owns nothing does not use team scopes yet, so after an upgrade new resources stay the whole instance's. Administrators' new resources get no owning team.

**Suppliers are the exception** (0.18.0, [ADR 0031](adr/0031-supplier-contracts-and-contacts-scope.md)): a new supplier gets no owning team, whoever creates it – the company record is shared by the instance, and the setting below does not apply to it. Each team keeps its own **contracts** with the supplier instead: a new contract's owners are its creator and the creator's teams for new resources, and a team-owned contract is seen only by its owners, the readers of the services it covers, administrators and auditors ([SUPPLIERS.md](SUPPLIERS.md#contracts-and-the-services-they-cover)). An administrator can still restrict a supplier on its _Owning teams_ panel; changing its owning teams there shows a preview first and protects its contracts and contacts ([SUPPLIERS.md](SUPPLIERS.md#shared-suppliers-merging-and-opening)).

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
2. Open a resource and choose its owning teams in the _Owning teams_ panel. It is on the _Access_ tab for processes, platforms, monitors and documents, and on the page itself for services, applications, systems, credentials, dashboards and ticket references.
3. To move a whole service at once, use **Owning teams for the whole service** on the service page (or `POST /api/owning-teams/bulk` with `service`). It covers the service, its applications, the records and ticket references linked to them, and the credentials that belong to them. Preview it first (`preview: true` in the API): for every resource it lists who **gains** and who **loses** visibility, and changes nothing.

Only administrators change owning teams. Adding a team, and removing every team (the resource then belongs to the whole instance), is confirmed with a step-up, like other grants – also in a bulk change. Every change is audited as `access.owning_teams_changed`, and a bulk change audits each resource. A **supplier** in a bulk change gets the same protections as on its own panel: its contracts keep their teams and its contacts their readers ([SUPPLIERS.md](SUPPLIERS.md#shared-suppliers-merging-and-opening)).

**Deleting a team** removes it from owner lists, but an entry that restricts who sees something stays as an entry that matches nobody: access lists and the owners of supplier contracts keep it, so deleting a team never widens anyone's access ([USERS.md](USERS.md)).

**Why do I have access?** On every owning-teams panel, this button shows your rights and where each one comes from, for example "designer in team Orders", "access list team:payments: use", "Named owner (user:vic): view, edit", "Named responsible (team:payments): view, edit" or "Auditor: view". Administrators and auditors can ask the same for any user. Access reviews use the same explanation.

## Named owners and responsibles

The people who change a team's item can name a `user:` or `team:` as its owner or responsible – also one from **outside the owning teams**, for example a contact person in another team. That subject then sees the item and changes it: a grant across teams without an administrator. It stays possible, but it is as deliberate as changing an access list (0.19.0, #195):

- **Covered** subjects need nothing: a member of one of the item's owning teams, or one of those teams itself.
- An item **without owning teams** belongs to the whole instance: naming anyone there grants nothing new, so nothing is asked.
- **Adding** an uncovered subject asks for the **step-up** (_Name an owner or responsible from outside the owning teams_, the baseline control point `access.grant` – [SECURITY-HARDENING.md](SECURITY-HARDENING.md#step-up-re-authentication), [ASSURANCE.md](ASSURANCE.md)). **Removing** one, or keeping one already named, never asks.
- It is audited as an **access change**: `access.named_subjects_granted` on the item, with the field, who was granted (`granted`), what they may do (`rights`) and the owning teams they are outside of (`owningTeams`), and the step-up's proof (`assurance`) – so it appears in the assurance report and the evidence packs that include it. The ordinary change entry (`credential.updated`, `service.updated` …) is written as before.
- **API tokens** cannot confirm, so they are refused (`SESSION_REQUIRED`), as for access lists; a change that only names covered subjects works with a token as before. Every other path – duplicates, suggestions turned into findings, a merge of suppliers – asks the same in the service before it writes anything, so nothing is granted without a confirmation. The public API (`/api/v1`) is read-only.
- The forms say it **before saving**: "user:vic is not in the owning teams (Orders) and will see and change this item" (`POST /api/access/named-outside`, for who may change the item).

| Field                                                          | The item's owning teams                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential: _Owners in Steward_                                | the credential's (a new one: those it gets from its creator)                                                                                    |
| Ticket reference: _Responsible_                                | the ticket reference's (a new one: its creator's)                                                                                               |
| Service, application, system: _Owners_                         | the item's; an application without its own: those of its services (a new one: its creator's)                                                    |
| Supplier: _Owners_                                             | the supplier's (a new supplier has none); also the owners chosen when suppliers are merged                                                      |
| Supplier contract: _Owners_                                    | the teams among the contract's owners; without one, the supplier's (a new contract: its creator's teams for new resources, else the supplier's) |
| Document (record): its owner (hand-over)                       | the record's (`PUT /api/records/:id` with `owner`)                                                                                              |
| Measure of an incident review: _Owners_                        | the review's                                                                                                                                    |
| Duty: _Owners_                                                 | the service's                                                                                                                                   |
| Corrective action: the finding's owner and the actions' owners | the finding's service's (an incident finding's actions: the review's); a finding without a service belongs to the whole instance                |

Not affected: the statement of applicability and maintenance windows have no owning teams (their owners and responsibles are the whole instance's); the owner of a process or monitor and every access list already ask for the step-up on their _Access_ tab; a dashboard's owner is its creator.

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

## Upgrade and migration

- The upgrade only adds columns (`team_members.roles`, `team_members.new_resources`) and tables (`resource_teams`, `team_settings`). No owning team is set and every team starts with the defaults above, so every installation keeps its visibility.
- Migration packages carry team roles, owning teams, team settings and members' choice of team for new resources through the identity mapping.

## API

|                                        |                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/owning-teams/:kind/:id`      | the owning teams (for whoever can see the resource)                                |
| `PUT /api/owning-teams/:kind/:id`      | `{ teamIds }`: set them (administrators)                                           |
| `POST /api/owning-teams/bulk`          | `{ teamIds, mode: set\|add\|remove, resources?: [{kind,id}], service?, preview? }` |
| `GET /api/access/explain?kind&id&user` | the rights of a user and where they come from                                      |
| `POST /api/access/named-outside`       | `{ kind, id?, supplierId?, subjects }`: which are outside the item's owning teams  |
| `GET/PUT /api/me/new-resource-teams`   | the owning teams of your new resources and your choice (`{ teamId \| null }`)      |

`kind` is one of `process`, `platform`, `service`, `application`, `system`, `record`, `credential`, `monitor`, `dashboard` and `ticket`. Report schedules keep their own rule (owner, recipients, auditors and administrators) and have no owning teams.
