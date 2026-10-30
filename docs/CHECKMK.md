# CheckMk

Steward **reads** CheckMk; it does not replace it. Alerting on raw metrics – thresholds, predictive levels, flapping detection, notifications to on-call – stays in CheckMk. Steward combines states with other signals, follows slow trends and reports what needs a decision.

| What                                                                 | Where                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Is this host or service OK right now? Combined with other checks     | a **monitor** with checks of type `checkmk`                                 |
| Is a disk filling up, a weekly average rising, a level crossed often | the **process** _CheckMk – trend summary_, its dataset and dashboard        |
| A morning summary in Teams, a PDF as evidence                        | a daily **schedule** of that process, and a **report schedule** for the PDF |
| Alerts on raw metrics, predictive levels, on-call notifications      | CheckMk                                                                     |

## Connect a CheckMk site

1. In CheckMk, create an **automation user** for Steward (_Setup → Users → Add user_, authentication "Automation secret for machine accounts"). A read-only role is enough: Steward only reads states and metrics.
2. In Steward, _Platforms → New → CheckMk (monitoring)_. Base URL: `https://<host>/<site>/check_mk/api/1.0`; the variable `site` is the site name.
3. Credential **token**: the user name, a space, then the secret – `steward-reader 8f2…`. It is sent as `Authorization: Bearer <user> <secret>`, as the REST API expects.
4. _Test connection_ calls `GET /version`. The outbound policy must allow the host.

Needs CheckMk 2.2 or later (REST API 1.0 with the Livestatus `query` filter and the metric endpoint); checked against 2.3.

## Monitor check `checkmk`

```yaml
checks:
  - { id: host, name: db01 reachable, type: checkmk, platform: CheckMk, host: db01 }
  - { id: var, name: /var on db01, type: checkmk, platform: CheckMk, host: db01, service: 'Filesystem /var', maxAgeSeconds: 900 }
```

- `service` is the service description exactly as CheckMk shows it; without it the check reads the host.
- **States.** Services: OK → up, WARN → degraded, CRIT → down, UNKNOWN → unknown. Hosts: UP → up, DOWN → down, UNREACHABLE → unknown. A pending state (not checked yet) is unknown; with `maxAgeSeconds`, a state CheckMk has not refreshed for that long is unknown too.
- **Message.** `CheckMk: db01 / Filesystem /var WARN – <plugin output>`, plus _in a CheckMk downtime_ or _acknowledged in CheckMk_ when that applies. Steward's own maintenance windows and acknowledgements stay separate.
- **Only the current state.** Monitors stay fast and quiet: one read per site and cycle for all hosts (`GET /domain-types/host/collections/all`) and one for all services (`GET /domain-types/service/collections/all`), each filtered to what the due checks need, shared by every CheckMk check of the cycle. Dependencies, root causes, maintenance and acknowledgements work as for every check type ([MONITORS.md](MONITORS.md)).
- To post status changes of a monitor to a Teams channel, add a webhook output with the format _Teams card_ ([MONITORS.md](MONITORS.md#webhook)).

## Trend summary

The example process _CheckMk – trend summary_ (`examples/processes/78-checkmk-trend-summary.yaml`) reads the metric history of a list of series (host, service, metric id, WARN and CRIT level) with `POST /domain-types/metric/actions/get/invoke` (`type: single_metric`, `reduce: average`, the chosen time range). It is a read sent as POST, marked `mutating: false`, so it also runs in dry runs. Per series it computes:

- average, peak and latest value;
- the share of the time at or above WARN and CRIT;
- the average of the last 7 days against the 7 days before (_week on week_), and at that rate the **days until CRIT** (empty when not heading for CRIT or not within two years).

It publishes `checkmk.trends` (one row per series; metrics `series`, `crossed`, `trending`) for the dashboard **CheckMk trends** (`examples/dashboards/70-checkmk-trends.yaml`, KPIs with trend lines, day / week / month). Set the dataset's metric history to 400 days to compare months.

Its checks fail when a series is above WARN, or reaches CRIT within the forecast days (default 14). With **message on change** in the schedule's notification policy ([NOTIFICATIONS.md](NOTIFICATIONS.md)) each is sent once when it starts, with a reminder while it lasts, and once when it passes again.

**Morning summary.** Schedule it daily, e.g. `0 7 * * *`: route _Process failed checks_ to Teams (or give the schedule _only these channels: Teams_) for the morning message, and add a report schedule with the run report as PDF for the evidence.

The metric ids are CheckMk's (`fs_used_percent`, `mem_used_percent`, `load15`, `response_time`, …): _Service → Show graph → Metrics_ in CheckMk lists them.

## Demo and tests

Demo mode adds **CheckMk (demo)**, a simulated site (`server/src/mock/mockCheckmk.ts`) with four hosts and services and a month of metric history – /var on db01 fills by about 0.6 % a day. Tests: `server/test/checkmk.test.ts` (states, shared reads, the preset, Teams cards) and the example run in `server/test/examples.test.ts`.
