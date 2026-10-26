# Reports

Steward produces three kinds of PDF/A-2b reports. All of them are archived the same way: the file is written once and never changed, its SHA-256 is recorded in the audit log (`report.generated`), and _Audit log → Verify PDF report_ checks a copy, also a signed one.

| Kind                 | What                                                    | Where                                                         |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Run report           | One run: what was done, decisions, checks, evidence     | Run page → _PDF reports_ ([README](../README.md#pdf-reports)) |
| Summary report       | Runs of one or more processes in a period               | _Runs → Summary report_ ([README](../README.md#pdf-reports))  |
| **Scheduled report** | Availability and SLA, credentials, runs – on a schedule | _Reports_ (this page)                                         |

Branding (company name, logo, colour, classification, footer) comes from _Settings → Report branding_ for all of them.

## Scheduled reports

A report schedule creates a summary report every day, week or month, archives it and sends it to its recipients.

### Create a schedule

1. _Reports → New report schedule_.
2. **Name** and, optionally, a **title** for the cover.
3. **When**:

   | Preset  | Runs                 | Period                                   |
   | ------- | -------------------- | ---------------------------------------- |
   | Daily   | every day at 06:00   | the previous calendar day                |
   | Weekly  | Mondays at 06:00     | the previous week, Monday to Monday      |
   | Monthly | on the 1st at 06:00  | the previous calendar month              |
   | Custom  | your cron expression | the given number of days before each run |

   Periods are calendar periods in the schedule's **time zone** (summer time is handled). The report's times are shown in that zone too.

   A custom cron expression has five fields (minute hour day month weekday; no seconds) and may run at most once an hour, so the minute field is a single number: `0 6 * * 1` or `15 * * * *`, not `*/5 * * * *`. Schedules saved before this limit that run more often are not started; their last error says why.

4. **Language** (English or German) and **classification**.
5. **Sections** – choose one or more:

   | Section                         | Contents                                                                                                                                                               |
   | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Availability of monitors        | Per monitor: uptime, SLA met or missed (optional target, e.g. 99.5 %), number of outages, downtime, average and p95 response time; a bar chart and the list of outages |
   | Availability of Gatus endpoints | The same per Gatus endpoint, from metrics mode ([GATUS.md](GATUS.md#5-metrics-mode))                                                                                   |
   | Credentials register            | Expired and overdue entries and those due within _N_ days after the period ([CREDENTIALS.md](CREDENTIALS.md))                                                          |
   | Runs                            | Runs started in the period per process: succeeded, failed, other                                                                                                       |
   | Records and change requests     | Records created, changed, approved or implemented in the period; open change requests by status; planned change windows ([RECORDS.md](RECORDS.md))                     |
   | Service duties                  | Periods of service duties that ended in the period with their status, and the duties not done yet at its end ([DUTIES.md](DUTIES.md))                                  |

6. **Recipients**: Steward users and teams (in the app and by e-mail, following their notification settings) and up to 20 e-mail addresses (e-mail only, when e-mail is set up). An address needs an allowed domain (_Settings → Notifications → Allowed e-mail domains for addresses outside Steward_; while it is empty, the company's own domains – see [CREDENTIALS.md](CREDENTIALS.md#e-mail-addresses-outside-steward)). _Attach the PDF_ sends the file with the e-mail (up to 10 MB); otherwise the e-mail has a link, which needs a Steward account. The subject is `Report ready: "<name>"`, with the name shortened to 80 characters.
7. Save. _Generate now_ (▶) creates a report immediately for the period ending now.

### Whose data is in the report?

A schedule has an **owner**, the person who created it. It runs with the owner's rights, checked again on every run:

- only monitors, processes and Gatus platforms the owner may see are included;
- monitors and processes named in a section must be visible to the owner when the schedule is saved;
- if the owner is deactivated or deleted, the schedule stops and records the reason (`report_schedule.skipped`).

Recipients get the report the owner was allowed to produce – choose them like you would choose the people you send a document to.

### Who may do what

|                                       | Create | Change, delete, generate now | See the schedule and its reports |
| ------------------------------------- | ------ | ---------------------------- | -------------------------------- |
| Administrator                         | ✓      | ✓ (all schedules)            | ✓                                |
| Designer, operator, approver, auditor | ✓      | own schedules                | own schedules; auditors: all     |
| Viewer                                |        |                              | as a recipient                   |
| Recipient (user or team)              |        |                              | ✓ while the schedule exists      |

The person whose rights a report was generated with keeps access to it after the schedule is deleted; auditors and administrators always do.

Everyone who may read data may create schedules: a report only contains what its owner may see, runs at most once an hour and only mails allowed domains. One person owns at most 20 schedules.

### How the figures are computed

- **Monitor uptime** is time-weighted from the monitor's status changes in the period: _down_ counts against it, _up_ and _degraded_ count for it; _unknown_, _blocked_ and _maintenance_ time is left out. An **outage** is a period in which the monitor was _down_.
- **Monitor response times** come from the stored check results (Steward keeps the newest results per check), so for long periods they describe the end of the period.
- **Gatus uptime** is the share of successful results among all results Gatus produced in the period (deltas of `gatus_results_total`). **Outages** are periods in which the newest result failed (`gatus_results_endpoint_success = 0`). **p95** needs the per-scrape samples, kept for _raw retention_ days (default 14); for older periods it is shown as –.
- **Credentials**: the state at the end of the period (or now, for a period that ends in the future).
- **Records**: _changed_ means a new content version in the period; _approved_ counts approvals of change requests and acceptances of decision records. Statuses are those at the end of the period, replayed from the record history. **Open change requests** are those not closed or cancelled. **Planned change windows** come from the _Planned start_ and _Planned end_ fields of change requests (not cancelled) and cover the period plus _N_ days after it (default 30). You can limit the section to some record types.
- **Service duties**: periods that ended in the report period, with the stored status (closed periods never change, so a report made later shows the same); a period still in its grace period shows its status at the time of the report. You can limit the section to levels or services.

### Archive and audit

Generated reports are stored under `data/reports/scheduled/<report>.pdf`, listed under _Reports → Generated reports_ and downloaded with the usual check of the recorded SHA-256. Audit entries: `report_schedule.created`, `.updated`, `.deleted`, `.skipped`, `.failed`, and `report.generated` (with the actor who triggered it, `system` for the timer) for each PDF.

### API

Internal API (web UI): `GET/POST /api/report-schedules`, `GET/PUT/DELETE /api/report-schedules/:id`, `POST /api/report-schedules/:id/run`, `GET /api/report-schedules/:id/reports`, `GET /api/report-schedules/reports`; download with `GET /api/reports/:id/download`.

### For developers: more sections

Sections are registered in `server/src/reports/sections.ts` with `registerReportSection({ id, schema, validate, title, build, render, glance })`:

- `schema` validates the section's configuration (zod);
- `build(config, { from, to, now, lang })` runs inside `runAs(owner)` and returns JSON data (part of the report's content hash);
- `render(data, { w, tr, lang, section })` draws it with the PDF writer;
- `glance` adds figures to the _At a glance_ row.

The "records" section (`server/src/records/report-section.ts`) plugs in this way; `reports/schedules.ts` imports it.
