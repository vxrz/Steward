# Service duties

A _duty_ is a recurring task a service must or should have done: an access review every quarter, a restore test every month, a firmware check every week. Schedules run processes regularly, but only a duty says which runs a service **needs** – so a missed or failed mandatory task shows up instead of going unnoticed.

- [What a duty is](#what-a-duty-is)
- [Define a duty](#define-a-duty)
- [Periods and time zone](#periods-and-time-zone)
- [Period status](#period-status)
- [Which runs count](#which-runs-count)
- [Exceptions: skipped for this period](#exceptions-skipped-for-this-period)
- [Stored history](#stored-history)
- [Where you see duties](#where-you-see-duties)
- [Reminders and missed periods](#reminders-and-missed-periods)
- [Who may do what](#who-may-do-what)
- [Audit, API, reports, migration](#audit-api-reports-migration)

## What a duty is

A duty belongs to a service and, if you like, to one of the service's applications ([APPLICATIONS.md](APPLICATIONS.md)). It has:

- a **process** – the real runs of this process do the duty;
- an **interval** – weekly, monthly, quarterly, half-yearly or yearly;
- a **level** – mandatory, recommended or optional;
- an optional **grace period** – days into the next period in which a run may still end, or a late run start (0–90);
- a **reminder** – days before the end of a period (default 5, 0 = none);
- optional **owners** – `user:<name>` or `team:<name>`. Without owners, the owners of the service are responsible.

A duty can name the **schedule** that runs it. It does not need one: many procedures are started by people (a manual restore test, a process with manual steps). The schedule is shown on the duty page with its next run, and a warning when it is disabled or makes dry runs (they do not count).

## Define a duty

1. Open the service: _Service management → Services → (service)_.
2. In _Duties_, choose _Add duty_.
3. Enter a name, choose the process, the interval and the level. Add a grace period, the reminder days, the owners, the application and the schedule if you like.
4. _Save_. The duty shows its current period, normally _Due_.

_Edit_ (pencil) changes a duty. A change of the process, the interval, the grace period or the level changes how the duty is judged, so the open periods are closed first, under the old rules:

- Every period that has ended – also one still in its grace period – is closed as it stands: done or late with a run that counts, skipped with an approved exception, else failed or missed (_closed early: the duty changed_).
- The **current period**: if it is done, late or skipped already, it is closed with that status, and the new rules start when it ends. Otherwise it is closed at the moment of the change as **ended without a run** – it counts as not met, like missed (start page, daily summary, report, scorecard), but sends no "missed" message. Its stored end is the moment of the change, and it is stored under the period's key with a suffix (`2026-10~1`); the rest of the period, under the new rules, keeps the plain key (`2026-10`) – the API shows both, the UI shows `2026-10`. For a mandatory or recommended duty, the duty's and the service's owners get a message, _Duty period ended without a run_ – not the person who made the change. The edit dialog says so before you save.
- The **new rules start at the change**: the first period under them runs from the change to the end of the period (of the new interval) that contains it. Only runs started after the change count; nothing before it is judged again under the new rules – switching from yearly to monthly does not judge the past months of the year.

A change that **only makes the duty stricter** – a higher level (optional → recommended → mandatory), a shorter grace period, or both, with no other change of how it is judged – applies to the current period directly: it stays open, now judged by the stricter rules (a shorter grace period moves its grace end), and the new rules start nothing anew. Periods that have ended are still closed first, with the old grace period. A lower level, a longer grace period, another process or another interval end the current period as described above.

A duty is archived, not deleted: _Archive_ on the duty page. Archiving closes the open periods the same way (_duty archived_; the confirmation says when the current period will be recorded as ended without a run). _Restore_ starts again at the moment of the restore, with a partial first period. Periods that lay entirely inside the archive window are stored as **inactive**.

## Periods and time zone

Periods are calendar periods in the **time zone of the server** (the `TZ` environment variable; _System status_ shows it):

| Interval    | Period                           | Key        |
| ----------- | -------------------------------- | ---------- |
| Weekly      | ISO week, Monday 00:00 to Sunday | `2026-W44` |
| Monthly     | Calendar month                   | `2026-10`  |
| Quarterly   | January–March, April–June, …     | `2026-Q4`  |
| Half-yearly | January–June, July–December      | `2026-H2`  |
| Yearly      | Calendar year                    | `2026`     |

A period starts and ends at local midnight, so the change to and from daylight saving time is handled: the week of the change simply has an hour more or less. A grace period counts calendar days after the end of the period.

The first period of a new duty is the current one. Only runs started after you defined the duty count for it – a restore test done on the 3rd does not count for a duty you define on the 20th.

## Period status

| Status       | Meaning                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| **Due**      | The period (or its grace period) is not over, and nothing counts yet                                           |
| **Done**     | A successful run started in the period and ended by the end of the grace period                                |
| **Late**     | Done, but by a run that started in the grace period                                                            |
| **Skipped**  | An exception approved by a second person (see below), and no run did it                                        |
| **Failed**   | The period ended with runs, but only failed ones: failed, interrupted, or rejected at an approval step         |
| **Missed**   | The period ended without any run that counts                                                                   |
| **Inactive** | The duty was archived during the whole period: not judged                                                      |
| **Ended**    | Ended without a run: the duty was archived or its rules changed before anything counted – not met, like missed |

While a period is open, failed runs are shown as "1 failed run" next to _Due_ – you can still try again. A period is judged in this order: done, late, skipped, failed, missed. A run done in the period always wins over an exception.

## Which runs count

- **Real runs of the duty's process** – started by anyone, by a schedule or by a webhook trigger, of any version of the process.
- **Dry runs never count.** They change nothing on the platforms.
- **Runs of other processes never count**, also not a copy of the process.
- **Cancelled runs are ignored** – someone stopped them on purpose. Interrupted runs count as failed.
- **A run that succeeds through the "rejected" branch of an approval** is not the duty done: it counts as failed.
- **Runs that wait for a person** – an approval, or a manual step that someone has to verify – count once they end, by their final status. A run still waiting when the grace period ends does not count.
- A run belongs to the period it **started** in, and it counts for **one period only**: the run that makes October late does not also make November done.

## Exceptions: skipped for this period

Sometimes a duty cannot or need not be done in a period – the system is being replaced, the restore test is replaced by a full disaster recovery exercise. Ask for an exception:

1. On the service page, choose the calendar icon of the duty (or _Ask for an exception_ on the duty page).
2. Choose the period – the current one, the last one while it is in its grace period, or one of the next three – and write the reason. Exceptions reach at most three periods ahead; the duty shows how many are planned ahead (_N exceptions planned ahead_).
3. _Ask_. The exception waits for a second person.

A **second person** approves or rejects it on the duty page: an administrator, a designer (who may edit every service), or one of the duty's or the service's owners **as they were when the exception was asked for** – adding an owner afterwards does not let that person decide it, so the requester cannot pick the second person. Never the person who asked (former names of an imported account count as the same person). The owners as of the request (else the administrators) get a notification, _Duty exception asked for_. Approving or rejecting is a four-eyes decision, like approving a record; it needs no step-up, because it changes no rights and both people and the reason are in the audit log. The requester can withdraw an exception while it waits. A period that has ended, or that is done already, takes no exception.

## Stored history

A duty job runs every five minutes. It stores the state of open periods and **closes** a period once its grace period has ended: the final status, the run that counted (with the process version and definition hash it ran), the number of failed runs, the exception, and what the period was judged against – name, level, interval, grace period, process name and time zone. A closed period is never written again. Later changes of the duty, the process or the runs do not change it – also not when the run retention deletes the run. An open period that is done stays done when its run is deleted.

The service scorecard reads these stored periods.

## Where you see duties

- **Service page → Duties**: each duty with its level, interval, the current and the last period.
- **Application page → Duties**: the duties of services that are about this application.
- **Service management → Duties**: every duty, with filters for the level and _Due or missed_.
- **Duty page**: the periods (newest first), the exceptions, the process, the schedule and the owners.
- **Start page → Duties due**: mandatory duties due within a week (or in their grace period) and those whose last period was missed or failed. Designers, administrators and auditors see all; everyone else the duties they are responsible for (no tile when there are none). The tile and the daily summary read the periods the duty job stores – they are at most five minutes old (a change of a duty or an exception is stored at once); the duty pages and the API judge the open periods when you open them.

## Reminders and missed periods

- **Duty due** – once per period, the reminder days before the period ends, while the duty is not done.
- **Duty missed** – once, when a period of a mandatory or recommended duty closes as missed or failed (optional duties send none).
- **Duty period ended without a run** – when someone archives or changes a mandatory or recommended duty and its current period ends without a run; to the duty's and the service's owners (else the administrators), not to the person who made the change.

Both go to the duty's owners (else the service owners, else the administrators), in their language, on the channels set in _Settings → Notifications_ ([NOTIFICATIONS.md](NOTIFICATIONS.md)). Each message is recorded before it is sent, so it goes out once, also after a restart. While the vault is locked, the job waits. The **daily summary** has a _Service duties_ section with the duties due and missed that you are responsible for.

## Who may do what

| Action                         | Who                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| See duties and their periods   | Everyone who can sign in (like services)                                                                   |
| Define, change, archive duties | Whoever may edit the service: designers, administrators, the service's owners                              |
| Ask for an exception           | The duty's owners and whoever may edit the service                                                         |
| Approve or reject an exception | Administrators, designers, the duty's and the service's owners as of the request – never the one who asked |
| Withdraw an exception          | The person who asked for it                                                                                |

A duty can only name a process you may view. People who may not view the process see the duty and its status, but not the process name or the runs.

## Audit, API, reports, migration

- **Audit log:** `duty.created`, `.updated` (with the changes before and after), `.archived`, `.restored`, `.skip_requested`, `.skip_approved`, `.skip_rejected`, `.skip_withdrawn`; by the system `duty.period_closed` and `duty.reminder_sent`.
- **Public API** (read-only, [API.md](API.md); the run that counted comes with its process version and definition hash): `GET /api/v1/duties` (filters `serviceId`, `applicationId`, `level`, `archived`), `GET /api/v1/duties/{dutyId}`, `GET /api/v1/duties/{dutyId}/periods` (newest first; filters `status`, `closed`, `from`, `to`).
- **Scheduled reports** ([REPORTS.md](REPORTS.md)): the section _Service duties_ lists the periods that ended in the report period with their status, and the duties not done yet at its end. Limit it to levels or services.
- **Migration packages** ([MIGRATION.md](MIGRATION.md)) carry duties, their stored periods and exceptions. Owners follow the identity mapping; who asked for and decided an exception stays as it was. The record of reminders sent does not move, so a reminder of the current period may come once more on the new server.

Internal API (web UI): `GET/POST /api/duties` (`?serviceId=`, `?applicationId=`, `?archived=1`), `GET/PUT /api/duties/:id`, `POST /api/duties/:id/archive`, `POST /api/duties/:id/skips`, `POST /api/duties/:id/skips/:skipId/decision`, `POST /api/duties/:id/skips/:skipId/withdraw`.
