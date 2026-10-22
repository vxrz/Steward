# Changelog

All notable changes to Steward are documented here.

The format follows [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Commits follow [Conventional Commits](https://www.conventionalcommits.org/), so entries can be drafted from the commit history.

## [Unreleased]

The first public version, 0.1.0, is being prepared. It contains everything below.

### Added

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

### Security

- Credentials register: no field holds a secret; free text, links and comments are checked for private keys, JWTs, well-known token formats, passwords in URLs and random-looking tokens and refused (the value is never echoed); only `http(s)` links are clickable (`javascript:`/`data:` refused); uploaded certificates are parsed and only their metadata is stored, files with a private key (PEM, DER, PKCS#12) are rejected; CSV exports are protected against formula injection.
- Gatus metrics mode: `/metrics` is unauthenticated in Gatus – the docs require it to be network-restricted. Steward fetches it through the platform and the outbound policy, only below the platform's base URL, with an 8 MB limit, a timeout and a bounded parser.
- E-mail to addresses outside Steward (credential owners, report recipients): only to allowed domains – the new setting _Settings → Notifications → Allowed e-mail domains for addresses outside Steward_ (`corp.example`, `*.corp.example`); while it is empty, the domains of the users' own addresses that an administrator, a single sign-on account or at least two users use. Checked when saving and again on every send. At most 10 addresses per credential entry and 20 per report schedule; owners who edit an entry only as its owner cannot change its owner addresses. Subjects carry user-chosen names only quoted after a fixed prefix and shortened to 80 characters.
- Report schedules: cron expressions with seconds are refused, a schedule runs at most once an hour (also schedules saved before), at most 20 schedules per owner.
- Certificate upload: PEM blocks are found in one linear pass, with at most 21 BEGIN lines (a file with many BEGIN lines without END blocked the server for seconds).
- MCP (new): its own token scope that no other API accepts (and MCP endpoints accept no other scope); `Origin` validation against DNS rebinding next to the `Host` allow-list; 64 kB request limit, no batches, strict argument schemas, per-token rate limits and time limits; tool output is structured JSON marked as untrusted data. The platform gateway is opt-in per platform, read-only (writes are refused and audited), builds paths only from the API specification or allow-listed prefixes (no absolute URLs, dot segments or encoded separators), validates query parameters, applies the outbound policy, does not follow redirects, caps responses at 512 kB, masks credentials and returns no cookies.
- Records: uploaded attachments are checked against their extension (magic numbers, e-mail headers, UTF-8 text), stored read-only with their SHA-256 (checked on download) and always downloaded as attachments in a sandbox; Markdown is rendered from a syntax tree without HTML (links: http, https and mailto only); YAML frontmatter is parsed with the core schema only (no custom tags, aliases limited) and sizes are limited; links only name targets the reader may see; a signed PDF is only accepted when its first bytes match a generated PDF of the record whose audit entry is authentic.
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

[Unreleased]: https://github.com/vxrz/service-manager/commits/HEAD
