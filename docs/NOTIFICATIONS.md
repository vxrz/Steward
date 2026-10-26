# Notifications

Steward notifies people in the app (the bell in the header) and – depending on _Settings → Notifications_ – by e-mail, Microsoft Teams or a webhook. Administrators choose per event which channels are used. People choose their language and whether they get e-mails on their profile page.

- [Events](#events)
- [E-mail addresses outside Steward](#e-mail-addresses-outside-steward)
- [Daily summary](#daily-summary)

## Events

| Event                           | Who gets it                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision                        | People who may decide a task that waits                                                                                                        |
| Run failed                      | Who started the run, the owner of the schedule                                                                                                 |
| Check failed                    | Who started the run, the schedule owner, the process owner                                                                                     |
| Stale data                      | The process owner and administrators                                                                                                           |
| Schedule skipped                | The schedule owner and administrators                                                                                                          |
| Monitor status                  | Owners and subscribers of the monitor (root causes only)                                                                                       |
| Credential due                  | The owners of the entry ([CREDENTIALS.md](CREDENTIALS.md))                                                                                     |
| Report ready                    | The recipients of the report schedule ([REPORTS.md](REPORTS.md))                                                                               |
| Ticket not checked              | The responsible people of a ticket reference ([TICKETS.md](TICKETS.md#reminders))                                                              |
| Document review due             | The review owner of a living document ([RECORDS.md](RECORDS.md#periodic-reviews))                                                              |
| Duty due                        | The owners of a service duty, else the service owners ([DUTIES.md](DUTIES.md))                                                                 |
| Duty missed                     | The same, when a mandatory or recommended duty's period ended without a run that counts                                                        |
| Duty period ended without a run | The duty's and the service's owners (else administrators), not who archived or changed the duty                                                |
| Duty exception asked for        | The duty's and the service's owners as of the request (else administrators), not the requester                                                 |
| Objective breached              | The service owners (else administrators), once per breach of an availability objective with _Send a message_ on ([SCORECARD.md](SCORECARD.md)) |
| Daily summary                   | People who turned it on (below) – in-app and e-mail only, never Teams or webhooks                                                              |

## E-mail addresses outside Steward

Plain addresses (credential owners, report recipients) only get e-mail when their domain is allowed: _Settings → Notifications → Allowed e-mail domains for addresses outside Steward_. An empty list means the domains of the Steward users' own addresses.

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
