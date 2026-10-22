# Reports

Steward produces three kinds of PDF/A-2b reports. All of them are archived the same way: the file is written once and never changed, its SHA-256 is recorded in the audit log (`report.generated`), and *Audit log → Verify PDF report* checks a copy, also a signed one.

| Kind | What | Where |
| --- | --- | --- |
| Run report | One run: what was done, decisions, checks, evidence | Run page → *PDF reports* ([README](../README.md#pdf-reports)) |
| Summary report | Runs of one or more processes in a period | *Runs → Summary report* ([README](../README.md#pdf-reports)) |
| **Scheduled report** | Availability and SLA, credentials, runs – on a schedule | *Reports* (this page) |

Branding (company name, logo, colour, classification, footer) comes from *Settings → Report branding* for all of them.

## Scheduled reports

A report schedule creates a summary report every day, week or month, archives it and sends it to its recipients.

### Create a schedule

1. *Reports → New report schedule*.
2. **Name** and, optionally, a **title** for the cover.
3. **When**:

   | Preset | Runs | Period |
   | --- | --- | --- |
   | Daily | every day at 06:00 | the previous calendar day |
   | Weekly | Mondays at 06:00 | the previous week, Monday to Monday |
   | Monthly | on the 1st at 06:00 | the previous calendar month |
   | Custom | your cron expression | the given number of days before each run |

   Periods are calendar periods in the schedule's **time zone** (summer time is handled). The report's times are shown in that zone too.
4. **Language** (English or German) and **classification**.
5. **Sections** – choose one or more:

   | Section | Contents |
   | --- | --- |
   | Availability of monitors | Per monitor: uptime, SLA met or missed (optional target, e.g. 99.5 %), number of outages, downtime, average and p95 response time; a bar chart and the list of outages |
   | Availability of Gatus endpoints | The same per Gatus endpoint, from metrics mode ([GATUS.md](GATUS.md#5-metrics-mode)) |
   | Credentials register | Expired and overdue entries and those due within *N* days after the period ([CREDENTIALS.md](CREDENTIALS.md)) |
   | Runs | Runs started in the period per process: succeeded, failed, other |

6. **Recipients**: Steward users and teams (in the app and by e-mail, following their notification settings) and e-mail addresses (e-mail only, when e-mail is set up). *Attach the PDF* sends the file with the e-mail (up to 10 MB); otherwise the e-mail has a link, which needs a Steward account.
7. Save. *Generate now* (▶) creates a report immediately for the period ending now.

### Whose data is in the report?

A schedule has an **owner**, the person who created it. It runs with the owner's rights, checked again on every run:

- only monitors, processes and Gatus platforms the owner may see are included;
- monitors and processes named in a section must be visible to the owner when the schedule is saved;
- if the owner is deactivated or deleted, the schedule stops and records the reason (`report_schedule.skipped`).

Recipients get the report the owner was allowed to produce – choose them like you would choose the people you send a document to.

### Who may do what

| | Create | Change, delete, generate now | See the schedule and its reports |
| --- | --- | --- | --- |
| Administrator | ✓ | ✓ (all schedules) | ✓ |
| Designer, operator, approver, auditor | ✓ | own schedules | own schedules; auditors: all |
| Viewer | | | as a recipient |
| Recipient (user or team) | | | ✓ while the schedule exists |

The person whose rights a report was generated with keeps access to it after the schedule is deleted; auditors and administrators always do.

### How the figures are computed

- **Monitor uptime** is time-weighted from the monitor's status changes in the period: *down* counts against it, *up* and *degraded* count for it; *unknown*, *blocked* and *maintenance* time is left out. An **outage** is a period in which the monitor was *down*.
- **Monitor response times** come from the stored check results (Steward keeps the newest results per check), so for long periods they describe the end of the period.
- **Gatus uptime** is the share of successful results among all results Gatus produced in the period (deltas of `gatus_results_total`). **Outages** are periods in which the newest result failed (`gatus_results_endpoint_success = 0`). **p95** needs the per-scrape samples, kept for *raw retention* days (default 14); for older periods it is shown as –.
- **Credentials**: the state at the end of the period (or now, for a period that ends in the future).

### Archive and audit

Generated reports are stored under `data/reports/scheduled/<report>.pdf`, listed under *Reports → Generated reports* and downloaded with the usual check of the recorded SHA-256. Audit entries: `report_schedule.created`, `.updated`, `.deleted`, `.skipped`, `.failed`, and `report.generated` (with the actor who triggered it, `system` for the timer) for each PDF.

### API

Internal API (web UI): `GET/POST /api/report-schedules`, `GET/PUT/DELETE /api/report-schedules/:id`, `POST /api/report-schedules/:id/run`, `GET /api/report-schedules/:id/reports`, `GET /api/report-schedules/reports`; download with `GET /api/reports/:id/download`.

### For developers: more sections

Sections are registered in `server/src/reports/sections.ts` with `registerReportSection({ id, schema, validate, title, build, render, glance })`:

- `schema` validates the section's configuration (zod);
- `build(config, { from, to, now, lang })` runs inside `runAs(owner)` and returns JSON data (part of the report's content hash);
- `render(data, { w, tr, lang, section })` draws it with the PDF writer;
- `glance` adds figures to the *At a glance* row.

A "records" section (records / change requests) plugs in this way.
