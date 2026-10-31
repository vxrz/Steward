# Teams and owning teams

One Steward can serve several teams: members of a team see and change their team's resources, while administrators and auditors see everything. You don't have to set anything up for this. **A resource without an owning team behaves exactly as before**, so an upgraded instance keeps its visibility until an administrator assigns teams.

## The model

- A **role** says what someone may do: viewer, operator, designer, approver, auditor or administrator.
- A role applies to the **instance** (the roles on the user) or to a **team** (the roles a member has in that team, set on the team in _Users → Teams_). Within a team's resources, a member has their instance roles _and_ their team roles; the higher one wins.
- A resource's **owning teams** are its scope. A resource can have several owning teams.
- **Allowed** means one of these grants it: an instance role on a resource without owning teams, a role in one of the resource's owning teams, or an access list entry. Rights only add up, and there are no deny rules.
- Administrators may do everything. Auditors may view everything. A resource's own owner (the owner of a process, monitor or dashboard, a record's owner, the named owners of a service or credential, a ticket's responsibles) keeps their rights on it.

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

**Child objects follow their parent.** Components, duties, objectives and CIA ratings follow their service or application; editions, reviews, attachments and links follow their record; schedules and runs follow their process.

**An application without owning teams of its own** belongs to the teams of the services it is part of. If those services belong to two teams, it belongs to both. If it is also part of a service of the whole instance, it belongs to the whole instance.

**New resources** get their creator's teams, but only teams that already own something. A team that owns nothing does not use team scopes yet, so after an upgrade new resources stay the whole instance's. Administrators' new resources get no owning team.

## Setting it up

1. In _Users → Teams_, create a team per service team, add its members, and give each member their roles in the team (e.g. _designer_ in team Orders, _viewer_ in team Payments).
2. Open a resource and choose its owning teams in the _Owning teams_ panel. It is on the _Access_ tab for processes, platforms, monitors and records, and on the page itself for services, applications, systems, credentials, dashboards and ticket references.
3. To move a whole service at once, use **Owning teams for the whole service…** on the service page (or `POST /api/owning-teams/bulk` with `service`). It covers the service, its applications, the records and ticket references linked to them, and the credentials that belong to them. Preview it first (`preview: true` in the API): for every resource it lists who **gains** and who **loses** visibility, and changes nothing.

Only administrators change owning teams. Adding a team is confirmed with a step-up, like other grants. Every change is audited as `access.owning_teams_changed`, and a bulk change audits each resource.

**Why do I have access?** On every owning-teams panel, this button shows your rights and where each one comes from, for example "designer in team Orders", "access list team:payments: use" or "Auditor: view". Administrators and auditors can ask the same for any user. Access reviews use the same explanation.

## Example: one team per service

- Teams _Orders_ and _Payments_, each with its developers (team role _designer_) and its on-call engineers (team role _operator_).
- Bulk change with `service: <Order intake>` and `teamIds: [Orders]`, and the same for _Payments_.
- A shared _Intranet_ service stays without an owning team, so everybody keeps seeing it, along with applications that are part of it.
- Platforms used by both teams stay the whole instance's, or get both teams.

## Single sign-on

An SSO claim mapping can set team memberships (_Teams_) and, beside them, the **roles in these teams**. On each sign-in with _Synchronise roles_, the member's team roles follow the mapping: they are added, changed, or removed when the mapping no longer gives any.

## Upgrade and migration

- The upgrade only adds a column (`team_members.roles`) and a table (`resource_teams`). No owning team is set, so every installation keeps its visibility.
- Migration packages carry team roles and owning teams through the identity mapping.

## API

|                                        |                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/owning-teams/:kind/:id`      | the owning teams (for whoever can see the resource)                                |
| `PUT /api/owning-teams/:kind/:id`      | `{ teamIds }`: set them (administrators)                                           |
| `POST /api/owning-teams/bulk`          | `{ teamIds, mode: set\|add\|remove, resources?: [{kind,id}], service?, preview? }` |
| `GET /api/access/explain?kind&id&user` | the rights of a user and where they come from                                      |

`kind` is one of `process`, `platform`, `service`, `application`, `system`, `record`, `credential`, `monitor`, `dashboard` and `ticket`. Report schedules keep their own rule (owner, recipients, auditors and administrators) and have no owning teams.
