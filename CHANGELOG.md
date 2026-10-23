# Changelog

All notable changes to Steward are documented here.

The format follows [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Commits follow [Conventional Commits](https://www.conventionalcommits.org/), so entries can be drafted from the commit history.

## [Unreleased]

The first public version, 0.1.0, is being prepared. It contains everything below.

### Added

- **Git sync** (optional, off by default; [docs/GIT-SYNC.md](docs/GIT-SYNC.md)): administrators add sources (Forgejo/Gitea, GitHub, GitLab; repository, branch, folder, what to sync, read-only token, schedule and/or signed push webhook) under _Settings → Git sync_. Fetched processes, dashboards, monitors and record types are validated and staged in the new inbox _Updates from Git_; designers review a diff (node summary for processes) and accept – a new version, applied with their rights – or reject. Local edits since the last sync show as conflicts. Synced items carry a _From Git_ badge linking to the file at its commit. Optional: auto-accept new items (monitors disabled), require signed commits. API: `/api/sync-sources`, `/api/sync-updates`, `/api/sync-origins`, `POST /api/hooks/sync/:id`. A mock Git host serves the demo and the tests.
- **Example: Insights Hub tenant usage and licence check** (`examples/processes/32-ih-tenant-usage.yaml`) with the dashboard _Tenant usage_: users, assets, agents, credits, time series and file storage and API calls against the licence, warning at 80 % and critical at 95 % (inputs), checks that notify on a breach, trends over 90 days. Part of the demo setup (scheduled daily). The Usage Transparency path and the agent paging fields are marked as assumptions to verify on your tenant. See [docs/INSIGHTS-HUB-USAGE.md](docs/INSIGHTS-HUB-USAGE.md).
- **Ticket references** (_Tickets_, German _Ticket-Referenzen_): document ServiceNow incidents and vendor tickets – configurable sources, number, http(s) link, title, Markdown note, vendor (with suggestions), responsible users/teams, free status (open, waiting for vendor, waiting for us, resolved, closed) with opened/resolved/last-checked dates and an audited history, affected services, platforms, credentials, records, monitors and processes (generic link model, names only for readers who may see them). _Open tickets_ on service, platform and record pages, a list with filters, a badge of open vendor tickets in the service catalogue, optional "not checked for N days" reminders (event _Ticket not checked_), the report section _Ticket references_ (open per service and vendor with age, opened/resolved, mean time to resolution per vendor), `GET /api/v1/ticket-references`, the MCP tool `list_ticket_references`. A status-sync adapter interface for ServiceNow is documented, not implemented. See [docs/TICKETS.md](docs/TICKETS.md).
- **Daily summary** (profile page, off by default): once a day at a chosen time and time zone, on weekdays or every day, in the app or also by e-mail (SMTP on, event routed to e-mail, allowed domain) – runs and failures, decisions waiting, monitor status changes (redacted per viewer), credentials due, open ticket references, records waiting for approval or changed, reports received; collected with the recipient's rights, in their language, skipped on empty days if wanted, sent at most once a day (survives restarts). Administrators see who subscribed (not the content) and can switch summaries off. See [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md#daily-summary).

- **Credentials register** (_Credentials_, German _Zugangsdaten_): documents API clients, technical users, tokens, certificates, agent certificates, SSH keys and passwords – platform, environment, who uses them (with links to processes, monitors and platforms), owner e-mail addresses with roles and owning users/teams, where the secret is kept (e.g. a KeePass entry; http(s) links clickable, `keepass://` and file paths copyable), issue and expiry dates, rotation and review intervals with computed due dates and a status (OK, due soon, overdue, expired). Upload a public certificate (PEM/CRT/DER, chains) to fill in subject, issuer, serial, fingerprint, SANs and expiry; optional expiry sync from Gatus metrics. _Mark rotated_ / _Mark reviewed_ with history. Reminders before and after due dates (_Settings → Credential reminders_, per-entry overrides) to the owners in the app and by e-mail, sent once and kept across restarts. Filters, CSV export, a _Credentials due_ card on the home page, `GET /api/v1/credentials`. See [docs/CREDENTIALS.md](docs/CREDENTIALS.md).
- **Scheduled reports** (_Reports_): daily, weekly, monthly or cron report schedules with sections for availability and SLA per monitor and per Gatus endpoint (uptime, outages, downtime, avg/p95 response time, bar chart), the credentials register (expired, overdue, due soon) and runs per process; a section registry for further sections. Generated with the owner's rights, archived and audited like all reports, delivered in the app and by e-mail (optionally with the PDF attached). See [docs/REPORTS.md](docs/REPORTS.md).
- **Gatus metrics mode** (_Platform → Metrics_): Steward scrapes Gatus' Prometheus `/metrics` (default every 60 s), keeps per-endpoint samples, hourly figures and outages (default 90 days, single samples 14 days), computes uptime from the result counters (Gatus restarts handled) and optionally reads Gatus' uptime API. The monitor check _Gatus endpoint_ can read this data (data source _metrics_). See [docs/GATUS.md](docs/GATUS.md#5-metrics-mode).
- **MCP server for AI assistants** ([docs/MCP.md](docs/MCP.md)), read-only, off by default (_Settings → MCP server_):
  - Streamable HTTP at `POST /api/mcp`, protocol 2026-07-28 (stateless, `server/discover`) and the earlier 2025-11-25 and 2025-06-18 (`initialize`), JSON responses;
  - tools for processes, runs and their steps, monitors, dashboards and datasets, platforms (metadata), schedules, webhook triggers, the audit log (auditors and administrators) and the system status – paginated, size-capped, with the rights of the token owner;
  - the semantic model as resource `steward://semantic-model`;
  - a new token scope _MCP client_ (profile page) that works only on the MCP endpoint; the token dialog and the settings show a ready-to-copy client configuration;
  - stdio bridge for desktop clients: `steward mcp` / `npm run mcp` (`--url`, `--api-key-file` or `STEWARD_API_KEY`); it never opens the database and checks that a local URL is really your Steward before sending the token;
  - Prometheus counters `steward_mcp_requests_total`, `steward_mcp_tool_calls_total`, `steward_mcp_gateway_calls_total`.
- **Platform MCP gateway** (platform → tab _MCP_, `manage` right): MCP clients find, describe and call the GET/HEAD operations of the platform's OpenAPI specifications – or GET paths below allow-listed prefixes – with the credentials Steward holds; every call is audited.
- **Semantic model** ([docs/SEMANTIC-MODEL.md](docs/SEMANTIC-MODEL.md)): `GET /api/v1/semantic-model` describes the REST API's datasets, fields, relationships and metrics (run success rate, monitor availability, …) as an Apache Ossie (formerly OSI) model – revision 0.1.1 or 0.2.0.dev0, JSON or YAML, validated against the official schemas in the tests.
- REST API 1.1: webhook triggers (`GET /api/v1/triggers`, `/triggers/{triggerId}`, metadata only).
- **Account recovery:** `steward admin list-admins` and `steward admin reset-password <user> [--activate]` (also `npm run admin`) set a one-time password on the server. They need the data folder and the master passphrase, refuse while Steward is running, sign out the account's sessions and are audited. Docs on resetting a demo instance.

**Records and services**

- Records: change requests and decision records (ADR, DR, SDR) with editable types (key, name, workflow, Markdown template, fields), numbers per type and year (`CR-2026-0001`), change and decision workflows, four-eyes approval, versions with a line diff, frozen content with a recorded SHA-256 and audited new revisions, comments, links with backlinks, and attachments (documents and e-mails). See [docs/RECORDS.md](docs/RECORDS.md).
- Markdown import of existing decision records (MADR, Nygard, YAML frontmatter; bulk with preview) and Markdown export.
- Record PDFs (PDF/A-2b) with content hash, approval history, audit excerpt and one signature block with an empty AcroForm signature field per external signer; upload of the signed PDF, checked to be derived from a generated PDF (signatures listed, not cryptographically validated).
- A minimal service catalogue: contacts, criticality, CMDB reference and links to platforms, monitors, processes, dashboards and records.
- Public API: `GET /api/v1/records`, `/records/{recordId}`, `/records/{recordId}/versions`.
- Services, credentials and records are connected: credentials register entries link to the services that use them, records and services link to credentials, and every side lists the others under _Linked from_ – always with the reader's rights (viewers only see credentials they own).
- Scheduled reports: a _Records and change requests_ section (records created, changed, approved or implemented in the period, open change requests by status, planned change windows).

**Compliance: access governance evidence** ([docs/COMPLIANCE.md](docs/COMPLIANCE.md)) – a new _Compliance_ section in the sidebar:

- **Access changes**: a built-in record type _Access change_ (`AC-2026-0001`; draft → documented (frozen) → verified by a second person) for every grant, revocation and change of access rights – platform, subject, rights before and after, reason, request reference, approver, performer, time, attachments.
- **Automatic entries from runs**: the new step _Document access change_ (`accessChange`) records what a run changed; when the run ends, Steward creates one documented entry per subject, linked to the run with its PDF protocol attached. The access review, privileged access review, offboarding and onboarding examples use it.
- **Access reconciliation**: scheduled snapshots of who has which access (Insights Hub identity management, or any platform through a dataset in the access snapshot shape – example 16), compared with the documented entries; undocumented grants, removals, changes, new and removed accounts become findings with notifications and a one-click _Document this change_ (marked _documented after the fact_). Snapshots are immutable, hash-chained and audited. In demo mode: _Simulate a change outside Steward_.
- **Controls**: built-in catalogues ISO/IEC 27001:2022 Annex A, IEC 62443-2-1 and NIS2 Art. 21(2) (identifiers and short topic names only), JSON/YAML/CSV import, mapping of processes, record types, records, monitors, report schedules and checks to controls, and the evidence coverage per period with gaps highlighted.
- **Evidence packs**: a ZIP for controls, a platform or a service and a period – index (PDF/A and JSON), run protocols, record PDFs and files, access changes, snapshots and findings, scheduled reports, an audit log excerpt with a signed checkpoint, and a `manifest.json` with the SHA-256 of every file signed with the installation's Ed25519 key. Offline check: `npm run evidence:verify -- pack.zip` / `steward evidence verify pack.zip`.
- REST API: `GET /api/v1/access-changes`, `/access-findings`, `/control-catalogues`, `/controls`, `/control-coverage`.

**Processes and engine**

- Node-RED-style flow editor with a node palette, labelled outputs and YAML source view.
  - Node types: API call (with pagination and OpenAPI operation picker), set variables, for each (optionally in parallel), if, user task/approval (assignees, four-eyes), check, report section, publish to dashboard, browser automation, run sub-process, wait, fail, comment.
- Versioned processes with inputs, constants, connection slots and outputs.
- Dry runs: read calls run, write calls are only recorded.
- Durable runs: journaled step by step and resumed after a restart without repeating finished steps.
- Expression assistant with autocomplete and live preview, a node inspector with the last run's data, undo/redo, copy/paste between processes, and a YAML diff between versions.
- Scheduling with cron and time zones; scheduled runs use the owner's rights.
- Webhook triggers that start a process from an inbound request:
  - per-trigger secret or HMAC signature, input mapping;
  - rate limits, de-duplication, source address allow-list, audit.
- Example library for Insights Hub and Industrial Edge housekeeping, access reviews, inventory, health and compliance checks, plus example dashboards.

**Monitors**

- Composable, dependency-aware monitors: a graph of checks with soft links (root-cause inference and alert suppression) and hard links (skip while the parent is down), sub-monitors, flapping control, aggregation rules (worst, critical, quorum), maintenance windows and acknowledgements.
- Check types: ping (with TCP fallback), TCP, HTTP(S) (status, JSONata condition, response time, certificate expiry), platform API call, data freshness (Insights Hub time series preset with shared reads per asset/aspect, cadence or maximum age), heartbeat (push), Gatus endpoint, sub-monitor.
- Heartbeat endpoints per check and a gateway batch endpoint with token/HMAC secrets, rate limits, source allow-lists and audit.
- Outputs: notifications (event `monitor.status`), runbooks, webhooks, Gatus external endpoints, Zabbix (sender protocol and `history.push`); pull via the public API (status, history, Zabbix low-level discovery), Prometheus gauges and dashboard datasets.
- Templates with parameters, CSV instantiation and re-sync; YAML import/export and example monitors (`examples/monitors`); demo monitors with an IoT gateway simulator.
- Monitors UI: list, graph view with root-cause highlighting, editor, heartbeat setup, gateways, status wall.

**Platforms and integrations**

- Platforms for any REST API: OpenAPI import (file, paste, URL), connector types (export/import), encrypted credentials.
  - Retries with backoff that honour `Retry-After`.
  - Per-platform concurrency limit.
  - Credentials only go to the platform's own origins.
- Gatus integration:
  - connector, uptime overview dashboard;
  - pushing results to Gatus external endpoints;
  - outage runbook started by Gatus alerts.
- Sandbox contract checks (`npm run contract`).

**Access, security and audit**

- Local accounts with roles (admin, designer, operator, approver, auditor, viewer), teams, and per-process/per-platform access lists.
- Single sign-on with Microsoft Entra ID or any OpenID Connect provider, with role and team mapping from claims.
- Personal API tokens (read-only or full).
- Tamper-evident audit log: a chain of HMAC-signed hashes, with a verify endpoint.
- Sealed run protocols (HTML/JSON).
- Branded PDF/A-2b reports for runs and periods:
  - reviewer comment and signature fields;
  - SHA-256 recorded in the audit log;
  - verification of archived and signed copies.
- Security headers (CSP, HSTS over TLS, Permissions-Policy), CSRF and DNS-rebinding protection, vault encrypted with AES-256-GCM.
- Retention policy for runs, report files and notifications.

**Observability and operations**

- Dashboards fed by processes: KPI, trend, status and table widgets, freshness indicators.
- Notifications: in-app notification centre, e-mail (SMTP), Microsoft Teams, generic webhooks.
- Structured JSON logs, OpenTelemetry tracing, Prometheus metrics (`/api/metrics`), readiness probe (`/api/ready`).
- Optional error reporting to Sentry, GlitchTip or Bugsink, with scrubbing of secrets and personal data.
- Public read-only REST API (`/api/v1`) with an OpenAPI 3.1 description:
  - API-token authentication, rate limiting, RFC 9457 errors;
  - an optional Swagger UI.
- System status page (_Settings → System status_, administrators; auditors get a view without paths and host names): readiness checks, database type and size, vault, scheduler with the next runs, monitor engine, notification channels, error reporting, tracing, metrics access, public API, retention and last cleanup, runtime (Node.js, platform, uptime, memory, time zone, installation type). Health and readiness URLs with copy buttons and monitoring hints (`GET /api/system/status`).

**Appearance and product information**

- Theming for the whole installation (_Settings → Appearance_, administrators): primary and accent colour, default colour scheme (users keep their own light/dark choice), corner radius, a display name for the header, window title and sign-in page (e.g. "ACME Steward") and a header logo (PNG, JPEG or WebP up to 512 KB, checked by its content; no SVG).
  - Ten-shade palettes generated from each colour (OKLCH); text on filled buttons and badges switches between black and white, and links use a darker or lighter shade where needed, so text stays at WCAG AA in light and dark mode. The settings explain each adjustment and show a live preview in both colour schemes; _Reset to Steward defaults_.
  - Applied before sign-in through the public, cacheable `GET /api/theme` (ETag), polled by open pages; the web app manifest (`/manifest.webmanifest`) uses the display name and colour. Changes are audited.
- About page (user menu and footer): version and build (commit, date) of the web UI and of the server with a reload hint when they differ, licence, documentation, changelog, security policy, source code, API documentation, language and theme in use, browser support, and the third-party licences of all production dependencies (generated at build time).
- The footer shows the version. Container images (`SM_BUILD_COMMIT`/`SM_BUILD_DATE` build arguments), release builds and the desktop executable carry their build commit and date; other builds report "development".

**Running and packaging**

- PostgreSQL as an alternative to the built-in SQLite, with `npm run db:copy` to move data in either direction.
- Desktop executable for Windows, macOS (Apple silicon and Intel) and Linux (x64 and arm64):
  - single file, opens as an app window;
  - per-user data folder, optional autostart at sign-in.
- Installable web app (PWA) with browser notifications.
- Hardened container image (read-only root file system, non-root user) and Compose files for SQLite and PostgreSQL.
- English and German user interface; each person picks a language (stored in the profile), notifications and e-mails use it, and channel posts use the default language from the settings. More languages can be added without code changes ([docs/I18N.md](docs/I18N.md), `npm run i18n:check`).

**Quality and supply chain**

- Test suites:
  - vitest API and integration tests on SQLite and PostgreSQL;
  - Playwright UI tests with accessibility checks (WCAG 2.1 AA).
- CI scans:
  - code and secrets: CodeQL, Semgrep, gitleaks;
  - dependencies: OSV-Scanner, npm audit;
  - configuration and container: Trivy, hadolint;
  - workflows: actionlint, zizmor.
- Container SBOMs (Syft) and image scan (Grype), OpenSSF Scorecard, Dependabot.
- Woodpecker CI pipelines (`.woodpecker/`) for a self-hosted Forgejo mirror, next to GitHub Actions: tests on SQLite and PostgreSQL, UI tests, the security scans (weekly too), the container image pushed to Harbor (release tags only after a passed scan, optional cosign signature) with SBOMs in Dependency-Track, and the Linux executable with an optional Forgejo release. See [docs/WOODPECKER.md](docs/WOODPECKER.md).
- Command-line tools follow clig.dev conventions (`--help`, exit codes, `--json`, `NO_COLOR`).
- ESLint, Prettier and EditorConfig for the whole repository (`npm run lint`, `npm run format:check`, checked in CI), with pre-commit hooks for staged files, a gitleaks scan and a Conventional Commits check of the message ([CONTRIBUTING.md](CONTRIBUTING.md#pre-commit-hooks)).
- **Navigation and first steps** ([docs/UX-REVIEW.md](docs/UX-REVIEW.md)): the sidebar is grouped into _Operate_, _Automate_, _Service management_ and _Administration_; sections fold (remembered per browser) and the whole sidebar folds to icons on wide screens. Detail pages show a breadcrumb back to their list. Lists have empty states with guidance and the first action, skeletons while loading and an error message with _Try again_; filters fold behind a button on phones. Administrators get a getting-started checklist on the start page (`setup` counts in `GET /api/dashboard`, administrators only). The command palette finds monitors, services, records and credential entries and has "New …" actions. Runs, cards and start-page tiles are real links (keyboard access), and status badges share one colour vocabulary.

### Fixed

- **German UI** – everything is translated now, also on the _Dokumente_ pages:
  - server errors of records, services, credentials, reports, report schedules, Gatus, MCP, monitors and gateways (about 240 messages) carry a `code` and `params`; the UI shows them in its language, with the details filled in, numbers formatted and lists joined in the UI language. Zod validation errors are shown inside a translated sentence;
  - the four-eyes and other reasons why a record action is not possible (`reasonCode`), the errors and notes of the Markdown import (`errorCode`, `warningCodes`) and why a task cannot be decided (`cannotDecideCode`);
  - the built-in record types: description, Markdown template, field labels and help, select options (_niedrig/mittel/hoch_) in the web UI, the record PDF and the records section of scheduled reports – as long as an administrator has not changed them. New records start with the template in the UI language (API/MCP: in the creator's profile language);
  - a few hard-coded English texts (task panel, report language names, close buttons of dialogs, the default name of a new sign-in provider) and German texts that were still English (_Protokoll_, _Audit-Log_, _Anfrageinhalt_, …); dates and numbers in the theme settings follow the UI language;
  - the PDF of a record is generated in the requester's profile language when the request names none (was English).
- New checks: `npm run i18n:literals` finds texts in the web UI that do not go through `t()`; `npm run i18n:check` also reports texts that are still English (allow-list `scripts/i18n-allow.json`); both run in CI. A server test makes sure every error code has a text, and a UI test visits the main pages in German. See [docs/I18N.md](docs/I18N.md).

### Security

- Regular expressions that relied on the V8 linear-engine fallback (see _Fixed_) work in linear time without it: the JSON Web Token mask of error reports (was quadratic on long `-eyJ-eyJ…` runs) and the Prometheus value parser of the Gatus metrics scraper (quadratic on long digit runs). Error-report scrubbing caps every string at 8 192 characters before its patterns run (known secrets are still removed from the whole string first), so no string takes more than about a second.
- Git sync review fixes: the _Updates from Git_ inbox hides updates of processes and monitors the reviewer cannot see (no name, no current definition; detail, accept and reject answer 404); blobs of SHA-256 repositories are checked against their object ids too; _Require signed commits_ checks every new commit since the last fetched commit through the hosts' compare/commits APIs (not only the branch head), refuses the whole fetch if one is unverified (nothing staged, audited) and can be limited to allowed signers (logins or e-mail addresses); superseded updates are deleted and the content of rejected ones removed after 30 days; one `sync.fetched` audit entry per fetch lists the staged files instead of one entry per file.
- Git sync: repository hosts must pass the outbound policy; the access token is vault-encrypted, never returned and only sent to the source's API base (redirects refused); responses are size-capped, blobs checked against their Git object ids, paths confined to the folder, YAML parsed as plain data, files with secret-looking values refused; optional signed-commit requirement; source configuration needs a signed-in session; the push webhook is HMAC/secret-authenticated and rate-limited; every fetch, staging and decision is audited.
- Evidence packs only contain what the requester may see (the audit log excerpt only for auditors and administrators), are size-limited, written to disk as they are built and deleted after the retention period; requesting, building and downloading them is audited.
- Access governance (review round 3, see [docs/COMPLIANCE.md](docs/COMPLIANCE.md)):
  - Access change entries are written and documented only by people who may use the platform, and read only by administrators, auditors, approvers, their owner and who has a right on the platform – also in record lists, search, links, backlinks, coverage, evidence packs, reports and `/api/v1`. Before, every signed-in user read them, and an operator without rights on a platform could close its reconciliation findings.
  - Nobody documents, dismisses or verifies a change of their own access (subject matched by user name or e-mail address); an entry documented by its subject does not close a finding. A finding is closed by a later entry only when the person who documents it may document the findings of the check.
  - Entries of runs name the person who started the run as performer; that person and the run's approvers cannot verify them, and nobody can change or revise them. Origin, run and finding of an entry are set only by Steward (`400 ACCESS_FIELD_RESERVED`). Entries show who documented them and who last edited them; entries changed in the database are flagged (`tampered`) and do not count.
  - Dataset checks need the right to view the process that publishes the dataset (when set up and on every run); the dataset key of a check with snapshots cannot change. Ignored rights are set by administrators only and audited with the old and new list (as are the recipients). Optional four-eyes dismissals (_Settings → Access reconciliation_).
  - _Verify history_ compares snapshots and findings with the authentic audit entries: deleted snapshots (also the newest), deleted findings and statuses changed in the database are reported; database triggers refuse deleting snapshots and findings.
  - Evidence packs: the offline check reports a pack signed with a key nobody confirmed as _UNTRUSTED_ and exits with 3 – pass `--public-key`, `--fingerprint` or `--trust-pack-key`; it always prints the key fingerprint. Manifest signatures are domain-separated from audit checkpoints (version 2 manifests; older packs still verify). The ZIP reader refuses bytes outside the listed entries, gaps, overlaps and local headers that differ from the central directory. Packs of someone who cannot see everything say so and count the evidence left out per control (_not visible_ instead of _gap_).
  - Mapped control items the reader may not see no longer show their id and cannot be removed by them.
  - The Insights Hub collector applies its limits while it reads the pages (rights per user, users, assignments; 16 MB per page).
  - YAML imports (control catalogues – now at most 256 KB –, processes, dashboards, monitors, API specifications, record front matter, Git sync files) are size-capped before parsing and check duplicate keys in linear time: the YAML library's own check is quadratic (40 000 keys took 20 seconds).
- Holistic review (OWASP ASVS 4.0.3 level 2), see [docs/REVIEW-2026-10.md](docs/REVIEW-2026-10.md):
  - API specifications and operations of a platform (`/api/platforms/:id/specs`, `/operations`, `/api/specs/:id/content`) were readable by every signed-in user; they now need a permission on the platform, like the platform itself.
  - API tokens can no longer manage users, teams, single sign-on providers, sign-in and outbound settings or the master passphrase (`403 SESSION_REQUIRED`): before, a leaked full-access token of an administrator could create a new administrator or reset a password and so outlive its revocation.
  - Sessions end after 30 minutes without a request and 12 hours after sign-in (before: 12 hours idle, 7 days); `SM_SESSION_IDLE_MINUTES` and `SM_SESSION_MAX_HOURS` change it. Over HTTPS the session cookie has the `__Host-` prefix (everyone signs in again once after the update).
  - Single sign-on: sign-ins in progress (started without signing in) are capped at 5000 and the return path at 1 KB – a flood of `/api/auth/oidc/:id/start` requests could exhaust the server's memory.
  - Changing the own password: at most 5 wrong current passwords per 15 minutes, each one audited (`user.password_change_failed`).
  - Webhook mapping preview only for people who may run a process; at most 100 mapped inputs and 5 s per evaluation.
  - Query strings are validated (repeated or malformed parameters gave HTTP 500, `limit=-1` unlimited lists); database errors are no longer returned to the client. Size limits for user, team, platform, schedule, task decision and process text fields.
  - Startup warnings for risky settings (no HTTPS with extra host names, demo mode on a network address, the passphrase in an environment variable, public metrics, long sessions).
  - `server/test/route-matrix.test.ts`: every route is called by every role, without credentials and with read-only and MCP tokens; a new route fails the test until its access rules are classified.
- Credentials register: no field holds a secret; free text, links and comments are checked for private keys, JWTs, well-known token formats, passwords in URLs and random-looking tokens and refused (the value is never echoed); only `http(s)` links are clickable (`javascript:`/`data:` refused); uploaded certificates are parsed and only their metadata is stored, files with a private key (PEM, DER, PKCS#12) are rejected; CSV exports are protected against formula injection.
- Gatus metrics mode: `/metrics` is unauthenticated in Gatus – the docs require it to be network-restricted. Steward fetches it through the platform and the outbound policy, only below the platform's base URL, with an 8 MB limit, a timeout and a bounded parser.
- E-mail to addresses outside Steward (credential owners, report recipients): only to allowed domains – the new setting _Settings → Notifications → Allowed e-mail domains for addresses outside Steward_ (`corp.example`, `*.corp.example`); while it is empty, the domains of the users' own addresses that an administrator, a single sign-on account or at least two users use. Checked when saving and again on every send. At most 10 addresses per credential entry and 20 per report schedule; owners who edit an entry only as its owner cannot change its owner addresses. Subjects carry user-chosen names only quoted after a fixed prefix and shortened to 80 characters.
- Report schedules: cron expressions with seconds are refused, a schedule runs at most once an hour (also schedules saved before), at most 20 schedules per owner.
- Certificate upload: PEM blocks are found in one linear pass, with at most 21 BEGIN lines (a file with many BEGIN lines without END blocked the server for seconds).
- Monitors: viewers of a monitor that includes a sub-monitor they may not view no longer see its id, key, name or check names – in root causes, _likely caused by_, the sub-monitor check, messages, history, the definition and YAML export, the `monitor.<key>` dataset, `/api/v1/monitors…`, the MCP tools and notifications ("a monitor you cannot view"). The sub-monitor check's message no longer names the monitor.
- Credentials register: the name of a linked platform is only shown to users with a right on it, and editors can only link platforms they may see (an unknown and a hidden platform get the same answer).
- Gatus metrics mode: the metrics path refuses encoded dots and slashes (`%2e`, `%2f`, `%5c`) and the resolved URL must stay below the base path; _Scrape now_ at most every 15 s per platform; deleting a platform deletes its Gatus data, and endpoints not seen for the history period are removed.
- MCP (new): its own token scope that no other API accepts (and MCP endpoints accept no other scope); `Origin` validation against DNS rebinding next to the `Host` allow-list; 64 kB request limit, no batches, strict argument schemas, per-token rate limits and time limits; tool output is structured JSON marked as untrusted data. The platform gateway is opt-in per platform, read-only (writes are refused and audited), builds paths only from the API specification or allow-listed prefixes (no absolute URLs, dot segments or encoded separators), validates query parameters, applies the outbound policy, does not follow redirects, caps responses at 512 kB, masks credentials and returns no cookies.
- Records: uploaded attachments are checked against their extension (magic numbers, e-mail headers, UTF-8 text), stored read-only with their SHA-256 (checked on download) and always downloaded as attachments in a sandbox; Markdown is rendered from a syntax tree without HTML (links: http, https and mailto only); YAML frontmatter is parsed with the core schema only (no custom tags, aliases limited) and sizes are limited; links only name targets the reader may see; a signed PDF is only accepted when its first bytes match a generated PDF of the record whose audit entry is authentic.
- Security review fixes (MCP, gateway, API v1):
  - `GET /api/v1/platforms` and `/platforms/{platformId}` only show platforms the token owner has a permission on (as the web UI does); others answer `404`;
  - the MCP stdio bridge no longer sends the token to a local URL while the data folder has no `instance.json`: it waits briefly (`--wait`), then fails; after a lost connection it checks the proof again; `--no-instance-check` (documented as less safe, with a warning) is for setups such as Docker on `localhost`;
  - credentials are masked in more encodings in run journals, logs and gateway responses: form encoding (`URLSearchParams`, e.g. `~` as `%7E`), RFC 3986 strict encoding and lowercase hex – for example a query API key echoed in a `Link` header;
  - the gateway refuses `;` in paths and path parameters (`..;/` is a dot segment for Tomcat, Jetty and Spring);
  - gateway audit entries escape control characters in client-chosen names and log invalid paths as `(invalid)`;
  - gateway rate limits apply per user and platform (not per token), and at most 2 gateway calls per platform run at the same time (`SM_MCP_GATEWAY_CONCURRENCY`), so runs and monitors keep their connection slots.
- Records (security review): the Markdown parser and the PDF engine (records, run and scheduled reports) work in linear time – unclosed brackets or emphasis, long lines of spaces, table cell bombs and very long words no longer block the server or the browser (words get invisible break opportunities, a PDF draws at most 1 000 000 characters); the Markdown import reads titles and comments without backtracking regular expressions; the signed-PDF scan reads each signature in a bounded window and a record keeps at most 100 generated and 30 signed PDFs (300 MB). Four-eyes counts everyone who attached or removed files and the authors of earlier revisions (a new revision no longer launders them). Before a transition the content hash must also match the authentic audit entry that froze the revision (a recomputed `frozen_hash` in the database is detected). The key of a record type with records cannot change any more (it is part of their content hash). Links to items the reader may not see no longer return the target id (API, UI, PDF) and `/api/backlinks` answers 404 for them; links of closed records cannot change. Signed PDFs are only accepted for the current, frozen revision and only with signature values and complete byte ranges; signer names are shown as claimed, not verified. Frozen records keep the field definitions they were approved with.
- Platform credentials are no longer sent to hosts outside the platform when a step calls an absolute URL.
- The vault rejects shortened AES-GCM authentication tags.
- Audit log integrity (review C):
  - verification fails on rows with a sequence number below 1, on rows outside the chain, and on entries removed while the server runs; the database refuses such rows (migration `security-001`);
  - every hour, on each verification and before each export a checkpoint `{seq, hash, digest, count, ts}` is signed with a per-installation Ed25519 key kept in the vault; it is written to the audit log, to `audit-anchor.json` in the data folder and as a log line for the SIEM, and can be e-mailed to auditors (_Audit log → Anchoring_);
  - verification compares the chain with these anchors and with an external checkpoint (pasted in the UI, `SM_AUDIT_ANCHOR`, `SM_AUDIT_ANCHOR_FILE`): removing the newest entries or wiping the log is detected;
  - exports include `prevHash`, details and a signed checkpoint; `npm run audit:verify-export` checks an export offline with the public key;
  - report verification, protocol seals and summary reports only trust audit entries whose HMAC and chain position check out – a forged row no longer makes a forged PDF verify;
  - audited free text is capped, failed sign-ins are summed up per account/address and minute, and entries recorded while the vault is locked are bounded (dropped entries are counted in the log); unauthenticated requests may send at most 64 KB.
- Sessions are bound to a per-session key that the web app keeps in its origin's `localStorage` and sends as `x-sm-session`; a session cookie received by another program on the same host no longer signs anyone in. Download links carry a read-only link key. **Everyone has to sign in again after the update.**
- The master passphrase can be read from a file (`SM_MASTER_PASSPHRASE_FILE`: Docker secrets, systemd credentials); both passphrase variables are removed from the environment at start. Browser steps start Chromium with a minimal environment and with its sandbox (unless running as root); the desktop launcher starts the user's browser without `SM_*` variables or secrets.
- Vault format 2: random data, audit, integrity and signing keys wrapped with a scrypt key (N=2^17); existing vaults are converted on their first unlock (the audit chain stays valid). Administrators can change the master passphrase (_Settings_), optionally rotating the data key; new passphrases need 12 characters; wrong passphrases are audited and throttled.
- Platform connection settings (base URL, authentication, token URL, trusted origins, headers) and sign-in provider settings are sealed with an HMAC; when they are changed directly in the database, no requests are sent until an administrator confirms them.
- Password checks run off the event loop with a concurrency limit and the same cost for unknown user names.
- The desktop launcher only opens its window for a server that proves it knows the secret in the user's data folder (port squatters are refused).
- Data folder `0700`, database, vault and key files `0600` on Linux/macOS (existing installations are fixed at start).
- Audit CSV export escapes cells that spreadsheets would run as formulas.
- `SM_TRUST_PROXY` for reverse proxies (real client addresses for the audit log, lockouts and webhook CIDRs); `Secure` cookie and HSTS with an `https://` `SM_PUBLIC_URL`.
- Failed sign-ins with user names that belong to no account store a pseudonym instead of the typed text; new process input type _secret_ (stored encrypted, `***` everywhere).
- Redaction of JSON-/URL-/Base64-encoded secrets, Basic credentials and OAuth token fields in run data; error reports scrub encoded secrets; traces carry a user pseudonym and scrubbed exception messages; TLS 1.2+ with forward-secret ciphers; `Cache-Control: no-store` on API responses; the desktop executable re-checks its unpacked files at every start; hardened compose files.
- Supply chain: `npm ci --ignore-scripts` plus an enforced install-script allow-list in CI, release builds and the Dockerfile; signed build provenance and SBOM attestations for release archives and the container image.
- New: [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md) (checklist for a work deployment) and [docs/PRIVACY.md](docs/PRIVACY.md).
- Every process expression now runs under guard rails by default — a time limit (`SM_EXPR_TIMEOUT_MS`, default 5 s), stack-depth and sequence-size limits (`SM_EXPR_MAX_DEPTH`, `SM_EXPR_MAX_SEQUENCE`), a heap watchdog and regular expressions that cannot backtrack catastrophically — and long evaluations yield to the event loop, so a single expression can no longer freeze the server (DoS).
- Resolved secret values (`$secret()` and platform credentials) may only leave Steward towards the platform's own allowed origins: outbound requests are scanned for any bound platform's secret (also base64/URL-encoded) and the step fails if one would reach another origin. Secrets are masked in their encoded forms in logs too.
- Credentials are re-evaluated on each redirect hop: custom-named API-key headers, default headers and any header carrying a secret are dropped when a redirect leaves the allowed origins, and `https → http` downgrades that would carry credentials are refused (redirects are followed manually, max 5 hops).
- New outbound destination policy (SSRF protection) for process-controlled requests — `http` node, pagination, browser navigation and sub-requests, OpenAPI import by URL — configurable under _Settings → Outbound access_ (`platforms` / `allowList` / `open`, `SM_OUTBOUND_POLICY`). Cloud-metadata and link-local addresses and the server's own API port are always blocked, and the resolved IP is pinned for the connection (no DNS rebinding).
- Dashboard datasets are owned by the process that first publishes a key; another process can no longer overwrite it or hijack its dashboard visibility.
- Dry runs can be made read-only for a browser step (`dryRunReadOnly`), and a dry run now warns in the protocol when a browser step performs page interactions that could change data.
- Monitors adopt the same policies: http/tcp/ping checks and webhook/Zabbix outputs are subject to the outbound policy (DNS-pinned; raw `host:port` checks need an explicit allow-list entry such as an IP/CIDR and are not inferred from platform origins); monitor http checks follow redirects manually and drop custom headers cross-origin; check error messages no longer echo the upstream response body; the guarded expression evaluation bounds condition/heartbeat/freshness expressions (CPU, memory via a `$pad` cap, and regex time); and gateway heartbeat batches share a global evaluation-concurrency cap (`SM_MONITOR_EVAL_CONCURRENCY`).
- Semgrep findings triaged (all rule sets of the CI job, see [docs/SECURITY-PIPELINE.md](docs/SECURITY-PIPELINE.md#semgrep-triage)): the dev, PostgreSQL-test and install-script helpers start npm without a shell, also on Windows (`scripts/npm-command.mjs`); monitor-gateway key patterns (glob) and the API path editor match without regular expressions built from configured data; translation lookups ignore inherited properties; the CI gate also blocks HIGH/CRITICAL findings; SARIF uploads get the `actions: read` permission they need.

[Unreleased]: https://github.com/vxrz/service-manager/commits/HEAD
