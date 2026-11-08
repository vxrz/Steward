# Metrics and alerts

Steward serves Prometheus metrics at `GET /api/metrics` (below the base path, if there is one). It answers administrators, auditors and their API tokens; with `SM_METRICS_PUBLIC=1` it answers without signing in (only on a private network). It also answers while the vault is locked, so `sm_vault_unlocked` and `sm_ready` can say so.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: steward
    metrics_path: /api/metrics
    scheme: https
    authorization: { credentials_file: /etc/prometheus/steward-token } # an API token (read scope) of an auditor
    static_configs: [{ targets: ['steward.example.com:443'] }]
rule_files: [steward-alerts.yml]
```

Ready-made alert rules: [`examples/prometheus/steward-alerts.yml`](../examples/prometheus/steward-alerts.yml) – Steward down, vault locked, not ready, scheduler stalled, background job failures, no successful backup for 26 hours, a failed backup or restore test, event-loop lag, server errors and stale datasets. Adjust the thresholds to your schedules. Monitor alerts are in [MONITORS.md](MONITORS.md#prometheus).

## Names

Every metric starts with `sm_`. Durations are in seconds (`_seconds`), sizes in bytes (`_bytes`), points in time are Unix seconds (`_timestamp_seconds`), counters end in `_total`. Labels have a small, fixed set of values: never a user, an id or a path.

### Renamed in 0.11.0

0.10 and older used two prefixes. The old names are still served in 0.11, as copies of the new metrics with `Deprecated: use …` in their help text, and are **removed in 0.12**. Change dashboards and alert rules now.

| Until 0.10                                     | From 0.11                                 |
| ---------------------------------------------- | ----------------------------------------- |
| `steward_mcp_requests_total`                   | `sm_mcp_requests_total`                   |
| `steward_mcp_tool_calls_total`                 | `sm_mcp_tool_calls_total`                 |
| `steward_mcp_gateway_calls_total`              | `sm_mcp_gateway_calls_total`              |
| `steward_monitor_status`                       | `sm_monitor_status`                       |
| `steward_monitor_last_ok_timestamp`            | `sm_monitor_last_ok_timestamp_seconds`    |
| `steward_monitor_evaluations_total`            | `sm_monitor_evaluations_total`            |
| `sm_http_requests_total` (calls to platforms)  | `sm_http_client_requests_total`           |
| `sm_http_request_duration_seconds` (platforms) | `sm_http_client_request_duration_seconds` |

## Operations

| Metric                                                  | Labels              | What it is                                                                                         |
| ------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `sm_build_info`                                         | `version`, `commit` | Always 1                                                                                           |
| `sm_vault_unlocked`                                     |                     | 1 unlocked; 0 locked or not set up – schedules, monitors and integrations wait                     |
| `sm_ready`                                              |                     | 1 when `GET /api/ready` would answer 200 (vault unlocked, database writable, schedules armed)      |
| `sm_readiness_check`                                    | `check`             | The checks behind `sm_ready`: `vault`, `database`, `scheduler` (1 ok, 0 failing)                   |
| `sm_backup_enabled`                                     |                     | 1 when scheduled backups are on                                                                    |
| `sm_backup_last_success_timestamp_seconds`              |                     | When the last successful backup ended (0: none yet)                                                |
| `sm_backup_last_failure_timestamp_seconds`              |                     | When the last failed backup ended (0: none)                                                        |
| `sm_backup_last_size_bytes`                             |                     | Size of the last successful backup as uploaded (encrypted)                                         |
| `sm_backup_restore_test_last_success_timestamp_seconds` |                     | When the last successful restore test ended                                                        |
| `sm_backup_restore_test_last_failure_timestamp_seconds` |                     | When the last failed restore test ended                                                            |
| `sm_job_last_success_timestamp_seconds`                 | `job`               | Last successful run of a background job; `job="scheduler-heartbeat"` shows that the scheduler runs |
| `sm_job_duration_seconds`                               | `job`               | Duration of background job runs (histogram)                                                        |
| `sm_job_failures_total`                                 | `job`               | Background job runs that failed or ran over their time limit                                       |
| `sm_event_loop_lag_seconds`                             |                     | 99th percentile of the event-loop delay over 10 s: how long every request waited                   |
| `sm_process_*`, `sm_nodejs_*`                           |                     | Node.js process metrics (memory, CPU, garbage collection)                                          |

The "no recent backup" rule is a dead-man's switch: it also fires when backups never ran, because the vault stayed locked after a restart, backups were switched off by mistake or Steward was down – cases that send no failure notification.

## Runs, steps and datasets

| Metric                       | Labels                         | What it is                                                   |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------ |
| `sm_runs_total`              | `process`, `status`, `trigger` | Finished runs (debug runs do not count)                      |
| `sm_run_duration_seconds`    | `process`                      | Duration of finished runs, including time waiting for people |
| `sm_step_duration_seconds`   | `type`, `status`               | Duration of executed steps                                   |
| `sm_runs_active`             |                                | Runs that are queued, running or waiting                     |
| `sm_tasks_open`              |                                | Open decisions                                               |
| `sm_task_oldest_age_seconds` |                                | Age of the oldest open decision                              |
| `sm_dataset_age_seconds`     | `dataset`                      | Age of the latest snapshot of a dashboard dataset            |
| `sm_dataset_stale`           | `dataset`                      | 1 when a partition of the dataset is stale                   |

Monitors (`sm_monitor_*`): [MONITORS.md](MONITORS.md#prometheus). MCP (`sm_mcp_*`): [MCP.md](MCP.md).

## HTTP

Steward's own server, after the OpenTelemetry semantic conventions for HTTP servers:

| Metric                                    | Labels                                                           | What it is                                     |
| ----------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `sm_http_server_request_duration_seconds` | `http_request_method`, `http_route`, `http_response_status_code` | Requests to the web UI and the API (histogram) |

`http_route` is the route template (`/api/runs/:id`), never the path; a request that matched no route has an empty route, an unknown method counts as `_OTHER`. The histogram's `_count` is the request count, so rate, errors and duration per route come from one metric:

```promql
# p95 per route over 5 minutes
histogram_quantile(0.95, sum by (le, http_route) (rate(sm_http_server_request_duration_seconds_bucket[5m])))
```

Calls to platforms: `sm_http_client_requests_total{host,method,status_class}` and `sm_http_client_request_duration_seconds{host}`.

With OpenTelemetry tracing on (`OTEL_EXPORTER_OTLP_ENDPOINT`), every request also gets a `SERVER` span, named after the method and the route (`POST /api/runs`), with `http.request.method`, `http.route`, `url.path` (no query), `url.scheme`, `http.response.status_code`, `error.type` for server errors, and the database time of the request (`sm.db.statements`, `sm.db.duration_ms`). It is the parent of what the request starts – a run, its steps, the platform calls – so a trace begins where the person clicked. A `traceparent` header from the caller (a proxy, an API client) continues the caller's trace. The span has no client address, user agent or user name.

## Database

Steward's database access is synchronous (ADR 0001): while a statement runs, every request waits. So every statement and transaction is measured:

| Metric                               | Labels                 | What it is                                                                                                            |
| ------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `sm_db_statement_duration_seconds`   | `dialect`, `operation` | Statements by kind: `select`, `insert`, `update`, `delete`, `with`, `ddl`, `pragma`, `transaction`, `cursor`, `other` |
| `sm_db_transaction_duration_seconds` | `dialect`              | Transactions, from `BEGIN` to `COMMIT`                                                                                |
| `sm_db_slow_statements_total`        | `dialect`, `operation` | Statements longer than `SM_DB_SLOW_MS`                                                                                |
| `sm_db_size_bytes`                   |                        | The SQLite file and its WAL, or the tables and indexes of the PostgreSQL schema                                       |
| `sm_db_free_bytes`                   |                        | SQLite: free pages in the file (see [Disk space after a clean-up](INSTALL.md#disk-space-after-a-clean-up))            |

A statement that takes longer than `SM_DB_SLOW_MS` (default 200 ms, `0` = off) is logged as `slow database statement` with its kind, its duration and the first 120 characters of its SQL – with `?` placeholders, never the values – at most once a minute per statement. A slow transaction is logged as `slow database transaction` with its number of statements. Each API request's log line has `dbStatements` and `dbMs`: how many statements it ran and how long they took.

```promql
# the share of time the event loop spent waiting for the database
sum(rate(sm_db_statement_duration_seconds_sum[5m]))
```

When that share stays high on PostgreSQL, ADR 0001's condition for revisiting the synchronous design is met.
