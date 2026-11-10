# Reports

Steward produces three kinds of PDF/A-2b reports. All of them are archived the same way: the file is written once and never changed, its SHA-256 is recorded in the audit log (`report.generated`), and _Audit log → Verify PDF report_ checks a copy, also a signed one.

| Kind                 | What                                                    | Where                                                        |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| Run report           | One run: what was done, decisions, checks, evidence     | Run page → _PDF reports_ ([below](#run-and-summary-reports)) |
| Summary report       | Runs of one or more processes in a period               | _Runs → Summary report_ ([below](#run-and-summary-reports))  |
| **Scheduled report** | Availability and SLA, credentials, runs – on a schedule | _Reports_ (this page)                                        |

## Run and summary reports

Steward creates PDF reports without a browser, also in the desktop executable.

- **Run report.** On a run page, open _PDF reports → Generate PDF report_ (or _Run report → Generate PDF report_). Choose English or German and add a reviewer comment if you like. The report contains:
  - a summary: process, version and definition hash, who started the run, when and how, the time zone, the status and a prominent _dry run_ banner;
  - the platforms used (names and kinds only, never credentials) and the inputs;
  - every step in order, the write operations (simulated ones are marked), decisions and approvals (who, when, selection, comment, four-eyes rule), checks, the process's own report sections, evidence with thumbnails and errors;
  - the reviewer comment, an integrity section with the sealed protocol hash and the run's audit trail, and a sign-off block (_Prepared / Reviewed / Approved by_) with empty digital signature fields.
- **Interim reports.** Runs that wait for a decision can be reported too. These reports are marked _interim_.
- **Summary report.** _Runs → Summary report_ lists all runs of one or more processes in a period, e.g. "Access reviews Q3", with totals.
- **Automatic reports.** In the process editor, _Settings → PDF report_ (YAML: `report: { auto: true, lang: de }`) generates the report whenever a run finishes, e.g. for scheduled reviews.
- **Branding.** _Settings → Report branding_ (administrators) sets the company name, logo (PNG/JPEG, max. 1 MB; default: the Steward logo), accent colour, default classification (e.g. _Internal_) and a footer note, with a sample preview ([Branding](#branding)).

**Archiving and signing.** The files are PDF/A-2b with embedded fonts and metadata (run ID, process, protocol hash, content hash), validated with veraPDF (PDF/A-2b). They are written once to `data/reports/<run>/<report>.pdf` and never overwritten; generating again creates a new version. Each generation is recorded as `report.generated` with the file's SHA-256 in the audit log, and data retention removes a run's reports together with the run. The signature fields can be signed later in Adobe Acrobat or another PDF signing tool.

**Verifying a copy.** _Audit log → Verify PDF report_ (or `POST /api/reports/verify`) checks a file against the audit log. It also recognises signed copies: a signature is appended as an incremental update, so the first bytes of a signed copy are still the original report.

API: `POST /api/runs/:id/reports` `{ lang, comment, classification, timeZone }`, `GET /api/runs/:id/reports`, `GET /api/reports/:id/download`, `POST /api/reports/summary` `{ processIds, from, to, lang, comment, title }`. `GET /api/runs/:id/report.pdf?lang=de` generates, stores and returns a report in one step. Generating and downloading needs view rights on the process; branding needs the _settings_ capability.

## Branding

Branding (company name, logo, colour, classification, footer) comes from _Settings → Report branding_ for all of them, unless a team overrides it.

A team can set its own report branding (_Users → Teams_ → settings → _Report branding_): each field on its own – an empty field keeps the instance value – and its own logo. It is used by:

- report schedules of the team (choose the team in the schedule; the owner must be a member of it, administrators may choose any team);
- run reports of a process the team owns, and summary reports whose processes all share that team;
- PDFs of documents the team owns.

A resource owned by several teams with branding uses the first of them by name. A renamed team is followed; a deleted team's schedules use the instance branding again. Reports already generated never change.

## How PDFs are created

Every PDF – run reports, summary and scheduled reports, PDFs of documents and the summary of evidence packs – is drawn in a **worker thread**, apart from the thread that answers requests. A long or unusual document (for example 200 000 characters of text without spaces take several seconds) no longer holds up anyone else.

- **One at a time.** Further PDFs wait their turn; with 20 waiting, the next request gets _Steward is creating other PDFs right now_ (`503 PDF_BUSY`).
- **At most 60 seconds** per PDF: after that it is stopped with `422 PDF_TIMEOUT`. Shorten very long text, especially long words without spaces.
- **At most 512 MB of JavaScript memory** (heap) per PDF (`422 PDF_TOO_LARGE`). Images are held outside it, so they have limits of their own: a run report shows thumbnails of evidence images up to 10 MB each and 64 MB together; larger ones stay in the evidence list (name, size, SHA-256) without a thumbnail.
- The data is read first, then the PDF is drawn without access to the database. The PDFs look exactly as before.

`SM_PDF_WORKER` chooses how:

| Value            | PDFs are drawn                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | in the worker thread; if it cannot start (logged: _PDF worker unavailable_), in the main thread as before, and Steward tries to start it again after 1 minute, then after 2, 4 … up to every hour |
| `off`            | always in the main thread, as before 0.3.0 – one at a time, but without the time and memory limits, and other requests wait while a PDF is drawn                                                  |

_System status → Runtime → PDFs_ shows which applies, and why the worker could not start. The worker runs in the container, with Node.js and in the desktop executable.

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

   | Section                         | Contents                                                                                                                                                                                                                                                       |
   | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Availability of monitors        | Per monitor: uptime, SLA met or missed (target from the monitor's availability objective, see below), number of outages, downtime, average and p95 response time; a bar chart and the list of outages                                                          |
   | Availability of Gatus endpoints | The same per Gatus endpoint, from metrics mode ([GATUS.md](GATUS.md#5-metrics-mode))                                                                                                                                                                           |
   | Credentials register            | Expired and overdue entries and those due within _N_ days after the period ([CREDENTIALS.md](CREDENTIALS.md))                                                                                                                                                  |
   | Runs                            | Runs started in the period per process: succeeded, failed, other                                                                                                                                                                                               |
   | Documents and change requests   | Documents created, changed, approved or implemented in the period; open change requests by status; planned change windows ([RECORDS.md](RECORDS.md))                                                                                                           |
   | Service duties                  | Periods of service duties that ended in the period with their status, and the duties not done yet at its end ([DUTIES.md](DUTIES.md))                                                                                                                          |
   | Service scorecard               | Per service duties, availability, documentation and protection need with _attention needed_; the trend of the stored days; availability objectives and their breaches ([SCORECARD.md](SCORECARD.md))                                                           |
   | AI usage                        | Calls and tokens of AI models per gateway and model, the processes with the most tokens, refused and failed calls, the budgets – with the preset _monthly_ the monthly AI report ([AI.md](AI.md#reporting))                                                    |
   | Costs                           | Per service, application, team or platform the costs of the period against the period before, per currency, with the budgets (platforms: what is unassigned) – with the preset _monthly_ the monthly cost report ([COSTS.md](COSTS.md#dashboards-and-the-api)) |
   | Data contracts                  | Per data contract the tests of the period (passed, warnings, failed), the last test, Steward's findings and the versions saved with their breaking changes ([DATA-CONTRACTS.md](DATA-CONTRACTS.md#monitors-processes-scorecard-and-reports))                   |

   **SLA targets of monitors.** With _Use the objective_ (on for new schedules), each monitor is judged by the availability objective that has it as source ([SCORECARD.md](SCORECARD.md#from-a-steward-monitor)): the target of the objective's window closest to the report period – 24 h for a daily report, 7 days for a weekly one, 30 days for a monthly one; with several objectives the strictest. The uptime is computed the same way as the objective's, so a report over 7 days ending now shows the same number as the objective's 7-day window. Monitors without such an objective use the section's own _SLA target_. That separate field is **deprecated** (0.11) and will be removed in a later release; schedules saved before 0.11 keep it until you switch _Use the objective_ on.

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
- **Documents**: _changed_ means a new content version in the period; _approved_ counts approvals of change requests and acceptances of decision records. Statuses are those at the end of the period, replayed from the record history. **Open change requests** are those not closed or cancelled. **Planned change windows** come from the _Planned start_ and _Planned end_ fields of change requests (not cancelled) and cover the period plus _N_ days after it (default 30). You can limit the section to some record types.
- **Service duties**: periods that ended in the report period, with the stored status (closed periods never change, so a report made later shows the same); a period still in its grace period shows its status at the time of the report. You can limit the section to levels or services.

### Archive and audit

Generated reports are stored under `data/reports/scheduled/<report>.pdf`, listed under _Reports → Generated reports_ and downloaded with the usual check of the recorded SHA-256. Audit entries: `report_schedule.created`, `.updated`, `.deleted`, `.skipped`, `.failed`, and `report.generated` (with the actor who triggered it, `system` for the timer) for each PDF.

### API

Internal API (web UI): `GET/POST /api/report-schedules`, `GET/PUT/DELETE /api/report-schedules/:id`, `POST /api/report-schedules/:id/run`, `GET /api/report-schedules/:id/reports`, `GET /api/report-schedules/reports`; download with `GET /api/reports/:id/download`.

### For developers: more sections

A section has two halves ([ARCHITECTURE.md](ARCHITECTURE.md#report-sections-and-the-pdf-worker)), joined with `defineReportSection()` (`server/src/reports/sections.ts`):

- the draw half, `<feature>/report-section-draw.ts`, runs in the PDF worker and reads no database:
  - `title(lang)` names the section;
  - `render(data, { w, tr, lang, section })` draws it with the PDF writer;
  - `glance` adds figures to the _At a glance_ row;
- the collect half, `<feature>/report-section.ts`, runs in the main thread:
  - `schema` validates the section's configuration (zod), `validate` checks what it names when a schedule is saved;
  - `build(config, { from, to, now, lang })` runs inside `runAs(owner)` and returns JSON data (part of the report's content hash).

The feature's manifest lists the section (`reportSections` in `server/src/features/<feature>.ts`), and `server/src/reports/pdf/drawers.ts` lists its draw half for the worker. The "records" section (`server/src/records/report-section.ts`) plugs in this way.
