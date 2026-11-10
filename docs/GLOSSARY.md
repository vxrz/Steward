# Glossary

The words Steward uses, in English and German. The web app has the same list under _Help → Glossary_.

**In one sentence:** a service consists of applications; an application runs on systems; Steward reaches systems and applications through platforms.

## Catalogue

| Term          | German       | Meaning                                                                                                                                                                                                           |
| ------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service       | Service      | What a team offers to others, with an owner and a criticality. It consists of applications. _Catalogue → Services_.                                                                                               |
| Application   | Anwendung    | Software a service consists of – a tenant you use or a small in-house app – with its CIA rating (protection need). It runs on systems. _Catalogue → Applications_.                                                |
| System        | System       | Where applications run: a server, VM, cluster, appliance or cloud service, with its environments. A catalogue entry. _Catalogue → Systems_.                                                                       |
| Supplier      | Lieferant    | Who runs, backs up, patches or recovers what a service uses (SaaS, managed platform, software vendor, service provider), with contracts and certificates. _Catalogue → Suppliers_ ([SUPPLIERS.md](SUPPLIERS.md)). |
| Component     | Komponente   | A code or data part of an application: a repository, image, library, topic or database. Listed on the application.                                                                                                |
| Platform      | Plattform    | A connection Steward talks to through an API: base URL, credentials, API specifications. Not a catalogue entry; an application or system can name the platform that reaches it. _Catalogue → Platforms_.          |
| Data contract | Datenvertrag | What a data source promises (ODCS): schema, quality rules, versions. An optional module.                                                                                                                          |

## Automation

| Term                         | German                       | Meaning                                                                                                                            |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Process (procedure, runbook) | Prozess (Verfahren, Runbook) | A versioned flow of steps that Steward runs. The UI says _process_; the docs also say _procedure_ or _runbook_ for the same thing. |
| Run                          | Ausführung                   | One execution of a process, with its journal, protocol and seal.                                                                   |
| Step                         | Schritt                      | One node of a process in a run: an API call, a check, a manual task, a decision.                                                   |
| Decision                     | Entscheidung                 | An approval or selection a person makes while a run waits. _Operate → My tasks_.                                                   |
| Schedule, trigger            | Zeitplan, Auslöser           | What starts a run: a time (cron) or an inbound webhook.                                                                            |

## Watching

| Term               | German          | Meaning                                                                                                                                                                                                                       |
| ------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monitor            | Monitor         | A graph of checks that runs on a schedule and reports a status (up, degraded, down).                                                                                                                                          |
| Check              | Prüfung         | One test inside a monitor or a process step: an HTTP status, a query value, a heartbeat.                                                                                                                                      |
| Objective          | Ziel            | An availability target of a service, measured over time from one source: a Steward monitor, a Gatus endpoint or a PromQL query. Shown on the scorecard (a tab of Services); scheduled reports take their SLA targets from it. |
| Maintenance window | Wartungsfenster | Planned work on platforms, systems, applications, services or monitors: affected monitors stay quiet and messages pause. The only kind of maintenance window since 0.11. _Operate → Maintenance_.                             |

## Registers and people

| Term                 | German                      | Meaning                                                                                                                                                                                                                          |
| -------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document (record)    | Dokument                    | An entry with a type and a workflow: change requests, decisions, reviews, firewall changes. The UI says _document_ (_Registers → Documents_); the docs and the API also say _record_ (`/api/records`, [RECORDS.md](RECORDS.md)). |
| Credentials register | Zugangsdaten (Register)     | Metadata about secrets kept elsewhere: expiry, rotation, owner. It never holds the secret; platforms do. _Registers → Credentials_.                                                                                              |
| Ticket reference     | Ticket-Referenz             | A ticket that lives in another tool (ServiceNow, a vendor portal), tracked with reminders. _Registers → Ticket references_ ([TICKETS.md](TICKETS.md)).                                                                           |
| Duty                 | Pflicht                     | A recurring obligation of a service, judged by real runs: done, late or missed. _Registers → Duties_.                                                                                                                            |
| Team, owning team    | Team, verantwortliches Team | A team groups people with roles. The owning teams of an item decide who may see and change it ([ADR 0006](adr/0006-owning-teams-policy-module.md)).                                                                              |
| Module               | Modul                       | An optional area an administrator can switch off in _Settings → Modules_ ([MODULES.md](MODULES.md)).                                                                                                                             |

## Costs

| Term           | German        | Meaning                                                                                                                                                                          |
| -------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fiscal year    | Geschäftsjahr | The planning period of cost plans: twelve months from the start month the instance sets (_Costs → Settings_), named by the year it starts in – _FY 2026_ or _FY 2026/27_.        |
| Plan line      | Planposition  | What a service plans to spend in a fiscal year on a licence, cloud, support, hardware or other: an amount and a cadence, optionally for an application or system of the service. |
| Cost entry     | Kostenbuchung | What a service incurred: a date, an amount and a reference (invoice or order number), on a plan line or unplanned. Not effort – Steward plans no person-hours.                   |
| Unplanned      | Ungeplant     | A cost entry without a plan line of its fiscal year.                                                                                                                             |
| Monthly budget | Monatsbudget  | A limit per month for the costs read for a service, application or team, with notices at 80 % and 100 % – independent of the cost plan.                                          |

## Plant registry

| Term             | German                 | Meaning                                                                                                                                                    |
| ---------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device profile   | Geräteprofil           | A kind of controller or device with its interfaces and data points; may extend a base profile ([PLANT.md](PLANT.md#profile-inheritance)).                  |
| Resolved profile | Wirksames Profil       | A profile as it is in effect: what it inherits from its bases, with its own changes and additions.                                                         |
| Asset addition   | Ergänzung einer Anlage | A data point or interface one asset has beyond its profile.                                                                                                |
| Known-as name    | Auch bekannt als       | A name tools commonly use for a data point (`aliases`), such as a gateway's variable name.                                                                 |
| Data collection  | Datenerfassung         | What a collector (a gateway, an ETL job) reads from an asset: items, mode, interval, destination, access patterns ([PLANT.md](PLANT.md#data-collections)). |
| Collector        | Kollektor              | Who reads or moves an asset's data: a Steward application, platform or process, or a job elsewhere by name.                                                |
| Raw item         | Roher Eintrag          | An item of a data collection that is not mapped to a data point of the asset.                                                                              |

The German terms of the UI in more detail: [I18N.md](I18N.md#german-glossary).
