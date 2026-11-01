# Steward REST API (v1)

Steward has a public, **read-only** REST API under `/api/v1` for reports, dashboards in other tools, compliance evidence and monitoring. It gives you the data Steward holds: processes and their versions, runs with step journal and logs, decisions, schedules, platform metadata, dashboard datasets, the audit log, users and teams.

- Base URL: `https://<your Steward host>/api/v1` (locally `http://127.0.0.1:4310/api/v1`)
- Description: [OpenAPI 3.1](openapi.json), also served at `/api/v1/openapi.json` (and `/api/v1/openapi.yaml`)
- Interactive documentation: Swagger UI at `/api/docs/` (see [Documentation page](#documentation-page))
- API version: `1.1.0` (`info.version` in the document, `apiVersion` in `/health` and `/me`)

The web UI keeps using its own internal API under `/api/…`. That one may change with every release – **build integrations on `/api/v1` only.**

## Contents

- [Authentication](#authentication)
- [Conventions](#conventions)
- [Endpoints](#endpoints)
- [Examples](#examples)
- [Pagination](#pagination)
- [Rate limits](#rate-limits)
- [Errors](#errors)
- [Versioning and deprecation](#versioning-and-deprecation)
- [Security notes](#security-notes)
- [Configuration](#configuration)
- [Documentation page](#documentation-page)
- [Auditing and logging](#auditing-and-logging)
- [For developers](#for-developers)

## Authentication

Every endpoint except `GET /health` needs a personal API token in the `Authorization` header:

```http
Authorization: Bearer smt_…
```

1. Sign in to the web UI and open **Profile → API tokens → New token**.
2. Choose the scope **Read only** – all `/api/v1` endpoints are read-only, so a read token is enough. _Full access_ tokens work as well, but give more power than an integration needs (they can also call the internal API's write endpoints).
3. Optionally set an expiry. Copy the token; it is shown only once.

Tokens with the scope **MCP client** are for AI assistants and work only on the MCP endpoint (`/api/mcp`, see [MCP.md](MCP.md)); `/api/v1` refuses them with `403` (`token-scope`).

A token acts with the rights of its owner: the API shows exactly what that user sees in the web UI (role defaults, process and platform access lists, auditor rights). `GET /me` tells you who the token belongs to and what it may read.

Session cookies are **not** accepted on `/api/v1`. That keeps the API explicitly key-guarded and takes cross-site request forgery off the table. Tokens in the URL (`?access_token=…`, `?token=…`, `?api_key=…`) are refused with `400`.

| Situation                                                 | Status | `type`                     |
| --------------------------------------------------------- | ------ | -------------------------- |
| No `Authorization` header (or only a session cookie)      | 401    | `token-required`           |
| Unknown, revoked or expired token                         | 401    | `invalid-token`            |
| Token owner deactivated                                   | 403    | `owner-disabled`           |
| Token owner has to change their password first            | 403    | `password-change-required` |
| Token with scope _MCP client_                             | 403    | `token-scope`              |
| Vault locked (after a restart, until an admin unlocks it) | 503    | `vault-locked`             |

## Conventions

- JSON, UTF-8, field names in `camelCase`.
- Timestamps are ISO 8601 in UTC, e.g. `2026-10-22T06:00:00.012Z`. Query parameters `from`/`to` accept any ISO 8601 date-time with offset.
- Ids are strings. (Only `seq` of audit entries and version numbers are integers.)
- Fields are always present; "no value" is `null`. Free-form JSON (definitions, inputs, step output, dataset rows) is passed through as is.
- Every response has `Cache-Control: no-store`.
- Multiple values of a filter are given by repeating the parameter: `?status=failed&status=cancelled`.
- Unknown query parameters are ignored.

## Endpoints

| Endpoint                                        | Who                                                      | Notes                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                   | everyone                                                 | `status: ok` / `unavailable` (503 while the vault is locked)                                                                                                                                                                                                                            |
| `GET /me`                                       | token                                                    | Owner, token name/scope/expiry, capabilities                                                                                                                                                                                                                                            |
| `GET /openapi.json`, `/openapi.yaml`            | token (or see [documentation page](#documentation-page)) | This API's OpenAPI document                                                                                                                                                                                                                                                             |
| `GET /processes`                                | token                                                    | Filters `tag` (`key` or `key=value`), `q`. Processes you may view                                                                                                                                                                                                                       |
| `GET /processes/{processId}`                    | token                                                    | With the current definition and its hash                                                                                                                                                                                                                                                |
| `GET /processes/{processId}/versions`           | token                                                    | Newest first                                                                                                                                                                                                                                                                            |
| `GET /processes/{processId}/versions/{version}` | token                                                    | Definition of that version                                                                                                                                                                                                                                                              |
| `GET /runs`                                     | token                                                    | Filters `processId`, `status`, `trigger`, `scheduleId`, `dryRun`, `from`, `to`. Newest first                                                                                                                                                                                            |
| `GET /runs/{runId}`                             | token                                                    | Inputs, platforms used, step counts, decisions, checks, stats, protocol fingerprint (`protocol.hash`, `recordedHash`, `intact`), parent and sub-process runs                                                                                                                            |
| `GET /runs/{runId}/steps`                       | token                                                    | Step journal in execution order (previews). Filters `status`, `type`                                                                                                                                                                                                                    |
| `GET /runs/{runId}/steps/{stepId}`              | token                                                    | One journal entry with its complete output                                                                                                                                                                                                                                              |
| `GET /runs/{runId}/logs`                        | token                                                    | Oldest first. Filter `level`                                                                                                                                                                                                                                                            |
| `GET /tasks`                                    | token                                                    | User tasks (selections, approvals, manual steps). Filters `status` (`open`, `completed`, `cancelled`), `processId`, `runId`                                                                                                                                                             |
| `GET /tasks/{taskId}`                           | token                                                    | With items and the decision                                                                                                                                                                                                                                                             |
| `GET /schedules`, `/schedules/{scheduleId}`     | token                                                    | Filters `processId`, `enabled`                                                                                                                                                                                                                                                          |
| `GET /triggers`, `/triggers/{triggerId}`        | token                                                    | Webhook triggers of processes you may view. Filters `processId`, `enabled`. Never the secret, its prefix, the input mapping or the allowed addresses                                                                                                                                    |
| `GET /semantic-model`                           | token                                                    | The data model of this API as an [Apache Ossie](SEMANTIC-MODEL.md) semantic model; JSON or YAML (`Accept: application/yaml` or `format=yaml`), `version=0.1.1` (default) or `0.2.0.dev0`                                                                                                |
| `GET /platforms`, `/platforms/{platformId}`     | token                                                    | **Metadata only** (id, name, kind, description, environment, base URL, auth type, your permissions), only for platforms the owner has a permission on (others: `404`). Never credentials, variables or authentication settings                                                          |
| `GET /datasets`, `/datasets/{datasetKey}`       | token                                                    | Dataset metadata (rows, status counts, latest metrics, staleness)                                                                                                                                                                                                                       |
| `GET /datasets/{datasetKey}/rows`               | token                                                    | Snapshot rows, `limit` up to 1000. Filter `status`                                                                                                                                                                                                                                      |
| `GET /datasets/{datasetKey}/metrics`            | token                                                    | Metric history: `names`, `days` (1–400), `points`                                                                                                                                                                                                                                       |
| `GET /dashboards`, `/dashboards/{dashboardId}`  | token                                                    | Dashboard definitions                                                                                                                                                                                                                                                                   |
| `GET /audit`                                    | auditor, admin                                           | Filters `action` (prefix), `actor`, `entityType`, `entityId`, `runId`, `q`, `from`, `to`. Newest first. Others may read the entries of a run they can view with `runId`                                                                                                                 |
| `GET /audit/verify`                             | auditor, admin                                           | Verifies the HMAC hash chain; the verification is itself audited                                                                                                                                                                                                                        |
| `GET /users`, `/users/{userId}`, `/teams`       | admin                                                    | No password hashes, no tokens                                                                                                                                                                                                                                                           |
| `GET /monitors`                                 | token                                                    | Monitors you may view, with status, status code, root causes and uptime. Filters `status`, `tag`, `q`                                                                                                                                                                                   |
| `GET /monitors/{monitorId}`                     | token                                                    | Id or key; with the definition (never heartbeat secrets)                                                                                                                                                                                                                                |
| `GET /monitors/{monitorId}/status`              | token                                                    | Monitor and check statuses with status codes (0 up, 1 degraded, 2 down, 3 unknown, 4 blocked, 5 maintenance) – for Zabbix HTTP agent items, see [MONITORS.md](MONITORS.md#zabbix-pull)                                                                                                  |
| `GET /monitors/{monitorId}/history`             | token                                                    | Status changes, newest first. Filter `check`                                                                                                                                                                                                                                            |
| `GET /monitors/discovery`                       | token                                                    | Zabbix low-level discovery: `{"data":[{"{#MONITOR}":…,"{#CHECK}":…}]}`; `level=monitors` for one entry per monitor                                                                                                                                                                      |
| `GET /records`                                  | token                                                    | Change requests, decision records and living documents, ordered by number. Filters `type`, `status`, `tag`, `q`, `workflow`, `reviewStatus`. See [RECORDS.md](RECORDS.md)                                                                                                               |
| `GET /records/{recordId}`                       | token                                                    | Id or number (`CR-2026-0001`); text, fields, content and frozen hash, attachments (with SHA-256), links, approvals and comments                                                                                                                                                         |
| `GET /records/{recordId}/versions`              | token                                                    | Every saved change of title, text and fields, newest first                                                                                                                                                                                                                              |
| `GET /records/{recordId}/editions`              | token                                                    | Living documents: approved editions (1.0, 1.1, 2.0) with content hash, change summary and approval, newest first                                                                                                                                                                        |
| `GET /records/{recordId}/editions/{edition}`    | token                                                    | One frozen edition with its text, fields and files                                                                                                                                                                                                                                      |
| `GET /records/{recordId}/reviews`               | token                                                    | Periodic reviews of a living document, newest first; the review status is on the record (`document.review`)                                                                                                                                                                             |
| `GET /services`                                 | token                                                    | The service catalogue, ordered by name: description, criticality, contacts, responsible users and teams, tags, CMDB entry, and counts of links and living documents (only what the token owner may see). `archived=include` or `only` (default `exclude`)                               |
| `GET /services/{serviceId}`                     | token                                                    | One service with its links (internal items the owner may not see: `visible: false`, without id or name), archived ones too                                                                                                                                                              |
| `GET /services/{serviceId}/documents`           | token                                                    | Living documents linked to the service either way, ordered by number, with current edition, review status and next review; documents the token owner may not read are left out                                                                                                          |
| `GET /applications`                             | token                                                    | Applications of the service catalogue, ordered by name: vendor, version, criticality, responsible users and teams, services with the role, number of integrations, CIA rating. `archived=include` or `only`                                                                             |
| `GET /applications/{applicationId}`             | token                                                    | One application with its integrations (platforms the owner may not see: `visible: false`) and links                                                                                                                                                                                     |
| `GET /applications/{applicationId}/documents`   | token                                                    | Living documents that apply to the application, with edition and review status                                                                                                                                                                                                          |
| `GET /cia-scale`                                | token                                                    | The CIA scale: mode (BSI default, shared or per dimension) and the ordered levels of each dimension                                                                                                                                                                                     |
| `GET /duties`                                   | token                                                    | Service duties with the status of the current and the last period, ordered by service and name. Filters `serviceId`, `applicationId`, `level`, `archived`. See [DUTIES.md](DUTIES.md)                                                                                                   |
| `GET /duties/{dutyId}`                          | token                                                    | One duty (archived ones too)                                                                                                                                                                                                                                                            |
| `GET /duties/{dutyId}/periods`                  | token                                                    | Its periods, newest first: open ones evaluated now, closed ones as stored with what they were judged against. Filters `status`, `closed`, `from`, `to`                                                                                                                                  |
| `GET /scorecard`                                | token                                                    | The service scorecard: per service (not archived) duties, availability, documentation and protection need, each with its own status, and `attention`; the rollup overall and per owner. See [SCORECARD.md](SCORECARD.md)                                                                |
| `GET /scorecard/trend`                          | token                                                    | The rollup of the stored daily snapshots, oldest first. `days` (default 90, at most 730), `owner` (`user:<name>`, `team:<name>`, `none`)                                                                                                                                                |
| `GET /services/{serviceId}/scorecard`           | token                                                    | The scorecard of one service with its stored days of the last 90 days                                                                                                                                                                                                                   |
| `GET /objectives`                               | token                                                    | Availability objectives with Gatus' current uptime and the status per window; platform and endpoint only when the token owner may see the platform. Filters `serviceId`, `applicationId`, `status`                                                                                      |
| `GET /objectives/{objectiveId}/samples`         | token                                                    | Hourly samples of an objective, newest first (kept 90 days). Filters `from`, `to`                                                                                                                                                                                                       |
| `GET /access-changes`                           | token                                                    | Access change entries (grants, revocations, changes of access rights), newest first. Filters `platformId`, `subject`, `status`, `kind`, `from`, `to`. See [COMPLIANCE.md](COMPLIANCE.md)                                                                                                |
| `GET /access-findings`                          | token                                                    | Access reconciliation findings (undocumented changes), only of checks the token owner may read. Filters `checkId`, `platformId`, `status`, `from`, `to`                                                                                                                                 |
| `GET /control-catalogues`, `GET /controls`      | token                                                    | Control catalogues and controls with the Steward items mapped to them                                                                                                                                                                                                                   |
| `GET /control-coverage`                         | token                                                    | Evidence coverage per control in a period (`from`, `to`, optional `catalogue`): covered, gap, unmapped or notVisible (evidence the caller may not see), with counts per evidence kind and `hidden`                                                                                      |
| `GET /credentials`                              | token                                                    | Credentials register (documentation only, never secret values): owners, where kept, expiry, rotation and review dates, status. Filters `status`, `type`, `platform`, `dueWithinDays`, `archived`, `q`. Not for viewers (unless they own an entry), see [CREDENTIALS.md](CREDENTIALS.md) |
| `GET /credentials/{credentialId}`               | token                                                    | One entry                                                                                                                                                                                                                                                                               |
| `GET /ticket-references`                        | token                                                    | Ticket references (ServiceNow incidents, vendor tickets): status, responsible people, affected items (names only for items the owner may see). Filters `status`, `state`, `source`, `vendor`, `affected=kind:id`, `q`. See [TICKETS.md](TICKETS.md)                                     |
| `GET /ticket-references/{ticketId}`             | token                                                    | One entry with its history                                                                                                                                                                                                                                                              |

Visibility follows the web UI: runs, tasks, schedules and datasets of a process you may not view do not exist for you (`404`, or left out of lists). Sub-process runs of hidden processes are left out of `children`.

## Examples

Keep the token out of your shell history and scripts:

```bash
export STEWARD=https://steward.corp.example
read -rs STEWARD_TOKEN   # paste the token, press Enter
H="Authorization: Bearer $STEWARD_TOKEN"
```

Who am I?

```bash
curl -sf -H "$H" "$STEWARD/api/v1/me"
```

The last 20 failed runs of a process since October:

```bash
curl -sf -H "$H" "$STEWARD/api/v1/runs?processId=ih-access-review-1&status=failed&from=2026-10-01T00:00:00Z&limit=20"
```

Page through **all** runs (follow `nextCursor` until it is `null`):

```bash
cursor=""
while :; do
  page=$(curl -sf -H "$H" "$STEWARD/api/v1/runs?limit=200${cursor:+&cursor=$cursor}")
  echo "$page" | jq -c '.items[] | {id, processId, status, startedAt}'
  cursor=$(echo "$page" | jq -r '.nextCursor // empty')
  [ -z "$cursor" ] && break
done
```

Download all rows of a dataset as JSON lines:

```bash
cursor=""
while :; do
  page=$(curl -sf -H "$H" "$STEWARD/api/v1/datasets/iem.devices/rows?limit=1000${cursor:+&cursor=$cursor}")
  echo "$page" | jq -c '.items[]'
  cursor=$(echo "$page" | jq -r '.nextCursor // empty')
  [ -z "$cursor" ] && break
done > iem-devices.jsonl
```

Only the problems of a dataset, and a metric trend:

```bash
curl -sf -H "$H" "$STEWARD/api/v1/datasets/iem.devices/rows?status=critical&status=serious"
curl -sf -H "$H" "$STEWARD/api/v1/datasets/iem.devices/metrics?names=offline&days=90"
```

Dashboards in Grafana and a Streamlit app on these dataset endpoints, with the token setup they need: [EXTERNAL-DASHBOARDS.md](EXTERNAL-DASHBOARDS.md).

Evidence for an audit – entries about credential changes, and the chain check:

```bash
curl -sf -H "$H" "$STEWARD/api/v1/audit?action=platform.secrets_changed&limit=200"
curl -sf -H "$H" "$STEWARD/api/v1/audit/verify"
```

PowerShell:

```powershell
$h = @{ Authorization = "Bearer $env:STEWARD_TOKEN" }
Invoke-RestMethod -Headers $h "$env:STEWARD/api/v1/tasks?status=open"
```

## Pagination

Lists return

```json
{ "items": [ … ], "nextCursor": "eyJ2IjoxLCJmIjoi…" }
```

- `limit` is 1–200 (default 50); dataset rows allow up to 1000 (default 100).
- To get the next page, repeat the request with the **same filters** and `cursor=<nextCursor>`. The same link is also in an RFC 8288 header: `Link: </api/v1/runs?limit=50&cursor=…>; rel="next"`. On the last page `nextCursor` is `null` and there is no `Link` header.
- Cursors are opaque – do not build or change them. A cursor used with different filters is refused (`400`, `invalid-cursor`). You may change `limit` between pages.
- Pagination is keyset-based (e.g. `startedAt` + `id` for runs), so pages neither skip nor repeat items when new runs start while you page; new items simply do not appear in pages you have not reached yet when they sort before them.
- Dataset rows belong to one snapshot. If the dataset is re-published while you page, the next page answers `409` (`dataset-changed`) – start again without a cursor.

## Rate limits

Each token may make **600 requests per minute** by default (token bucket: short bursts up to the limit, refilled continuously). Requests without a valid token are limited per client IP. Every response carries the headers of the IETF draft _RateLimit header fields for HTTP_:

```http
RateLimit-Limit: 600
RateLimit-Remaining: 599
RateLimit-Reset: 1
RateLimit-Policy: 600;w=60
```

Above the limit the API answers `429 Too Many Requests` with `Retry-After: <seconds>`. Wait that long before the next call. The limit is set with `SM_API_RATE_LIMIT` (see [Configuration](#configuration)). Counters are kept in memory and reset when the server restarts.

## Errors

Errors are _problem details_ ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)) with `Content-Type: application/problem+json`:

```json
{
  "type": "https://github.com/vxrz/steward/blob/main/docs/API.md#invalid-token",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Invalid, expired or revoked API token",
  "instance": "/api/v1/runs"
}
```

`type` links to the matching entry below; generic HTTP errors use `about:blank`. Validation errors add `errors: [{ "in": "query", "name": "limit", "message": "must be <= 200" }]`. Internal errors (`500`) never contain internal details – the `detail` names the request id to look up in the server log.

<a id="token-required"></a>**token-required** (401) – no `Authorization: Bearer` header. Session cookies do not count.<br>
<a id="invalid-token"></a>**invalid-token** (401) – the token is unknown, revoked or expired. Create a new one.<br>
<a id="owner-disabled"></a>**owner-disabled** (403) – the token's owner was deactivated.<br>
<a id="password-change-required"></a>**password-change-required** (403) – the owner must change their password in the web UI.<br>
<a id="token-scope"></a>**token-scope** (403) – the token has the scope _MCP client_; it only works on the MCP endpoint. Create a _read_ token for the REST API.<br>
<a id="forbidden"></a>**forbidden** (403) – the owner lacks the right (e.g. audit log without the auditor role).<br>
<a id="not-found"></a>**not-found** (404) – does not exist, or the owner may not see it.<br>
<a id="validation-error"></a>**validation-error** (400) – a query or path parameter is invalid; see `errors`.<br>
<a id="invalid-cursor"></a>**invalid-cursor** (400) – the cursor is malformed or belongs to other filters.<br>
<a id="token-in-url"></a>**token-in-url** (400) – a token was sent in the URL. Send it in the header, and revoke it: URLs end up in logs.<br>
<a id="method-not-allowed"></a>**method-not-allowed** (405) – the API is read-only (`Allow: GET, HEAD`).<br>
<a id="dataset-changed"></a>**dataset-changed** (409) – the dataset was re-published while paging.<br>
<a id="rate-limited"></a>**rate-limited** (429) – see [Rate limits](#rate-limits).<br>
<a id="vault-locked"></a>**vault-locked** (503) – Steward was restarted and an administrator has not unlocked the vault yet (`Retry-After: 60`).

## Versioning and deprecation

- The major version is part of the path (`/api/v1`). The OpenAPI document carries a semantic version (`info.version`, e.g. `1.0.0`): the **minor** version grows with additive changes, the **patch** version with fixes and documentation.
- Within v1 changes are **additive only**: new endpoints, new optional query parameters, new response fields, new enum values in fields that are documented as open (e.g. `type` of a step). Clients must ignore fields they do not know.
- Breaking changes (removing or renaming fields, changing types or meaning, new required parameters) only come with a new major version (`/api/v2`), which then runs next to v1 for at least two releases.
- Endpoints that are going away are announced in the release notes and with the `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) response headers, plus `deprecated: true` in the OpenAPI document, before they are removed.

## Security notes

- **A token acts as its owner.** For integrations, create a dedicated service account (e.g. `svc-reporting`) with the **viewer** role – or **auditor** if it needs the audit log – and create a _read only_ token for it, with an expiry. Never use an administrator's token for an integration.
- **Treat tokens like passwords.** Store them in your secret store / CI secrets, never in source code, never in URLs (the API refuses them there), never in tickets or chats. Revoke a token immediately on the profile page (or as an admin under _Settings → API tokens_) when it may have leaked.
- Tokens are stored only as SHA-256 hashes; Steward cannot show a token again.
- Deactivating a user stops all their tokens at once (`403`).
- The API never returns platform credentials, secret variables, authentication settings, password hashes or tokens. Responses are serialised strictly from the documented schemas, so fields that are not documented cannot leak. Base URLs are returned without user info and query string.
- Run step inputs contain the resolved request with secrets redacted, exactly like the run page in the web UI.
- Use HTTPS (`SM_TLS_CERT`/`SM_TLS_KEY` or a reverse proxy) whenever the API is reached over the network. The host allow-list (`SM_ALLOWED_HOSTS`) also applies to the API.
- No CORS headers are sent, so browser pages on other origins cannot call the API.
- Turn the API off completely with `SM_API_V1=off` if you do not need it.

## Configuration

| Variable            | Default     | Purpose                                                                                                                               |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `SM_API_V1`         | `on`        | `off` turns the public API and its documentation off (all `/api/v1` and `/api/docs` requests answer 404)                              |
| `SM_API_DOCS`       | – (setting) | `off`, `authenticated` or `public`; overrides the setting _Settings → REST API → API documentation_. An unknown value counts as `off` |
| `SM_API_RATE_LIMIT` | `600`       | Requests per minute and token; `0` or `off` = unlimited                                                                               |

## Documentation page

The Swagger UI at **`/api/docs/`** shows the OpenAPI document and lets you try the endpoints: click **Authorize**, paste a token, then _Try it out_. The token is kept only in the page's memory (not stored in the browser).

Who may open it is set by administrators under **Settings → REST API → API documentation**, or by `SM_API_DOCS`, which wins over the setting:

| Mode                      | Documentation page and `openapi.json` without a token                    |
| ------------------------- | ------------------------------------------------------------------------ |
| `off`                     | 404                                                                      |
| `authenticated` (default) | Only for people signed in to the web UI (session cookie); others get 401 |
| `public`                  | Everyone who can reach the server                                        |

The API endpoints themselves always require a token, whatever the mode; `/api/v1/openapi.json` is always available with a token. The page is served from Steward itself (no CDN) under the same strict Content Security Policy as the web UI. The profile page and the settings page link to it when it is enabled.

In the single-file desktop executable the Swagger UI files are embedded and unpacked next to the web UI.

## Auditing and logging

- Reads are **not** written to the audit log one by one (that would flood it). Instead, the first use of each token per UTC day is audited (`api.token_used`, with owner and client IP), and the token's _last used_ time is updated (at most once a minute; visible on the profile page and in _Settings → API tokens_).
- `GET /audit/verify` is audited like the button in the web UI.
- Every request is logged at `debug` level in the operational log (method, path, status, duration, user, token id – never the token). Rejected requests (403, 429 …) are logged at `warn`.

## For developers

- Schemas: `server/src/api/v1/schemas.ts` (zod, converted to JSON Schema and used for Fastify's response serialisation). Routes: `server/src/api/v1/routes.ts` (shared setup, Meta) and one `routes-<area>.ts` per area, plus the feature modules' `api-v1.ts`. Authentication, rate limits: `server/src/api/v1/auth.ts`. Plugin, OpenAPI and Swagger UI: `server/src/api/index.ts`.
- `npm run openapi` regenerates [`docs/openapi.json`](openapi.json); `npm run openapi -- --check` fails (exit 1) when the committed file is outdated – run it in CI. `npm run openapi -- --help` lists the options.
- `server/test/api-v1.test.ts` checks authentication, permissions, pagination, secret leakage and validates every response against the generated document.

## Tag filters

Tags are `key` or `key=value` (shown as `key: value`). Every list with tags – processes, monitors, records, services, applications and credentials – takes `tag=env` (every value of `env`, and the plain tag `env`) or `tag=env=prod` (only that value); case does not matter.
