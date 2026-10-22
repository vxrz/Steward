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
- **(must) Behind a proxy: `SM_TRUST_PROXY`** – preferably the proxies' addresses/CIDRs (`10.0.0.5`, `10.1.0.0/16`, `loopback`), or the number of proxy hops (`1`; only honoured when the direct peer has a loopback or private address, so a client that reaches Steward directly cannot forge its address). Without it every request seems to come from the proxy: the audit log records the proxy's address, the sign-in lockout locks out everyone at once, and webhook source-address rules cannot work. `true` is refused on purpose (any client could claim any address). Make the proxy overwrite (not append to) `X-Forwarded-For` from clients.
- Proxy settings: forward `Host` (or `X-Forwarded-Host`), `X-Forwarded-Proto`; allow request bodies up to 25 MB for uploads (sign-in and other unauthenticated requests are limited to 64 KB by Steward); do not cache `/api/` (Steward sends `Cache-Control: no-store`).
- Firewall: only the proxy may reach Steward's port.

## Sign-in

- **Single sign-on** (Entra ID / OIDC) with your company's MFA. Then set _Settings → Sign-in → Only administrators_ so that ordinary users cannot fall back to passwords. Keep one or two local break-glass administrator accounts with long passwords in the company password manager. If their passwords are lost too, `steward admin reset-password` on the server sets a one-time password (needs the data folder and the master passphrase, audited; see [INSTALL.md](INSTALL.md#forgotten-administrator-password)).
- Map roles from IdP groups (`requireMapping` for production) – leavers lose access when the IdP account is disabled.
- Sessions are bound to a per-session key in the browser (origin-isolated `localStorage`), not only to the cookie. Scripts use API tokens (`Authorization: Bearer smt_…`), never copied cookies.
- Failed sign-ins are rate-limited per account, per account and address, and per address, and audited in bounded form (see [PRIVACY.md](PRIVACY.md)).

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
  - _Audit log → Anchoring → E-mail checkpoints to_: auditors or a write-once mailbox (uses the notification e-mail settings, at most every N hours);
  - `<data dir>/audit-anchor.json` always holds the latest one (a database administrator cannot change it).
- **Verify against them**: _Audit log → Verify against checkpoint_ (paste the JSON or `seq:hash`), or keep the newest one in `SM_AUDIT_ANCHOR` / `SM_AUDIT_ANCHOR_FILE` (e.g. a file on a WORM share the SIEM writes) so every verification checks it. Verification fails when the log is shorter than the checkpoint or differs from it.
- **Record the public key** once: _Audit log → Anchoring → Public key (PEM)_; note its fingerprint in your change-management system. Anyone can then check a signed checkpoint and an export offline, without Steward:
  `npm run audit:verify-export -- --file audit-log.json --public-key steward-audit-public-key.pem [--anchor checkpoint-from-siem.json]`
  (export: _Audit log → Export → JSON with signed checkpoint_). Offline checks cover the chain linkage, the signature and that the entries up to the checkpoint are exactly the signed ones (SHA-256 digest); the per-entry HMAC needs the vault and is checked by the server.
- PDF reports: their SHA-256 is recorded in the audit log; _Verify report_ only trusts audit entries whose HMAC and chain position check out, and shows the chain status. Keep archived PDFs (and signed copies) outside Steward as well.
- Clock: entries carry the server's time. Synchronise it (NTP) and monitor it; a trusted timestamp (RFC 3161 TSA) of checkpoints is planned (below).
- Retention: the audit log is never pruned (see [PRIVACY.md](PRIVACY.md)).

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

Release archives and the container image (OCI archive on tags) come with signed build provenance (SLSA, GitHub artifact attestations, keyless Sigstore) and an SBOM attestation:

```bash
gh attestation verify steward-linux-x64.tar.gz --repo <owner>/<repo>
sha256sum -c SHA256SUMS.txt
```

## Known limits

- **RFC 3161 timestamps** of checkpoints by a corporate TSA are not implemented yet (planned): they would add trusted time, so a manipulated server clock could not back-date entries. Until then, the SIEM's own receive timestamps of the checkpoint lines serve that purpose.
- Someone who knows the master passphrase _and_ controls the server can sign checkpoints too – the protection is that checkpoints that have already left the system cannot be changed. Restrict who knows the passphrase.
- Redaction masks known secret values (also JSON-, URL- and Base64-encoded) and token fields; fragments of a secret or secrets transformed by a process (e.g. a substring) can still appear in step data. Use process inputs of type _secret_ for one-time values.
- Error reports and traces may contain platform host names and paths.
- The container base image carries OS packages with known vulnerabilities that have no fix yet (reported by the weekly scan); none is reachable through Steward's code paths as far as we know.
