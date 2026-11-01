# Hardening checklist for a work deployment

Steward holds credentials for production systems, can change data on them, and its audit log and PDF reports are meant as evidence (change management, IEC 62443, ISO 27001). This page lists what to set up so that it lives up to that at work, for example in an industrial company. Work through it before the first production platform is connected.

Each item says **why** it matters. Items marked **(must)** close a gap that a security review found exploitable; the others are strongly recommended.

Contents: [Where it runs](#where-it-runs) · [Network, TLS and reverse proxy](#network-tls-and-reverse-proxy) · [Sign-in](#sign-in) · [Master passphrase](#master-passphrase) · [Least privilege](#least-privilege) · [Outbound connections](#outbound-connections) · [Browser steps and Chromium](#browser-steps-and-chromium) · [Audit log as evidence](#audit-log-as-evidence) · [Backups](#backups) · [Monitoring and SIEM](#monitoring-and-siem) · [Updates](#updates) · [Shared hosts](#shared-hosts) · [Verifying downloads](#verifying-downloads) · [Known limits](#known-limits)

## Where it runs

- **(must) A dedicated VM or container for a team installation** – not a shared Windows host (RDS, Citrix, jump host). Anyone who can run code as the service account, or read its data folder, can read the database and – with the passphrase – every credential.
- Linux/macOS: Steward creates its data folder with mode `0700` and the database, vault, anchor and instance files with `0600`, and fixes the permissions of existing installations at start (a warning is logged when that fails). Keep the data folder on a local disk, owned by the service account.
- Container: use the provided `docker-compose.yml` – read-only root file system, no Linux capabilities, `no-new-privileges`, process and memory limits, the port published on `127.0.0.1` only. The image runs as uid 1000 and only writes to `/data` and `/tmp`.
- Desktop executable: fine for one person on their own laptop. The launcher only opens its window when the server on the port proves that it knows the secret in your data folder (`instance.json`); otherwise it refuses with "Port … is in use by another program". Do not start it on a multi-user machine.

## Network, TLS and reverse proxy

- Keep `SM_HOST=127.0.0.1` unless colleagues connect. Then:
  - **(must)** TLS. Either a reverse proxy that terminates TLS, or `SM_TLS_CERT`/`SM_TLS_KEY` (TLS 1.2+, forward-secret AEAD ciphers; override with `SM_TLS_CIPHERS` only if your PKI requires it).
  - `SM_ALLOWED_HOSTS=<DNS name>` – other `Host` headers are refused (DNS rebinding).
  - `SM_PUBLIC_URL=https://<DNS name>` – used for SSO redirects and links; an `https://` URL makes the session cookie `Secure` and turns on HSTS even when TLS ends at the proxy.
  - Prefer an own host name over a path prefix (`https://apps.corp.example/steward`): under a path every application on that host shares Steward's origin, and the cookie cannot use `__Host-`. See [INSTALL.md](INSTALL.md#behind-a-reverse-proxy).
- **(must) Behind a proxy: `SM_TRUST_PROXY`** – preferably the proxies' addresses/CIDRs (`10.0.0.5`, `10.1.0.0/16`, `loopback`), or the number of proxy hops (`1`; only honoured when the direct peer has a loopback or private address, so a client that reaches Steward directly cannot forge its address). Without it every request seems to come from the proxy: the audit log records the proxy's address, the sign-in lockout locks out everyone at once, everyone who is not signed in shares one [rate-limit](#request-rate-limits) bucket, and webhook source-address rules cannot work. `true` is refused on purpose (any client could claim any address). Make the proxy overwrite (not append to) `X-Forwarded-For` from clients.
- Proxy settings: forward `Host` (or `X-Forwarded-Host`), `X-Forwarded-Proto`; allow request bodies as large as your uploads (60 MB covers record attachments, report PDFs and imports, see [INSTALL.md](INSTALL.md); migration packages need `SM_MIGRATION_MAX_MB`) – Steward sets the limit of each route itself (see [Request body limits](#request-body-limits)); do not cache `/api/` (Steward sends `Cache-Control: no-store`).
- Firewall: only the proxy may reach Steward's port.

## Request rate limits

Steward limits how many requests one client can send, so a script or a stuck browser tab cannot keep the server busy (PDF rendering, exports, checks against platforms).

- **Who is counted:** the signed-in user (session or API token). Requests without a valid sign-in count per client address (IPv6 per /64 network). A made-up session cookie or token does not get its own counter: it counts against the address, also when Steward refuses it with 401. Behind a reverse proxy, the address is only right with `SM_TRUST_PROXY`.
- **General limit:** `SM_RATE_LIMIT_PER_MINUTE` requests per minute and user or address, default `600`. That is far above what the web app needs, even with dashboards and pages that refresh themselves. `0` or `off` turns all limits on this page off.
- **Lower limits for expensive actions,** per user (or address) and route, counted separately from the general limit:

  | Limit per minute                    | Routes                                                                                                                                                                                                                                                                                                                                                                                              |
  | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 30                                  | PDF reports (run, summary, record, branding preview, scheduled report _Run now_), report and evidence pack downloads, creating evidence packs, PDF and signature checks, bundle and audit exports, the credentials CSV, imports (bundle, records, catalogues, monitors, connector types), audit chain verification and checkpoints, maintenance clean-up, the daily summary preview, the demo setup |
  | 120                                 | Starting runs, schedules, monitor checks and access checks, refreshing dashboards, platform tests, requests and contract checks, Git fetches, Gatus scrapes, trigger tests and heartbeat test reports, test notifications, SSO discovery                                                                                                                                                            |
  | 10                                  | Password changes and resets, unlocking the vault, changing the master passphrase, the first setup                                                                                                                                                                                                                                                                                                   |
  | 10 × the general limit, per address | Inbound webhooks (`/api/hooks/…`); triggers, heartbeats and monitor gateways keep their own limits on top. The web UI's files and its start-up reads before sign-in (page, built assets, manifest, theme, logo, error reporting set-up): a browser with an empty cache fetches dozens of them per page, and several people may share an address                                                     |

- **Not counted here:** the public REST API `/api/v1` (its own per-token limit, `SM_API_RATE_LIMIT`, see [API.md](API.md#rate-limits)) and the MCP endpoint (`SM_MCP_RATE_LIMIT`), so their requests are not counted twice; `/api/health` and `/api/ready`, so probes keep working while someone else from the same address is limited; the demo's mock platforms.
- **Above a limit** Steward answers `429 Too Many Requests` with `Retry-After` (seconds) and the error code `RATE_LIMITED`; the web app shows how long to wait. Counted answers carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. A limited user or address is logged once per minute as `rate limit reached` (with the key, the limit and the route, never cookies or tokens); it is not written to the audit log. Failed sign-ins keep their own, stricter lockout (see [Sign-in](#sign-in)).
- **One server process:** the counters are kept in memory and reset on restart. Several Steward instances behind a load balancer would each count on their own (Steward runs as one instance today); a shared store such as Redis would be needed then.

## Request body limits

- **Size:** 1 MB per request by default. Only the routes that carry the content of a file in a JSON body accept more, each sized from its own content limit (JSON escaping and UTF-8 can double a text, so a text limit counts twice); they are listed in `server/src/bodyLimits.ts`, and a test fails when any other route accepts more than 1 MB:

  | Route                                                                                                   | Body limit | Why                                                                                     |
  | ------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
  | `POST /api/records/import`                                                                              | 4.06 MB    | Markdown files of up to 2 MB together                                                   |
  | `POST /api/compliance/catalogues/import`                                                                | 2.02 MB    | a control catalogue of up to 1 MB                                                       |
  | `POST /api/monitors/import`                                                                             | 1.06 MB    | a monitor file (YAML) of up to 512 KB                                                   |
  | `POST /api/monitors/:id/instances`                                                                      | 2.06 MB    | template instances from a CSV of up to 1 MB                                             |
  | `POST`/`PUT /api/processes…`, `POST /api/processes/validate`, `/to-yaml`, `POST`/`PUT /api/dashboards…` | 4.06 MB    | a process or dashboard definition of up to 2 MB (`MAX_DEFINITION_TEXT`)                 |
  | `POST /api/platforms/:id/specs`                                                                         | 25 MB      | an API specification of up to 20 MB, as when fetched from a URL                         |
  | `POST /api/bundle/import`, `POST /api/platform-types/import`                                            | 25 MB      | exports of a whole installation (processes and dashboards; a connector type with specs) |
  | `POST /api/reports/branding/logo`                                                                       | 1.35 MB    | the 1 MB logo as base64 (the web app sends multipart)                                   |
  | `POST /api/reports/verify`                                                                              | 25 MB      | a report PDF as base64 for scripts (the web app sends multipart, up to 50 MB)           |

  File uploads as `multipart/form-data` (record attachments and signed PDFs, logos, documentation, certificates, migration packages) are streamed and limited per file by their route instead. Some routes have lower limits (sign-in 16 KB, audit verification 256 KB, MCP 64 KB, inbound webhooks 64–512 KB). Above the limit Steward answers `413` with the error code `BODY_TOO_LARGE` (`BODY_TOO_LARGE_KIB` below 1 MB) and the limit; the web app shows it translated. Process inputs, also a CSV table loaded from a file, are part of the 1 MB request that starts a run. Requests without a session or token may send at most 64 KB and must give a `Content-Length`.

- **Shape:** before a route validates a JSON body, Steward counts its contents: at most 10,000 items in one list, 10,000 fields in one object, 200,000 values in all and 100 levels of nesting (imports of bundles, connector types and monitors: 50,000 items or fields and 1,000,000 values). Above that: `413` with the error code `BODY_TOO_COMPLEX`. The count is linear and stops at the first limit.
- **Lists and maps in the schemas:** every list a route, an import, a webhook mapping, an MCP tool or a process definition accepts has its own maximum length, and every map (inputs, headers, fields …) a maximum number of keys. Validation (zod 4) checks the length first and stops there, so a long list can't make it allocate memory per item ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), fixed in zod 4.6.6). The shape limits above stay as a second line of defence; a test checks that no schema leaves out a limit.

## Sign-in

- **Single sign-on** (Entra ID / OIDC) with your company's MFA. Then set _Settings → Sign-in_ to _Single sign-on, administrators also with a password_ so that ordinary users cannot fall back to passwords, or – once an administrator has signed in with single sign-on – to **_Single sign-on only_** (`SM_PASSWORD_LOGIN=none` pins it for locked-down deployments; on a new installation it takes effect – for good – once an administrator has signed in with single sign-on, so the first administrator can set Steward up with a password). In that mode nobody signs in with a password: `POST /api/auth/login` answers every attempt with the usual "wrong user name or password" (without checking the password), password resets and new passwords are refused, new accounts get no password and are linked at their first single sign-on, and open password sessions end. API tokens keep working – they are not a sign-in.
- **Break-glass.** With _Single sign-on only_, the way in when the identity provider fails is **emergency access** from the server: `steward admin emergency-access <admin>` prints a one-time link (for one administrator account, one use, a window of at most 24 hours – each administrator has at most one open window, a new link replaces the older one of that account; a session of at most one hour with a banner, every action flagged in the audit log, the other administrators notified). It needs the data folder and the master passphrase – so keep server access and the passphrase with at least two people – and cannot be triggered remotely: a running server only accepts the grant signed with the vault's key, fresh, for its own instance, directly over loopback. See [INSTALL.md](INSTALL.md#locked-out-of-single-sign-on). With password sign-in for administrators instead, keep one or two local break-glass administrator accounts with long passwords in the company password manager; if their passwords are lost too, `steward admin reset-password` on the server sets a one-time password (needs the data folder and the master passphrase, audited; see [INSTALL.md](INSTALL.md#forgotten-administrator-password)).
- Map roles from IdP groups (`requireMapping` for production) – leavers lose access when the IdP account is disabled.
- **Who claims an account at the first single sign-on:** an account created without a password (_Users & teams → New user → Signs in with_, or a new single sign-on account from a migration) belongs to one provider; only that provider links it, by its exact user name. A linked account is never handed to another identity of the same provider: after the first sign-in it is found by the identity's **stable identifier** (the issuer plus `sub`, or Entra ID `tid` + `oid`), never by its name, and a change of the identifier claims re-links each account only through its own earlier issuer + `sub` (audited `user.sso_relinked`). Whether a **local account** with the same user name is linked is a setting per provider – _only accounts an administrator bound to this provider_ (the default for new providers; bind under _Edit user → Signs in with_, which removes the password), _any local account by name_ (providers from before this setting; the editor warns), or _never_. A local **administrator** is never linked by its name. Whenever the e-mail claim names or identifies an account, the provider must confirm the address (`email_verified`) unless it is marked as verifying every address. **Every claim that names, identifies or links accounts must be controlled by your organisation** (nOAuth): use an immutable identifier, never `email`/`upn`/`preferred_username` of a multi-tenant issuer (Entra `common`/`organizations` – add the required claim `tid`), never `name`; restrict Google sign-in to your domain with the required claim `hd`. The stable identifier must include `sub` or `oid` (or a claim you confirm as unique per person); claims many people share such as `tid` are refused. Stripping `@domain` from user names works only for the domains you list – any other domain is refused. A refused sign-in shows the person only a reference; the reason is in the audit log. The provider editor warns about each of these, and every change of the claim settings is audited with the former values. Group overage (too many groups for the token) never grants roles and is audited. Check a provider with the **test sign-in** before enabling it: it shows the claims and the resulting account without signing in or changing anything. See [SSO.md](SSO.md).
- Sessions are bound to a per-session key in the browser (origin-isolated `localStorage`), not only to the cookie. Scripts use API tokens (`Authorization: Bearer smt_…`), never copied cookies.
- Sessions end after 30 minutes without a request and 12 hours after sign-in (OWASP ASVS level 2). An open Steward tab keeps a session alive. Change it with `SM_SESSION_IDLE_MINUTES` and `SM_SESSION_MAX_HOURS`; longer values are logged as a warning at startup. Over HTTPS the cookie is called `__Host-sm_session`, so a neighbouring subdomain cannot plant or overwrite it.
- API tokens act as their owner, but they cannot manage users, teams, single sign-on providers, the sign-in and outbound settings, the master passphrase or other tokens, and they never do a [step-up action](#step-up-re-authentication). Do that signed in. Give tokens an expiry date and the `read` scope where possible.
- Steward logs a warning at startup for risky settings: reachable under another host name without HTTPS, demo mode on a network address, the passphrase in `SM_MASTER_PASSPHRASE` instead of a file, public metrics, long sessions.
- Failed sign-ins are rate-limited per account, per account and address, and per address, and audited in bounded form (see [PRIVACY.md](PRIVACY.md)).

## Step-up re-authentication

Sensitive actions need a fresh confirmation that the person at the keyboard is the account's owner (OWASP ASVS 3.7.1). A stolen or forgotten session alone cannot do them.

**How a session confirms** follows how it was opened:

- **Password session:** the password again, in a dialog. It is limited and counted like a sign-in: ten tries a minute, five wrong ones lock the account for five minutes from that address, and the failures count against the sign-in limits too. Audited as `auth.step_up` / `auth.step_up_failed`.
- **Single sign-on session:** a fresh sign-in at the same provider, in a popup (or the same window when popups are blocked). Steward asks with `prompt=login` and `max_age=0` and accepts the answer only when the ID token's `auth_time` is at most `SM_STEP_UP_MINUTES` old and the identity is the signed-in account – the same stable identifier a sign-in links by, not the user name. A provider that sends no `auth_time` cannot confirm (see [SSO.md](SSO.md#step-up-re-authentication)). Per provider, _Require multi-factor authentication_ also checks `amr` for `mfa`, the `acr` against configured `acr_values`, or an Entra ID authentication context in `acrs`.
- **A sign-in counts:** right after signing in with a password, or with single sign-on whose `auth_time` is fresh (and shows MFA where the provider requires it), the session is confirmed already.
- **Emergency sessions** (`steward admin emergency-access`) count as confirmed for their whole life (at most one hour): opening one needed the server, the data folder and the master passphrase – more than a password – and they have no password or provider to confirm with. They still cannot create API tokens.
- **API tokens** never do a step-up action, whatever their scope: a token cannot confirm anything. Most of these routes are for signed-in sessions anyway; on the others (e-mail domains in the notification settings, evidence packs) a token gets `403 SESSION_REQUIRED` – for the notification settings only when the allowed domains change.

A confirmation lasts **`SM_STEP_UP_MINUTES`** (default 5, 1–15) for the session that made it – not for other sessions of the same person. It ends with the session; `DELETE /api/auth/step-up` ends it right away.

**What needs it:**

| Action                                                                                                                                                                                             | Route                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Creating an API or MCP token (it outlives the session)                                                                                                                                             | `POST /api/me/tokens`                                                                                                     |
| Changing the master passphrase                                                                                                                                                                     | `POST /api/vault/passphrase`                                                                                              |
| Creating an account with roles                                                                                                                                                                     | `POST /api/users` (with roles)                                                                                            |
| Changing an account's roles, binding it to a provider, (de)activating an administrator                                                                                                             | `PUT /api/users/:id` (only for those changes)                                                                             |
| Resetting a password (a temporary password lets the administrator sign in as the person)                                                                                                           | `POST /api/users/:id/reset-password`                                                                                      |
| Adding, changing (incl. claim mapping) or deleting a single sign-on provider                                                                                                                       | `POST/PUT/DELETE /api/sso/providers…`                                                                                     |
| Changing the sign-in mode, the outbound policy or the outbound allow-list, turning the four-eyes rule for dismissing findings off                                                                  | `PUT /api/settings` (only for those changes)                                                                              |
| Changing where notifications go: SMTP server, port, TLS, user or sender, a new Teams or webhook URL, the base URL of links, the allowed e-mail domains, the channels of the emergency access alert | `PUT /api/settings/notifications` (only for those changes)                                                                |
| Adding team members or renaming a team (teams are subjects of access lists)                                                                                                                        | `POST /api/teams` (with members), `PUT /api/teams/:id`                                                                    |
| Giving anyone a right in an access list (platforms, processes, monitors): a new entry or a raised one, an empty list that falls back to the role defaults, a new owner                             | `PUT /api/platforms/:id/access`, `PUT /api/processes/:id/access`, `PUT /api/monitors/:id/access` (only for those changes) |
| Exporting an evidence pack, the audit log or the credential register (they leave Steward in bulk)                                                                                                  | `POST /api/compliance/evidence-packs`, `GET /api/audit/export`, `GET /api/credentials/export.csv`                         |
| Changing where the signed audit checkpoints go                                                                                                                                                     | `PUT /api/audit/anchoring`                                                                                                |
| Exporting or applying a migration package (every credential leaves, or a whole instance comes in)                                                                                                  | `POST /api/migration/export`, `POST /api/migration/imports/staged/:id/apply`                                              |
| Changing the CIA scale (it maps or flags the ratings of every application at once)                                                                                                                 | `PUT /api/catalogue/cia-scale`                                                                                            |

Everyday changes stay as they are: display names, retention periods, removing team members or rights, reordering an access list, clearing an owner (that takes access away only), deleting a team, platform credentials, processes, single exports of one process, dashboard, monitor or record, and the bundle export (process and dashboard definitions, no secrets – what the person can open anyway). A route without its step-up fails the route permission test (`server/test/route-matrix.test.ts`).

The server checks it right after authentication, before the route runs (`config: { stepUp: { action, who, when } }` on the route, see `server/src/auth/step-up.ts`), and answers `403 STEP_UP_REQUIRED` with how to confirm and what (`action`). Callers the route does not serve and unknown objects get the route's own answer (403 or 404) – a step-up is only asked of someone who may do the action. The web app shows the dialog with the action (requests that ask while it is open join it and are listed too) and then sends the same request again, once; a sensitive download asks before it starts. Nothing is stored on the server to be replayed later. The single sign-on callback page says what the confirmation was requested for and when it started – and that, like every confirmation, it then applies to all sensitive actions of the session for `SM_STEP_UP_MINUTES`.

**The SMTP password stays with its server.** Changing the SMTP server, port or user, or turning TLS off, needs the password again (`SMTP_PASSWORD_AGAIN`) – without a user it is removed – so a stored password is never sent to another host. Steward uses STARTTLS when the server offers it; it does not require TLS on port 587/25, so that internal relays without TLS keep working. For a relay that needs a password, use one that offers TLS (or `secure` on port 465).

API tokens can no longer download `GET /api/audit/export` and `GET /api/credentials/export.csv` (use a signed-in session, or `/api/v1` for reading).

## Master passphrase

The passphrase protects every credential and unlocks the audit and signing keys. It cannot be recovered.

- At least 12 characters (required for new vaults); a sentence of several words is fine. Keep it in the company password manager with at least two people having access.
- **(must) Unattended start: a file, not an environment variable.** Set `SM_MASTER_PASSPHRASE_FILE` to a file only the service account can read. `SM_MASTER_PASSPHRASE` still works, but environment variables are inherited by child processes, and the kernel keeps the _initial_ environment of a process readable in `/proc/<pid>/environ` (for the same user and root) for its whole lifetime. Steward removes both variables from its environment right after start, so no child process (browser, launcher) inherits them – with the file variant only the path is ever visible.
  - Docker / Kubernetes: a secret mounted at `/run/secrets/steward_passphrase` (example in `docker-compose.yml`).
  - systemd: `LoadCredential=steward-passphrase:/etc/steward/passphrase` and `Environment=SM_MASTER_PASSPHRASE_FILE=%d/steward-passphrase` (the `%d` prefix is resolved to `$CREDENTIALS_DIRECTORY`); with `systemd-creds encrypt` the file is encrypted with the TPM/host key at rest.
  - Windows (desktop autostart): keep the passphrase in a DPAPI-protected file of your user and let a small wrapper write it to a file with a user-only ACL at sign-in, for example
    `(Get-Content passphrase.dpapi | ConvertTo-SecureString | ConvertFrom-SecureString -AsPlainText) | Set-Content -NoNewline $env:LOCALAPPDATA\steward\passphrase.txt`
    (created once with `Read-Host -AsSecureString | ConvertFrom-SecureString | Set-Content passphrase.dpapi`). Do **not** store the passphrase as a Windows user environment variable – every program you start inherits it, including your browser.
- Change it under _Settings → Master passphrase_ (administrators, needs the current passphrase, audited). Tick _rotate the data key_ when the old passphrase or an old `vault.json` may have been exposed: all credentials are re-encrypted, so the old file plus the old passphrase opens nothing current. The audit chain and the checkpoint signing key stay the same.
- Wrong passphrases are audited and slowed down (exponential back-off after three attempts).
- Vaults created before this release are converted on their first unlock (wrapped keys, scrypt N=2^17); the old file is kept as `vault.json.v1.bak` – delete it once a backup of the new file exists.

## Least privilege

- Roles: give people the least role that works (viewer/auditor for most), restrict production platforms with access lists, use four-eyes approval steps for changes.
- Platform service accounts: their own technical users on each platform with only the rights the processes need, ideally read-only for monitoring processes. Prefer OAuth client credentials with short-lived tokens over static API keys.
- Put API keys in the platform's _credentials_, not in _default headers_ (headers are stored in clear, only credentials are encrypted).
- Put API keys in the platform's _credentials_, not in _default headers_ (headers are stored in clear, only credentials are encrypted).
- AI assistants (MCP, [MCP.md](MCP.md)): leave the MCP server off unless people need it, and turn the platform gateway on only for platforms whose data may leave through an assistant (the assistant's vendor sees the tool results). Give MCP tokens a short expiry. Every gateway call is in the audit log (`mcp.gateway_call`).
- PostgreSQL: a dedicated database user that owns only Steward's schema. A database administrator cannot read credentials, and changes they make to platform or sign-in settings are detected (configuration seal) – but they can still delete data: anchor the audit log outside the database (below).

## Outbound connections

- Steward calls the platforms you connect, the identity provider, SMTP/Teams/webhooks for notifications, and optionally an OTLP collector and an error tracker. Allow exactly these in the egress firewall/proxy (`HTTPS_PROXY`, `NO_PROXY`); block everything else, in particular cloud metadata endpoints.
- Credentials are only attached to requests for the platform's own origins (and _Trusted origins_).
- Error reporting (`SM_SENTRY_DSN`) and tracing (`OTEL_*`) are off by default. Events are scrubbed; traces carry no user names (a pseudonym), but URLs and host names of platforms. Point them at systems inside your company.

## Browser steps and Chromium

- Turn browser steps off (do not install Playwright/Chromium) unless a process needs them.
- The browser is started with a minimal environment (no `SM_*` settings, no secrets) and with **Chromium's sandbox**, except when the server runs as root (Chromium refuses that), or when the sandbox cannot start (no user namespaces in a container) – then a warning is logged. `SM_CHROMIUM_SANDBOX=1` makes a missing sandbox an error, `0` disables it explicitly.
- **Keep Chromium current.** The Chromium bundled with Playwright is as old as the Playwright release; browser steps open pages of the platforms you automate. Either update Playwright regularly (`npm install playwright@<latest> -w server && npx playwright install chromium`, then rebuild the image with `WITH_BROWSER=1`), or point `SM_CHROMIUM_PATH` at a browser managed by your company's patch process.

## Audit log as evidence

What Steward guarantees: every entry is HMAC-signed and chained, so an edit, an inserted row (also one with a sequence number below 1), a re-ordering or a gap is detected by _Verify chain_. What needs your help: an attacker with database (and data folder) access could remove the _newest_ entries, or replace the whole log, unless a copy of a recent checkpoint exists somewhere they cannot change. Steward provides those copies:

- **Signed checkpoints**: every `SM_AUDIT_CHECKPOINT_MINUTES` (default 60, when there are new entries), on every verification and before every export Steward signs `{seq, hash, digest, count, ts}` with the installation's **Ed25519 key** (the private key never leaves the vault; it is not derived from the passphrase).
- **(must) Ship them somewhere append-only:**
  - the operational log has one JSON line per checkpoint (`"msg":"audit checkpoint"`, field `auditCheckpoint`) – send stdout to your SIEM/syslog;
  - _Audit log → Anchoring → E-mail checkpoints to_: auditors or a write-once mailbox (uses the notification e-mail settings, at most every N hours; addresses outside Steward need an allowed domain, _Settings → Notifications_);
  - `<data dir>/audit-anchor.json` always holds the latest one (a database administrator cannot change it).
- **Verify against them**: _Audit log → Verify against checkpoint_ (paste the JSON or `seq:hash`), or keep the newest one in `SM_AUDIT_ANCHOR` / `SM_AUDIT_ANCHOR_FILE` (e.g. a file on a WORM share the SIEM writes) so every verification checks it. Verification fails when the log is shorter than the checkpoint or differs from it.
- **Record the public key** once: _Audit log → Anchoring → Public key (PEM)_; note its fingerprint in your change-management system. Anyone can then check a signed checkpoint and an export offline, without Steward:
  `npm run audit:verify-export -- --file audit-log.json --public-key steward-audit-public-key.pem [--anchor checkpoint-from-siem.json]`
  (export: _Audit log → Export → JSON with signed checkpoint_). Offline checks cover the chain linkage, the signature and that the entries up to the checkpoint are exactly the signed ones (SHA-256 digest); the per-entry HMAC needs the vault and is checked by the server.
- PDF reports: their SHA-256 is recorded in the audit log; _Verify report_ only trusts audit entries whose HMAC and chain position check out, and shows the chain status. Keep archived PDFs (and signed copies) outside Steward as well.
- Clock: entries carry the server's time. Synchronise it (NTP) and monitor it; a trusted timestamp (RFC 3161 TSA) of checkpoints is planned (below).
- Retention: the audit log is never pruned (see [PRIVACY.md](PRIVACY.md)).
- **Moving an instance** ([MIGRATION.md](MIGRATION.md)): the source's log moves unchanged as imported history, verifiable with the source's public key and its signed checkpoint; the target's own chain gets one `instance.imported` entry with the package's SHA-256 and the identity mapping. The package names the key that signed it, so only your comparison ties it to the real source: read the fingerprint **on the source** (the export result, or _Audit log → Anchoring_) and enter it at the import – all 32 characters. The target does not show it, so the import cannot be confirmed by echoing what the package claims. Everything that rests on the imported history trusts that key; such answers say so (_verified against the imported audit history of <fingerprint>_): the run report PDF, `protocol.importedHistory` in the API, report verification, record pages, signed PDFs and the verification of access checks. The package carries every credential: protect it like a backup of the vault (transfer passphrase passed on separately, file deleted after the import). Export and import are for administrators in a session; the export asks for the master passphrase again.

## Backups

- Back up the **database and `vault.json` together** (and `audit-anchor.json`, artifacts, reports, uploaded docs): the credentials in the database can only be read with the matching vault file. Steward refuses a `vault.json` that belongs to another database ("does not belong to this database").
- **Encrypt backups** (they contain the encrypted credentials, personal data and the evidence) and keep them separate from the server. Test a restore regularly, including unlocking and _Verify chain_.
- After a restore, _Verify chain_ against the last checkpoint from the SIEM tells you exactly which entries the restore lost; the local anchor file of a newer state reports the difference too.
- SQLite: stop the app or use `sqlite3 service-manager.db ".backup …"`; PostgreSQL: `pg_dump` of the schema.

## Monitoring and SIEM

Collect stdout (JSON lines) and alert on at least:

- `audit checkpoint` lines missing for more than two intervals, and any `audit chain verification failed`;
- `vault.unlock_failed`, `vault.passphrase_changed`, `platform.config_confirmed`, `platform.config_sealed`, `audit.entries_dropped` (audit entries lost while the vault was locked), `auth.login_failed` bursts;
- `could not restrict permissions in the data directory`, `Chromium could not start with its sandbox`;
- `/api/ready` (vault unlocked, database writable, scheduler running) and `/api/metrics` (Prometheus).

## Updates

- Watch the repository's releases and security advisories; install security releases promptly (critical/high fixes within the times in [SECURITY.md](../SECURITY.md)).
- Container: rebuild regularly – the base image gets OS fixes (the CI scans it weekly). Desktop: replace the executable; it re-checks its unpacked files against the hashes embedded at build time at every start.
- Chromium: see above. PostgreSQL, the reverse proxy and the OS follow your normal patch process.

## Shared hosts

If Steward has to run on a host where other people (or their programs) are logged in:

- Browsers send cookies to **every port** of a host. Steward therefore binds the session to a key that only its own origin can read; a program on another local port that receives the cookie cannot use it. Still prefer a dedicated host.
- Other users must not be able to read the data folder (checked at start on Linux/macOS; on Windows the per-user `%LOCALAPPDATA%` is private by default – do not move the data folder to a shared location).
- The desktop launcher verifies the instance identity before opening the window; if it reports that the port is used by another program, do not enter your passphrase anywhere – find out what listens there.

## Verifying downloads

Release archives come with signed build provenance (SLSA, GitHub artifact attestations, keyless Sigstore) and an SBOM attestation:

```bash
gh attestation verify steward-linux-x64.tar.gz --repo vxrz/Steward
sha256sum -c SHA256SUMS.txt
```

**Container image** (`ghcr.io/vxrz/steward`). The Container workflow signs every published image with [cosign](https://docs.sigstore.dev/cosign/) – keyless: the certificate names the workflow, the release tag and the commit – and attaches SLSA build provenance and the CycloneDX SBOM (from Syft) as attestations. Check that an image comes from a release tag of this repository before you run it (cosign 3 or later, a current GitHub CLI):

```bash
# signature: built by .github/workflows/container.yml for a v* tag of vxrz/Steward
cosign verify ghcr.io/vxrz/steward:0.2.1 \
  --certificate-identity-regexp '^https://github\.com/vxrz/Steward/\.github/workflows/container\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# for one exact release, compare the whole identity instead of a pattern
cosign verify ghcr.io/vxrz/steward:0.2.1 \
  --certificate-identity https://github.com/vxrz/Steward/.github/workflows/container.yml@refs/tags/v0.2.1 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# build provenance (SLSA) of the multi-platform image
gh attestation verify oci://ghcr.io/vxrz/steward:0.2.1 --repo vxrz/Steward \
  --signer-workflow vxrz/Steward/.github/workflows/container.yml --source-ref refs/tags/v0.2.1
```

Each platform image (linux/amd64, linux/arm64) is signed too and has its own provenance and SBOM attestation. Look up its digest and check it:

```bash
docker buildx imagetools inspect ghcr.io/vxrz/steward:0.2.1          # lists the platform digests
gh attestation verify oci://ghcr.io/vxrz/steward@sha256:<platform digest> --repo vxrz/Steward \
  --predicate-type https://cyclonedx.org/bom                          # the SBOM attestation
```

Run what you verified: pin the digest (`image: ghcr.io/vxrz/steward:0.2.1@sha256:…` in the compose file) or at least the version, so a later push to the tag cannot replace it unnoticed. The same commands work for the `-browser` tags.

## Known limits

- **RFC 3161 timestamps** of checkpoints by a corporate TSA are not implemented yet (planned): they would add trusted time, so a manipulated server clock could not back-date entries. Until then, the SIEM's own receive timestamps of the checkpoint lines serve that purpose.
- Someone who knows the master passphrase _and_ controls the server can sign checkpoints too – the protection is that checkpoints that have already left the system cannot be changed. Restrict who knows the passphrase.
- Redaction masks known secret values (also JSON-, URL- and Base64-encoded) and token fields; fragments of a secret or secrets transformed by a process (e.g. a substring) can still appear in step data. Use process inputs of type _secret_ for one-time values.
- Error reports and traces may contain platform host names and paths.
- The container base image carries OS packages with known vulnerabilities that have no fix yet (reported by the weekly scan); none is reachable through Steward's code paths as far as we know.
