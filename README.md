# Service Manager

A local tool for running standard service and platform procedures against **Siemens Insights Hub**, **Industrial Edge Management** and any other REST platform. Examples are onboarding users, access reviews and housekeeping, attribute-consumption optimization, health checks and status tests. Each procedure becomes a repeatable, versioned process. You can run it on demand or on a schedule, a person can approve or select items where needed, and every run leaves a tamper-evident protocol.

- **Platform-agnostic.** You add platforms (base URL, credentials, OpenAPI specs, documentation). Processes refer to *connection slots*, so the same process runs against test and production tenants.
- **Process editor.** Build procedures from steps such as API call (with pagination), set variables, for-each, if/else, user task / approval, check, report, browser automation, wait and fail. You can also edit the YAML source directly.
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

1. Open <http://127.0.0.1:4310> and choose a master passphrase.
2. Click **Load demo platforms & processes** on the dashboard. This adds a simulated Insights Hub tenant, a simulated Industrial Edge Management and all templates.
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
| `SM_OPERATOR` | OS user | Default operator name for the audit log |
| `SM_ALLOWED_HOSTS` | – | Extra allowed `Host` headers (comma-separated) |
| `SM_CHROMIUM_PATH` | – | Use a specific Chromium/Chrome binary for browser steps |
| `HTTPS_PROXY` / `NO_PROXY` | – | Corporate proxy, used for platform calls unless a platform overrides it |
| `SM_DEMO` | – | `1` mounts the mock platforms under `/mock` |

## Concepts

| | |
| --- | --- |
| **Platform** | One instance of a system: an Insights Hub tenant, an IEM, any REST API. It holds the base URL, authentication, non-secret variables (tenant, region, API paths), encrypted credentials, OpenAPI specs (searchable operations, used by the editor and the API explorer) and docs (notes, links, files). |
| **Process** | A versioned procedure. It declares connection slots (e.g. `hub`, kind `insights-hub`), inputs (number, text, list, CSV table, …), constants (e.g. group bundles) and steps. Every save creates a new version with author, comment and hash. |
| **Run** | One execution of a pinned process version, manual or scheduled, real or dry. It has a full step journal, logs, decisions, checks, reports and evidence. |
| **Task** | A decision a run is waiting for: select items or approve/reject. Tasks are listed in **My tasks** and on the run page. |
| **Schedule** | Cron plus time zone, with preset inputs and connections. It skips a new run while the previous one is still waiting, unless overlap is allowed. |
| **Audit log** | Everything that changed anything: platform/credential changes, process versions, runs, every write call, skipped (dry-run) writes, decisions, failed checks, screenshots, exports. |

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

Processes are built in the visual editor or as YAML (*Source* tab, or *Import YAML*). A minimal example:

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

### Step types

| Type | Use |
| --- | --- |
| `http` | API call on a connection. `query`, `headers` and `body` are templated. `expectStatus` sets the accepted status codes. `paginate` modes: `scim` (startIndex/count), `page` (page/size + `page.totalPages`), `offset`, `nextLink`. The result is `{status, headers, body, durationMs}`; with pagination, `body` is the concatenated item list. Writes are skipped in dry runs. |
| `set` | Compute variables (evaluated in order). |
| `forEach` | Loop over a list (`as` names the item variable). Supports `delayMs` and a `maxItems` safety limit. |
| `if` / `group` | Branching and grouping. |
| `userTask` | `select` (pick items; result has `selected`, `unselected`, `comment`, `decidedBy`) or `approve` (`approved`; rejection fails the run unless `onReject: continue`). |
| `check` | Pass/fail with a severity. Shown on the dashboard and in the protocol. `failRun` stops the run. |
| `report` | Text (markdown subset) and/or a table section in the protocol. |
| `browser` | Playwright actions: `goto`, `click`, `fill`, `press`, `select`, `check`, `waitFor`, `expectText`, `extract`, `screenshot`, `wait`, `evaluate`. The session is shared across browser steps of a run, and a failure screenshot is captured automatically. Mark it `mutating` so it is skipped in dry runs. |
| `wait`, `fail`, `log` | Self-explanatory. |

Common options for all steps:

- `when` (condition)
- `saveAs`
- `onError: continue`
- `retry: { attempts, delayMs }`

Tip: `npx playwright codegen https://your-portal` records clicks and gives you selectors.

## Security model

- Credentials are encrypted at rest (AES-256-GCM). The key is derived with scrypt from your master passphrase and only kept in memory. The API never returns secret values, and they are redacted from logs, protocols and audit entries.
- The audit log is HMAC-chained with a key derived from the master key. *Audit log → Verify chain* detects modified, removed or re-ordered entries. Each finished run stores a fingerprint of its protocol in the chain, and the protocol shows whether it is still intact.
- The server listens on `127.0.0.1` only and rejects foreign `Host` headers (DNS rebinding). Every state-changing request needs a custom header that browsers cannot send cross-site (CSRF). Pages cannot be framed.
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

The engine is in `server/src/engine/runner.ts`. Every step result is journaled in `run_steps`, so a resumed run replays finished steps from the journal instead of calling the APIs again.

### Ideas for next steps

- Import a Postman collection as a platform spec.
- E-mail or Teams notification for open tasks and failed checks.
- Parallel `forEach` with a concurrency limit for very large tenants.
- Data retention policy (archiving old runs and evidence).
