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

1. Download the file for your system from the GitHub release (`service-manager-windows-x64.zip`, `…-macos-arm64.tar.gz` for Apple silicon, `…-macos-x64.tar.gz` for Intel Macs, `…-linux-x64.tar.gz`, `…-linux-arm64.tar.gz`) and unpack it.
2. Start `service-manager` (`service-manager.exe` on Windows).
   - A console window shows the address and stays open while the app runs. Close it to stop the app.
   - The UI opens as its own app window in Edge or Chrome (`--app` mode, no tabs or address bar). Without Edge/Chrome it opens in your default browser.
   - Starting it a second time only opens the window again.
3. Data is kept per user:
   - Windows: `%LOCALAPPDATA%\service-manager`
   - macOS: `~/Library/Application Support/service-manager`
   - Linux: `~/.local/share/service-manager`

```text
service-manager [--port 4310] [--data-dir <folder>] [--no-open] [--demo] [--autostart on|off]
```

| Option | Effect |
| --- | --- |
| `--autostart on` | Starts the app in the background when you sign in, so schedules keep running. It uses the Startup folder on Windows, a LaunchAgent on macOS and XDG autostart on Linux; no admin rights needed. Combine it with `SM_MASTER_PASSPHRASE` (user environment variable) if schedules must run before anyone unlocks the vault. `--autostart off` removes it. |
| `--no-open` | Start without opening a window. |
| `--demo` | Demo mode with simulated platforms. |

All `SM_*` and `OTEL_*` environment variables from the README work as well.

**First start on Windows and macOS.** The release files are not code-signed, so you may see a warning:

- Windows SmartScreen: *More info → Run anyway*.
- macOS: right-click → *Open*, or `xattr -d com.apple.quarantine service-manager`.

For a company rollout, sign the binaries (Authenticode on Windows, Developer ID and notarisation on macOS) and distribute them with Intune, Jamf or your software centre.

**Browser steps** (the *Browser* node and PDF protocols) need Playwright and Chromium, which are not embedded because they are large. Use option 3 or 4 (with `WITH_BROWSER=1`) if you need them. Everything else works in the executable.

**Build it yourself:**

```bash
npm install
npm run build        # web UI
npm run build:exe    # → dist-exe/service-manager[.exe]
```

The executable is built for the system you build on, so build on each target OS. The `Release` GitHub workflow does this for Windows, macOS (Intel and Apple silicon) and Linux (x64 and arm64). It smoke-tests each binary, adds a CycloneDX SBOM and checksums, and attaches everything to the release when you push a tag such as `v0.2.0`.

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
docker build --build-arg WITH_BROWSER=1 -t service-manager .   # with Chromium for browser steps
```

- Data lives in the `sm-data` volume (`/data`). Back it up.
- The compose file publishes the port on `127.0.0.1` only. To serve colleagues:
  - put it behind a reverse proxy with TLS, or set `SM_TLS_CERT`/`SM_TLS_KEY`;
  - set `SM_ALLOWED_HOSTS` to the DNS name and `SM_PUBLIC_URL` to the external URL;
  - configure single sign-on.
- `/api/health` (liveness) and `/api/ready` (readiness: vault unlocked, database writable, scheduler running) are available for orchestrators. `/api/metrics` serves Prometheus metrics.
- Set `SM_MASTER_PASSPHRASE` from a secret so schedules run after restarts.

## Why not Electron or Tauri?

Both are possible and would add a native tray icon and auto-update. They also add a second toolchain:

- Electron bundles its own Chromium, around 150 MB more.
- Tauri needs Rust.

The executable plus the browser's app window gives nearly the same experience with no extra code. If a tray icon or auto-update becomes important, Electron can wrap the same server unchanged by importing `server/src/main.ts`.
