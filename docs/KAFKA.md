# Kafka

Steward checks the Kafka topics an application owns – service-level checks, not a data viewer. It reads topic settings, offsets, consumer groups and schema versions with a **read-only service account**; it never creates, changes or deletes a topic, group or offset, and it reads message content only where you allow it ([Peek](#peek)).

| What                                                                                      | Where                                                                              |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Settings, partitions, newest message, consumer lag and schema version of a topic          | application components of type **Kafka topic** (read every 6 hours, or _Read now_) |
| New messages within N minutes, too much lag, a stuck consumer group, an unexpected schema | monitors with the check type **Kafka topic**                                       |
| The topics of applications against your standards                                         | the example process _Kafka – topic standards_ and the dashboard **Kafka topics**   |
| A schema change with a compatibility check and an approval                                | the example process _Kafka – schema change review_                                 |
| A few recent messages for troubleshooting                                                 | _Peek_ on a topic component (off by default)                                       |

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

Processes see what Steward read as `readout` of each component of an application input – that is how _Kafka – topic standards_ works without calling the cluster.

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

The example _Kafka – schema change review_ takes the subject, the proposed schema and the reason, reads the current version, asks the Schema Registry whether the change is compatible (by the subject's compatibility level) and asks an approver to decide. The run with its approval is the evidence; record the decision as a decision record (_Records → New → DR_) linking the run. Steward does not register the schema – your pipeline does, after approval; start the process from it through a trigger.

## Peek

For troubleshooting, a platform manager can read the newest messages of a topic: the eye icon on a Kafka topic component.

- **Off by default.** The platform's variable `peek = on` turns it on, per platform.
- **Platform managers only** (the platform's _manage_ right), never API tokens without it.
- **At most 5 messages of 4 KB.** Steward reads with a throw-away consumer group (`steward-peek-…`) that commits nothing.
- **Sensitive fields hidden**: JSON fields whose names look like secrets or personal data (password, token, key, e-mail, phone, IBAN, card, name, address, birth date …) become `***`; e-mail addresses, IBANs and card numbers in text are masked too. Binary messages (e.g. Avro) are shown as their size only.
- **Audited**: every read is recorded as `kafka.messages_read` with the topic and the offsets read.

## Demo and tests

Demo mode adds **Kafka (demo)**, a simulated cluster (`server/src/mock/mockKafka.ts`; reached only in demo mode, bootstrap `kafka.demo.invalid:9092`) with the topics `orders` (a consumer group that keeps up and one that is stuck), `payments` (no message for 3 hours) and `shop-events` (compacted), and a Schema Registry. Peek is on in the demo. Tests: `server/test/kafka.test.ts` and the example runs in `server/test/examples.test.ts`.
