# 0021. Monitor states and expected statuses

- **Status:** Accepted (owner decision 2026-11-09) – every _Recommendation_ below was taken as recommended, except the Gatus output, which became a per-output setting (see _Owner decisions_)
- **Date:** 2026-11-09
- **Since:** planned for 0.13 or later – monitors ([MONITORS.md](../MONITORS.md))

## Context

A machine monitor turns red every time the machine is switched off on purpose. The example in [MONITORS.md](../MONITORS.md#example-a-machine-with-a-powermeter) (`examples/monitors/10-…` and `11-…`) has these checks: _PowerMeter reachable_ (ping, TCP fallback 502), the PowerMeter's data reported by the gateway (heartbeat, cadence 60 s) and in Insights Hub (freshness, cadence 60 s), and the sub-monitor _Machine 17 – machine data_ (heartbeat with maximum age 600 s, Insights Hub freshness with maximum age 900 s). The PowerMeter sits in the machine's cabinet and loses power with it. At a switch-off at 18:00 the checks fail one after the other: the ping after two failures (about 18:02), the PowerMeter heartbeat after four missed intervals, its Insights Hub data after six, the machine data after 10 and 15 minutes. The result is two alerts every evening – _Down: Machine 17 – PowerMeter · Root cause: PowerMeter reachable_ ("timeout") and _Down: Machine 17 – machine data_ – although every check agrees that the machine is off.

The owner wants monitors to report an issue only when **checks contradict each other**, not when they consistently say "off", and to define that evaluation logic per monitor.

What the code does today:

- **Per check:** `applyResult` (`server/src/monitors/logic.ts`) applies flapping control – `down` after `failuresBeforeDown` failing results, back after `successesBeforeUp`; `unknown` does not end a confirmed `down`; `blocked` is taken over directly.
- **Per monitor:** `analyze` computes, from the confirmed check statuses, the root causes (the topmost failing ancestors along soft and hard links; a sub-monitor node expands to that monitor's root causes) and the status by `aggregate.rule` – `worst`, `critical` (a non-critical check only degrades) or `quorum`. A maintenance window overrides the result with `maintenance` as the last step.
- **Statuses** are `up`, `degraded`, `down`, `unknown`, `blocked`, `maintenance` with the codes 0–5 (`MONITOR_STATUSES`, `MONITOR_STATUS_CODE` in `shared/src/monitors.ts`) that Zabbix, Prometheus, the webhook and `/api/v1` carry. Nine places map every status (`Record<MonitorStatus, …>`): status pages, plant live states, datasets, the wall, the web badges and others.
- **Uptime** (`monitors/stats.ts`, [ADR 0018](0018-one-maintenance-window-concept.md)): `upAndDown` counts `up` and `degraded` as available and `down` as unavailable; `unknown`, `blocked` and `maintenance` count neither way. The monitor's figure, availability objectives with the monitor as source and the reports' availability section all use it.
- **What helps today, and why it is not enough:** a maintenance window silences everything, contradictions included, and must be planned – an unplanned stop still alerts; an acknowledgement lasts until the monitor is up again; `critical: false` and `quorum` weaken checks but cannot express "these checks agree".
- **Expressions:** JSONata (`engine/expr.ts`, `evalExpr`) already turns values into statuses per check – an `http` or `platform` `condition`, a heartbeat `condition` or `statusExpression` (example 11: `value > 0`).
- **Gateways:** `monitor_gateways.last_seen_at` changes only when a report is accepted. A gateway whose machines are all off and that has nothing to forward looks exactly like a dead one.

## Decision

### 1. States: a decision table per monitor

A monitor may have **states** (Running, Off, Standby …). Each state is a row of a **decision table** whose columns are the monitor's checks. A row has:

- a **condition** – cells that select the state (_when_);
- **required** checks (_requires_) – a precondition that must be up for the state to be trusted (section 5);
- **expected statuses** of the other checks (_expect_);
- the **status it shows** when everything agrees: `up` (default) or `off`;
- optionally a settle time, a maximum off time (sections 3 and 4) and how a contradiction counts (`down`, the default, or `degraded`).

A cell is `up` (matches `up` and `degraded`), `down` (matches `down`; `blocked` counts as `down`, since a check skipped by a hard link is consistent with its parent being down) or `any` (no expectation: the check is shown but neither confirms nor contradicts the state). A check the row does not name is `any`. A sub-monitor column also offers `off`. **The first row whose condition matches wins.** A last row, _Otherwise_, is fixed: no state, today's evaluation. A monitor without `states:` behaves exactly as today.

_Recommendation:_ the condition should name the checks that react first (the direct check of the device – the ping); the expectations are the data paths that lag behind it. This split is what makes settle time (section 3) work: the state changes when the fast check changes, and the slow checks get time to follow.

```yaml
# Proposal for examples/monitors/11-machine-17-powermeter.yaml – checks as today, plus:
checks:
  # … pm-reachable, pm-reports, pm-ih, machine as today
  - { id: gateway, name: Gateway Hall 2 alive, type: monitor, monitor: gateway-hall-2 }
links:
  # … as today, plus the gateway as parent of what it forwards (root causes fold under it)
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
      # settleSeconds: 1020 – derived from the checks when left out (section 3)
```

**Rules checked when saving** (`definitionIssues`, with the editor showing each problem on its cell): state ids unique (`CHECK_ID_RE`), at most 10 states; every cell names an existing, enabled check; every row has at least one condition cell; `off` only on a sub-monitor column; a required check is not also a condition or expectation cell of its row; a row can never match (an earlier row has the same or a wider condition) – a warning, not an error. States are part of the definition: the _edit_ right, `monitor.updated` lists them, YAML export, import, Git sync and templates carry them.

_Recommendation – no JSONata escape hatch in the first version._ It would not fall out of the existing expression support: `analyze` is pure and synchronous and works on statuses, while `evalExpr` is asynchronous and the checks' values have a different shape per check type (`last_result.value`). The cases an expression would cover – a PowerMeter that stays on and reports 0 kW when the machine is off – are covered per check: a heartbeat `condition` (`value > 0.5`) turns the reading into a status the table can use (better as its own check _Machine draws power_ next to _PowerMeter data arrives_, so "no data" and "no power" stay apart). A table is also what the "why" panel (section 9) can explain cell by cell; an expression is not. Revisit when real cases need arithmetic across checks.

### 2. `off`, agreement and contradictions

**Evaluation**, added to `analyze` after the check views and before the maintenance override (pure functions in a new `shared/src/monitorStates.ts`, so the editor's preview and the server agree, as `definitionIssues` does):

1. **Select** the state with the **confirmed** statuses (after flapping control): the first row whose condition and required cells match. A not-yet-confirmed failure (`pendingDown`) does not change the state, so one lost ping never switches Running to Off.
2. **Compare** each `up` and `down` cell of the selected row with its check. A check that agrees is not an issue. A check that deviates is a **contradiction** – after the settle time (section 3).
3. **Status.** No contradiction: the row's status – `off` for an off row; for an `up` row, today's aggregation over the checks expected `up` (a degraded check still degrades, `critical` and `quorum` apply to these checks). A contradiction: `down`, or `degraded` when the row says so or the deviating check has `critical: false`.

**The new status `off`** (grey, label from the state: _Off – all checks agree_) is a monitor status and a check status: a check whose `down` agrees with its state shows `off` in every display and output, as checks show `maintenance` during a window today; its raw results and messages are kept unchanged. `off` is appended to `MONITOR_STATUSES` with **code 6** – codes 0–5 stay. In `worstStatus` it ranks **below `up`**: a parent without states whose sub-monitor is off is `up` (as a sub-monitor in maintenance counts as `up` today), and `off` only when all its checks are off. `isProblem` stays false for it.

**Root cause of a contradiction.** _Recommendation:_ the deviating cells of the **closest row** – the row (not _Otherwise_) with the fewest cells the current statuses contradict, the selected row winning a tie. Deviations fold along links as failures do today (a deviating check whose parent deviates the same way is _likely caused by_ it). The two contradictions the owner named:

| Situation                                          | Selected | Closest | Root cause and message                                                                                                                     |
| -------------------------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| PowerMeter reachable, machine data missing         | Running  | Running | _Machine data flow_ (expanded to the sub-monitor's own root cause): "Running, but machine data flow is down"                               |
| PowerMeter unreachable, but its data still arrives | Off      | Running | _PowerMeter reachable_: "PowerMeter reachable is down, but 3 checks say Running" – the check or its path is broken, as the note says today |

So "root cause = the deviating check" holds, measured against the state the evidence supports – a broken selector check is blamed, not the three checks that disagree with it.

**`unknown` and `blocked`.** An `unknown` check confirms nothing and contradicts nothing. In a condition cell it **keeps the current state** (as `unknown` does not end a confirmed `down`); with no current state the row is not selected. In an expectation cell the check shows `unknown`; the monitor shows the state with the note _2 checks could not be checked_, and is `unknown` when no expected check is known. `blocked` counts as `down` for matching and is never named as a root cause (its parent is).

**Maintenance** stays as it is: a window overrides the status with `maintenance` and silences everything. The state is still selected underneath, so it is right when the window ends.

### 3. Settle time

A state change (Running → Off, Off → Running, from or to _Otherwise_) starts a **settle time**. Until it ends, a deviation from the **new** state's expectations does not count: the check shows its own status with _settling_, the monitor shows the new state with _settling until 18:19_. The data paths go stale minutes after power-off and come back minutes after power-on; the settle time covers exactly that.

**Default:** derived per row from its expected checks – the largest of _freshness window + interval × confirmations_ per check:

- freshness window: `freshnessWindowSeconds` (`maxAgeSeconds`, or `expectedIntervalSeconds × downAfterMissed`) for `freshness` and `heartbeat` checks; 0 for others;
- confirmations: `failuresBeforeDown` when the cell expects `down` (or `off`), `successesBeforeUp` when it expects `up`;
- a sub-monitor column: its monitor's largest value computed the same way.

Example 11's Off row: _PowerMeter data in Insights Hub_ 6 × 60 s + 2 × 60 s = 8 min; the machine data's Insights Hub check 900 s + 2 × 60 s = 17 min – **17 minutes**. The editor shows the derived value and lets it be overridden per row (`settleSeconds`, 60 s to 24 h).

**Interplay, exactly:**

- **Flapping control** acts on each check first, unchanged; the state uses confirmed statuses (section 2). The selector's `failuresBeforeDown` therefore debounces state changes too.
- **A state change during settling** restarts the settle time for the newest state.
- **States that change too often:** _Recommendation_ – more than 4 state changes within 60 minutes make the monitor `degraded` ("Changes state too often: 6 times in the last hour") until an hour passes with fewer, so a flapping selector cannot keep contradictions hidden behind restarted settle times.
- **Required checks and contradictions in the condition** are not delayed: a failing precondition is judged at once (section 5).
- **Restart:** state, `state_since` and `settle_until` are stored (section 10), so a restart of Steward neither restarts nor skips a settle time.

### 4. Maximum off time and planned downtime

**Off can be an outage.** A consistent Off is quiet only up to the **maximum off time** of the monitor (`states.maxOffHours`; a row may set its own). Past it the monitor is `degraded` – "Off for longer than expected (9 h, maximum 8 h)" – and notifies like any degraded status. It counts from the time the state became Off (not from the end of settling). It ends when the state changes, or while planned downtime lasts. _Recommendation:_ 8 hours when not set (the editor shows it); `0` means no maximum, set on purpose.

**Planned downtime** is a new **kind** of catalogue maintenance window ([APPLICATIONS.md](../APPLICATIONS.md#maintenance-windows)): `kind: maintenance` (default, as today) or `kind: downtime`. It keeps one window concept ([ADR 0018](0018-one-maintenance-window-concept.md)) – the same form, calendar, targets, reach, rights, audit and `.ics` – and differs in what it does:

|                         | Maintenance (today)                         | Planned downtime (new)                                                        |
| ----------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| Monitor status          | `maintenance`                               | unchanged (`off`, `up` …)                                                     |
| Contradictions          | silenced                                    | **alerted**                                                                   |
| Maximum off time        | does not count (the window is excluded too) | **does not count** – the time inside a window is subtracted from the off time |
| Monitors without states | silenced                                    | no effect (the form says so)                                                  |
| Uptime and objectives   | excluded                                    | as the status says (Off is excluded anyway, section 6)                        |
| Announcements           | yes (reminder 24 h by default)              | _Recommendation:_ off by default – weekends are routine                       |

Recurring weekends are a weekly window (Friday 22:00 to Monday 06:00, `MAINTENANCE_LIMITS.maxDays` is 31); company holidays and shutdowns are windows that happen once. A machine off since Friday 22:00 with the weekend window stays quiet over the weekend; still off on Monday 14:00, it is `degraded` – 8 hours after the window ended. Yearly repetition and importing a holiday calendar are later (section 11). The engine asks `plannedDowntime(monitorId, from, to)` from `monitors/maintenance-hook.ts`, filled by `catalogue/maintenance.ts` as for maintenance.

### 5. Gateway liveness: a required check

Off is only trusted when something proves that the data would arrive if there were any. A state names **required** checks (`requires`); _Recommendation:_ the gateway's own heartbeat.

- **If a required check is not up** while the rest of the condition matches, the state is not taken: the monitor is `down` **at once** (no settle time; the required check's own flapping control applies), root cause the required check, message "Gateway Hall 2 is silent – Off cannot be told from an outage".
- **Modelling** (_Recommendation_): one small monitor per gateway, _Gateway Hall 2_, with a heartbeat check on a key of its own (`gw-hall2.alive`, cadence 60 s) that the gateway reports in every batch call whether or not a machine sends data. Each machine monitor includes it as a sub-monitor check and lists it in `requires` of its off row, and links it as parent of the checks the gateway forwards – so in Running a dead gateway is the root cause too, through today's folding. Rejected: a new check type reading `monitor_gateways.last_seen_at` – it changes only with accepted reports, so a gateway with all machines off looks dead; a heartbeat check per machine monitor – a heartbeat key belongs to one check (`HEARTBEAT_KEY_USED`).

### 6. Uptime and objectives

- **Off is excluded** from uptime and availability objectives, like maintenance: `upAndDown` counts `off` neither way and also returns the off time. Figures read **"Up 97 % · Off 31 h"** – on the monitor page (24 h, 7 d, 30 d), in objectives with the monitor as source (next to the planned minutes they already show) and in the reports' availability section (a column _Off_). Check samples count a check in `off` as _other_, as in maintenance.
- **Settling** counts as the new state: after → Off as off, after → Running as up.
- **Off beyond the maximum** is `degraded`, and the existing rule counts `degraded` as **available** (`upAndDown`: `up` and `degraded` are available time). So time over the maximum no longer counts as Off, does not lower the figure, and is listed apart: "Off beyond maximum 5 h". (Owner decision 11.)
- **A contradiction** is `down` (or `degraded`) and counts as such.
- Objectives on Gatus or PromQL keep their tools' figures.

### 7. Sub-monitors, root causes, notifications and the wall

**Sub-monitors.** A sub-monitor check reports `off` when its monitor is off; a parent with states can expect `off` in that column; a parent without states sees it as described in section 2 (`up`, unless all its checks are off). Root causes expand into sub-monitors as today.

**A sub-monitor that cannot decide its state itself** – _Machine 17 – machine data_ has only data checks – **follows** another monitor (_Recommendation_): `states.from: machine-17-powermeter` and rows that name the leader's state ids with this monitor's own expectations (no `when`). It changes state when the leader does (a leader's state change recomputes its followers, as status changes recompute including monitors today), with its own settle time and no maximum off time (the leader reports that). Saving refuses a leader whose condition or required checks use a follower (`STATES_CYCLE`).

```yaml
# Proposal for examples/monitors/10-machine-17-machine-data.yaml – checks as today, plus:
states:
  from: machine-17-powermeter
  cases:
    - { id: running, expect: { machine-reports: up, machine-ih: up } }
    - { id: off, status: off, expect: { machine-reports: down, machine-ih: down } }
```

**Notifications** (event `monitor.status`): `off` is never an alert. `dispatchOutputs` gets a quiet reason _expected state_ for people-facing outputs, as for maintenance – unless `off` is listed in the output's `statuses`. `off` after `down` or `degraded` is sent as a recovery, like `up`. An acknowledgement ends when the monitor is `up` or `off`. _Recommendation:_ state changes as **information** – a notification output option `stateChanges: true` sends a new event `monitor.state` ("Machine 17: Running → Off, all checks agree"), never urgent, held by quiet hours and digests ([ADR 0012](0012-quiet-hours-and-digests.md)).

**Status wall and pages.** The wall sorts `down`, `degraded`, `unknown`, `blocked`, `maintenance`, `off`, `up`; an off tile shows the state's label and a power icon, a settling tile _Off · settling 12 min_; a switch _Hide off_ for the control room. `off` is grey like `unknown`, so it never relies on colour: it has its own icon and word. Monitor detail shows the state next to the status and the "why" panel (section 9).

**Outputs** (each mapping checked against the code):

| Output                                         | Today's mapping                                   | `off`                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Webhook (`outputs.ts`, JSON)                   | `status`, `statusCode` from `MONITOR_STATUS_CODE` | `"off"`, `6`; new fields `state` (`id`, `name`, `since`, `settlingUntil`) and on a contradiction `contradiction` (expected, actual, checks) – additive |
| Teams card                                     | status word                                       | _Off – all checks agree_; only sent when `off` is selected or as a recovery                                                                            |
| Zabbix push (`sendZabbix`)                     | code 0–5 or the word                              | `6` or `off`; the value map needs a row 6 → Off. Triggers on `=2` are unaffected; triggers on `>1` already fire on maintenance (5) and will on 6       |
| Zabbix pull (`/api/v1/…/status`)               | `statusCode`                                      | `6`; `state` added to the answer                                                                                                                       |
| Prometheus (`metrics.ts`, `sm_monitor_status`) | 0–5                                               | `6`; new gauge `sm_monitor_state{monitor,state}` = 1 for the current state. `== 2` rules are unaffected                                                |
| Gatus output (`sendGatus`)                     | `success` = up or degraded; maintenance not sent  | per output, `whileOff`: `success` (default), `failure` or `skip` (send nothing); a contradiction and Off beyond the maximum are always failures        |
| Status pages (`status-pages.ts`)               | `down` → outage … `maintenance` → maintenance     | `operational` – the service is as planned                                                                                                              |
| Plant live state (`plant/live.ts`)             | `down` → offline                                  | `offline` with a new reason `off`, drawn grey on the OT network and plant views, not red                                                               |
| Datasets (`datasets.ts`)                       | `maintenance` → unknown                           | `unknown`; a new metric `off` in `monitors.status`                                                                                                     |
| Process output                                 | `down` only by default                            | not started                                                                                                                                            |

### 8. Templates for many machines

States live in the definition, so templates carry them with `{{ params … }}` anywhere ([MONITORS.md](../MONITORS.md#templates-for-many-machines)). _Recommendation:_ `examples/monitors/30-powermeter-machine-template.yaml` gains the gateway check (`gatewayMonitor` parameter), the two rows and `maxOffHours` (parameter, default 8); a gateway monitor example (`12-gateway-hall-2.yaml`) is added. Existing instances get states with **Re-sync**; a CSV of 30 machines creates 30 monitors with states. Thirty machines behind one silent gateway still raise thirty alerts plus the gateway's own, as today – grouping by a shared root cause belongs to site-wide correlation (section 11).

### 9. UI

**Editor: a tab _States_** (between _Graph_ and _Settings_):

```
 Order  State      Shows   PowerMeter   PM data    PM data     Machine    Gateway     Settle   Max off
                           reachable    gateway    Ins. Hub    data       Hall 2
 ↑↓ 1   Running    Up      [Up]●        Up         Up          Up         Up          16 min   –
 ↑↓ 2   Off        Off     [Down]●      Down       Down        Off        Up 🔒        17 min   8 h
    –   Otherwise  as without states
 ● selects the state   🔒 required   [ ] condition cell        [+ State]  [Try it]
```

- A cell is a select _Any / Up / Down_ (_Off_ for sub-monitors) with a toggle _Selects the state_ (condition) and _Required_; empty cells read _Any_. Rows move with buttons (and drag); the order is the priority.
- Each row shows _Matches now_ from the current statuses. **Try it** sets each check to a status and shows which row wins and what the monitor would report, with the "why" text – computed by the shared logic in the browser, nothing is stored.
- Settle shows the derived value with _(derived)_ until overridden; problems show on the cell as everywhere in the editor.

**Detail: "Why this state"** – a panel next to the graph:

```
Off since 18:02 · settled 18:19 · off 3 h 10 min of 8 h (planned downtime "Weekend" from 22:00 does not count)
Selected by   PowerMeter reachable   Down   agrees
Required      Gateway Hall 2         Up     agrees
Expected      PowerMeter data …      Down   agrees      (newest report 2.4 h old)
              Machine data flow      Off    agrees
```

On a contradiction: "✗ contradicts – PowerMeter data reported by the gateway: expected Down, is Up (newest report 40 s old). Closest state: Running – PowerMeter reachable is down although its data arrives." The graph marks agreeing checks grey with a tick, deviating ones with a cross.

**Keyboard and screen readers.** The table is a real `<table>` with header cells for rows and columns; every select has a label naming state and check ("Off – PowerMeter data reported by the gateway: Down"); move up and down are buttons; the _Try it_ result is announced (`aria-live="polite"`); agreement and contradiction are words and signs, never colour alone; `off` and `unknown` have different icons.

**Phones.** The table becomes one card per state with the checks as a list of _check: value_; editing works, large tables are a desktop task. The "why" panel stacks; the wall is unchanged.

### 10. Code, migration and tests

**Code.** `shared/src/monitors.ts` (`off`, code 6, rank, `statesSchema` in `monitorDefinitionSchema`, rules in `definitionIssues`); `shared/src/monitorStates.ts` (select, compare, closest row, derived settle time – pure); `monitors/logic.ts` (`analyze` takes the state context); `monitors/engine.ts` (`recompute` reads and writes the state, recomputes followers; the max-off and settle ends are noticed at the next evaluation, which every check interval triggers); `outputs.ts`, `metrics.ts`, `datasets.ts`, `stats.ts`, `reports/builtin-sections.ts`, `catalogue/status-pages.ts`, `plant/live.ts`, `catalogue/maintenance.ts` and `maintenance-hook.ts`; the web badges, wall, editor and detail page; docs (MONITORS, APPLICATIONS, NOTIFICATIONS, PROMETHEUS, the Zabbix value map).

**Migration (additive).** `monitors-0NN-states`: `monitor_state` gains `state_id`, `state_since`, `settle_until`; `monitor_history` gains `state` (null before), and a state change writes a monitor history row even when the status stays (Running and Standby both `up`), so `statusPoints` reads the same table. `catalogue-0NN-downtime`: `maintenance_windows.kind` (default `maintenance`). No monitor changes behaviour until it gets states. Older Steward versions importing an export with `states:` drop the section (the schema strips unknown keys) and alert as before. Consumers that enumerate statuses – Zabbix value maps, API clients with a fixed list – learn `off` from the upgrade notes.

**Tests.** The pure logic is tested without a clock; the engine with `setMonitorClock` and a simulated gateway, as the monitor tests do today:

- _Unchanged:_ every existing monitor test passes untouched; a definition without states gives the same `analyze` result (property test over random graphs and statuses).
- _Power-off with realistic lag:_ ping fails at once, PowerMeter data stops, Insights Hub lags 2–5 minutes, machine data stops after 10 minutes. No `down`, no notification during the settle time; `off` from the confirmed ping failure; all checks `off` after the lag.
- _Power-on:_ ping first, data 3 and 12 minutes later – no alert; data never coming back – a contradiction exactly at the end of the settle time, root cause the machine data.
- _Contradictions:_ ping down while data arrives (root cause the ping, closest row Running); ping up while machine data is missing (root cause the sub-monitor's own root cause); a contradiction during planned downtime is alerted; one during maintenance is not.
- _Flapping:_ one lost ping does not change the state; a selector that flaps gives `degraded` "Changes state too often", and settle restarts never hide a contradiction for more than an hour.
- _Maximum off:_ 8 h → `degraded` and a notification; a weekly weekend window across the boundary; a holiday window; leaving the window continues the count.
- _Gateway outage:_ gateway silent while off → `down` at once with the gateway as root cause; while running → the gateway as root cause through links.
- _unknown / blocked:_ Insights Hub errors keep the state and show the note; a hard-linked child counts as down.
- _Outputs and figures:_ code 6 in the webhook, Zabbix (sender and API), Prometheus and `/api/v1`; Gatus success; status pages and plant live states; uptime "Up · Off", objectives and the report column agree for one window.
- _Followers and cycles:_ the machine-data monitor follows the PowerMeter monitor; a cycle is refused; templates re-sync states; YAML round trip.
- _UI:_ the table and _Try it_ by keyboard only, a phone viewport, axe checks.

### 11. Later, not in the first version

- **Site-wide correlation:** many machines of a site turn Off at once outside planned downtime → one _site outage_ alert instead of many quiet monitors; and one alert, not thirty, for monitors whose root cause is the same gateway.
- **States from outside:** from a production or shift calendar (a dataset or an `.ics` feed that generates planned downtime), or from the plant asset's status (`ASSET_STATUSES`: `out_of_service` → Off without maximum, `maintenance` → maintenance).
- Yearly repeating windows and importing a holiday calendar; states in the public API's write path (read is in the first version).

## Owner decisions

Taken on 2026-11-09:

1. **States per monitor** with a condition and expected statuses per check, edited as a decision table (cells up / down / any, first matching row wins, _Otherwise_ = today's behaviour).
2. **Agreement is not an issue:** the monitor shows `off` (grey, label from the state) and sends no alert; a **contradiction** is an issue – down or degraded as configured, root cause the deviating check, the message names the contradiction.
3. **Settle time** per state change, derived from the freshness windows and delays of the checks involved, editable.
4. **Maximum off time** per monitor, then `degraded` and a notification; **planned downtime** as a new kind of catalogue window that suspends the maximum but not the alerting of contradictions.
5. **Gateway liveness:** Off requires the gateway's own heartbeat; a silent gateway is an outage, alerted at once.
6. **Uptime and objectives:** consistent Off is excluded and reported apart ("Up 97 % · Off 31 h"); Off beyond the maximum counts as degraded by the existing rules.
7. Sub-monitors, root causes, notifications (state changes are not alerts; information optional), the wall, the outputs, the YAML format (`states:`, backward compatible), templates and the examples are covered as above.
8. **Later:** site-wide correlation; states from a production calendar or the plant asset's state.

The open questions of the proposal, decided on 2026-11-09 – each the recommended answer except question 4:

9. **Machine data as its own monitor:** it _follows_ the PowerMeter monitor's state (`states.from`, section 7); both monitors and their own alerts stay.
10. **Maximum off time when not set:** 8 hours, shown in the editor; `0` means no maximum.
11. **Off beyond the maximum in uptime:** `degraded`, which counts as available by the existing rule; the over-time is listed apart.
12. **Gatus output for `off`:** a **setting per Gatus output**, `whileOff: success | failure | skip` (labels _While off: success / failure / send nothing_), default `success`. A contradiction and Off beyond the maximum are always sent as failures, whatever the setting.
13. **Information on state changes:** an opt-in output option `stateChanges` with its own event `monitor.state`.
14. **Planned downtime announcements:** off by default.
15. **States that change too often:** more than 4 changes within an hour make the monitor `degraded`.

## Consequences

- A machine switched off on purpose is grey and quiet; a stop that is not consistent, too long, or hidden by a silent gateway still alerts – with the check that does not fit as the root cause.
- Monitors gain a second layer of logic. The table and the "why" panel keep it explainable, but a badly ordered table can hide a problem: the editor's _Try it_, the _Matches now_ marks and the warning for rows that can never match are the safeguards.
- One more status everywhere: nine typed mappings, the Zabbix value map and external rules that compare codes. Codes 0–5 do not move.
- One window concept, two kinds. Downtime windows are planned like maintenance and do something different; the form has to make that plain.
- Uptime becomes honest for machines that do not run around the clock, and objectives stop counting nights as outages.
- Revisit when tables need arithmetic across checks (the JSONata escape hatch), when several leaders per follower are asked for, or when correlation across monitors arrives.
