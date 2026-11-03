# 0006. Owning teams decided in one policy module

- **Status:** Accepted
- **Date:** 2026-11-02
- **Since:** 0.3.0 (#131)

## Context

Several teams share one installation. Processes, platforms, catalogue entries, records, credentials, monitors, dashboards and ticket references needed a scope – "this belongs to the network team" – without breaking installations that never used teams, and with an answer to _why do I have access?_. Spreading team checks over each service would have produced as many slightly different rules as there are resource kinds.

## Decision

A resource can have **owning teams** (table `resource_teams`). One module, `server/src/auth/policy.ts`, decides every right on a resource and returns the reason with it: a **role** says what someone may do; it applies to the instance (the user's roles) or to a team (the roles a member has there). Without owning teams a resource behaves exactly as before (instance roles, optional access list). With owning teams, members of those teams have their instance and team roles on it; everyone else only what an access-list entry gives. Administrators have every right, auditors may view, a process's owner may do everything. Rights only add up – there are no deny rules. Lists read all owning teams of a request once (`withOwningTeams`), so filtering stays one query.

## Consequences

- Every resource kind follows the same rules, and the UI can explain each right (_Why do I have access?_).
- Installations without teams are unaffected; adding a team to a resource narrows who sees it.
- Without deny rules some setups need an access-list entry instead of an exception; this keeps the model predictable.
- A new resource kind must route its checks through `policy.ts` (and the route-access layer, [0005](0005-route-access-declared-on-routes.md)) – adding a private check elsewhere is a review finding.
