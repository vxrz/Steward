# Architecture decision records

Short records of decisions that shape Steward's design: the context, what was decided, and what follows from it. A record is not changed once accepted; a later decision that replaces it gets a new number and marks the old one _Superseded_.

| No.                                                    | Decision                                                | Status   |
| ------------------------------------------------------ | ------------------------------------------------------- | -------- |
| [0001](0001-synchronous-db-layer-with-pg-bridge.md)    | Synchronous database layer, PostgreSQL through a bridge | Accepted |
| [0002](0002-single-active-instance-with-lease-lock.md) | One active instance, held by a lease lock               | Accepted |
| [0003](0003-hmac-chained-audit-log.md)                 | HMAC-chained audit log with signed checkpoints          | Accepted |
| [0004](0004-vault-with-master-passphrase.md)           | Credential vault unlocked by a master passphrase        | Accepted |
| [0005](0005-route-access-declared-on-routes.md)        | Route access declared on the route                      | Accepted |
| [0006](0006-owning-teams-policy-module.md)             | Owning teams decided in one policy module               | Accepted |
| [0007](0007-plant-registry.md)                         | The plant registry as an opt-in module                  | Accepted |
| [0008](0008-database-platforms.md)                     | Database platforms: direct SQL, read-only               | Accepted |

New record: copy [template.md](template.md) to `NNNN-short-title.md`, fill it in, add it to the table, and link it from [ARCHITECTURE.md](../ARCHITECTURE.md) where it applies.
