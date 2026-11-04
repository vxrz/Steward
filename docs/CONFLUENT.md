# Confluent Cloud access reviews

Who may administer your Confluent Cloud organisation, its environments and clusters, and who may read or write which topic? Steward reads the **role bindings** (Confluent Cloud IAM) and, optionally, the **Kafka ACLs** of a cluster, takes snapshots of them like every access reconciliation check ([COMPLIANCE.md](COMPLIANCE.md)) and includes them in **person reviews** – a leaver's Confluent access is found by their e-mail address next to Insights Hub, Snowflake, Git and AWS.

For topics, consumer lag and schemas use a **Kafka cluster** platform ([KAFKA.md](KAFKA.md)); this platform is only the Confluent Cloud management API.

## Connect

_Platforms → Add platform → Confluent Cloud API (access reviews)_:

| Setting                        | Value                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL                       | `https://api.confluent.cloud`                                                                                                         |
| Authentication                 | Basic                                                                                                                                 |
| Credentials `username`         | a **Cloud API key** (resource "Cloud resource management", not a Kafka cluster key)                                                   |
| Credentials `password`         | its secret                                                                                                                            |
| Variable `kafkaRestUrl`        | optional, for ACLs: the cluster's REST endpoint, `https://pkc-….<region>.<provider>.confluent.cloud:443` (cluster → Cluster settings) |
| Variable `clusterId`           | optional, for ACLs: the cluster id, `lkc-…`                                                                                           |
| Credentials `clusterApiKey`    | optional, for ACLs: an API key **of that cluster**                                                                                    |
| Credentials `clusterApiSecret` | its secret                                                                                                                            |

The connection test reads `GET /iam/v2/users?page_size=1`.

**Rights.** Create a service account for Steward and give its Cloud API key a role that may list role bindings, users and service accounts under the scope you review – `OrganizationAdmin` reads everything; for one environment, `EnvironmentAdmin` on it is enough to list its bindings (users and service accounts are organisation-wide lists). The cluster API key for ACLs needs `DescribeConfigs`/`Describe` on the cluster (a `CloudClusterAdmin` binding of the service account, or an ACL `DESCRIBE CLUSTER`). Steward only reads.

**Outbound access.** `api.confluent.cloud` is the platform's base URL; the cluster's REST endpoint counts as the platform's own for the ACL read. Both go through the outbound policy like every platform call.

## Access check

_Compliance → Access reconciliation → New check_, the Confluent platform, source **Confluent Cloud role bindings and ACLs**, and the **CRN** of what to review:

```text
crn://confluent.cloud/organization=1111aaaa-11aa-11aa-11aa-111111aaaaaa                         the whole organisation
crn://confluent.cloud/organization=…/environment=env-abc12                                     one environment and everything in it
crn://confluent.cloud/organization=…/environment=env-abc12/cloud-cluster=lkc-xyz89             one cluster
crn://confluent.cloud/organization=…/environment=env-abc12/cloud-cluster=lkc-xyz89/kafka=lkc-xyz89/topic=orders
```

The CRN is passed to `GET /iam/v2/role-bindings?crn_pattern=…` (Confluent returns the bindings on it and below it; `environment=*` patterns work as Confluent defines them). It is checked before it is stored – `crn://confluent.cloud/`, `organization=` first, `name=value` parts of known names, values of letters, digits, `- _ . *`, at most 500 characters – by a plain scan, no pattern built from it.

**What a snapshot contains** – one subject per principal:

| Principal       | Subject id                     | Name                               | Type        |
| --------------- | ------------------------------ | ---------------------------------- | ----------- |
| `User:u-abc12`  | the user's e-mail (lower case) | the full name from `/iam/v2/users` | `user`      |
| `User:sa-xyz89` | `sa-xyz89`                     | the display name of the account    | `technical` |
| `User:*`        | `User:*`                       | Every principal                    | `technical` |

and its rights, e.g. `EnvironmentAdmin on environment=env-abc12`, `DeveloperRead on environment=…/cloud-cluster=lkc-…/kafka=lkc-…/topic=orders`, and – with the ACL settings – `ACL ALLOW READ TOPIC:orders`, `ACL ALLOW READ GROUP:order-service*` (`*`: a prefixed ACL). A binding of a user who no longer exists keeps the user id. The user id (`u-…`, `User:u-…`) is kept as an alias, so person reviews match it too.

Every list is read page by page (`metadata.next`, at most 50 pages of 100); a next page that points to another origin is not followed. Like every check, a new binding or ACL that no access change entry documents is a finding.

## Person reviews

_Compliance → Person reviews → New_: name the colleague's e-mail address and choose the Confluent check with the others. Their bindings and ACLs appear next to the rights from the other platforms; the decisions and the removal check work the same ([COMPLIANCE.md](COMPLIANCE.md)). Removing a binding stays a manual step in Confluent Cloud – Steward only reads.

## Demo and tests

`server/src/mock/mockConfluent.ts` simulates the endpoints at `/mock/confluent` (Cloud API key `CLOUDKEY`) and the Kafka REST API of the cluster `lkc-demo1` at `/mock/confluent/kafka-rest` (key `CLUSTERKEY`), two items per page. Tests: `server/test/confluent.test.ts`.
