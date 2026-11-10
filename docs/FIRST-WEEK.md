# Your first week with Steward

Steward is installed and opens in the browser. This page plans the first five working days for the team that will run it: what to do each day, in an order where each day builds on the one before, and what to leave for later. Each step is short and links to the page with the details. [GETTING-STARTED.md](GETTING-STARTED.md) explains the installation steps themselves; the in-app checklist (_Help → Getting-started checklist_) shows how far you are.

The examples use an invented company, _Brightwater_, with a plant in _Riverside_, a team _Line Operations_ and an Insights Hub test tenant. Use your own names.

- [Day 1: sign-in, administrators, the vault](#day-1-sign-in-administrators-the-vault)
- [Day 2: the first platform and process](#day-2-the-first-platform-and-process)
- [Day 3: monitors and notifications](#day-3-monitors-and-notifications)
- [Day 4: the catalogue](#day-4-the-catalogue)
- [Day 5: the plant registry](#day-5-the-plant-registry)
- [What to leave for later](#what-to-leave-for-later)

## Day 1: sign-in, administrators, the vault

Goal: people can sign in, two people can administer, and nothing is lost if the server goes.

1. **Master passphrase.** Store the passphrase you chose at the first start in the company password manager, with two people having access. It cannot be recovered ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#master-passphrase)). For restarts without a person: a passphrase file only the service account can read ([GETTING-STARTED.md](GETTING-STARTED.md#3-unlocking-after-a-restart)).
2. **Single sign-on.** _Users & teams → Single sign-on_: add your identity provider with its preset, run **Test discovery** and a **test sign-in** before anyone depends on it ([SSO.md](SSO.md#set-up-a-provider), [SSO.md](SSO.md#test-sign-in)). With Microsoft Entra ID use the Entra preset: it identifies people by `tid` + `oid` ([SSO.md](SSO.md#microsoft-entra-id)).
3. **Roles from groups.** Map one group per role – for example _BW-Steward-Operators_ to _operator_ – and, if several teams share the instance, to teams with their roles ([SSO.md](SSO.md#groups-and-roles), [TEAMS.md](TEAMS.md#setting-it-up)).
4. **A second administrator.** Give a second person the administrator role: changes that loosen the assurance policy wait for a second administrator ([ASSURANCE.md](ASSURANCE.md)). Keep the local administrator account as break-glass access ([INSTALL.md](INSTALL.md#locked-out-of-single-sign-on)).
5. **Backups.** _Settings → Backups_: an encrypted copy to an S3 bucket on a schedule, with the weekly restore test ([BACKUPS.md](BACKUPS.md#setting-it-up)). Keep the backup passphrase offline next to the master passphrase: a restore needs both.

By the evening: two administrators, sign-in through your identity provider, the first backup listed as tested.

## Day 2: the first platform and process

Goal: one real procedure runs as a dry run against a test system.

1. **A platform.** _Platforms → Create platform_: the Insights Hub test tenant (or any REST API you know well) with its base URL and sign-in ([PLATFORMS.md](PLATFORMS.md), [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#adding-a-platform)). **Test connection**.
2. **An identity.** Start with a read-only identity for reading and add a second one for changes later; processes and monitors choose which identity they use ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#identities), [read-only identities](PLATFORM-SIGN-IN.md#read-only-identities-and-the-operation-filter)).
3. **The API spec.** Import its OpenAPI specs (file, paste or URL), so the editor and the API explorer list the operations ([PLATFORMS.md](PLATFORMS.md#api-specifications-and-path-prefixes)). Look at one real answer in the API explorer.
4. **A process from the examples.** _Processes → From template_: a health check or an access review fits a first week ([PROCESSES.md](PROCESSES.md#templates), [examples/README.md](../examples/README.md)). Choose your platform when the template asks for one.
5. **A dry run.** Start it with _Dry run_ on: read calls run, write calls are only recorded ([PROCESSES.md](PROCESSES.md#trying-a-process-safely)). Read the protocol step by step, answer its decisions under _My tasks_, and compare what it would change with what you expect.

By the evening: one platform, one process, one dry run whose protocol the team has read together. Run it for real only once the dry run shows what you expect.

## Day 3: monitors and notifications

Goal: one data path is watched, and the right people hear about it at the right time.

1. **One monitor for one data path.** Pick one path data really takes – for example a gateway in Riverside sending machine data to the Insights Hub tenant – and build a monitor for it: the gateway's heartbeat, the freshness of the data, the platform's API ([MONITORS.md](MONITORS.md#concepts), [check types](MONITORS.md#check-types), [heartbeats](MONITORS.md#heartbeat-api-for-gateways)).
2. **States.** If the machine is switched off on purpose (evenings, weekends), give the monitor states – _Running_ and _Off_ – so that off is not an outage ([MONITORS.md](MONITORS.md#states-off-is-not-an-outage)). Set a maximum off time, so a machine that stays off too long still raises an issue.
3. **Channels and routes.** _Settings → Notifications_: set up e-mail (SMTP) and, if you use it, a Microsoft Teams channel; then choose per event where it goes ([NOTIFICATIONS.md](NOTIFICATIONS.md#events)). Send a test message to each channel.
4. **Quiet hours.** Each person sets their own under _Profile → Quiet hours and digests_; a team can set a default for its members ([NOTIFICATIONS.md](NOTIFICATIONS.md#quiet-hours-and-digests)). Mark a source _Urgent_ only when it must wake people ([NOTIFICATIONS.md](NOTIFICATIONS.md#urgent)).
5. **The monitor's outputs.** Send its changes to the team's channel, or to a JSON webhook for an on-call tool ([MONITORS.md](MONITORS.md#outputs)).

By the evening: one monitor that is green, grey when the machine is off on purpose, and red with a named root cause when you pull the gateway's cable in a test.

## Day 4: the catalogue

Goal: Steward knows what you run, who owns it and when it is allowed to be down.

1. **Services.** _Catalogue → Services_: one service per thing a team offers to others – _Machine data for Riverside_, owned by _Line Operations_ ([GLOSSARY.md](GLOSSARY.md#catalogue)).
2. **Applications.** _Catalogue → Applications_: what each service consists of, with its owners, and map the platforms they use ([APPLICATIONS.md](APPLICATIONS.md#create-an-application), [APPLICATIONS.md](APPLICATIONS.md#map-platforms-integrations), [add them to a service](APPLICATIONS.md#add-applications-to-a-service)).
3. **Owners and teams.** Name the owners on services and applications; owners get the messages about them (end of life, new releases, maintenance). If teams share the instance, give each service its owning team in one step: _Owning teams for the whole service…_ ([TEAMS.md](TEAMS.md#setting-it-up)).
4. **Maintenance windows.** _Catalogue → Maintenance_: the weekly patch window of the gateways, and **planned downtime** for weekends and shutdowns of machines that are off on purpose ([APPLICATIONS.md](APPLICATIONS.md#maintenance-windows)). Monitors of what a window affects stay quiet while it lasts.

By the evening: one service with its applications, owners and windows; the monitor of day 3 is quiet in the next patch window.

## Day 5: the plant registry

Goal: one site is in the plant registry, with device profiles and KPIs, and changes to it are reviewed the way you want. Skip this day if you do not run plants.

1. **Turn it on.** _Settings → Modules → Plant registry_ with the enterprise's name ([PLANT.md](PLANT.md#turning-it-on)).
2. **Import one site.** Write Riverside's hierarchy and assets as YAML (or export them from your engineering tool into that format), preview the import and apply it ([PLANT.md](PLANT.md#yaml-import-and-export)). Start with one area of one site, not the whole plant.
3. **Device profiles and KPIs.** Add the device profiles of your most common machines, assign them to assets, and define one or two KPI definitions such as availability ([PLANT.md](PLANT.md#device-profiles), [PLANT.md](PLANT.md#kpi-definitions), [PLANT.md](PLANT.md#assignment-of-an-asset)). _Plant → Checks_ shows what is not set up yet.
4. **Review and change sets.** Decide whether changes to the site need a second person: the assurance policy's control point `plant.changeSet` and, with _optional_, the site's switch _Changes need a second person_ ([PLANT.md](PLANT.md#change-sets), [ASSURANCE.md](ASSURANCE.md)). Without review, edits and imports apply at once; with it, they become proposed change sets under _Plant → Changes_. Try it once: propose a change as an operator and apply it as someone else.

By the evening: one site with profiles and KPIs, and a review rule the team agreed on.

## What to leave for later

- **Schedules** for the process of day 2: once it has run for real a few times by hand ([GETTING-STARTED.md](GETTING-STARTED.md#8-build-and-run-the-first-process)).
- **More sites, monitors and processes**: copy what worked in week one (_Duplicate_, [TEAMS.md](TEAMS.md#duplicating)) and use templates for many machines ([MONITORS.md](MONITORS.md#templates-for-many-machines)).
- **Duties, objectives and the scorecard**: once services and monitors have a few weeks of history ([DUTIES.md](DUTIES.md), [SCORECARD.md](SCORECARD.md)).
- **Reports, evidence packs and dashboards** for auditors and management ([REPORTS.md](REPORTS.md), [DASHBOARDS.md](DASHBOARDS.md)).
- **AI assistants over MCP**: after the team knows its processes and platforms ([MCP.md](MCP.md)).
- **Approvals in Teams** (the Teams bot, a preview): needs an Entra app, an Azure Bot and inbound HTTPS from Microsoft ([TEAMS-APPROVALS.md](TEAMS-APPROVALS.md)).
- **Git sync and shared libraries**: when more than one instance or team shares procedures ([GIT-SYNC.md](GIT-SYNC.md), [LIBRARIES.md](LIBRARIES.md)).
- **Hardening before you go live**: the checklist in [SECURITY-HARDENING.md](SECURITY-HARDENING.md) and [GETTING-STARTED.md](GETTING-STARTED.md#12-before-you-go-live).
