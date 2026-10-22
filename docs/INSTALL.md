# Ways to run it

| Option                           | Best for                                                                               | Needs                         | Effort                                      |
| -------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------- |
| **1. Desktop executable**        | One person on a Windows/Mac/Linux laptop                                               | Nothing (Node.js is built in) | Download, double-click                      |
| **2. Installed web app (PWA)**   | Getting an app window, taskbar/dock icon and Start-menu entry for any running instance | Edge or Chrome                | One click in the browser                    |
| **3. Node.js** (`npm start`)     | Developers, customising                                                                | Node.js 24 (LTS)              | `npm install && npm run build && npm start` |
| **4. Container** (Docker/Podman) | A shared team instance on a VM or server                                               | Docker                        | `docker compose up -d`                      |

All options run the same server and keep everything in one data folder. You can move between them by copying that folder.

## 1. Desktop executable

A single file that contains Node.js, the server, the web UI and the example library.

1. Download the file for your system from the GitHub release (`steward-windows-x64.zip`, `…-macos-arm64.tar.gz` for Apple silicon, `…-macos-x64.tar.gz` for Intel Macs, `…-linux-x64.tar.gz`, `…-linux-arm64.tar.gz`) and unpack it.
2. Start `steward` (`steward.exe` on Windows).
   - A console window shows the address and stays open while the app runs. Close it to stop the app.
   - The UI opens as its own app window in Edge or Chrome (`--app` mode, no tabs or address bar). Without Edge/Chrome it opens in your default browser.
   - Starting it a second time only opens the window again.
3. Data is kept per user:
   - Windows: `%LOCALAPPDATA%\steward`
   - macOS: `~/Library/Application Support/steward`
   - Linux: `~/.local/share/steward`

```text
steward [--port 4310] [--data-dir <folder>] [--no-open] [--demo] [--autostart on|off]
```

| Option           | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--autostart on` | Starts the app in the background when you sign in, so schedules keep running. It uses the Startup folder on Windows, a LaunchAgent on macOS and XDG autostart on Linux; no admin rights needed. If schedules must run before anyone unlocks the vault, put the passphrase in a file only you can read and set `SM_MASTER_PASSPHRASE_FILE` (on Windows preferably a DPAPI-protected file, see [SECURITY-HARDENING.md](SECURITY-HARDENING.md#master-passphrase)) – not in a user environment variable, which every program you start inherits. `--autostart off` removes it. |
| `--no-open`      | Start without opening a window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--demo`         | Demo mode with simulated platforms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

All `SM_*` and `OTEL_*` environment variables from the README work as well.

**First start on Windows and macOS.** The release files are not code-signed, so you may see a warning:

- Windows SmartScreen: _More info → Run anyway_.
- macOS: right-click → _Open_, or `xattr -d com.apple.quarantine steward`.

For a company rollout, sign the binaries (Authenticode on Windows, Developer ID and notarisation on macOS) and distribute them with Intune, Jamf or your software centre.

**Browser steps** (the _Browser_ node) need Playwright and Chromium, which are not embedded because they are large. Use option 3 or 4 (with `WITH_BROWSER=1`) if you need them. Everything else works in the executable, including PDF reports: their fonts, logo and colour profile are embedded and unpacked next to the web UI.

**Build it yourself:**

```bash
npm install
npm run build        # web UI
npm run build:exe    # → dist-exe/steward[.exe]
```

The executable is built for the system you build on, so build on each target OS. The `Release` GitHub workflow does this for Windows, macOS (Intel and Apple silicon) and Linux (x64 and arm64). It smoke-tests each binary, adds a CycloneDX SBOM and checksums, and attaches everything to the release when you push a tag such as `v0.2.0`. A tag with a suffix (`v0.2.0-beta.1`) becomes a pre-release. To build without a release, use _Actions → Release → Run workflow_ or put `[build-exe]` in a commit message; the files are then attached to the workflow run as artifacts.

## 2. Installed web app (PWA)

With any running instance (executable, Node.js or container), open the address in Edge or Chrome and choose **Install** (address-bar icon, or the _Install app_ item in the user menu). You get:

- your own window, taskbar/dock icon and Start-menu entry,
- shortcuts to _Tasks_, _Dashboards_ and _Runs_ (right-click the icon),
- browser notifications for new tasks and failed checks, if you enable them on your profile page.

This works for `localhost` and for HTTPS addresses. The app shell is cached, but data is always live: nothing from the API is stored offline.

## 3. Node.js

See _Quick start_ and _Everyday use_ in the [README](../README.md). `npm run desktop` starts the desktop launcher from source, i.e. per-user data folder and app window.

## 4. Container

```bash
docker compose up -d                                   # http://localhost:4310
docker build --build-arg WITH_BROWSER=1 -t steward .   # with Chromium for browser steps
```

- Data lives in the `sm-data` volume (`/data`). Back it up.
- The compose file publishes the port on `127.0.0.1` only. To serve colleagues:
  - put it behind a reverse proxy with TLS, or set `SM_TLS_CERT`/`SM_TLS_KEY`;
  - set `SM_ALLOWED_HOSTS` to the DNS name and `SM_PUBLIC_URL` to the external URL;
  - configure single sign-on.
- `/api/health` (liveness) and `/api/ready` (readiness) are available for orchestrators, see [Health and readiness](#health-and-readiness). `/api/metrics` serves Prometheus metrics.
- For unattended unlock after restarts, mount the passphrase as a Docker secret and set `SM_MASTER_PASSPHRASE_FILE=/run/secrets/steward_passphrase` (commented example in `docker-compose.yml`).
- Behind a reverse proxy that terminates TLS: `SM_TRUST_PROXY=1` (or the proxy's address), `SM_PUBLIC_URL=https://…` (Secure cookie, HSTS) and `SM_ALLOWED_HOSTS=<DNS name>`.
- The complete checklist for a work deployment: [SECURITY-HARDENING.md](SECURITY-HARDENING.md).
- Build information for the About page: `docker build --build-arg SM_BUILD_COMMIT=$(git rev-parse HEAD) --build-arg SM_BUILD_DATE=$(date -u +%FT%TZ) -t steward .` (the container workflow does this). Without it the image reports a "development" build.

## 5. Database: SQLite or PostgreSQL

Steward keeps its data in **SQLite** by default: one file, `service-manager.db`, in the data directory. Nothing to set up, which is right for the desktop executable and for laptops.

For a shared installation, such as an internal VM, it can use **PostgreSQL** instead. Set `SM_DATABASE_URL`:

```bash
SM_DATABASE_URL=postgres://steward:secret@db.corp.example:5432/steward npm start
docker compose -f docker-compose.postgres.yml up -d    # app + postgres:16, see the file's header
```

| Variable             | Purpose                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SM_DATABASE_URL`    | `postgres://user:password@host:5432/database`. URL-encode special characters in the password. TLS: add `?sslmode=verify-full` (or `require`, which `pg` currently treats like `verify-full`). `sslmode=no-verify` encrypts without checking the certificate. The standard `PG*` variables (e.g. `PGPASSWORD`) fill in missing parts. |
| `SM_DATABASE_SCHEMA` | Schema for all tables. Default `public`. It is created if it does not exist, so one database can host several installations, or test runs.                                                                                                                                                                                           |
| `SM_DATABASE_CA`     | Path to the CA certificate (PEM) of the database server. Adds `sslrootcert` and, unless the URL sets one, `sslmode=verify-full`.                                                                                                                                                                                                     |

**Requirements.** You need PostgreSQL 12 or later; it was tested with 16. The server must be built with ICU, as the official images and the Debian, Ubuntu and RHEL packages are. ICU provides the case-insensitive collation for user and team names. The database user needs to be able to create tables in the schema: the database owner can, and with another schema `CREATE` on the database is enough. Tables are created and upgraded automatically at start-up, the same way as on SQLite.

**One instance per database schema.** The scheduler and the run engine keep state in memory, so two instances on the same data would run schedules twice. At start-up the app takes a PostgreSQL advisory lock for its schema. If another instance holds the lock, the app refuses to start and says which database session has it. After a hard crash of the VM, the old session can linger until the database notices that it is gone. End it with `SELECT pg_terminate_backend(<pid>)`.

**The data directory is still needed.** It holds `vault.json` (the encrypted key material: without it, the credentials stored in the database cannot be decrypted), screenshots and files of runs (`artifacts/`), reports and uploaded docs. Give the app a persistent `SM_DATA_DIR`. In the compose file this is the `steward-data` volume.

**Backup.** Back up both parts together:

```bash
pg_dump -Fc -d steward -f steward-$(date +%F).dump    # database
tar czf steward-data-$(date +%F).tgz -C /data .        # data directory (vault.json, artifacts, reports, docs)
```

To restore, use `pg_restore -d steward --clean steward-….dump` and unpack the data directory. With SQLite, copying the data directory while the app is stopped is enough.

**Moving existing data.** `npm run db:copy` copies everything from one database to another: SQLite to PostgreSQL, or back. Stop the app first:

```bash
npm run db:copy -- --from sqlite:./data/service-manager.db --to postgres://steward:secret@db:5432/steward
# --to-schema <name>   target schema (default SM_DATABASE_SCHEMA or public)
# --force              replace data already in the target (otherwise a non-empty target is refused)
```

- Both databases are first brought to the current schema version.
- Rows are copied verbatim, in foreign-key order and in batches, in one transaction on the target, and the row counts are checked before the commit. So the tamper-evident audit chain still verifies (Admin → Audit → Verify).
- Afterwards, start the app with `SM_DATABASE_URL` and the same data directory.
- In a container: `docker compose -f docker-compose.postgres.yml run --rm steward node --import tsx server/src/cli/db-copy.ts --from sqlite:/data/service-manager.db`. The target then defaults to `SM_DATABASE_URL`.

**Things to know.**

- The **desktop executable always uses SQLite**. If `SM_DATABASE_URL` is set there, it refuses to start. Use the Node.js or container version for PostgreSQL.
- The app talks to PostgreSQL through one connection, and each query waits for the answer. On the same host or LAN this costs about 0.2–0.3 ms per query, against about 0.01 ms for SQLite, and is not noticeable in the UI. Keep the database close to the app: a slow network link makes every request slower. A statement that runs longer than about 25 s is cancelled.
- Size on the _Settings → Maintenance_ page is the size of the schema's tables and indexes. PostgreSQL's autovacuum reclaims space after the retention cleanup.
- `/api/ready` checks that the database is reachable and writable, for both kinds.

## Resetting a demo and recovering access

### Start a demo from scratch

A Steward installation is its data folder. To start over, stop Steward, delete (or rename) the folder and start again: you get the first-start screen (new master passphrase, new admin) and can load the demo platforms and processes again. This also deletes all processes, runs, the vault and the audit log of that folder.

| Started with | Data folder |
| --- | --- |
| `npm run demo` / `npm run dev:demo` | `data/` in the project folder (or `SM_DATA_DIR`) |
| Desktop executable, Windows | `%LOCALAPPDATA%\steward` |
| Desktop executable, macOS | `~/Library/Application Support/steward` |
| Desktop executable, Linux | `~/.local/share/steward` (or `$XDG_DATA_HOME/steward`) |
| Container | the `sm-data` volume: `docker compose down -v` |

Keep demos in their own folder so they never mix with real data: `steward --demo --data-dir ~/steward-demo` or `SM_DATA_DIR=./demo-data npm run demo`. With PostgreSQL, the data lives in the database schema (`SM_DATABASE_URL`/`SM_DATABASE_SCHEMA`): use a separate schema for demos.

### Forgotten administrator password

The recovery command sets a one-time password for a local account on the server itself. It needs access to the data folder **and** the master passphrase, so it gives no more than someone who can already unlock the vault. Steward must be stopped (the command refuses otherwise). It signs out all sessions of the account, and the next sign-in asks for a new password. The reset is written to the audit log with the operating-system account that ran it (`cli:<user>@<host>`).

```bash
steward admin list-admins                      # which administrator accounts exist
steward admin reset-password admin             # prompts for the master passphrase
steward admin reset-password alice --activate  # also reactivates a deactivated account
npm run admin -- reset-password admin          # from the source tree
```

In the container: `docker compose stop steward && docker compose run --rm steward node --import tsx server/src/cli/admin.ts reset-password admin`, then start it again.

The passphrase comes from `SM_MASTER_PASSPHRASE_FILE`/`SM_MASTER_PASSPHRASE`, `--passphrase-stdin` or a prompt. Run `steward admin --help` for all options; `--json` gives machine-readable output.

Without the master passphrase nothing can be recovered: the credentials and the audit key are encrypted with it. Start from scratch as above and set up the platforms again.

Accounts that sign in with single sign-on have no password. If the identity provider is unavailable, reset the password of a local administrator account (keep one as a break-glass account, see [SECURITY-HARDENING.md](SECURITY-HARDENING.md)).

## Health and readiness

Every installation answers two public endpoints, without signing in:

| Endpoint          | Answers                                                                                                                                                                                                                          | Use it for                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health` | Always `200 {"ok": true, "version": "…"}` while the process runs                                                                                                                                                                 | Liveness: container `HEALTHCHECK`, Kubernetes `livenessProbe`, a simple uptime check                                                  |
| `GET /api/ready`  | `200` when the vault is unlocked, the database is writable and the enabled schedules are armed; otherwise `503` with the failing checks: `{"ready": false, "checks": {"vault": {"ok": false, "message": "Vault is locked"}, …}}` | Readiness: Kubernetes `readinessProbe`, load balancers, Gatus/Zabbix/Uptime Kuma alerts ("Steward needs someone to unlock the vault") |

```yaml
# Kubernetes
livenessProbe: { httpGet: { path: /api/health, port: 4310 }, periodSeconds: 30 }
readinessProbe: { httpGet: { path: /api/ready, port: 4310 }, periodSeconds: 15 }
```

```yaml
# Gatus
endpoints:
  - name: steward
    url: https://steward.example.com/api/ready
    conditions: ['[STATUS] == 200', '[BODY].ready == true']
```

For Zabbix, use an _HTTP agent_ item on `/api/ready` with a trigger on the status code (or the JSON path `$.ready`). [docs/MONITORS.md](MONITORS.md) and [docs/GATUS.md](GATUS.md) cover how Steward itself monitors other systems.

**Version in `/api/health`.** The health endpoint keeps returning the version: monitoring and rollout checks use it to confirm which version runs, and the version is public anyway (the web UI's code and footer contain it), so hiding it here would add no protection. There is no separate `/api/version`. Signed-in users see the build details on the **About** page (`GET /api/about`).

**System status page.** _Settings → System status_ (administrators; auditors get a view without paths, host names and connection details) shows the readiness checks, database type and size, vault, scheduler with the next runs, monitor engine, notification channels, error reporting, tracing, metrics access, public API, retention, TLS and runtime details (Node.js, platform, uptime, memory, time zone, installation type), with the two URLs above ready to copy. It reads `GET /api/system/status`, which never contains secrets.

## Version and build information

The **About** page (user menu or footer) shows the version, build commit and build date of the web UI and of the server, and warns when a tab still runs an older web UI than the server ("Reload").

| Installation            | Where commit and date come from                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Desktop executable      | `scripts/build-exe.mjs` compiles them in (`SM_BUILD_COMMIT`/`SM_BUILD_DATE`, else `git rev-parse HEAD` and the build time).         |
| Container               | Build arguments `SM_BUILD_COMMIT` and `SM_BUILD_DATE` (set by the container workflow).                                              |
| Node.js from a checkout | The web build reads the commit from git; the server reports a "development" build unless `SM_BUILD_COMMIT`/`SM_BUILD_DATE` are set. |

The installation type (desktop executable, container, Node.js) is detected automatically; the container image also sets `SM_DEPLOYMENT=container`.

## Why not Electron or Tauri?

Both are possible and would add a native tray icon and auto-update. They also add a second toolchain:

- Electron bundles its own Chromium, around 150 MB more.
- Tauri needs Rust.

The executable plus the browser's app window gives nearly the same experience with no extra code. If a tray icon or auto-update becomes important, Electron can wrap the same server unchanged by importing `server/src/main.ts`.
