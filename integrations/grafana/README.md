# Grafana example: Steward datasets in Grafana

Two Grafana dashboards on Steward's read-only API (`/api/v1`), with the [Infinity data source](https://grafana.com/grafana/plugins/yesoreyeram-infinity-datasource/) (`yesoreyeram-infinity-datasource`). Use them when your teams already look at Grafana and want Steward's results next to their other panels. Background, the API calls and security notes for both this example and the Streamlit app: [docs/EXTERNAL-DASHBOARDS.md](../../docs/EXTERNAL-DASHBOARDS.md).

| Dashboard          | Panels                                                                                                           | Datasets (process)                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Steward – Uptime   | Endpoints, down, average uptime, data age; average uptime and outages over time; problem rows; all endpoints     | `gatus-uptime` (71) or `gatus-uptime-metrics` (74) |
| Steward – Datasets | Every dataset the token can see with age, rows and problems; all metrics of a chosen dataset over time; its rows | all                                                |

Files:

| File                                    | Purpose                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `provisioning/datasources/steward.yaml` | The data source _Steward_ (uid `steward`): base URL, bearer token, allowed URL prefix      |
| `provisioning/dashboards/steward.yaml`  | Loads the dashboards from `/etc/grafana/dashboards/steward` into the folder _Steward_      |
| `dashboards/steward-uptime.json`        | Dashboard _Steward – Uptime_                                                               |
| `dashboards/steward-datasets.json`      | Dashboard _Steward – Datasets_                                                             |
| `compose.snippet.yml`                   | Grafana 13.2.3 with Infinity 4.1.1 next to Steward, behind the same proxy under `/grafana` |

## 1. A token for Grafana

Grafana reads with one API token, which acts as its owner. Create a **dedicated technical user** (e.g. `svc-grafana`) with the role **viewer**, sign in as that user and create a token under **Profile → API tokens → New token** with the scope **Read only** and an expiry. See [What the token can see](../../docs/EXTERNAL-DASHBOARDS.md#what-the-token-can-see).

## 2. Run it next to Steward

`compose.snippet.yml` fits the setup from [docs/INSTALL.md → Steward in Docker](../../docs/INSTALL.md#steward-in-docker): Caddy on the network `caddy-bridge` serves Steward under `/steward` and Grafana under `/grafana`.

1. Put the token into `.env` next to the compose file (`chmod 600 .env`; `.env` is ignored by Git):
   ```bash
   STEWARD_TOKEN=<read-only token>
   ```
2. Create `grafana-admin-password.txt` with the initial admin password (commands in the snippet).
3. Add `steward` to Steward's host allow-list, comma-separated without spaces: `SM_ALLOWED_HOSTS=apps.corp.example,steward`. Grafana calls `http://steward:4310/steward/api/v1` on the Docker network; without the entry Steward answers `403 Host not allowed`.
4. Merge the service into your compose file, adjust `GF_SERVER_ROOT_URL` and the paths, then `docker compose up -d grafana`.
5. Add the `/grafana` block to the Caddyfile. Grafana keeps the prefix (`GF_SERVER_SERVE_FROM_SUB_PATH=true`), so the proxy must not strip it.
6. Open `https://apps.corp.example/grafana/`, sign in as `admin`, and open **Dashboards → Steward**. **Connections → Data sources → Steward → Save & test** checks the URL and the token.

Grafana downloads the plugin from grafana.com at start (`GF_PLUGINS_PREINSTALL_SYNC`, pinned to `4.1.1`, auto-update off). Without internet access, download the plugin ZIP once, unpack it into `/var/lib/grafana/plugins` (the `grafana-data` volume) and remove the variable.

**Prefer an own host name** such as `grafana.corp.example` over a path on Steward's host: applications on one host name share an origin in the browser (see [INSTALL.md → Under a path](../../docs/INSTALL.md#under-a-path-httpsappscorpexamplesteward)). Then set `GF_SERVER_ROOT_URL=https://grafana.corp.example/` and drop `GF_SERVER_SERVE_FROM_SUB_PATH`.

### Without Docker, or with your own Grafana

- Install the plugin: `grafana cli plugins install yesoreyeram-infinity-datasource 4.1.1` (Grafana 11.6.11, 12.2.5 or newer; see the plugin's `grafanaDependency`).
- Copy the two provisioning files to Grafana's `provisioning/datasources/` and `provisioning/dashboards/`, and the dashboards to the folder named in `provisioning/dashboards/steward.yaml`.
- Set `STEWARD_API_URL` and `STEWARD_TOKEN` in Grafana's environment (systemd: `Environment=` in an override file readable only by root).

## The data source

```yaml
url: ${STEWARD_API_URL} # e.g. https://apps.corp.example/steward/api/v1
jsonData:
  auth_method: bearerToken
  allowedHosts:
    - ${STEWARD_API_URL}/datasets
secureJsonData:
  bearerToken: ${STEWARD_TOKEN}
```

- `STEWARD_API_URL` is Steward's address **with its base path**, plus `/api/v1`, without a trailing slash. Panel queries use paths relative to it (`/datasets/${dataset}/rows`).
- `allowedHosts` is a URL **prefix**: Infinity sends the token only to URLs that start with it, and refuses everything else. Here only the dataset endpoints. Add a prefix such as `${STEWARD_API_URL}/runs` only if a dashboard needs it.
- Grafana stores the token encrypted (`secureJsonData`); it is never sent to the browser. To read it from a file instead of an environment variable, use `bearerToken: $__file{/run/secrets/steward_token}` and mount the file as a Docker secret.
- `editable: false`: the data source can only be changed in the file.

## How the panels query Steward

Each panel is an Infinity query of type JSON with the backend parser:

| Panel                       | URL and parameters                                                        | Root selector                       | Columns                                                                                     |
| --------------------------- | ------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| Endpoints, Down, Avg uptime | `/datasets/${dataset}`                                                    | `metrics`                           | `endpoints`, `down`, `avgUptime`                                                            |
| Data age                    | `/datasets/${dataset}`                                                    | JSONata on `updatedAt`              | `ageMinutes`                                                                                |
| Average uptime (%)          | `/datasets/${dataset}/metrics?names=avgUptime&days=${days}&points=1000`   | `series.#.points\|@flatten`         | `ts` (timestamp), `value`                                                                   |
| Endpoints and outages       | the same with `names=endpoints` (A) and `names=down` (B)                  | `series.#.points\|@flatten`         | `ts`, `value`                                                                               |
| Problems                    | `/datasets/${dataset}/rows?status=critical&status=serious&status=warning` | `items`                             | all (`_key` hidden, `_status` → Status)                                                     |
| All endpoints, Rows         | `/datasets/${dataset}/rows?limit=1000`, cursor paging on `nextCursor`     | `items`                             | all                                                                                         |
| Datasets                    | `/datasets?limit=200`, cursor paging                                      | `items`                             | `key`, `title`, `processName`, `updatedAt`, `rowCount`, `statusCounts.*`, `stale`, `dryRun` |
| Metrics of a dataset        | `/datasets/${dataset}/metrics?days=${days}`                               | JSONata: one row per point and name | `ts`, `metric`, `value` (_Prepare time series_)                                             |

Notes:

- **History** (`days`, 1–400) is a dashboard variable, because the metrics endpoint takes a number of days, not a time range. Keep it at least as long as the dashboard's time range.
- Steward stores **one metric value per run**. Long windows are thinned out to `points` values per metric (every n-th value, not an average).
- **Paging:** Infinity follows `nextCursor` for at most 5 pages by default, so a table shows up to 5000 rows. For bigger datasets filter by `status`, or use the Streamlit example.
- Row fields are the dataset's **column labels** (`Endpoint`, `Uptime (%)`, …) plus `_key`, `_status` and `_statusText`. A label change in the process changes the field name in Grafana.
- Dashboards are loaded from files with `allowUiUpdates: false`. To change one, use **Save as** and keep your copy, or edit the JSON file.

## Protect Grafana

- **Everyone who can query the data source sees what the token sees.** Grafana OSS has no per-data-source permissions: every user of the organisation can run queries against _Steward_ (Editors in Explore, Viewers through the query API). Give this Grafana, or this organisation, only to people who may see the technical user's data.
- Sign-in: Grafana's own users, or your identity provider with [generic OAuth / OIDC](https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-authentication/generic-oauth/) (`GF_AUTH_GENERIC_OAUTH_*`). Anonymous access stays off.
- The snippet turns off sign-up, usage reporting and update checks, and sets `GF_SECURITY_COOKIE_SECURE=true` (Grafana is reached over HTTPS through the proxy).

## Versions

Grafana `13.2.3` (image `grafana/grafana`, released 2026-09-29) and Infinity `4.1.1` (2026-10-05). Infinity 4 needs Grafana 11.6.11 / 12.0.10 / 12.1.7 / 12.2.5 or newer. The dashboards use `schemaVersion` 39; newer Grafana versions migrate them when loading.
