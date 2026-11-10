# Getting started for administrators

This guide takes you from an installation to a Steward the team can use: the first start, unlocking, single sign-on, teams, the first platform and process, monitors, notifications and backups. Each step is short and links to the page with the details. The in-app checklist (_Help → Getting-started checklist_) follows the same order. Once it is installed, [Your first week with Steward](FIRST-WEEK.md) plans the team's first five days.

To look around first, start the demo with simulated platforms ([README](../README.md#quick-start-demo-with-simulated-platforms)).

1. [Install](#1-install)
2. [First start](#2-first-start)
3. [Unlocking after a restart](#3-unlocking-after-a-restart)
4. [Reach it over the network](#4-reach-it-over-the-network)
5. [Single sign-on](#5-single-sign-on)
6. [Users and teams](#6-users-and-teams)
7. [Add the first platform](#7-add-the-first-platform)
8. [Build and run the first process](#8-build-and-run-the-first-process)
9. [Watch systems with monitors](#9-watch-systems-with-monitors)
10. [Notifications](#10-notifications)
11. [Backups and retention](#11-backups-and-retention)
12. [Before you go live](#12-before-you-go-live)

## 1. Install

Choose how Steward runs ([INSTALL.md](INSTALL.md)):

- **One person on a laptop:** the desktop executable. Nothing else is needed.
- **A shared team server:** the container image with PostgreSQL ([INSTALL.md](INSTALL.md#4-container), [database](INSTALL.md#5-database-sqlite-or-postgresql)).
- **Development or customising:** Node.js ([INSTALL.md](INSTALL.md#3-nodejs)).

Every setting of the server is an environment variable ([CONFIGURATION.md](CONFIGURATION.md)). All data lives in one data folder (`SM_DATA_DIR`).

## 2. First start

Open Steward in the browser (`http://127.0.0.1:4310` by default).

1. **Choose the master passphrase.** It encrypts every credential and unlocks the audit and signing keys. It cannot be recovered: keep it in the company password manager, with at least two people having access ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#master-passphrase)).
2. **Create the first administrator account.** Keep a local administrator even when you use single sign-on later: it is the break-glass access.

## 3. Unlocking after a restart

After every restart the vault is locked. Schedules, monitors and platform calls wait until it is unlocked:

- **By hand:** an administrator signs in and enters the master passphrase.
- **Unattended:** put the passphrase in a file only the service account can read and set `SM_MASTER_PASSPHRASE_FILE`. Do not use an environment variable that other programs inherit. Docker secrets, systemd credentials and Windows: [SECURITY-HARDENING.md](SECURITY-HARDENING.md#master-passphrase), [INSTALL.md](INSTALL.md#the-passphrase-file-in-docker).

The _Unattended operation_ card in _Settings_ shows what is set. `/api/ready` answers `503` while the vault is locked; use it for alerts, not as a load-balancer check ([INSTALL.md](INSTALL.md#health-and-readiness)).

## 4. Reach it over the network

Steward listens on `127.0.0.1` only. For colleagues on other machines:

1. Set `SM_HOST=0.0.0.0` and name the host they use in `SM_ALLOWED_HOSTS`.
2. Serve HTTPS: a certificate with `SM_TLS_CERT` and `SM_TLS_KEY`, or a reverse proxy with `SM_TRUST_PROXY` and an `https://` `SM_PUBLIC_URL` ([INSTALL.md](INSTALL.md#behind-a-reverse-proxy)).
3. Behind a company proxy or TLS inspection: [INSTALL.md](INSTALL.md#company-proxy-and-tls-inspection).

## 5. Single sign-on

Connect your identity provider under _Users & teams → Single sign-on_: Microsoft Entra ID, Keycloak, Okta, Google Workspace, Authentik or any OpenID Connect provider ([SSO.md](SSO.md)).

1. Register Steward at the provider with the redirect URI shown in Steward.
2. Add the provider with its preset, then **Test discovery** and a **test sign-in**: it shows the claims and the account a sign-in would get, without signing anyone in.
3. Map groups or app roles to Steward roles and teams.
4. Optionally limit password sign-in to administrators (_Settings → Sign-in_). If single sign-on fails later, see [Locked out of single sign-on](INSTALL.md#locked-out-of-single-sign-on).

## 6. Users and teams

Roles decide what someone may do: admin, designer, operator, approver, auditor, viewer and status ([USERS.md](USERS.md#roles)). Create accounts under _Users & teams_, or let single sign-on create them at the first sign-in.

When several teams share one Steward, create the teams under _Users → Teams_ and give members roles in their team. Resources that a team owns are visible to its members, administrators and auditors only. Resources without an owning team behave as before ([TEAMS.md](TEAMS.md)).

## 7. Add the first platform

A platform is one system Steward works with: an Insights Hub tenant, an Industrial Edge Management, any REST API, a database, a cloud account ([PLATFORMS.md](PLATFORMS.md)).

1. Create it with its kind, base URL and sign-in ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md)). Credentials go into the vault and are never shown again.
2. Import its OpenAPI specs (by file, paste or URL), so the editor and the API explorer list its operations.
3. **Test connection.** Use the API explorer to look at a real answer.
4. Restrict it with an access list if only one team may use it, for example the production tenant ([USERS.md](USERS.md#platform-access-list)).

Requests that processes and monitors control may only reach the hosts the outbound policy allows. The default allows the configured platforms ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#outbound-connections)).

## 8. Build and run the first process

1. Create a process **from a template** (health checks, access reviews, inventories – [PROCESSES.md](PROCESSES.md#templates)) or build your own flow ([PROCESSES.md](PROCESSES.md)).
2. Start a **dry run**: read calls run, write calls are only recorded. Read the protocol: every request, the decisions and checks.
3. Make the decisions the run asks for under _My tasks_.
4. Run it for real once the dry run shows what you expect. The protocol is sealed in the audit log.
5. **Schedule** it, for example every Monday morning. A schedule runs with its owner's rights; runs that need a decision wait in _My tasks_.

Templates for Insights Hub and Industrial Edge, monitors and dashboards: [examples/README.md](../examples/README.md). Shared libraries from a publisher you trust: [LIBRARIES.md](LIBRARIES.md).

## 9. Watch systems with monitors

A monitor is a small graph of checks – ping, TCP, HTTP, platform API calls, data freshness, heartbeats from gateways and more – that names the root cause when something fails ([MONITORS.md](MONITORS.md)). Add maintenance windows for planned work. If you already run Gatus, Steward reads it instead of checking the same endpoints again ([GATUS.md](GATUS.md)).

## 10. Notifications

Under _Settings → Notifications_, set up e-mail (SMTP), Microsoft Teams or a webhook, and choose per event which channels are used ([NOTIFICATIONS.md](NOTIFICATIONS.md)). Everyone can turn on a daily summary on their profile page. Quiet hours hold e-mails and Teams posts at night ([NOTIFICATIONS.md](NOTIFICATIONS.md#quiet-hours-and-digests)).

## 11. Backups and retention

- **Backups:** _Settings → Backups_ makes encrypted copies of the database and the data folder to an S3 bucket on a schedule and tests the newest one every week ([BACKUPS.md](BACKUPS.md)). Without S3, back up the data folder and, with PostgreSQL, the database. Keep the backup passphrase and the master passphrase offline: a restore needs both.
- **Retention:** runs and notifications are kept as set under _Settings → Retention_. New installations keep runs for 400 days; installations that existed before 0.2.4 keep them until an administrator sets a period (_Settings → System status_ points this out once the database grows past 1 GB). What Steward stores about people: [PRIVACY.md](PRIVACY.md).
- **Audit log:** ship the signed checkpoints to your SIEM or a write-once mailbox, and turn on archives if the log should not grow for ever ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#audit-log-as-evidence), [ADR 0017](adr/0017-audit-retention.md)).

## 12. Before you go live

- Work through the hardening checklist: [SECURITY-HARDENING.md](SECURITY-HARDENING.md).
- Alert on `/api/ready` and watch the logs and metrics ([INSTALL.md](INSTALL.md#health-and-readiness), [SECURITY-HARDENING.md](SECURITY-HARDENING.md#monitoring-and-siem)).
- Plan updates: [INSTALL.md](INSTALL.md#6-updating) and which versions get fixes ([RELEASES.md](RELEASES.md)).
- Test against a sandbox tenant first: [TESTING.md](TESTING.md).
