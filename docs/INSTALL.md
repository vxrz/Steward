# Ways to run it

| Option                           | Best for                                                                               | Needs                         | Effort                                      |
| -------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------- |
| **1. Desktop executable**        | One person on a Windows/Mac/Linux laptop                                               | Nothing (Node.js is built in) | Download, double-click                      |
| **2. Installed web app (PWA)**   | Getting an app window, taskbar/dock icon and Start-menu entry for any running instance | Edge or Chrome                | One click in the browser                    |
| **3. Node.js** (`npm start`)     | Developers, customising                                                                | Node.js 24 (LTS) or 26        | `npm install && npm run build && npm start` |
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

Every release publishes a signed image to the GitHub Container Registry, for linux/amd64 and linux/arm64:

| Tag                                                    | Content                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `ghcr.io/vxrz/steward:0.2.1`                           | exactly this version (recommended: pin it, update on purpose)                 |
| `ghcr.io/vxrz/steward:0.2`                             | the newest 0.2.x                                                              |
| `ghcr.io/vxrz/steward:latest`                          | the newest release (pre-releases such as `0.3.0-rc.1` only get their own tag) |
| `…:0.2.1-browser`, `…:0.2-browser`, `…:latest-browser` | the same with Chromium for browser steps (larger)                             |

`docker-compose.yml` pins the version of its checkout:

```bash
docker compose up -d                                   # http://localhost:4310
```

Check the image before you start it the first time (and after each update) – see [Verifying downloads](SECURITY-HARDENING.md#verifying-downloads):

```bash
cosign verify ghcr.io/vxrz/steward:0.2.1 \
  --certificate-identity-regexp '^https://github\.com/vxrz/Steward/\.github/workflows/container\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

If the registry doesn't have the pinned version (a checkout from before the first published image, or no access to ghcr.io), `docker compose up` builds it from the checkout instead – such a local build carries no signature, so run `docker compose pull` first when you want the signed image (it fails if there is none). To always build yourself (e.g. with your own changes), run `docker compose build --pull && docker compose up -d`, or:

```bash
docker build -t steward .                              # the default image
docker build --build-arg WITH_BROWSER=1 -t steward .   # with Chromium for browser steps
```

Images are published from 0.2.0 on. For older versions, build the image from the checkout.

- Data lives in the `sm-data` volume (`/data`). Back it up.
- The compose file publishes the port on `127.0.0.1` only. To serve colleagues:
  - put it behind a reverse proxy with TLS, or set `SM_TLS_CERT`/`SM_TLS_KEY`;
  - set `SM_ALLOWED_HOSTS` to the DNS name and `SM_PUBLIC_URL` to the external URL;
  - configure single sign-on.
- `/api/health` (liveness) and `/api/ready` (readiness) are available for orchestrators, see [Health and readiness](#health-and-readiness). `/api/metrics` serves Prometheus metrics.
- For unattended unlock after restarts, mount the passphrase as a Docker secret and set `SM_MASTER_PASSPHRASE_FILE=/run/secrets/steward_passphrase` (commented example in `docker-compose.yml`). The file must be readable by the container's user – see [The passphrase file in Docker](#the-passphrase-file-in-docker).
- Behind a reverse proxy that terminates TLS: `SM_TRUST_PROXY=<the proxy's address>`, `SM_PUBLIC_URL=https://…` (Secure cookie, HSTS) and `SM_ALLOWED_HOSTS=<DNS name>`. Examples for nginx, Traefik and Caddy, on an own host name or under a path: [Behind a reverse proxy](#behind-a-reverse-proxy); which address Steward sees in Docker: [Steward in Docker](#steward-in-docker).
- Behind a company proxy or TLS inspection (Steward cannot reach a platform, or reports `unable to verify the first certificate`): [Company proxy and TLS inspection](#company-proxy-and-tls-inspection).
- The complete checklist for a work deployment: [SECURITY-HARDENING.md](SECURITY-HARDENING.md).
- Build information for the About page: `docker build --build-arg SM_BUILD_COMMIT=$(git rev-parse HEAD) --build-arg SM_BUILD_DATE=$(date -u +%FT%TZ) -t steward .` (the container workflow does this). Without it the image reports a "development" build.

### The passphrase file in Docker

The container runs as user **1000**. Docker Compose (without Swarm) mounts a file secret as it is – with the owner and mode it has on the host – so the file must belong to that user. Otherwise Steward stops at start-up with `SM_MASTER_PASSPHRASE_FILE: cannot read … EACCES`.

```bash
sudo install -m 400 -o 1000 -g 1000 /dev/null passphrase.txt   # next to docker-compose.yml
sudo nano passphrase.txt                                       # the master passphrase, one line
```

- **User namespaces** (`"userns-remap"` in `/etc/docker/daemon.json`): user 1000 in the container is another user on the host – the start of the `dockremap` range in `/etc/subuid` and `/etc/subgid` plus 1000:
  ```bash
  U=$(( $(awk -F: '$1=="dockremap"{print $2}' /etc/subuid) + 1000 ))
  G=$(( $(awk -F: '$1=="dockremap"{print $2}' /etc/subgid) + 1000 ))
  sudo chown "$U:$G" passphrase.txt && sudo chmod 400 passphrase.txt
  ```
- **SELinux** (RHEL and relatives, enforcing): the file also needs the container label – a secret cannot take the `:z` option of a volume:
  ```bash
  sudo semanage fcontext -a -t container_file_t "$PWD/passphrase\.txt" && sudo restorecon -v passphrase.txt
  ```
- The folder must be passable for that user (`chmod 755` on the folder is fine; the file stays `400`).
- Check it: `docker compose run --rm --no-deps --entrypoint sh steward -c 'id; cat /run/secrets/steward_passphrase >/dev/null && echo readable'`.
- The file only **unlocks** a vault. Set Steward up in the browser first – with exactly the passphrase from the file – and turn the secret on afterwards.

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

Steward can also do this itself: encrypted backups of the database and the data folder to an S3 bucket on a schedule, with a retention rule and a weekly restore test – see [BACKUPS.md](BACKUPS.md).

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

## 6. Updating

Your data stays in the data folder (and, if you use it, in PostgreSQL). A new version keeps it: at the first start it upgrades the database to its own schema, then works on the same data. Updates go forward only.

**Every time:**

1. Read the release notes ([CHANGELOG.md](../CHANGELOG.md)) for steps that apply to you.
2. Stop the app. Running steps of runs are marked _interrupted_ at the next start; runs that wait for a decision keep waiting.
3. Back up the data folder (and the PostgreSQL database, see below).
4. Replace the app, keep the data folder.
5. Start the new version and unlock the vault with your master passphrase, as usual.

**Desktop executable.** Close the console window (or press Ctrl+C in it). Copy the data folder somewhere safe (Windows `%LOCALAPPDATA%\steward`, macOS `~/Library/Application Support/steward`, Linux `~/.local/share/steward`, or your `--data-dir`). Unpack the new release over the old file, or next to it, and start it. With `--autostart on`, sign out and in again, or start the new file once, so that the autostart entry points to it.

**Node.js.**

```bash
# stop the app (Ctrl+C or your service manager), then:
tar czf steward-data-$(date +%F).tgz -C data .   # or your SM_DATA_DIR
git pull                                          # or unpack the new release
npm ci && npm run build
npm start
```

**Container.**

```bash
docker compose stop
docker run --rm -v <project>_sm-data:/data -v "$PWD":/backup alpine tar czf /backup/steward-data-$(date +%F).tgz -C /data .
# set the new version in docker-compose.yml (image: ghcr.io/vxrz/steward:<version>), or git pull, then:
docker compose pull && docker compose up -d
```

`<project>` is the compose project, by default the folder name (`docker volume ls` shows it). The data volume stays; only the image changes. Verify the new image as above before you start it. With a self-built image: `git pull && docker compose build --pull && docker compose up -d`.

An air-gapped host: pull and verify the image on a connected machine, then `docker save ghcr.io/vxrz/steward:<version> | gzip > steward.tar.gz`, copy the file and `docker load < steward.tar.gz`.

**What happens at the first start.** The app compares the database with the migrations it knows:

- Nothing new: it starts as usual. No copy is made.
- Migrations to apply (SQLite): it first writes a copy of the database to `<data folder>/backups/pre-<new version>-<UTC time>.db`, then applies the migrations, each one in its own transaction. The log line `database backed up before migrating` names the copy. The newest 3 copies are kept; set `SM_UPGRADE_BACKUPS` to keep more, or `0` for none. The copies are private to the account that runs the app (0600), like the database: they hold the same encrypted secrets.
- After the vault is unlocked, the audit log gets one entry `system.upgraded` with the old and new version, the schema before and after, the migrations applied and the path of the copy.
- Administrators then see a notice at the top of the web app: _Steward was updated from … to …_, with the migrations applied, where the copy is (or why there is none: nothing to migrate, PostgreSQL – use `pg_dump` – or `SM_UPGRADE_BACKUPS=0`) and a link to the release notes. Each administrator closes it for themselves; it stays closed in other browsers too. The next update replaces it. Other users never see it, because it names the path of the copy.
- A migration fails: the app does not start. The message says which migration failed and where the copy is. The failed migration is rolled back; migrations before it in the same start stay applied. Restore the copy (below) and start the previous version, and please report the problem with the message.
- The database is newer than the app (a downgrade): the app refuses to start with `The database schema (version …) is newer than this version of the app supports`. **Downgrades are not supported.** To go back, restore the copy or backup from before the update and use the previous version with it.

**Restore the automatic copy (SQLite).** Stop the app. In the data folder, move `service-manager.db` and any `service-manager.db-wal` and `service-manager.db-shm` aside, copy the backup to `service-manager.db`, and start the version you used before the update. (A copy is named after the version that was about to migrate it, not the one that wrote it.) Keep `vault.json` and the other files of the data folder: the copy belongs to them. Your manual backup of the whole data folder works the same way: stop, unpack, start.

**PostgreSQL.** The app does not back up PostgreSQL itself: a copy of a live server database is best made with the server's own tools. Before every update, run `pg_dump` (see [Backup](#5-database-sqlite-or-postgresql)) and back up the data folder. When an update migrates the database, the log says so with the warning `PostgreSQL: migrating the database without an automatic backup`. PostgreSQL rolls back a failed migration as well; to go back, restore the dump with `pg_restore --clean` and start the previous version.

**Moving from a local to a deployed instance.** To move the desktop app to a server with PostgreSQL and single sign-on, use a **migration package**: export it on the laptop (_Settings → Migration_ or `steward migrate export`), set up the server with its own master passphrase, administrator and single sign-on, then import the package there with a mapping of every local user to an account on the server (for example their single sign-on account). Everything important moves, credentials are re-encrypted for the server's vault, the audit log stays verifiable, and the mapping is recorded in the audit log. Step by step: [MIGRATION.md](MIGRATION.md).

To move an instance 1:1 instead – the same accounts, the same master passphrase – copy the data folder to the server, start the same or a newer version there, and for PostgreSQL move the database with `npm run db:copy` (see above). `db:copy` upgrades the source first and keeps a copy of an older SQLite source in `backups/` next to it.

## Resetting a demo and recovering access

### Start a demo from scratch

A Steward installation is its data folder. To start over, stop Steward, delete (or rename) the folder and start again: you get the first-start screen (new master passphrase, new admin) and can load the demo platforms and processes again. This also deletes all processes, runs, the vault and the audit log of that folder.

| Started with                        | Data folder                                            |
| ----------------------------------- | ------------------------------------------------------ |
| `npm run demo` / `npm run dev:demo` | `data/` in the project folder (or `SM_DATA_DIR`)       |
| Desktop executable, Windows         | `%LOCALAPPDATA%\steward`                               |
| Desktop executable, macOS           | `~/Library/Application Support/steward`                |
| Desktop executable, Linux           | `~/.local/share/steward` (or `$XDG_DATA_HOME/steward`) |
| Container                           | the `sm-data` volume: `docker compose down -v`         |

Keep demos in their own folder so they never mix with real data: `steward --demo --data-dir ~/steward-demo` or `SM_DATA_DIR=./demo-data npm run demo`. With PostgreSQL, the data lives in the database schema (`SM_DATABASE_URL`/`SM_DATABASE_SCHEMA`): use a separate schema for demos.

### Forgotten administrator password

The recovery command sets a one-time password for a local account on the server itself. It needs access to the data folder **and** the master passphrase, so it gives no more than someone who can already unlock the vault. Steward must be stopped (the command refuses otherwise). It signs out all sessions of the account, and the next sign-in asks for a new password. The reset is written to the audit log with the operating-system account that ran it (`cli:<user>@<host>`).

```bash
steward admin list-admins                      # administrator accounts and how they can sign in
steward admin reset-password admin             # prompts for the master passphrase
steward admin reset-password alice --activate  # also reactivates a deactivated account
npm run admin -- reset-password admin          # from the source tree
```

In the container: `docker compose stop steward && docker compose run --rm steward node --import tsx server/src/cli/admin.ts reset-password admin`, then start it again.

The passphrase comes from `SM_MASTER_PASSPHRASE_FILE`/`SM_MASTER_PASSPHRASE`, `--passphrase-stdin` or a prompt. Run `steward admin --help` for all options; `--json` gives machine-readable output.

Without the master passphrase nothing can be recovered: the credentials and the audit key are encrypted with it. Start from scratch as above and set up the platforms again.

Accounts that sign in with single sign-on have no password. If the identity provider is unavailable, use [emergency access](#locked-out-of-single-sign-on), or reset the password of a local administrator account while password sign-in is allowed for administrators (see [SECURITY-HARDENING.md](SECURITY-HARDENING.md)). With password sign-in turned off (_single sign-on only_), `reset-password` refuses and points to `emergency-access`.

### Locked out of single sign-on

With _Settings → Sign-in → Single sign-on only_ (or `SM_PASSWORD_LOGIN=none`) nobody signs in with a password. `SM_PASSWORD_LOGIN=none` on a new installation waits until single sign-on works: until an administrator has signed in through an enabled provider, administrators sign in with their password (as with `adminsOnly`), so you can set Steward up and configure the provider; from that sign-in on (audit entry `settings.password_login_effective`) it applies for good – disabling the provider later does not bring passwords back. _Settings → Sign-in_ and _System status_ show while it waits. When the identity provider fails – an expired client secret, a tenant change, an outage – an administrator gets in with **emergency access** from the server's command line:

```bash
steward admin emergency-access alice               # 60 minutes by default
steward admin emergency-access alice --minutes 30  # at most 1440 (24 hours)
```

What it does and needs:

- It runs **on the server**, needs the **data folder** and the **master passphrase** (`SM_MASTER_PASSPHRASE_FILE`/`SM_MASTER_PASSPHRASE`, `--passphrase-stdin` or a prompt) – the same rules as `reset-password`. It cannot be used from another machine.
- It prints a **one-time link**, `<address>/emergency-access#code=…`. The address is `SM_PUBLIC_URL` when set (with the base path), otherwise the address Steward runs at on the server. The code is in the part after `#`, which browsers do not send to the server or a proxy log. Open the link in a browser that reaches Steward, or open `/emergency-access` and paste the code.
- The link works **once**, for that **administrator** only (a local or a single sign-on account), until the window ends. Each administrator account has at most one open link: a new command for the same account replaces the older one (other administrators can have their own at the same time; `list-admins` shows the open windows). Only a hash of the code is stored.
- The session is marked as **emergency access**: a banner at the top of every page (_Emergency access – fix the sign-in, then sign out_), at most **one hour**, no forced password change, no new API tokens. Every action of the session is flagged in the audit log (`[Emergency access]`). Password sign-in itself stays off.
- Audit entries: `auth.emergency_access_granted` (the operating-system account and host as `cli:<user>@<host>`, the account, the window) when the command runs; `auth.emergency_sign_in` at the sign-in; `auth.emergency_sign_in_failed` for wrong, used or expired codes.
- All other administrators are notified at the sign-in (in the app, by e-mail and in Teams, as far as these are set up – _Settings → Notifications_, event _Emergency access_), so nobody can use it unnoticed.

It works **while Steward runs** and while it is stopped:

- **Running:** the command signs the request with the installation's key from the vault (which needs `vault.json` and the master passphrase) and hands it to Steward on this machine (`instance.json` in the data folder tells it where). Steward checks the signature, that the request is fresh, that it is meant for this running instance and that it came directly over the loopback interface (not through a proxy). This also works while the vault is locked. The command only sends to a loopback address: if Steward listens on one specific network address (`SM_HOST=10.0.0.5`), stop it first.
- **Stopped:** the command writes the grant into the database; start Steward, then open the link.

Step by step:

1. **Desktop executable.** Open a terminal on the computer where Steward runs and run `steward admin emergency-access <your user name>` (Windows: `steward.exe admin …`; add `--data-dir` if you use your own data folder). Enter the master passphrase. Open the printed link.
2. **Node.js.** In the project folder, as the account that runs Steward: `npm run admin -- emergency-access <your user name>`. Use the same `SM_DATA_DIR`, `SM_DATABASE_URL` and `SM_PUBLIC_URL` as the service.
3. **Container.** While it runs: `docker compose exec steward node --import tsx server/src/cli/admin.ts emergency-access alice` (with `SM_MASTER_PASSPHRASE_FILE` set in the compose file the command reads the passphrase from the secret, otherwise it asks for it). If it does not run: `docker compose run --rm steward node --import tsx server/src/cli/admin.ts emergency-access alice`, then `docker compose up -d`.
4. Sign in with the link, repair the sign-in (_Users & teams → Single sign-on_: client secret, issuer, mappings), check that a single sign-on administrator gets in again, and **sign out**.

If the provider stays down for longer, switch password sign-in back on from the emergency session (_Settings → Sign-in_) or on the server with Steward stopped:

```bash
steward admin password-login adminsOnly   # or all; none needs an enabled provider and an administrator who signs in with it
steward admin list-admins                 # how each administrator can sign in right now
```

`password-login` is audited like the setting and signs out the password sessions the new mode refuses. When `SM_PASSWORD_LOGIN` is set, it wins: change the variable instead.

## Behind a reverse proxy

Colleagues usually reach Steward through a reverse proxy (nginx, Traefik, Caddy, …) that terminates TLS. Steward then listens on a local or internal address only.

### Settings

| Setting            | Value                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SM_PUBLIC_URL`    | The address people open, e.g. `https://steward.corp.example` – or `https://apps.corp.example/steward` under a path                           |
| `SM_TRUST_PROXY`   | The proxy's address or network (`10.0.0.5`, `10.1.0.0/16`, `loopback`), so `X-Forwarded-For/-Proto/-Host` are believed from it (and only it) |
| `SM_ALLOWED_HOSTS` | The `Host` header the proxy sends to Steward – the public name when the proxy keeps it (the examples below do)                               |
| `SM_BASE_PATH`     | Only under a path, and only if you do not set `SM_PUBLIC_URL`: e.g. `/steward`                                                               |

An `https://` `SM_PUBLIC_URL` makes the session cookie `Secure` and turns on HSTS. Steward builds the single sign-on redirect URI and the links in e-mails, Teams cards and the daily summary from it (or from the base URL in _Settings → Notifications_). Register `<SM_PUBLIC_URL>/api/auth/oidc/callback` at the identity provider; _Settings → Single sign-on_ shows the exact URI.

### Recommended: an own (sub)domain

Give Steward its own host name, e.g. `steward.corp.example`. Browsers keep sites apart by origin (scheme, host and port), not by path. With its own host name no other application can read Steward's pages or act with its users' sessions, and the session cookie gets the strongest protection (`__Host-sm_session`: `Secure`, `Path=/`, no `Domain`).

```nginx
# nginx – steward.corp.example
server {
  listen 443 ssl;
  server_name steward.corp.example;
  # ssl_certificate …; ssl_certificate_key …;
  client_max_body_size 60m;              # uploads up to 50 MB
  location / {
    proxy_pass http://127.0.0.1:4310;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, do not append the client's value
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_buffering off;                 # streamed answers (MCP, downloads) arrive right away
  }
}
```

```yaml
# Traefik (Docker labels)
labels:
  - traefik.http.routers.steward.rule=Host(`steward.corp.example`)
  - traefik.http.routers.steward.tls=true
  - traefik.http.services.steward.loadbalancer.server.port=4310
```

```caddyfile
# Caddy
steward.corp.example {
  reverse_proxy 127.0.0.1:4310
}
```

Steward: `SM_PUBLIC_URL=https://steward.corp.example`, `SM_ALLOWED_HOSTS=steward.corp.example`, `SM_TRUST_PROXY=<proxy address>` (`loopback` when the proxy runs on the same machine). Traefik and Caddy send `X-Forwarded-*` themselves.

### Under a path: `https://apps.corp.example/steward`

Some companies give only one host name. Steward can run under a path prefix:

- Set `SM_PUBLIC_URL=https://apps.corp.example/steward`. Its path is the base path. (Or set `SM_BASE_PATH=/steward`; when both are set they must agree, otherwise Steward refuses to start.) The base path may only contain letters, digits and `. _ ~ -` in its segments.
- Everything Steward serves moves below the prefix: the web UI, `/steward/api/…` (including `/api/v1`, `/api/mcp`, webhooks under `/api/hooks/…`, `/api/health`, `/api/ready`, `/api/metrics` and the API documentation), the manifest and the service worker. Requests outside the prefix get `404`; only `/` itself redirects to `/steward/`.
- **The proxy passes the path on unchanged. It must not strip the prefix.** Steward expects `/steward/api/health`, not `/api/health`. A proxy that strips the prefix makes every request fail with `404`, and Steward logs `request outside the base path … no prefix stripping` (at most once a minute). `X-Forwarded-Prefix` is not used.
- One web build works under any prefix: Steward writes the base into the page (`<base href="/steward/">`).
- Health checks, Gatus and Kubernetes probes use the prefix too: `https://apps.corp.example/steward/api/ready`, `httpGet.path: /steward/api/ready`.

```nginx
# nginx – the prefix stays: proxy_pass WITHOUT a path (no trailing slash)
location = /steward { return 302 /steward/; }
location /steward/ {
  proxy_pass http://127.0.0.1:4310;      # not http://127.0.0.1:4310/ – that would strip /steward
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
  proxy_buffering off;
  client_max_body_size 60m;
}
```

```yaml
# Traefik – PathPrefix router, and NO StripPrefix middleware
labels:
  - traefik.http.routers.steward.rule=Host(`apps.corp.example`) && PathPrefix(`/steward`)
  - traefik.http.routers.steward.tls=true
  - traefik.http.services.steward.loadbalancer.server.port=4310
```

```caddyfile
# Caddy – "handle", not "handle_path" (handle_path strips the prefix)
apps.corp.example {
  redir /steward /steward/
  handle /steward/* {
    reverse_proxy 127.0.0.1:4310
  }
}
```

Steward: `SM_PUBLIC_URL=https://apps.corp.example/steward`, `SM_ALLOWED_HOSTS=apps.corp.example`, `SM_TRUST_PROXY=<proxy address>`.

> **Security: a path is weaker than an own host name.** Every application on `apps.corp.example` shares Steward's origin. A cross-site scripting flaw in any of them could read Steward's pages and act inside Steward with the signed-in user's session; the cookie path does not stop that. The session cookie is `__Secure-sm_session` with `Path=/steward` (`__Host-` requires `Path=/`): still `Secure`, `HttpOnly`, `SameSite=Strict` and host-only, but no longer protected by the `__Host-` rules: a neighbouring subdomain could plant a cookie of that name. The session binding (the key only Steward's pages hold) keeps such a cookie from taking over a session, but it can sign users out. Use a path only when you trust every application on that host name, and prefer an own subdomain. Two Steward installations under different paths of one host also share the browser's storage: signing in to one can sign the other tab out.

The desktop executable is not affected: it always runs on its own local address.

### Steward in Docker

`SM_TRUST_PROXY` names the address the proxy's requests **come from as Steward sees them**. In a container that is often not the address you expect:

- **The proxy runs on the host** and Steward's port is published (`127.0.0.1:4310:4310`): the requests come from the gateway of the container's Docker network, not from `127.0.0.1` – `loopback` does not match. Give the network a fixed subnet and trust its gateway:
  ```yaml
  services:
    steward:
      networks: [steward]
      environment:
        SM_TRUST_PROXY: '172.30.0.1'
  networks:
    steward:
      ipam:
        config:
          - subnet: 172.30.0.0/24
            gateway: 172.30.0.1
  ```
- **The proxy runs in Docker too** (e.g. Caddy on a network `caddy-bridge`): put Steward on that network, publish no port, and trust the proxy's address on it. Give the proxy a fixed address (`ipv4_address`, which needs a network created with `--subnet`); trusting the whole subnet lets every container on it claim any client address.
  ```yaml
  services:
    steward:
      # no "ports:" – only containers on caddy-bridge reach it
      networks:
        caddy-bridge:
          aliases: [steward]
      environment:
        SM_PUBLIC_URL: 'https://apps.corp.example/steward'
        SM_ALLOWED_HOSTS: 'apps.corp.example'
        SM_TRUST_PROXY: '172.20.0.10' # the proxy's fixed address on caddy-bridge
  networks:
    caddy-bridge:
      external: true
  ```
  ```caddyfile
  apps.corp.example {
    redir /steward /steward/
    handle /steward/* {
      reverse_proxy steward:4310
    }
  }
  ```
- Avoid a hop count (`SM_TRUST_PROXY=1`) in Docker: it trusts any private address, and every container is one.
- Check it: after signing in through the proxy, the audit log shows your own address – not one of the Docker network.

## Company proxy and TLS inspection

Steward in a container does not use the host's or your PC's proxy settings, and Node.js trusts only the public certificate authorities – not your company's. A platform that works in Postman or the browser can therefore fail in Steward:

| Message                                                                                   | Cause and fix                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ETIMEDOUT`, `ECONNREFUSED`, `fetch failed`, `getaddrinfo ENOTFOUND` for an internet host | Outbound traffic must go through a proxy. Set it for all of Steward (`HTTPS_PROXY`, `NO_PROXY` below) or per platform (_Platform → HTTP → Proxy_: a URL, empty = the environment, `none` = direct).             |
| `unable to verify the first certificate`                                                  | The server sends its certificate without the intermediate CA (browsers fetch it themselves, Node.js does not). Fix the server: its certificate file must contain the intermediate(s). Or trust the CA as below. |
| `unable to get local issuer certificate`, `self-signed certificate in certificate chain`  | Your network re-signs HTTPS (TLS inspection) or the server uses a company CA. Trust that CA as below.                                                                                                           |

```yaml
services:
  steward:
    volumes:
      - ./corp-ca.pem:/etc/steward/corp-ca.pem:ro # root (and intermediate) certificates, PEM; readable by the container user
    environment:
      HTTPS_PROXY: 'http://proxy.corp.example:8080'
      NO_PROXY: 'localhost,127.0.0.1,.corp.example' # add internal hosts and the names of other containers
      NODE_EXTRA_CA_CERTS: /etc/steward/corp-ca.pem
```

Per platform, _Additional CA certificate (PEM)_ trusts a CA for that platform only. Do not use _Accept self-signed certificates_ for this – it turns the certificate check off. The hint `--use-system-ca` in Node.js' message does not help in the container: its system store does not know your company CA either. Single sign-on and notifications use the same `HTTPS_PROXY`/`NO_PROXY` and `NODE_EXTRA_CA_CERTS`.

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

**Under a path**, both live below it: `https://apps.corp.example/steward/api/ready`. The image's own `HEALTHCHECK` follows the base path, the port and `SM_TLS_CERT` by itself (before 0.2.1 it always asked `/api/health` at the root, so a container under a path showed _unhealthy_). With 0.2.0, override it in the compose file:

```yaml
healthcheck:
  test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:4310/steward/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

With Steward's own TLS (`SM_TLS_CERT`), the check accepts only the certificate in that file. Steward reads the file at start, so after renewing the certificate the container shows _unhealthy_ until Steward is restarted, which it needs anyway to serve the new certificate.

A monitor that gets **401** asks a path Steward does not know (a trailing slash, `/api/healthz`): unknown API paths answer _please sign in_ rather than revealing which routes exist. Monitors need no credentials for these two endpoints.

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
