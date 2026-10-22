# Steward – improvements, standards and roadmap

This document collects what makes sense next: improvements to the tool, standards to align with, UX ideas, how workflow engines such as Kestra or Temporal could fit, and the observability baseline. The example procedures themselves are described in [`examples/README.md`](../examples/README.md).

## 1. Where it stands

| Area | Today |
| --- | --- |
| Processes | Node-RED-style graph flows. Versioned, dry runs, approvals and selections, browser steps. Durable: resumes after a restart without repeating finished steps. |
| Platforms | Any REST API. OpenAPI import (file, paste, URL), connector types (export/import), encrypted credentials. |
| Access | Local accounts and OIDC/Entra ID SSO. Roles, teams, per-process and per-platform access lists, four-eyes approvals. |
| Evidence | HMAC-chained audit log, run protocols (HTML/JSON) with a sealed fingerprint, screenshots, branded PDF/A reports (run and summary) recorded in the audit log, ready for signing. |
| Dashboards | Fed by *Publish to dashboard* nodes: dataset snapshots and metric history, KPI/trend/status/table widgets. |
| Import / export | Single process (YAML), dashboard (YAML), connector type (JSON), bundles of processes and dashboards (JSON), example library in `examples/`, `npm run validate` for CI. |
| Observability | Structured JSON logs (pino) with request, run and trace correlation. Optional OpenTelemetry traces (runs → nodes → HTTP calls, W3C `traceparent` propagation). Prometheus metrics and readiness probe. |
| Operations | Notifications (in-app, e-mail, Teams, webhook), API tokens, CSP/HSTS headers, retention of runs and notifications, contract checks. |
| Distribution | Desktop executable (Windows/macOS/Linux), installable PWA, container image, release workflow with SBOM. See [INSTALL.md](INSTALL.md). |

## 2. Import and export – how to work "as code"

Everything that defines behaviour can leave the tool as text:

| What | Format | Where |
| --- | --- | --- |
| One process | YAML (graph or compact sequential format) | Process editor → *Export YAML*; *Processes → Import YAML* (several files at once) |
| Several processes and dashboards | Bundle JSON | *Processes → Export bundle / Import bundle*. On conflict choose *new version*, *skip* or *copy*. |
| Dashboard | YAML | Dashboard → *Export*; *Dashboards → Import* |
| Connector type (platform template without credentials) | JSON | Platform → *Save as connector type*; *Platforms → Connector types → Export / Import* |
| Library | YAML files in `examples/processes` and `examples/dashboards` | Shown in the *From template* galleries |

**Recommended workflow (GitOps-lite):**

1. Keep your company's procedures in a Git repository, in the same layout as `examples/`.
2. Review changes through pull requests.
3. Let CI run `npm run validate` on them.
4. Import approved versions with a bundle.

The tool keeps its own version history and audit trail. Git adds peer review before a change reaches production.

## 3. Kestra, Temporal and friends – do they fit?

| Tool | What it is | Fit for this project |
| --- | --- | --- |
| **Temporal** | Durable-execution engine. Workflows written in code (TS/Go/Java/…) survive crashes. Timers, signals (good for human approvals), retries, a history per workflow. Needs a Temporal server (cluster + database). | **Best candidate if the tool grows** into a hosted, multi-node service with many long-running runs. The usual pattern is an *interpreter workflow*: one generic Temporal workflow walks our graph, each node becomes an activity, and user tasks become signals. Our engine is isolated in `server/src/engine/runner.ts` and already journals node by node, so a swap would not change the process format, UI or permissions. Too heavy for a local tool today. |
| **Kestra** | Declarative YAML orchestrator (Java; Postgres or Elasticsearch). Scheduling, event triggers, many plugins, "Pause" for approvals. RBAC, SSO and audit logs are largely Enterprise features. | Overlaps with what is built here, so it is not a base for the same reasons as Windmill. It could run heavy data/ETL jobs next to this tool. The *API call* node can trigger Kestra flows through its API. |
| **Node-RED** | Low-code flows, strong in OT/edge (ships with Industrial Edge). | An interop partner, not a replacement. Edge-side flows can stay in Node-RED; this tool calls their HTTP endpoints or reads what they publish. |
| **n8n / Windmill** | General automation platforms. | Already discussed. Good for generic glue work, weaker on dry runs, attestation-style decisions and sealed evidence. |

**Recommendation:** keep the engine. Make the engine boundary explicit, i.e. an interface for "start run / signal decision / cancel", so a Temporal backend could be added later without touching anything else.

## 4. Observability

**Built in:**

- **Logs.** JSON lines on stdout via pino. Levels follow `SM_LOG_LEVEL`. Every API request produces one line (debug for reads, info for changes, warn/error for problems). Runs log *started/finished* with `runId`, `processId` and duration. Failed steps are logged with their step key. Secrets, cookies and auth headers are redacted. When tracing is on, every line carries `trace_id`/`span_id`. Ship stdout with your usual agent (Fluent Bit, Vector, Splunk UF, Azure Monitor agent).
- **Traces.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` (plus the standard `OTEL_*` variables) to export spans:
  - one per run,
  - one per executed node,
  - one per platform HTTP call, with method, host, path (no query string) and status.

  Outgoing calls carry `traceparent`; `SM_OTEL_PROPAGATE=0` turns that off.
- **Audit.** Kept deliberately separate from operational logs. It is tamper-evident and records *who did what*.

**Next steps:**

1. **OpenTelemetry metrics:**
   - runs by process and status,
   - run and step duration histograms,
   - platform call latency and error rate by host,
   - open tasks and their age,
   - dataset staleness.

   Also offer a Prometheus `/metrics` endpoint for those who prefer it.
2. **Alerting.** Failed checks, stale datasets and failed scheduled runs should notify e-mail, Teams or webhooks, with de-duplication and quiet hours.
3. **Health probes.** `/api/health` exists. Add `/api/ready` (vault unlocked, scheduler running, database writable) for container orchestration.
4. **Audit anchoring.** Periodically export the latest audit hash to WORM storage, or timestamp it (RFC 3161), so the chain can be proven against an external reference.

## 5. Standards and best practices to align with

**Governance and compliance**

- **ITIL 4.** Treat every process as a *standard change* or *service request* model:
  - approved once, run many times, with evidence;
  - map the procedures to *access management*, *service request management*, *monitoring & event management* and *change enablement*.
- **ISO/IEC 27001:2022 Annex A.** Requirements this tool provides evidence for:
  - 5.15–5.18: access control, identity management, access rights and their periodic review;
  - 8.2: privileged access;
  - 8.15–8.16: logging and monitoring.

  The access-review, privileged-review and offboarding flows generate exactly the evidence auditors ask for.
- **IEC 62443 (OT security).** For Industrial Edge:
  - asset inventory, firmware and patch compliance, least privilege, monitoring of device connectivity;
  - see the IEM inventory and compliance flows.
- **GDPR.** Protocols contain personal data (user names, last logins). Define retention periods, minimise columns in published datasets (projection via `columns`), and keep access to protocols restricted (auditor/admin).
- **SOC 2 / internal audit.** Sealed protocols, four-eyes approvals and a verifiable audit chain map directly to change-management and access-review controls.

**Security (OWASP ASVS level 2 as the yardstick)**

1. A Content-Security-Policy header (the UI needs no third-party sources) and HSTS when served over HTTPS.
2. API tokens or service accounts with scopes for automation and CI, instead of sharing user sessions.
3. Secrets in an external vault (Azure Key Vault, HashiCorp Vault) as an option. Master passphrase rotation (re-encrypt everything) and backup/restore drills.
4. Dependency hygiene:
   - Renovate or Dependabot;
   - `npm audit --omit=dev` in CI (included);
   - an SBOM (CycloneDX) per release;
   - signed release artifacts.
5. Least-privilege platform credentials: Insights Hub service credentials only with the scopes a process needs; a separate read-only credential for inventory flows.

**Engineering**

1. CI is included in `.github/workflows/ci.yml` (typecheck, validate, tests, build, audit). Add ESLint/Prettier, and Playwright UI tests for the critical paths (sign-in, run with decision, dashboard).
2. Contract tests against a real sandbox tenant (recorded fixtures), so API changes at Siemens are noticed before production runs fail.
3. Our own OpenAPI description of the Steward API (generated from the zod schemas). That allows automation and integration with ITSM tools such as ServiceNow or Jira Service Management.
4. Semantic versioning, a changelog, migration tests.

**Process design (what a "good" procedure looks like)**

1. **Read, decide, write, verify, report.** Gather data, let a person decide or approve, write, re-read to verify, publish evidence.
2. **Make writes safe to repeat.**
   - Check before writing.
   - Accept "already done" answers (`expectStatus: [200, 201, 409]`).
   - Treat the run as resumable.
3. **Guard destructive steps.**
   - Always dry-run first.
   - Require approval with `fourEyes` for deletions and privilege removal.
   - Add a `maxItems` safety limit on loops.
4. **Least privilege per process.** Use access lists, a dedicated platform credential per purpose, and restrict production platforms to a team.
5. **Explicit inputs with defaults.** No hidden constants for things people tune (thresholds, group names).
6. **Publish what you learn.** Every scheduled process should publish a dataset (status per item plus metrics), so the dashboard shows the result without anyone opening protocols.

## 6. UX improvements

**High value**

1. **Expression assistant.** Autocomplete for `vars.*`, `inputs.*` and node outputs, and live evaluation of an expression against the data of the last run. This is the biggest productivity gain for flow authors.
2. **Flow debugger.**
   - Run a single node with sample data.
   - Step through a run.
   - Show `vars` after each node from the run journal.
   - Show a "data at this wire" preview, like Node-RED's debug sidebar.
3. **Subflows.** Call another process as a node, with inputs and outputs, to reuse building blocks such as "resolve group id" or "remove all memberships".
4. **Undo/redo and copy/paste across flows** in the canvas.
5. **Notifications.** An in-app notification centre, plus e-mail/Teams for "decision needed" and "check failed", with deep links into the task.
6. **Mobile approvals.** An installable PWA with push notifications for approvers. The task panel already works at phone width.

**Polish**

- Command palette (Ctrl/Cmd+K): jump to a process, run, dashboard or platform.
- Global search, breadcrumbs, and a "recently used" list.
- Run comparison: diff two runs' decisions and changes.
- Process diff between versions, visually on the canvas and as YAML.
- A drag-and-drop layout for dashboard widgets, saved views, and a time-range filter row (per the dataviz guidance: one filter row above all widgets).
- Localisation (e.g. German UI), date and number formats per locale.
- An accessibility pass to WCAG 2.2 AA: keyboard flows on the canvas, focus order, contrast. Table views for charts already exist.
- Onboarding: a first-run checklist (add platform → import template → dry run → schedule → dashboard).

## 7. Performance and scaling

- **Lists.** Cursor pagination for runs, tasks and audit (partly done). Archive or compress old run journals (gzip blobs) with a retention policy.
- **Data volume.**
  - Large step outputs: store compressed, show previews (done).
  - Metric history: downsampled on read and capped per series (done). Add roll-ups (hourly → daily) after 30 days.
- **Throughput.**
  - Parallel *for each* with a concurrency limit per platform.
  - Respect `429 Retry-After` with exponential backoff and jitter.
  - Per-host rate limits.
- **Efficient feeding.**
  - Request only the needed attributes (`attributes=` on Insights Hub user lists).
  - Use the largest allowed page sizes.
  - Fetch incrementally where the API allows it (`meta.lastModified` filters).
  - Publish compact projections.
  - Dashboards read stored snapshots (with ETag/304), never live APIs.
- **Web bundle.** Lazy-load routes (canvas, dashboards) to cut the initial ~1 MB JavaScript.
- **Hosted mode.** Postgres instead of SQLite, the engine as a separate worker process (or Temporal), and a shared vault via KMS.

## 8. Prioritised roadmap

| When | Item |
| --- | --- |
| **Done** | Notifications for decisions and failed checks (e-mail/Teams/webhook). CSP and HSTS headers. Retry-After/backoff and per-platform concurrency. API tokens. Retention policy. Expression assistant, node inspector, undo/redo, version diff. Subflows. Prometheus `/metrics`, `/ready`. Contract checks. Parallel for-each. PWA with browser notifications. Command palette, lazy-loaded UI. Desktop executable, container, release workflow. |
| **Next** | Step-through debugging and "run this node with sample data". Quiet hours for notifications. Run comparison. First-run checklist. ESLint/Prettier and Playwright UI tests in CI. German UI. |
| **Later** (bigger projects) | Hosted mode (Postgres, separate workers, KMS-backed vault). Optional Temporal backend. SCIM provisioning. ITSM integration (ServiceNow/Jira tickets per run). Process marketplace via Git repositories. Audit anchoring (RFC 3161). Signed releases and auto-update. |
