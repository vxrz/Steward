# Data contracts

A data contract says what a data source promises: its schema, quality rules, owner, servers and terms. Steward keeps data contracts in the **[Open Data Contract Standard (ODCS) v3](https://bitol-io.github.io/open-data-contract-standard/)** of Bitol (Linux Foundation AI & Data), links them to what it already knows – tables, datasets, applications, systems, API specifications – and tests them through the **[datacontract CLI](https://cli.datacontract.com)** (MIT), which runs as its own container next to Steward. Test results are evidence: every run is stored with its full report, and monitors, the process step, the scorecard and the reports use them.

Where: **Catalogue → Data contracts** (`/data-contracts`). Since 0.9.0 (#221).

## Contents

- [Standards](#standards)
- [Contracts and versions](#contracts-and-versions)
- [Breaking changes](#breaking-changes)
- [Links](#links)
- [Drafts](#drafts)
- [Testing](#testing)
- [Steward's own checks](#stewards-own-checks)
- [Monitors, processes, scorecard and reports](#monitors-processes-scorecard-and-reports)
- [Notifications](#notifications)
- [Import and export](#import-and-export)
- [Rights](#rights)
- [Limits](#limits)
- [The datacontract API next to Steward (compose)](#the-datacontract-api-next-to-steward-compose)
- [Security](#security)
- [Decisions](#decisions)

## Standards

- **ODCS v3** is the format: a contract is a YAML document with `apiVersion`, `kind: DataContract`, `id`, `version`, `status`, `servers`, `schema` (schema objects – tables, topics, API responses – with their properties), `quality` rules, `team`, `slaProperties` and more. Steward stores the YAML exactly as it was saved.
- **Lint on save:** every saved text is checked against the **official JSON Schema of ODCS v3.0.2**, vendored with its Apache 2.0 licence in `server/assets/odcs/` (source: [bitol-io/open-data-contract-standard](https://github.com/bitol-io/open-data-contract-standard), `schema/odcs-json-schema-v3.0.2.json` at commit `448f7b93`). The check runs with [Ajv](https://ajv.js.org) (JSON Schema 2019-09). Findings are stored with the version and shown in the editor while you type; they do not block saving. A contract of a later v3 version (v3.1.0, v3.2.0) is stored too: Steward says it checked it against v3.0.2 only, and **Lint with the service** (the menu of a contract) runs the CLI's own lint against the schema of its version.
- **What blocks saving:** a text that is not YAML, that is not an ODCS v3 contract (`kind: DataContract`, an `apiVersion` v3.x, an `id`), or that is beyond the [limits](#limits).
- **Testing** uses the datacontract CLI's API (`datacontract api`, [API documentation](https://cli.datacontract.com/#api)): `POST /test` and `POST /lint`.

## Contracts and versions

- **A contract** has Steward's id (`dct_…`), the ODCS `id` (shown as _ODCS id_), its name and status (from the current version), its owning teams, links and test settings.
- **Versions:** saving a changed text adds a new version (1, 2, 3 …); an unchanged text adds none. Each version keeps the YAML, its SHA-256, the lint findings, the changes against the version before (breaking ones marked), a note and – when needed – the change record. The **Versions** tab lists them and compares any two: the changes with their breaking marks (**Copy as Markdown** for a change record) and the YAML side by side.
- **Breaking changes need a change record** (optional, per contract, under _Overview → Testing_): a version with a breaking change is then saved only with an **approved change record** – a document of a type with the change workflow (the CR type) in status approved, implemented, verified or closed, that the person saving may read. The version names it.

## Breaking changes

Changes are seen from a consumer of the data. Schema objects are matched by `name`, properties by their path (`customer.address.city`), quality rules by their `id`, else their `name`, else their type and `rule` (or `metric`).

| Change                                                                                                                                                  | Breaking | Why                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------ |
| A schema object or a field removed                                                                                                                      | yes      | consumers read it                    |
| A field added that is `required`                                                                                                                        | yes      | producers must deliver it            |
| `required: true` or `unique: true` added to a field                                                                                                     | yes      | data that was valid is not any more  |
| `logicalType` changed (except `integer` → `number`)                                                                                                     | yes      | values change their meaning          |
| `physicalType` narrowed or changed (`varchar(40)` → `varchar(20)`, `bigint` → `integer`)                                                                | yes      | values may no longer fit             |
| `logicalTypeOptions` narrowed (`maxLength`, `maximum` lower, `minLength`, `minimum` higher; a new or other `pattern`; another `format`)                 | yes      | values may no longer fit             |
| A quality rule added (not of type `text`) or tightened (`mustBeLessThan` lower, `mustBeGreaterThan` higher, `mustBeBetween` narrower, `mustBe` changed) | yes      | a promise was added or made stricter |
| A field or schema object added (optional), a type widened, `required` or `unique` removed                                                               | no       |                                      |
| A quality rule removed or loosened; an SQL rule whose query changed (listed: Steward cannot judge SQL)                                                  | no       |                                      |
| `version`, `status`, servers added or removed                                                                                                           | no       | listed                               |

The [data contract service](#testing) has its own comparison (`/changelog`, `/breaking`); Steward's is the one that decides the change record, so that it works without the service.

## Links

What a contract describes, and which database platform answers for its servers – **Links** tab. One contract can cover several tables or datasets (ODCS v3 has several schema objects): link each to its schema object.

| Kind              | Target                                                                                                   | Used for                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Database table    | a table of a database platform or a system (its latest [schema snapshot](DATABASES.md#database-schemas)) | the column check; the scorecard via the system    |
| Dataset           | a dataset of Steward                                                                                     | the column check                                  |
| Application       | an application of the service catalogue                                                                  | the [scorecard](SCORECARD.md) of its services     |
| System            | a system of the service catalogue                                                                        | the scorecard of the services of its applications |
| API specification | an OpenAPI specification of a platform, optionally one operation                                         | documentation                                     |
| Server            | the **database platform** that answers for one of the contract's servers                                 | [tests](#testing): its host and credentials       |

A link can be made only to what the person may see (a hidden target answers like a missing one); a server link also needs the **use** right on the database platform, because the tests send its credentials. Later readers who may not see a target see that a link exists, without its name or detail.

## Drafts

**New contract → Start from** drafts a contract from what Steward already has – nothing is saved until you choose **Create contract**:

- **Database tables:** the tables and columns of the latest schema snapshot of a database platform or a system (#222): `logicalType` from the column type, `physicalType` as the database writes it, `required` from NOT NULL, the primary key and single-column unique indexes, comments as descriptions. For a database platform the draft also names its server (host, port, database) and links it – when you may use the platform.
- **Dataset:** its columns, with types guessed from up to 200 rows.
- **OpenAPI response:** the response schema (200, 201, … or the first 2xx) of an operation of a platform's OpenAPI description, `$ref`s resolved, nested objects and arrays as nested properties, `required`, formats and lengths kept. A list response describes one item.
- **Recorded response:** a recorded response of a platform (#105), types guessed from its values; a field present and not null in every row is `required`.

Every draft is ODCS v3.0.2 with status `draft`; its warnings say what to review. Patterns from a specification are copied as data – Steward never runs them.

## Testing

Platform kind **Data contract service** (_Platforms → Add platform → Databases_): the datacontract CLI's API, base URL for example `http://datacontract:4242`, credential **API key** (the value of `DATACONTRACT_CLI_API_KEY` of the service, sent as `x-api-key`). A contract names its service and the server to test under _Overview → Testing_.

A test (**Test now**, a [monitor check](#monitors-processes-scorecard-and-reports) or the process step):

1. checks the rights of whoever starts it – the contract's **test** right and the **use** right on the service and on the tested database platform;
2. finds the tested server: the contract's setting, else its only server; it must be **linked to a database platform** of a fitting DBMS (`postgres`/`postgresql`, `mysql`, `sqlserver`) – otherwise the test is refused;
3. checks the **outbound policy** for both: the service's URL like every platform request, and the tested database like a connection of Steward's own (`assertDatabaseAllowed`: the policy, address safety, and **Steward's own database is refused**, [ADR 0008](adr/0008-database-platforms.md));
4. sends `POST /test?server=<name>` with the contract as `application/yaml` and the tested server's connection in the CLI's documented per-request headers – `datacontract-<type>-host`, `-port`, `-database`, `-username`, `-password` (`<type>` is `postgres`, `mysql` or `sqlserver`, [configuration](https://cli.datacontract.com/configuration)). The credentials come from the vault for this request only – **never from or into the contract**. The CLI takes host, port and database from these headers over the contract's `servers` entry, so the service connects where Steward's platform points. Redirects are not followed (the headers carry credentials);
5. stores the answer – the CLI's test run with one check per test – as a **test run** of the contract: result (passed, warnings, failed; `error` when the run itself failed), check counts, the first problems, the full report (at most 2 MB; logs and then checks are cut beyond), its SHA-256, the version and server tested, who started it and how. Every secret of both platforms is masked in the report and the summary. The audit log records `contract.tested` with the result and the report's SHA-256.

Not yet: servers of other types (Snowflake, Databricks, Kafka, S3, API servers …) – the CLI supports them; Steward will map them to its platform kinds in a later step. The CLI's own import formats (SQL DDL, JSON Schema, Avro) are not offered: its API has no import endpoint – use the [drafts](#drafts) or the CLI on the command line.

The **demo** has a simulated service (_Data contract service (demo)_, `server/src/mock/mockDataContract.ts`) that "tests" contracts against the demo shop database, and two contracts: _Shop orders_ holds, _Shop customers_ promises a column the table does not have.

## Steward's own checks

Without the service, on the contract's **Overview** and in the monitor check's `findings` mode:

- **No owner:** no owning team and nobody in the contract's ODCS `team` section (warning).
- **Not tested** for 7 days (the monitor check sets the days), or never (warning).
- **The last test did not pass** (error).
- **Columns that no longer match:** for every linked dataset or table, the top-level fields of its schema object (`physicalName`, else `name`) against the dataset's columns or the table's columns in its latest schema snapshot – fields missing in the source are an error, columns the contract does not name a warning.
- **Lint errors** of the current version (warning).

## Monitors, processes, scorecard and reports

- **Monitor check _Data contract_** (`type: data-contract`, [MONITORS.md](MONITORS.md)): `contract` (Steward's id), `mode: test` (default – runs the test with the monitor owner's rights; passed → up, warnings → `warningAs` (degraded), failed or error → `failAs` (down)) or `mode: findings` (Steward's own checks: an error finding → `failAs`, a warning → `warningAs`; `testedWithinDays`, default 7). A test gets at least a minute, at most 300 s. The check's value names the stored run – the evidence. A test run of the monitor never calls the service: it judges the last stored run.
- **Process step _Test a data contract_** (`type: contractTest`): `contract` (Steward's id or the ODCS id; a template), `server` (optional), `failOnWarning`, `failRun`. It runs with the rights of the run's actor; a test that does not pass marks the step failed (like a check) and the run goes on, unless `failRun`. Dry runs test too (a test only reads) – their run is stored marked as dry run, it neither notifies nor counts as the last test; test runs never call the service. The step's result names the run (`run`, `result`, `checks`, `headline`, `link`).
- **Scorecard part _Data contracts_** ([SCORECARD.md](SCORECARD.md)): the contracts linked to a service's applications or to their systems – attention when one's last test failed or it has an error finding, pending when one was never tested or has other findings, none when no contract is linked (the part is then hidden). Stored in the daily snapshots (`scorecard_snapshots.contracts`) and in `/api/v1` (scorecard `contracts`).
- **Report section _Data contracts_** ([REPORTS.md](REPORTS.md)): per contract the owner of the schedule may see, the tests of the report period (passed · warnings · failed, dry runs left out), the last test, the findings, and the versions saved in the period with their breaking changes.

## Notifications

A test that fails (or ends in an error) after one that did not sends **`contract.failed`** ([NOTIFICATIONS.md](NOTIFICATIONS.md)) to the **members of the contract's owning teams** who may see it – through the event's routes (in the app and by e-mail by default), or, when a scheduled or triggered run's step tested it, through the **notification policy** of that schedule or trigger. The owning teams' own channels get it too. A contract without an owning team: the person who saved it last. Repeated failures do not repeat the message; a passing test resets it. **Opening a vendor ticket stays a person's decision** – link the ticket to the contract's application under Ticket references.

## Import and export

- **Export YAML** (menu of a contract; the Versions tab for older versions): the version's YAML exactly as saved, as `<odcs-id>-v<n>.odcs.yaml`.
- **Import YAML** (the list): a file whose ODCS `id` is that of a contract the person may change becomes its new version (or nothing, when unchanged); otherwise a new contract. Contracts the person may not see are not looked at.
- Example files: `examples/data-contracts/*.odcs.yaml` (`npm run validate` checks them against the JSON Schema).

## Rights

Contracts can have owning teams (kind `contract`, [TEAMS.md](TEAMS.md), `server/src/auth/policy.ts` → `contractAccess`):

| Right  | Without owning teams                                                                   | With owning teams                                         |
| ------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| see    | every role that works in Steward                                                       | members of the teams, auditors, administrators            |
| test   | operators, designers, administrators                                                   | operators and designers among the members, administrators |
| change | designers, administrators                                                              | designers among the members, administrators               |
| create | designers and administrators (instance roles); a new contract gets the creator's teams |                                                           |

A contract the caller may not see answers 404 like a missing one – in the API, links, monitor checks and process steps. Plant and status viewers have no access.

## Limits

| What                           | Limit                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| A contract (YAML)              | 1 MB, 50,000 keys, 32 levels, 100 aliases expanded (a "billion laughs" document is refused) |
| Schema objects / properties    | 500 / 20,000                                                                                |
| Lint findings kept per version | 200                                                                                         |
| Changes listed per comparison  | 2,000 (more are counted)                                                                    |
| Links per contract             | 200                                                                                         |
| A stored test report           | 2 MB (cut beyond, marked)                                                                   |
| Test runs kept per contract    | the newest 500                                                                              |
| A test                         | 120 s by hand and in processes, the monitor's time limit (at least 60 s), at most 300 s     |

YAML is read with the YAML library and the limits of the plant registry import (`server/src/yaml-safe.ts`: size and keys before parsing, duplicate keys found in linear time, aliases capped).

## The datacontract API next to Steward (compose)

Add the service to Steward's `docker-compose.yml` – on an internal network, without a published port, with an API key:

```yaml
services:
  steward:
    # … as in docker-compose.yml
    networks: [default, contracts]

  datacontract:
    # The datacontract CLI as a web service. Pin the release you tested (built against 1.2.9).
    image: datacontract/cli:v1.2.9
    command: ['api', '--host', '0.0.0.0', '--port', '4242']
    restart: unless-stopped
    environment:
      # every request must carry this key (Steward sends it as x-api-key: the platform's credential "API key")
      DATACONTRACT_CLI_API_KEY: ${DATACONTRACT_CLI_API_KEY:?set a long random key}
      # no credentials here: Steward sends the tested server's per request (datacontract-* headers)
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 1g
    # no "ports:" – only Steward talks to it
    networks: [contracts, databases]

networks:
  contracts:
    internal: true # Steward ↔ service only
  databases:
    # the network the tested databases are reachable on; restrict the service's egress to it
    external: true
```

Then add the platform: _Platforms → Add platform → Data contract service_, base URL `http://datacontract:4242`, the same API key. With the outbound policy _allow-list_ add `http://datacontract:4242` to the allow-list; with _platforms_ the platform's own origin is allowed.

The service connects to the tested databases itself: **restrict its egress** (as above, or with your firewall) to the database networks – Steward checks the outbound policy for the database platform before every test, but cannot see the service's own connections. Keep the service's defaults: no environment credentials (`DATACONTRACT_*` passwords), `--no-allow-local-files`, `--no-allow-private-network` (they only concern API servers, which Steward does not test yet). Use TLS between Steward and the service when they do not share a host (a reverse proxy in front of the service, or `--ssl-keyfile`/`--ssl-certfile` of uvicorn).

## Security

- **Credentials never in contracts, reports or logs:** they are read from the vault for one request and sent in headers; contracts never carry them (the ODCS v3.2 `${VAR}` references are not resolved by Steward), stored reports and summaries are masked with every secret of the service and the database platform, the audit log records the result and the report's hash only, and errors of the service are masked the same way. Redirects of the service are not followed.
- **Outbound policy:** the service's URL and the tested database are checked before each test; Steward's own database is refused under every policy.
- **What callers may not see** stays hidden: hidden contracts answer 404; links to hidden targets show neither name nor detail; a hidden service platform is not named; monitor checks and steps refuse a hidden contract like a missing one; the report section and the scorecard count only visible contracts.
- **Untrusted YAML:** size, key, depth and alias limits before and while parsing; the JSON Schema check uses only Steward's vendored schema; nothing compiles a regular expression from a contract (patterns are data); property names from drafts are built as entries (`__proto__` dropped).

## Decisions

- **One contract, several datasets or tables** (open question 1 of #221): ODCS v3 has several schema objects per contract, so a contract is not tied 1:1 to a dataset. Each table or dataset is **linked explicitly** to its schema object; the column check and the drafts work per link.
- **Who hears of failures** (open question 2): failed tests notify the **contract's owning team** through the existing notification routes and policies (event `contract.failed`); **opening a vendor ticket stays a manual action**.
- **Steward's diff decides breaking changes** (not the service's `/breaking`), so that the change record rule works without the service; the JSON Schema of ODCS v3.0.2 is vendored (pinned, offline) rather than fetched.
