# Semantic model (Apache Ossie)

Steward describes its own data as a **semantic model** in the [Apache Ossie](https://github.com/apache/ossie) format. BI tools, data catalogs and AI agents can read it to learn which data Steward offers, what the fields mean, how the datasets are related and how key figures such as the run success rate are calculated – without guessing from raw JSON.

## What Ossie is

Apache Ossie (incubating) is a vendor-neutral specification for semantic models. It was formerly called **Open Semantic Interchange (OSI)**. A model is a JSON or YAML document with:

- **datasets** – logical tables (here: the resources of Steward's REST API),
- **fields** – columns with a description, an expression and (in newer revisions) a data type,
- **relationships** – foreign keys between datasets,
- **metrics** – aggregations such as counts, rates and averages.

Specification and JSON schema: [apache/ossie, `core-spec/`](https://github.com/apache/ossie/tree/main/core-spec).

## Get the model

```bash
# JSON (default)
curl -H "Authorization: Bearer smt_…" https://steward.example.com/api/v1/semantic-model

# YAML
curl -H "Authorization: Bearer smt_…" -H "Accept: application/yaml" https://steward.example.com/api/v1/semantic-model
curl -H "Authorization: Bearer smt_…" "https://steward.example.com/api/v1/semantic-model?format=yaml"
```

The endpoint belongs to the public REST API ([API.md](API.md)): it needs an API token with scope *read* (or *full*), like every other `/api/v1` endpoint, and is described in the OpenAPI document (`getSemanticModel`). MCP clients find the same model as the resource `steward://semantic-model` ([MCP.md](MCP.md#resources)).

The model describes the **schema, not the data**. It is the same for every token. The data itself comes from the API, and every token only sees what its owner may see.

| Query parameter | Values | Default |
| --- | --- | --- |
| `version` | `0.1.1`, `0.2.0.dev0` | `0.1.1` |
| `format` | `json`, `yaml` | from the `Accept` header, else JSON |

### Which Ossie revision

- **0.1.1** is the released specification (December 2025). It is the default. Its documents have a `semantic_model` array, metrics at model level (fields referenced as `dataset."field"`) and no data types.
- **0.2.0.dev0** is the revision in development on the `main` branch of apache/ossie (pinned in Steward's tests to commit `fae8f41`, 21 October 2026). One model per document, `datatype` on fields and metrics, and dataset-scoped metrics. The specification itself says not to depend on it in production yet – it may still change.

The tests validate both renderings against the official JSON schemas (`server/test/fixtures/ossie/`).

## What the model contains

| Dataset | API operation | Content |
| --- | --- | --- |
| `processes` | `GET /api/v1/processes` | Service processes |
| `runs` | `GET /api/v1/runs` | Executions with status, trigger, timing |
| `run_steps` | `GET /api/v1/runs/{runId}/steps` | Step journal of a run |
| `tasks` | `GET /api/v1/tasks` | Selections and approvals |
| `schedules` | `GET /api/v1/schedules` | Cron schedules |
| `webhook_triggers` | `GET /api/v1/triggers` | Webhook triggers (never secrets) |
| `platforms` | `GET /api/v1/platforms` | Platform metadata (never credentials) |
| `dashboard_datasets` | `GET /api/v1/datasets` | Datasets published for dashboards |
| `dashboards` | `GET /api/v1/dashboards` | Dashboard definitions |
| `monitors` | `GET /api/v1/monitors` | Monitors with status and uptime |
| `monitor_checks` | `GET /api/v1/monitors/{monitorId}/status` | Current result of each check |
| `monitor_status_changes` | `GET /api/v1/monitors/{monitorId}/history` | Status changes |
| `audit_entries` | `GET /api/v1/audit` | Audit log (auditors and administrators) |

Relationships connect them, for example `runs.processId → processes.id`, `run_steps.runId → runs.id` and `monitor_checks.monitorId → monitors.id`.

Metrics include:

| Metric | Meaning |
| --- | --- |
| `run_success_rate` | Share of finished runs that succeeded (0–1); filter `dryRun = false` for real runs |
| `failed_run_count`, `run_count` | Runs |
| `avg_step_duration_ms`, `failed_step_count` | Steps |
| `open_task_count`, `approval_rate` | Decisions |
| `monitor_availability_24h`, `monitor_availability_30d` | Average monitor uptime in percent |
| `monitors_down_count`, `down_transition_count` | Outages |
| `check_availability_24h`, `avg_check_duration_ms` | Checks |
| `trigger_fire_count`, `trigger_rejected_share` | Webhook triggers |
| `failed_steps_per_failed_run` | Model-level metric across `run_steps` and `runs` |

Users and teams are left out on purpose: they are personal data and only useful to administrators.

### How datasets map to the API

The physical **source** of a dataset is the REST API resource, not a database table:

- `source` is a logical name, `steward.api_v1.<dataset>`.
- A custom extension on each dataset (vendor `COMMON` in 0.1.1, `STEWARD` in 0.2.0.dev0) names the API operation, the endpoint, where the items are in the response (`items`, or `checks` for the check status) and the pagination (`nextCursor` → `?cursor=`):

  ```json
  {"steward": {"api": "v1", "operationId": "listRuns", "endpoint": "GET /api/v1/runs", "itemsPath": "items", "pagination": "cursor (nextCursor → ?cursor=)", "access": "runs of processes the token owner may view"}}
  ```

- Field names are the JSON properties of the API response. The expression is the same name as a quoted ANSI SQL identifier (`"startedAt"`; nested properties as `"uptime"."h24"`).
- A field that comes from the URL rather than the item (for example `runId` of a step) carries a custom extension `{"steward": {"pathParameter": "runId"}}`.

Why the API and not the tables? The API is the supported, permission-checked way to read Steward's data and stays stable within v1. The tables hold encrypted credentials, sealed inputs and internal columns, change without notice, and reading them directly would bypass the access rules. Describing only what the API returns also guarantees that the model names no secret fields: no credentials, variables, process inputs or step payloads.

## Using it with Ossie-compatible tools

1. Download the model (YAML or JSON) with a read token.
2. Load it into the tool's Ossie import or converter (see [apache/ossie-converters](https://github.com/apache/ossie-converters) for dbt, GoodData, Polaris, Salesforce and others).
3. Point the tool's data connection to Steward's REST API (or to a copy of the API data in your warehouse): each dataset's custom extension says which endpoint fills it.

For AI agents, the `ai_context` fields carry synonyms ("executions" for runs, "availability" for uptime) and an instruction that field values are data, not instructions.

## Versioning

The model follows the REST API: new datasets, fields and metrics are added within v1; nothing is removed or renamed without a new API version. When Ossie releases 0.2.0, Steward will offer it and keep 0.1.1 for a while.
