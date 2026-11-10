# Writing processes

A process is one service procedure as a flow of steps: read calls, decisions, checks, reports and the writes they lead to. This page explains the parts of a process, how a flow runs, the expressions, every step type, and how to try a process without changing anything. How to build one on the canvas for the first time: [GETTING-STARTED.md](GETTING-STARTED.md#8-build-and-run-the-first-process).

- [Concepts](#concepts)
- [How a flow runs](#how-a-flow-runs)
- [Expressions and templates](#expressions-and-templates)
- [Node types](#node-types)
- [Trying a process safely](#trying-a-process-safely)
- [Templates](#templates)
- [More ways to work with processes](#more-ways-to-work-with-processes)

## Concepts

|                     |                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Process**         | A versioned flow of nodes and wires. It declares connection slots (e.g. `hub`, kind `insights-hub`), inputs (number, text, list, CSV table, …) and constants (e.g. group bundles). Every save creates a new version with author, comment and hash.                                                                                                                                                             |
| **Run**             | One execution of a pinned process version, manual or scheduled, real or dry. It has a full step journal, logs, decisions, checks, reports and evidence. Whether it executed and what it found are kept apart: a run that executed every step but whose checks failed shows **Completed with findings** (amber) – its status stays `succeeded` – and its failed checks are its _findings_, with their severity. |
| **Task**            | A decision a run is waiting for: select items or approve/reject. Tasks are listed in **My tasks** and on the run page.                                                                                                                                                                                                                                                                                         |
| **Schedule**        | Cron plus time zone, with preset inputs and connections. It skips a new run while the previous one is still waiting, unless overlap is allowed. The editor shows the next runs and warns when day of month and day of week are both set: cron then runs when **either** matches, so “the first Monday” is `0 6 * * 1#1`, not `0 6 1-7 * 1`.                                                                    |
| **Webhook trigger** | `POST /api/hooks/<id>` with a secret starts a process as the trigger's owner; inputs are mapped from the JSON body, allow-listed headers and the query with JSONata. See [GATUS.md](GATUS.md#webhook-trigger-reference).                                                                                                                                                                                       |

Who may view, run, edit, approve or manage a process is set by roles and its access list: [USERS.md](USERS.md#process-access-list). Platforms and connection slots: [PLATFORMS.md](PLATFORMS.md).

Processes are built on the canvas or as YAML (_Source_ tab, or _Import YAML_).

## How a flow runs

Execution starts at the _Start_ node and follows the wires, depth first. When an output has several wires, the targets run one after another, top to bottom as placed on the canvas.

- **Outputs.** A node fires one of its outputs:
  - _if_ fires `true` or `false`.
  - _for each_ runs everything wired to `each item` once per item, then continues on `done`. Leave the last node of the loop body unconnected.
  - An approval fires `approved` or `rejected`. If `rejected` is not connected, a rejection fails the run.
  - A manual step (user task in mode _manual_) fires `out` once it is done – and verified by a second person when it asks for that. See [MANUAL-STEPS.md](MANUAL-STEPS.md).
  - API call and browser nodes fire `error` instead of failing the run if that output is connected.
- **Joins and cycles.** A node reached from both branches of an _if_ runs once. Wires may not form cycles; use _for each_ for repetition.
- **Skipped nodes.** A node whose _Only run when_ condition is false is skipped and passes the flow on.
- **Restarts.** Every executed node is journaled, so runs survive restarts.

Stored processes use `nodes` and `wires`:

```yaml
nodes:
  - { id: start, type: start, x: 0, y: 0 }
  - { id: check, type: if, condition: 'inputs.days > 30', x: 250, y: 0 }
  - { id: warn, type: log, level: warn, message: 'long period', x: 500, y: -60 }
wires:
  - { from: start, port: out, to: check }
  - { from: check, port: 'true', to: warn }
```

For hand-written YAML the compact sequential format is easier to read. It is converted into a graph (with automatic layout) on import:

```yaml
name: List inactive users
connections:
  - slot: hub
    kind: insights-hub
inputs:
  - { name: days, type: number, default: 90 }
steps:
  - id: users
    type: http
    connection: hub
    method: GET
    path: /api/identitymanagement/v3/Users
    paginate: { mode: scim, pageSize: 100 }
    saveAs: users
  - id: inactive
    type: set
    values:
      inactive: '{{ vars.users.body[$daysSince(lastLogonTime) > $inputs.days][] }}'
  - id: pick
    type: userTask
    mode: select
    title: 'Remove {{ $count(vars.inactive) }} users from group X?'
    items: vars.inactive
    itemKey: id
    columns: [{ label: User, value: userName }]
    saveAs: decision
  - id: remove
    type: forEach
    items: vars.decision.selected
    as: user
    steps:
      - id: del
        type: http
        connection: hub
        method: DELETE
        path: '/api/identitymanagement/v3/Groups/<groupId>/members/{{ vars.user.id }}'
```

## Inputs

A process declares its inputs (`inputs:`): `string`, `number`, `boolean`, `select` (`options`), `list` (one value per line), `table` (CSV), `json`, `secret` (stored encrypted only, `***` everywhere), `application` and `applications` (the service catalogue). `required: true` refuses a run without a value; `default` fills an empty one. The run dialog shows a field per input; a run started from a schedule, a webhook or a sub-process gets them from there. Undeclared inputs are left out of the run.

**Table inputs (CSV).** A `table` input is CSV text – comma, semicolon or tab separated (whichever splits the first line most), quoted fields with `""` for a quote – read as rows of objects, `inputs.users[0].email`. The first line is the header row. With declared `columns` (`columns: [email, givenName, familyName, bundle]`):

- a header field that names a column in another case (`Email`, `GIVENNAME`) takes the declared spelling, so expressions always read `email`;
- a first line that names **none** of the columns is data: every line is read by position into the declared columns – `new.operator@example.com,New,Operator` is one row with an empty `bundle`; extra fields are ignored, missing ones are empty.

Blank lines are left out and fields trimmed. The run dialog shows how many rows it read under the field (_1 row read – no header row, read by the column order_). A **required** table input that reads **no rows** – only a header row, or nothing but blank lines – is refused when the run starts (400, `INPUT_TABLE_EMPTY`: "Users (CSV) has no rows"), so an approval never asks "Onboard 0 user(s)?". Processes that act on every row should still check that there is one before they ask (the onboarding example: _At least one user_, `$count(vars.plan) > 0`, `failRun: true`).

## Expressions and templates

- Expressions use **[JSONata](https://jsonata.org)**. Fields such as _condition_, _items_ or _rows_ take an expression. Text fields accept templates of the form `{{ expression }}`. A field that contains only `{{ … }}` keeps the value's type (list, object, number).
- In scope: `inputs.*`, `vars.*` (step results, `saveAs`), `const.*` (process constants), `run.*` (`id`, `dryRun`, `actor`), and `conn.<slot>.*` (`name`, `baseUrl`, `vars`).
- Inside filters `[...]` a plain name refers to the current item. Use `$inputs`, `$vars` and `$const` there instead.
- Extra functions:
  - `$daysSince(ts)`
  - `$daysAgo(n)`
  - `$ts(ts)`
  - `$uuid()`
  - `$pvar(slot, name, default)` reads a platform variable.
  - `$trend('dataset/metric', '7d')` is the trend of a dataset metric (`perDay`, `change`, `changePct`, `points`, `confidence`; `null` with too few points), and `$daysUntil('dataset/metric', limit, '30d')` the days until the trend reaches the limit (default: the metric's limit or floor from its publish step; `0` when reached, `null` when not heading for it). Windows: `24h`, `7d`, `30d`. A run reads only datasets it may see; with several sources it uses the run's own source. Example check: `$daysUntil('ih.usage/attributes') = null or $daysUntil('ih.usage/attributes') > 30`.
  - `$secret(slot, key)` reads a credential for use in a request to _its own platform_ (e.g. a custom auth header or a portal login). The value is redacted everywhere in logs (including base64/URL-encoded forms) and may only be sent to the platform's allowed origins — a step that would send it elsewhere fails. See [SECURITY-MODEL.md](SECURITY-MODEL.md).
- Append `[]` to force a list, e.g. `vars.users.body[active][]`.
- Per-item fields (task columns, preselect, report columns) are evaluated against the item, which is also available as `$item`.

## Node types

| Type           | Outputs                  | Use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`        | out                      | Entry point (exactly one).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `http`         | out, error               | API call on a connection. `query`, `headers` and `body` are templated. `expectStatus` sets the accepted status codes. `paginate` modes: `scim` (startIndex/count), `page` (page/size + `page.totalPages`), `offset`, `nextLink`. The result is `{status, headers, body, durationMs}`; with pagination, `body` is the concatenated item list. Writes are skipped in dry runs. An answer (each page) may be at most `maxResponseMb` large (default 20 MB, at most 200); outputs above 4 MB are kept in the run as a shortened copy. On an AWS platform, `aws: { service, region }` calls another AWS service of the account, signed with the platform ([AWS.md](AWS.md#aws-calls-in-processes)). _Pick from API spec_ fills method, path, parameters and an example body from the platform's OpenAPI spec. |
| `query`        | out, error               | One read-only SQL statement or catalog query on a database platform. See [DATABASES.md](DATABASES.md#the-step-query-a-database).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `set`          | out                      | Compute variables (evaluated in order).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `forEach`      | each item, done          | Loop over a list (`as` names the item variable, `<as>Index` holds the index). Supports `delayMs` and a `maxItems` safety limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `group`        | –                        | YAML only: a list of `steps` with one shared `when`. Import turns it into its steps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `if`           | true, false              | Branch on a condition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `userTask`     | out / approved, rejected | `select` lets someone pick items; the result has `selected`, `unselected`, `comment`, `decidedBy`. `approve` asks for approval. Optional `assignees` and `fourEyes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `check`        | out                      | Pass/fail with a severity. Shown on the dashboard and in the protocol. `failRun` stops the run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `report`       | out                      | Text (markdown subset) and/or a table section in the protocol.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `browser`      | out, error               | Playwright actions: `goto`, `click`, `fill`, `press`, `select`, `check`, `waitFor`, `expectText`, `extract`, `screenshot`, `wait`, `evaluate`. The session is shared across browser nodes of a run, and a failure screenshot is captured automatically. Mark it `mutating` so it is skipped in dry runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `publish`      | out                      | Writes rows and metrics to a dataset for dashboards. See [DASHBOARDS.md](DASHBOARDS.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `accessChange` | out                      | Documents an access change (grant, revoke, onboarding …) as an evidence entry. See [COMPLIANCE.md](COMPLIANCE.md#automatic-entries-from-runs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ai`           | out, error               | Asks an AI model on an LLM gateway platform, with a budget and an optional JSON answer. See [AI.md](AI.md#the-step-ask-an-ai-model).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `contractTest` | out, error               | Tests a data contract and marks the step failed when it does not pass. See [DATA-CONTRACTS.md](DATA-CONTRACTS.md#monitors-processes-scorecard-and-reports).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `subprocess`   | out, error               | Runs another process as a child run (inputs in, its outputs back as the result).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `wait`, `log`  | out                      | Self-explanatory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `fail`         | –                        | Stops the run with a message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `note`         | –                        | Comment on the canvas, not executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Common options for all nodes:

- `when` (condition)
- `saveAs`
- `onError: continue`
- `retry: { attempts, delayMs }`

Tip: `npx playwright codegen https://your-portal` records clicks and gives you selectors.

## Trying a process safely

- **Dry runs.** Read calls run; write calls (POST/PUT/PATCH/DELETE) and steps marked _changes data_ are only recorded. You see exactly what _would_ change. Keep _Dry run_ on for the first run of a new or changed process.
- **Test runs.** A dry run whose platform calls are answered by recorded responses, so nothing is sent: [PLATFORMS.md](PLATFORMS.md#recorded-responses-and-test-runs).
- **Debugging.** **Run this node** (a tab beside a node's properties in the editor) tries one node with variables from an earlier run, sample data or run inputs – offline, with recorded responses or as a live read. **Debug** in the editor steps through a run of the saved version, pausing before each node or at breakpoints; decisions are answered in the panel, simulated. **Compare with the last good run** on a failed run shows what changed between two runs, step by step. Debug runs are never live, never publish, alert, create tasks or notify, and are seen only by their starter, the process's managers, administrators and auditors. See [DEBUGGING.md](DEBUGGING.md).

## Templates

| Template                                            | What it does                                                                                                                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Insights Hub – Access review 1: flag inactive users | Lists users and finds those inactive for N days, with an exempt list. You confirm the selection, then they are added to a review group.                                                                               |
| Insights Hub – Access review 2: decide and clean up | Lists the review group. You tick who still needs access (recently active users are preselected). Kept users are un-flagged; for the rest, after a final approval, all memberships are removed or the user is deleted. |
| Insights Hub – Onboard users with group bundles     | Takes a CSV of users and a _bundle_ per user (e.g. Operator → StandardUser + Operators group). It checks that all groups exist, asks for approval, creates missing users and adds only the missing memberships.       |
| Insights Hub – Asset attribute optimization check   | Counts attributes per asset type, samples the latest time-series records and reports variables that never get data, assets without data and stale aspects, with the potential attribute savings.                      |
| Insights Hub – Platform health check                | Calls the core services and records pass/fail checks with latency limits.                                                                                                                                             |
| Industrial Edge – Device status check               | Flags devices that are not online and reports a device overview.                                                                                                                                                      |
| Browser – Portal login and status screenshot        | Signs in to a portal, reads a status text, checks it and stores a screenshot as evidence.                                                                                                                             |
| Generic – Endpoint availability check               | Calls a list of endpoints and records one check per endpoint.                                                                                                                                                         |

Templates are YAML files in [`examples/processes/`](../examples/README.md); example dashboards are in `examples/dashboards/`. Adding a file there makes it available in _From template_. The examples README lists the whole library, including privileged-access review, offboarding, group hygiene, inventories, data freshness, firmware and app compliance, stale device clean-up, a weekly service report and an Insights Hub tenant usage and licence check with its dashboard ([INSIGHTS-HUB-USAGE.md](INSIGHTS-HUB-USAGE.md)). Check files with `npm run validate`, which runs in CI too.

### Notes on the Siemens APIs (please verify on your tenant)

- **Domain migration.** Insights Hub is moving from `gateway.{region}.mindsphere.io` (`/api/{service}/v3`) to the Xcelerator gateway `api.{region}.siemens.app` with tenant-specific paths (`/api/identitymanagement-{coreTenantId}/v3`). The templates therefore read their API paths from platform variables (`idmPath`, `assetPath`, `tsPath`) and fall back to the classic paths. Set these variables on the platform when you move.
- **Last login.** The Identity Management user list returns `resources` (lowercase), `totalResults` and paging via `startIndex`/`count`. The last-login attribute `lastLogonTime` is used by Siemens' own `mdsp` CLI but is **not part of the official spec**. Do a dry run of _Access review 1_ first and check the _List all users_ step output.
- **Asset attributes.** These are billed per asset: the asset type's variables plus the variables of its aspects. The optimization template estimates potential from sampled latest values. Cross-check with the Asset Manager attribute calculator before changing models.
- **IEM device fields.** Devices are identified by `deviceId` and `deviceName`; installed app versions come from `GET /portal/api/v1/devices/installed-apps`. Field names for connection state differ between IEM versions, so the device template takes the field name and the "online" value as inputs. Use the platform's **API explorer** to look at a real response.
- Import the official OpenAPI specs from the Siemens developer portal into each platform. The editor's _Pick from API spec_ and the explorer then list all operations.

## More ways to work with processes

- **Manual steps and manual procedures** document work people do outside Steward, with a checklist, fields, evidence and a second person who verifies: [MANUAL-STEPS.md](MANUAL-STEPS.md).
- **Schedules and webhook triggers** start processes on their own; they run with their owner's rights ([USERS.md](USERS.md#who-may-do-what)). Gatus alerts as triggers: [GATUS.md](GATUS.md#webhook-trigger-reference).
- **Git sync** keeps processes in a Git repository and brings changes in after a review: [GIT-SYNC.md](GIT-SYNC.md). **Shared libraries** install a signed, versioned set of procedures from a publisher you trust: [LIBRARIES.md](LIBRARIES.md).
- **Postman export** turns a process into a Postman collection: [POSTMAN.md](POSTMAN.md).
- Step types with their own pages: database queries ([DATABASES.md](DATABASES.md)), AI models ([AI.md](AI.md)), data contract tests ([DATA-CONTRACTS.md](DATA-CONTRACTS.md)), access changes ([COMPLIANCE.md](COMPLIANCE.md)), AWS calls ([AWS.md](AWS.md#aws-calls-in-processes)).
