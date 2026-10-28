# Notifications

Steward notifies people in the app (the bell in the header) and – depending on _Settings → Notifications_ – by e-mail, Microsoft Teams or a webhook. Administrators choose per event which channels are used. People choose their language and whether they get e-mails on their profile page.

- [Events](#events)
- [E-mail addresses outside Steward](#e-mail-addresses-outside-steward)
- [Daily summary](#daily-summary)

## Events

| Event                           | Who gets it                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision                        | People who may decide a task that waits                                                                                                                       |
| Run failed                      | Who started the run, the owner of the schedule                                                                                                                |
| Check failed                    | Who started the run, the schedule owner, the process owner                                                                                                    |
| Check passes again              | The same, when a schedule asks for it (below)                                                                                                                 |
| Stale data                      | The process owner and administrators                                                                                                                          |
| Schedule skipped                | The schedule owner and administrators                                                                                                                         |
| Monitor status                  | Owners and subscribers of the monitor (root causes only)                                                                                                      |
| Credential due                  | The owners of the entry ([CREDENTIALS.md](CREDENTIALS.md))                                                                                                    |
| Report ready                    | The recipients of the report schedule ([REPORTS.md](REPORTS.md))                                                                                              |
| Ticket not checked              | The responsible people of a ticket reference ([TICKETS.md](TICKETS.md#reminders))                                                                             |
| Document review due             | The review owner of a living document ([RECORDS.md](RECORDS.md#periodic-reviews))                                                                             |
| Tech stack end of life          | The owners of the application (else administrators), once when a release cycle ends soon and once at its end ([APPLICATIONS.md](APPLICATIONS.md#end-of-life)) |
| Duty due                        | The owners of a service duty, else the service owners ([DUTIES.md](DUTIES.md))                                                                                |
| Duty missed                     | The same, when a mandatory or recommended duty's period ended without a run that counts                                                                       |
| Duty period ended without a run | The duty's and the service's owners (else administrators), not who archived or changed the duty                                                               |
| Duty exception asked for        | The duty's and the service's owners as of the request (else administrators), not the requester                                                                |
| Objective breached              | The service owners (else administrators), once per breach of an availability objective with _Send a message_ on ([SCORECARD.md](SCORECARD.md))                |
| Daily summary                   | People who turned it on (below) – in-app and e-mail only, never Teams or webhooks                                                                             |

## Failed checks of scheduled runs

A scheduled process that runs every 10 minutes and finds the same failing endpoint would otherwise notify after every run. Each schedule decides (_Schedules → Edit → Failed checks notify_):

| Setting                 | What notifies                                                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **On change** (default) | A check that starts failing; the same check with another result (its message or severity changed, e.g. other endpoints down); and – while it keeps failing with the same result – a reminder after _Reminder while still failing_ hours (default 4, `0` = none), with the time it started failing. |
| **After every run**     | Every run in which a check fails, as before 0.2.3 (in the app every time; e-mail, Teams and webhook at most once an hour per process and check).                                                                                                                                                   |
| **Never**               | Nothing for failed checks; they are shown in the runs. Failed runs still notify.                                                                                                                                                                                                                   |

_Send a message when a check passes again_ adds **Check passes again** (with the time it had been failing since) for the first passing run. In the app, by e-mail, Teams and webhook alike; the webhook body carries `phase` (`new`, `changed`, `reminder`, `every`) and `since`. Existing schedules get _on change_ with a 4-hour reminder.

- The state is kept per schedule and check (dry runs separately). Changing the setting starts over: a check that still fails notifies again at the next run.
- A check compares its **message**, so keep values that change in every run (uptime percentages, timestamps) out of it, or put them in the run report instead.
- Runs without a schedule – started by hand, by a webhook trigger, a monitor or a parent process – notify on every failed check, as before.
- A check step with `notify: false` (_Notify when the check fails: No_ in the editor) never notifies: an informational check, shown in the run. The examples use it for _Gatus publishes endpoint metrics_, _The usage service answered_ and _No single-member groups_.

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
- **Generic webhooks** get the same JSON as before.
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
- records waiting for your approval, and records you own that changed their status;
- reviews of living documents you review that are due soon or overdue;
- service duties you are responsible for that are due soon, and periods missed or failed since the last summary ([DUTIES.md](DUTIES.md));
- scheduled reports you receive that were generated since the last summary.

You choose the sections, the time of day and your time zone, the days (Monday to Friday, or every day), and whether it comes in the app only or also by e-mail. With _Send nothing on days without anything to report_ you get nothing on quiet days. **Preview** shows what it would contain right now, without sending anything.

**E-mail** is sent only when e-mail is set up (SMTP), the event _Daily summary_ is routed to e-mail in _Settings → Notifications_, you turned on e-mail notifications, and your address's domain is allowed (see above). The profile card says why when one of these is missing. The e-mail has a compact HTML part and a plain text part, in your language, with links into Steward (`SM_PUBLIC_URL` or the base URL in the notification settings).

**Administrators** see under _Settings → Daily summaries_ who receives one, when and how – never the content – and can switch daily summaries off for everyone. Every change of the settings is in the audit log.

**When it is sent.** The notification job checks every five minutes. A summary is due once your local time passes the chosen time on a chosen day; if Steward was down at that time, it is sent within the next six hours, otherwise that day is skipped. Each person and local day is recorded before anything is sent, so a summary goes out at most once a day, also after a restart. "Since the last summary" means since the last one that was due (at most seven days back). While the vault is locked, summaries that include e-mail wait until it is unlocked.

**One instance.** Steward assumes one server process per database. The once-a-day record is a database key, so two instances would still not send the same summary twice, but both would run the job.
