# Architecture decision records

Short records of decisions that shape Steward's design: the context, what was decided, and what follows from it. A record is not changed once accepted; a later decision that replaces it gets a new number and marks the old one _Superseded_. When a later record replaces only part of one, the old record gets an _Update_ line that points to it.

| No.                                                    | Decision                                                | Status                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| [0001](0001-synchronous-db-layer-with-pg-bridge.md)    | Synchronous database layer, PostgreSQL through a bridge | Accepted                                                               |
| [0002](0002-single-active-instance-with-lease-lock.md) | One active instance, held by a lease lock               | Accepted                                                               |
| [0003](0003-hmac-chained-audit-log.md)                 | HMAC-chained audit log with signed checkpoints          | Accepted, last consequence replaced by 0017                            |
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
| [0017](0017-audit-retention.md)                        | Audit retention: archives keep the chain verifiable     | Accepted                                                               |
| [0018](0018-one-maintenance-window-concept.md)         | One maintenance-window concept; monitors as a source    | Accepted                                                               |
| [0019](0019-data-collections.md)                       | Data collections: what a collector reads, mapped        | Accepted                                                               |
| [0020](0020-plant-change-sets.md)                      | Plant change sets: one path for every change            | Accepted, built in 0.13.0–0.19.0                                       |
| [0021](0021-monitor-states.md)                         | Monitor states and expected statuses                    | Accepted                                                               |
| [0022](0022-privileged-access-checkout.md)             | Privileged access: credentials checked out from a PAM   | Accepted, not built yet                                                |
| [0023](0023-edge-runner.md)                            | Steward edge runner: steps inside an OT segment         | Accepted, not built yet                                                |
| [0024](0024-signed-releases.md)                        | Signed releases: provenance and an update notice        | Accepted, not built yet                                                |
| [0025](0025-personal-teams-notifications.md)           | Personal Teams notifications through the bot            | Accepted                                                               |
| [0026](0026-service-cost-planning.md)                  | Service cost planning per fiscal year                   | Accepted                                                               |
| [0027](0027-backup-contents-and-exports.md)            | Backup contents and scheduled exports                   | Accepted                                                               |
| [0028](0028-plant-proposals-in-parts.md)               | Plant proposals in parts; sources of data points        | Accepted                                                               |
| [0029](0029-iso-27001-support.md)                      | ISO/IEC 27001: suppliers, SoA, corrective actions       | Accepted, built in 0.17.0                                              |
| [0030](0030-contract-payments-and-recorded-costs.md)   | Contract payments, commitments and recorded costs       | Accepted, built in 0.18.0                                              |
| [0031](0031-supplier-contracts-and-contacts-scope.md)  | Shared suppliers: contracts and contacts with own scope | Accepted, built in 0.18.0                                              |
| [0032](0032-cost-attribution-platform-plans.md)        | Cost attribution, platform cost plans and volumes       | Accepted, built in 0.19.0                                              |
| [0033](0033-one-access-model.md)                       | One access model: owning teams and shares               | Accepted, built in 0.21.0 (phase 1)                                    |
| [0034](0034-module-access.md)                          | Who may use a module: module access and roles           | Accepted, built in 0.21.0 (phase 1)                                    |
| [0035](0035-price-books-and-calculators.md)            | Price books, cost drivers and calculators               | Accepted, built in 0.21.0 (phase 1)                                    |
| [0036](0036-data-products-module.md)                   | Data products: data objects, elements, ports, pipelines | Accepted, built in 0.22.0 (phase 1)                                    |

New record: copy [template.md](template.md) to `NNNN-short-title.md`, fill it in, add it to the table, and link it from [ARCHITECTURE.md](../ARCHITECTURE.md) where it applies.
