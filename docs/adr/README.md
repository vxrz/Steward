# Architecture decision records

Short records of decisions that shape Steward's design: the context, what was decided, and what follows from it. A record is not changed once accepted; a later decision that replaces it gets a new number and marks the old one _Superseded_.

| No.                                                    | Decision                                                | Status                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| [0001](0001-synchronous-db-layer-with-pg-bridge.md)    | Synchronous database layer, PostgreSQL through a bridge | Accepted                                                               |
| [0002](0002-single-active-instance-with-lease-lock.md) | One active instance, held by a lease lock               | Accepted                                                               |
| [0003](0003-hmac-chained-audit-log.md)                 | HMAC-chained audit log with signed checkpoints          | Accepted                                                               |
| [0004](0004-vault-with-master-passphrase.md)           | Credential vault unlocked by a master passphrase        | Accepted                                                               |
| [0005](0005-route-access-declared-on-routes.md)        | Route access declared on the route                      | Accepted                                                               |
| [0006](0006-owning-teams-policy-module.md)             | Owning teams decided in one policy module               | Accepted                                                               |
| [0007](0007-plant-registry.md)                         | The plant registry as an opt-in module                  | Accepted; switch superseded in part by [0016](0016-module-registry.md) |
| [0008](0008-database-platforms.md)                     | Database platforms: direct SQL, read-only               | Accepted                                                               |
| [0009](0009-platform-identities.md)                    | Platform identities: several credentials per platform   | Accepted                                                               |
| [0010](0010-debugging-procedures.md)                   | Debugging procedures: one node, step through, compare   | Accepted                                                               |
| [0011](0011-engine-boundary.md)                        | The engine boundary: start, signal, cancel, query       | Accepted                                                               |
| [0012](0012-quiet-hours-and-digests.md)                | Quiet hours and digests for notifications               | Accepted                                                               |
| [0013](0013-teams-approvals.md)                        | Approvals from Microsoft Teams                          | Accepted                                                               |
| [0014](0014-shared-procedure-libraries.md)             | Shared procedure libraries: signed releases             | Accepted                                                               |
| [0015](0015-map-of-sites.md)                           | A map of sites, tiles served through Steward            | Accepted                                                               |
| [0016](0016-module-registry.md)                        | One module registry: optional areas switched off        | Accepted                                                               |

New record: copy [template.md](template.md) to `NNNN-short-title.md`, fill it in, add it to the table, and link it from [ARCHITECTURE.md](../ARCHITECTURE.md) where it applies.
