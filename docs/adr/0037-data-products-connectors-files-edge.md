# 0037. Data products, phase 3: generic parts and bridges, connectors, object storage, edge applications and semantic models

- **Status:** Accepted – the owner agreed with every recommendation of the analysis of 2026-11-13 and asked for generic parts and bridges, connectors and object storage (see _Owner decisions_); to be built in 0.25.0
- **Date:** 2026-11-13
- **Since:** 0.25.0 (planned); builds on [ADR 0036](0036-data-products-module.md) (data products, phases 1 and 2), [ADR 0019](0019-data-collections.md) (data collections), [ADR 0023](0023-edge-runner.md) (edge runner) and [ADR 0009](0009-platform-identities.md) (platform identities)

## Context

Phase 1 (0.22.0) built data products with an element catalogue, ports, steps, health, costs and a scorecard. Phase 2 (0.24.0) adds lineage sources (OpenLineage, dbt, Snowflake object dependencies), quality results, consumers and governance, measured costs and exchange. Five things the owner wants are not covered:

1. **Change data capture and connectors.** Databases reach Kafka or Confluent through **Debezium** source connectors; topics reach Snowflake or object storage through **sink connectors** (the Snowflake Kafka connector, S3 sinks). Steward already reads Kafka Connect and Confluent ([KAFKA.md](../KAFKA.md#kafka-connect-and-debezium)): connectors, tasks and plugins, and it links a Debezium connector to the database platform and system it reads. It keeps **no connector configuration**, so it cannot say which tables become which topics, or which topics land in which Snowflake table – the lineage a data product needs.
2. **File-based data products on object storage.** `files.path` exists as an element kind (0.22.0), entered by hand and never discovered. Products that publish Parquet or CSV files to S3, read by Snowflake through external stages and Snowpipe, have no freshness, volume or lineage.
3. **Edge applications.** An Industrial Edge device runs connector applications (OPC UA, Modbus, S7) that read machines, publish to its Databus, and send data on – for example through an application to Confluent topics. The plant registry and the catalogue already describe most of this (collections with a collector application and a host system, applications that run on systems), but the plant device and the system are not linked, a pipeline step cannot name its host, and Databus or MQTT topics are no data product elements.
4. **Semantic models.** Apache Ossie (incubating, formerly Open Semantic Interchange) describes datasets, fields, relationships and metrics. Steward exports its own API in Ossie and, from 0.24.0, its data objects. Products have no model of their own.
5. **Exports and previews.** Teams may run Apache Camel later; lineage should leave Steward in a standard format; people want to see what a topic carries.

The analysis of 2026-11-13 compared the options with Steward's purpose – a service support and documentation tool that should become the source of truth of auditable records, never the runtime of a pipeline.

## Decision

Phase 3 extends the data products module ([ADR 0036](0036-data-products-module.md)) and the plant registry; it adds no module and no new kind of pipeline entity. Everything stays metadata only, team-scoped, behind module access, and read-only towards the platforms.

### 0. Generic parts and bridges (the foundation)

Technologies come and go faster than Steward can learn to discover them. A product must be describable before Steward knows the technology, and gain discovery later without losing anything.

- **Two roles, not one list per technology.** _Parts_ are where data rests or flows (elements); _bridges_ move data between parts without being a part themselves (steps). Debezium, a Kafka Connect sink, a Node-RED flow, a Camel route or an edge cloud connector are bridges; a Snowflake table, a Confluent topic, an S3 prefix, an API or a Databus topic are parts.
- **Generic element kinds by role** besides the specific, discovered ones: `generic.dataset` (a table-like store), `generic.stream` (a topic, queue or channel), `generic.files` (a file location or object storage prefix), `generic.endpoint` (an API or service interface); `other` stays for the rest. A generic element has a **technology**, a **qualified name** and a **namespace** (its identity and its OpenLineage name, entered by people), and optional **properties** (key: value, like tags – a Node-RED flow id, a Camel route id, a retention). It takes part in everything except discovery: ports and contracts, steps and lineage, checks linked by hand (heartbeat, monitor checks), cost lines matched by tag or resource, the scorecard.
- **A bridge step kind** (`bridge`) besides ingest, transform, replicate …: it moves or replicates data between technologies without changing its meaning – change data capture, sink connectors, flows, routes, edge-to-cloud connectors. Its runner names the technology, the application or connector, and the host it runs on.
- **One technology list** for parts and bridges: built-in entries (Snowflake, Kafka, Confluent, Amazon S3, Debezium, Kafka Connect, Node-RED, Apache Camel, Industrial Edge, MQTT, REST API, dbt, Spark, Airflow …) with a role (part, bridge or both), an icon and an optional OpenLineage namespace pattern; administrators add their own. Pictures, filters and the scorecard use it; free values remain possible and show as "not in the list".
- **Upgrade without loss.** When Steward learns a technology (or a generic element matches a discovered one), _Convert to …_ turns a generic element into the specific kind: same id, ports, contracts, lineage, checks and history; discovery takes over from then on. The conversion is audited.

### 1. Connector lineage: Debezium, Kafka Connect and Confluent

- **Configuration read on an allow-list.** The Kafka Connect and Confluent readouts keep, per connector, only named non-secret keys: `connector.class`, `topics`, `topics.regex`, `topic.prefix` (and the older `database.server.name`), `table.include.list`, `collection.include.list`, `transforms` names and their `topic.regex`/`replacement` (topic routing), `snowflake.database.name`, `snowflake.schema.name`, `snowflake.topic2table.map`, `s3.bucket.name`, `topics.dir`, `format.class`, `flush.size`. Everything else – passwords, keys, URLs with credentials, user names – is never stored; a test asserts the allow-list.
- **Lineage from connectors.** A Debezium source connector yields _table → topic_ edges (`<prefix>.<schema>.<table>`, after routing transforms); a sink yields _topic → Snowflake table_ (the topic-to-table map, else the connector's naming rule) or _topic → `files.path`_ (bucket, `topics.dir`, format). The edges arrive as **proposals** in phase 2's lineage proposal inbox – a person accepts them; nothing changes a product on its own.
- **Steps from connectors.** _Create step from connector_ fills a step with runner _Kafka Connect connector_ (the connector), its inputs and outputs, and the CDC or sink kind. Connector state (running, failed, tasks failing) becomes the step's health through the existing Kafka Connect check.
- **Confluent managed connectors** use the same rules through the Confluent API readout.

### 2. Object storage and file-based products

- **`files.path` discovery on S3** through the AWS account platform: `ListObjectsV2` with a delimiter on the prefixes a product names (never a whole account), metadata only – common prefixes, object count, total size, newest `LastModified`, the format by suffix (Parquet, CSV, JSON, Avro, ORC) and Hive-style partitions. No `GetObject`; the setup grants `s3:ListBucket` on named prefixes only. Limits per run (prefixes, keys read) like the Snowflake discovery.
- **Freshness and volume** of a file element from the newest object and the count/size (the `data-element` check's freshness and volume modes).
- **Links:** a Snowflake external stage (its URL) links to the `files.path` it reads; a pipe reads its stage – so `S3 prefix → stage → pipe → table` is lineage without data access. Iceberg tables on S3 are recorded as `files.path` with format _Iceberg_ for now.
- **File ports** carry the format, partitioning and the ODCS server of type `s3`. Azure Blob Storage and Google Cloud Storage follow the same model when a platform kind for them exists.

### 3. Edge applications and Industrial Edge devices

- **Plant device ↔ system:** an optional link from a plant device to the Steward system it is (an edge device is _equipment_ in the plant and a _host_ in the catalogue). The asset shows **Apps on this device**, the OT network diagram places the applications, and the host name is no longer kept twice.
- **Collects data from:** on a system and on the edge asset, the collections whose collector runs there (collector host, or an application that runs on the system), grouped by source asset; derived, team-scoped.
- **Runs on:** a step runner of kind application or connector names the system (and environment) it runs on – "Modbus Import Client @ IED-BWG01".
- **`mqtt.topic` element kind** for MQTT brokers and the **Industrial Edge Databus**, entered or created from a plant sink (_Create element from this sink_); OpenLineage namespace `mqtt://host:port`. The bridge _Databus topic → application on the edge device → Confluent topic_ is an ordinary step with runner application @ edge system, input `mqtt.topic`, output `kafka.topic`.
- **IEM device id on the system** (external reference): the device status (online within its report interval, firmware) of the Industrial Edge examples shows on the system and the edge asset.
- **Industrial Edge installations readout:** a process reads IEM's devices and installed applications and publishes a dataset; it also compares with the catalogue and offers **suggestions** – _"Device IED-BWG01 has no system – create it?"_, _"OPC UA Connector 1.12 runs on IED-BWG01 but is not recorded – add it?"_ – that a person confirms in an inbox. Steward never fills its inventory by itself (the "no CMDB or discovery" non-goal stands).

### 4. Semantic models (Apache Ossie) as governed records

- Steward is **not the master of metrics** – dbt, Snowflake semantic views or BI tools define them. It keeps the **governed, auditable copy**: one Ossie document per product, stored as written, versioned (who, when, SHA-256), with an optional sign-off like records, so "which model was valid on 1 March, and who approved it" has an answer.
- Linted against the vendored official schema (0.1.1 and the pinned dev revision); findings never block saving. Drafts from bound contracts and data objects (_Start from_), never with metrics. Drift findings on read: sources that are no bound element, columns missing from the contract or schema snapshot, personal fields without an `ai_context` note, metrics naming unknown fields.
- Export as stored, with an environment rewrite of sources; the ODPS output port links it. MCP reads it; proposals are a part of phase 2's `propose_data_product_changes`. Snowflake semantic views (read with `SYSTEM$READ_OSSIE_YAML_FROM_SEMANTIC_VIEW`, a definition, not data) can follow as drafts and comparisons.

### 5. OpenLineage export; Camel later as an import

- **OpenLineage static export** per product and per step (JSON Lines; `JobEvent` per step with the `jobType` facet, `DatasetEvent`s with schema facets from contracts), also on `/api/v1`; hidden inputs are counted in a Steward facet, never named.
- **No Camel code generation.** Steward documents pipelines and runs none; a generated route would be an untested skeleton. When teams run Apache Camel, Camel YAML routes are **imported** as proposed steps (like the Node-RED import). The runner tools _Apache Camel_, _Node-RED_ and _Industrial Edge connector_ exist from 0.24.0.

### 6. Previews

- **Allowed:** contract examples and linked recorded responses (no platform read), and the existing Kafka peek on `kafka.topic` elements and topic bindings – off by default, at most 5 messages of 4 KB, masked, audited without values – which also masks the fields a bound contract marks personal.
- **Not allowed:** sample rows from Snowflake or SQL databases. ADR 0036's "metadata only" stays for them: reading production rows would put personal and business data into Steward and widen its audit and GDPR scope. Revisit only with a concrete need, then with a separate identity on secure views, a step-up, masking and nothing stored.

## Owner decisions (2026-11-13)

1. Metrics: Steward keeps a governed, auditable copy; it is not the master. **Accepted.**
2. Sample rows: examples and the masked Kafka peek only, no SQL or Snowflake rows. **Accepted.**
3. Camel: no export; import when teams run Camel; OpenLineage export instead. **Accepted.**
4. Industrial Edge readout: dataset plus suggestions a person confirms. **Accepted.**
5. Edge model: device ↔ system link, _Collects data from_, _Runs on_, `mqtt.topic`, IEM device id on the system. **Accepted.**
6. Debezium and Kafka Connect lineage, and file-based products on object storage, are part of this phase. **Asked for by the owner.**
7. Generic parts and bridges with one technology list, so technologies Steward does not know yet can be described now and converted later. **Asked for by the owner.**

## Phases (0.25.0)

Four work packages, each with its migrations prefixed by its letter:

- **A – Generic parts, bridges and connectors** (first, the others use it): the generic kinds, the bridge step kind, the technology list, _Convert to …_; configuration allow-list in the Kafka Connect and Confluent readouts, lineage proposals and _Create step from connector_, connector health on steps; OpenLineage export.
- **B – Edge:** device ↔ system, _Collects data from_, _Runs on_, `mqtt.topic`, IEM device id, the installations readout with suggestions, the Databus → Confluent bridge in the demo.
- **C – Object storage:** `files.path` discovery on S3, freshness and volume, stage and pipe links, file ports.
- **D – Semantic models and previews:** Ossie documents per product with versions, sign-off, lint, drafts, drift, export and MCP; contract examples; the Kafka peek on topic elements.

## Security notes

- Every new read is metadata only and goes through the outbound policy; S3 needs list rights on named prefixes only; the connector allow-list is tested so no secret is stored.
- Suggestions and lineage proposals never apply themselves; confirming one needs the right to edit the target, and widening access asks for the `access.grant` step-up as everywhere.
- Team scope and module access on every page, API, export, MCP tool and notification; what the reader may not see is counted, never named.
- The Kafka peek keeps its rules (managers of the platform, off by default, audited without values); it is never offered over MCP or `/api/v1`.

## Consequences

- Lineage from databases through Kafka to Snowflake and object storage, and from machines through edge devices to the cloud, appears in one picture without Steward reading data.
- The Kafka Connect readout stores a few configuration keys it did not keep before; the allow-list must follow new connector types.
- Edge devices are described once in the plant and once in the catalogue, linked; the readout helps keep them current but never decides.
- Revisit when teams run Camel (import), when Azure or GCS storage platforms are added, or when a concrete need for sample rows appears.

## Alternatives considered

- **Camel route export** – rejected: untested skeletons that drift from what runs; Camel K is no longer a supported product (Red Hat, June 2025).
- **Steward as the metric designer** – rejected: metrics need data to test and belong to dbt, Snowflake or BI tools.
- **One element kind per technology only** – rejected: every new technology would wait for a release; generic parts with a technology and _Convert to …_ cover the gap.
- **A new "pipeline" or "edge application" entity** – rejected: collections and steps already describe it (ADR 0036, alternative 6).
- **Automatic inventory from IEM** – rejected: the "no CMDB or discovery" non-goal; suggestions with confirmation instead.
- **Sample rows from SQL and Snowflake** – deferred (see _Previews_).
