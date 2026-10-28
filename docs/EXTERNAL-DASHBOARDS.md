# Steward data in other tools: Streamlit and Grafana

Steward is not a general visualisation tool. Its dashboards show the datasets that processes publish, and that is enough for most service teams. When you need more – other data sources next to Steward's, your own calculations, or Steward's results in the Grafana your teams already use – read the datasets through the read-only API and build on them elsewhere.

Two examples show how:

| Example                                                          | What it is                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`integrations/streamlit/`](../integrations/streamlit/README.md) | A small Python app: uptime from the metric history, privileged access review status, a spot to join other data      |
| [`integrations/grafana/`](../integrations/grafana/README.md)     | Provisioning for the Infinity data source and two dashboards: uptime over time, every dataset with rows and metrics |

Both run on a server, next to Steward, with one read-only token. Neither changes anything in Steward.

## Contents

- [Which tool for what](#which-tool-for-what)
- [Datasets in short](#datasets-in-short)
- [The API calls](#the-api-calls)
- [Base URL and host names](#base-url-and-host-names)
- [Tokens and permissions](#tokens-and-permissions)
- [Security notes](#security-notes)
- [Versions](#versions)

## Which tool for what

| Need                                                                         | Use                                                 |
| ---------------------------------------------------------------------------- | --------------------------------------------------- |
| KPIs, tables and trends of Steward's datasets, with each viewer's own rights | **Steward dashboards** (_Dashboards_)               |
| _Refresh_ that re-runs the feeding processes, links to runs and protocols    | **Steward dashboards**                              |
| Steward results next to metrics and logs in an existing Grafana              | **Grafana** with the Infinity data source           |
| Alerts in Grafana on a dataset value                                         | **Grafana** (or a Steward check with notifications) |
| Joins with other sources (HR export, CMDB, a database), your own logic       | **Streamlit** (or any script on the API)            |
| A one-off export                                                             | `curl` and `jq`, see [API.md](API.md#examples)      |

Steward's own dashboards apply the **viewer's** rights. Grafana and Streamlit apply the rights of the **token's** user to everyone who opens them. That difference drives most of the security notes below.

## Datasets in short

A process publishes a dataset with a `publish` step (see the processes in [`examples/processes`](../examples/processes)). Per dataset Steward keeps:

- **one snapshot of rows**, replaced on every run. A row's fields are the step's column **labels** (`Endpoint`, `Uptime (%)`), plus `_key`, `_status` (`good`, `warning`, `serious`, `critical`, `unknown`) and `_statusText`. Labels can contain spaces and brackets; values are numbers, strings, booleans or `null`.
- **a metric history**: every run appends one value per metric (`endpoints`, `down`, `avgUptime`, …). The latest values are also in the dataset's metadata.
- **freshness**: `updatedAt`, `staleAfterMinutes` and `stale` (older than that), and `dryRun` when a dry run published it.

The examples use these datasets:

| Dataset                | Process                                    | Columns                                                                                                          | Metrics                               |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `gatus-uptime`         | 71 Gatus – uptime overview                 | Endpoint, Group, Healthy, Uptime (%), Avg response (ms), Last response (ms), Last check (UTC), Last error        | `endpoints`, `down`, `avgUptime`      |
| `gatus-uptime-metrics` | 74 Gatus – uptime overview (from /metrics) | Endpoint, Group, Healthy, Uptime (%), Avg response (ms), Last response (ms), Certificate expires in (days), Type | the same, plus `certificatesExpiring` |
| `ih.privileged`        | 12 Insights Hub – Privileged access review | User, Role, Last login, Days, Review                                                                             | `privileged`, `stale90`, `removed`    |
| `ih.access-snapshot`   | 16 Insights Hub – Access snapshot          | subjectId, subjectName, subjectType, right                                                                       | `users`, `assignments`                |

Process 74 writes `–` for missing numbers, so read those columns as numbers with care (`pd.to_numeric(..., errors="coerce")`).

## The API calls

All under `<base URL>/api/v1`, with `Authorization: Bearer <token>`. Full reference: [API.md](API.md), [openapi.json](openapi.json).

| Call                          | Parameters                                                                                  | Answer                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me`                     | –                                                                                           | `user` (username, roles, teams), `token` (name, scope, expiresAt)                                                                                                                 |
| `GET /datasets`               | `limit` 1–200, `cursor`                                                                     | `items`: `key`, `title`, `processId`, `processName`, `runId`, `dryRun`, `updatedAt`, `rowCount`, `columns`, `statusCounts`, `metrics`, `staleAfterMinutes`, `stale`; `nextCursor` |
| `GET /datasets/{key}`         | –                                                                                           | one dataset's metadata (as above)                                                                                                                                                 |
| `GET /datasets/{key}/rows`    | `limit` 1–1000 (default 100), `cursor`, `status` (repeatable)                               | `items`: the rows in published order; `nextCursor`                                                                                                                                |
| `GET /datasets/{key}/metrics` | `names` (repeatable, default all), `days` 1–400 (default 30), `points` 2–2000 (default 200) | `key`, `days`, `series`: `[{ "name", "points": [{ "ts", "value" }] }]`, oldest first                                                                                              |

- **Paging:** repeat the request with the same parameters and `cursor=<nextCursor>` until `nextCursor` is `null`. If the dataset is published again while you page, the next page answers `409` (`dataset-changed`): start again without a cursor. The Streamlit client does that; Grafana shows the error and the next refresh works.
- **Thinning:** with more stored values than `points`, the API returns every n-th value (and the newest). It does not average.
- **Rate limit:** 600 requests per minute and token by default (`429` with `Retry-After` above it). Both examples cache or refresh every few minutes, which stays far below.
- **Errors** are problem details (`type`, `detail`). The ones you will meet: `401 invalid-token` (unknown, revoked or expired), `403 owner-disabled`, `403 Host not allowed` (see below), `404 not-found` (does not exist, or not visible to the token's user), `503 vault-locked` (after a restart, until an administrator unlocks the vault).

## Base URL and host names

- The base URL is Steward's address **with the base path**: `https://apps.corp.example/steward` when Steward runs under `/steward` (`SM_PUBLIC_URL` or `SM_BASE_PATH`, see [INSTALL.md](INSTALL.md#under-a-path-httpsappscorpexamplesteward)). The API is then `https://apps.corp.example/steward/api/v1`. Without the base path every call answers `404`.
- Steward refuses `Host` headers it does not know, on the API as well (`403 Host not allowed`). When the tools call Steward on the Docker network (`http://steward:4310/steward`), add that name: `SM_ALLOWED_HOSTS=apps.corp.example,steward` (comma-separated, no spaces). Calls through the public URL need no change.
- Keep the tools on the internal network or behind HTTPS. Over the internal Docker network the token does not leave the host.

## Tokens and permissions

### What the token can see

A token acts as its owner. On `/api/v1` Steward runs every request as that user, with the same checks as the web UI:

- **Datasets of processes the user may view.** Others answer `404` and are left out of `/datasets`. Who may view a process:
  - administrators, the process owner and auditors: always;
  - every other role (designer, operator, approver, viewer): when the process has **no access list**;
  - with an access list: only the users, teams and roles on it.
- **Datasets of monitors** follow the monitor's access in the same way.
- **Everything else the user can read.** A read-only token is not limited to datasets: it reads all of `/api/v1` its user may see (processes, runs with logs, schedules, platform metadata; the audit log for auditors), and the GET endpoints of the internal API. It cannot change anything: `/api/v1` has no write endpoints, and on the internal API a read-only token gets `403` for every write. Tokens with the scope _MCP client_ do not work on `/api/v1` at all.

The tools pass this on: **whoever can open the Streamlit app or query the Grafana data source sees what the token's user sees**, whatever their own rights in Steward.

### Recommended setup

1. Create a **technical user** per tool, e.g. `svc-grafana` and `svc-dashboards`, with the role **viewer** and no other role. Never use an administrator's or your own token.
2. Keep sensitive processes out of its sight: give them an access list without the technical user (or its team or role).
3. Sign in as the technical user, open **Profile → API tokens → New token**, choose **Read only** and an expiry. One token per tool, so you can revoke one without the other.
4. Keep the token in the tool's secret store: `secrets.toml` for Streamlit (ignored by Git and Docker), an environment variable or a file for Grafana (`secureJsonData`, stored encrypted). Never in a dashboard JSON, a URL or the browser.
5. Before the token expires, create a new one and swap it. Deactivating the technical user stops all its tokens at once.

`GET /me` shows the token's user, roles, scope and expiry; the Streamlit app shows it in the sidebar. The first use of a token each day is audited as `api.token_used`, and _Settings → API tokens_ lists every token with its last use.

## Security notes

- **Put a sign-in in front of both tools.** Streamlit: its OpenID Connect login (`st.login`, an `[auth]` section in `secrets.toml`) or an authenticating proxy. Grafana: its own users or generic OAuth, no anonymous access. Restrict who may sign in at the identity provider.
- **Grafana OSS has no data source permissions.** Every user of the Grafana organisation can query the _Steward_ data source, not only the provisioned panels. The data source's `allowedHosts` limits the token to URLs starting with `…/api/v1/datasets`; treat that as a safety net, not as the access control. The access control is the technical user's rights.
- **Personal data.** `ih.privileged` and `ih.access-snapshot` hold user names and login dates. Showing them in another tool copies them there: decide who may see them, and do not cache them longer than needed (see [PRIVACY.md](PRIVACY.md)).
- **An own host name per tool** (`grafana.corp.example`, `reports.corp.example`) is safer than paths on Steward's host. Applications on one host name share a browser origin, so a flaw in one can act inside Steward with the signed-in user's session ([INSTALL.md](INSTALL.md#under-a-path-httpsappscorpexamplesteward)). The examples show the path variant because it is the common one behind a single company host name.
- **Server side only.** Steward sends no CORS headers, so browser code on another origin cannot call the API; and it should not, because the token would end up in the browser. Both examples call Steward from the server.
- **Certificates.** Keep certificate checks on. For a company CA set `ca_bundle` in the Streamlit secrets, or mount the CA into the Grafana container.
- **Turning it off.** `SM_API_V1=off` turns the public API off; both tools then get `404`.

## Versions

Pinned in the examples, each released at least two weeks before 2026-10-28:

| Component                                                | Version                                                 |
| -------------------------------------------------------- | ------------------------------------------------------- |
| Python image (Streamlit)                                 | `python:3.13.15-slim-trixie`                            |
| Streamlit (with `[auth]`)                                | 1.66.1 (with Pillow 13.0.0)                             |
| pandas, requests, Authlib                                | 3.0.6, 2.34.2, 1.8.0 (all others in `requirements.txt`) |
| Grafana image                                            | `grafana/grafana:13.2.3`                                |
| Infinity data source (`yesoreyeram-infinity-datasource`) | 4.1.1                                                   |

The Grafana panels were written against the Infinity 4.1.1 source (query model, backend parser, cursor paging). Infinity changes faster than Grafana; after an upgrade, open the dashboards once and check the panels.
