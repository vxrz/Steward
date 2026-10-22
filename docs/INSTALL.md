# Ways to run it

| Option | Best for | Needs | Effort |
| --- | --- | --- | --- |
| **1. Desktop executable** | One person on a Windows/Mac/Linux laptop | Nothing (Node.js is built in) | Download, double-click |
| **2. Installed web app (PWA)** | Getting an app window, taskbar/dock icon and Start-menu entry for any running instance | Edge or Chrome | One click in the browser |
| **3. Node.js** (`npm start`) | Developers, customising | Node.js 24 (LTS) | `npm install && npm run build && npm start` |
| **4. Container** (Docker/Podman) | A shared team instance on a VM or server | Docker | `docker compose up -d` |

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

| Option | Effect |
| --- | --- |
| `--autostart on` | Starts the app in the background when you sign in, so schedules keep running. It uses the Startup folder on Windows, a LaunchAgent on macOS and XDG autostart on Linux; no admin rights needed. Combine it with `SM_MASTER_PASSPHRASE` (user environment variable) if schedules must run before anyone unlocks the vault. `--autostart off` removes it. |
| `--no-open` | Start without opening a window. |
| `--demo` | Demo mode with simulated platforms. |

All `SM_*` and `OTEL_*` environment variables from the README work as well.

**First start on Windows and macOS.** The release files are not code-signed, so you may see a warning:

- Windows SmartScreen: *More info → Run anyway*.
- macOS: right-click → *Open*, or `xattr -d com.apple.quarantine steward`.

For a company rollout, sign the binaries (Authenticode on Windows, Developer ID and notarisation on macOS) and distribute them with Intune, Jamf or your software centre.

**Browser steps** (the *Browser* node) need Playwright and Chromium, which are not embedded because they are large. Use option 3 or 4 (with `WITH_BROWSER=1`) if you need them. Everything else works in the executable, including PDF reports: their fonts, logo and colour profile are embedded and unpacked next to the web UI.

**Build it yourself:**

```bash
npm install
npm run build        # web UI
npm run build:exe    # → dist-exe/steward[.exe]
```

The executable is built for the system you build on, so build on each target OS. The `Release` GitHub workflow does this for Windows, macOS (Intel and Apple silicon) and Linux (x64 and arm64). It smoke-tests each binary, adds a CycloneDX SBOM and checksums, and attaches everything to the release when you push a tag such as `v0.2.0`. A tag with a suffix (`v0.2.0-beta.1`) becomes a pre-release. To build without a release, use *Actions → Release → Run workflow* or put `[build-exe]` in a commit message; the files are then attached to the workflow run as artifacts.

## 2. Installed web app (PWA)

With any running instance (executable, Node.js or container), open the address in Edge or Chrome and choose **Install** (address-bar icon, or the *Install app* item in the user menu). You get:

- your own window, taskbar/dock icon and Start-menu entry,
- shortcuts to *Tasks*, *Dashboards* and *Runs* (right-click the icon),
- browser notifications for new tasks and failed checks, if you enable them on your profile page.

This works for `localhost` and for HTTPS addresses. The app shell is cached, but data is always live: nothing from the API is stored offline.

## 3. Node.js

See *Quick start* and *Everyday use* in the [README](../README.md). `npm run desktop` starts the desktop launcher from source, i.e. per-user data folder and app window.

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
- `/api/health` (liveness) and `/api/ready` (readiness: vault unlocked, database writable, scheduler running) are available for orchestrators. `/api/metrics` serves Prometheus metrics.
- Set `SM_MASTER_PASSPHRASE` from a secret so schedules run after restarts.

## 5. Database: SQLite or PostgreSQL

Steward keeps its data in **SQLite** by default: one file, `service-manager.db`, in the data directory. Nothing to set up, which is right for the desktop executable and for laptops.

For a shared installation, such as an internal VM, it can use **PostgreSQL** instead. Set `SM_DATABASE_URL`:

```bash
SM_DATABASE_URL=postgres://steward:secret@db.corp.example:5432/steward npm start
docker compose -f docker-compose.postgres.yml up -d    # app + postgres:16, see the file's header
```

| Variable | Purpose |
| --- | --- |
| `SM_DATABASE_URL` | `postgres://user:password@host:5432/database`. URL-encode special characters in the password. TLS: add `?sslmode=verify-full` (or `require`, which `pg` currently treats like `verify-full`). `sslmode=no-verify` encrypts without checking the certificate. The standard `PG*` variables (e.g. `PGPASSWORD`) fill in missing parts. |
| `SM_DATABASE_SCHEMA` | Schema for all tables. Default `public`. It is created if it does not exist, so one database can host several installations, or test runs. |
| `SM_DATABASE_CA` | Path to the CA certificate (PEM) of the database server. Adds `sslrootcert` and, unless the URL sets one, `sslmode=verify-full`. |

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
- Size on the *Settings → Maintenance* page is the size of the schema's tables and indexes. PostgreSQL's autovacuum reclaims space after the retention cleanup.
- `/api/ready` checks that the database is reachable and writable, for both kinds.

## Why not Electron or Tauri?

Both are possible and would add a native tray icon and auto-update. They also add a second toolchain:

- Electron bundles its own Chromium, around 150 MB more.
- Tauri needs Rust.

The executable plus the browser's app window gives nearly the same experience with no extra code. If a tray icon or auto-update becomes important, Electron can wrap the same server unchanged by importing `server/src/main.ts`.
