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
- Audit log integrity (review C):
  - verification fails on rows with a sequence number below 1, on rows outside the chain, and on entries removed while the server runs; the database refuses such rows (migration `security-001`);
  - every hour, on each verification and before each export a checkpoint `{seq, hash, digest, count, ts}` is signed with a per-installation Ed25519 key kept in the vault; it is written to the audit log, to `audit-anchor.json` in the data folder and as a log line for the SIEM, and can be e-mailed to auditors (*Audit log → Anchoring*);
  - verification compares the chain with these anchors and with an external checkpoint (pasted in the UI, `SM_AUDIT_ANCHOR`, `SM_AUDIT_ANCHOR_FILE`): removing the newest entries or wiping the log is detected;
  - exports include `prevHash`, details and a signed checkpoint; `npm run audit:verify-export` checks an export offline with the public key;
  - report verification, protocol seals and summary reports only trust audit entries whose HMAC and chain position check out – a forged row no longer makes a forged PDF verify;
  - audited free text is capped, failed sign-ins are summed up per account/address and minute, and entries recorded while the vault is locked are bounded (dropped entries are counted in the log); unauthenticated requests may send at most 64 KB.
- Sessions are bound to a per-session key that the web app keeps in its origin's `localStorage` and sends as `x-sm-session`; a session cookie received by another program on the same host no longer signs anyone in. Download links carry a read-only link key. **Everyone has to sign in again after the update.**
- The master passphrase can be read from a file (`SM_MASTER_PASSPHRASE_FILE`: Docker secrets, systemd credentials); both passphrase variables are removed from the environment at start. Browser steps start Chromium with a minimal environment and with its sandbox (unless running as root); the desktop launcher starts the user's browser without `SM_*` variables or secrets.
- Vault format 2: random data, audit, integrity and signing keys wrapped with a scrypt key (N=2^17); existing vaults are converted on their first unlock (the audit chain stays valid). Administrators can change the master passphrase (*Settings*), optionally rotating the data key; new passphrases need 12 characters; wrong passphrases are audited and throttled.
- Platform connection settings (base URL, authentication, token URL, trusted origins, headers) and sign-in provider settings are sealed with an HMAC; when they are changed directly in the database, no requests are sent until an administrator confirms them.
- Password checks run off the event loop with a concurrency limit and the same cost for unknown user names.
- The desktop launcher only opens its window for a server that proves it knows the secret in the user's data folder (port squatters are refused).
- Data folder `0700`, database, vault and key files `0600` on Linux/macOS (existing installations are fixed at start).
- Audit CSV export escapes cells that spreadsheets would run as formulas.
- `SM_TRUST_PROXY` for reverse proxies (real client addresses for the audit log, lockouts and webhook CIDRs); `Secure` cookie and HSTS with an `https://` `SM_PUBLIC_URL`.
- Failed sign-ins with user names that belong to no account store a pseudonym instead of the typed text; new process input type *secret* (stored encrypted, `***` everywhere).
- Redaction of JSON-/URL-/Base64-encoded secrets, Basic credentials and OAuth token fields in run data; error reports scrub encoded secrets; traces carry a user pseudonym and scrubbed exception messages; TLS 1.2+ with forward-secret ciphers; `Cache-Control: no-store` on API responses; the desktop executable re-checks its unpacked files at every start; hardened compose files.
- Supply chain: `npm ci --ignore-scripts` plus an enforced install-script allow-list in CI, release builds and the Dockerfile; signed build provenance and SBOM attestations for release archives and the container image.
- New: [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md) (checklist for a work deployment) and [docs/PRIVACY.md](docs/PRIVACY.md).

[Unreleased]: https://github.com/vxrz/service-manager/commits/HEAD
