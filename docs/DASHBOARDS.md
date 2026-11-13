# Dashboards

Dashboards show what processes publish: a snapshot of rows with a status per row, plus the history of metrics. Opening a dashboard makes no live API call; the data is as fresh as the last run that published it. For charts and data that Steward's dashboards do not cover, use Streamlit or Grafana on Steward's API: [EXTERNAL-DASHBOARDS.md](EXTERNAL-DASHBOARDS.md).

## Publish data and build a dashboard

1. **Publish data from a flow.** Add a **Publish to dashboard** node. Give it a dataset key such as `iem.devices`, the rows (an expression), optionally compact `columns`, a `status` expression per row (good / warning / serious / critical / unknown), a reason text, and `metrics` (numbers kept as history).
2. **What a run stores.** A dataset has one **partition per source** – the platform the rows were read from: the process's only connection, the publish step's `source` connection, or all bound platforms together (a process without connections: the instance). A run replaces only its own partition and appends its metrics, so the same inventory scheduled against three tenants keeps all three. Rows carry `_source` (`platformId`, `platform`, `environment`, `run`), metrics are kept per source, and existing datasets became one partition of their last run's platform.
3. **Keep it fresh.** Schedule the publishing flow, e.g. hourly inventories or a health check every 15 minutes. A partition written by a scheduled run (or by a sub-process of one) is stale after 2.5 × the interval of that schedule – read from the schedule as it is now, at least 15 minutes. The step's `staleAfterMinutes` is the limit for runs without a schedule (default 24 hours); with `staleAfterFixed: true` it applies to scheduled runs too, e.g. for a tighter limit. The freshness widget shows every source with _Fresh_, _Due_ (a scheduled run is overdue) or _Stale since …_, the interval in words, the limit and where it comes from ("stale after 2 h 30 min (from the schedule “Inventory EU”)", "via the “Nightly checks” schedule"), and the next run of that source's own schedule; the dashboard header gives the age of the oldest source. Stale messages go out when the step sets the limit or a schedule feeds the partition.
4. **Build the dashboard.** _Dashboards → New / From template / Import YAML_. Widget types:
   - `kpi`: value, change and sparkline;
   - `trend`: up to three metrics;
   - `status`: distribution of row statuses;
   - `table`: rows with status, search and a problems-only filter;
   - `checks`: the latest checks of a process;
   - `freshness`;
   - `markdown`;
   - `vega`: a chart from a [Vega-Lite](https://vega.github.io/vega-lite/) spec, for the few views the others do not cover ([below](#vega-lite-charts)).
5. **Sources.** When a dashboard's data comes from several sources, a _Sources_ filter appears (part of the URL, remembered per person); every widget follows it, or pins its own sources in the editor. Tables get a _Source_ column, trends one line per source, KPIs a value per source – or, with _With several sources → Sum of all sources_ (`combine: sum`), one total such as the users of all tenants, with the values per source below it. The change of a sum runs from its first to its latest point, so a source added in that period counts as growth. `GET /api/v1/datasets/{key}/rows` and `…/metrics` take `source` (repeat it) and return `_source` and `source` per series.
6. **Refresh.** _Refresh data_ re-runs the feeding processes with the inputs of their last run, provided you have run rights.
7. **Trends and forecasts.** A KPI shows the change of the **trend line** over its days instead of first point → latest value, with what it is based on ("Based on 28 points over 30 days · stable"). Give the publish step `limits` (an upper limit per metric: a quota, a contract) or `floors` (a lower limit: free storage), or a KPI its own _Limit_, and the KPI says when the trend reaches it at this rate ("Limit 1,130 reached in about 23 days (Nov 22)"). A trend widget can draw dashed trend lines. Details in [How the trend is computed](#how-the-trend-is-computed).

## How the trend is computed

A robust straight line through the points of the window (Theil–Sen: the median of the slopes between all pairs of points), so one outlier or a gap does not tilt it. A counter that was reset (it drops by more than half of its range while it otherwise only rises, e.g. a monthly quota) is followed from its last reset. Fewer than 5 points, or points covering less than a fifth of the window, give no trend: _too few points for a forecast_. The trend is _stable_ when the points stay close to the line (their median distance is under a quarter of the change), else _rough_. A forecast says _reached_, _in about N days_, _not heading for the limit_ (flat or moving away), or _not within two years_. The same math runs on the server and in the browser ([`shared/src/trends.ts`](../shared/src/trends.ts)). `GET /api/v1/datasets/{key}/metrics?trend=7d` returns `trend`, `limit` and `forecast` per series; checks use `$trend` and `$daysUntil` ([PROCESSES.md](PROCESSES.md#expressions-and-templates)), the daily summary a _Trends_ section ([NOTIFICATIONS.md](NOTIFICATIONS.md#daily-summary)).

## Vega-Lite charts

A `vega` widget draws its `spec` (Vega-Lite JSON, or YAML in the dashboard file) from the widget's dataset – nothing else:

- The data is the dataset's rows under the name `dataset` (at most 5,000), with the publish step's column labels as fields, plus `_status`, `_statusText` and `_source` (the platform's name). Leave `data` out, or write `{ name: dataset }` (e.g. in a layer).
- Refused when saving, from the editor, YAML, bundles and Git sync alike: `url` anywhere (no loading data or images), `href` (no links), `values` or other inline data, `datasets`, full Vega specs, specs over 64 kB.
- In the browser, expressions run in [vega-interpreter](https://github.com/vega/vega/tree/main/packages/vega-interpreter) instead of being compiled to code, so the Content Security Policy keeps `script-src 'self'` without `unsafe-eval`, and the chart's loader refuses every request. Vega is loaded only on dashboards that have such a widget.
- Colours, fonts and lines follow the light or dark theme. The schemes `steward` (series colours) and `steward-status` (good, warning, serious, critical, unknown – give that `domain`) can be used in `scale.scheme`; the spec's own `config` wins.
- _Chart / Table_ switches to a table of the fields the chart encodes, as for the other charts; the spec's `description` (default: the title) labels the chart for screen readers.
- Examples: _Devices per firmware version_ on _Edge fleet_ and _Used share of each limit_ on _Tenant usage_.

## Who can see what

A dataset is visible to everyone who may view the process that publishes it. A partition is left out – from rows, counts, metrics, the API and MCP, without a hint – when one of its platforms is kept from the reader (Restricted, or owned by teams the reader is not in, without a share that lets them use it – until 0.22 an access list); administrators and auditors see all. Platforms of the whole instance keep their data visible to everyone who sees the dataset.

**A dashboard** is seen by everybody signed in and changed by its owner (its creator) and administrators; with owning teams only their members see it, and a **designer among the members edits it** (0.23.0, [ADR 0033](adr/0033-one-access-model.md) decision 11 – before, only its owner could). Its _Access_ section shares it with a user, a team or a role – View, Edit or Manage – and administrators can make it Restricted ([TEAMS.md](TEAMS.md#sharing-the-access-tab)). Its owner has an implied Manage share: they change its shares and delete it; deleting needs Manage, not Edit.
