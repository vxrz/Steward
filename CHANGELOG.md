# Changelog

All notable changes to Steward are documented here.

The format follows [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Commits follow [Conventional Commits](https://www.conventionalcommits.org/), so entries can be drafted from the commit history.

## [Unreleased]

The first public version, 0.1.0, is being prepared. It contains everything below.

### Added

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
- System status page (*Settings → System status*, administrators; auditors get a view without paths and host names): readiness checks, database type and size, vault, scheduler with the next runs, monitor engine, notification channels, error reporting, tracing, metrics access, public API, retention and last cleanup, runtime (Node.js, platform, uptime, memory, time zone, installation type). Health and readiness URLs with copy buttons and monitoring hints (`GET /api/system/status`).

**Appearance and product information**

- Theming for the whole installation (*Settings → Appearance*, administrators): primary and accent colour, default colour scheme (users keep their own light/dark choice), corner radius, a display name for the header, window title and sign-in page (e.g. "ACME Steward") and a header logo (PNG, JPEG or WebP up to 512 KB, checked by its content; no SVG).
  - Ten-shade palettes generated from each colour (OKLCH); text on filled buttons and badges switches between black and white, and links use a darker or lighter shade where needed, so text stays at WCAG AA in light and dark mode. The settings explain each adjustment and show a live preview in both colour schemes; *Reset to Steward defaults*.
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
- Command-line tools follow clig.dev conventions (`--help`, exit codes, `--json`, `NO_COLOR`).

### Security

- Platform credentials are no longer sent to hosts outside the platform when a step calls an absolute URL.
- The vault rejects shortened AES-GCM authentication tags.

[Unreleased]: https://github.com/vxrz/service-manager/commits/HEAD
