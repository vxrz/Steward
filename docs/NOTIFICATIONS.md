# Notifications

Steward notifies people in the app (the bell in the header) and – depending on _Settings → Notifications_ – by e-mail, Microsoft Teams or a webhook. Administrators choose per event which channels are used. People choose their language and whether they get e-mails on their profile page.

- [The bell](#the-bell)
- [Events](#events)
- [Notification policy of automated runs](#notification-policy-of-automated-runs)
- [What the messages say](#what-the-messages-say)
- [E-mail addresses outside Steward](#e-mail-addresses-outside-steward)
- [Look of e-mails and Teams messages](#look-of-e-mails-and-teams-messages)
- [Daily summary](#daily-summary)
- [Quiet hours and digests](#quiet-hours-and-digests)
- [Decisions from Microsoft Teams](#decisions-from-microsoft-teams)

## The bell

The bell in the header lists the newest 50 notifications, grouped by event. Groups of decision requests (_Decision_, _Request from an AI assistant_, _Duty exception asked for_) come first and always show every entry; other groups show three entries and _Show all N_. An unread decision request stays in the list however many alerts arrive after it.

- **Show:** _All_, _Decisions_, _Alerts_ (failed runs and checks, monitors, stale data, failing platforms, backups, budgets, broken objectives and contracts, undocumented access changes) or _Updates_ (reminders and news).
- **Unread only** hides what you have read.
- **Mark read** next to a group marks that group read; _Mark all read_ marks everything read. The API takes `POST /api/notifications/read-all` with `{ "events": ["check.failed"] }` for one group, or no body for all.

## Events

| Event                           | Key                     | Who gets it                                                                                                                                                                                                                                  |
| ------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision                        | `task.assigned`         | People who may decide a task that waits                                                                                                                                                                                                      |
| Run failed                      | `run.failed`            | Who started the run, the owner of the schedule                                                                                                                                                                                               |
| Check failed                    | `check.failed`          | Who started the run, the schedule owner, the process owner                                                                                                                                                                                   |
| Check passes again              | `check.resolved`        | The same, when a schedule asks for it (below)                                                                                                                                                                                                |
| Stale data                      | `dataset.stale`         | The process owner and administrators: after 2.5 × the interval of the schedule that fed it, else the publish step's `staleAfterMinutes`                                                                                                      |
| Schedule skipped                | `schedule.skipped`      | The schedule owner and administrators                                                                                                                                                                                                        |
| Monitor status                  | `monitor.status`        | Owners and subscribers of the monitor (root causes only)                                                                                                                                                                                     |
| Monitor state                   | `monitor.state`         | Owners and subscribers of a monitor with states whose notification output has _Tell state changes_ (information: Running → Off; never urgent)                                                                                                |
| Credential due                  | `credential.due`        | The owners of the entry ([CREDENTIALS.md](CREDENTIALS.md))                                                                                                                                                                                   |
| Report ready                    | `report.ready`          | The recipients of the report schedule ([REPORTS.md](REPORTS.md))                                                                                                                                                                             |
| Ticket not checked              | `ticket.unchecked`      | The responsible people of a ticket reference ([TICKETS.md](TICKETS.md#reminders))                                                                                                                                                            |
| Document review due             | `document.review`       | The review owner of a living document ([RECORDS.md](RECORDS.md#periodic-reviews))                                                                                                                                                            |
| Tech stack end of life          | `stack.eol`             | The owners of the application (else administrators), once when a release cycle ends soon and once at its end ([APPLICATIONS.md](APPLICATIONS.md#end-of-life))                                                                                |
| New major release               | `stack.release`         | The owners of the application or system (else administrators), once per new major release ([APPLICATIONS.md](APPLICATIONS.md#version-watch))                                                                                                 |
| Duty due                        | `duty.due`              | The owners of a service duty, else the service owners ([DUTIES.md](DUTIES.md))                                                                                                                                                               |
| Duty missed                     | `duty.missed`           | The same, when a mandatory or recommended duty's period ended without a run that counts                                                                                                                                                      |
| Duty period ended without a run | `duty.ended`            | The duty's and the service's owners (else administrators), not who archived or changed the duty                                                                                                                                              |
| Duty exception asked for        | `duty.exception`        | The duty's and the service's owners as of the request (else administrators), not the requester                                                                                                                                               |
| Objective breached              | `objective.breached`    | The service owners (else administrators), once per breach of an availability objective with _Send a message_ on ([SCORECARD.md](SCORECARD.md))                                                                                               |
| Maintenance                     | `maintenance.announced` | The responsible people and owners of what a maintenance window reaches ([APPLICATIONS.md](APPLICATIONS.md#maintenance-windows)); 0.14: the owners its [impact](APPLICATIONS.md#impact-before-maintenance) names, when the planner tells them |
| Incident review measure         | `measure.due`           | The owners of a measure from an incident review: before its due date, on it, weekly while overdue ([RECORDS.md](RECORDS.md#incident-reviews))                                                                                                |
| Platform connection failing     | `platform.failing`      | The platform's managers (else administrators), once when its periodic connection test starts failing – again only after it passed in between ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#platform-health))                                    |
| Cost budget                     | `cost.budget`           | The owners and owning teams of a service, application or team (else administrators), at 80 % and 100 % of its monthly cost budget, once per month and level ([COSTS.md](COSTS.md#budgets))                                                   |
| AI request                      | `mcp.request`           | People who may decide a request of an AI assistant to change something on a platform or to start a run ([MCP.md](MCP.md#approved-writes))                                                                                                    |
| Plant change to review          | `plant.change_proposed` | Who may apply a proposed plant change set: sees it and manages every site it touches (the catalogue for profiles and KPI definitions) – never one of its authors ([PLANT.md](PLANT.md#change-sets))                                          |
| Plant change decided            | `plant.change_decided`  | The authors of a plant change set someone else applied, rejected or returned to them – with the reviewer's comment – or that expired; never who decided                                                                                      |
| AI budget                       | `ai.budget`             | The administrators; for a gateway's budget also its managers, for a process's budget its owner – at 80 % and when it is used up, once per budget and period ([AI.md](AI.md#limits))                                                          |
| Data contract test failed       | `contract.failed`       | The members of the contract's owning teams who may see it, and the team's channel, when a test fails after one that did not ([DATA-CONTRACTS.md](DATA-CONTRACTS.md#notifications))                                                           |
| Undocumented access             | `access.undocumented`   | The owner of the reconciliation check, the users and teams it names, and the administrators, when changes without an access change entry are found ([COMPLIANCE.md](COMPLIANCE.md#access-reconciliation))                                    |
| Backup failed                   | `backup.failed`         | The administrators, when a backup or the weekly restore test fails ([BACKUPS.md](BACKUPS.md#the-restore-test))                                                                                                                               |
| Emergency access                | `security.emergency`    | The administrators, when someone signs in with emergency access from the server command line ([INSTALL.md](INSTALL.md#locked-out-of-single-sign-on))                                                                                         |
| Daily summary                   | `summary.daily`         | People who turned it on (below) – in-app and e-mail only, never Teams or webhooks                                                                                                                                                            |

## Notification policy of automated runs

A process that runs every few minutes and is expected to find failures (the Gatus uptime overview, where some endpoints are always down) should not fill mailboxes. Every **source that repeats runs** has one notification policy: a **schedule**, a **webhook trigger** and a **monitor output** that starts a process. Runs started by hand are not affected; a **sub-process** follows the source of its parent.

**Principles.** Runs are evidence: a policy never changes what is recorded – the run history, its checks, the start page, the daily summary, the scorecard and reports always show every result. It only decides who is interrupted, how and when. The process definition keeps only meaning: the severity of a check, `notify: false` for informational checks, and what its messages say (below). The policy belongs to the source, because the same process may run every 10 minutes in production and by hand while debugging.

**Layers** – each narrows what the one above allows:

1. the instance: channels on or off, and the routes per event (_Settings → Notifications_)
2. teams
3. the source's policy (this section)
4. personal: _E-mail notifications_ in the profile

### When

| Setting                                                                                 | What notifies                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **On change** (default for schedules)                                                   | A check that starts failing; the same check with another result; and – while it keeps failing – a reminder after _Reminder while still failing_ hours (default 4, `0` = none), with the time it started failing. |
| **After every run** (default for webhook triggers and monitor outputs, as before 0.2.4) | Every run in which a check fails (in the app every time; e-mail, Teams and webhook at most once an hour per process and check).                                                                                  |
| **Never**                                                                               | Nothing for failed checks; they are shown in the runs. Failed runs still notify.                                                                                                                                 |

_What counts as a change_ (on change): **a different message or severity** (default), or **only the start and end of failing** – one message when a check starts failing, the reminders, and the end. _Send a message when a check passes again_ adds **Passes again** for the first passing run.

- The state is kept per source and check (dry runs separately). Changing _when_ or _what counts as a change_ starts over: a check that still fails notifies again at the next run.
- With _a different message or severity_, keep values that change in every run (uptime percentages, timestamps) out of the message, or use `value` (below) – it says whether things got better or worse.
- A check step with `notify: false` (_Notify when the check fails: No_ in the editor) never notifies: an informational check, shown in the run.

### Where

**As configured** (default) uses the routes per event. **Only these channels** picks in the app, e-mail, Teams and webhook for this source; a channel the instance has turned off stays off. It applies to every message the source's runs cause: failed and resolved checks, failed runs and tasks waiting for a decision.

### Urgent

_Urgent – interrupts quiet hours_ (off by default) marks a source whose failures must reach people at night: failed runs and checks failing with severity `error` of this source break through [quiet hours](#quiet-hours-and-digests), with a footer that says why. A person or channel can still hold urgent messages (_Let urgent messages through_ off). The flag is part of the policy of schedules, webhook triggers and monitor process outputs, audited with it; monitor notification outputs and Teams outputs have the same switch for a change to _down_.

### Pause

_Schedules_ and _Webhook triggers_ → _Pause messages_: until a time or until resumed, with a reason, optionally still in the app. A badge on the source shows the end and the reason; runs and checks go on as usual. A pause ends on its own; when it ends while a check still fails, one **Still failing after the pause** message per check says so, so nothing is lost silently. Monitor outputs keep their pause in the monitor's definition. Audited as `schedule.paused` / `schedule.resumed` and `trigger.paused` / `trigger.resumed` (with the reason; an ended pause by `system`). API: `POST /api/schedules/{id}/pause` with `{ until, reason, inApp }`, `POST /api/schedules/{id}/resume`, the same for `/api/triggers/{id}`; `notify` is part of schedules and triggers in the API (`/api/v1` too) and of monitor process outputs.

**Example – the Gatus overview every 10 minutes:** _On change_, _Only the start and end of failing_, reminder every 24 hours, _Passes again_ on, channels as configured. The team gets one message when endpoints start failing, one reminder a day and one when all are healthy again; for a planned maintenance of the Gatus host, pause the messages until the end of the window.

## What the messages say

Every message about a failed check has the same structure in the app, by e-mail, in Teams and as webhook data: the **state first, then where** (_Warning · 11 of 58 endpoints down – Status (IntRAnet) /metrics_), one line on **what happened** (_Started failing_, _Got better: 12 → 11 · failing since …_, _Still failing (reminder)_, _Passes again_), a small table (process, who started it, severity, value, failing since), the **items** behind the failure, _Open runbook_ (only when one is set), _Open in Steward_, and a footer saying **why the reader got it** (_you own the schedule "Gatus overview"_) with a link to the source's message settings.

What a process adds is optional – a check without it still gets a clear message from what Steward knows. On a check step:

| Field      | Example                                                      | In the message                                                                           |
| ---------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `headline` | `{{ $count(vars.down) }} of {{ vars.total }} endpoints down` | The subject and title instead of the check name (the name stays in the table)            |
| `value`    | `$count(vars.down)`                                          | "11 (was 12) · better"; `betterWhen: higher` for values where more is better (days left) |
| `items`    | `vars.down.(group & '/' & endpoint)`                         | Bullets, the first 10, then "+ N more"                                                   |
| `runbook`  | `rec_…` or `https://…`                                       | _Open runbook_; the process can set a `runbook` for all its checks                       |

Without a value, better or worse follows the severity. An expression that fails only logs a warning in the run. The webhook body keeps its fields and adds `headline`, `value`, `previousValue`, `direction` (`better`, `worse`, `same`), `items`, `runbook` (null when none), `since` and `source` (`kind`, `id`, `name`). The Gatus overviews, the Insights Hub health check, the data freshness monitor and the tenant usage check use them.

### A monitor or a process check?

Use a **monitor** ([MONITORS.md](MONITORS.md)) for the state of something that should be up: it sends status changes, waits for several failures before _down_, knows dependencies and root causes, can be acknowledged and has maintenance windows. Use a **check in a scheduled process** for findings of a job – an access review, a data freshness sweep, an uptime overview with a report – where the run, its report and its dataset are the point, and the notification only says that something needs a look.

## E-mail addresses outside Steward

Plain addresses (credential owners, report recipients) only get e-mail when their domain is allowed: _Settings → Notifications → Allowed e-mail domains for addresses outside Steward_. An empty list means the domains of the Steward users' own addresses.

## Look of e-mails and Teams messages

_Settings → Look of e-mails and Teams messages_ (administrators) gives the messages Steward sends the company's name, colour and logo, like the web UI (_Appearance_) and the PDF reports (_Report branding_). Every field is optional: an empty field follows _Settings → Appearance_, so a Steward with its own app name and colour already sends messages in that look.

| Setting     | Used for                                                                                      | When empty                              |
| ----------- | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| Name        | The e-mail header, the subject prefix (`[Name] …`), the Teams card and the "Open in …" button | The Appearance app name, else "Steward" |
| Colour      | The e-mail header and button                                                                  | The Appearance primary colour           |
| Logo        | App logo (Appearance), report logo (Report branding), an own logo for messages, or none       | The app logo                            |
| Footer text | Small print at the bottom of every e-mail and Teams card                                      | No footer                               |

- **E-mails** (every notification, the daily summary, test messages) use one layout: a header bar in the colour with logo and name, a thin strip that shows how the message reads (red: something failed, orange: something to do, green: a monitor is up again, blue: information), the text, a button and the footer. It is built from tables and inline styles, so Outlook and web mail show it, and the plain-text part is kept.
- **The logo travels inside the e-mail** as an inline attachment (`cid:`). Mail clients block remote images, and Steward is usually not reachable from outside, so nothing is loaded from Steward. PNG and JPEG up to 512 KB; a WebP app logo is left out (many mail clients cannot show it) – upload a PNG or JPEG, or use the report logo.
- **Teams cards** carry the name, the footer and a coloured strip with the same meaning. Adaptive Cards only know named colours (`good`, `warning`, `attention`, `accent`), not the hex colour. The logo is embedded only up to 12 KB, because Teams refuses cards over 28 KB.
- **Generic webhooks** get the same JSON as before – or, with the format _Teams card_, the same Adaptive Card as the Teams channel, for a second Teams or Workflows target. Monitors can post to their own Teams channels as well ([MONITORS.md](MONITORS.md#webhook)).
- **Where webhooks and Teams messages may go**: the URL an administrator stores is not checked against the outbound policy, but it and every redirect must not be a cloud-metadata or link-local address or Steward's own API. At most 5 redirects are followed; a redirect to another host than the URL's must be allowed by the outbound policy (a configured platform or the allow-list, _Settings → Outbound access_), and a `307`/`308` to another host is refused when the message would carry the credential of the URL. _Send test_ shows the reason ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#which-rule-checks-which-call)).
- The card's **preview** shows the test message, or a failed dry run, as an e-mail and a Teams card with the unsaved settings. _Send test_ under _Notifications_ sends it with the saved ones. Changes are audited as `notifications.look_updated`; the setting moves with a [migration package](MIGRATION.md).

### Own logo

_Logo → Own logo_ takes a logo just for messages: PNG or JPEG (checked by the file's content), at most 512 KB. The app and the reports keep their logos. It is stored as `branding/notification-logo.png` (or `.jpg`) in the data folder, moves with a migration package, and uploading or removing it is audited (`notifications.logo_uploaded`, `notifications.logo_removed`). API (administrators): `GET`/`POST`/`DELETE /api/settings/notifications/look/logo` (multipart, or JSON `{ "contentBase64": "…" }`).

### Style

| Setting       | Choices                                                                             | Default     |
| ------------- | ----------------------------------------------------------------------------------- | ----------- |
| Logo size     | Small (20 px), medium (28 px), large (40 px)                                        | Medium      |
| Logo position | Left of the name, or centred above it                                               | Left        |
| Header        | Coloured, white with a line in the colour, or minimal (white with a thin grey line) | Coloured    |
| Button colour | Any hex colour; the text on it is white or dark, whichever reads better             | Header      |
| Corners       | Rounded or square                                                                   | Rounded     |
| Font          | System font, Arial/Helvetica, or a serif (Georgia) – fonts every mail client has    | System font |

The defaults are the look of 0.2.1. E-mails follow every setting. **Teams cards** only take the logo's size (20, 24 or 32 px) and position: Adaptive Cards have no fonts, header styles or button colours, Teams draws them itself.

### Dry runs

A dry run is a test: read calls are real, writes are only recorded. When one fails (or a check in it fails), the notification must not read like an outage.

- **E-mail:** the subject reads `[Name] Dry run – Run failed: …` (German: `Probelauf – …`), a grey banner on top says _Dry run – a test, nothing was changed. No action needed._, and the strip is grey instead of red. The text part starts with the same sentence.
- **Teams:** the same sentence under the header, and a grey (`emphasis`) card style.
- **In the app:** the title starts with _Dry run –_.
- **Tasks of a dry run** (a decision, a manual step to verify, a step sent back) are marked the same way: _Dry run – Decision needed: …_. The task itself is a normal task – the dry run waits for it – only the message says it is a test.
- **Webhooks:** unchanged; `data.dryRun` is `true`, as before.

_Dry runs_ in the same card chooses where these go: **e-mail, Teams and webhook, marked as a test** (default), or **only in the app**. Real runs are not affected.

## Daily summary

Once a day, a short summary of what concerns you. It is **off by default**; turn it on in your profile under _Daily summary_.

**What it contains** – only what you may see, collected with your rights:

- runs since the last summary and the failed ones (processes you may view);
- open tasks and approvals you may decide;
- status changes of monitors you may view (root causes in monitors you may not view are shown as "a monitor you cannot view");
- credentials due soon, overdue or expired that you may see;
- open ticket references you are responsible for (directly or through a team);
- documents waiting for your approval, and documents you own that changed their status;
- reviews of living documents you review that are due soon or overdue;
- service duties you are responsible for that are due soon, and periods missed or failed since the last summary ([DUTIES.md](DUTIES.md));
- scheduled reports you receive that were generated since the last summary;
- **trends** of dataset metrics you may see: limits and floors the trend reaches within 30 days (soonest first), then metrics that changed by 10 % or more in 7 days with a stable trend ([trends and forecasts](DASHBOARDS.md#how-the-trend-is-computed)). People who had every section selected get a new section; a chosen subset stays as it was (also a section you left out after it was added).
- **new Kafka topics** under prefixes kept in sync of applications you may change ([KAFKA.md](KAFKA.md#add-topics-by-prefix)).

**Team default.** A team can set a daily summary for its members (_Users → Teams_ → settings → _Daily summary_). Members who have not saved their own settings get it – the profile card says _Default of team …_; with several teams, the first by name that sets one applies. Saving in the profile makes the settings your own (they always win), and _Back to the default_ removes them again.

You choose the sections, the time of day and your time zone, the days (Monday to Friday, every day, or **once a week** on a chosen day), and whether it comes in the app only or also by e-mail. With _Send nothing on days without anything to report_ you get nothing on quiet days. **Preview** shows what it would contain right now, without sending anything.

**E-mail** is sent only when e-mail is set up (SMTP), the event _Daily summary_ is routed to e-mail in _Settings → Notifications_, you turned on e-mail notifications, and your address's domain is allowed (see above). The profile card says why when one of these is missing. The e-mail has a compact HTML part and a plain text part, in your language, with links into Steward (`SM_PUBLIC_URL` or the base URL in the notification settings).

**Administrators** see under _Settings → Daily summaries_ who receives one, when and how – never the content – and can switch daily summaries off for everyone. Every change of the settings is in the audit log.

**When it is sent.** The notification job checks every five minutes. A summary is due once your local time passes the chosen time on a chosen day; if Steward was down at that time, it is sent within the next six hours, otherwise that day is skipped. Each person and local day is recorded before anything is sent, so a summary goes out at most once a day, also after a restart. "Since the last summary" means since the last one that was due (at most seven days back). While the vault is locked, summaries that include e-mail wait until it is unlocked.

**One instance.** Steward assumes one server process per database. The once-a-day record is a database key, so two instances would still not send the same summary twice, but both would run the job.

## Quiet hours and digests

The design is in [ADR 0012](adr/0012-quiet-hours-and-digests.md). **Quiet hours decide when** an interrupting message reaches you – never whether. **Nothing is dropped**: what arrives during quiet hours waits and comes as **one catch-up message** when they end; the app shows everything at once, always. Runs, checks, the audit log, reports and the daily summary are not affected.

**Order.** The pause of a source, maintenance windows, a monitor's quiet reasons and the dry-run setting decide first whether a message goes out at all (as before). Quiet hours and digests then decide when.

**What is held.** E-mail to a person, and posts in Teams format: the instance Teams channel, the instance webhook in format _Teams card_, a team's channel in Teams format and monitor outputs in Teams format. **JSON webhooks are never held** – they feed tickets and on-call tools that have their own rules. Steward does not escalate and has no on-call rota: point an on-call tool at a JSON webhook for paging.

**Setting them.** _Profile → Quiet hours and digests_: on/off, the time zone ([IANA](https://www.iana.org/time-zones) name, prefilled from the browser), up to 14 times (days + from/until), whole days, and _Let urgent messages through_. A time whose end is not after its start runs past midnight and belongs to its start day: _weekdays 18:00–07:30_ is Monday 18:00 to Tuesday 07:30 … Friday 18:00 to Saturday 07:30; with Saturday and Sunday as whole days the weekend joins up to Monday 07:30. A week grid shows the result.

- **Team default**: a team can set quiet hours and digests for its members (_Users → Teams_ → settings → _Quiet hours_, with the step-up _change notification delivery_ for the quiet hours), like the daily summary; the first team by name that sets one applies; _Back to the default_ removes your own.
- **Channels**: the instance channels under _Settings → Notifications_ (Teams, and the webhook in Teams format), a team channel in Teams format in its team settings, a monitor output in Teams format in the monitor editor. Changing the quiet hours of the instance channels or of a team channel needs the step-up _change notification delivery_ and is audited (`notification.quiet_hours_changed`).
- **Administrators** can switch quiet hours and digests off for everyone and see who uses them and how many messages wait – never the content (_Settings → Notifications → Quiet hours and digests_; held messages go out at the next tick). Audited as `notification.quiet_hours_switch`.

**Time and daylight saving.** Quiet hours are evaluated on the local wall clock each time a message arrives and every five minutes – never stored as an instant. On the night the clocks go forward they are shorter in real time; an end time that does not exist that night ends at the first minute after the gap. On the night they go back they are longer; an end time that occurs twice ends at its first occurrence. Tested for Europe/Berlin, America/New_York and Australia/Lord_Howe (a 30-minute shift).

**What breaks through** (sent at once, with a footer such as _Sent during your quiet hours: this request expires at 03:10_):

- **emergency access** (`security.emergency`) – always;
- a **decision that expires** inside the quiet hours or within an hour after them (today: AI requests). For a decision several people may take, it is held for someone in quiet hours **while another eligible decider is reachable**; when nobody is, it breaks through for everybody. Decision steps of processes have no deadline and are held;
- messages of an **urgent source** (see [Urgent](#urgent)), unless _Let urgent messages through_ is off.

**The catch-up message** goes out at the first check after the quiet hours end: _While you were away: 2 decisions waiting, 3 checks still failing_. Groups, most important first: _Decisions waiting for you_, _Still failing_, _Failed and passed again_, _Other_. Repeats of the same thing are one item with its start and latest state (a check that failed at 02:10 and passed at 05:40 is one item); "still failing" is the state at release. A decision someone else took meanwhile is left out and counted. When your daily summary e-mail is due within 60 minutes after the quiet hours end, the catch-up becomes its first section, _While you were away_, instead of a separate e-mail. Channels get the catch-up as one card.

**Digests** (e-mail only): per event group – _Decisions_, _Runs and checks_, _Monitors and platforms_, _Reminders_, _Reports and releases_, _Budgets and costs_ – _immediately_ (default), _hourly_, _daily_ at a time or _weekly_ on a day and time. Decisions are immediately or hourly only (a run waits). Emergency access and urgent sources are never digested; an expiring decision breaks through a digest like it breaks through quiet hours. A digest due inside quiet hours is not sent; the catch-up takes its items. Digests are _the messages you would have got_; the daily summary stays _an overview of the state_.

**Rights at release.** A held message goes out only when the person is still active, still has e-mail on and an allowed address, and may still see what the item is about – the process of a run, and every kind of resource (platform, monitor, credential, document, service, application, system, ticket …) with the access decision of its page; a plant change set to review while they may still see it and it still waits (one decided meanwhile is counted as decided by others). Items that fail are left out (logged); the in-app copy is unaffected. Released messages use the same send path as immediate ones.

**Limits and storage.** Held messages are kept in `notification_outbox` as the rendered text in the target's language – never a channel URL or a secret. At most 500 open items per target; beyond that the oldest of the same event (else of another event) are folded into a count – a decision waiting for someone is never folded. Released items are deleted after 7 days by the cleanup. Each catch-up or digest is claimed per target and period before it is sent (`notification_digest_sends`), so it goes out at most once, also after a restart. While the vault is locked nothing is released. The bell shows _Quiet hours until 07:30 · 4 messages held_.

API: `GET`/`PUT`/`DELETE /api/me/notification-prefs`; administrators `GET`/`PUT /api/settings/quiet-hours`; the team settings (`quietHours`, `digests`, `channel.quietHours`) and `/api/settings/notifications` (`teams.quietHours`, `webhook.quietHours`) take the fields above.

## Decisions from Microsoft Teams

The design is in [ADR 0013](adr/0013-teams-approvals.md), the set-up in [TEAMS-APPROVALS.md](TEAMS-APPROVALS.md). Plant change sets (`plant.change_proposed`) are decided in Steward only – a card cannot show a field-by-field change ([ADR 0020](adr/0020-plant-change-sets.md)) – so their card is a plain message with a link and only who wrote it. Cards about decisions (`task.assigned`, `mcp.request`) show what is decided – process and step, platform, the change as `METHOD path_template`, who asked, since when, the expiry – and never a request body, run inputs or values. **Approve** and **Reject** open the decision in Steward with that choice pre-selected (`/runs/<run>?task=<task>&decide=approve`, `/mcp-requests/<id>?decide=reject`); nothing is decided until you confirm there. Select decisions, manual steps, verifications and proposals only get _Open_. When the decision is made (in Steward or in Teams), the run is cancelled or the request expires, a short **follow-up card** goes to the channels the card went to. E-mails carry the same facts and links. With the optional **Teams bot** (a preview, a second administrator approves it), people can decide in the card itself – decision steps by default, AI requests only when the assurance policy allows it.
