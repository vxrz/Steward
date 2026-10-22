# Error reporting (Sentry, GlitchTip, Bugsink)

Steward can send **unexpected errors** to any service that speaks the Sentry
protocol: [Sentry](https://sentry.io) (SaaS or self-hosted),
[GlitchTip](https://glitchtip.com) or [Bugsink](https://www.bugsink.com).
It is **off by default**. Nothing is loaded, sent or allowed by the Content
Security Policy until you set a DSN.

## Turning it on

| Variable | Default | Purpose |
| --- | --- | --- |
| `SM_SENTRY_DSN` | – | DSN for server errors, e.g. `https://<public key>@glitchtip.corp.example/3`. Also used for the web UI unless `SM_SENTRY_DSN_WEB` is set. |
| `SM_SENTRY_DSN_WEB` | = `SM_SENTRY_DSN` | DSN for errors in the browser (another project, or `off` to report server errors only). |
| `SM_SENTRY_ENVIRONMENT` | `production` | Environment shown in the error tracker (`test`, `prod-eu`, …). |
| `SM_SENTRY_RELEASE` | `steward@<version>` | Release name. |
| `SM_SENTRY_TRACES_SAMPLE_RATE` | `0` | `0`–`1`. Above 0, performance traces (runs, steps, platform calls, HTTP requests) go to Sentry as well. Ignored while OpenTelemetry export is on (see below). |

The same settings work for `npm start`, the Docker image and the desktop
executable. The web UI gets its DSN from the server at runtime
(`GET /api/client-config`), so the same build works with and without error
reporting. Check the configuration with:

```bash
SM_SENTRY_DSN=https://…  steward --send-test-error     # desktop executable
SM_SENTRY_DSN=https://…  npm run desktop -- --send-test-error
```

The server's requests to the error tracker honour `HTTPS_PROXY` / `NO_PROXY`.
Browsers send their reports directly to the DSN host, so it has to be reachable
from the users' machines; Steward then adds that origin (and only that) to the
`connect-src` directive of its Content Security Policy.

The DSN's public key is not a secret: it can only submit events, and every
browser that opens Steward receives it. `GET /api/client-config` is therefore
readable without signing in (errors on the sign-in page are reported too).

## What is reported

| Reported | Not reported (business outcomes, visible in Steward itself) |
| --- | --- |
| API requests answered with a 5xx status by the error handler | 4xx responses: validation errors, missing permissions, not found, locked vault |
| Unhandled exceptions and unhandled promise rejections (the process still exits as before, after reporting) | Failed runs and failed steps, platforms answering with 4xx/5xx, timeouts, network errors |
| Internal engine errors: programming errors (`TypeError`, `ReferenceError`, `RangeError`) in a step or run, failed resume/recovery of runs, failed schedules | A wrong `SM_MASTER_PASSPHRASE` and other expected errors (`HttpError` < 500) |
| Browser: uncaught errors, unhandled rejections, rendering errors caught by the error boundary | |

## What is sent

Steward configures the SDKs with an explicit, minimal set of integrations (no
defaults) and `sendDefaultPii: false`, and scrubs every event before it leaves
the process (`scrubEvent` in `shared/src/scrub.ts`, shared by server and browser;
covered by `server/test/error-reporting.test.ts`).

**An event contains**

- the error type, message and stack trace (file names, functions, line numbers,
  and on the server a few lines of Steward's own source code around each frame);
  the linked `cause` errors
- tags: `route` (route pattern, e.g. `/api/runs/:id`), `method`, `request_id`,
  `phase` (`step`, `run`, `resume`, `schedule`, …), `node_type`, `run_id`
  (random id, to find the run in Steward), `trace_id` (OpenTelemetry trace, when
  tracing is on)
- `user.id`: a SHA-256 hash of Steward's internal user id (16 hex characters) –
  lets you count affected users, but not identify them. No name, user name,
  e-mail or IP address.
- server: Node.js version, OS name and version, CPU architecture/model/count,
  memory, locale and time zone, process start time; environment and release
- browser: page path (without host, query string or fragment), the user agent,
  and breadcrumbs of the last 30 navigations, clicks (CSS selector of the
  element) and API calls (method, path without query string, status code)

**Never sent**

- request headers (except the browser's user agent), cookies, `Authorization`,
  request and response bodies, query strings, URL fragments
- the host name of the server (`server_name` is `steward`), cloud metadata,
  host names in page URLs
- local variables (`includeLocalVariables: false`), console output, the list
  of installed modules
- session replays, user feedback, release-health sessions, profiles
- performance traces, unless `SM_SENTRY_TRACES_SAMPLE_RATE` > 0

**Masked as `***` wherever they appear** (messages, tags, breadcrumbs, span
attributes, extra data):

- all platform secret values from the vault and cached OAuth access tokens,
  the secrets used by the run in which an error happened, the master passphrase
  and the values of environment variables whose names contain `SECRET`,
  `PASSWORD`, `PASSPHRASE`, `TOKEN`, `PRIVATE`, `CREDENTIAL`, `API_KEY`,
  `ACCESS_KEY` or end in `_KEY`
- values under keys such as `authorization`, `cookie`, `password`,
  `passphrase`, `secret`, `token`, `api_key`, `credential`, `private_key`,
  `signature`, `session`, `email`, `username`, `ip`, `enduser.*`
- Steward API tokens (`smt_…`), JSON Web Tokens, `Bearer`/`Basic` credentials,
  `user:password@` in URLs, `password=…`/`"token": "…"` pairs, GitHub/Slack/AWS/
  Google key formats, other long random-looking strings (≥ 32 characters)
- e-mail addresses, IPv4 and IPv6 addresses
- the user name in home-directory paths (`/home/<user>`, `C:\Users\<user>`)

Scrubbing is deliberately aggressive. If an event lacks something you need,
reproduce the error locally with `SM_LOG_LEVEL=debug` instead of loosening the
rules.

## Tracing: OpenTelemetry and Sentry together

Steward has its own OpenTelemetry tracing (`OTEL_EXPORTER_OTLP_ENDPOINT`, see
the README). The two do not get in each other's way:

- **OTLP export on** (with or without a DSN): Steward's tracer provider stays in
  charge. Sentry is started with `skipOpenTelemetrySetup` and only reports
  errors – no second tracer provider, no double instrumentation. Errors that
  happen inside a run carry the OpenTelemetry `trace_id` as a tag, so you can
  jump from the error to the trace. `SM_SENTRY_TRACES_SAMPLE_RATE` is ignored
  (a warning is logged); send your OTLP traces to the tracing backend of your
  choice (Sentry also accepts OTLP).
- **OTLP export off, DSN set, sample rate 0** (default): errors only.
- **OTLP export off, DSN set, sample rate > 0**: Sentry sets up OpenTelemetry
  itself; Steward's run, step and platform-call spans and incoming HTTP requests
  are sent to Sentry as transactions (scrubbed like events).

## Desktop executable

The single-file executable embeds the server SDK; it is only loaded when a DSN
is set. Should loading fail in a custom build, Steward logs a warning and runs
without error reporting.

## Trying it locally

Any HTTP server that accepts `POST /api/<project>/envelope/` will do;
`server/test/fakeSentry.ts` is the one the tests use. For a real UI:

```bash
docker run -d -p 8000:8000 -e SECRET_KEY=$(openssl rand -hex 32) \
  -e CREATE_SUPERUSER=admin:admin bugsink/bugsink   # then create a project and copy its DSN
```
