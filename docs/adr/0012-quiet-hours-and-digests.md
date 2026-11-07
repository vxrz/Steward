# 0012. Quiet hours and digests for notifications

- **Status:** Accepted
- **Date:** 2026-11-07
- **Since:** 0.10.0 (#236), planned in steps (below)

## Context

People get e-mails and Teams posts at night and at weekends for things that can wait. Others get twenty small messages where one would do. The issue asks for quiet hours (nothing at night unless it is critical) and digests (many messages become one), without losing anything and without changing the evidence.

What the code does today:

- **One delivery function.** `notify()` in `server/src/notifications/service.ts` takes a `Notice` (event, recipients, text per language, `inAppKey`, `externalKey`, `source`, `runId`, `about`). It picks the channels from the routes per event (`notifications.config` → `routes`, `notifications/settings.ts`) or from the source's policy, stores the in-app entry (`addInApp`, table `notifications`) and sends e-mail (`queueEmail`, `notifications/email.ts`), Teams (`sendTeams`) and webhooks (`sendWebhook`) in the background. Nothing is stored for later: a message is sent now or never.
- **Teams is always a channel post.** Teams messages go to an incoming-webhook or Workflows URL: the instance channel (`teamsWebhookUrl` in the vault blob `notifications.secrets`), the instance webhook in the format _Teams card_, a team's own channel (`team_settings.channel` and `channel_secret`, `notifications/team-channels.ts`) and monitor webhook outputs in Teams format (`sendTeamsCards`, `monitors/outputs.ts`). **There is no Teams message to one person.** That needs the bot of ADR [0013](0013-teams-approvals.md).
- **De-duplication.** `claimSend()` (`notifications/store.ts`, table `notification_sends`) allows one external send per channel, event and entity per hour (`DEDUPE_WINDOW_MS`). A message held for later must not claim this window when it is held, or its later send would be swallowed.
- **What already keeps messages back** – all of these suppress (nothing goes out, the app keeps it), none of them defers:
  - the **pause** of a schedule or webhook trigger (`notify_pause`, `pauseActive()`), with one _Still failing after the pause_ message per failing check when it ends (`notifications/pause.ts` `checkPauseEnds`, table `notify_pause_ends`);
  - **maintenance windows** with _pause messages_ on the run's platforms (`maintenancePausesRun()` in `catalogue/maintenance.ts`, hooked in with `setMaintenancePause`);
  - **monitor outputs**: `dispatchOutputs()` records quiet reasons (maintenance window, acknowledged, caused by a failing parent, first status) and sends nothing;
  - **dry runs** with _only in the app_ (`dryRunDelivery()`).
- **The source's notification policy** (#139, `shared/src/notifyPolicy.ts`): mode (on change, after every run, never), reminders, _passes again_, channels, pause. It belongs to the source (schedule, webhook trigger, monitor output), not to the process.
- **The daily summary** (`notifications/summary.ts`): per person, off by default, with a team default (`team_settings.defaults.summary`, `teamDefaults()`). It has its own time zone, time, days (`weekdays` | `everyday`), sections and channel (in-app or in-app and e-mail). `localClock()` turns a time and an IANA zone into a local day, weekday and minute. The job `daily-summary` (`jobs/builtin.ts`) claims one row per person and local day in `daily_summary_sends` before sending. It is never sent to Teams or webhooks (the content is personal).
- **Urgency is not modelled.** Check severities are `error`, `warning` and `info`, and `error` is the default (`engine/runner.ts`). There is no _critical_ severity and no _critical process_ flag. Services have a criticality in the catalogue (`SERVICE_CRITICALITIES`). A monitor check's `critical` flag means "a failure makes the monitor down", not "wake people up".
- **No on-call rota.** Service duties (`server/src/duties/`) are periodic tasks with owners. The issue's "service duties the person is on call for" has nothing to attach to.
- **Deadlines are rare.** Decision steps (`userTask` in `shared/src/process.ts`) have no deadline. Things that do expire: MCP requests (24 hours, `MCP_REQUEST_LIMITS.expiryHours`, `expireRequests()`), MCP proposals (days), pending assurance policy changes (7 days) and – planned in ADR [0009](0009-platform-identities.md) step 4 – the start approval of privileged runs (24 hours).
- **Jobs** run every five minutes (`NOTIFY_INTERVAL`, `every5` in `jobs/builtin.ts`). One Steward instance per database is assumed (ADR [0002](0002-single-active-instance-with-lease-lock.md)).

## Decision

### Principles

1. **Hold, never drop.** A message held back reaches its target later, in a catch-up message or a digest. Quiet hours only decide _when_.
2. **The app is not affected.** In-app notifications arrive at once, always. Quiet hours and digests apply only to channels that interrupt: e-mail and Teams.
3. **Runs are evidence.** Nothing about what is recorded changes: runs, checks, the audit log, the start page, reports and the daily summary stay as they are.
4. **Suppression first, then deferral.** The pause, maintenance windows, the monitor's quiet reasons and the dry-run setting decide first whether a message goes out at all – as today. Quiet hours and digests then decide when it goes out. A maintenance window that suppresses a message is not undone by quiet hours.
5. **Machines are never held.** JSON webhooks (the instance webhook in JSON format, team channels in format `json`, monitor webhook outputs in JSON, Gatus, Zabbix and process outputs) are delivered at once. They feed tickets, on-call tools and other systems that have their own rules.

### Terms

- **Target**: one place an interrupting message goes. A person's e-mail (`email:<userId>`), the instance Teams channel (`teams:instance`), the instance webhook in Teams format (`webhook:instance`), a team channel in Teams format (`team:<teamId>`), a monitor output in Teams format (`output:<monitorId>:<outputId>`), and later a person's Teams chat with the bot (`teamsChat:<userId>`, ADR 0013).
- **Quiet hours**: times when a target is not interrupted.
- **Held message**: a message kept in the outbox for a target until its quiet hours end or its digest is due.
- **Catch-up message**: the one message per target at the end of its quiet hours.
- **Digest**: messages of chosen events, collected and sent in a rhythm (hourly, daily, weekly).

### Where it sits in the code

`notify()` keeps its first steps (channels, pause, maintenance, in-app). For each external target it then asks a new function, `deliveryPlan(target, notice, now)` in `notifications/quiet.ts`. The answer is _send now_ (today's path, unchanged) or _hold_ with a reason (`quiet`, `hourly`, `daily`, `weekly`). A held message goes to `holdMessage()` in `notifications/outbox.ts`. `claimSend()` is called when the message is released, not when it is held.

Monitor `notification` outputs already go through `notify()`. Monitor webhook outputs in Teams format (`sendTeamsCards`) ask `deliveryPlan` with their own target.

### Quiet hours: the setting

```ts
interface QuietHours {
  enabled: boolean;
  timeZone: string; // IANA, e.g. Europe/Berlin
  windows: { days: Weekday[]; from: 'HH:MM'; to: 'HH:MM' }[]; // at most 14
  allDay: Weekday[]; // e.g. ['sat', 'sun']
  urgentBreaksThrough: boolean; // default true (below)
}
```

- A window whose `to` is not after its `from` crosses midnight and belongs to its start day. _Weekdays 18:00–07:30_ means Monday 18:00 to Tuesday 07:30, …, Friday 18:00 to Saturday 07:30. With Saturday and Sunday all day, the weekend joins up to Monday 07:30.
- **Per person** in the profile (_Notifications → Quiet hours_). **Team default** in the team settings, like the daily summary: members who have not saved their own settings get it, from the first team by name that sets one. The profile says _Default of team …_; _Back to the default_ removes the own settings.
- **Per channel target**: the instance Teams channel and the instance webhook in Teams format (_Settings → Notifications_), each team channel in Teams format (team settings), and monitor outputs in Teams format (the output's settings). The issue says "on the route". Routes are per event, so the setting would be repeated for every event. It belongs to the target.
- **Time zone**: an IANA name, validated like `prefsSchema` does. The profile pre-fills it from the person's daily summary, else from the browser.
- Holiday calendars are not part of this decision.

### Time and daylight saving

- `localClock()` moves from `summary.ts` to `notifications/clock.ts` and is shared.
- "Is this target in quiet hours now?" is answered from the **local wall clock** each time a message arrives and at each job tick. Steward never computes and stores the end as an instant.
- On the night the clocks go forward, quiet hours are one hour shorter in real time. On the night they go back, they are one hour longer. An end time that does not exist that day (a gap) ends at the first minute after the gap. An end time that occurs twice ends at its first occurrence.
- Tests on SQLite and PostgreSQL cover `Europe/Berlin`, `America/New_York` and `Australia/Lord_Howe` (30-minute shift), windows across midnight, across the weekend and across both switch nights.

### What breaks through

A message that breaks through is sent at once, even in quiet hours. Its footer (`parts.reason`) says why, e.g. _Sent during your quiet hours: this request expires at 03:10_.

**Always, cannot be turned off:**

- `security.emergency` (someone used emergency access).
- A **decision that expires** inside the target's quiet hours or within one hour after their end. Today that is an MCP request; later the start approval of ADR 0009. Process decision steps have no deadline, so they are held (decision 2 below).

**By default, and the person or channel can turn it off (`urgentBreaksThrough`):**

- Messages from an **urgent source**: a source whose notification policy is marked _Urgent – interrupts quiet hours_ (decision 1 below).

A message that broke through is not repeated in the catch-up message.

### The outbox

New table (named migration `notifications-002-quiet-hours`):

```sql
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,                  -- nob_…
  target TEXT NOT NULL,                 -- email:<userId> | teams:instance | webhook:instance | team:<teamId> | output:… | teamsChat:<userId>
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,  -- for personal targets
  item_key TEXT NOT NULL,               -- event + externalKey: repeats of the same thing collapse into one row
  event TEXT NOT NULL,
  reason TEXT NOT NULL,                 -- quiet | hourly | daily | weekly
  locale TEXT NOT NULL,
  states TEXT NOT NULL,                 -- JSON [{ ts, title, lead, tone, link }]: the first and the last four
  about TEXT,                           -- JSON { kind, id } or { runId }: checked again at release
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  released_at TEXT                      -- set in the claim, before sending
);
CREATE UNIQUE INDEX notification_outbox_open ON notification_outbox(target, item_key, reason) WHERE released_at IS NULL;
```

- It stores the **rendered text** in the target's language – the same text the message would have had. It never stores a channel URL or a secret: the target is an id, and the URL is read from the vault at release.
- **Collapsing**: a second message for the same `item_key` adds a state to the open row. A check that failed at 02:10 and passed again at 05:40 is one item with both states.
- **Rights at release**: the person must still be active, still have e-mail on, and their address must still be allowed (`domainAllowed`). They must still be allowed to see what the item is about (`about`: the process of a run, the monitor, the resource with its owning teams, ADR [0006](0006-owning-teams-policy-module.md)). An item that fails is left out and logged. The in-app copy, made at the time, is unaffected.
- **Limits**: at most 500 open rows per target. Beyond that, the oldest rows of the same event are folded into a count (_+ 120 more failed checks_). Released rows are deleted after 7 days by the cleanup.
- **Vault locked**: release waits until it is unlocked, as daily summaries do.
- **Migration packages** (`migration/tables.ts`): `notification_outbox` is `NOT_MOVED` (short-lived; another instance must not send this one's messages). The settings tables are `MOVED`.

### The catch-up message

- A new job `notification-outbox` runs every five minutes. At the first tick after a target's quiet hours end, it sends **one message** with everything held for `quiet`.
- Grouped, most important first: _Decisions waiting for you_, _Still failing_, _Failed and passed again_, _Other_ (by event). Each item appears once, with when it started and its latest state, and a link.
- "Still failing" is the **current** state: for checks, `failingChecks(source)` (`engine/check-alerts.ts`) at release, as `reportPauseEnd()` does after a pause.
- A decision that someone else took in the meantime is left out. The message counts them (_3 decided by others meanwhile_).
- Title: _While you were away: 2 decisions waiting, 3 checks still failing_.
- **Claimed before sending**: one row per target and period in `notification_digest_sends (target, period, ts, outcome)`, primary key `(target, period)`, like `daily_summary_sends`. So the message goes out at most once, also after a restart.
- Nothing held → nothing sent.
- **Next to the daily summary**: when the person's daily summary is due within 60 minutes after their quiet hours end, the catch-up becomes the summary's first section, _While you were away_, instead of a separate e-mail. The daily summary itself is never held: the person chose its time.
- Channel targets get the catch-up as one Teams card with the same groups.

### Digests

- A person chooses, per **event group** (decision 3 below), a rhythm for e-mail: _immediately_ (default, as today), _hourly_, _daily_ at a chosen time, or _weekly_ on a chosen day and time.
- Channel targets have quiet hours, but **no digests** in this release. A noisy source is tamed with its own notification policy (#139).
- **Limits on decisions**: decision events (`task.assigned`, `mcp.request`, `duty.exception`) can be _immediately_ or _hourly_, never daily or weekly – a run is waiting. An expiring decision breaks through a digest like it breaks through quiet hours.
- Never digested: `security.emergency` and messages from urgent sources.
- Digest items collapse like catch-up items. A digest due inside quiet hours is not sent; the catch-up takes its items.
- **Digests and the daily summary** stay separate things. A digest is _the messages you would have got_. The summary is _an overview of the state_, collected with your rights. The summary gains **weekly** (`days: 'weekly'` with a `weekday`); its sections can already be chosen.

### Data, API, audit

- `notification_prefs (user_id PRIMARY KEY REFERENCES users ON DELETE CASCADE, prefs TEXT, updated_at TEXT)`: quiet hours and digests of a person.
- Team defaults: `team_settings.defaults` gains `quietHours` and `digests`, next to `summary`.
- Channel quiet hours: `notifications.config` gains `teams.quietHours` and `webhook.quietHours`; `team_settings.channel` gains `quietHours`; monitor outputs in Teams format gain `quietHours` in the definition.
- API: `GET`, `PUT`, `DELETE /api/me/notification-prefs`; the team settings and `/api/settings/notifications` bodies gain the fields above.
- **Administrators** can switch quiet hours and digests off for everyone (like `setSummariesAllowed`) and see who uses them and how – never the content.
- **Audit**: `notification.quiet_hours_changed` (person, team or channel; old and new value), `notification.digests_changed`, `notification.quiet_hours_switch`. The release of held messages is logged, not audited, like every other send.
- **Step-up**: changing the quiet hours of a channel target changes where messages go. It uses the existing `changeNotificationDelivery` step-up (`changesNotificationDelivery`, `changesTeamChannel` in `auth/step-up-rules.ts`). A person's own settings need no step-up.

### Security and privacy

- **Nothing can be hidden with quiet hours.** The app gets everything at once. `security.emergency` always goes out. Channel quiet hours need a step-up and are audited. Administrators see who uses quiet hours.
- **The outbox holds message texts**, the same as the `notifications` table. No secrets, no channel URLs. Personal rows are deleted with the person (`ON DELETE CASCADE`). [PRIVACY.md](../PRIVACY.md) lists the new data.
- **Rights are checked again at release** (above), so a person who lost access does not get the item hours later.
- **The send path does not change.** Released messages go through `queueEmail` (with the domain check) and `postJson` (address safety and the redirect rules of 0.9.0) exactly like immediate ones.
- **Bounded growth**: 500 open rows per target, 7 days of released rows.

## UI outline

- **Profile → Notifications**: _Quiet hours_ (on/off, time zone, a week grid with the windows, _Let urgent messages through_) and _Digests_ (one row per event group: immediately, hourly, daily, weekly). A line shows the effective source (own, team default).
- **Bell**: during quiet hours a small line, _Quiet hours until 07:30 · 4 messages held_.
- **Team settings**: defaults for members; for a team channel in Teams format, its quiet hours.
- **Settings → Notifications**: quiet hours of the instance channels; the switch for everyone; the list of who uses them.
- **Message footer**: _Sent during your quiet hours because …_ when a message broke through.

## Alternatives considered

- **Drop messages during quiet hours (do not disturb).** Simple, but information is lost. The issue and the pause both say: nothing is lost silently.
- **Leave it to the clients.** Teams on phones has its own quiet times, and mail clients have rules. But channel posts reach everyone, clients cannot know what is urgent, and desktop mail has nothing comparable. Steward knows urgency and expiry.
- **Quiet hours on the source only.** The pause already does this per source. Quiet hours are about people and channels.
- **Quiet hours per route (event).** Repeats one setting for each of about 30 events. Hard to understand.
- **Reuse `notification_sends`.** It stores only a time per key, no content, and cannot release anything.

## Consequences

**Positive**

- Fewer interruptions at night and at weekends, without losing a message.
- One outbox serves both quiet hours and digests, with one release path and one claim table.
- Decisions that would expire still reach someone.

**Negative**

- Messages are no longer "sent now or never": a new table, a new job, and texts that wait hours. Support questions ("why did I get this at 07:30?") – the footer and the bell answer them.
- Rights are checked twice (when held and at release), which adds code and tests.
- People in quiet hours may react later to failures. That is the point, but teams must mark what is urgent.

**Risks**

- **Time zone and daylight-saving bugs.** Mitigation: wall-clock evaluation only, no stored instants, the test matrix above on both databases.
- **Too much breaks through, or too little.** Mitigation: a narrow default (decision 1: only sources marked urgent), the footer says why, and the admin view shows who uses what.
- **A large backlog after a long weekend.** Mitigation: collapsing per item, current state at release, the 500-row limit with counts.

### Migration and rollout plan

Each step is its own PR. Nothing changes until someone turns quiet hours on.

1. **Outbox and personal quiet hours.** `quiet.ts`, `outbox.ts`, `clock.ts`, the tables, `deliveryPlan` in `notify()`, quiet hours for e-mail with team defaults, the fixed break-throughs, the catch-up message, the admin switch and view, audit, the profile card.
2. **Channel quiet hours and urgent sources.** Instance channels, team channels and monitor outputs in Teams format; the urgent flag on the notification policy (decision 1).
3. **Digests.** Event groups and rhythms, the digest job, the weekly daily summary.
4. **Teams chat target.** `teamsChat:<userId>` once ADR 0013 stage 2 sends personal Teams messages.

Each step: tests on SQLite and PostgreSQL (time zones, daylight saving), e2e on desktop and phone with axe, [NOTIFICATIONS.md](../NOTIFICATIONS.md).

## Changed while building

1. The migration `notifications-002-quiet-hours` also adds `notify_urgent` to `schedules` and `webhook_triggers` (the urgent flag of their notification policy; monitor process outputs keep it in the definition).
2. Monitor notification outputs and outputs in Teams format have no notification policy: they got their own _Urgent_ switch (a change to _down_ breaks through).
3. The quiet hours (and the urgent switch) of a monitor output in Teams format are part of the monitor definition: changed with the monitor's edit right and audited with the monitor, without the step-up of the instance and team channels.
4. A team default sets quiet hours and digests together: the first team by name that sets either gives both.
5. A target that can no longer receive at release (its channel switched off or removed, the person's e-mail turned off) gets nothing; the held items are dropped with a log entry – the in-app copies stay. Visibility at release is checked for runs, processes, platforms and monitors; other items rely on the recipients chosen when they were held.
6. All four rollout steps landed in 0.10.0 together, the `teamsChat:<userId>` target with the Teams bot of ADR 0013.

## Decided after review

1. **What counts as urgent, so it breaks through quiet hours?** Decided: a flag on the source's notification policy, _Urgent – interrupts quiet hours_, on schedules, webhook triggers and monitor outputs. Failed runs and checks failing with severity `error` of such a source break through; the flag is visible on the source and audited with it.
2. **Decisions for several people, when some of them are in quiet hours?** Decided: hold while another eligible decider is outside their quiet hours. When nobody is reachable and the decision expires inside the quiet hours (or within an hour after), it breaks through for everybody. An optional deadline on process decision steps stays a separate issue.
3. **How fine are the digest choices?** Decided: per event group (about six: decisions, runs and checks, monitors, reminders, reports and releases, budgets and costs), e-mail only. A new event joins a group.
4. **Does Steward escalate when nobody reacts?** Decided: no escalation and no on-call rota in Steward. JSON webhooks are never held, so an on-call tool can page people with its own rota.
