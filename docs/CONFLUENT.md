# Confluent Cloud

A platform of kind **Confluent Cloud** reads a Confluent Cloud organisation through its management API – **read-only**, with a Cloud API key:

| What                                                                                                       | Where                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Environments and Kafka clusters (type, cloud, region, availability, status) and the Kafka platform each is | the platform's tab **Clusters** (read every hour, or _Read now_)                       |
| Schema Registry clusters, and the subjects of one with their versions and compatibility                    | the tab **Schemas**                                                                    |
| Fully managed connectors with their tasks and the error of a failed one                                    | the tab **Connectors**, and the Kafka topic components of the cluster's Kafka platform |
| Service accounts and API keys – owner, resource, created, expiry, never a secret                           | the tab **API keys**, and – one by one, reviewed – the credentials register            |
| Clusters provisioned, connectors and tasks running                                                         | monitors with the check type **Confluent Cloud**                                       |
| Who may administer the organisation and read or write which topic (role bindings, ACLs)                    | access checks and person reviews ([below](#access-check))                              |
| What the organisation costs, per cluster, connector and product                                            | platform costs ([below](#costs))                                                       |

For topics, consumer lag and schemas of topics use a **Kafka cluster** platform ([KAFKA.md](KAFKA.md)) with the cluster's bootstrap servers; set its variable `confluentClusterId` to the cluster id (`lkc-…`) and the two are linked.

## Connect

_Platforms → Add platform → Confluent Cloud API (read-only)_:

| Setting                        | Value                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL                       | `https://api.confluent.cloud`                                                                                                             |
| Authentication                 | Basic                                                                                                                                     |
| Credentials `username`         | a **Cloud API key** (resource "Cloud resource management", not a Kafka cluster key)                                                       |
| Credentials `password`         | its secret                                                                                                                                |
| Variable `schemaRegistryUrl`   | optional, for subjects: a Schema Registry's endpoint, `https://psrc-….<region>.<provider>.confluent.cloud` (the tab _Schemas_ lists them) |
| Credentials `registryKey`      | optional, for subjects: an API key **of that Schema Registry**                                                                            |
| Credentials `registrySecret`   | its secret                                                                                                                                |
| Variable `kafkaRestUrl`        | optional, for ACLs: the cluster's REST endpoint, `https://pkc-….<region>.<provider>.confluent.cloud:443` (cluster → Cluster settings)     |
| Variable `clusterId`           | optional, for ACLs: the cluster id, `lkc-…`                                                                                               |
| Credentials `clusterApiKey`    | optional, for ACLs: an API key **of that cluster**                                                                                        |
| Credentials `clusterApiSecret` | its secret                                                                                                                                |

The connection test reads `GET /iam/v2/users?page_size=1`. Every secret is kept in the vault like any platform credential; none appears in an answer, a log line or the audit log.

**Rights.** Create a service account for Steward and give its Cloud API key a role that may read what you want to see – `OrganizationAdmin` reads everything. Listing **API keys** and reading **costs** need `OrganizationAdmin` (costs also `BillingAdmin`); environments, clusters and connectors are readable with `EnvironmentAdmin` on each environment (or a cluster role such as `CloudClusterAdmin`); for access reviews of one environment `EnvironmentAdmin` on it is enough to list its bindings (users and service accounts are organisation-wide lists). The Schema Registry key needs `DeveloperRead` on the subjects; the cluster API key for ACLs needs `DescribeConfigs`/`Describe` on the cluster. A part the key may not read is shown with its error on the platform page – the other parts are still read. _The role names are those of Confluent's documentation as of this writing; check them on your organisation (see [Sources](#sources-and-assumptions))._

**Outbound access.** The base URL (`api.confluent.cloud`) is the platform's own origin and goes through the outbound policy like every platform call – under the policy _Allow-list only_ it must be on the allow-list. The **Schema Registry endpoint** (`psrc-…`) is a regional host and goes through the same rules as any other host: it is allowed when it is another platform's origin (for example the base URL of the Kafka platform that reads the same registry) or on the allow-list (_Settings → Outbound access_); a refusal is the error of the part _Schema Registry subjects_. The cluster's REST endpoint for ACLs counts as the platform's own for the ACL read, as before. Steward never follows a redirect of these reads, and a next page that points to another origin is not followed.

**What Steward changes.** Steward's own readers – the hourly readout, _Read now_, the monitor check, the access and cost reads – only send `GET` requests. Process steps, the explorer and the MCP gateway may call the Cloud API like any platform's, so a process can manage Confluent Cloud through Steward (for example rotate an API key with an approval and evidence). **If Steward should never change anything in Confluent Cloud, mark the platform's identity read-only** ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md), [ADR 0009](adr/0009-platform-identities.md#read-only-identities-what-counts-as-writing)) – or give the Cloud API key a role that can only read. A `secret` field is removed from every answer of the kind – the secret of a key a process creates never reaches Steward's steps, logs or audit –, and a managed connector's configuration and status in an answer have their secret-looking values removed like Kafka Connect's ([KAFKA.md](KAFKA.md#configurations-and-secrets)).

## What Steward reads

Every hour (job `confluent`) and with _Read now_ (who may use the platform), each part on its own:

| Part                     | Request                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environments             | `GET /org/v2/environments`                                                                                                                                                                                          |
| Kafka clusters           | `GET /cmk/v2/clusters?environment=env-…`, per environment                                                                                                                                                           |
| Schema Registry clusters | `GET /srcm/v3/clusters?environment=env-…`, per environment                                                                                                                                                          |
| Service accounts         | `GET /iam/v2/service-accounts`                                                                                                                                                                                      |
| API keys                 | `GET /iam/v2/api-keys` (and `GET /iam/v2/users` to name keys of users)                                                                                                                                              |
| Managed connectors       | `GET /connect/v1/environments/env-…/clusters/lkc-…/connectors?expand=info,status,id`, per cluster that is not being provisioned                                                                                     |
| Schema Registry subjects | with `schemaRegistryUrl` and its key: `GET /subjects` (`offset`/`limit`, 500 at a time), `GET /config`, and for the first 200 subjects `GET /subjects/{subject}/versions` and `GET /config/{subject}` (4 at a time) |

What is kept (table `confluent_readouts`, one row per platform): ids, names, types, regions, states, the tasks of each connector with the trimmed error of a failed one (secret-looking values and the configuration's secret values removed), the topics of its configuration (`topics`, `kafka.topic`) and its connector class – **no configuration** and **no secret**. A part that fails keeps its last values and its error (_Parts that could not be read_); a read that fails as a whole keeps the last readout. Limits: 100 environments, 200 clusters, 2,000 service accounts, 5,000 API keys, 500 connectors per cluster, 2,000 subjects. Clusters and connectors that appear or disappear are recorded in the platform's history (`platform.clusters_changed`, `platform.connectors_changed`).

API: `GET /api/platforms/:id/confluent` (who sees the platform; service accounts and API keys only for who may use it) and `POST /api/platforms/:id/confluent/read` (who may use it). Not in the public API.

**Links.** A cluster belongs to the Kafka platform whose variable `confluentClusterId` is its id – the first by name when several name it, only one the reader may see. A managed connector's topics link to the Kafka topic components of that Kafka platform, and the components list the connector under _Connectors_ like those of Kafka Connect ([KAFKA.md](KAFKA.md#links-topics-databases-systems)).

### Pagination and rate limits

- The Cloud API's lists are **paged with a token**: `page_size` (at most 100, default 10) and `page_token`; the answer's `metadata.next` is the URL of the next page. Steward asks for 100 per page and follows `metadata.next` – only on the API's own origin – for at most 50 pages per list (5,000 items); more fails the part. The Costs API pages the same way.
- The clusters and Schema Registry lists **require** the `environment` parameter, so they are read per environment.
- The connectors list with `expand` is **one map** of name → id, info and status, not paged.
- The Schema Registry pages `/subjects` with `offset` and `limit`.
- **Rate limits**: the Cloud API answers `429 Rate Limit Exceeded` with `Retry-After` (seconds) and `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds until the window resets, relative – not an epoch time). Steward retries a `429` like every platform call (by default 3 times, waiting as `Retry-After` says, at most 30 s; the platform's _Retries_ setting) and sends at most the platform's concurrent requests. A read of the demo organisation makes about 15 requests; an organisation with E environments, C clusters and S subjects about 5 + 2E + C + 2S (S at most 200) per hour.

### Sources and assumptions

Checked (November 2026) against Confluent's OpenAPI descriptions in [confluentinc/ccloud-sdk-go-v2](https://github.com/confluentinc/ccloud-sdk-go-v2) – `org/v2`, `cmk/v2`, `srcm/v3`, `iam/v2`, `apikeys/v2`, `connect/v1`, `billing/v1` and `schema-registry/v1` (`…/api/openapi.yaml`), the specifications the SDK is generated from: the paths and parameters above, `page_size` (default 10, maximum 100; the Costs API default 5,000, maximum 10,000), `page_token`, `metadata.next`, the required `environment`, the `429` answer with its headers, the cluster's `status.phase` (`PROVISIONING`, `PROVISIONED`, `FAILED`) and `spec.config.kind`, the connector states (`NONE`, `PROVISIONING`, `RUNNING`, `DEGRADED`, `FAILED`, `PAUSED`, `DELETED`) and task fields (`id`, `state`, `worker_id`, `msg`), an API key's `spec.secret` ("only provided in `create` responses, not in `get` or `list`"), `spec.expires_at` (a date; the key is valid through 23:59:59Z of it), and `offset`/`limit` and `defaultToGlobal` of the Schema Registry.

The Confluent documentation site (`docs.confluent.io`, e.g. https://docs.confluent.io/cloud/current/api.html) could not be reached from where this was written. **To verify on a real organisation**:

- the request rate the Cloud API allows per key or organisation (Steward only relies on `429` and `Retry-After`);
- the roles named under _Rights_, in particular which role may list connectors and API keys;
- `expand=info,status,id` as one comma-separated value (as the specification's path names it) – the demo accepts it repeated too;
- that `GET /config/{subject}` answers `404` for a subject without a level of its own (Steward then shows the registry's level);
- the API keys list has **no "last used"** field – Steward shows none (Confluent's audit logs or metrics would be needed for it).

## API keys and the credentials register

The tab **API keys** lists every key with its owner (service account or user, by name and id), its resource (`lkc-…` cluster, `lsrc-…` Schema Registry, or the organisation for a Cloud key), when it was created and when it expires, and a hint: **Expired**, **Expires soon** (within 30 days) or **Older than a year – rotate**. Who may add entries to the credentials register ([CREDENTIALS.md](CREDENTIALS.md)) – administrators, designers and operators – can take a key into it with the key button: a new entry of type _API client_ on the platform with the owner, resource, creation and expiry filled in, reviewed and saved by hand. Only metadata goes into it; the secret stays in Confluent Cloud (and wherever the key is used). Service accounts are listed below the keys with the number of keys each has.

## Monitor check

_Monitors → New → Confluent Cloud_ (check type `confluent`, a platform of kind Confluent Cloud – another kind is refused when saving, `CHECK_PLATFORM_KIND`):

| Field           | Meaning                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `target`        | `connectors` (default): the managed connectors and their tasks are `RUNNING`; `clusters`: the Kafka clusters are `PROVISIONED` |
| `resource`      | one connector (name or `lcc-…`) or cluster (`lkc-…` or name); empty: every one of the organisation                             |
| `notRunningAs`  | the status of a `FAILED` cluster, connector or task (default `down`)                                                           |
| `pausedAs`      | the status of a `PAUSED` connector (default `degraded`)                                                                        |
| `failedMinutes` | a failed task is `degraded` until it has failed this long, then `notRunningAs`                                                 |

A cluster being provisioned, a connector `PROVISIONING` or `DEGRADED` is degraded. The check reads Confluent Cloud now, with the rights of the monitor's owner.

```yaml
checks:
  - id: connectors
    type: confluent
    name: Managed connectors running
    platform: Confluent Cloud
    target: connectors
    failedMinutes: 10
```

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

## Costs

The same platform reads the organisation's costs ([COSTS.md](COSTS.md#sources)) from the **Costs API** `GET /billing/v1/costs` – daily lines per cluster, connector and product in US dollars, at most one month per request, complete after 72 hours – once a day when turned on under _Costs → the platform → Source_ (who may manage the platform). The Cloud API key's service account needs the **OrganizationAdmin** or **BillingAdmin** role for it. A cluster's costs belong to the Kafka platform whose variable `confluentClusterId` is the cluster id (`lkc-…`) and so to the application of its topics; other lines – connectors, clusters no Kafka platform names, Stream Governance – stay on the Confluent platform. Who sees which costs follows [COSTS.md](COSTS.md#who-sees-costs).

## Demo and tests

`server/src/mock/mockConfluent.ts` simulates the endpoints at `/mock/confluent` (Cloud API key `CLOUDKEY`, also the Costs API; the demo platform _Confluent Cloud (demo)_) and the Kafka REST API of the cluster `lkc-demo1` at `/mock/confluent/kafka-rest` (key `CLUSTERKEY`), two items per page. The invented organisation has the environments _production_, _development_ and _staging_, the clusters _orders-cluster_ (`lkc-demo1`, Standard on AWS – the cluster of _Kafka (demo)_) and _sandbox_ (`lkc-demo2`, Basic on GCP), four service accounts, five API keys (one old enough to rotate, one expiring soon), the managed connectors _orders-s3-sink_ (topic `orders`), _shop-events-http-source_ (its task failed) and _clickstream-datagen_ (paused), and a Schema Registry whose endpoint is the Kafka demo's registry (`/mock/schema-registry`). Tests: `server/test/confluent.test.ts` (access reviews), `server/test/confluent-readout.test.ts` (readout, rights, read-only, outbound policy, monitor check, costs), `e2e/confluent.spec.ts`.
