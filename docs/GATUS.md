# Gatus and Steward

[Gatus](https://github.com/TwiN/gatus) (Apache-2.0) is an uptime monitor with a status page and alerting. Steward does **not** re-implement monitoring: Gatus keeps checking your endpoints every few seconds, keeps the history and sends the alerts. Steward adds what Gatus does not do: procedures with approvals, an audit trail and protocols, and dashboards next to your other platform data.

The two work together in four directions, plus a metrics mode that gives Steward its own history of Gatus' results:

| #   | Direction                                       | How                                                                                                                                                                        |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Gatus monitors Steward**                      | Gatus endpoints for `/api/health` and `/api/ready`                                                                                                                         |
| 2   | **Steward shows Gatus status** (read-only)      | Connector type _Gatus_, process _Gatus – uptime overview_, dashboard _Uptime_                                                                                              |
| 3   | **Steward reports its own checks to Gatus**     | Gatus _external endpoint_, process _Gatus – report Steward check to Gatus_                                                                                                 |
| 4   | **A Gatus alert starts a Steward runbook**      | Gatus _custom alerting provider_ → Steward **webhook trigger** → _Diagnose endpoint outage_                                                                                |
| 5   | **Steward keeps Gatus' history** (metrics mode) | Steward scrapes Gatus' Prometheus endpoint `/metrics`: uptime, outages, response times and certificate expiry for monitors, scheduled reports and the credentials register |

Everything below was written against the Gatus README and source (`api/*.go`, `alerting/provider/custom/custom.go`, `config/key/key.go`) on `master`, latest release **v5.37.0**, checked on 2026-10-22. Gatus has no formally versioned API, so check a release's README if you run an older version.

In demo mode (`npm run demo` → _Load demo data_) a simulated Gatus with healthy, degraded and failing endpoints is available as the platform **Gatus (demo)**, so you can try everything here without a Gatus instance.

## 1. Gatus monitors Steward

Steward has two probes that need no sign-in:

- `GET /api/health`: liveness. `200 {"ok":true,"version":"…"}` while the process runs.
- `GET /api/ready`: readiness. `200 {"ready":true,"checks":{…}}` when the vault is unlocked, the database is writable and the scheduler is armed; otherwise `503` with `"ready": false` and the failing check in `checks`.

```yaml
# Gatus config.yaml
endpoints:
  - name: steward-api
    group: steward
    url: 'https://steward.corp.example/api/health'
    interval: 1m
    conditions:
      - '[STATUS] == 200'
      - '[RESPONSE_TIME] < 1000'
  - name: steward-ready
    group: steward
    url: 'https://steward.corp.example/api/ready'
    interval: 1m
    conditions:
      - '[STATUS] == 200'
      - '[BODY].ready == true'
    alerts:
      - type: slack # or any other provider; a locked vault after a restart shows up here
        send-on-resolved: true
```

- Steward rejects foreign `Host` headers. Gatus sends the host name of the URL, so add it to `SM_ALLOWED_HOSTS` (e.g. `SM_ALLOWED_HOSTS=steward.corp.example`).
- `/api/ready` going to 503 after a restart usually means nobody has unlocked the vault yet. Set `SM_MASTER_PASSPHRASE_FILE` for unattended start-up (see [SECURITY-HARDENING.md](SECURITY-HARDENING.md#master-passphrase)).

## 2. Show Gatus status in Steward

### Add the platform

_Platforms → Add platform → Gatus (status monitoring)_:

| Field          | Value                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL       | The Gatus address without `/api`, e.g. `https://status.corp.example`                                                                                                                                        |
| Authentication | `none` if the Gatus API is open. `basic` if Gatus has `security.basic`: enter the user name and the **plain** password as the credentials `username`/`password` (Gatus itself only stores the bcrypt hash). |
| Credentials    | `externalToken` only for direction 3                                                                                                                                                                        |

- **Gatus OIDC** (`security.oidc`) protects the API with a browser session cookie only; automation cannot use it. Either use `security.basic` instead (with both configured, Gatus applies OIDC), or expose the read-only status API through a reverse proxy that checks a token. In that case choose `bearer` and set the credential `token`.
- Use a Gatus account that can only read. The status API is read-only anyway.
- The platform comes with an OpenAPI description of the Gatus routes Steward uses, so _Pick from API spec_ in the editor and the API explorer list them. _Test connection_ calls `/api/v1/endpoints/statuses?pageSize=1`.

### Two ways to read Gatus: API mode and metrics mode

|                         | API mode (default)                                                                                                           | Metrics mode                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Reads                   | `GET /api/v1/endpoints/statuses` (the newest results)                                                                        | `GET /metrics` (Prometheus text), every 60 s by default                                                         |
| Authentication in Gatus | `security.basic` (Steward sends the platform's basic auth); with `security.oidc` only through a token-checking reverse proxy | **none** – `/metrics` is always open in Gatus; restrict it in the network (see [Metrics mode](#5-metrics-mode)) |
| History                 | What Gatus returns (at most `maximum-number-of-results` per endpoint)                                                        | Steward's own: hourly figures for 90 days, single samples for 14 days (configurable)                            |
| Provides                | Status of the newest result, recent failures, response time of the newest results                                            | Status, uptime from result counters, outages, response times (avg, p95), TLS certificate and domain expiry      |
| Used by                 | Monitor check _Gatus endpoint_, processes, dashboards                                                                        | Monitor check _Gatus endpoint_ (data source _metrics_), scheduled reports, credentials register (expiry sync)   |

Both can be used at the same time. With metrics mode on, a monitor's _Gatus endpoint_ check reads the scraped state automatically (data source _Automatic_); choose _Gatus status API_ to keep using the API.

### Gatus API facts the processes rely on

| Route                                                             | Auth in Gatus                                     | Notes                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/endpoints/statuses?page=&pageSize=`                  | protected (`security.*`)                          | **All** endpoints in one array: `key`, `name`, `group`, `results[]`. `page`/`pageSize` page the _results of each endpoint_, not the endpoint list (defaults 1 and 50; page 1 is capped at `storage.maximum-number-of-results`, default 100). |
| `GET /api/v1/endpoints/{key}/statuses`                            | protected                                         | One endpoint, plus `events` (`START`, `HEALTHY`, `UNHEALTHY`).                                                                                                                                                                               |
| `GET /api/v1/endpoints/{key}/uptimes/{1h\|24h\|7d\|30d}`          | open                                              | `text/plain` fraction, e.g. `0.958333`.                                                                                                                                                                                                      |
| `GET /api/v1/endpoints/{key}/response-times/{1h\|24h\|7d\|30d}`   | open                                              | `text/plain` average in ms.                                                                                                                                                                                                                  |
| `POST /api/v1/endpoints/{key}/external?success=&error=&duration=` | `Authorization: Bearer <external endpoint token>` | See direction 3.                                                                                                                                                                                                                             |

- A result has `success`, `timestamp`, `duration` (**nanoseconds**), `status` (HTTP status, omitted for TCP/ICMP/DNS checks), `hostname`, `errors[]` and `conditionResults[]`. Results are ordered oldest first; the last one is the latest check.
- The endpoint **key** is `<group>_<name>`, both lower-cased, with space, `/`, `_`, `,`, `.`, `#`, `+` and `&` replaced by `-`. An endpoint without a group has the key `_<name>`.

### Process and dashboard

1. _Processes → From template → Gatus – uptime overview_ (`examples/processes/71-gatus-uptime-overview.yaml`).
2. _Dashboards → From template → Uptime_ (`examples/dashboards/40-uptime.yaml`).
3. _Schedules → New schedule_: the process, cron `*/10 * * * *` (every 10 minutes; 5–15 minutes is sensible), the Gatus platform for the `gatus` connection. Use a service account as the owner.

Per run the process reads all statuses, computes per endpoint

| Column                       | Meaning                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Healthy                      | `success` of the latest result                                                                                                                                         |
| Uptime (%)                   | from Gatus' uptime API for the chosen window (input `uptimeWindow`, default `24h`; one call per endpoint, four at a time), or with `results` from the returned results |
| Avg / last response (ms)     | average over the returned results / the latest one                                                                                                                     |
| Last check (UTC), last error | timestamp and `errors` of the latest result                                                                                                                            |

and publishes the dataset **`gatus-uptime`**: row status `critical` when down, `warning` below `minUptimePercent` (99) or above `maxResponseMs` (1000 ms average), otherwise `good`; metrics `endpoints`, `down`, `avgUptime`. The check _All endpoints healthy_ (severity warning) fails while an endpoint is down, so the failed-check notification fires, but the run itself succeeds. Gatus remains the place for alerting; you do not need to alert on this check twice.

## 3. Push Steward check results into Gatus

Gatus can show results that someone else measured, as _external endpoints_. Steward can be that someone: a scheduled check (e.g. a login flow or an API sequence Gatus cannot do) reports pass/fail, and Gatus shows it on the status page and alerts on it, including when results stop arriving (`heartbeat`).

```yaml
# Gatus config.yaml
external-endpoints:
  - name: steward-checks
    group: steward
    token: '${STEWARD_EXTERNAL_TOKEN}' # Gatus substitutes environment variables
    heartbeat:
      interval: 30m # alert when Steward stops reporting
    alerts:
      - type: slack
        send-on-resolved: true
```

1. Generate a long random token (e.g. `openssl rand -base64 32`), give it to Gatus as `STEWARD_EXTERNAL_TOKEN` and store it on the Gatus platform in Steward as the credential **`externalToken`**.
2. _From template → Gatus – report Steward check to Gatus_ (`72-gatus-report-check.yaml`). Inputs: the endpoint key (`steward_steward-checks` for the snippet above), the path to check on the `target` platform, the latency limit and the name of the token credential (one credential per external endpoint if you push to several).
3. Schedule it more often than the heartbeat interval.

The first two steps are the check; replace them with any check of your own. Only `success`, `error` and `duration` are sent: `POST /api/v1/endpoints/<key>/external?success=true|false&error=…&duration=<ms>ms` with `Authorization: Bearer <token>`. That token belongs to the external endpoint, not to the Gatus login; the step sets the header itself. It is read with `$secret()` and redacted from the protocol. Dry runs record the POST without sending it.

## 4. Gatus alerts start a Steward runbook

Gatus' **custom alerting provider** can call any URL. Point it at a Steward **webhook trigger**, and every alert starts a process: here the runbook _Diagnose endpoint outage (from Gatus alert)_ (`73-gatus-diagnose-outage.yaml`). It

1. reads the recent results of the endpoint from Gatus,
2. probes the endpoint URL once more, but **only if the URL lies below the base URL of the `probe` platform**,
3. writes the evidence into the protocol,
4. asks _Run remediation?_ (approvers or admins, four-eyes: not the trigger's owner), and
5. runs the remediation step, which is an **example placeholder** that only writes a log line. Replace it with your own steps.

A `RESOLVED` alert is only logged.

### Set up Steward

1. Import the runbook from the template.
2. Add a platform for the probe: _Generic REST API_, auth `none`, base URL covering the applications Gatus watches (e.g. `https://apps.corp.example`). The runbook never sends credentials to an address taken from the alert; URLs outside the probe platform are not called.
3. _Triggers → New webhook trigger_:
   - Process _Diagnose endpoint outage_, connections `gatus` and `probe`.
   - _Map a Gatus alert_ fills the input mapping below.
   - Ignore identical payloads for **300 s** (Gatus re-sends an alert as a reminder when `minimum-reminder-interval` is set) and keep _Skip while the previous run is still running or waiting_ on.
   - Allowed source addresses: the address of the Gatus host (see _Security_).
4. **Save → copy the secret.** It is shown once. The dialog also shows the URL and ready-to-copy curl and Gatus snippets.

| Process input   | Mapping (JSONata over the request) | Gatus placeholder in the body   |
| --------------- | ---------------------------------- | ------------------------------- |
| `endpointName`  | `body.name`                        | `[ENDPOINT_NAME]`               |
| `endpointGroup` | `body.group`                       | `[ENDPOINT_GROUP]`              |
| `endpointUrl`   | `body.url`                         | `[ENDPOINT_URL]`                |
| `alertState`    | `body.event`                       | `[ALERT_TRIGGERED_OR_RESOLVED]` |
| `errors`        | `body.errors`                      | `[RESULT_ERRORS]`               |
| `description`   | `body.description`                 | `[ALERT_DESCRIPTION]`           |

### Configure Gatus

```yaml
# Gatus config.yaml
alerting:
  custom:
    url: 'https://steward.corp.example/api/hooks/wht_XXXXXXXXXXXX'
    method: 'POST'
    headers:
      Content-Type: 'application/json' # Gatus sends no content type on its own
      Authorization: 'Bearer ${STEWARD_WEBHOOK_SECRET}' # from Gatus' environment, never in the file
    body: |
      {
        "event": "[ALERT_TRIGGERED_OR_RESOLVED]",
        "name": "[ENDPOINT_NAME]",
        "group": "[ENDPOINT_GROUP]",
        "url": "[ENDPOINT_URL]",
        "description": "[ALERT_DESCRIPTION]",
        "errors": "[RESULT_ERRORS]"
      }
    default-alert:
      send-on-resolved: true
      failure-threshold: 3
      success-threshold: 2

endpoints:
  - name: historian-api
    group: plant
    url: 'https://apps.corp.example/historian/health'
    interval: 1m
    conditions:
      - '[STATUS] == 200'
      - '[BODY].status == UP'
    alerts:
      - type: custom
        description: 'historian health check failed'
```

- Start Gatus with `STEWARD_WEBHOOK_SECRET` in its environment (Docker: `-e STEWARD_WEBHOOK_SECRET=…` or a secret file mapped into the variable). The secret contains no `$`, so Gatus' `$$` escaping does not apply.
- `alerting.custom.overrides` (per `group`) can send different groups to different triggers, each with its own secret.
- Gatus fills the placeholders by plain text replacement and only escapes double quotes in `[RESULT_ERRORS]`. An error text with a backslash or line break makes the body invalid JSON; Steward then answers `400` and Gatus logs `call to provider alert returned status code 400`. Leave `[RESULT_ERRORS]` out if your checks produce such errors; the runbook reads the errors from the Gatus history anyway.
- Gatus logs any answer other than 2xx as a failed alert. Steward answers `202` also when it skips a run (duplicate, previous run still waiting), so Gatus does not retry those.

## 5. Metrics mode

Gatus publishes Prometheus metrics at `/metrics` when its configuration contains `metrics: true`. Steward reads them on an interval and keeps its own compact history, so it can report availability over weeks and months without a Prometheus server.

```yaml
# Gatus config.yaml
metrics: true
```

### What Gatus publishes (checked against `metrics/metrics.go` on master)

| Metric                                                      | Type    | Steward uses it for                                          |
| ----------------------------------------------------------- | ------- | ------------------------------------------------------------ |
| `gatus_results_total{key,group,name,type,success}`          | counter | number of successful and failed results → uptime             |
| `gatus_results_endpoint_success{key,…}`                     | gauge   | state of the newest result (1/0) → status, outages           |
| `gatus_results_duration_seconds{key,…}`                     | gauge   | response time of the newest result                           |
| `gatus_results_certificate_expiration_seconds{key,…}`       | gauge   | TLS certificate expiry → endpoint list, credentials register |
| `gatus_results_domain_expiration_seconds{key,…}`            | gauge   | domain expiry (shown in the endpoint list)                   |
| `gatus_results_code_total`, `gatus_results_connected_total` | counter | (ignored)                                                    |
| `process_start_time_seconds`                                | gauge   | detects Gatus restarts (counters start at zero again)        |

Extra labels Gatus adds (`extra-labels`) are summed up per endpoint key.

### Turn it on

1. Set `metrics: true` in Gatus and restart it.
2. **Restrict access to `/metrics`.** Gatus serves it without authentication, also when `security.basic` or `security.oidc` protects the rest. It reveals endpoint names, groups, response times and certificate dates. Options:
   - a reverse proxy in front of Gatus that forwards `/metrics` only from Steward's host (allow-list by source address), or
   - a Gatus that is only reachable from Steward's host (firewall, internal network).
     If the proxy expects credentials, configure the platform's authentication (_basic_ or _bearer_): Steward sends them, and only to the platform's own origin.
3. _Platforms → your Gatus platform → Metrics → Turn on metrics mode_. Settings:

   | Setting                         | Default    | Notes                                                                                                                                                                                                                                   |
   | ------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Metrics path                    | `/metrics` | A path below the base URL; absolute URLs, `.`/`..` segments and encoded dots or slashes (`%2e`, `%2f`, `%5c`) are refused, so the scrape stays below the base URL on the platform's origin                                              |
   | Interval                        | 60 s       | 15 s – 1 h                                                                                                                                                                                                                              |
   | Keep history                    | 90 days    | Hourly figures and status changes                                                                                                                                                                                                       |
   | Keep single samples             | 14 days    | One row per scrape and endpoint; needed for p95 response times and short outages                                                                                                                                                        |
   | Also read Gatus' uptime figures | off        | Once an hour per endpoint, `GET /api/v1/endpoints/{key}/uptimes/{1h,24h,7d,30d}` (unauthenticated in Gatus; answers `text/plain` like `0.958333`, a JSON number or `{"uptime": …}` is accepted too). Shown next to Steward's own figure |

   Managing metrics mode needs _manage_ rights on the platform; _Scrape now_ needs _use_ rights. The scrapes run with the rights of the person who saved the settings (they must keep _use_ rights on the platform). Changes are audited (`gatus.metrics_enabled`, `gatus.metrics_updated`, `gatus.metrics_removed`).

4. _Scrape now_ checks the setup (at most every 15 seconds per platform). The table lists every endpoint with its state, uptime over 24 hours, 7 and 30 days, response time, certificate expiry and the time of the newest result.

### How it works

- **Fetching**: through the platform (base URL, proxy, TLS settings), the outbound policy (_Settings → Outbound access_) and the address checks every outbound request gets. Answers above 8 MB are rejected, redirects are followed manually, the timeout is the interval (5–30 s). Errors are shown on the platform (_The last scrape failed_) and in the server log.
- **Parsing**: a small parser for the Prometheus text format with limits (bytes, lines, samples, labels, label length). Malformed lines are skipped and counted; only `gatus_*` metrics and the process start time are kept.
- **Uptime from counters**: each scrape stores the difference of `gatus_results_total{success="true"}` and `{success="false"}` since the previous scrape – the results Gatus produced in between. When a counter goes down or Gatus' process start time changes (a restart), the new value counts as the number of results since the restart. The very first scrape only sets the baseline.
- **Storage**: the newest state per endpoint, one sample per scrape (kept _Keep single samples_ days), hourly sums (kept _Keep history_ days) and the changes of the success gauge (outages; the newest change per endpoint is always kept). The daily maintenance job removes old data, and endpoints Gatus no longer reports once they were not seen for _Keep history_ days; removing metrics mode or deleting the platform deletes all data of the platform.
- **Monitor check**: _Gatus endpoint_ with data source _metrics_ (or _Automatic_ while metrics mode is on) reads the stored state: down when the newest result failed, degraded when one of the last _N_ results failed, unknown when the last successful scrape is older than three intervals, and down when Gatus produced no new result within _maximum age_.

### Limitations of metrics mode

- The resolution is the scrape interval: an outage shorter than the interval can be missed in the outage list, but it is counted in the uptime (from the counters).
- Response times are the gauge of the newest result at each scrape, not every single result.
- Endpoints that disappear from Gatus keep their history until it ages out.

## Webhook trigger reference

Webhook triggers are a general Steward feature: any system that can send an HTTP request with a header (CI pipelines, ticketing systems, other monitors) can start a process.

**Request.** `POST /api/hooks/<trigger id>`, `Content-Type: application/json`, body up to **64 KB**. No session and no `x-sm-client` header are needed. Authentication, depending on the trigger's mode:

- **Static token** (what Gatus can do): `Authorization: Bearer <secret>` or `X-Steward-Token: <secret>`.
- **HMAC signature** (GitHub style; the secret never travels): `X-Steward-Signature: sha256=<hex HMAC-SHA256 of the raw request body, keyed with the secret>`:

  ```bash
  BODY='{"name":"Historian API","event":"TRIGGERED"}'
  SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$STEWARD_WEBHOOK_SECRET" | sed 's/^.* //')
  curl -sS -X POST "https://steward.corp.example/api/hooks/wht_XXXX" \
    -H 'Content-Type: application/json' -H "X-Steward-Signature: sha256=$SIG" --data "$BODY"
  ```

- **Either**: both are accepted.

**Inputs.** One JSONata expression per process input, evaluated against `{ body, headers, query }`. `headers` contains only the header names you allow-list on the trigger, and never `Authorization`, `Cookie` or the `X-Steward-*` headers. `query` holds the URL parameters. Inputs without an expression use their default. Evaluation is limited to 1 s per expression.

**Answers.**

| Status | Body                                                                          | When                                                                                                                                                            |
| ------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 202    | `{"runId": "run_…"}`                                                          | Run started                                                                                                                                                     |
| 202    | `{"skipped": "duplicate"}`                                                    | Same payload within the de-duplication window                                                                                                                   |
| 202    | `{"skipped": "previous run still active"}`                                    | _Skip while running_ is on and the last run of this trigger is running or waiting                                                                               |
| 202    | `{"skipped": "not permitted"}`                                                | The owner is deactivated, lost the run right on the process or the use right on a bound platform, or the process is archived (the details are in the audit log) |
| 400    | `{"error": "Invalid JSON"}`                                                   | Body is not valid JSON                                                                                                                                          |
| 401    | `{"error": "Unauthorized"}`                                                   | Missing or wrong secret or signature                                                                                                                            |
| 404    | `{"error": "Not found"}`                                                      | Unknown or disabled trigger, or the source address is not allowed (same answer, so nothing is revealed)                                                         |
| 413    |                                                                               | Body over 64 KB                                                                                                                                                 |
| 415    |                                                                               | Content type is not JSON                                                                                                                                        |
| 422    | `{"error": "Input mapping failed"}` / `{"error": "Run could not be started"}` | Mapping expression failed, or a required input is missing or of the wrong type                                                                                  |
| 429    | `{"error": "Too many requests"}` + `Retry-After`                              | More calls than the trigger's limit per minute (default 30)                                                                                                     |
| 503    |                                                                               | The vault is locked                                                                                                                                             |

**Runs.** A trigger runs its process as its **owner** (the person who created it), with the owner's rights, exactly like a schedule. The rights are checked again on every call. Runs show _webhook trigger "<name>"_ as their origin, in the run list, the run page and the protocol. Failed runs send the usual _run failed_ notifications. A trigger can pin a process version and can be set to dry run.

**Managing triggers** needs the same rights as schedules: run rights on the process and use rights on the bound platforms to create one; the owner, an administrator or a process manager to change, rotate or delete it. Everyone who can see the process sees its triggers, but never the secret. _Send a test call_ sends a sample payload through the real endpoint (dry run by default), and _Recent calls_ lists accepted calls with source address, outcome and payload hash.

**Audit log.** `trigger.created`, `trigger.updated` (with the changed fields), `trigger.secret_rotated`, `trigger.deleted`; per accepted call `trigger.fired` (source address, payload SHA-256, run id), `trigger.skipped` or `trigger.failed`, followed by the run's own `run.started`. Rejected calls (wrong secret, address, rate limit, duplicates, bad content) are counted on the trigger and written as `trigger.rejected` at most once per trigger and reason every 10 minutes, with the number of suppressed calls, so a flood cannot fill the audit log.

## Security notes

- **Secrets.** 256 random bits, shown once, stored encrypted with the vault key (to verify HMAC signatures) plus a SHA-256 hash; compared in constant time. They never appear in API responses, logs, protocols or the audit log, which only records a short prefix. Rotate a secret as soon as it may have leaked; the old one stops working immediately.
- **Transport.** A static token travels with every request. Use HTTPS (`SM_TLS_CERT`/`SM_TLS_KEY` or a reverse proxy) for anything beyond `localhost`, and prefer HMAC for callers that support it. HMAC has no timestamp, so a recorded request can be replayed; the de-duplication window limits that, TLS prevents the recording.
- **Exposure.** Gatus needs to reach `POST /api/hooks/…`, and `/api/health` and `/api/ready` for direction 1, nothing else. Behind a reverse proxy, forward only these paths from the Gatus network. The host name must be in `SM_ALLOWED_HOSTS`.
- **Source addresses.** Restrict each trigger to the Gatus host's address or CIDR. Steward checks the address of the TCP peer and deliberately ignores `X-Forwarded-For` (which a caller can forge). Behind a reverse proxy it therefore sees the proxy: allow the proxy's address and restrict the source at the proxy.
- **Least privilege.** Create triggers as a service account that may run only the runbooks it needs. The owner's rights are checked on every call, and deactivating the account stops all its triggers.
- **Untrusted payload.** Everything in the request is data from outside. Map only the fields the process needs, do not use `$eval()` on payload values, and never let a payload choose where credentials go: an HTTP step with an absolute URL sends the platform's credentials to that URL. The runbook therefore probes only below a credential-less probe platform.
- **Human in the loop.** Changes after an alert should wait for an approval by someone other than the trigger owner (`fourEyes: true`), as in the runbook. Turn on _Dry run_ on the trigger while you try things out.
- **Floods.** Bodies are limited to 64 KB of JSON; calls are rate-limited per trigger; identical payloads are ignored for the de-duplication window; _skip while running_ keeps one runbook per incident.
- **Gatus credentials** (basic-auth password, external endpoint tokens) are stored as platform credentials in Steward's vault, encrypted at rest and redacted from protocols.

## Limitations

- Metrics mode: see [Limitations of metrics mode](#limitations-of-metrics-mode).
- Rate-limit and de-duplication counters live in memory and start fresh after a restart (one instance per database is enforced).
- Uptime computed from results only covers the results Gatus returns (at most `maximum-number-of-results` per endpoint); use the uptime API windows for longer periods.
- The diagnosis runbook's remediation is a placeholder by design.
