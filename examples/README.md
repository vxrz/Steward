# Example library: service management & housekeeping

Ready-to-use procedures, dashboards and monitors for **Siemens Insights Hub**, **Industrial Edge Management**, **Gatus**, **changedetection.io**, **CheckMk**, **Prometheus**, **Kubernetes**, the Git hosts **GitHub, GitLab and Forgejo**, **Kafka** and **Kafka Connect**, **Dependency-Track**, **Snowflake**, **AWS**, **MQTT**, **IBM Verify Privilege Vault** and the service catalogue (applications, tech stacks, end of life).

- **Processes** (`processes/*.yaml`) appear in the app under **Processes → From template**. The gallery shows which platforms a template needs, when to run it and which dashboards it feeds (see [Template metadata](#template-metadata)).
- **Dashboards** (`dashboards/*.yaml`) appear under **Dashboards → From template**.
- **Template bundles** (`bundles/*.yaml`) appear under **Processes → From template → Set up together**: processes, a dashboard, schedules and monitors set up in one go (see [Template bundles](#template-bundles)).
- **Monitors** (`monitors/*.yaml`) appear under **Monitors → Import → From the example library**.
- **Libraries** (`libraries/*/`, 0.10.0): a shared procedure library – a signed, versioned set of items installed after a review under **Automate → Libraries** ([docs/LIBRARIES.md](../docs/LIBRARIES.md)). The example is signed with a **test key** (`libraries/TEST-PUBLISHER-KEY.pub`) that no installation trusts by default.
- **Example triggers** (`triggers/*.yaml`) are offered in the webhook trigger editor: their input mapping (_Map: …_) when the chosen process has the inputs, and the sender's setup in the secret dialog (see [Example triggers](#example-triggers)).
- **Demo mode** (`npm run demo` → _Load demo data_) imports everything, creates two sample applications whose components point to the simulated platforms, schedules the read-only "feeder" processes and runs them once. The dashboards of the feeders fill within a minute or two. The dashboards and tables fed by reviews with a person in the loop (privileged access review, Snowflake project access review, Git member review) stay empty until you run such a review yourself.

The processes are written in the compact sequential YAML format and become node graphs when imported. You can edit them on the canvas afterwards.

## Catalogue

"Writes" means the process changes data on the platform. Write calls are only simulated in dry runs, and every destructive step asks for confirmation.

| #   | Process                                                                | Purpose                                                                                                                                                                                                                                                    | Suggested schedule                   | Writes                              | Datasets published                                        |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------- | --------------------------------------------------------- |
| 10  | Insights Hub – Access review 1: flag inactive users                    | Find users without login for N days, confirm, add them to a review group                                                                                                                                                                                   | quarterly                            | yes (group membership)              | –                                                         |
| 11  | Insights Hub – Access review 2: decide and clean up                    | Owners tick who keeps access; the rest lose memberships or are deleted after a second person confirms (four-eyes)                                                                                                                                          | quarterly, 2–4 weeks after #10       | yes                                 | –                                                         |
| 12  | Insights Hub – Privileged access review                                | Attest every TenantAdmin (or other privileged) assignment; removal needs a second person (four-eyes)                                                                                                                                                       | monthly                              | yes (role removal)                  | `ih.privileged`                                           |
| 13  | Insights Hub – Offboard leavers                                        | Paste leavers; look up, confirm (four-eyes), remove all memberships or delete; unknown names only warn                                                                                                                                                     | on demand / daily from HR export     | yes                                 | –                                                         |
| 14  | Insights Hub – Group and role hygiene                                  | Empty groups, single-member groups, users with only the default role                                                                                                                                                                                       | weekly                               | no                                  | `ih.groups`                                               |
| 15  | Insights Hub – Inventory snapshot                                      | Users (activity, admin flag), groups, assets and attributes per type                                                                                                                                                                                       | hourly                               | no                                  | `ih.users`, `ih.groups-summary`, `ih.assets`              |
| 16  | Insights Hub – Access snapshot                                         | Who has which role and group, as the dataset an access reconciliation check reads (works as a template for any platform)                                                                                                                                   | daily                                | no                                  | `ih.access-snapshot`                                      |
| 20  | Insights Hub – Onboard users with group bundles                        | CSV of new users plus a role bundle; creates missing users and adds missing memberships                                                                                                                                                                    | on demand                            | yes                                 | –                                                         |
| 21  | Entra ID – Guest user review                                           | Guests with invitation state, last sign-in and groups; attest → four-eyes → manual deletion with maker–checker → access changes (offboarding)                                                                                                              | quarterly                            | no (removal by hand, documented)    | `entra.guests`                                            |
| 22  | Entra ID – Privileged directory role review                            | Active and eligible (PIM) assignments of privileged roles to users, groups and service principals; attest → four-eyes → manual removal → access changes                                                                                                    | monthly                              | no (removal by hand, documented)    | `entra.privileged-roles`                                  |
| 23  | Entra ID – Stale accounts                                              | Enabled accounts without a sign-in for N days or never signed in, disabled accounts still in groups                                                                                                                                                        | weekly                               | no                                  | `entra.stale-accounts`                                    |
| 24  | Entra ID – Group owner and membership review                           | Members (direct and nested) and owners of chosen groups; groups without owner, guests, disabled accounts; attest → four-eyes → manual removal                                                                                                              | quarterly                            | no (removal by hand, documented)    | `entra.group-members`                                     |
| 25  | Entra ID – Expiring app secrets and certificates                       | Client secrets and certificates of app registrations and enterprise applications: expired, ending within N days, replaced and left over                                                                                                                    | daily                                | no                                  | `entra.app-credentials`                                   |
| 30  | Insights Hub – Asset attribute optimisation check                      | Unused variables, silent assets and stale aspects, with the attribute saving potential                                                                                                                                                                     | daily / weekly                       | no                                  | `ih.attribute-optimization`                               |
| 31  | Insights Hub – Data freshness monitor                                  | Newest time-series value per asset and aspect, against warning/critical age                                                                                                                                                                                | hourly                               | no                                  | `ih.data-freshness`                                       |
| 32  | Insights Hub – Tenant usage and licence check                          | Users, assets, agents, asset attributes per type and an optional Usage Transparency KPI against your licence; warning at 80 %, critical at 95 % (inputs), failing checks notify                                                                            | daily                                | no                                  | `ih.usage`, `ih.usage-attributes`                         |
| 40  | Insights Hub – Platform health check                                   | Reachability and latency of core services                                                                                                                                                                                                                  | every 15 min                         | no                                  | `ih.health`                                               |
| 50  | Industrial Edge – Device status check                                  | Online/offline per device (light-weight)                                                                                                                                                                                                                   | 30–60 min                            | no                                  | `iem.device-status`                                       |
| 51  | Industrial Edge – Inventory snapshot                                   | Devices (state, firmware compliance, offline duration) and the app catalog                                                                                                                                                                                 | hourly                               | no                                  | `iem.devices`, `iem.apps`                                 |
| 52  | Industrial Edge – Firmware compliance                                  | Devices below the minimum firmware of your baseline                                                                                                                                                                                                        | daily                                | no                                  | `iem.firmware`                                            |
| 53  | Industrial Edge – Stale device cleanup                                 | Devices offline for N+ days; select and remove (four-eyes)                                                                                                                                                                                                 | monthly                              | yes (device delete)                 | –                                                         |
| 54  | Industrial Edge – App version compliance                               | Installed app versions per device against the catalog                                                                                                                                                                                                      | daily                                | no                                  | `iem.app-compliance`                                      |
| 60  | Browser – Portal login and status screenshot                           | Sign in to a portal and keep a screenshot as evidence                                                                                                                                                                                                      | daily                                | no                                  | –                                                         |
| 61  | Snowflake – Project access review (database grants)                    | `SHOW GRANTS ON DATABASE` → roles → `SHOW GRANTS OF ROLE` (nested roles followed to the users, with the path); users enriched from `ACCOUNT_USAGE.USERS`, technical users marked; attest → four-eyes → manual `REVOKE` with maker–checker → access changes | quarterly                            | no (revocation by hand, documented) | `snowflake.project-access`                                |
| 62  | Snowflake – Account hygiene and usage                                  | Inactive people, password sign-ins without MFA, technical users with passwords, ACCOUNTADMIN/SECURITYADMIN holders, disabled users with roles, warehouse credits 7/30 days, failed tasks                                                                   | daily                                | no                                  | `snowflake.users`, `snowflake.credits`, `snowflake.tasks` |
| 63  | AWS – IAM access key age and unused credentials                        | Active keys to rotate, active keys unused, inactive keys left, unused console passwords – from the cloud accounts of the applications                                                                                                                      | daily                                | no                                  | `aws.iam-keys`                                            |
| 64  | AWS – Costs per application                                            | Last month, the month before, change, this month so far and the average per application tag (Cost Explorer, via the cloud accounts)                                                                                                                        | monthly (3rd)                        | no                                  | `aws.costs`                                               |
| 65  | Prometheus – SLO and error-budget report                               | Availability over the objective window per service from your PromQL, error budget left, burn rate 1 h / 6 h, fast burn                                                                                                                                     | weekly (Mon 07:00)                   | no                                  | `prom.slo`                                                |
| 70  | Generic – Endpoint availability check                                  | One check per endpoint of any API                                                                                                                                                                                                                          | 15–60 min                            | no                                  | –                                                         |
| 71  | Gatus – Uptime overview                                                | Status, uptime, response times and last error of every Gatus endpoint; warns while endpoints are down                                                                                                                                                      | every 10 min                         | no                                  | `gatus-uptime`                                            |
| 72  | Gatus – Report a Steward check to Gatus                                | Runs a check and pushes the result to a Gatus external endpoint                                                                                                                                                                                            | 5–15 min (below the Gatus heartbeat) | yes (Gatus result)                  | –                                                         |
| 73  | Gatus – Diagnose an endpoint outage (from an alert)                    | Runbook for a webhook trigger: Gatus history, probe below the probe platform, evidence, approval (four-eyes) before the placeholder remediation                                                                                                            | started by a Gatus alert             | no (example placeholder)            | –                                                         |
| 74  | Gatus – Uptime overview (from /metrics)                                | The same overview for a Gatus behind OIDC: reads only `/metrics` and the open uptime API, adds TLS certificate expiry; no Gatus login needed                                                                                                               | every 10 min                         | no                                  | `gatus-uptime-metrics`                                    |
| 76  | changedetection.io – Review a changed page (from a notification)       | Runbook for a webhook trigger: a changedetection.io notification names a watch; it is looked up (metadata only), a person reviews the diff and notes a vendor ticket or follow-up ([docs/CHANGEDETECTION.md](../docs/CHANGEDETECTION.md))                  | started by a notification            | no                                  | –                                                         |
| 77  | End of life – Tech stack overview                                      | Every component and system of the applications with the end of life of its release cycle (from endoflife.date); warns about versions past it                                                                                                               | weekly                               | no                                  | `eol-overview`                                            |
| 78  | CheckMk – Trend summary                                                | Metric history of chosen hosts and services from CheckMk: average, peak, time above WARN/CRIT, week-on-week change, days until CRIT; checks for levels crossed and series heading for CRIT; a morning report                                               | daily (07:00)                        | no                                  | `checkmk.trends`                                          |
| 79  | Kubernetes – Namespace health                                          | Deployments (ready replicas, images), pods not well and cert-manager certificates of the namespaces you list; checks for deployments not ready, crash-looping pods and certificates ending soon                                                            | every 15 min                         | no                                  | `k8s.health`                                              |
| 81  | Cross-platform – Weekly service report                                 | Reachability and key figures of both platforms in one report                                                                                                                                                                                               | weekly (Mon 07:00)                   | no                                  | `platform.service-report`                                 |
| 82  | Git – Repository health (GitHub, GitLab, Forgejo)                      | Default branch protected, newest pipeline on it, latest release, Dependabot alerts (GitHub), deploy and access tokens expiring (GitLab); one schedule per host                                                                                             | hourly                               | no                                  | `git.repositories`                                        |
| 83  | Kafka – Topic standards                                                | Partitions, replication, min.insync.replicas, retention, schema, newest message and consumer lag of the topics of applications against your standards                                                                                                      | daily                                | no                                  | `kafka.topics`                                            |
| 84  | Kafka – Schema change review                                           | The Schema Registry checks a proposed schema against the current version; an approver decides                                                                                                                                                              | on demand / from CI                  | no                                  | –                                                         |
| 85  | Industrial Edge – Replace an Edge device on site                       | Manual procedure: checklists, fields, evidence photos; the replacement and the final check are verified by a second person (maker–checker)                                                                                                                 | on demand                            | no (manual work)                    | –                                                         |
| 86  | Dependency-Track – Vulnerabilities per project                         | Open findings by severity and policy violations of the latest project versions                                                                                                                                                                             | every 6 hours                        | no                                  | `dt.vulnerabilities`                                      |
| 87  | Firewall change via provider                                           | Manual procedure: request, four-eyes approval, submit to the provider (ticket), the provider's confirmation as evidence, HTTP connectivity check, verification by a second person, close ([docs/FIREWALL-CHANGES.md](../docs/FIREWALL-CHANGES.md))         | on demand (one run per change)       | no (manual work)                    | –                                                         |
| 90  | Building block – Resolve an Insights Hub group                         | Reusable sub-process: group/role by name → id and members (returned as `outputs`)                                                                                                                                                                          | – (called by other processes)        | no                                  | –                                                         |
| 91  | Insights Hub – Add users to a group (with sub-process)                 | Resolves the group via #90 as a sub-process, looks up users in parallel, adds missing memberships after approval and documents them                                                                                                                        | on demand                            | yes (group membership)              | –                                                         |
| 92  | Git – Member and outside-collaborator review (GitHub, GitLab, Forgejo) | Owners, members, outside collaborators, 2FA and last activity where the host offers them; attest → four-eyes → manual removal with maker–checker → access changes                                                                                          | quarterly                            | no (removal by hand, documented)    | `git.members`                                             |
| 93  | IBM Verify Privilege Vault – Secret hygiene                            | Failed heartbeats, passwords not rotated or expired, automatic changing off, secrets without an owner, privileged secrets without checkout or approval (metadata only, never a value)                                                                      | daily                                | no                                  | `pv.hygiene`                                              |
| 94  | IBM Verify Privilege Vault – Privileged use                            | Views, checkouts, password displays, edits and access requests of the privileged secrets in the last days                                                                                                                                                  | weekly (8 days)                      | no                                  | `pv.privileged-use`                                       |
| 95  | CheckMk – AI summary of the trends                                     | Asks an AI model through an LLM gateway which CheckMk trends need attention (JSON answer checked against a schema), a second person approves, then a report and a check marked as AI-generated ([docs/AI.md](../docs/AI.md))                               | weekly (Mon 07:30)                   | no                                  | –                                                         |

Processes 85 and 87 are **manual procedures**: people do the work outside Steward and document it step by step (see [docs/MANUAL-STEPS.md](../docs/MANUAL-STEPS.md)). In the process editor, _New manual procedure_ starts one from scratch.

Processes 11, 12, 13, 20, 21, 22, 24, 61, 91 and 92 document the access changes they make with the step _Document access change_: when such a run ends, Steward creates the access change entries, linked to the run and its PDF protocol (see [docs/COMPLIANCE.md](../docs/COMPLIANCE.md)). The Snowflake, Git and Entra ID connections are read-only: 21, 22, 24, 61 and 92 show the statements or commands to run as a manual step, which a second person verifies before the changes are documented.

Every process that removes access asks a second person first (`fourEyes: true`, `assignees: [role:approver, role:admin]`): 11, 12, 13, 21, 22, 24, 53, 61 and 92. The access reviews share the tag `access-review`.

## Dashboards

| Dashboard              | Shows                                                                                                                                                                         | Fed by                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Platform operations    | KPIs for users, inactive users, admins, saving potential, devices online/offline/outdated, stale data; trends; status distributions; problem tables; health checks; freshness | 15, 30, 31, 40, 51 (+12 for privileged access) |
| Access governance      | User activity, privileged access, group hygiene, Git members and Snowflake project access of the latest reviews, review cadence                                               | 15, 12, 14, 61, 92                             |
| Edge fleet             | Connectivity, firmware and app versions, app catalogue                                                                                                                        | 51, 52, 54                                     |
| Uptime                 | Endpoints, endpoints down, average uptime, status distribution, problem table, freshness                                                                                      | 71                                             |
| Uptime (from /metrics) | The same for a Gatus behind OIDC, plus certificates expiring                                                                                                                  | 74                                             |
| Tenant usage           | Credits, storage, users, assets and agents in % of the licence; trends; figures above the warning level                                                                       | 32                                             |
| End of life            | Components past their end of life, ending soon, supported and without data; trend; tables of what to upgrade                                                                  | 77                                             |
| Snowflake account      | Users, inactive people, passwords without MFA, technical users with passwords, ACCOUNTADMIN holders, credits 7/30 days, failed tasks, the latest project access review        | 62, 61                                         |
| Cloud costs and keys   | AWS costs per application and month, keys to rotate, unused and inactive keys                                                                                                 | 64, 63                                         |
| Service levels         | Availability, error budget left and burn rate per service; services below the objective                                                                                       | 65                                             |
| CheckMk trends         | Levels crossed, series heading for CRIT, averages and peaks                                                                                                                   | 78                                             |
| Kubernetes             | Deployments not ready, crash-looping pods, certificates ending soon                                                                                                           | 79                                             |
| Repositories           | Default branches failing or not protected, critical and high alerts, tokens expiring – GitHub, GitLab and Forgejo                                                             | 82                                             |
| Kafka topics           | Topics not to standard, lagging consumers, quiet topics                                                                                                                       | 83                                             |
| Vulnerabilities        | Open critical and high findings and failing policies per project                                                                                                              | 86                                             |
| Entra ID governance    | Guests, privileged directory roles (Global Administrators, PIM), stale accounts, groups without owner, app secrets and certificates ending                                    | 25, 23, 22, 21, 24                             |
| Vault hygiene          | Secrets of IBM Verify Privilege Vault needing attention and the privileged use                                                                                                | 93, 94                                         |
| AI usage               | Tokens today and this month against the budgets, calls, refused and failed calls, use per gateway, model and process                                                          | the built-in dataset `ai.usage` (no process)   |

Dashboards only read stored datasets: opening them never calls a platform. A dataset shows as _stale_ when a run is overdue. For runs without a schedule the publishing step's `staleAfterMinutes` is the limit; the examples set it to about twice the suggested schedule (three times for schedules of an hour or less): 180 for hourly, 2880 for daily, 20160 for weekly, 89280 for monthly and 264960 for quarterly processes. _Refresh_ on a dashboard re-runs the feeding processes with the inputs and connections of their last run.

## Dashboards in other tools

These live in [`integrations/`](../integrations) rather than here, because they are not Steward definitions (the validator and Git sync read every YAML and JSON file in `examples/`). They show how to build on the published datasets elsewhere, through the read-only API.

- **Streamlit** ([integrations/streamlit](../integrations/streamlit/README.md)): a small Python app with uptime from the metric history (71/74), the privileged access review (12, 16) and a place to join other data sources.
- **Grafana** ([integrations/grafana](../integrations/grafana/README.md)): Infinity data source provisioning and two dashboards, uptime over time and every dataset with its rows and metrics.

When to use them instead of Steward's dashboards, the API calls, tokens and security notes: [docs/EXTERNAL-DASHBOARDS.md](../docs/EXTERNAL-DASHBOARDS.md).

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

- **Insights Hub `lastLogonTime`:** returned by the user API, but not in the official spec (used by #10–#15). Tenants send an ISO date-time **or epoch milliseconds**, and leave it out or send `null` for people who never signed in. The examples read it with `$ts(lastLogonTime)` (milliseconds, or nothing when empty) and show it with `$fromMillis(…)`; `$exists()` alone is not enough, it is true for `null`. The same applies to `lastSeen` of Industrial Edge devices (#50–#53).
- **Insights Hub API paths:** taken from the platform variables `idmPath`, `assetPath` and `tsPath`, which matters for the new `siemens.app` gateway.
- **IEM device fields:** `connectionState`, `deviceStatus`, `lastSeen` and `firmware` differ between IEM releases. The state field and online value are inputs; adapt the firmware/lastSeen expressions if needed.
- **Insights Hub usage (#32):** the aggregated usage path of the Usage Transparency Service and the agent paging fields are assumptions. See [docs/INSIGHTS-HUB-USAGE.md](../docs/INSIGHTS-HUB-USAGE.md).
- **IEM per-device apps:** `GET /portal/api/v1/devices/{id}/apps` (#54) is an assumption. Check the Portal API reference of your release.
- **IEM device deletion:** `DELETE /portal/api/v1/devices/{id}` (#53) is an assumption as well.
- **Gatus (#71–#74):** built against the Gatus API of v5.37 (README and source, checked 2026-10-22). Setup, Gatus configuration snippets (monitoring Steward, external endpoints, custom alerts to a webhook trigger) and security notes are in [docs/GATUS.md](../docs/GATUS.md).
- **Snowflake (#61, #62):** statements go to the SQL API (`POST /api/v2/statements`) of the Snowflake platform with its key-pair JWT; values are bind parameters, database and role names are checked against `^[A-Za-z0-9_$."-]+$` and always sent as quoted identifiers (unquoted names in upper case, as Snowflake stores them). `SHOW GRANTS OF ROLE` lists the grantees only for a role with MANAGE GRANTS or the ownership of the role; `ACCOUNT_USAGE.USERS` needs IMPORTED PRIVILEGES on the SNOWFLAKE database and a warehouse. `HAS_MFA` is a newer column of the USERS view – remove it from the statement if your account does not have it. Results larger than the first partition of the SQL API (some thousand rows) are cut. See [docs/SNOWFLAKE.md](../docs/SNOWFLAKE.md#templates).
- **Git hosts (#82, #92):** GitHub's `filter=2fa_disabled` needs an organisation owner's token, GitLab's last activity (`billable_members`) Premium or Ultimate and its 2FA list an administrator token; without them the columns say "unknown". GitHub has no API for the last activity of members. See [docs/GIT-PLATFORMS.md](../docs/GIT-PLATFORMS.md#templates).
- **AWS (#63, #64):** the processes read what Steward read for the application components of type "Cloud account" – IAM users with the application tag, costs by the tag (activate it as a cost allocation tag). Process http steps cannot sign requests for other AWS services yet, so the templates do not call AWS themselves. See [docs/AWS.md](../docs/AWS.md#templates).
- **Prometheus (#65):** the query is yours; it must return one series per service with the share of good requests (0…1), `$window` is replaced by the window. Long windows (28 days) are expensive on a plain Prometheus – a recording rule helps.

## Importing

- **One template:** in the app, go to **Processes → From template**, or to **Dashboards → From template**.
- **Your own YAML:** use **Processes → Import YAML**, or the YAML/import option on the Dashboards page.
- **Templates that belong together:** a [template bundle](#template-bundles) sets up processes, their dashboard, schedules and monitors in one go (**Processes → From template → Set up together**).
- **Many at once:** use an export package (`GET /api/bundle/export` / `POST /api/bundle/import`, _Processes → … → Export all processes & dashboards_). A package carries processes and dashboards together, e.g. from a test to a production instance. (The API still calls it a bundle; it is not a template bundle.)
- **Share with the team:** drop files into `examples/processes` or `examples/dashboards` and commit them. They show up as templates after a restart.
- **Keep them up to date:** turn on the Git sync source **Steward example library** (_Settings → Git sync_; it exists disabled in every installation since 0.2.1). It follows the tag of your Steward version (`v{version}`), so improved examples of that release arrive in **Updates from Git** for review, and after an upgrade those of the new release. Allow `api.github.com` in the outbound policy first. See [docs/GIT-SYNC.md](../docs/GIT-SYNC.md#stewards-example-library).

### Files for a newer Steward

An example that uses something a release added says so in a comment line at the top, e.g. `# steward-min-version: 0.2.6`. Git sync lists it as _Needs Steward 0.2.6 or newer_ on older installations instead of staging it; for every importer it is a plain comment, so the file still imports into older versions as before. The examples for the platforms added after 0.2.0 carry it: 77, 78, 79 and 65 (0.2.6: `$systems()`, CheckMk, Kubernetes, Prometheus), 82, 83, 84 and 92 (0.2.7: Git hosts, Kafka), 61–64 (0.2.8: Snowflake, AWS) 86 (0.2.9: Dependency-Track) and 87–88 (0.5.0: IBM Verify Privilege Vault, `morePath` paging). The others work with 0.2.0. Add the line when an example starts to use a function, node, platform or field of a newer release.

### Template metadata

`GET /api/templates` returns, besides `id`, `name`, `description`, `tags` and `definition`, what the template gallery needs to search and filter (0.3.1):

```json
{
  "id": "61-snowflake-project-access-review",
  "connections": [{ "slot": "snowflake", "kinds": ["snowflake"], "description": "Snowflake account (SQL API, key-pair JWT; read-only)" }],
  "connectionKinds": ["snowflake"],
  "recommendedSchedule": { "cron": "0 7 1 1,4,7,10 *", "text": "quarterly (`0 7 1 1,4,7,10 *`) and when a project ends" },
  "datasets": ["snowflake.project-access"],
  "dashboards": [
    { "id": "20-access-governance", "name": "Access governance" },
    { "id": "61-snowflake-account", "name": "Snowflake account" }
  ],
  "minVersion": "0.2.8"
}
```

- `connections`: per connection slot the platform kinds that fit – the slot's `kind`, or for a slot that takes several kinds the optional `kinds` list of the template (`kinds: [github, gitlab, forgejo]`); empty: any platform. `connectionKinds` is the sorted union.
- `recommendedSchedule`: `text` is the sentence after "Recommended schedule:" in the description; `cron` comes from the optional top-level field `recommendedSchedule: "0 7 * * 1"`, else from the first cron expression in backticks in that sentence, else null ("on demand"). `null` when the description has no such sentence – every example has one.
- `datasets`: the keys its publish steps write; `dashboards`: the dashboard templates that read one of them.
- `minVersion`: the `# steward-min-version` comment, or null.

`recommendedSchedule` and `connections[].kinds` are hints for the gallery only: the process schema does not keep them, so a process created from the template does not carry them and older versions ignore them.

## Template bundles

`bundles/*.yaml` (0.4.0) are sets of templates that belong together – the processes that feed a dashboard, their recommended schedules and optional monitors. The template gallery lists them as **Set up together**; **Set up** asks for the platform(s) to bind and then

1. creates the processes from their templates (ids as from **Use**: `ih-inventory-snapshot`), bound to the chosen platform,
2. creates the dashboards, the **schedules – switched off** – with the template's recommended cron (or the bundle's), and the monitors (optional, **switched off**, their platform references set to the chosen platform),
3. starts **one dry run per process**,
4. shows the result with links and a **Turn on** step for the schedules and monitors.

Re-running a setup finds what exists: processes and dashboards are kept as they are or updated to the template (_Update to the template_, a new process version), schedules of the process and monitors with the example's key are always kept. The setup and the turn-on are audited (`template_bundle.setup`, `template_bundle.turned_on`) besides the entries of every object made. Setting a bundle up needs the right to create processes (designers, administrators) and _use_ on the platform. API: `GET /api/template-bundles`, `POST /api/template-bundles/:id/setup` (`{ bindings: { <key>: <platformId> }, existing: skip | update, monitors, dryRuns }`), `POST /api/template-bundles/:id/turn-on` (`{ schedules, monitors }`).

| Bundle                                   | Platform                   | Processes              | Dashboard            | Monitor (optional)           |
| ---------------------------------------- | -------------------------- | ---------------------- | -------------------- | ---------------------------- |
| 10 Access governance (Insights Hub)      | Insights Hub               | 15, 16, 14, 12, 10, 11 | Access governance    | –                            |
| 20 Tenant usage (Insights Hub)           | Insights Hub               | 32                     | Tenant usage         | –                            |
| 30 Snowflake                             | Snowflake                  | 62, 61                 | Snowflake account    | Snowflake account            |
| 40 Git repositories (health and members) | GitHub, GitLab, Forgejo    | 82, 92                 | Repositories         | Repository pipelines         |
| 50 AWS (access keys and costs)           | AWS                        | 63, 64                 | Cloud costs and keys | –                            |
| 60 Service levels (Prometheus)           | Prometheus                 | 65                     | Service levels       | Error budget burn rate       |
| 70 Kubernetes (namespace health)         | Kubernetes                 | 79                     | Kubernetes           | Kubernetes namespace         |
| 80 Vulnerabilities (Dependency-Track)    | Dependency-Track           | 86                     | Vulnerabilities      | New critical vulnerabilities |
| 15 Entra ID access governance            | Microsoft Graph            | 25, 23, 22, 21, 24     | Entra ID governance  | Entra ID app credentials     |
| 90 Privileged access governance          | IBM Verify Privilege Vault | 93, 94                 | Vault hygiene        | Vault hygiene                |

The format:

```yaml
# steward-min-version: 0.4.0
name: Access governance (Insights Hub)
description: Who has access to the tenant, and is it still justified? …
tags: [access-review, governance, insights-hub]
platforms: # one platform is chosen per entry; required
  - { key: hub, label: Insights Hub tenant, kinds: [insights-hub] }
processes:
  - template: 15-ih-inventory-snapshot # a file in processes/, without .yaml
    schedule: '7 * * * *' # default: the template's recommendedSchedule; "none": no schedule
  - template: 11-ih-access-review-2-decide
    dryRun: false # no dry run after the setup
    # connections: { hub: hub }   slot → platform key (default: the platform whose kinds fit the slot)
    # inputs: { … }               inputs of the schedule and the dry run (default: the template's)
dashboards: [20-access-governance] # files in dashboards/
monitors:
  - { file: 50-snowflake-account.yaml, optional: true } # files in monitors/
```

`npm run validate` checks bundle files too.

## Monitors

`monitors/*.yaml` are monitor definitions (`kind: monitor`) and templates (`kind: monitorTemplate`), importable under **Monitors → Import → From the example library** and checked by `npm run validate`. Import them in file order (a sub-monitor before the monitor that includes it). See [docs/MONITORS.md](../docs/MONITORS.md).

| #   | Monitor                                 | What it shows                                                                                                                                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | Machine 17 – machine data               | Heartbeat of on-change machine data (maximum age) and its freshness in Insights Hub                                                          |
| 11  | Machine 17 – PowerMeter                 | PowerMeter reachable → data reported by the gateway → data in Insights Hub; the machine data as a sub-monitor                                |
| 20  | Plant services                          | Steward's own HTTP and platform checks next to Gatus endpoints, with a dependency between two Gatus endpoints                                |
| 30  | PowerMeter with machine data (template) | Parameters for IP address, assets, cadence; create one monitor per machine from a CSV                                                        |
| 40  | New critical vulnerabilities            | Open critical findings and failing policy violations of production projects in Dependency-Track                                              |
| 50  | Snowflake account                       | Freshness of a table, failing tasks of a database, credits of a warehouse (check type `snowflake`)                                           |
| 51  | Error budget burn rate                  | Fast (1 h, 14.4×) and slow (6 h, 6×) burn of an error budget from Prometheus (check type `prometheus`)                                       |
| 52  | Kubernetes namespace                    | Every deployment of a namespace ready, no pod crash-looping, one deployment on its own (check type `kubernetes`)                             |
| 53  | Repository pipelines                    | The default-branch pipeline and the critical/high alerts of repositories on GitHub, GitLab or Forgejo (check type `git`)                     |
| 54  | Kafka – orders topic                    | New messages within 15 minutes, the lag of two consumer groups (check type `kafka`)                                                          |
| 55  | Presses reporting over MQTT             | Every device of a topic pattern reports, the broker has clients (check type `mqtt`)                                                          |
| 56  | Database host (CheckMk)                 | A host and its services as CheckMk sees them, services depending on the host (check type `checkmk`)                                          |
| 57  | TCP service (template)                  | A TCP port answers; one monitor per service from a form or CSV (check type `tcp`)                                                            |
| 58  | Entra ID app credentials                | App secrets and certificates ending within 30 days, Microsoft 365 service health (check type `entra`)                                        |
| 59  | Vault hygiene                           | Failed heartbeats, rotation, owners and checkout/approval of privileged secrets in IBM Verify Privilege Vault (check type `privilege-vault`) |
| 63  | Kafka Connect – shop connectors         | Connectors and tasks running, a failed task after 10 minutes, a sink's lag, a quiet Debezium connector (check type `kafka-connect`)          |
| 64  | Vendor page watches                     | Changes of vendor terms in changedetection.io, watches failing or not checked for two days (check type `page-watch`)                         |

The monitors name their platform generically (`platform: Snowflake`, `platform: GitHub`, …): on import Steward takes the only platform of that kind, or the only one whose name starts with it, and otherwise asks which platform to use. Replace the objects (tables, namespaces, topics, hosts) with your own.

## Example triggers

`triggers/*.yaml` (`kind: webhookTrigger`) describe a webhook trigger for a process template: the input mapping of the sender's payload, a sample payload, the trigger's limits and how to set up the sender. Steward does not create them on its own: in _Triggers → New webhook trigger_, a process with the mapped inputs offers _Map: <name>_, and after saving the secret dialog shows the sender's URL and body with the real address and secret. `npm run validate` checks the format and that the process template next to it has the mapped inputs.

| #   | Trigger                         | Process | Sender                                                                                                                |
| --- | ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| 10  | changedetection.io notification | 76      | changedetection.io's `posts://` notification with a JSON body ([docs/CHANGEDETECTION.md](../docs/CHANGEDETECTION.md)) |
