# Example library: service management & housekeeping

Ready-to-use procedures for **Siemens Insights Hub**, **Industrial Edge Management** and the **Gatus** uptime monitor, plus dashboards that show their results.

- **Processes** (`processes/*.yaml`) appear in the app under **Processes → From template**.
- **Dashboards** (`dashboards/*.yaml`) appear under **Dashboards → From template**.
- **Demo mode** (`npm run demo` → _Load demo data_) imports everything, schedules the read-only "feeder" processes and runs them once. The dashboards are filled right away against the simulated platforms.

The processes are written in the compact sequential YAML format and become node graphs when imported. You can edit them on the canvas afterwards.

## Catalogue

"Writes" means the process changes data on the platform. Write calls are only simulated in dry runs, and every destructive step asks for confirmation.

| #   | Process                                                | Purpose                                                                                                                                         | Suggested schedule                   | Writes                   | Datasets published                           |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------ | -------------------------------------------- |
| 10  | Insights Hub – Access review 1: flag inactive users    | Find users without login for N days, confirm, add them to a review group                                                                        | quarterly                            | yes (group membership)   | –                                            |
| 11  | Insights Hub – Access review 2: decide and clean up    | Owners tick who keeps access; the rest lose memberships or are deleted (approval)                                                               | quarterly, 2–4 weeks after #10       | yes                      | –                                            |
| 12  | Insights Hub – Privileged access review                | Attest every TenantAdmin (or other privileged) assignment; removal needs a second person (four-eyes)                                            | monthly                              | yes (role removal)       | `ih.privileged`                              |
| 13  | Insights Hub – Offboard leavers                        | Paste leavers; look up, confirm (four-eyes), remove all memberships or delete; unknown names only warn                                          | on demand / daily from HR export     | yes                      | –                                            |
| 14  | Insights Hub – Group and role hygiene                  | Empty groups, single-member groups, users with only the default role                                                                            | weekly                               | no                       | `ih.groups`                                  |
| 15  | Insights Hub – Inventory snapshot                      | Users (activity, admin flag), groups, assets and attributes per type                                                                            | hourly                               | no                       | `ih.users`, `ih.groups-summary`, `ih.assets` |
| 16  | Insights Hub – Access snapshot                         | Who has which role and group, as the dataset an access reconciliation check reads (works as a template for any platform)                        | daily                                | no                       | `ih.access-snapshot`                         |
| 20  | Insights Hub – Onboard users with group bundles        | CSV of new users plus a role bundle; creates missing users and adds missing memberships                                                         | on demand                            | yes                      | –                                            |
| 30  | Insights Hub – Asset attribute optimization check      | Unused variables, silent assets and stale aspects, with the attribute saving potential                                                          | daily / weekly                       | no                       | `ih.attribute-optimization`                  |
| 31  | Insights Hub – Data freshness monitor                  | Newest time-series value per asset and aspect, against warning/critical age                                                                     | hourly                               | no                       | `ih.data-freshness`                          |
| 32  | Insights Hub – Tenant usage and licence check          | Users, assets, agents, credits and storage against the licence; warning at 80 %, critical at 95 % (inputs), failing checks notify               | daily                                | no                       | `ih.usage`                                   |
| 40  | Insights Hub – Platform health check                   | Reachability and latency of core services                                                                                                       | every 15 min                         | no                       | `ih.health`                                  |
| 50  | Industrial Edge – Device status check                  | Online/offline per device (light-weight)                                                                                                        | 30–60 min                            | no                       | `iem.device-status`                          |
| 51  | Industrial Edge – Inventory snapshot                   | Devices (state, firmware compliance, offline duration) and the app catalog                                                                      | hourly                               | no                       | `iem.devices`, `iem.apps`                    |
| 52  | Industrial Edge – Firmware compliance                  | Devices below the minimum firmware of your baseline                                                                                             | daily                                | no                       | `iem.firmware`                               |
| 53  | Industrial Edge – Stale device cleanup                 | Devices offline for N+ days; select and remove (four-eyes)                                                                                      | monthly                              | yes (device delete)      | –                                            |
| 54  | Industrial Edge – App version compliance               | Installed app versions per device against the catalog                                                                                           | daily                                | no                       | `iem.app-compliance`                         |
| 60  | Browser – Portal login and status screenshot           | Sign in to a portal and keep a screenshot as evidence                                                                                           | daily                                | no                       | –                                            |
| 70  | Generic – Endpoint availability check                  | One check per endpoint of any API                                                                                                               | 15–60 min                            | no                       | –                                            |
| 71  | Gatus – uptime overview                                | Status, uptime, response times and last error of every Gatus endpoint; warns while endpoints are down                                           | every 10 min                         | no                       | `gatus-uptime`                               |
| 72  | Gatus – report Steward check to Gatus                  | Runs a check and pushes the result to a Gatus external endpoint                                                                                 | 5–15 min (below the Gatus heartbeat) | yes (Gatus result)       | –                                            |
| 73  | Diagnose endpoint outage (from Gatus alert)            | Runbook for a webhook trigger: Gatus history, probe below the probe platform, evidence, approval (four-eyes) before the placeholder remediation | started by a Gatus alert             | no (example placeholder) | –                                            |
| 81  | Cross-platform – Weekly service report                 | Reachability and key figures of both platforms in one report                                                                                    | weekly (Mon 07:00)                   | no                       | `platform.service-report`                    |
| 85  | Industrial Edge – Replace an Edge device on site       | Manual procedure: checklists, fields, evidence photos; the replacement and the final check are verified by a second person (maker–checker)      | on demand                            | no (manual work)         | –                                            |
| 90  | Building block – Resolve an Insights Hub group         | Reusable sub-process: group/role by name → id and members (returned as `outputs`)                                                               | – (called by other processes)        | no                       | –                                            |
| 91  | Insights Hub – Add users to a group (with sub-process) | Resolves the group via #90 as a sub-process, looks up users in parallel, adds missing memberships after approval                                | on demand                            | yes (group membership)   | –                                            |

Process 85 is a **manual procedure**: people do the work outside Steward and document it step by step (see [docs/MANUAL-STEPS.md](../docs/MANUAL-STEPS.md)). In the process editor, _New manual procedure_ starts one from scratch.

Processes 11, 12, 13 and 20 document the access changes they make with the step _Document access change_: when such a run ends, Steward creates the access change entries, linked to the run and its PDF protocol (see [docs/COMPLIANCE.md](../docs/COMPLIANCE.md)).

## Dashboards

| Dashboard           | Shows                                                                                                                                                                         | Fed by                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Platform operations | KPIs for users, inactive users, admins, saving potential, devices online/offline/outdated, stale data; trends; status distributions; problem tables; health checks; freshness | 15, 30, 31, 40, 51 (+12 for privileged access) |
| Access governance   | User activity, privileged access, group hygiene, review cadence                                                                                                               | 15, 12, 14                                     |
| Edge fleet          | Connectivity, firmware and app versions, application catalog                                                                                                                  | 51, 52, 54                                     |
| Uptime              | Endpoints, endpoints down, average uptime, status distribution, problem table, freshness                                                                                      | 71                                             |
| Tenant usage        | Credits, storage, users, assets and agents in % of the licence; trends; figures above the warning level                                                                       | 32                                             |

Dashboards only read stored datasets: opening them never calls a platform. A dataset shows as _stale_ when it is older than the publishing step's `staleAfterMinutes`. That threshold is set to roughly 2–3× the suggested schedule, so a missed run becomes visible. _Refresh_ on a dashboard re-runs the feeding processes with the inputs and connections of their last run.

## Recommended operating model

1. **Dry run first.** Start every new or changed process as a dry run. Read calls are real, writes are only recorded, and the protocol shows exactly what would change.
2. **Schedule the read-only feeders.**
   - Inventories and the data freshness monitor: hourly.
   - Health checks: every 15 minutes.
   - Compliance checks: daily.
   - Hygiene: weekly.

   Schedules run with the rights of their owner, so use a service-desk account rather than a personal admin.

3. **Put a second person on destructive steps.** Privileged role removal, offboarding and device deletion use `fourEyes: true` and `assignees: [role:approver, role:admin]`. Keep it that way for production.
4. **Run attestations on a fixed cadence and keep the protocols.**
   - Access review 1 + 2: quarterly.
   - Privileged access review: monthly and after organisational changes.

   Download the run protocol (PDF) as audit evidence; the audit log links every decision to a person.

5. **Use thresholds as inputs, not code.** Inactivity days, firmware baseline and age limits are inputs. Store your values in the schedule rather than editing the flow.
6. **Keep the snapshots small.** The publish steps project only the columns a dashboard needs. Metrics are kept as history for trends; rows are replaced on every run.

## Verify against your environment

The flows were built against the documented Insights Hub APIs and the simulated platforms. Check these points with a dry run and the platform's **API explorer** before relying on the results:

- **Insights Hub `lastLogonTime`:** returned by the user API, but not in the official spec (used by #10–#15).
- **Insights Hub API paths:** taken from the platform variables `idmPath`, `assetPath` and `tsPath`, which matters for the new `siemens.app` gateway.
- **IEM device fields:** `connectionState`, `deviceStatus`, `lastSeen` and `firmware` differ between IEM releases. The state field and online value are inputs; adapt the firmware/lastSeen expressions if needed.
- **Insights Hub usage (#32):** the aggregated usage path of the Usage Transparency Service and the agent paging fields are assumptions. See [docs/INSIGHTS-HUB-USAGE.md](../docs/INSIGHTS-HUB-USAGE.md).
- **IEM per-device apps:** `GET /portal/api/v1/devices/{id}/apps` (#54) is an assumption. Check the Portal API reference of your release.
- **IEM device deletion:** `DELETE /portal/api/v1/devices/{id}` (#53) is an assumption as well.
- **Gatus (#71–#73):** built against the Gatus API of v5.37 (README and source, checked 2026-10-22). Setup, Gatus configuration snippets (monitoring Steward, external endpoints, custom alerts to a webhook trigger) and security notes are in [docs/GATUS.md](../docs/GATUS.md).

## Importing

- **One template:** in the app, go to **Processes → From template**, or to **Dashboards → From template**.
- **Your own YAML:** use **Processes → Import YAML**, or the YAML/import option on the Dashboards page.
- **Many at once:** use a bundle (`GET /api/bundle/export` / `POST /api/bundle/import`). A bundle carries processes and dashboards together, e.g. from a test to a production instance.
- **Share with the team:** drop files into `examples/processes` or `examples/dashboards` and commit them. They show up as templates after a restart.

## Monitors

`monitors/*.yaml` are monitor definitions (`kind: monitor`) and templates (`kind: monitorTemplate`), importable under **Monitors → Import → From the example library** and checked by `npm run validate`. Import them in file order (a sub-monitor before the monitor that includes it). See [docs/MONITORS.md](../docs/MONITORS.md).

| #   | Monitor                                 | What it shows                                                                                                 |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 10  | Machine 17 – machine data               | Heartbeat of on-change machine data (maximum age) and its freshness in Insights Hub                           |
| 11  | Machine 17 – PowerMeter                 | PowerMeter reachable → data reported by the gateway → data in Insights Hub; the machine data as a sub-monitor |
| 20  | Plant services                          | Steward's own HTTP and platform checks next to Gatus endpoints, with a dependency between two Gatus endpoints |
| 30  | PowerMeter with machine data (template) | Parameters for IP address, assets, cadence; create one monitor per machine from a CSV                         |
