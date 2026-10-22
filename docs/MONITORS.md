# Monitors

Monitors are Steward's composable, dependency-aware health checks: **combined, branched and cascaded** uptime checks for machines, gateways and platforms. A monitor is a small graph of checks. Some checks Steward runs itself (ping, TCP, HTTP, platform API calls, data freshness in Insights Hub), some it reads from Gatus, and some are **pushed** to Steward by another system, for example an IoT gateway. Results go to people (notifications) and to other monitoring systems (Zabbix, Gatus, webhooks, Prometheus, the public API).

- [Concepts](#concepts)
- [Example: a machine with a PowerMeter](#example-a-machine-with-a-powermeter)
- [Check types](#check-types)
- [Heartbeat API for gateways](#heartbeat-api-for-gateways)
- [Outputs](#outputs): [notifications](#notifications), [webhook](#webhook), [runbooks](#runbooks), [Gatus](#gatus-external-endpoints), [Zabbix push](#zabbix-push), [Zabbix pull](#zabbix-pull), [Prometheus](#prometheus), [dashboards](#dashboards)
- [Templates for many machines](#templates-for-many-machines)
- [Permissions and audit](#permissions-and-audit)
- [Engine, storage and limits](#engine-storage-and-limits)
- [Protocol facts and sources](#protocol-facts-and-sources)

## Concepts

| | |
| --- | --- |
| **Monitor** | A directed graph of checks with links, an owner, a schedule (default interval 60 s), outputs and an access list. Its status is aggregated from its checks. |
| **Check** | One test. Every check is evaluated **independently on its own interval** (the monitor's, or its own). |
| **Link** | `parent → child`: the child depends on the parent. A **soft** link (default) never stops the child from running; it is used for root causes and alert suppression. A **hard** link skips the child while the parent is down (status `blocked`) – for cases where evaluating would be meaningless or harmful. |
| **Sub-monitor** | A check of type `monitor` shows the aggregated status of another monitor. That monitor runs on its own schedule (it is not evaluated twice) and has its own status, outputs and history. Cycles are refused. |
| **Root cause** | A failing check whose parent fails too is reported as *likely caused by* the topmost failing ancestor; only the root cause is alerted. A failing sub-monitor node is expanded to that monitor's own root cause. |

**Why soft links.** The checks of a machine should *not all rely on the PowerMeter being active*. If the PowerMeter check fails while the machine data still arrives, the machine branch stays healthy and the PowerMeter failure is flagged as its own problem, with the note *"Down while all dependent checks are healthy – the check itself or its data path may be broken"*. Only when parent and child fail together is the child folded into the parent's alert.

### Statuses

| Status | Code | Meaning |
| --- | --- | --- |
| `up` | 0 | Healthy |
| `degraded` | 1 | A warning threshold is reached (slow answer, missed intervals, certificate expiring …) |
| `down` | 2 | Failing (after flapping control) |
| `unknown` | 3 | No data yet, or the check itself could not run (platform missing, vault locked, expression error, the data source answered with an error) |
| `blocked` | 4 | Not evaluated because a hard dependency is down |
| `maintenance` | 5 | In a maintenance window: alerts are silenced, the time does not count against uptime |

**Flapping control.** A check goes `down` after *N* consecutive failing results (`failuresBeforeDown`, default 2) and back after *M* consecutive good results (`successesBeforeUp`, default 1). `up` ↔ `degraded` switch immediately. An `unknown` result (the check could not run) does not end a confirmed outage. A failing result that is not confirmed yet already explains failing children.

**Monitor status.** `aggregate.rule`:

- `worst` (default): the worst check;
- `critical`: checks with `critical: false` can only degrade the monitor;
- `quorum` with `quorum: k`: up while at least *k* critical checks are up or degraded (degraded when some are not).

**Maintenance windows** (start, end, reason) and **acknowledgements** (a comment; until the monitor is up again) are set per monitor by everyone with the *acknowledge* right.

## Example: a machine with a PowerMeter

The machine itself cannot be checked directly, but its PowerMeter has a static IP. If the PowerMeter is on and delivers data, the machine should be on and deliver data too. The IoT gateway reports what it receives to Steward, and forwards the data to Insights Hub.

```
PowerMeter reachable (ping, TCP fallback 502)
├─▶ PowerMeter data reported by the gateway (heartbeat, every 60 s)
│     └─▶ PowerMeter data in Insights Hub (freshness: Energy/activePower, energy; cadence 60 s)
└─▶ Machine data flow (sub-monitor "Machine 17 – machine data")
        Machine data reported by the gateway (heartbeat, on change: max. age 10 min)
          └─▶ Machine data in Insights Hub (freshness: MachineData/spindleSpeed, max. age 15 min)
```

1. **Platforms.** An *Insights Hub* platform (service credentials). Optionally *Gatus* and *Zabbix* platforms for outputs.
2. **Import the examples** (*Monitors → Import → From the example library*): first *Machine 17 – machine data* (`examples/monitors/10-…`), then *Machine 17 – PowerMeter* (`11-…`). Platforms are referenced by name; "Insights Hub" also finds "Insights Hub (production)" when it is the only one, otherwise the only platform of the right kind is used. Replace the IP address and the asset ids (*Edit* → select a check).
3. **Heartbeat secrets.** Saving shows the URL and secret of every heartbeat check **once**. Configure the gateway – one call per check, or a [gateway](#gateway-batch) for all checks.
4. **Outputs.** *Edit → Outputs*: notification subscribers (e.g. `team:maintenance`), Zabbix, Gatus, a webhook or a runbook.
5. **Watch it.** The detail page shows the graph coloured by status, the root cause, and per check the latest results, status changes and uptime. *Monitors → Status wall* is made for a screen in the control room.

What happens when …

| Situation | Result |
| --- | --- |
| The gateway stops reporting the PowerMeter | *PowerMeter data reported by the gateway* goes down; a little later *… in Insights Hub* too, but it is shown as *likely caused by* the gateway check. One notification: *Down: Machine 17 – PowerMeter · Root cause: PowerMeter data reported by the gateway*. |
| The PowerMeter check fails, but data still arrives | Only the PowerMeter check is down (with the note that its dependents are healthy); the machine branch stays up. |
| The machine branch fails on its own | The sub-monitor goes down with its own root cause and its own alert; the PowerMeter monitor shows the sub-monitor node down with that root cause. |
| Insights Hub answers with an error | The freshness checks are `unknown` (the data path could not be checked), not `down`. |

In demo mode (`npm run demo` → *Load demo data*) all of this runs against simulated platforms: an **IoT gateway simulator** reports every 30 s through the real batch endpoint, and the PowerMeter of *Machine 18* (created from the template) stopped reporting 25 minutes ago, so its monitor shows a realistic root cause.

## Check types

Common fields: `id`, `name`, `description`, `intervalSeconds`, `timeoutSeconds`, `critical`, `enabled`, `failuresBeforeDown`, `successesBeforeUp`, `key` (heartbeat: the key for gateway reports; default `<monitor key>.<check id>`).

| Type | Fields | Result |
| --- | --- | --- |
| `ping` | `host`, `fallbackPort` (default 80), `degradedRttMs` | Runs the system `ping` with fixed arguments (`-n -c 1 -W <s>`, Windows `-n 1 -w <ms>`); the host must not start with `-`. Where ping is not installed or ICMP is not permitted (containers, sandboxes), a **TCP connect** to `fallbackPort` is used – an accepted *or refused* connection proves the host answers; the message says so. |
| `tcp` | `host`, `port`, `degradedMs` | Connect within the timeout. |
| `http` | `url`, `method` (GET/HEAD/POST), `headers`, `body`, `expectStatus` (`200`, `200-299`, `200,204`; default `200-399`), `condition` (JSONata over `{status, headers, body, durationMs}`), `degradedResponseMs`, `tlsExpiryWarnDays` (default 14), `insecureTls`, `useProxy` (default true) | Down on an unexpected status or a false condition; degraded when slow or when the certificate expires soon. Bodies are read up to 1 MB. |
| `platform` | `platform`, `method`, `path`, `query`, `headers`, `body`, `condition`, `degradedResponseMs` | A call through a configured platform: its authentication, base URL, proxy/CA settings, retries and concurrency limit. Default: HTTP 2xx. |
| `freshness` | `source: insightsHub` with `platform`, `assetId`, `aspect`, `variables[]` – or `source: platform` with `platform`, `path`, `query`, `timestamp` (JSONata returning a timestamp or a list); plus the freshness fields below | The newest timestamp of every variable must be recent; the worst variable counts. |
| `heartbeat` | freshness fields, `condition` (JSONata over the last report), `statusExpression`, `authMode` (token, hmac, either), `allowedCidrs`, `rateLimitPerMinute` (default 60) | Fed by [reports](#heartbeat-api-for-gateways). Evaluated on its interval too, so a **missing** report turns it down without any request. Before the first report: `unknown`, and `down` once the window has passed. |
| `gatus` | `platform` (Gatus), `endpointKey`, `maxAgeSeconds`, `degradedOnRecentFailures` | Status of a Gatus endpoint (newest result). All Gatus checks of a cycle share one `GET /api/v1/endpoints/statuses`. |
| `monitor` | `monitor` (id or key) | The other monitor's status (`maintenance` counts as up here); root causes are taken over. |

**Freshness fields.** `mode: cadence` – `expectedIntervalSeconds`, degraded after `degradedAfterMissed` missed intervals (default 2), down after `downAfterMissed` (default 4). `mode: maxAge` – for **on-change data**: down when the newest value is older than `maxAgeSeconds`, degraded after `degradedAgeSeconds` (optional).

**Insights Hub time series.** Steward reads `GET {tsPath}/timeseries/{assetId}/{aspect}?latestRecord=true` (`tsPath` is the platform variable, default `/api/iottimeseries/v3`). The latest record comes from the raw store but only contains the variables written at that moment, so for the other variables a second call reads `?from=<now − window>&to=<now>&select=<variables>` and takes the newest value per variable. `latestValue=true` is not used: it reads aggregated data that can lag 1–2 hours. **All checks on the same asset and aspect that are due in the same cycle share these calls** (checks with the same asset/aspect and interval are scheduled into the same cycle); answers are reused for 10 s. With 20–30 machines and a few variables each, that is one or two calls per asset/aspect and interval.

## Heartbeat API for gateways

### One check

`POST /api/hooks/monitor/<hook id>` – the URL is shown on the check (*Heartbeat setup*). Body: JSON, at most 64 KB.

```json
{ "status": "up", "value": 42.7, "ts": "2026-10-22T08:15:00Z", "data": { "unit": "kW" } }
```

| Field | |
| --- | --- |
| `status` | optional: `up`/`ok`/`true`, `degraded`/`warning`, `down`/`error`/`false` … (`statusExpression` can compute it from the report instead) |
| `value` | optional, any JSON value; available to `condition`, e.g. `value > 0` |
| `ts` | optional, when the gateway took the measurement (ISO 8601 or Unix time). Freshness is computed from it, but never later than the moment the report arrived. Default: arrival time. |
| `data` | optional, anything else; shown on the check |

```bash
curl -sS -X POST "https://steward.corp.example/api/hooks/monitor/hb_XXXXXXXX" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $STEWARD_HEARTBEAT_SECRET" \
  --data '{"value": 42.7, "ts": "2026-10-22T08:15:00Z"}'
```

Answer: `202 {"accepted": true, "status": "up"}` (the check's status after this report).

### Gateway batch

A gateway usually prefers **one call for many checks**. Create a gateway under *Monitors → Gateways* (designers and administrators); its secret is shown once. Optional *allowed keys* (`m17.*`) limit what it may report.

`POST /api/hooks/monitors`

```json
{
  "reports": [
    { "key": "m17.powermeter", "ts": "2026-10-22T08:15:00Z", "value": 42.7 },
    { "key": "m17.machine", "ts": "2026-10-22T08:14:31Z", "value": 1450, "data": { "state": "running" } }
  ]
}
```

A bare array is accepted too; at most 500 reports per call; the newest report per key counts. Answer: `202 {"accepted": 2, "rejected": [{ "index": 3, "key": "m99.x", "reason": "unknown key" }]}`.

### Security (same model as webhook triggers)

- **Authentication:** static token (`Authorization: Bearer <secret>` or `X-Steward-Token`) or HMAC (`X-Steward-Signature: sha256=<hex HMAC-SHA256 of the raw body>`; for gateways also `X-Steward-Gateway: <gateway id>`). Secrets have 256 random bits, are stored encrypted (HMAC) and as SHA-256 (constant-time comparison), are shown once and can be rotated (audited).
- **Answers:** `404` unknown or disabled check/gateway, or source address not in the allow-list (same answer) · `503` vault locked · `401` wrong secret · `415` not JSON · `400` invalid JSON or report · `413` body over 64 KB · `429` + `Retry-After` over the rate limit.
- **Audit:** rejected calls are written as `monitor.report_rejected` at most once per endpoint and reason every 10 minutes; accepted reports are only counted (they are frequent).
- No session and no `x-sm-client` header is needed; put `/api/hooks/` behind TLS and allow only the gateway's network.

MQTT is not supported yet; a small bridge (e.g. Node-RED) can turn MQTT messages into the batch call.

## Outputs

Outputs are configured per monitor (*Edit → Outputs*) and can include the monitor status, every check, or both (`include`), optionally only some checks (`checks`) and statuses (`statuses`). They send **on change** (default) or **after every evaluation** (`on: every`, at most every `minIntervalSeconds`, default 60). Per output and subject the last delivered status is stored: nothing is sent twice (also not after a restart), and a failed delivery is retried with a later evaluation (at most once a minute). Targets may use `${monitor.key}`, `${monitor.name}`, `${check.id}`, `${check.key}` and `${check.name}`.

| Type | Default subjects | During maintenance |
| --- | --- | --- |
| `notification` | the monitor | silenced |
| `process` | the monitor, status `down` only | silenced |
| `webhook`, `zabbix` | monitor and checks | sent with status `maintenance` (code 5) |
| `gatus` | monitor and checks | not sent |

### Notifications

Event `monitor.status` (in-app, and e-mail/Teams/webhook as routed under *Settings → Notifications*). Recipients: the **owner** and the **subscribers** (`user:…`, `team:…`, `role:…`) who may view the monitor. People are told about *confirmed problems and their recovery*: a check folded into its parent's failure (`suppressDependents`, default on) and an acknowledged monitor stay quiet; `unknown` is only sent when selected in `statuses`. `holdSeconds` waits before alerting, so a parent that fails a little later can still explain the failure.

### Webhook

`POST` to `url` (no credentials in the URL) – or to `platform` + `path`, using that platform's authentication:

```json
{
  "source": "steward",
  "monitor": { "id": "mon_…", "key": "machine-17-powermeter", "name": "Machine 17 – PowerMeter" },
  "events": [
    {
      "level": "check", "status": "down", "statusCode": 2, "previous": "up", "since": "2026-10-22T08:20:00.000Z",
      "ts": "2026-10-22T08:20:00.000Z", "message": "Newest report is 5 min old, expected every 60 s (5 intervals missed)",
      "rootCauses": [], "check": { "id": "pm-reports", "key": "m17.powermeter", "name": "PowerMeter data reported by the gateway", "type": "heartbeat" },
      "monitor": { "id": "mon_…", "key": "machine-17-powermeter", "name": "Machine 17 – PowerMeter", "status": "down" },
      "durationMs": null, "value": 42.7
    }
  ]
}
```

### Runbooks

`type: process` starts a process as the **monitor owner** (their rights are checked at every start) with inputs mapped by JSONata over `{ monitor, check, event }`, e.g. `machine: monitor.name`, `cause: event.rootCauses[0].checkName`. The run shows *Monitor "…"* as its origin; while the previous run of the output is still active, no new one is started.

### Gatus external endpoints

```yaml
# Gatus config.yaml
external-endpoints:
  - name: machine-17-powermeter
    group: steward
    token: "${STEWARD_EXTERNAL_TOKEN}"
    heartbeat:
      interval: 10m
```

Output: `type: gatus`, the Gatus platform, `endpointKey: steward_${monitor.key}`, credential `externalToken` on the platform (or `tokenSecret`). Steward sends `POST /api/v1/endpoints/<key>/external?success=true|false&error=…&duration=…ms` with `Authorization: Bearer <token>`. `up` and `degraded` count as success. See [GATUS.md](GATUS.md#3-push-steward-check-results-into-gatus).

### Zabbix push

Add a platform from the preset **Zabbix (monitor outputs)**: variable `host` (the Zabbix host the items belong to), `trapperHost`/`trapperPort` (server or proxy, default 10051), `apiPath` (default `/api_jsonrpc.php`) and, for the API mode, the credential `token` (API token).

Default item keys (change them with `itemKeyMonitor` / `itemKeyCheck`):

- `steward.monitor.status[<monitor key>]`
- `steward.check.status[<monitor key>,<check id>]`

Values: `0` up, `1` degraded, `2` down, `3` unknown, `4` blocked, `5` maintenance – or the status word with `value: text`.

**a) Sender / trapper protocol** (`via: sender`, default). In Zabbix create items of type **Zabbix trapper** with these keys (type of information *Numeric (unsigned)*, a value map 0–5), and put Steward's address into *Allowed hosts*. Steward speaks the `zabbix_sender` protocol over TCP: header `ZBXD` + `0x01`, 4-byte little-endian data length, 4 reserved bytes, then `{"request":"sender data","data":[{"host","key","value","clock","ns"}]}`; the answer's `info` (`processed: 2; failed: 0; total: 2; seconds spent: …`) is checked – any `failed` value is reported as an output error (usually a wrong host name, item key or item type). TLS/PSK for the trapper connection is not supported; allow unencrypted connections for this host or use the API mode over HTTPS.

**b) API `history.push`** (`via: api`, Zabbix **7.0** or later). The same trapper items (or HTTP agent items with *Enable trapping*); the Zabbix frontend's address must be in the items' *Allowed hosts*. Steward calls `history.push` with `[{host, key, value, clock, ns}]` and `Authorization: Bearer <API token>` and reports per-value errors from the answer.

Use `on: every` with `minIntervalSeconds: 60` and a Zabbix trigger such as

```
last(/steward/steward.monitor.status[machine-17-powermeter])=2
nodata(/steward/steward.monitor.status[machine-17-powermeter],5m)=1
```

so Zabbix also notices when Steward itself stops sending.

### Zabbix pull

The public API (token with scope *read*, a viewer service account is enough) serves everything for Zabbix **HTTP agent** items:

1. **Discovery rule** (HTTP agent): URL `https://steward.corp.example/api/v1/monitors/discovery`, header `Authorization: Bearer {$STEWARD_TOKEN}`. Answer:

   ```json
   {"data":[{"{#MONITOR}":"machine-17-powermeter","{#MONITORNAME}":"Machine 17 – PowerMeter","{#MONITORID}":"mon_…","{#CHECK}":"pm-reports","{#CHECKNAME}":"PowerMeter data reported by the gateway","{#CHECKTYPE}":"heartbeat","{#CHECKKEY}":"m17.powermeter"}]}
   ```

   `?level=monitors` returns one entry per monitor.
2. **Item prototype** (HTTP agent): URL `https://steward.corp.example/api/v1/monitors/{#MONITOR}/status`, same header, preprocessing *JSONPath* `$.checks[?(@.checkId=='{#CHECK}')].statusCode.first()`.
   With many checks, prefer a discovery rule with `level=monitors`, one master item per monitor (`/monitors/{#MONITOR}/status`, type text, history 0) and dependent items with JSONPath – one request per monitor instead of one per check.
3. The monitor status itself: JSONPath `$.statusCode` on the same answer.

The API is rate-limited per token (`SM_API_RATE_LIMIT`, default 600/min).

### Prometheus

`/api/metrics` (see the README) contains

```
steward_monitor_status{monitor="machine-17-powermeter",check=""} 0            # the monitor itself
steward_monitor_status{monitor="machine-17-powermeter",check="pm-reports"} 2
steward_monitor_last_ok_timestamp{monitor="machine-17-powermeter",check="pm-reports"} 1792656000
steward_monitor_evaluations_total{type="heartbeat",result="up"} 1234
```

```yaml
- alert: StewardMonitorDown
  expr: steward_monitor_status{check=""} == 2
  for: 2m
```

### Dashboards

Steward publishes the dataset **`monitors.status`** (one row per monitor; visible to users who may view every monitor) and **`monitor.<key>`** (one row per check) at most once a minute, with the metrics `up`, `down`, `degraded`, `unknown`, `monitors` / `checks`, `uptime24h`. Use them in table, status and KPI widgets like any other dataset.

## Templates for many machines

A template is a monitor definition with parameters. `{{ params.<name> }}` placeholders may stand anywhere – also where numbers are expected, e.g. `fallbackPort: "{{ params.pmPort }}"` or `maxAgeSeconds: "{{ params.machineMaxAge + 300 }}"` (JSONata). They are replaced **once**, when an instance is created.

- *Monitors → Templates → New monitors*: one instance with a form, or **many from CSV** (header line = parameter names, optional `name` and `key` columns; `,` or `;`). All rows are validated first; a bad row creates nothing.
- An instance remembers its template, the template version and its parameters. When the template changes, the instance shows *template updated*; **Re-sync** renders the current version again (heartbeat endpoints and secrets stay).
- `examples/monitors/30-powermeter-machine-template.yaml` is a complete template for a machine with a PowerMeter.

A process can create instances too: `POST /api/monitors/<template id>/instances` with `{ "rows": [ { "params": { … }, "name": "…" } ] }` (or `{ "csv": "…" }`) and an API token with scope *full*.

## Permissions and audit

| Right | Default roles | Allows |
| --- | --- | --- |
| `view` | everyone | See the monitor, its checks and history (also in the API and datasets) |
| `acknowledge` | operator, designer | Acknowledge problems, plan maintenance, *Check now* |
| `edit` | designer | Change the definition, rotate heartbeat secrets, re-sync |
| `manage` | admin, owner | Access list, owner, delete |

Designers and administrators create monitors and gateways; the creator becomes the owner. An access list (users, teams, roles) narrows the rights like for processes. Checks and outputs that use a platform need the *use* right of the editor when saving and of the **owner** when they run (checked again at least once a minute). The audit log records `monitor.created`, `monitor.updated` (with added, removed and changed checks), `monitor.deleted`, `monitor.access_changed`, `monitor.secret_rotated`, `monitor.maintenance_added`/`_ended`, `monitor.acknowledged`, `monitor.resynced`, `monitor.gateway_*` and `monitor.report_rejected`.

## Engine, storage and limits

- **Scheduler.** A light scheduler next to the process engine (monitor checks do **not** create process runs). Each check runs on a fixed grid of its interval with a stable phase per check, so shared reads land in the same cycle and restarts keep the rhythm. Active checks run with a global concurrency limit (`SM_MONITOR_CONCURRENCY`, default 8), a timeout each and the platform's own concurrency limit; OpenTelemetry spans `monitor check <type>` are recorded when tracing is on.
- **State.** Status, counters, the latest result and heartbeat reports live in the database, so a restart continues where it stopped. Status **changes** are kept as history, uptime comes from **hourly samples** (evaluations that were ok vs. down) for checks and from the time-weighted history for monitors; the latest 50 raw results per check are kept.
- **Retention.** *Settings → Data retention → Monitor history* (`retentionMonitorDays`, default 30) – history, samples, results and past maintenance windows are removed by the daily cleanup; the newest status change per check is kept.
- **Database.** SQLite or PostgreSQL, like everything else. One Steward instance per database (enforced), which is also why rate-limit counters may live in memory.
- **Sizes.** Up to 100 checks and 30 outputs per monitor; heartbeat bodies up to 64 KB; at most 500 reports per gateway call. Designed for dozens of monitors with a handful of checks each and intervals of 30 s or more.

Limitations: no MQTT ingestion yet (use a bridge); no TLS/PSK for the Zabbix trapper connection; the ping fallback can only say "reachable", not measure ICMP round trips; Zabbix discovery is pull-only (Steward does not create Zabbix items).

## Protocol facts and sources

Checked on 2026-10-22; verify against your versions.

| Fact | Source |
| --- | --- |
| Zabbix sender protocol: `ZBXD`, flags `0x01` (protocol), `0x02` (compression), `0x04` (large packet), 4-byte little-endian data length + 4 reserved bytes; request `{"request":"sender data","data":[{host,key,value,clock,ns}]}`; answer `{"response":"success","info":"processed: 1; failed: 0; total: 1; seconds spent: 0.060753"}` | Zabbix manual, *Zabbix sender protocol* and *Header* (7.0–8.0): <https://www.zabbix.com/documentation/current/en/manual/appendix/protocols/zabbix_sender> |
| `history.push` exists since Zabbix 7.0 (ZBXNEXT-8541); records use `itemid` or `host` + `key`, `value`, `clock`, `ns`; result `{"response":"success","data":[{"itemid":"…"} or {"error":"…"}]}`; the frontend address must be in the trapper items' *Allowed hosts* | <https://www.zabbix.com/documentation/7.0/en/manual/api/reference/history/push>, <https://support.zabbix.com/browse/ZBXNEXT-8541> |
| Zabbix LLD JSON `{"data":[{"{#MACRO}":"value"}]}` | Zabbix manual, low-level discovery |
| Insights Hub IoT Time Series v3 `GET /timeseries/{entityId}/{propertySetName}` with `from`, `to`, `select`, `limit`, `latestValue`, `latestRecord`; `latestValue` reads aggregated data (1–2 h delay), `latestRecord` the raw store but only the variables of the newest record | Siemens Insights Hub API docs and support articles *latestValue and latestRecord while querying TimeSeries Data* (PL8555040), *IOT timeseries API not returning latest value* (PL8543152) |
| Gatus external endpoints: `POST /api/v1/endpoints/{key}/external?success=&error=&duration=`, `Authorization: Bearer <token>` | Gatus README, see [GATUS.md](GATUS.md) |
