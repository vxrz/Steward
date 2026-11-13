# Kafka

Steward checks the Kafka topics an application owns – service-level checks, not a data viewer. It reads topic settings, offsets, consumer groups and schema versions with a **read-only service account**; it never creates, changes or deletes a topic, group or offset, and it reads message content only where you allow it ([Peek](#peek)).

| What                                                                                      | Where                                                                              |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Settings, partitions, newest message, consumer lag and schema version of a topic          | application components of type **Kafka topic** (read every 6 hours, or _Read now_) |
| New messages within N minutes, too much lag, a stuck consumer group, an unexpected schema | monitors with the check type **Kafka topic**                                       |
| The topics of applications against your standards                                         | the example process _Kafka – Topic standards_ and the dashboard **Kafka topics**   |
| A schema change with a compatibility check and an approval                                | the example process _Kafka – Schema change review_                                 |
| A few recent messages for troubleshooting                                                 | _Peek_ on a topic component (off by default)                                       |
| Connectors and tasks of Kafka Connect (also Debezium), and what they read and write       | platforms of kind **Kafka Connect** – see [below](#kafka-connect-and-debezium)     |
| Clusters, managed connectors, schemas and API keys of Confluent Cloud                     | platforms of kind **Confluent Cloud** – see [CONFLUENT.md](CONFLUENT.md)           |

Works with Confluent Cloud and Confluent Platform, Apache Kafka, Redpanda, Amazon MSK (SASL/SCRAM) and Azure Event Hubs (Kafka endpoint). Steward connects with a pure-JavaScript Kafka client (`@platformatic/kafka`); nothing to install.

## Connect a cluster

_Platforms → New → Kafka cluster (Confluent, read-only)_:

| Setting                                          | Value                                                                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Variable **bootstrap**                           | the bootstrap servers, `host:port`, comma-separated – Confluent Cloud: `pkc-….region.provider.confluent.cloud:9092`               |
| Variable **sasl**                                | `plain` (Confluent API key), `scram-sha-256`, `scram-sha-512`, `oauthbearer` or `none`                                            |
| Variable **tls**                                 | `true` (default); a private CA under the platform's HTTP settings                                                                 |
| Credentials **username** / **password**          | the service account's API key and secret (SASL)                                                                                   |
| Base URL                                         | the Schema Registry, e.g. `https://psrc-….region.provider.confluent.cloud` (optional)                                             |
| Credentials **registryKey** / **registrySecret** | the Schema Registry's own API key (auth type _basic_ on a Kafka platform uses these; username/password stay the SASL credentials) |
| Variable **peek**                                | `off` (default) or `on` – see [Peek](#peek)                                                                                       |

**OAuth (Confluent identity pools):** `sasl = oauthbearer`, the variable `tokenUrl` (your identity provider's token endpoint), optionally `scope`, `logicalCluster` (`lkc-…`) and `identityPoolId` (`pool-…`), and the credentials `clientId` / `clientSecret` – Steward fetches the token with client credentials.

_Test connection_ connects, lists the topics and, with a Schema Registry, its subjects.

**Rights of the service account** (Confluent ACLs or RBAC, read-only):

- `DESCRIBE` and `DESCRIBE_CONFIGS` on the topics,
- `DESCRIBE` on the consumer groups (for their lag),
- `READ` on the topics and on the group prefix `steward-peek-` only if you turn peek on,
- Schema Registry: read on the subjects (Confluent: _DeveloperRead_ on the subjects).

**Outbound access.** Steward reaches the bootstrap servers on exactly their port, and the brokers the cluster names in the same domain (Confluent Cloud: `b0-pkc-….confluent.cloud` for `pkc-….confluent.cloud`). Brokers elsewhere need the outbound allow-list (Settings → Outbound access). Private and metadata addresses are refused unless allow-listed.

## Topics of an application

On the application page, _Components → Add_: type **Kafka topic**, the topic name as name (`orders`), its environment and the **Kafka platform**. Steward reads it every 6 hours – with the rights of whoever last changed the component – and on _Read now_ (refresh icon):

- **Settings**: partitions and replicas, `cleanup.policy`, `retention.ms`, `retention.bytes`, `min.insync.replicas`, `max.message.bytes`, `compression.type`.
- **Offsets**: the sum of the end offsets, and the time of the newest message (Kafka 3.0 and newer).
- **Consumer groups** with committed offsets on the topic and their lag (end offset − committed offset; partitions without a commit count fully), the group with the most lag first.
- **Schema**: the subject `<topic>-value` in the Schema Registry, its latest version, id and type. A new version is recorded in the application's history (`application.topic_schema_changed`).

Processes see what Steward read as `readout` of each component of an application input – that is how _Kafka – Topic standards_ works without calling the cluster.

### Add topics by prefix

Teams often name their topics by a convention (`smo-ie.dev.machines`, `smo-ie.dev.alerts`, …). _Components → Add Kafka topics by prefix_ on the application page:

1. Choose the **Kafka platform** and the **prefix** (`smo-ie.dev.`) and, optionally, the environment the topics belong to.
2. _List the topics_ reads the cluster's topic list (read-only, with the same client as above) and shows every topic whose name **starts with** the prefix – a plain comparison, no pattern; internal topics (`_…`) are left out, at most 500 at once. Topics the application has already (same name and environment) are ticked and greyed.
3. Choose the topics and _Add_: each becomes a **Kafka topic** component with that environment and platform – checked and audited like a component added by hand, and read every 6 hours like the others. Names the cluster does not list under the prefix are refused.

**Keep in sync.** With _Keep in sync_ on, Steward remembers the prefix (at most 20 per application) and reads it again once a day with the rights of the person who set it up. New topics under it that are not components yet are **offered** above the component list – _Add all_ or _Dismiss_ – and in the **daily summary** (section _New Kafka topics_) of everyone who may change the application. Topics listed when the prefix was set up but not chosen are not offered again; dismissed ones neither. _Stop_ ends the sync; the components stay. Everything is in the application's history (`application.topics_added`, `application.topic_prefix_synced`, `application.topics_offered`, `application.topics_dismissed`, `application.topic_prefix_unsynced`).

API: `POST /api/applications/:id/kafka-topics/list` (`{ platformId, prefix, environment }`), `POST /api/applications/:id/kafka-topics` (`{ platformId, prefix, environment, topics, keepInSync }`), `GET /api/applications/:id/topic-prefixes`, `POST …/topic-prefixes/:syncId/check`, `POST …/topic-prefixes/:syncId/dismiss` (`{ topics }`), `DELETE …/topic-prefixes/:syncId`. Who may change the application uses them; the platform must be one they may use.

**Confluent Cloud** itself – its clusters, fully managed connectors, Schema Registry, service accounts, API keys, role bindings for access reviews and its costs – is a separate platform that reads the Cloud API, see [CONFLUENT.md](CONFLUENT.md). Its clusters link to the Kafka platform whose variable `confluentClusterId` is the cluster id (`lkc-…`), and its managed connectors appear on that platform's topic components like Kafka Connect's.

## Monitor check

```yaml
checks:
  - { id: orders, name: Orders arrive, type: kafka, platform: Kafka (prod), topic: orders, messagesWithinMinutes: 10 }
  - { id: billing, name: Billing keeps up, type: kafka, platform: Kafka (prod), topic: orders, group: billing, maxLag: 1000, stuckMinutes: 15 }
  - { id: schema, name: Orders schema, type: kafka, platform: Kafka (prod), topic: orders, schemaVersion: 2 }
```

- `messagesWithinMinutes`: **down** (or `quietAs: degraded`) when the newest message is older. Brokers before Kafka 3.0 cannot say when the newest message came; then Steward notices when the end offsets stop moving, from the second window on.
- `group` with `maxLag`: **degraded** above the lag; **down** when the group is _stuck_ – it has lag and committed nothing for `stuckMinutes` (default 15).
- `schemaVersion`: **degraded** when the latest version of `<topic>-value` is another one – a version registered without review.

The message says what it saw: `Kafka: orders – group billing stuck: lag 3326, no commit for 20 minutes`.

## Schema change review

The example _Kafka – Schema change review_ takes the subject, the proposed schema and the reason, reads the current version, asks the Schema Registry whether the change is compatible (by the subject's compatibility level) and asks an approver to decide. The run with its approval is the evidence; record the decision as a decision record (_Records → New → DR_) linking the run. Steward does not register the schema – your pipeline does, after approval; start the process from it through a trigger.

## Peek

For troubleshooting, a platform manager can read the newest messages of a topic: the eye icon on a Kafka topic component.

- **Off by default.** The platform's variable `peek = on` turns it on, per platform.
- **Platform managers only** (the platform's _manage_ right), never API tokens without it.
- **At most 5 messages of 4 KB.** Steward reads with a throw-away consumer group (`steward-peek-…`) that commits nothing.
- **Sensitive fields hidden**: JSON fields whose names look like secrets or personal data (password, token, key, e-mail, phone, IBAN, card, name, address, birth date …) become `***`; e-mail addresses, IBANs and card numbers in text are masked too. Binary messages (e.g. Avro) are shown as their size only.
- **Audited**: every read is recorded as `kafka.messages_read` with the topic and the offsets read.

## Kafka Connect and Debezium

Where Kafka Connect runs – for example with [Debezium](https://debezium.io/documentation/reference/stable/connectors/index.html) for change data capture – Steward watches it like the other platforms. It **does not** run connectors or capture changes itself, and it **never writes**: no connector is created, changed, restarted, paused, resumed or deleted. A restart may come later as a manual step with four-eyes approval.

### Connect a cluster

_Platforms → New → Kafka Connect (connectors, read-only)_:

| Setting                                                            | Value                                                                                                                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL                                                           | the [Kafka Connect REST API](https://kafka.apache.org/documentation/#connect_rest) of one worker or its load balancer, e.g. `https://connect.example.com:8083`                |
| Variable **kafkaPlatform**                                         | the name or id of the **Kafka platform** of the cluster – for the topic components, a sink's lag and a Debezium connector's topics                                            |
| Credentials **username** / **password**                            | basic sign-in (the REST extension `BasicAuthSecurityRestExtension`, or a proxy in front)                                                                                      |
| Credential **token**                                               | a bearer token (a proxy or gateway in front of the REST API)                                                                                                                  |
| Credentials **tlsCertificate** / **tlsKey** (**tlsKeyPassphrase**) | a client certificate for **mutual TLS** (PEM); a private CA under the platform's HTTP settings – see [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#client-certificate-mutual-tls) |

The account only needs to read (`GET`) – Steward sends nothing else to a Kafka Connect platform, whatever asks: processes, the explorer, the MCP gateway and monitors get `403 PLATFORM_METHOD_DENIED` for `POST`, `PUT`, `PATCH` and `DELETE` – also when another platform sends the request to the Kafka Connect API, and its credentials may only be used in a step on the Kafka Connect connection itself ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#which-rule-checks-which-call)). The base URL goes through the outbound policy like every platform; redirects are not followed.

### What Steward reads

The platform page opens on **Connectors**, read every hour and with _Read now_ (who may use the platform):

- **Connectors** with **type** (source or sink), **class** (`connector.class`), the **version** of its plugin, **state**, the worker it runs on and the **topics** it uses – the active topics Kafka Connect tracks (`GET /connectors/{name}/topics`, Kafka 2.5 and newer), else a sink's `topics`.
- **Tasks** per connector with state and worker; a **failed** task (or connector) with its **error trace**, shortened to 12 lines and 2,000 characters, and since when Steward has seen it failed.
- The installed **connector plugins** with class, type and version.
- A sink's **consumer group**: `connect-<name>`, or `consumer.override.group.id`.

Requests: `GET /`, `GET /connectors?expand=status&expand=info` (one request per connector on Kafka Connect before 2.3), `GET /connectors/{name}/topics`, `GET /connector-plugins`. The readout is kept per platform without any configuration (`kafka_connect_readouts`); connectors that appear or disappear are recorded in the platform's history (`platform.connectors_changed`).

### Configurations and secrets

Connector configurations hold credentials. **Every answer of a Kafka Connect platform** – to the readout, the explorer, process steps, the MCP gateway and recorded responses – has its secret-looking values removed before Steward uses, shows, logs or stores it (`shared/src/kafkaConnect.ts`):

- **By key**: a fixed list compared with the words of the key – `password`, `passwd`, `pwd`, `secret`, `token`, `credential(s)`, `passphrase`, `apikey` / `api.key`, `private.key`, `user.info` (as in `basic.auth.user.info`), `jaas` and `sasl.jaas.config`, and keys ending in `key`, `pass`, `auth` or `headers` (`ssl.key`, `aws.secret.access.key`, `proxy.auth`, the request `headers` of an HTTP sink). `key.converter` or `primary.key.mode` are kept.
- **By value**: private keys (`-----BEGIN …`), JSON Web Tokens and long random-looking strings (32 characters or more of Base64 or hexadecimal) become `***`; passwords in URLs (`jdbc:postgresql://user:***@host/db`), in JDBC URLs without `//` (`jdbc:oracle:thin:scott/***@//db:1521/ORCL`, `user:***@host`), after `Bearer` and `Basic` (`Authorization: Bearer ***`) and in `key=value` pairs (`;password=***`, `Authorization: ***`) are masked. Private keys and JSON Web Tokens are also removed inside lists and nested objects.
- **Kept**: configuration provider references such as `${file:/opt/connect/secrets.properties:db.password}` ([KIP-297](https://kafka.apache.org/documentation/#connect_configproviders)) – they name where a secret is, not the secret. Use them: then Kafka Connect itself never returns the value.
- **Error traces** lose the secret values of the same answer's configurations and everything that looks like a credential (URLs with user info, `password=…`, tokens, keys, e-mail and IP addresses).

_Configuration_ on a connector reads its configuration **now** – it is never stored or cached – for who may use the platform, and records the read in the audit log (`kafka_connect.config_read`, the connector and the number of keys, no values). These are heuristics: when a connector keeps a secret under a key the rules do not know, put it into a configuration provider.

### Links: topics, databases, systems

- **Kafka topics**: a connector's topics link to the **Kafka topic components** of applications on the linked Kafka platform (same topic name); the topic component on the application page lists the connectors that read or write it.
- **Debezium source connectors** (class `io.debezium.connector.<dbms>.…`) link to the **database platform** and the **system** they read. The rule:
  1. From the configuration: the DBMS from the class (`postgresql`, `mysql`, `mariadb`, `sqlserver`, `oracle`, `db2`, …), the host `database.hostname`, the port `database.port` (else the DBMS's default), the databases `database.dbname` (PostgreSQL, Oracle, Db2), `database.names` (SQL Server) or `database.include.list` (MySQL, MariaDB).
  2. **Database platform**: one whose connection (_Platform → Database_) has the same dialect (MariaDB and MySQL are one), the same host (case-insensitive, without a trailing dot) and port, and – when the connector names databases – one of them as its database. Several: the first by name.
  3. **System**: the system that _is_ that database platform; else a system named like the host, or like its first label (`shop-db` for `shop-db.example.internal`).
- **Only what you may see**: a database platform, system, Kafka platform or application you may not see is not named – it reads like no match.

### Monitor check

```yaml
checks:
  - { id: connectors, name: Connectors run, type: kafka-connect, platform: Kafka Connect (prod) }
  - { id: archive, name: Archive sink, type: kafka-connect, platform: Kafka Connect (prod), connector: orders-archive, failedMinutes: 10, maxLag: 10000 }
  - { id: cdc, name: CDC delivers, type: kafka-connect, platform: Kafka Connect (prod), connector: shop-cdc, quietMinutes: 30 }
```

- `connector`: one connector; empty: every connector of the cluster.
- A connector or task **FAILED**: `notRunningAs` (default **down**); with `failedMinutes`, a failed task is **degraded** until it has failed that long. **UNASSIGNED** or **RESTARTING** (a rebalance): degraded. **PAUSED** or **STOPPED**: `pausedAs` (default degraded; `up` for connectors paused on purpose).
- `maxLag`: a **sink connector's** consumer lag on its topics, read on the linked Kafka platform – **degraded** above. Needs the variable `kafkaPlatform` and a Kafka platform the monitor's owner may use; otherwise the message says so and the status is unaffected.
- `quietMinutes`: a **Debezium source connector** none of whose topics got a message for that long – `quietAs` (default degraded). Brokers before Kafka 3.0: when the end offsets stopped moving, from the second window on.

The message says what it saw: `Kafka Connect: orders-archive RUNNING (1/2 tasks) – orders-archive task 1 FAILED for 25 minutes`. An example: [`examples/monitors/63-kafka-connect.yaml`](../examples/monitors/63-kafka-connect.yaml).

## Data products discovery

A discovery source of the data products module ([DATA-PRODUCTS.md](DATA-PRODUCTS.md#discovery)) on a Kafka platform reads the cluster's topics into the element catalogue – all of them, or those under the source's **prefixes** (a plain comparison, as _Add topics by prefix_); internal topics (`_…`) are left out. Per topic: its **topic id** (Kafka 2.8 and newer), partitions, replication, `cleanup.policy` and `retention.ms`, and from the platform's Schema Registry the latest version of the subject `<topic>-value` (its version, id and type – not the schema). Confluent Cloud clusters are discovered through the Kafka platform that connects to them.

- **Requests:** one metadata request for the topic list, then one metadata and one DescribeConfigs request per 200 topics; `GET /subjects` (paged) and `GET /subjects/{subject}/versions/latest` for at most 2,000 subjects per run. No consumer group, no offset, no message – the tests check the calls. The service account's `DESCRIBE` and `DESCRIBE_CONFIGS` on the topics and read on the subjects are enough.
- **A topic created again** under the same name gets a new topic id: it stays the same element with the new id (the catalogue is unique by name). A deleted topic goes missing after a complete run.
- **A Schema Registry that cannot be read** (a wrong key, the outbound policy) does not stop the run: the topics are written without schema versions, and the run says what it could not read.
- The brokers are reached as for every Kafka read (the bootstrap servers, advertised brokers in their domain, otherwise the outbound allow-list, every connection to the checked address); the registry's origin must be allowed by the outbound policy.

## Demo and tests

Demo mode adds **Kafka (demo)**, a simulated cluster (`server/src/mock/mockKafka.ts`; reached only in demo mode, bootstrap `kafka.demo.invalid:9092`) with the topics `orders` (a consumer group that keeps up and one that is stuck), `payments` (no message for 3 hours) and `shop-events` (compacted), and a Schema Registry. Peek is on in the demo. **Kafka Connect (demo)** (`server/src/mock/mockKafkaConnect.ts`) has the Debezium PostgreSQL source `shop-cdc` of the demo database (topics `shop.public.orders` and `shop.public.customers`) and the sink `orders-archive` of `orders`, one of whose tasks failed. For data products discovery every topic has a topic id; tests add thousands of topics, delete or recreate one and read which calls discovery made. Tests: `server/test/kafka.test.ts`, `server/test/kafka-prefix.test.ts` (topics by prefix), `server/test/dataproducts-discovery.test.ts` (discovery), `server/test/kafka-connect.test.ts` (Kafka Connect) and the example runs in `server/test/examples.test.ts`.
