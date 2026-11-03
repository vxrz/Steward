# Prometheus as a data source

Steward reads **PromQL** from a Prometheus-compatible query API: monitor checks of the type `prometheus` judge a query against WARN and CRIT levels ([MONITORS.md](MONITORS.md#check-types)), and availability objectives can take their figures from a query with `[$window]` ([SCORECARD.md](SCORECARD.md#availability-objectives)). Steward only reads.

This page is about connecting a Prometheus. Steward's **own** metrics for Prometheus to scrape (`/api/metrics`) are described in [MONITORS.md](MONITORS.md#prometheus) and the README.

## Connect

_Platforms → New → Prometheus (PromQL)_.

**Base URL** – the address under which `/api/v1/query` exists, with any prefix of the product, without `/api/v1`:

| Product                       | Base URL                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| Prometheus                    | `https://prometheus.example.com` (the server root; with `--web.route-prefix=/prom`: `…/prom`) |
| Thanos Query / Query Frontend | the root of the query component, e.g. `https://thanos-query.example.com`                      |
| Grafana Mimir                 | `https://mimir.example.com/prometheus` (the `prometheus_http_prefix`, default `/prometheus`)  |
| Cortex                        | `https://cortex.example.com/prometheus` (older versions: `…/api/prom`)                        |
| Grafana Cloud Metrics         | `https://prometheus-prod-NN-REGION.grafana.net/api/prom`                                      |
| VictoriaMetrics (single node) | `https://victoria.example.com:8428`                                                           |
| VictoriaMetrics (cluster)     | `https://vmselect.example.com:8481/select/<accountID>/prometheus`                             |

**Authentication** – pick the one the server (or the proxy in front of it) expects; filling in the credential fields in the _New_ dialog picks it for you:

- **None** – a Prometheus without authentication. Credentials entered anyway are **not sent**; the platform settings and the connection test say so.
- **Basic** – `username` and `password` (Prometheus `web.yml` basic auth, a reverse proxy, Grafana Cloud: the instance ID as username and an access policy token as password).
- **Bearer** – `token` (Mimir or a gateway that expects `Authorization: Bearer`).

**Tenant (Mimir, Cortex, multi-tenant Thanos/VictoriaMetrics gateways)** – add a default header under _Settings → HTTP → Default headers_: `X-Scope-OrgID: <tenant>`. Without it a multi-tenant Mimir answers `401 no org id`, and Steward says so.

**Test** – _Test connection_ calls `GET /api/v1/status/buildinfo` (the preset's test path) and passes only when the answer is JSON with `"status": "success"`. A sign-in page, a redirect or a Grafana UI at the base URL fail with what answered.

## How queries are sent

Every query is an instant query, `POST <base>/api/v1/query` with the query as a form field (`application/x-www-form-urlencoded`), so long queries do not run into URL length limits of proxies. A server or proxy that answers `405 Method Not Allowed` gets the same query as `GET …/api/v1/query?query=…`. The query must return an instant vector or a scalar; `+Inf` and `-Inf` count as values past any level, `NaN` as unknown.

Prometheus queries are built-in connector reads: they go to the platform's base URL and need no entry on the outbound allow-list ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#do-i-need-an-allow-list-entry)).

## When it does not work

| Message                                                    | Likely cause and fix                                                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `HTTP 404: no Prometheus API at <base>/api/v1/query`       | The base URL lacks the product's prefix (table above) or points at Grafana or a UI.                             |
| `HTTP 401 … add the default header X-Scope-OrgID`          | A multi-tenant Mimir/Cortex: add the tenant header.                                                             |
| `HTTP 401 … Authentication is set to "none"`               | Credentials were entered but the authentication is _None_: choose _Basic_ or _Bearer_ in the platform settings. |
| `HTTP 401 … The platform refused the credentials`          | Wrong, expired or revoked credentials, or a proxy in front of the server removed the `Authorization` header.    |
| `HTTP 200 with an HTML page, not the {"status":"success"}` | A sign-in page or UI answered instead of the API.                                                               |
| `HTTP 400: invalid parameter "query" …`                    | A PromQL syntax error – Prometheus' own message follows.                                                        |

## Demo

Demo mode has _Prometheus (demo)_ (`/mock/prometheus`, `server/src/mock/mockPrometheus.ts`) with the series `up{job="shop"}` and file system usage of two hosts. Tests: `server/test/prometheus.test.ts`.
