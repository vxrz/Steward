# Service Manager

A local tool for running standard service and platform procedures against **Siemens Insights Hub**, **Industrial Edge Management** and any other REST platform. Examples are onboarding users, access reviews and housekeeping, attribute-consumption optimization, health checks and status tests. Each procedure becomes a repeatable, versioned process. You can run it on demand or on a schedule, a person can approve or select items where needed, and every run leaves a tamper-evident protocol.

- **Platform-agnostic.** You add platforms (base URL, credentials, OpenAPI specs, documentation). Processes refer to *connection slots*, so the same process runs against test and production tenants. A configured platform can be saved as a reusable **connector type**, exported and imported, so adding a new tool is a one-time job.
- **Flow editor (Node-RED style).** Drag nodes from a palette onto a canvas and wire them together. Node types: API call (with pagination and OpenAPI operation picker), set variables, for each, if, user task / approval, check, report, browser automation, wait, fail, comment. Outputs are labelled (true/false, each item/done, approved/rejected, error). You can also edit the YAML source directly.
- **Users and access control.** Sign-in with roles (admin, designer, operator, approver, auditor, viewer) and teams. Per-process and per-platform access lists narrow who may view, run, edit, approve or manage, e.g. only the Service Desk team may use the production tenant. Decisions can be assigned to people, teams or roles, with an optional four-eyes rule.
- **Human in the loop.** A run can pause and ask you to pick items from a list, e.g. "untick the users who still need access", or to approve a change. The decision, who made it and when are all recorded.
- **Dry runs.** Read calls run, write calls (POST/PUT/PATCH/DELETE) are only recorded. You see exactly what *would* change.
- **Scheduling.** Cron schedules with time zones. Scheduled runs that need a decision wait in *My tasks*.
- **Auditability.** There is a hash-chained, HMAC-signed audit log and a per-run protocol (HTML/PDF/JSON) with inputs, every request, decisions, checks, reports and screenshots. Each protocol has a sealed fingerprint, so later changes are detected.
- **Durable.** Runs are journaled step by step. If the app stops while a run waits for a decision, it resumes after a restart without repeating finished steps.
- **Local and safe.** The server binds to `127.0.0.1` and stores credentials AES-256-GCM encrypted with your master passphrase. It has CSRF and DNS-rebinding protection.

## Quick start (demo with simulated platforms)

Requirements: **Node.js 22.13 or newer** (it uses the built-in SQLite). Windows, macOS and Linux are supported.

```bash
npm install
npx playwright install chromium   # only needed for browser automation / PDF export
npm run demo
```

Then:

1. Open <http://127.0.0.1:4310>. Choose a master passphrase and create the first administrator account.
2. Click **Load demo platforms & processes** on the dashboard. This adds a simulated Insights Hub tenant, a simulated Industrial Edge Management, all templates, and demo users:
   - `dana` (designer)
   - `olivia` (operator)
   - `adam` (approver)
   - `audrey` (auditor)
   - `vera` (viewer)

   All of them have the password `Demo-password-1`. Olivia and Adam are in the team *Service Desk*.
3. Open **Processes → "Insights Hub – Access review 1"** and click *Run*. Keep *Dry run* on the first time.

## Everyday use

```bash
npm install
npm run build      # builds the web UI once (again after updates)
npm start          # http://127.0.0.1:4310
```

All data lives in `./data`: the SQLite database, encrypted credentials, screenshots, uploaded docs and the vault file. Back it up. Use `SM_DATA_DIR` to keep it somewhere else.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SM_PORT` | `4310` | HTTP port |
| `SM_HOST` | `127.0.0.1` | Bind address. Keep it local unless you know what you are doing. |
| `SM_DATA_DIR` | `./data` | Data directory |
| `SM_MASTER_PASSPHRASE` | – | Unlock automatically at start-up, so schedules run after a reboot. |
| `SM_ALLOWED_HOSTS` | – | Extra allowed `Host` headers (comma-separated), e.g. the machine's DNS name when colleagues use it |
| `SM_TLS_CERT` / `SM_TLS_KEY` | – | Paths to a certificate and key. Serves HTTPS, which is recommended when others connect over the network. |
| `SM_CHROMIUM_PATH` | – | Use a specific Chromium/Chrome binary for browser steps |
| `HTTPS_PROXY` / `NO_PROXY` | – | Corporate proxy, used for platform calls unless a platform overrides it |
| `SM_DEMO` | – | `1` mounts the mock platforms under `/mock` |

## Concepts

| | |
| --- | --- |
| **Platform** | One instance of a system: an Insights Hub tenant, an IEM, any REST API. It holds the base URL, authentication, non-secret variables (tenant, region, API paths), encrypted credentials, OpenAPI specs (searchable operations, used by the editor and the API explorer; import by file, paste or URL) and docs (notes, links, files). |
| **Connector type** | A reusable template for a kind of platform: auth, variables, HTTP options, credential field names, doc links and API specs, but never credential values. Create one from a configured platform with *Save as connector type*. Export it as JSON to share, import it elsewhere, and new platforms created from it get the specs automatically. |
| **Process** | A versioned flow of nodes and wires. It declares connection slots (e.g. `hub`, kind `insights-hub`), inputs (number, text, list, CSV table, …) and constants (e.g. group bundles). Every save creates a new version with author, comment and hash. |
| **Run** | One execution of a pinned process version, manual or scheduled, real or dry. It has a full step journal, logs, decisions, checks, reports and evidence. |
| **Task** | A decision a run is waiting for: select items or approve/reject. Tasks are listed in **My tasks** and on the run page. |
| **Schedule** | Cron plus time zone, with preset inputs and connections. It skips a new run while the previous one is still waiting, unless overlap is allowed. |
| **Audit log** | Everything that changed anything, attributed to the signed-in user: sign-ins, user/role/access changes, platform/credential changes, process versions, runs, every write call, skipped (dry-run) writes, decisions, failed checks, screenshots, exports. |

## Users, roles and access

| Role | Default rights |
| --- | --- |
| admin | Everything: users and teams, platforms and credentials, settings, all processes, unlocking the vault. |
| designer | Create processes. Edit and run all processes unless an access list says otherwise. |
| operator | Run and schedule processes. |
| approver | Decide approvals and user tasks. |
| auditor | Read-only access to everything, including the audit log and all protocols. |
| viewer | Read processes and their runs. |

- **Process access list.** Rights are `view`, `run` (start, schedule, make selection decisions), `edit`, `approve` and `manage` (change access, archive). An empty list means the role defaults apply. As soon as entries exist, only the listed `user:…`, `team:…` or `role:…` subjects get the listed rights. Admins and the process owner (its creator) always keep full rights.
- **Platform access list.** Rights are `use` (bind it in runs; read-only explorer calls) and `manage` (configuration, credentials, access, write calls in the explorer). Use this to restrict e.g. the production tenant to one team.
- **Decisions.** A user task can name `assignees` (users, teams, roles). Otherwise everyone with `run` or `approve` on the process may decide. With `fourEyes: true`, the person who started the run may not decide.
- **Schedules.** A schedule runs with the rights of its owner (the person who created it). If the owner loses the rights or is deactivated, the run is skipped and recorded in the audit log.
- New accounts get a temporary password and must change it at first sign-in. Passwords are hashed with scrypt. Five failed sign-ins lock the account for five minutes.

### Using it as a team

It still runs locally. Make it reachable on your network:

1. Set `SM_HOST=0.0.0.0` and `SM_ALLOWED_HOSTS=<machine name>`.
2. Provide a certificate with `SM_TLS_CERT` / `SM_TLS_KEY`, or run it behind your reverse proxy.
3. Create accounts under **Users & teams**.

One person (an admin) unlocks the vault after a restart, or you set `SM_MASTER_PASSPHRASE` for unattended start-up.

### Supported authentication

`none`, `basic`, `bearer`, `apiKey` (header or query), `oauth2_client_credentials` (e.g. Insights Hub service credentials), and `token_request`. `token_request` is a configurable login call whose response contains a token, e.g. the IEM `/portal/api/v1/login/direct` or the Insights Hub Technical Token Manager. Per platform you can also set a proxy, a custom CA, *accept self-signed certificates* (common for on-prem IEM), a timeout and default headers.

## Bundled templates

| Template | What it does |
| --- | --- |
| Insights Hub – Access review 1: flag inactive users | Lists users and finds those inactive for N days, with an exempt list. You confirm the selection, then they are added to a review group. |
| Insights Hub – Access review 2: decide and clean up | Lists the review group. You tick who still needs access (recently active users are preselected). Kept users are un-flagged; for the rest, after a final approval, all memberships are removed or the user is deleted. |
| Insights Hub – Onboard users with group bundles | Takes a CSV of users and a *bundle* per user (e.g. Operator → StandardUser + Operators group). It checks that all groups exist, asks for approval, creates missing users and adds only the missing memberships. |
| Insights Hub – Asset attribute optimization check | Counts attributes per asset type, samples the latest time-series records and reports variables that never get data, assets without data and stale aspects, with the potential attribute savings. |
| Insights Hub – Platform health check | Calls the core services and records pass/fail checks with latency limits. |
| Industrial Edge – Device status check | Flags devices that are not online and reports a device overview. |
| Browser – Portal login and status screenshot | Signs in to a portal, reads a status text, checks it and stores a screenshot as evidence. |
| Generic – Endpoint availability check | Calls a list of endpoints and records one check per endpoint. |

Templates are YAML files in `server/templates/`. Adding a file there makes it available in *Processes → From template*.

### Notes on the Siemens APIs (please verify on your tenant)

- **Domain migration.** Insights Hub is moving from `gateway.{region}.mindsphere.io` (`/api/{service}/v3`) to the Xcelerator gateway `api.{region}.siemens.app` with tenant-specific paths (`/api/identitymanagement-{coreTenantId}/v3`). The templates therefore read their API paths from platform variables (`idmPath`, `assetPath`, `tsPath`) and fall back to the classic paths. Set these variables on the platform when you move.
- **Last login.** The Identity Management user list returns `resources` (lowercase), `totalResults` and paging via `startIndex`/`count`. The last-login attribute `lastLogonTime` is used by Siemens' own `mdsp` CLI but is **not part of the official spec**. Do a dry run of *Access review 1* first and check the *List all users* step output.
- **Asset attributes.** These are billed per asset: the asset type's variables plus the variables of its aspects. The optimization template estimates potential from sampled latest values. Cross-check with the Asset Manager attribute calculator before changing models.
- **IEM device fields.** Field names for connection state differ between IEM versions, so the device template takes the field name and the "online" value as inputs. Use the platform's **API explorer** to look at a real response.
- Import the official OpenAPI specs from the Siemens developer portal into each platform. The editor's *Pick from API spec* and the explorer then list all operations.

## Writing processes

Processes are built on the canvas or as YAML (*Source* tab, or *Import YAML*).

**How a flow runs.** Execution starts at the *Start* node and follows the wires, depth first. When an output has several wires, the targets run one after another, top to bottom as placed on the canvas.

- **Outputs.** A node fires one of its outputs:
  - *if* fires `true` or `false`.
  - *for each* runs everything wired to `each item` once per item, then continues on `done`. Leave the last node of the loop body unconnected.
  - An approval fires `approved` or `rejected`. If `rejected` is not connected, a rejection fails the run.
  - API call and browser nodes fire `error` instead of failing the run if that output is connected.
- **Joins and cycles.** A node reached from both branches of an *if* runs once. Wires may not form cycles; use *for each* for repetition.
- **Skipped nodes.** A node whose *Only run when* condition is false is skipped and passes the flow on.
- **Restarts.** Every executed node is journaled, so runs survive restarts.

Stored processes use `nodes` and `wires`:

```yaml
nodes:
  - { id: start, type: start, x: 0, y: 0 }
  - { id: check, type: if, condition: "inputs.days > 30", x: 250, y: 0 }
  - { id: warn, type: log, level: warn, message: "long period", x: 500, y: -60 }
wires:
  - { from: start, port: out, to: check }
  - { from: check, port: "true", to: warn }
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
      inactive: "{{ vars.users.body[$daysSince(lastLogonTime) > $inputs.days][] }}"
  - id: pick
    type: userTask
    mode: select
    title: "Remove {{ $count(vars.inactive) }} users from group X?"
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
        path: "/api/identitymanagement/v3/Groups/<groupId>/members/{{ vars.user.id }}"
```

### Expressions and templates

- Expressions use **[JSONata](https://jsonata.org)**. Fields such as *condition*, *items* or *rows* take an expression. Text fields accept templates of the form `{{ expression }}`. A field that contains only `{{ … }}` keeps the value's type (list, object, number).
- In scope: `inputs.*`, `vars.*` (step results, `saveAs`), `const.*` (process constants), `run.*` (`id`, `dryRun`, `actor`), and `conn.<slot>.*` (`name`, `baseUrl`, `vars`).
- Inside filters `[...]` a plain name refers to the current item. Use `$inputs`, `$vars` and `$const` there instead.
- Extra functions:
  - `$daysSince(ts)`
  - `$daysAgo(n)`
  - `$ts(ts)`
  - `$uuid()`
  - `$pvar(slot, name, default)` reads a platform variable.
  - `$secret(slot, key)` reads a credential. The value is redacted everywhere in logs.
- Append `[]` to force a list, e.g. `vars.users.body[active][]`.
- Per-item fields (task columns, preselect, report columns) are evaluated against the item, which is also available as `$item`.

### Node types

| Type | Outputs | Use |
| --- | --- | --- |
| `start` | out | Entry point (exactly one). |
| `http` | out, error | API call on a connection. `query`, `headers` and `body` are templated. `expectStatus` sets the accepted status codes. `paginate` modes: `scim` (startIndex/count), `page` (page/size + `page.totalPages`), `offset`, `nextLink`. The result is `{status, headers, body, durationMs}`; with pagination, `body` is the concatenated item list. Writes are skipped in dry runs. *Pick from API spec* fills method, path, parameters and an example body from the platform's OpenAPI spec. |
| `set` | out | Compute variables (evaluated in order). |
| `forEach` | each item, done | Loop over a list (`as` names the item variable, `<as>Index` holds the index). Supports `delayMs` and a `maxItems` safety limit. |
| `if` | true, false | Branch on a condition. |
| `userTask` | out / approved, rejected | `select` lets someone pick items; the result has `selected`, `unselected`, `comment`, `decidedBy`. `approve` asks for approval. Optional `assignees` and `fourEyes`. |
| `check` | out | Pass/fail with a severity. Shown on the dashboard and in the protocol. `failRun` stops the run. |
| `report` | out | Text (markdown subset) and/or a table section in the protocol. |
| `browser` | out, error | Playwright actions: `goto`, `click`, `fill`, `press`, `select`, `check`, `waitFor`, `expectText`, `extract`, `screenshot`, `wait`, `evaluate`. The session is shared across browser nodes of a run, and a failure screenshot is captured automatically. Mark it `mutating` so it is skipped in dry runs. |
| `wait`, `log` | out | Self-explanatory. |
| `fail` | – | Stops the run with a message. |
| `note` | – | Comment on the canvas, not executed. |

Common options for all nodes:

- `when` (condition)
- `saveAs`
- `onError: continue`
- `retry: { attempts, delayMs }`

Tip: `npx playwright codegen https://your-portal` records clicks and gives you selectors.

## Security model

- Everyone signs in. Sessions are HttpOnly, SameSite=Strict cookies (12 h idle timeout). Every API call is checked against roles and access lists on the server.
- Credentials are encrypted at rest (AES-256-GCM). The key is derived with scrypt from your master passphrase and only kept in memory. The API never returns secret values, and they are redacted from logs, protocols and audit entries.
- The audit log is HMAC-chained with a key derived from the master key. *Audit log → Verify chain* detects modified, removed or re-ordered entries. Each finished run stores a fingerprint of its protocol in the chain, and the protocol shows whether it is still intact.
- By default the server listens on `127.0.0.1` only. It rejects foreign `Host` headers (DNS rebinding) and can serve HTTPS (`SM_TLS_CERT` / `SM_TLS_KEY`). Every state-changing request needs a custom header that browsers cannot send cross-site (CSRF). Pages cannot be framed.
- Dry runs, approval steps and the explorer's "I understand this changes data" confirmation guard against accidental changes.

## Development

```bash
npm install
npm run dev:demo   # API with auto-reload + Vite UI on http://127.0.0.1:5173 (with mock platforms)
npm test           # end-to-end tests against the mock platforms (incl. browser + crash/resume)
npm run typecheck
```

Code layout:

```
shared/   process model (zod schemas), step metadata for the editor, API types
server/   Fastify API, SQLite (node:sqlite), engine, platforms, audit, scheduler, reports, mock platforms, templates
web/      React + Mantine UI
```

Where things live:

- **Engine:** `server/src/engine/runner.ts`. Every node execution is journaled in `run_steps` (key = loop scope + node id), so a resumed run replays finished nodes from the journal instead of calling the APIs again.
- **Access control:** `server/src/auth/`.
- **Process model, conversion and validation:** `shared/src/process.ts` and `shared/src/graph.ts`.

### Ideas for next steps

- Single sign-on (OIDC, e.g. Microsoft Entra ID) instead of local accounts.
- Sub-flows (call another process as a node).
- Import a Postman collection as a platform spec.
- E-mail or Teams notification for open tasks and failed checks.
- Parallel `forEach` with a concurrency limit for very large tenants.
- Data retention policy (archiving old runs and evidence).
