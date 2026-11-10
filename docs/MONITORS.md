# Monitors

Monitors are Steward's composable, dependency-aware health checks: **combined, branched and cascaded** uptime checks for machines, gateways and platforms. A monitor is a small graph of checks. Some checks Steward runs itself (ping, TCP, HTTP, platform API calls, data freshness in Insights Hub), some it reads from Gatus, and some are **pushed** to Steward by another system, for example an IoT gateway. Results go to people (notifications) and to other monitoring systems (Zabbix, Gatus, webhooks, Prometheus, the public API).

- [Steward monitors, Gatus and Prometheus](#steward-monitors-gatus-and-prometheus)
- [Concepts](#concepts)
- [Example: a machine with a PowerMeter](#example-a-machine-with-a-powermeter)
- [Check types](#check-types)
- [Heartbeat API for gateways](#heartbeat-api-for-gateways)
- [Outputs](#outputs): [notifications](#notifications), [webhook](#webhook), [runbooks](#runbooks), [Gatus](#gatus-external-endpoints), [Zabbix push](#zabbix-push), [Zabbix pull](#zabbix-pull), [Prometheus](#prometheus), [dashboards](#dashboards)
- [Templates for many machines](#templates-for-many-machines)
- [Permissions and audit](#permissions-and-audit)
- [Engine, storage and limits](#engine-storage-and-limits)
- [Protocol facts and sources](#protocol-facts-and-sources)

## Steward monitors, Gatus and Prometheus

Steward's monitors cover the checks that belong to its procedures and services: a check that a runbook answers, a platform a service depends on, a data feed a duty relies on. They have 26 check types, root-cause graphs, maintenance windows and status pages, and their uptime can be the source of an availability objective ([SCORECARD.md](SCORECARD.md#availability-objectives)). For broad infrastructure monitoring – every host, port and endpoint of an estate, checked every few seconds – Gatus or Prometheus remain good choices. Their figures can feed objectives too, and monitors can read Gatus endpoints and Prometheus queries as checks ([GATUS.md](GATUS.md), [PROMETHEUS.md](PROMETHEUS.md)).

## Concepts

|                 |                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Monitor**     | A directed graph of checks with links, an owner, a schedule (default interval 60 s), outputs and an access list. Its status is aggregated from its checks.                                                                                                                                                   |
| **Check**       | One test. Every check is evaluated **independently on its own interval** (the monitor's, or its own).                                                                                                                                                                                                        |
| **Link**        | `parent → child`: the child depends on the parent. A **soft** link (default) never stops the child from running; it is used for root causes and alert suppression. A **hard** link skips the child while the parent is down (status `blocked`) – for cases where evaluating would be meaningless or harmful. |
| **Sub-monitor** | A check of type `monitor` shows the aggregated status of another monitor. That monitor runs on its own schedule (it is not evaluated twice) and has its own status, outputs and history. Cycles are refused.                                                                                                 |
| **Root cause**  | A failing check whose parent fails too is reported as _likely caused by_ the topmost failing ancestor; only the root cause is alerted. A failing sub-monitor node is expanded to that monitor's own root cause.                                                                                              |

**Why soft links.** The checks of a machine should _not all rely on the PowerMeter being active_. If the PowerMeter check fails while the machine data still arrives, the machine branch stays healthy and the PowerMeter failure is flagged as its own problem, with the note _"Down while all dependent checks are healthy – the check itself or its data path may be broken"_. Only when parent and child fail together is the child folded into the parent's alert.

### Statuses

| Status        | Code | Meaning                                                                                                                                   |
| ------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `up`          | 0    | Healthy                                                                                                                                   |
| `degraded`    | 1    | A warning threshold is reached (slow answer, missed intervals, certificate expiring …)                                                    |
| `down`        | 2    | Failing (after flapping control)                                                                                                          |
| `unknown`     | 3    | No data yet, or the check itself could not run (platform missing, vault locked, expression error, the data source answered with an error) |
| `blocked`     | 4    | Not evaluated because a hard dependency is down                                                                                           |
| `maintenance` | 5    | In a maintenance window: alerts are silenced, the time does not count against uptime                                                      |
| `off`         | 6    | A monitor with [states](#states-off-is-not-an-outage) in an off state, every check agreeing: grey, no alert, not counted in the uptime    |

**Flapping control.** A check goes `down` after _N_ consecutive failing results (`failuresBeforeDown`, default 2) and back after _M_ consecutive good results (`successesBeforeUp`, default 1). `up` ↔ `degraded` switch immediately. An `unknown` result (the check could not run) does not end a confirmed outage. A failing result that is not confirmed yet already explains failing children.

**Monitor status.** `aggregate.rule`:

- `worst` (default): the worst check;
- `critical`: checks with `critical: false` can only degrade the monitor;
- `quorum` with `quorum: k`: up while at least _k_ critical checks are up or degraded (degraded when some are not).

**Maintenance windows** are the catalogue's maintenance windows ([APPLICATIONS.md](APPLICATIONS.md#maintenance-windows)): once or repeating, planned under _Operate → Maintenance_ or from the monitor page (_Plan maintenance_ opens the same form with the monitor filled in). A window affects a monitor when it lists the monitor, or a platform, system, application or service that reaches a platform the monitor checks. While it lasts (with _Monitors stay quiet_ on) the monitor shows `maintenance`, sends no alerts, and the time does not count against its uptime. A window that lists monitors needs the _acknowledge_ right on each of them. The monitor's _Maintenance_ tab shows the windows that list or reach it.

**Acknowledgements** (a comment; until the monitor is up again) are set by everyone with the _acknowledge_ right.

**Before 0.11** a monitor had maintenance windows of its own (start, end, reason). The update copies each of them into a catalogue window that lists the monitor (audit entry `maintenance.migrated`; the old row keeps a reference to the copy). The copies send no announcements, as the old windows did not. The monitor API's maintenance routes (`GET`/`POST /api/monitors/{id}/maintenance`, `DELETE /api/monitors/{id}/maintenance/{windowId}`) still work in 0.11 and read and write such windows. They are **deprecated** and will be removed in a later release; use `/api/maintenance-windows` with a target `{ "kind": "monitor", "id": "…" }`.

## Example: a machine with a PowerMeter

The machine itself cannot be checked directly, but its PowerMeter has a static IP. If the PowerMeter is on and delivers data, the machine should be on and deliver data too. The IoT gateway reports what it receives to Steward, and forwards the data to Insights Hub.

```
PowerMeter reachable (ping, TCP fallback 502)
├─▶ PowerMeter data reported by the gateway (heartbeat, every 60 s)
│     └─▶ PowerMeter data in Insights Hub (freshness: Energy/activePower, energy; cadence 60 s)
└─▶ Machine data flow (sub-monitor "Machine 17 – machine data")
        Machine data reported by the gateway (heartbeat, on change: max. age 10 min)
          └─▶ Machine data in Insights Hub (freshness: MachineData/spindleSpeed, max. age 15 min)
Gateway Hall 2 alive (sub-monitor "Gateway Hall 2", 0.13) ─▶ parent of the data the gateway forwards
```

1. **Platforms.** An _Insights Hub_ platform (service credentials). Optionally _Gatus_ and _Zabbix_ platforms for outputs.
2. **Import the examples** (_Monitors → Import → From the example library_): first _Gateway Hall 2_ (`examples/monitors/09-…`) and _Machine 17 – machine data_ (`10-…`), then _Machine 17 – PowerMeter_ (`11-…`). Since 0.13 the two machine monitors have [states](#states-off-is-not-an-outage): switched off on purpose, the machine is _Off_ – grey and quiet – instead of down. Platforms are referenced by name; "Insights Hub" also finds "Insights Hub (production)" when it is the only one, otherwise the only platform of the right kind is used. When the name fits several of your platforms (e.g. "Insights Hub (modev)" and "Insights Hub (prod)") or none, the dialog shows a **platform picker per reference** – with the platforms of the right kind you may use, and the one the name resolves to preselected – and imports the monitor with your choice. The same works for pasted or loaded YAML and for templates; the API takes it as `platforms: { "<name in the file>": "<platform id>" }` on `POST /api/monitors/import` and `POST /api/monitors/examples/{file}`, and lists the references with `…/preview`. Replace the IP address and the asset ids (_Edit_ → select a check).
3. **Heartbeat secrets.** Saving shows the URL and secret of every heartbeat check **once**. A save with an API token gets no secrets (`secrets: []`): rotate the secret signed in. Configure the gateway – one call per check, or a [gateway](#gateway-batch) for all checks.
4. **Outputs.** _Edit → Outputs_: notification subscribers (e.g. `team:maintenance`), Zabbix, Gatus, a webhook or a runbook.
5. **Watch it.** The detail page shows the graph coloured by status, the root cause, and per check the latest results, status changes and uptime. _Monitors → Status wall_ is made for a screen in the control room.

What happens when …

| Situation                                          | Result                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The gateway stops reporting the PowerMeter         | _PowerMeter data reported by the gateway_ goes down; a little later _… in Insights Hub_ too, but it is shown as _likely caused by_ the gateway check. One notification: _Down: Machine 17 – PowerMeter · Root cause: PowerMeter data reported by the gateway_. |
| The PowerMeter check fails, but data still arrives | Only the PowerMeter check is down (with the note that its dependents are healthy); the machine branch stays up.                                                                                                                                                |
| The machine branch fails on its own                | The sub-monitor goes down with its own root cause and its own alert; the PowerMeter monitor shows the sub-monitor node down with that root cause.                                                                                                              |
| Insights Hub answers with an error                 | The freshness checks are `unknown` (the data path could not be checked), not `down`.                                                                                                                                                                           |

In demo mode (`npm run demo` → _Load demo data_) all of this runs against simulated platforms: an **IoT gateway simulator** reports every 30 s through the real batch endpoint, and the PowerMeter of _Machine 18_ (created from the template) stopped reporting 25 minutes ago, so its monitor shows a realistic root cause. Two more monitors show [states](#states-off-is-not-an-outage): _Lathe 5 – PowerMeter_ is switched off and every check agrees (grey _Off_), while the PowerMeter of _Mill 6 – PowerMeter_ does not answer although its data still arrives (a contradiction, red, root cause the PowerMeter check).

## States: off is not an outage

A machine switched off on purpose makes every check of its monitor fail – one after the other, as the data paths go stale. Without states that is an alert every evening. With **states** (0.13, [ADR 0021](adr/0021-monitor-states.md)) a monitor knows when its checks are _expected_ to fail: when every check agrees that the machine is off, the monitor is **Off** – grey and quiet. It raises an issue only when **checks contradict each other**, when the gateway that would bring the data is silent, or when the machine is off for longer than expected. A monitor without `states:` behaves exactly as before.

### The decision table

Each state (Running, Off, Standby …) is a row of a decision table whose columns are the monitor's checks. A row has

- a **condition** – cells that select the state (`when`); the first row whose condition matches wins, a last row _Otherwise_ is fixed and evaluates the monitor as without states;
- **required** checks (`requires`) – a precondition that must be up for the state to be trusted (the gateway, below);
- **expected statuses** of the other checks (`expect`);
- the status it **shows** while everything agrees: `up` (default) or `off`;
- optionally its own settle time (`settleSeconds`), maximum off time (`maxOffHours`) and what a contradiction makes the monitor (`contradiction: down`, the default, or `degraded`).

A cell is `up` (matches up and degraded), `down` (matches down; `blocked` counts as down, since a check skipped by a hard link agrees with its parent being down) or `any` (no expectation). A sub-monitor column also offers `off`. A check a row does not name is `any`.

```yaml
# examples/monitors/11-machine-17-powermeter.yaml (shortened)
checks:
  # … pm-reachable, pm-reports, pm-ih, machine
  - { id: gateway, name: Gateway Hall 2 alive, type: monitor, monitor: gateway-hall-2 }
links:
  - { from: gateway, to: pm-reports }
  - { from: gateway, to: machine }
states:
  maxOffHours: 8
  cases:
    - id: running
      name: Running
      when: { pm-reachable: up }
      expect: { gateway: up, pm-reports: up, pm-ih: up, machine: up }
    - id: off
      name: Off
      status: off
      when: { pm-reachable: down }
      requires: [gateway]
      expect: { pm-reports: down, pm-ih: down, machine: off }
```

Name the checks that react first in the condition (the direct check of the device – the ping) and the data paths that lag behind it as expectations: the state changes when the fast check changes, and the slow ones get time to follow.

**Evaluation.** The state is selected with the **confirmed** statuses (after flapping control), so one lost ping never switches Running to Off. Each `up` and `down` cell of the selected row is compared with its check:

| The checks …                     | The monitor                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agree                            | the row's status: `off`, or for an `up` row the aggregation over the checks expected up (a degraded check still degrades). A check whose `down` agrees with its state shows `off` everywhere.  |
| contradict the state             | `down` (or `degraded` when the row says so or the deviating check has `critical: false`) – after the settle time                                                                               |
| could not be checked (`unknown`) | the state holds with the note _2 checks could not be checked_; `unknown` when none of its expected checks is known. In a condition `unknown` keeps the current state and selects no other one. |

**Root cause of a contradiction:** the deviating cells of the **closest** row – the row with the fewest contradicted cells, the selected row winning a tie – folded along links like failures. _PowerMeter reachable, machine data missing_: Running is selected and closest, the root cause is the machine data (expanded to the sub-monitor's own root cause), "Running, but Machine data flow is down". _PowerMeter unreachable, but its data still arrives_: Off is selected, Running is closest, so the PowerMeter check is blamed – "PowerMeter reachable is down, but 3 checks say Running" – not the three checks that disagree with it.

**Saving checks** that state ids are unique (at most 10 states), every cell names an existing, enabled check, every row has a condition, `off` is only on a sub-monitor column and a required check is no other cell of its row; a row that can never match (an earlier row has the same or a wider condition) is a warning.

### Settle time

A state change (also from or to _Otherwise_) starts a **settle time**: until it ends, a deviation from the new state's expectations does not count – the check shows its own status with _settling_, the monitor the new state with _settling until 18:19_. The monitor's status stays as computed (a Running state that settles is _Up_), so the page says why red would be wrong: next to the status _settling until 18:19 – 1 check not as expected yet_ (the expected checks that deviate), the deviating cards are drawn amber with _Settling – not counted yet_ instead of red, and the checks table, the check's panel and the monitor list mark them _settling_; on the status wall the tile reads _Running · settling 12 min – 1 check not as expected yet_. The data paths go stale minutes after a power-off and come back minutes after a power-on; the settle time covers exactly that. By default it is derived per row from its expected checks – the largest _freshness window + interval × confirmations_ (the freshness window of `freshness` and `heartbeat` checks, 0 for others; `failuresBeforeDown` for a check expected down, `successesBeforeUp` for one expected up; a sub-monitor column: its monitor's largest value). Example 11's Off row: 900 s + 2 × 60 s of the machine data's Insights Hub check – **17 minutes**. `settleSeconds` (60 s to 24 h) overrides it. A state change during settling restarts it; a required check and the condition are never delayed. A changed settle time – `settleSeconds`, or the checks it is derived from – applies at once to a settle that is running: its end is always the state change plus the settle time of the current definition, so shortening it shows a contradiction at once and lengthening it extends the running settle. A settle that has already ended stays ended: lengthening the settle time afterwards does not reopen it, so a contradiction that was confirmed (the monitor went down and notified) is not turned back into _settling_ and _Up_. The very first state of a monitor (new, or states just added) is taken without a settle time, so what is wrong is told at once.

**States that change too often:** more than 4 state changes within 60 minutes make the monitor `degraded` ("Changes state too often: 6 times in the last hour") until an hour passes with fewer – a flapping selector cannot hide contradictions behind restarted settle times. State, since when and the end of the settle time are stored, so a restart neither restarts nor skips a settle time.

### Maximum off time and planned downtime

A consistent Off is quiet only up to the **maximum off time** (`states.maxOffHours`, default **8 hours**; a row may set its own; `0` means no maximum). Past it the monitor is `degraded` – "Off for longer than expected (9 h, maximum 8 h)" – and notifies once, like any degraded status. It counts from the time the state became Off and ends when the state changes.

**Planned downtime** is a kind of [maintenance window](APPLICATIONS.md#maintenance-windows) (`kind: downtime`): weekends, holidays, shutdowns. Unlike maintenance it leaves the status as it is (`off`, `up` …), **suspends the maximum off time** – the time inside a window is not counted as off time, and while one lasts the maximum is not checked – and **still alerts contradictions**. Monitors without states are not affected. It announces nothing unless a reminder is set. A machine off since Friday 22:00 with a weekend window (Friday 22:00 to Monday 06:00) stays quiet over the weekend; still off on Monday 14:00, it is `degraded`. Maintenance stays as it is: it overrides the status with `maintenance`; the state is still selected underneath.

**From the impact of a window** (0.14): when maintenance is planned for a gateway, a switch or a machine, the window's [impact](APPLICATIONS.md#impact-before-maintenance) lists the monitors that check what is behind it – _Goes off_ for a monitor with an Off state, _Goes down_ for one without – and _Plan downtime for N monitors_ adds planned downtime for them at the window's times in one click (only monitors you may acknowledge).

### Gateway liveness: a required check

Off is only trusted when something proves that data would arrive if there were any. A gateway whose machines are all off looks exactly like a dead one, so give each gateway a small monitor with a heartbeat on a key of its own that it reports in every batch call – [`09-gateway-hall-2.yaml`](../examples/monitors/09-gateway-hall-2.yaml), key `gw-hall2.alive` – include it in each machine monitor as a sub-monitor check, list it in `requires` of the off row and link it as parent of the checks it forwards. If a required check is not up while the rest of the condition matches, the state is not taken: the monitor is `down` **at once** (no settle time), root cause the gateway, "Gateway Hall 2 alive is silent – Off cannot be told from an outage". In Running a dead gateway is the root cause through the links.

### Following another monitor

A monitor that cannot tell its state itself – _Machine 17 – machine data_ has only data checks – **follows** another one: `states.from` names it (id or key), and its rows name the leader's state ids with this monitor's own expectations and no condition. It changes state when the leader does, with its own settle time and no maximum off time (the leader reports that). Saving refuses a leader whose condition or required checks use a monitor that follows it (`STATES_CYCLE`). The leader may be named by the key of a monitor that is imported later (the two examples refer to each other); until it exists, the follower is evaluated as without states.

```yaml
# examples/monitors/10-machine-17-machine-data.yaml (states)
states:
  from: machine-17-powermeter
  cases:
    - { id: running, name: Running, expect: { machine-reports: up, machine-ih: up } }
    - { id: off, name: Off, status: off, expect: { machine-reports: down, machine-ih: down } }
```

### Outputs, notifications and the wall

| Output                     | `off`                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Notifications, Teams cards | never an alert: sent only when `off` is in the output's `statuses`, or as a recovery after `down` or `degraded`. An acknowledgement ends when the monitor is up or off.                                |
| State changes              | a notification output with `stateChanges: true` also sends the event `monitor.state` – "Machine 17: Running → Off" – as information, never urgent, held by quiet hours and digests                     |
| Webhook (JSON)             | `"status": "off"`, `"statusCode": 6`; the monitor's event has `state` (`id`, `name`, `since`, `settlingUntil`) and on a contradiction `contradiction` (`closest`, the checks with expected and actual) |
| Zabbix push and pull       | `6` (or `off`); add a row 6 → Off to the value map. Triggers on `=2` are unaffected; triggers on `>1` fire on maintenance (5) and off (6). The pull API's answer has `state`.                          |
| Prometheus                 | `sm_monitor_status` 6; `sm_monitor_state{monitor,state}` is 1 for the current state. `== 2` rules are unaffected.                                                                                      |
| Gatus                      | per output, `whileOff`: `success` (default), `failure` or `skip` (send nothing). A contradiction and Off beyond the maximum are always failures.                                                       |
| Status pages               | `operational` – the service is as planned                                                                                                                                                              |
| Plant live states          | `offline` with the reason _off_, drawn grey, not red                                                                                                                                                   |
| Datasets                   | `unknown`; the metric `off` in `monitors.status`                                                                                                                                                       |
| Runbooks (`process`)       | not started (down only by default)                                                                                                                                                                     |

The **status wall** sorts `down`, `degraded`, `unknown`, `blocked`, `maintenance`, `off`, `up`; an off tile shows the state's name with a power icon (_Off · settling 12 min_ while settling), and _Hide off_ leaves them out (remembered in the browser). The **monitor page** shows a grey _Off – all checks agree_ banner instead of the red root cause, and the panel **Why this state**: since when, the settle time, the off time of its maximum, and each cell – selected by, required, expected – with what the check is and whether it agrees (words and signs, never colour alone). On a contradiction it names the closest state and each deviating check, expected and actual.

### The editor's States tab

_Edit → States_ (between _Graph_ and _Settings_) edits the table: one row per state with its name, id and what it shows, a select per check, its choices grouped by what they do – _Any_ (no rule); **Selects this state** (_Up · selects_, _Down · selects_, _Off · selects_: the condition); **Expected in this state** (_Up · expected_, _Down · expected_, _Off · expected_); **Precondition** (_Required_) – the settle time (_derived_ until overridden), **On contradiction** (_Down_, the default, or _Degraded_: what a contradiction in this state makes the monitor, `contradiction:`; the other way is per check – a check that is not _Critical_ only degrades the monitor when it deviates) and the maximum off time; rows move with buttons, the order is the priority. Each row is marked _Matches now_ from the current statuses. **Try it** sets each check to a status and shows which row wins and what the monitor would report, with the "why" text – computed in the browser by the same code as the engine (`shared/src/monitorStates.ts`); nothing is stored. The legend under the table explains the groups. _Off_ cells are offered only in sub-monitor columns – a sub-monitor that is off itself; a check of the monitor's own is _Down_ when its device is off, and agreeing it shows `off`. Whether a state shows grey _Off_ is its **Shows** column. Problems show below the table; a row that can never match is a warning.

### Uptime and objectives

Off is **excluded** from uptime and availability objectives, like maintenance – it counts neither way and is shown apart: "Up 97 % · Off as expected 31 h" on the monitor page, _Off as expected_ next to the figures of objectives with the monitor as source, and a column _Off_ in the reports' availability section (when a monitor was off in the period). Settling counts as the new state. Off beyond the maximum is `degraded`, which counts as available by the existing rule. A contradiction is `down` (or `degraded`) and counts as such. Check samples count a check that shows `off` as neither up nor down.

## The editor

_Monitors → New monitor_ (or _Edit_) shows the checks as cards on a canvas.

- **Adding checks.** A check type from the palette adds a card. With a card selected, the new one is placed below it and depends on it (a soft link) – remove the link when it does not. Otherwise drag from the lower edge of a card to the card that depends on it.
- **Cards and ids.** Every card keeps its identity in the editor; the check id is just a field. A duplicate or invalid id is shown on the field, and both cards stay.
- **Problems.** The editor checks the definition as you type, with the same rules as the server, and shows a problem on the field you changed. Saving lists all problems (e.g. _Check "Power Meter – Insights Hub" (pm-ih) – Variables: Required_); an entry selects the card and puts the cursor in the field. Required fields are marked for the check type and mode. Errors from the server name the card too, never `checks.1`.
- **Duplicate, Tidy up, Undo/Redo, Delete.** _Duplicate_ copies the selected card (id with `-copy`, without its gateway key). **Several cards at once:** shift-click them (or drag a box with Shift held) and choose _Duplicate selection_ – the copies keep the links between the selected cards and are placed next to the graph. _Tidy up_ arranges the cards by their dependencies. Undo and redo with the buttons or Ctrl/⌘+Z and Ctrl/⌘+Shift+Z; Delete removes the selected card or link (outside text fields).
- **Check now before saving.** _Check now_ on a card runs that check as it is in the editor (`POST /api/monitors/check-preview`) and shows the result on the card's form. Nothing is stored. It runs with the rights of the monitor's owner (a new monitor: yours) – but you must see the platform or system it names yourself (one you may not see answers like a missing one, as when saving), and a schema check with `read: true` needs your own _use_ right on the database platform; the outbound policy applies, it is rate-limited and audited as `monitor.check_previewed`. Heartbeat and sub-monitor checks have no call to try.

## Check types

Common fields: `id`, `name`, `description`, `intervalSeconds`, `timeoutSeconds`, `critical`, `enabled`, `failuresBeforeDown`, `successesBeforeUp`, `key` (heartbeat: the key for gateway reports; default `<monitor key>.<check id>`).

| Type               | Fields                                                                                                                                                                                                                                                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`             | `host`, `fallbackPort` (default 80), `degradedRttMs`                                                                                                                                                                                                                                    | Runs the system `ping` with fixed arguments (`-n -c 1 -W <s>`, Windows `-n 1 -w <ms>`); the host must not start with `-`. Where ping is not installed or ICMP is not permitted (containers, sandboxes), a **TCP connect** to `fallbackPort` is used – an accepted _or refused_ connection proves the host answers; the message says so.                                                                                                                                                                                                                                                                                      |
| `tcp`              | `host`, `port`, `degradedMs`                                                                                                                                                                                                                                                            | Connect within the timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `http`             | `url`, `method` (GET/HEAD/POST), `headers`, `body`, `expectStatus` (`200`, `200-299`, `200,204`; default `200-399`), `condition` (JSONata over `{status, headers, body, durationMs}`), `degradedResponseMs`, `tlsExpiryWarnDays` (default 14), `insecureTls`, `useProxy` (default true) | Down on an unexpected status or a false condition; degraded when slow or when the certificate expires soon. Bodies are read up to 1 MB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `platform`         | `platform`, `method`, `path`, `query`, `headers`, `body`, `condition`, `degradedResponseMs`                                                                                                                                                                                             | A call through a configured platform: its authentication, base URL, proxy/CA settings, retries and concurrency limit. Default: HTTP 2xx.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `freshness`        | `source: insightsHub` with `platform`, `assetId`, `aspect`, `variables[]` – or `source: platform` with `platform`, `path`, `query`, `method` (GET, POST), `headers`, `body`, `timestamp` (JSONata returning a timestamp or a list); plus the freshness fields below                     | The newest timestamp of every variable must be recent; the worst variable counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `heartbeat`        | freshness fields, `condition` (JSONata over the last report), `statusExpression`, `authMode` (token, hmac, either), `allowedCidrs`, `rateLimitPerMinute` (default 60)                                                                                                                   | Fed by [reports](#heartbeat-api-for-gateways). Evaluated on its interval too, so a **missing** report turns it down without any request. Before the first report: `unknown`, and `down` once the window has passed.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `gatus`            | `platform` (Gatus), `endpointKey`, `maxAgeSeconds`, `degradedOnRecentFailures`                                                                                                                                                                                                          | Status of a Gatus endpoint (newest result). All Gatus checks of a cycle share one `GET /api/v1/endpoints/statuses`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `checkmk`          | `platform` (Checkmk), `host`, `service` (empty: the host), `maxAgeSeconds`                                                                                                                                                                                                              | The current state in Checkmk: OK / WARN / CRIT / UNKNOWN → up / degraded / down / unknown (host: UP / DOWN / UNREACHABLE → up / down / unknown), the plugin output as message; pending or not checked for `maxAgeSeconds` → unknown. All Checkmk checks of a cycle share one host and one service read ([CHECKMK.md](CHECKMK.md)).                                                                                                                                                                                                                                                                                           |
| `prometheus`       | `platform` (Prometheus), `query` (PromQL), `direction` (`above` default, or `below`), `warn`, `crit`, `noData` (`unknown` default, `up`, `down`), `unit`                                                                                                                                | An instant query (`POST /api/v1/query`, `GET` when the server answers 405) against Prometheus, Thanos, Mimir or VictoriaMetrics – setup per product: [PROMETHEUS.md](PROMETHEUS.md). **Every series is judged and the worst one counts**: at or past `crit` → down, past `warn` → degraded; the message names the worst series by the labels that tell the series apart (`{instance="db01:9100"} 82.04 (worst of 2 series)`). No series → `noData` (unknown by default: the target may have disappeared). A range vector is refused – use `avg_over_time(…[5m])`. `+Inf`/`-Inf` are judged like any value, `NaN` is unknown. |
| `kubernetes`       | `platform` (Kubernetes), `namespace`, `deployment` (empty: all)                                                                                                                                                                                                                         | Up when the deployments have all replicas ready; degraded when fewer are ready or a pod is not well (crash-looping, failed, many restarts); down when none is ready ([KUBERNETES.md](KUBERNETES.md)).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `git`              | `platform` (GitHub, GitLab, Forgejo/Gitea), `repository` (`owner/repo`, GitLab `group/project`), `branch` (empty: the default branch), `failedAs` (`down` or `degraded`), `maxCritical`, `maxHigh`                                                                                      | Up when the pipeline of the branch passed or is running; down (or degraded) when it failed; degraded when there are more open Dependabot alerts than allowed; unknown without a pipeline run ([GIT-PLATFORMS.md](GIT-PLATFORMS.md#monitor-check)).                                                                                                                                                                                                                                                                                                                                                                           |
| `kafka`            | `platform` (Kafka), `topic`, `messagesWithinMinutes`, `quietAs`, `group`, `maxLag`, `stuckMinutes` (15), `schemaVersion`                                                                                                                                                                | Down (or degraded) when the newest message is older than the window; degraded above the lag; down when the group is stuck (lag and no commit); degraded on another schema version ([KAFKA.md](KAFKA.md#monitor-check)).                                                                                                                                                                                                                                                                                                                                                                                                      |
| `kafka-connect`    | `platform` (Kafka Connect), `connector` (empty: all), `notRunningAs`, `pausedAs`, `failedMinutes`, `maxLag`, `quietMinutes`, `quietAs`                                                                                                                                                  | Down (or degraded) when a connector or task FAILED – with `failedMinutes` a failed task is degraded until then; degraded when paused or rebalancing, above a sink's lag, or when a Debezium connector's topics got no message ([KAFKA.md](KAFKA.md#monitor-check-1)).                                                                                                                                                                                                                                                                                                                                                        |
| `confluent`        | `platform` (Confluent Cloud), `target` (`connectors` default, or `clusters`), `resource` (a connector or cluster; empty: all), `notRunningAs`, `pausedAs`, `failedMinutes` – [CONFLUENT.md](CONFLUENT.md#monitor-check)                                                                 |
| `mqtt`             | `platform` (MQTT), `topic` (pattern with `+`/`#`), `mode` (`any` or `each`), `withinMinutes`, `quietAs`, `minClients`                                                                                                                                                                   | Up when a message came within the window; `each`: degraded when some topics of the pattern went silent, down when all did; degraded below the connected clients ([MQTT.md](MQTT.md#monitor-check)).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `snowflake`        | `platform` (Snowflake), `mode` (`freshness`, `tasks`, `credits`), `object` (`DB.SCHEMA.TABLE`, `DB[.SCHEMA]` or the warehouse), `maxAgeMinutes`, `withinHours`, `maxCredits`, `failAs`                                                                                                  | Down (or degraded) when the table did not change within the time, a task failed, or the warehouse used more credits; unknown when the table is not found ([SNOWFLAKE.md](SNOWFLAKE.md#monitor-check)).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `database`         | `platform` (a database platform), `mode` (`connection`, `replication`, `query`), `sql`, `params`, `direction`, `warn`, `crit`, `noData`, `unit`                                                                                                                                         | `connection`: down when it cannot connect or sign in, degraded when the account can write; `replication`: the largest lag in seconds against the levels; `query`: the first column of the first row of a read-only statement against the levels ([DATABASES.md](DATABASES.md#templates-dashboard-and-monitor)).                                                                                                                                                                                                                                                                                                              |
| `dynamodb`         | `platform` (AWS), `region`, `table`, `mode` (`newestItem`, `writeActivity`, `hygiene`), `indexName`, `partitionKey`, `partitionValues[]`, `timeAttribute`, `timeFormat`, `freshnessMode` + freshness fields, `activeTable`, `pointInTimeRecovery`, `timeToLive`, `failAs`               | newestItem: the age of the newest item of each partition key value, the worst counts; writeActivity: the newest minute with writes (CloudWatch); hygiene: status, point-in-time recovery and time to live ([below](#dynamodb-tables)). Throttling is `unknown`, never `down`.                                                                                                                                                                                                                                                                                                                                                |
| `db-schema`        | `platform` (a database platform) or `system`, `mode` (`breaking`, `changed`), `withinHours` (24), `read`, `failAs`, `noData`                                                                                                                                                            | The schema snapshots taken within the window: `breaking` fails (down) on a breaking change, `changed` (degraded) on any change; `read: true` reads the platform first ([DATABASES.md](DATABASES.md#database-schemas)).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cost`             | `scope` (`service`, `application`, `team`, `platform`), `target` (its id), `period` (`month`, `monthToDate`), `maxIncreasePct`, `maxIncrease`, `currency`, `failAs`, `noData`                                                                                                           | The costs of the scope against the month before (or this month so far against the same share of it): fails (degraded) when they rose by more than the percentage or the amount ([COSTS.md](COSTS.md#monitor-check)).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `data-contract`    | `contract` (Steward's id), `mode` (`test`, `findings`), `testedWithinDays` (7), `failAs` (down), `warningAs` (degraded)                                                                                                                                                                 | `test`: runs the data contract's test through its data contract service with the owner's rights and stores the full report as a test run of the contract (the value names it); passed is up, warnings `warningAs`, failed `failAs`. `findings`: Steward's own checks without the service – no owner, not tested, last test failed, columns of linked datasets and tables ([DATA-CONTRACTS.md](DATA-CONTRACTS.md#monitors-processes-scorecard-and-reports)).                                                                                                                                                                  |
| `dependency-track` | `platform` (Dependency-Track), `project` (`name@version`, `name@latest` or UUID), `maxCritical` (0), `maxHigh`, `policyFail` (true), `failAs`                                                                                                                                           | Down (or degraded) above the open critical findings or with a failing policy violation; degraded above the critical and high findings ([DEPENDENCY-TRACK.md](DEPENDENCY-TRACK.md#monitor-check)).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `version-behind`   | `application` (id or name), `environment`, `products`, `maxMinors` (2), `maxDays`, `majorAs` (down), `eolAs` (down)                                                                                                                                                                     | Down (or degraded) when a stack entry of the application is a major release behind or its release cycle is past its end of life; degraded above `maxMinors` minor releases or `maxDays` days behind – from the version watch, no call ([APPLICATIONS.md](APPLICATIONS.md#version-watch)).                                                                                                                                                                                                                                                                                                                                    |
| `entra`            | `platform` (Microsoft Graph), `mode` (`app-credentials` or `service-health`), `withinDays` (30), `downWithinDays` (7), `apps` (names or application ids), `services`                                                                                                                    | app-credentials: per app registration and type, the secret or certificate that lasts longest ends within `withinDays` (degraded), within `downWithinDays` or has ended (down) – an old one next to its replacement counts as rotated. service-health: a Microsoft 365 service not operational (degraded; an interruption: down; needs ServiceHealth.Read.All) ([ENTRA.md](ENTRA.md)).                                                                                                                                                                                                                                        |
| `privilege-vault`  | `platform` (IBM Verify Privilege Vault), `folder`, `maxAgeDays` (90), `privilegedFolders`, `privilegedTemplates`, `kinds`, `maxFindings` (0), `failAs` (degraded)                                                                                                                       | Degraded (or down) with more findings than allowed – failed heartbeat, not rotated, expired, automatic changing off, no owner – and always with a finding on a privileged secret, including missing checkout or approval; read at most every 10 minutes ([IBM-PAM.md](IBM-PAM.md#hygiene)).                                                                                                                                                                                                                                                                                                                                  |
| `page-watch`       | `platform` (changedetection.io), `watch` (UUID) or `tag` (name), `changedWithinHours` (24), `changedAs` (`up`, `degraded`), `failingAs` (degraded), `maxCheckAgeHours`, `pausedAs` (`ignore`, `degraded`)                                                                               | Degraded (or down) while a watch failed or was not checked in time; a change within the window is information or degraded; paused watches left out or degraded; unknown without a matching watch ([CHANGEDETECTION.md](CHANGEDETECTION.md#monitor-check-page-watch)).                                                                                                                                                                                                                                                                                                                                                        |
| `monitor`          | `monitor` (id or key)                                                                                                                                                                                                                                                                   | The other monitor's status (`maintenance` counts as up here); root causes are taken over.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Platform kinds.** A check type that reads one kind of platform – the kind in brackets after `platform` above (`gatus`, `checkmk`, `prometheus`, `kubernetes`, `git`, `kafka`, `kafka-connect`, `confluent`, `mqtt`, `snowflake`, `database`, `dynamodb`, `db-schema`, `dependency-track`, `entra`, `privilege-vault`, `page-watch`, and `freshness` with `source: insightsHub`) – needs a platform of that kind. Saving refuses another kind with `CHECK_PLATFORM_KIND` (the API, the editor, duplicates, templates, imports and Git sync); an import or a Git sync update offers only platforms of a fitting kind. `freshness` with `source: platform` and the `platform` check read any platform. A stored check whose platform is of another kind (saved before 0.11.0, or the platform's kind changed) reports _unknown_ with the reason and sends no request; at start the server logs one warning that lists such checks (and such [outputs](#outputs)) by monitor and check or output id.

**Freshness fields.** `mode: cadence` – `expectedIntervalSeconds`, degraded after `degradedAfterMissed` missed intervals (default 2), down after `downAfterMissed` (default 4). `mode: maxAge` – for **on-change data**: down when the newest value is older than `maxAgeSeconds`, degraded after `degradedAgeSeconds` (optional). Both modes take `allowedDelaySeconds` (0–86400, default 0): how much later than its timestamp the data may arrive. With `maxAge` the check is down only when the newest value is older than `maxAgeSeconds` + the allowance (degraded likewise); with `cadence` the missed intervals are counted from the age minus the allowance. The look-back of queries grows by it, and messages name it ("Newest value of activePower is 22 min old, 15 min of it allowed delay, expected every 60 s"). [How fresh is fresh](#how-fresh-is-fresh-delays-in-insights-hub) explains how to choose it.

**Freshness through a platform.** `source: platform` reads one API call and takes the newest timestamp the `timestamp` expression returns. `method` is `GET` by default; `POST` is for APIs that read with POST – search endpoints, GraphQL, JSON RPC – and sends `body` (JSON, or a string as it is; at most 64 KB). `headers` are sent with the request; the platform's own authentication is added as usual (headers the connection sets – `Host`, `Content-Length`, `Transfer-Encoding`, `Connection` – are refused). Method, headers and body are only for the platform source. The outbound policy and the platform's credentials work as for the `platform` check: the request goes to the platform's base URL.

**An absolute URL as the path** (`platform` and `freshness` checks): `path` may be a full `http(s)://` URL instead of a path below the base URL. It goes through the outbound policy like every other request – the platform's own origins (base URL, trusted origins), another platform's origin or the outbound allow-list (_Settings → Outbound access_); a host outside it fails the check with "Blocked by the outbound policy". The platform's credentials are sent only to its own origins. Both check types also check the base URL against the policy (with the policy _allowList_, it must be on the list). For DynamoDB, use the [DynamoDB check](#dynamodb-tables).

**Redirects** (`http`, `platform` and `freshness` checks, webhook outputs): at most 5 are followed, and every target goes through the outbound policy like the first URL ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#which-rule-checks-which-call)). A redirect on the same origin, from `http` to `https` on the same host, or to the platform's own origins passes; a redirect to any other host must be allowed, or the check fails with "Blocked by the outbound policy: … redirected to …" – as for a refused first URL, an `http` check reports _unknown_ ("Target not allowed: …"), a `freshness` check _unknown_ and a `platform` check _down_. An `http` check's own headers go only to its first origin.

```yaml
- id: newest-order
  name: Newest order in the search index
  type: freshness
  source: platform
  platform: Search
  method: POST
  path: /orders/_search
  headers: { content-type: application/json }
  body: { size: 1, sort: [{ createdAt: desc }], _source: [createdAt] }
  timestamp: hits.hits[0]._source.createdAt
  mode: maxAge
  maxAgeSeconds: 900
```

**Insights Hub time series.** Steward reads `GET {tsPath}/timeseries/{assetId}/{aspect}?latestRecord=true` (`tsPath` is the platform variable, default `/api/iottimeseries/v3`). The latest record comes from the raw store but only contains the variables written at that moment, so for the other variables a second call reads `?from=<now − window>&to=<now>&select=<variables>` (the window is 1.5 × the time after which the check is down) and takes the newest value per variable. The API answers the **oldest** records of a range first, at most 2,000 per call: when that page is full, the newest values lie beyond it, so Steward reads the window again in slices from now backwards (10 min, 1 h, 6 h, 1 day, 7 days), each paged forward to its end, until every variable has a value. A slice with more than 20,000 records is not paged through: the check is then `unknown` with _Too much data to find the newest value_, never `down` (shorten the window or check fewer, sparser variables). Before 0.12.0 the newest value found in a full page was the last of its 2,000 oldest records, so dense data could look up to an hour old. `latestValue=true` is not used: it reads aggregated data that can lag 1–2 hours. **All checks on the same asset and aspect that are due in the same cycle share these calls** (checks with the same asset/aspect and interval are scheduled into the same cycle); answers are reused for 10 s. With 20–30 machines and a few variables each, that is one or two calls per asset/aspect and interval.

### How fresh is fresh: delays in Insights Hub

**What the check reads.** `latestRecord=true` (and, for variables missing from it, `from`/`to`/`select`) reads the **raw store** of IoT Time Series, and the age is measured from `_time` – the measurement timestamp the device or gateway set, not the time Insights Hub received the value. `latestValue=true` is not used: it reads aggregates, which Siemens documents as lagging 1–2 hours.

**What makes up the age.** The device's read cycle, the gateway's upload interval and buffering (many gateways upload in batches, e.g. 1-minute values every 15 minutes), the transport, the asynchronous write into the store (Siemens: data is "written asynchronously … there might be a delay before you can read back the data" – no figure is documented), and any difference between the device clock and real time. Siemens documents **no fixed ingestion delay for raw data**: it depends on the tenant and above all on the gateway's upload cycle. So set an explicit `allowedDelaySeconds`, and let Steward measure what it sees.

**Peak age, not just delay.** With batched uploads a fresh batch makes the newest value about 1 minute old – but just before the next upload it is about 16 minutes old. A threshold has to tolerate that **peak age**. For every Insights Hub and API-source freshness check, and for each variable, Steward keeps the newest timestamp it saw (_T_) and when it last saw it as the newest (_t_, the start of that read – with the shared Insights Hub read, the read's own times, not the check's schedule). When a later read, ending at _t′_, sees a newer timestamp _T′_, it records one sample with two intervals:

| Figure                         | Lower bound        | Upper bound |
| ------------------------------ | ------------------ | ----------- |
| Peak age of the previous value | _t_ − _T_          | _t′_ − _T_  |
| Delay of the new value         | max(0, _t_ − _T′_) | _t′_ − _T′_ |

The true value lies in between; the width is about one check interval, so **the resolution is the check interval** – use a short interval (e.g. 60 s) while measuring. Suggestions use the **upper bounds** only: they never under-estimate. Samples are kept per variable for 7 days in **slots**: 20 minutes for the last 24 hours, 2 hours before (a slot keeps the lowest lower and the highest upper bound of its samples and their number; the figures are taken over the slots). The state is stored compactly with the check – about 3 KB per variable for a week of new values every minute – and only when something worth keeping changed (a sample, a count, a newest timestamp), not on every read; a restart continues the series, and with no stored state the first read records nothing.

**What is not used** (counted and shown, never used): failed reads (no observation – the next sample starts from the last successful read); a newest timestamp that **goes backwards** (a non-monotonic read, e.g. a lagging replica: the newest seen is kept – and the check's **status** uses it too, so a lagging read never makes data look older or raises an alarm); timestamps more than 5 s **in the future** (clock skew; each counted once); samples whose interval overlaps a **maintenance window** of the monitor. Changing the check's **source** – platform, asset, aspect, variables, or path, query, method, body or timestamp expression – starts a new series; changing thresholds does not. Device clock differences are part of the figures: a clock that is behind makes values look older, one that is ahead younger – only a clock ahead of real time is detectable (timestamps in the future).

**Reading it.** The check's panel and the editor show, for the variable that gets oldest: _Peak age before new data (7 days): median 15 min, 95 % 17 min, max 2 h 10 min · delay 1–2 min · 412 samples · checked every 1 min_, the counts of what was not used, and from **24 hours and 20 samples** on a suggestion. Outages show up in the maximum but do not drive the suggestion (it uses the 95th percentile):

- `cadence`: `allowedDelaySeconds` = 95 % peak age − `expectedIntervalSeconds`, rounded up to the minute, plus one check interval;
- `maxAge`: `maxAgeSeconds` = 95 % peak age − `allowedDelaySeconds`, rounded up to the minute, plus one check interval; a `degradedAgeSeconds` that would warn at the observed peak is removed.

_Apply suggestion_ in the editor shows the old and new values and changes the form; it is saved like any other edit. The public API returns the figures and the suggestion as `observedDelay` of each freshness check (`GET /api/v1/monitors/{monitorId}/status`).

**Worked examples.** A PowerMeter sends values every 60 s; the gateway uploads every 5 minutes. Observed: peak age median and 95 % 6.7 min (403 s), delay 1–2 min. For `mode: cadence`, `expectedIntervalSeconds: 60`, checked every minute: 403 − 60 = 343 s → 6 min, plus 1 min → `allowedDelaySeconds: 420`. Missed intervals then count only from 7 minutes of age, so `degradedAfterMissed: 3` warns at 10 minutes, `downAfterMissed: 6` alarms at 13 minutes. For **on-change data** (a machine state that changes every few minutes) use `mode: maxAge`: with a 95 % peak age of 13.5 min and no allowance, `maxAgeSeconds: 900` (rounded up to 14 min, plus 1 min check interval).

### DynamoDB tables

The check type **DynamoDB table** (`dynamodb`) watches whether the data in a DynamoDB table is current – the way the freshness check watches Insights Hub and the Snowflake check a table. It runs on an [AWS account platform](AWS.md) and signs its calls with SigV4 for `dynamodb` (and `monitoring` for CloudWatch), like every other AWS call of Steward; `region` empty means the platform's main region. Example: [`61-dynamodb-table.yaml`](../examples/monitors/61-dynamodb-table.yaml) (all three modes); template _DynamoDB freshness_: [`62-dynamodb-freshness-template.yaml`](../examples/monitors/62-dynamodb-freshness-template.yaml). The AWS inventory of a cloud-account component links every DynamoDB table it found to a new monitor with this check.

| Mode            | Calls                                                                                                                                                                                                                                    | Status                                                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `newestItem`    | One `Query` per partition key value (at most 20): `KeyConditionExpression: "#pk = :pk"`, `Limit: 1`, `ScanIndexForward: false`, `ProjectionExpression: "#pk, #t"` – on the table, or on the index `indexName` whose sort key is the time | The age of each value's newest item, by the freshness fields (`freshnessMode: cadence` or `maxAge`); the worst value counts. No item for a value: down. An item without the time attribute, or one that is not a time: unknown.              |
| `writeActivity` | One CloudWatch `GetMetricData`: `AWS/DynamoDB` `ConsumedWriteCapacityUnits`, dimension `TableName`, statistic `Sum`, the window and a half back (60 s periods; coarser for long windows), newest first                                   | The end of the newest period with writes is the age; no writes in the window: down. For tables without a time-sorted key. CloudWatch is a few minutes behind – allow at least 10 minutes (e.g. `maxAgeSeconds: 900`).                        |
| `hygiene`       | `DescribeTable`, `DescribeContinuousBackups`, `DescribeTimeToLive`                                                                                                                                                                       | `activeTable` (status `ACTIVE`, default `required`), `pointInTimeRecovery` and `timeToLive` (default `report`) are each `required` – not met: `failAs` (default degraded) – or only reported. A required part that may not be read: unknown. |

- **Only the key and the time are read.** Every attribute name is a placeholder of `ExpressionAttributeNames` (`#pk`, `#t`) and the key value an entry of `ExpressionAttributeValues` (`:pk`): names from the check are never written into an expression. Nothing of the item is stored – only its age. Never `Scan` or `GetItem`.
- **The time attribute** may be ISO 8601 (`2026-11-06T10:15:00Z`, with an offset, without a zone = UTC, or at the start of a sort key such as `2026-11-06T10:15:00Z#order-77`), epoch seconds or epoch milliseconds. `timeFormat: auto` (default) takes a number below 10¹¹ as seconds and above it as milliseconds; `iso8601`, `epochSeconds` and `epochMillis` insist on their format.
- **Bounded:** one call per partition key value (four at a time), or one call per check (writeActivity), or three (hygiene); answers of at most 1 MB; the check's timeout covers all its calls.
- **Throttling** (`ProvisionedThroughputExceededException`, `ThrottlingException`, `RequestLimitExceeded`, CloudWatch `Throttling`) gives `unknown` with the reason – never `down`. A missing table or index gives `down`; a call the policy does not allow gives `unknown` and names the action. Messages never contain the platform's secrets.
- **Values for trends:** the result value holds the ages (`ageSeconds`, `keys[].ageSeconds`), the write capacity units (`writes`), or `itemCount` and `tableSizeBytes` (AWS updates these about every six hours). The dataset `monitor.<key>` carries them as metrics – `<check>.ageSeconds`, `<check>.ageSeconds.<value>`, `<check>.writes`, `<check>.itemCount`, `<check>.tableSizeBytes` – for KPI and trend widgets.
- **IAM:** the read-only statements are in [AWS.md](AWS.md#dynamodb-monitor-checks).

**Trying checks without the platform.** _Test with recorded responses_ (monitor page) runs the monitor's platform checks against the [recorded responses](PLATFORMS.md#recorded-responses-and-test-runs) of their platforms and shows the results; nothing is stored. Other check types are skipped.

## Heartbeat API for gateways

### One check

`POST /api/hooks/monitor/<hook id>` – the URL is shown on the check (_Heartbeat setup_). Body: JSON, at most 64 KB.

```json
{ "status": "up", "value": 42.7, "ts": "2026-10-22T08:15:00Z", "data": { "unit": "kW" } }
```

| Field    |                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status` | optional: `up`/`ok`/`true`, `degraded`/`warning`, `down`/`error`/`false` … (`statusExpression` can compute it from the report instead)                                             |
| `value`  | optional, any JSON value; available to `condition`, e.g. `value > 0`                                                                                                               |
| `ts`     | optional, when the gateway took the measurement (ISO 8601 or Unix time). Freshness is computed from it, but never later than the moment the report arrived. Default: arrival time. |
| `data`   | optional, anything else; shown on the check                                                                                                                                        |

```bash
curl -sS -X POST "https://steward.corp.example/api/hooks/monitor/hb_XXXXXXXX" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $STEWARD_HEARTBEAT_SECRET" \
  --data '{"value": 42.7, "ts": "2026-10-22T08:15:00Z"}'
```

Answer: `202 {"accepted": true, "status": "up"}` (the check's status after this report).

### Gateway batch

A gateway usually prefers **one call for many checks**. Create a gateway under _Monitors → Gateways_ (designers and administrators); its secret is shown once. Its _allowed keys_ (`m17.*`) are required: a gateway reports nothing else, and only for monitors its owner may edit (the report is evaluated with the owner's rights).

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

- **Authentication:** static token (`Authorization: Bearer <secret>` or `X-Steward-Token`) or HMAC (`X-Steward-Signature: sha256=<hex HMAC-SHA256 of the raw body>`; for gateways also `X-Steward-Gateway: <gateway id>`). Secrets have 256 random bits, are stored encrypted (HMAC) and as SHA-256 (constant-time comparison), are shown once and can be rotated (audited). Creating a gateway and rotating a gateway or heartbeat secret need a signed-in session; API tokens get `403 SESSION_REQUIRED`.
- **Answers:** `404` unknown or disabled check/gateway, or source address not in the allow-list (same answer) · `503` vault locked · `401` wrong secret · `415` not JSON · `400` invalid JSON or report · `413` body over 64 KB · `429` + `Retry-After` over the rate limit.
- **Audit:** rejected calls are written as `monitor.report_rejected` at most once per endpoint and reason every 10 minutes; accepted reports are only counted (they are frequent).
- No session and no `x-sm-client` header is needed; put `/api/hooks/` behind TLS and allow only the gateway's network.

MQTT is not supported yet; a small bridge (e.g. Node-RED) can turn MQTT messages into the batch call.

## Outputs

Outputs are configured per monitor (_Edit → Outputs_). Because they act in the monitor's name (runbooks start as the owner), changing them needs the **manage** right (owner, administrators or the access list); `edit` is enough for checks and links. Outputs can include the monitor status, every check, or both (`include`), optionally only some checks (`checks`) and statuses (`statuses`). They send **on change** (default) or **after every evaluation** (`on: every`, at most every `minIntervalSeconds`, default 60). Per output and subject the last delivered status is stored: nothing is sent twice (also not after a restart), and a failed delivery is retried with a later evaluation (at most once a minute). Targets may use `${monitor.key}`, `${monitor.name}`, `${check.id}`, `${check.key}` and `${check.name}`.

| Type                | Default subjects                | During maintenance                      |
| ------------------- | ------------------------------- | --------------------------------------- |
| `notification`      | the monitor                     | silenced                                |
| `process`           | the monitor, status `down` only | silenced                                |
| `webhook`, `zabbix` | monitor and checks              | sent with status `maintenance` (code 5) |
| `gatus`             | monitor and checks              | not sent                                |

While a monitor with states is **off**, people-facing outputs stay quiet and the others send `off` (code 6); Gatus outputs choose with `whileOff` – see [States](#outputs-notifications-and-the-wall).

**Platform kinds.** A `gatus` output needs a Gatus platform, a `zabbix` output a Zabbix platform (a Teams card: a _Microsoft Teams channel_ platform). Saving refuses another kind with `OUTPUT_PLATFORM_KIND`; an import or a Git sync update offers only platforms of that kind. A stored output whose platform is of another kind (saved before 0.11.0, or the platform's kind changed) sends nothing and reads no credential: the failure is recorded on the output and logged (`monitor output failed`), and the start-up warning about checks lists such outputs too.

### Notifications

Event `monitor.status` (in-app, and e-mail/Teams/webhook as routed under _Settings → Notifications_). Recipients: the **owner** and the **subscribers** (`user:…`, `team:…`, `role:…`) who may view the monitor. People are told about _confirmed problems and their recovery_: a check folded into its parent's failure (`suppressDependents`, default on) and an acknowledged monitor stay quiet; `unknown` is only sent when selected in `statuses`. `holdSeconds` waits before alerting, so a parent that fails a little later can still explain the failure.

### Webhook

`POST` to `url` (no credentials in the URL) – or to `platform` + `path`, using that platform's authentication.

**Teams card** (`format: teams`): instead of the JSON below, one Adaptive Card per status change (at most 10 per evaluation), in the look of the notification settings and the default language – the same card as the _monitor status_ notification. So a monitor posts to its own Teams channel, not only to the one under _Settings → Notifications_. Create a platform of kind **Microsoft Teams channel (Workflows)** per channel and put the Workflows URL ("Post to a channel when a webhook request is received") into its credential `webhookUrl`: the URL carries its own signature, so it is stored encrypted like every credential, never shown again and never part of the monitor definition or its exports. A Teams card always goes to such a platform: saving refuses a plain URL or a path with this format (`OUTPUT_TEAMS_PLATFORM`). The platform's access list decides who may post there; the outbound policy must allow the URL's host.

```yaml
outputs:
  - { id: ops, type: webhook, format: teams, platform: 'Teams – Ops channel', include: monitor }
```

The JSON format:

```json
{
  "source": "steward",
  "monitor": { "id": "mon_…", "key": "machine-17-powermeter", "name": "Machine 17 – PowerMeter" },
  "events": [
    {
      "level": "check",
      "status": "down",
      "statusCode": 2,
      "previous": "up",
      "since": "2026-10-22T08:20:00.000Z",
      "ts": "2026-10-22T08:20:00.000Z",
      "message": "Newest report is 5 min old, expected every 60 s (5 intervals missed)",
      "rootCauses": [],
      "check": { "id": "pm-reports", "key": "m17.powermeter", "name": "PowerMeter data reported by the gateway", "type": "heartbeat" },
      "monitor": { "id": "mon_…", "key": "machine-17-powermeter", "name": "Machine 17 – PowerMeter", "status": "down" },
      "durationMs": null,
      "value": 42.7
    }
  ]
}
```

### Runbooks

`type: process` starts a process as the **monitor owner** (their rights are checked at every start) with inputs mapped by JSONata over `{ monitor, check, event }`, e.g. `machine: monitor.name`, `cause: event.rootCauses[0].checkName`. The run shows _Monitor "…"_ as its origin; while the previous run of the output is still active, no new one is started.

### Gatus external endpoints

```yaml
# Gatus config.yaml
external-endpoints:
  - name: machine-17-powermeter
    group: steward
    token: '${STEWARD_EXTERNAL_TOKEN}'
    heartbeat:
      interval: 10m
```

Output: `type: gatus`, the Gatus platform, `endpointKey: steward_${monitor.key}`, credential `externalToken` on the platform (or `tokenSecret`). Steward sends `POST /api/v1/endpoints/<key>/external?success=true|false&error=…&duration=…ms` with `Authorization: Bearer <token>`. `up` and `degraded` count as success. While a monitor with states is **off**, `whileOff` decides: `success` (default), `failure`, or `skip` (nothing is sent – Gatus marks the endpoint failed after its heartbeat interval); a contradiction and Off beyond the maximum are always failures. See [GATUS.md](GATUS.md#3-push-steward-check-results-into-gatus).

### Zabbix push

Add a platform from the preset **Zabbix (monitor outputs)**: variable `host` (the Zabbix host the items belong to), `trapperHost`/`trapperPort` (server or proxy, default 10051), `apiPath` (default `/api_jsonrpc.php`) and, for the API mode, the credential `token` (API token).

Default item keys (change them with `itemKeyMonitor` / `itemKeyCheck`):

- `steward.monitor.status[<monitor key>]`
- `steward.check.status[<monitor key>,<check id>]`

Values: `0` up, `1` degraded, `2` down, `3` unknown, `4` blocked, `5` maintenance, `6` off (0.13: a monitor with [states](#states-off-is-not-an-outage), every check agreeing) – or the status word with `value: text`.

**a) Sender / trapper protocol** (`via: sender`, default). In Zabbix create items of type **Zabbix trapper** with these keys (type of information _Numeric (unsigned)_, a value map 0–6 – add the row 6 → Off when updating to 0.13), and put Steward's address into _Allowed hosts_. Steward speaks the `zabbix_sender` protocol over TCP: header `ZBXD` + `0x01`, 4-byte little-endian data length, 4 reserved bytes, then `{"request":"sender data","data":[{"host","key","value","clock","ns"}]}`; the answer's `info` (`processed: 2; failed: 0; total: 2; seconds spent: …`) is checked – any `failed` value is reported as an output error (usually a wrong host name, item key or item type). TLS/PSK for the trapper connection is not supported; allow unencrypted connections for this host or use the API mode over HTTPS.

**b) API `history.push`** (`via: api`, Zabbix **7.0** or later). The same trapper items (or HTTP agent items with _Enable trapping_); the Zabbix frontend's address must be in the items' _Allowed hosts_. Steward calls `history.push` with `[{host, key, value, clock, ns}]` and `Authorization: Bearer <API token>` and reports per-value errors from the answer.

Use `on: every` with `minIntervalSeconds: 60` and a Zabbix trigger such as

```
last(/steward/steward.monitor.status[machine-17-powermeter])=2
nodata(/steward/steward.monitor.status[machine-17-powermeter],5m)=1
```

so Zabbix also notices when Steward itself stops sending.

### Zabbix pull

The public API (token with scope _read_, a viewer service account is enough) serves everything for Zabbix **HTTP agent** items:

1. **Discovery rule** (HTTP agent): URL `https://steward.corp.example/api/v1/monitors/discovery`, header `Authorization: Bearer {$STEWARD_TOKEN}`. Answer:

   ```json
   {
     "data": [
       {
         "{#MONITOR}": "machine-17-powermeter",
         "{#MONITORNAME}": "Machine 17 – PowerMeter",
         "{#MONITORID}": "mon_…",
         "{#CHECK}": "pm-reports",
         "{#CHECKNAME}": "PowerMeter data reported by the gateway",
         "{#CHECKTYPE}": "heartbeat",
         "{#CHECKKEY}": "m17.powermeter"
       }
     ]
   }
   ```

   `?level=monitors` returns one entry per monitor.

2. **Item prototype** (HTTP agent): URL `https://steward.corp.example/api/v1/monitors/{#MONITOR}/status`, same header, preprocessing _JSONPath_ `$.checks[?(@.checkId=='{#CHECK}')].statusCode.first()`.
   With many checks, prefer a discovery rule with `level=monitors`, one master item per monitor (`/monitors/{#MONITOR}/status`, type text, history 0) and dependent items with JSONPath – one request per monitor instead of one per check.
3. The monitor status itself: JSONPath `$.statusCode` on the same answer.

The API is rate-limited per token (`SM_API_RATE_LIMIT`, default 600/min).

### Prometheus

Steward's own metrics for a Prometheus to scrape (reading PromQL from a Prometheus is a check type: [PROMETHEUS.md](PROMETHEUS.md)). `/api/metrics` ([METRICS.md](METRICS.md)) contains

```
sm_monitor_status{monitor="machine-17-powermeter",check=""} 0            # the monitor itself
sm_monitor_status{monitor="machine-17-powermeter",check="pm-reports"} 2
sm_monitor_last_ok_timestamp_seconds{monitor="machine-17-powermeter",check="pm-reports"} 1792656000
sm_monitor_evaluations_total{type="heartbeat",result="up"} 1234
sm_monitor_state{monitor="machine-17-powermeter",state="running"} 1   # monitors with states (0.13)
```

`sm_monitor_status` is `6` while a monitor with states is off; `== 2` rules are unaffected, rules on `> 1` also fire on maintenance (5) and off (6).

Until 0.10 these were `steward_monitor_status`, `steward_monitor_last_ok_timestamp` and `steward_monitor_evaluations_total`. 0.11 still serves the old names (deprecated); 0.12 removes them.

```yaml
- alert: StewardMonitorDown
  expr: sm_monitor_status{check=""} == 2
  for: 2m
```

### Prometheus templates

- The monitor example [Error budget burn rate](../examples/monitors/51-error-budget-burn-rate.yaml) alerts on the burn rate of a service's error budget with the check type `prometheus`: down at 14.4× over one hour, degraded at 6× over six hours (the multi-window rule of the Google SRE workbook; the objective is the divisor of the query).
- The process [Prometheus – SLO and error-budget report](../examples/processes/65-prometheus-slo-report.yaml) (weekly) reads the share of good requests per service over the objective window (28 days by default) from your PromQL (`$window` is replaced), the error budget left and the burn rate over 1 h and 6 h, and publishes `prom.slo` for the dashboard [Service levels](../examples/dashboards/65-service-levels.yaml).

The other monitor examples cover the check types `snowflake` (50), `kubernetes` (52), `git` (53), `kafka` (54), `mqtt` (55), `checkmk` (56), `tcp` (57, a template) and `kafka-connect` (63); see [examples/README.md](../examples/README.md#monitors).

### Dashboards

Steward publishes the dataset **`monitors.status`** (one row per monitor; visible to users who may view every monitor) and **`monitor.<key>`** (one row per check; causes in other monitors appear as "another monitor") at most once a minute, with the metrics `up`, `down`, `degraded`, `unknown`, `monitors` / `checks`, `uptime24h` – and the [values of DynamoDB checks](#dynamodb-tables). Use them in table, status and KPI widgets like any other dataset.

## From an Insights Hub mapping

A data collection's [Insights Hub sink](PLANT.md#insights-hub-mapping) maps its items to assets, aspects and variables there (0.14). The sink shows per asset and aspect which **existing** checks watch the variables already – Insights Hub freshness checks on the same platform, asset (case ignored) and aspect whose `variables` include the variable – and only for the variables nobody watches offers **Create monitor**. It creates a **disabled** monitor – a draft for review, never enabled by Steward:

- one `freshness` check (`source: insightsHub`) per asset and aspect with the unwatched variables (a target the last check of the mapping found missing gets none), `mode: cadence` with the collection's interval as `expectedIntervalSeconds` for a collection read every interval, else `mode: maxAge` with 15 minutes;
- the **allowance** for late data from what Steward [measured](#how-fresh-is-fresh-delays-in-insights-hub) on the asset's other checks: the suggestion of the observed delay of a check on the same asset (the same aspect first), else that check's own `allowedDelaySeconds`, else none – then enable it with a short interval and apply the suggestion after a day;
- **states** from the asset's planned-off behaviour: when the plant asset links to a monitor with states of its own (a condition, not following another one), the draft [follows](#following-another-monitor) it – `states.from` that monitor, a row per state, its new checks expected `down` in an off state and `up` otherwise – so planned off times and [planned downtime](#maximum-off-time-and-planned-downtime) stay quiet. Without one, its description says to add states before enabling it.

Its checks are linked to the items they cover, so the sink shows the draft as watching (_Disabled_) and the monitor's page says which collection's items it covers (_Covers 3 mapped items of …_); _Check mapping_ also stores the links of the checks it finds. Creating needs the right to create monitors and to manage the collection's site (`monitor.created` and `plant.ih_monitor_created`, with the checks, their allowance's source and the monitor followed).

## Templates for many machines

A template is a monitor definition with parameters. `{{ params.<name> }}` placeholders may stand anywhere – also where numbers are expected, e.g. `fallbackPort: "{{ params.pmPort }}"` or `maxAgeSeconds: "{{ params.machineMaxAge + 300 }}"` (JSONata). They are replaced **once**, when an instance is created.

- _Monitors → Templates → New monitors_: one instance with a form, or **many from CSV** (header line = parameter names, optional `name` and `key` columns; `,` or `;`). All rows are validated first; a bad row creates nothing.
- An instance remembers its template, the template version and its parameters. When the template changes, the instance shows _template updated_; **Re-sync** renders the current version again (heartbeat endpoints and secrets stay).
- `examples/monitors/30-powermeter-machine-template.yaml` is a complete template for a machine with a PowerMeter. Since 0.13 it has [states](#states-off-is-not-an-outage) (Running, Off) with the gateway's monitor as required check (parameter `gatewayMonitor`, default `gateway-hall-2`) and the maximum off time as a parameter (`maxOffHours`, default 8); existing instances get them with **Re-sync**, and a CSV of 30 machines creates 30 monitors with states.

**Save as template** (in the editor of a saved monitor): turns the monitor into a new template. Choose the fields that become parameters – host names, URLs, asset ids and keys are chosen from the start – and their names; the same name for several fields makes one parameter. Each parameter's default is the value it had. The monitor stays as it is; the template records that it was copied from it (`monitor.duplicated` with `asTemplate`).

A process can create instances too: `POST /api/monitors/<template id>/instances` with `{ "rows": [ { "params": { … }, "name": "…" } ] }` (or `{ "csv": "…" }`) and an API token with scope _full_.

## Permissions and audit

| Right         | Default roles      | Allows                                                                 |
| ------------- | ------------------ | ---------------------------------------------------------------------- |
| `view`        | everyone           | See the monitor, its checks and history (also in the API and datasets) |
| `acknowledge` | operator, designer | Acknowledge problems, plan maintenance, _Check now_                    |
| `edit`        | designer           | Change the definition, rotate heartbeat secrets, re-sync               |
| `manage`      | admin, owner       | Access list, owner, delete                                             |

**Sub-monitors you may not view.** A monitor can include a sub-monitor that some of its viewers may not view. They see the sub-monitor node with its status, but not which monitor it is: root causes, _likely caused by_, the node's link, messages, history, the YAML export, the definition, the `monitor.<key>` dataset, the public API, the MCP tools and notifications show "a monitor you cannot view" instead of its id, key, name and check names. The sub-monitor check's own message never names the monitor ("The sub-monitor is down"). An editor who may not view the sub-monitor can still save the monitor; the reference stays as it is (`(hidden)` in the definition). A copy (_Duplicate_) made by someone who may not view it leaves the sub-monitor out – with its links and its cells in the states table (condition, required, expected); a state whose condition named only that sub-monitor is left out too, and so are the states of a monitor that follows one they may not view. The message after copying says what was left out.

Designers and administrators create monitors and gateways; the creator becomes the owner. An access list (users, teams, roles) narrows the rights like for processes. Checks and outputs that use a platform need the _use_ right of the editor when saving and of the **owner** when they run (checked again at least once a minute). The audit log records `monitor.created`, `monitor.updated` (with added, removed and changed checks), `monitor.deleted`, `monitor.access_changed`, `monitor.secret_rotated`, `monitor.maintenance_added`/`_ended` (deprecated maintenance routes), `monitor.acknowledged`, `monitor.resynced`, `monitor.gateway_*`, `monitor.report_rejected`, `monitor.test_run` and `monitor.check_previewed`.

### Identities

A check or output on a platform reads or sends with the platform's **default identity** – or the identity it names (`identity`: its id or name; the editor shows a choice where the platform has several, [ADR 0009](adr/0009-platform-identities.md)). The editor must be allowed to use the identity when saving, the monitor's **owner** at every run (checked again at least once a minute); a check whose owner may no longer use it reports why, like a platform the owner may not use. Outputs write: they never send with a read-only identity (`IDENTITY_READ_ONLY` when saving). A shared read of several checks (Insights Hub, Gatus, Checkmk) is shared only among checks with the same identity. The identity's operation filter applies to the check's requests; an identity named by a monitor cannot be deleted. Process outputs name the identity per slot (`identities`, as schedules do). See [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#identities).

```yaml
checks:
  - id: users
    name: Users answer
    type: platform
    platform: Directory
    identity: Monitoring # read with this identity instead of the default
    path: /users
```

## Engine, storage and limits

- **Scheduler.** A light scheduler next to the process engine (monitor checks do **not** create process runs). Each check runs on a fixed grid of its interval with a stable phase per check, so shared reads land in the same cycle and restarts keep the rhythm. Active checks run with a global concurrency limit (`SM_MONITOR_CONCURRENCY`, default 8), a timeout each and the platform's own concurrency limit; OpenTelemetry spans `monitor check <type>` are recorded when tracing is on.
- **State.** Status, counters, the latest result, heartbeat reports and the [observed delay](#how-fresh-is-fresh-delays-in-insights-hub) of freshness checks live in the database, so a restart continues where it stopped. Status **changes** are kept as history, uptime comes from **hourly samples** (evaluations that were ok vs. down) for checks and from the time-weighted history for monitors; the latest 50 raw results per check are kept.
- **Retention.** _Settings → Data retention → Monitor history_ (`retentionMonitorDays`, default 30) – history, samples, results and the monitors' own maintenance windows from before 0.11 are removed by the daily cleanup; the newest status change per check is kept. Catalogue maintenance windows stay.
- **Database.** SQLite or PostgreSQL, like everything else. One Steward instance per database (enforced), which is also why rate-limit counters may live in memory.
- **Sizes.** Up to 100 checks and 30 outputs per monitor; heartbeat bodies up to 64 KB; at most 500 reports per gateway call. Designed for dozens of monitors with a handful of checks each and intervals of 30 s or more.

Limitations: no MQTT ingestion yet (use a bridge); no TLS/PSK for the Zabbix trapper connection; the ping fallback can only say "reachable", not measure ICMP round trips; Zabbix discovery is pull-only (Steward does not create Zabbix items).

## Protocol facts and sources

Checked on 2026-10-22; verify against your versions.

| Fact                                                                                                                                                                                                                                                                                                                                   | Source                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zabbix sender protocol: `ZBXD`, flags `0x01` (protocol), `0x02` (compression), `0x04` (large packet), 4-byte little-endian data length + 4 reserved bytes; request `{"request":"sender data","data":[{host,key,value,clock,ns}]}`; answer `{"response":"success","info":"processed: 1; failed: 0; total: 1; seconds spent: 0.060753"}` | Zabbix manual, _Zabbix sender protocol_ and _Header_ (7.0–8.0): <https://www.zabbix.com/documentation/current/en/manual/appendix/protocols/zabbix_sender>                                 |
| `history.push` exists since Zabbix 7.0 (ZBXNEXT-8541); records use `itemid` or `host` + `key`, `value`, `clock`, `ns`; result `{"response":"success","data":[{"itemid":"…"} or {"error":"…"}]}`; the frontend address must be in the trapper items' _Allowed hosts_                                                                    | <https://www.zabbix.com/documentation/7.0/en/manual/api/reference/history/push>, <https://support.zabbix.com/browse/ZBXNEXT-8541>                                                         |
| Zabbix LLD JSON `{"data":[{"{#MACRO}":"value"}]}`                                                                                                                                                                                                                                                                                      | Zabbix manual, low-level discovery                                                                                                                                                        |
| Insights Hub IoT Time Series v3 `GET /timeseries/{entityId}/{propertySetName}` with `from`, `to`, `select`, `limit`, `latestValue`, `latestRecord`; `latestValue` reads aggregated data (1–2 h delay), `latestRecord` the raw store but only the variables of the newest record                                                        | Siemens Insights Hub API docs and support articles _latestValue and latestRecord while querying TimeSeries Data_ (PL8555040), _IOT timeseries API not returning latest value_ (PL8543152) |
| Gatus external endpoints: `POST /api/v1/endpoints/{key}/external?success=&error=&duration=`, `Authorization: Bearer <token>`                                                                                                                                                                                                           | Gatus README, see [GATUS.md](GATUS.md)                                                                                                                                                    |
