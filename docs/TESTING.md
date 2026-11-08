# Testing Steward

This guide covers how to test Steward properly: the automated test layers, manual checks per role using the demo, a plan for a real sandbox tenant, and the resilience, security, performance and packaging checks to run before go-live.

## 1. Test layers

| Layer                    | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Command                                                                                           | When                                                   | Time                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| Unit + API tests         | Engine, process model, RBAC, SSO, scheduler, dashboards, restart/resume, browser steps. These run against the mock platforms (vitest, `server/test`, test files in parallel – see [below](#running-the-server-tests)).                                                                                                                                                                                                                                                                     | `npm test`                                                                                        | Every change                                           | about 25 min with 2 workers, 5–7 min per CI shard |
| Engine contract          | The invariants of the run engine (ADR 0011) and golden protocol hashes of example processes as test runs; a crash and restart with two server processes. Part of the server suite, also on PostgreSQL.                                                                                                                                                                                                                                                                                     | `npx vitest run test/engine-contract.test.ts test/engine-contract-restart.test.ts` (in `server/`) | Changes to `server/src/engine/`                        | ~1 min                                            |
| Same tests on PostgreSQL | The server suite against PostgreSQL instead of SQLite. Each test server gets its own schema.                                                                                                                                                                                                                                                                                                                                                                                               | `SM_TEST_DATABASE_URL=postgres://… npm run test:pg`                                               | Changes to SQL or `server/src/db*`                     | about 30 min with 2 workers                       |
| Type check               | shared, server, web and the UI tests (`e2e/`)                                                                                                                                                                                                                                                                                                                                                                                                                                              | `npm run typecheck`                                                                               | Every change                                           | ~30 s                                             |
| Lint and formatting      | ESLint (TypeScript, React hooks) and Prettier over the whole repository                                                                                                                                                                                                                                                                                                                                                                                                                    | `npm run lint && npm run format:check`                                                            | Every change (the pre-commit hook checks staged files) | ~30 s                                             |
| UI tests                 | Critical paths in a real browser (Playwright): sign-in, roles, run → decision → protocol → audit, process editor, schedules, dashboards, platforms, command palette, API tokens, settings, users, phone layout, accessibility (axe), console errors                                                                                                                                                                                                                                        | `npm run build && npm run test:ui`                                                                | Every UI or API change                                 | ~1 min (4 workers), ~1.5 min in CI                |
| Example validation       | Every YAML in `examples/` parses and validates                                                                                                                                                                                                                                                                                                                                                                                                                                             | `npm run validate`                                                                                | Changes to examples                                    | seconds                                           |
| Contract check           | Calls each documented GET operation (no required parameters) of a platform and compares the response with its OpenAPI spec                                                                                                                                                                                                                                                                                                                                                                 | `npm run contract -- --url http://127.0.0.1:4310 --token smt_… --platform <platform id> [--json]` | Against a sandbox tenant, weekly and before upgrades   | ~1 min                                            |
| Executable smoke test    | The single-file binary starts and serves the UI                                                                                                                                                                                                                                                                                                                                                                                                                                            | see [section 7](#7-packaging)                                                                     | Each release                                           | 1 min                                             |
| CI                       | `.github/workflows/ci.yml` (lint, formatting and the generated documents; build on Node 24 and 26: typecheck, validate, build, smoke test, audit; the server suite in shards – Node 24 with coverage, Node 26, PostgreSQL –, the shards' coverage merged with its minimums: summary in the job, HTML report as the artifact `server-coverage`; the database platforms), `.github/workflows/ui-tests.yml` (UI tests), `release.yml` (executables + smoke test + SBOM) – see [In CI](#in-ci) | pull request, push to `main`                                                                      | automatic                                              | –                                                 |

The contract check also accepts `SM_URL`, `SM_TOKEN` and `SM_PLATFORM` instead of the flags. It exits with 1 when an operation fails and with 2 on usage or connection errors, so it can gate a CI job.

### Running the server tests

```bash
npm test                                         # the whole suite on SQLite, several test files at once
npm run test:coverage                            # the same with coverage and its minimums (see Coverage)
SM_TEST_DATABASE_URL=postgres://… npm run test:pg # the same on PostgreSQL
cd server && npx vitest run test/runs.test.ts    # one file (or a part of a name: npx vitest run runs)
cd server && npx vitest run --maxWorkers=1       # one file at a time, to rule out interference
cd server && npx vitest run --shard=2/3          # the second of three shards, as one CI job runs it
```

How it works:

- **Files run in parallel.** Every test file runs in its own process (`pool: 'forks'` in `server/vitest.config.ts`), and several files run at the same time: half of the cores locally, 3 workers in CI (where `CI` is set: a hosted runner has 4 vCPUs). Most of a file's time is starting its server and loading demo data, not its tests, so this scales with the cores; `--maxWorkers=N` changes it.
- **Nothing is shared between files.** Each test server listens on port 0 (the system picks a free port), gets its own data folder in the temp directory and, on PostgreSQL, its own schema; `process.env`, timers and other process-wide state stay in the file's own process. A new test that needs a file outside its data folder or a listening socket makes it unique: `fs.mkdtempSync(path.join(os.tmpdir(), 'sm-…-'))`, `listen(0)`.
- **`startTestServer()` stops its server.** After the file's last hook it closes every server the file started and has not closed yet, and removes their data folders. It closes all connections first: a raw `fetch` whose body is never read keeps its keep-alive socket busy, and `app.close()` would wait for it up to the hook time-out. A file needs no `afterAll` for its server; one that starts several servers one after another closes each before the next (`await s.app.close()`).
- **Time limits stretch.** Write an elapsed-time check with `timeLimit()` from `server/test/time.ts`: `expect(performance.now() - t0).toBeLessThan(timeLimit(500))`. The limit is multiplied by `SM_TEST_TIME_FACTOR` (set in `vitest.config.ts`): 2, because other files take CPU at the same time, and 6 with coverage. Such a limit says "linear, not quadratic" or "answers at once" – it catches a runaway, not a busy machine. A check that a time-out fires compares with the time-out itself instead.
- **Demo data are loaded per file.** About half of the files load the demo data (`POST /api/demo/setup`, about 4 s each). They are not loaded once and copied, because they contain the test server's own address: the mock platforms' URLs carry its port and are sealed with the vault's integrity key, so a copy would point at another server.

#### Coverage

`npm run test:coverage` measures the coverage of `server/src` (v8): a summary in the terminal, the HTML report in `server/coverage/`. The run fails below the minimums in `server/vitest.config.ts` (`coverage.thresholds`: statements 84 %, branches 73 %, functions 87.5 %, lines 87.5 %), about one point below the coverage of the whole suite in November 2026 (84.9 %, 74.4 %, 88.7 %, 88.6 %). Raise them when coverage grows; do not lower them to let a change pass. Only the whole suite reaches them – for a few files use `npm test`, or measure with `--coverage.thresholds.statements=0 …`. A shard (`--shard`) never checks them: CI checks the merged coverage of all shards.

#### In CI

`.github/workflows/ci.yml` runs, in parallel jobs:

| Job                                                             | What                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint`                                                          | ESLint, Prettier, translations, the generated documents (`config:docs`, `openapi` with `--check`)                                                                                                                                                                                |
| `build (Node 24)`, `build (Node 26)`                            | typecheck, `validate`, `npm run build`, the smoke test of the compiled server, the desktop executable's bundle, and on Node 24 the dependency audit                                                                                                                              |
| `test (Node 24, shard …)`                                       | the server suite in 3 shards with coverage; each shard keeps its results as a [blob report](https://vitest.dev/guide/reporters#blob-reporter) (artifact `server-blob-*`, one day)                                                                                                |
| `coverage`                                                      | merges the Node 24 shards (`npx vitest --merge-reports=blob-report --coverage`): the test results once more, the coverage summary in the job summary, the HTML report as the artifact `server-coverage`, the minimums                                                            |
| `test (Node 26, shard …)`                                       | the server suite in 2 shards                                                                                                                                                                                                                                                     |
| `test-postgres (shard …)`                                       | the server suite on PostgreSQL in 3 shards                                                                                                                                                                                                                                       |
| `test-databases`                                                | the database platforms against MariaDB and SQL Server                                                                                                                                                                                                                            |
| `build-test (Node 24)`, `build-test (Node 26)`, `test-postgres` | gate jobs with the names the branch rules of `main` require: each succeeds only when every job it waits for succeeded (Node 24: its build, test shards and `coverage`; Node 26: its build and test shards; PostgreSQL: its shards) – a failed, cancelled or skipped job fails it |

Pull requests are tested through the `pull_request` event, `main` through `push` (tags are built by `release.yml` and the container workflow) – a branch push alone starts nothing, so a commit is not tested twice. A new push to a pull request cancels its running checks; every commit on `main` is tested to the end. Neither `ci.yml` nor `ui-tests.yml` has a paths filter: they produce required checks, and a required check that never runs blocks a pull request. To rerun a failed shard locally, take its number from the job name: `cd server && npx vitest run --shard=2/3` (with `--coverage` for a Node 24 shard). Woodpecker CI runs the same checks without shards ([WOODPECKER.md](WOODPECKER.md)).

### Environment variables in server tests

The server validates its `SM_*` variables once, when `server/src/config.ts` is loaded ([CONFIGURATION.md](CONFIGURATION.md)). Set them in `process.env` before the test server starts (`startTestServer` imports the configuration). To change one while the server runs, use `await setEnv({ SM_API_RATE_LIMIT: '3' })` from `server/test/helpers.ts` (`undefined` removes it): it sets the variable and calls `reloadConfig()`, which re-reads the environment into the same `env` object. `overrideConfig({ … })` sets single, already typed values. Values derived once at start (port, data directory, database, base path, session lifetimes) keep their start-up value.

### Running the UI tests

```bash
npm install
npx playwright install chromium     # once (skip if browsers are preinstalled, e.g. PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers)
npm run build                        # the tests use the built UI in web/dist
npm run test:ui                      # all tests, headless
npx playwright test --ui             # interactive runner: pick tests, watch, time-travel through steps
npx playwright test e2e/auth.spec.ts --headed   # one file, visible browser
npx playwright test -g "four-eyes"   # by test name
npx playwright show-report           # HTML report of the last run (playwright-report/)
```

How it works:

- `e2e/global-setup.ts` starts one demo server (`SM_DEMO=1`) on a free port with a fresh temporary data directory. It creates the admin `admin` / `Admin-password-1`, loads the demo data with its service half (`POST /api/demo/setup` with `{ "services": true }`: services, documents, credential entries, duties, a maintenance window, a status page – the server tests load the demo without it and get an empty catalogue), waits for the first feeder runs, and stores a signed-in session for `admin`, `dana`, `olivia`, `adam`, `audrey` and `vera` in `e2e/.auth/`. The server log is written to `e2e/.auth/server.log`. The server is stopped and its data deleted at the end; set `SM_E2E_KEEP_DATA=1` to keep the data.
- Projects: **desktop** (Chromium 1440×900) runs everything except tests tagged `@mobile`. **mobile** (390×844, touch) runs only the `@mobile` tests.
- Every test fails when the page logs a console error or throws an uncaught error. Known harmless messages are listed with a reason in `BENIGN_CONSOLE` in `e2e/support/fixtures.ts`.
- Tests create their own data with unique names and run in parallel (4 workers locally, 2 in CI). Other knobs: `SM_E2E_WORKERS`, `SM_E2E_PORT`, and `SM_E2E_SERVER=dist`, which starts the test servers from the compiled server (`server/dist`, built by `npm run build`) – what the container image runs – instead of the TypeScript sources.
- **Under a path prefix:** `E2E_BASE_PATH=/steward npm run test:ui` runs the whole suite with Steward under `/steward` (`SM_BASE_PATH`) behind a small reverse proxy (`scripts/reverse-proxy.mjs`: passes the path on, sets `X-Forwarded-For/-Proto/-Host`; `E2E_PROXY_PROTO=https` sends `https`). Write app paths as at the root – `page.goto('/runs')`, `request.get('/api/runs')`: `e2e/support/basePath.ts` puts the base path in front of what the tests pass in, never in front of what the app requests. Compare links the app renders with `appHref('/runs')` from `e2e/support/env.ts`, and build storage states with `origin()` (an origin has no path). CI runs both variants (`.github/workflows/ui-tests.yml`).
- On CI there is one retry, a trace is recorded on the first retry, and screenshots are taken on failure. The workflow uploads `playwright-report/`, `test-results/` and the server log when something fails. Open a trace with `npx playwright show-trace test-results/<test>/trace.zip`.
- Accessibility: `e2e/accessibility.spec.ts` runs axe (WCAG 2.1 A/AA) on the main pages in light and dark mode, and on dialogs, open menus (light and dark, with a red item hovered), the run page with an open task, and the sign-in page. It fails on _serious_ or _critical_ violations. If a violation cannot be fixed right away, add the rule id with a reason to `KNOWN_ISSUES` in that file and list it below.

**Accessibility, known gaps.** No rule is disabled at the moment. axe does not catch everything, so check these by hand:

- Process cards, platform cards and dashboard cards are clickable areas, not links. With the keyboard, use the command palette (Ctrl+K) or the card's buttons instead.
- The flow canvas (React Flow) can only be edited with a mouse. The _Source_ tab (YAML) is the keyboard alternative.
- Plain scrolling tables (`.table-scroll`) are only made focusable on dashboards. On narrow screens other wide tables scroll but cannot be focused.

### Adding a UI test

```ts
// e2e/my-feature.spec.ts
import { test, expect } from './support/fixtures'; // console-error guard, loginAs, apiAs
import { authFile } from './support/env';
import { uniq } from './support/helpers';

test.use({ storageState: authFile('olivia') }); // signed in as the operator

test('operator can rename her schedule', async ({ page, loginAs }) => {
  const name = uniq('My schedule'); // unique → parallel-safe
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'New schedule' }).click();
  // … prefer roles, labels and visible text over CSS selectors
  const adam = await loginAs('adam'); // a second user in their own browser context
  await adam.goto('/tasks');
  await expect(adam.getByRole('heading', { name: 'My tasks', level: 2 })).toBeVisible();
});
```

Rules of thumb:

- Use roles and labels for selectors. If an important control has no accessible name, add an `aria-label` in `web/src`; this helps screen-reader users too.
- Do not sign out with a shared stored session, because that would end it for all other tests. Sign in yourself in a fresh context instead (see `auth.spec.ts`).
- Tests that change installation-wide state (e.g. the theme) start their own empty server with `startIsolatedServer()` from `e2e/support/server.ts` instead of using the shared demo server (see `theme.spec.ts`, which also runs axe with a bright yellow primary colour in light and dark mode).
- Do not match the product name literally. Import `BRAND` from `shared/src/brand.ts` if you need it.
- Read-only checks of server state are faster through `apiAs('<user>')` than through the UI.
- Put "real" writes on data that only your test uses. For example, the real-run test flags users into the empty demo group `mdsp_usergroup:LegacyProjects`.

### Upgrade tests

People keep their data across releases, so every supported upgrade path is tested. `server/test/fixtures/upgrade/<version>/` holds a data folder written by a released version, made by its own code: `datadir/` (the SQLite database, `vault.json`, `audit-anchor.json`, record attachments, the PDF report and the evidence pack) and `manifest.json` (passphrase, ids and counts the test expects). `server/test/upgrade.test.ts` copies each fixture, starts the current version on it and checks that the migrations ran, the vault unlocks with the fixture passphrase, the old data comes back from the API, the audit hash chain and the signed checkpoints still verify, the run that waited for an approval finishes after the approval, attachments and the report download, and the evidence pack still verifies. With `SM_TEST_DATABASE_URL` (`npm run test:pg`) it runs the same upgrade on PostgreSQL itself: it brings a PostgreSQL schema to exactly the fixture's version (the core and named migrations the fixture's database lists, `Db` option `upTo`), copies the fixture's rows into it as they are (`copyDatabase` with `asIs`), and starts the current version on it – so the PostgreSQL migrations, with their own data-moving SQL, run on the old version's data, after the automatic `pg_dump`. This relies on one rule: **a migration never changes once it is released** (fix a released migration with a new one). The test checks that rule for every fixture on SQLite, where the fixture is what the old version really wrote: today's migrations, replayed to the fixture's version, must give exactly the fixture's schema.

After the upgrade, on both databases, the schema must equal the schema of a new installation (`server/test/schema-snapshot.ts`: tables, columns with type, `NOT NULL`, default and collation, primary and unique keys, foreign keys, `CHECK`s, indexes, triggers and trigger functions, normalised). An intentional difference goes into `SCHEMA_DIFFERENCES_ALLOWED` in the test, with its reason; the list is empty. Columns are compared by name, not position: an old installation ran migrations of different modules in another order than a new one, so `SELECT *` and `INSERT` without a column list are not safe in Steward's code.

`server/test/upgrade-backup.test.ts` covers the automatic copy before migrating (SQLite file and `pg_dump`, a failing copy, `SM_UPGRADE_BACKUP_REQUIRED=0`) and the `system.upgraded` audit entry.

The fixtures are test data only: their vault and keys are protected by the published passphrase `steward-upgrade-fixture` (see the [fixture README](../server/test/fixtures/upgrade/README.md)).

**Add a fixture for every minor release** (v0.2.0, v0.3.0, …), right after tagging it:

```bash
git worktree add --detach ../steward-v0.2.0 v0.2.0
(cd ../steward-v0.2.0 && npm ci --ignore-scripts)
node scripts/fixtures/make-upgrade-fixture.mjs --app ../steward-v0.2.0 --out server/test/fixtures/upgrade/v0.2.0
git worktree remove ../steward-v0.2.0
npm test -- test/upgrade.test.ts
```

The script starts the release in demo mode on a fresh data folder (SQLite), sets it up with the test passphrase and creates the content through the API, stops it cleanly and copies only what an installation keeps (no logs, no instance file; the database is compacted). Keep a fixture below about 3 MB. If a release changed an API the script uses, adapt the script in a way that still works for the older releases, or note the release it needs in the script. Keep the old fixtures: each one is an upgrade path that must keep working. Add the new version to the list in the fixture README.

## 2. Manual test scenarios per role (demo)

Start the demo with `npm run demo`, set it up, then click **Load demo platforms & processes**. Every demo user has the password `Demo-password-1`. Use separate browser profiles or private windows to be signed in as several people at once.

**Designer (dana)**

- [ ] Processes → _From template_ → "Platform health check" → rename it in Settings → Save (with a comment) → v2.
- [ ] Add a node from the palette, wire it, undo/redo (Ctrl+Z / Ctrl+Shift+Z), copy/paste a node into another process.
- [ ] In a text field, type `{{ vars.`: suggestions appear. After a dry run, the live preview shows real values. The _Last run_ tab shows the input and output of each node.
- [ ] Versions tab: compare v1 ↔ v2; restore an old version as the working copy.
- [ ] Export YAML, change the name, _Import YAML_; Source tab: paste the compact `steps:` format → _Apply to editor_.
- [ ] Introduce a validation error (e.g. delete a required field): the issue badge appears and saving is refused.

**Operator (olivia)**

- [ ] Run "Access review 1" as a dry run: the protocol lists the simulated writes ("Simulated" counter).
- [ ] Run it for real (switch _Dry run_ off): the orange warning is shown, and after the decision "Changes made" equals the number of selected users.
- [ ] Create a schedule (preset chip, time zone), _Run now_, disable it, delete it.
- [ ] Ctrl+K: find a process, start a run from the palette, open a recent run.
- [ ] Platforms: may use the explorer read-only (GET/HEAD only), cannot see the settings/credentials forms.

**Approver (adam)**

- [ ] Bell shows "Decision needed …"; _My tasks_ lists it; filter, untick, comment, submit.
- [ ] Privileged access review (four-eyes): olivia attests, adam confirms the removal; olivia sees "Waiting for someone else".
- [ ] Reject an approval: the run follows the `rejected` branch or fails as designed.

**Auditor (audrey)**

- [ ] Audit log: filter _Decisions_, find who decided what; _Verify chain_ → "Audit chain intact".
- [ ] Open a run → Run report → HTML/PDF/JSON; the protocol shows "intact". Export the audit log (CSV/JSONL).
- [ ] Cannot start runs or change anything (no Run/Save buttons; the API answers 403).

**Viewer (vera)**

- [ ] Sees processes, runs and dashboards; no _New process_, _Run_, _Users & teams_, _Audit log_; `/users` shows "Page not found".

**Admin**

- [ ] Users & teams: create a user (temporary password → forced change at first sign-in), roles, team, deactivate (sign-in refused), reset password.
- [ ] Access lists: restrict a process to `team:Service Desk`; check that dana loses edit rights, and that a platform restricted to a team cannot be bound by others.
- [ ] Settings: retention, _Clean up now_, notification channels (_Send test_ for SMTP/Teams/webhook), routing table, SSO-only mode (admins keep password sign-in).
- [ ] SSO: demo "Microsoft Entra ID (simulated)": sign in as Max Admin, Oskar Operator, Nina Nobody (rejected: no mapping).
- [ ] Lock the vault from the user menu: everyone sees the waiting page, schedules stop; unlock.

## 3. Sandbox tenant test plan (Insights Hub and Industrial Edge)

Do this on a **test tenant / test IEM** before any production use.

1. **Read-only credential first.** Create a technical user or service credential with read rights only (Insights Hub: `im.usr.r`/`im.g.r` and asset/time-series read; IEM: a viewer account). Add the platform, import the official OpenAPI specs from the Siemens developer portal, and set the platform variables (`idmPath`, `assetPath`, `tsPath` for the `api.<region>.siemens.app` gateway).
2. **Test connection** and run the **contract check** (`npm run contract …`). Fix variables or specs until all GET operations pass. Save the output as a baseline and repeat it after Siemens API updates.
3. **Dry runs only.** Run every template you plan to use as a dry run. In the run page check:
   - _Steps_: request URL, status, page count of paginated calls, duration;
   - _List all users_ output: is `lastLogonTime` present? Do the IEM field names (`connectionState`, `lastSeen`, `firmware`) match?
   - _Simulated_ counter and the simulated requests in the protocol: are they exactly the writes you expect?
4. **Compare with the portal.** Check the numbers by hand: user count and inactive users (Identity Management UI or `mdsp` CLI), group members, asset counts and attributes per type (Asset Manager attribute calculator), online/offline devices in IEM. Any difference has to be explained before you go on.
5. **Writes on test objects only, with approvals.** Create test users and groups (e.g. `zz-sm-test-*`) and use the exempt-list input to protect real accounts. Grant write rights to a separate credential, keep the approval/four-eyes steps on, and run onboarding → access review 1 → 2 → offboarding on the test users.
6. **Verify the evidence.** Check that the protocol lists every write call with its status, the decisions (who, when, comment) and checks. In the audit log, every `api.*` write is attributed to the right person, and _Verify chain_ is OK. Download the PDF protocol and check the fingerprint shows "intact".
7. **Restore.** Remove the test users and groups (offboarding template or portal) and check that nothing else changed (group member counts back to baseline).
8. **Schedules.** Schedule the read-only feeders against the sandbox for a few days and watch dashboard freshness, notification noise and run durations.

## 4. Resilience tests

- **Crash during a waiting run.** Start "Access review 1", wait for the decision, kill the process (`kill -9` / Task Manager), and start it again with `SM_MASTER_PASSPHRASE` set. The run must still wait for the same task, and after the decision finished steps must not run again: the list call must not repeat (see `server/test/restart.test.ts`). The audit log shows `run.resumed`.
- **Vault locked after restart.** Restart _without_ `SM_MASTER_PASSPHRASE_FILE`. Users see "Waiting for an administrator", `/api/ready` answers HTTP 503 with "Vault is locked", schedules do not fire, and nothing runs until an admin unlocks. Then schedules resume.
- **Interrupted runs.** Kill the server during a running (not waiting) step. After restart the run is _interrupted_; _Resume_ continues, _Cancel_ ends it.
- **Network/proxy failures.** Point a platform at an unreachable host, at a proxy that refuses the connection (`HTTPS_PROXY` / per-platform proxy), and at a self-signed certificate with and without _accept self-signed_. You should get clear errors in the step, no hanging runs, and the `error` output fires where wired.
- **429 / 5xx retries.** In demo mode, `/mock/test/flaky?key=<k>&fail=2&status=429&retryAfter=1` fails the first _n_ calls per key (`status` and `retryAfter=none` are configurable). `/mock/test/flaky/calls?key=<k>` shows how many calls arrived, and `/mock/test/delay?ms=…` simulates slow APIs. Add an HTTP node with that URL (absolute URL) and check that it retries with backoff, honours `Retry-After`, gives up after the configured attempts, and does not retry POST unless `retryNonIdempotent` is set.
- **Clock and time zone.** Create schedules in `Europe/Berlin` and `UTC` around a DST change (`0 2 * * *` on the last Sunday of March/October). Check the "Next:" preview, the next-run column and the actual start time. Change the machine time zone and restart: schedules keep their own zone. Overlapping runs: a schedule must skip while its previous run waits for a decision (unless _Allow overlap_), and the skip appears in notifications and the audit log.

## 5. Security checks

- **Roles and ACLs.** For each role, try the forbidden actions through the API, not only the UI. `server/test/rbac.test.ts` and `e2e/auth.spec.ts` cover the basics. Check process and platform access lists, schedules of a user who lost rights (skipped and audited), and deactivated users (sessions and tokens stop working).
- **Tokens.** A read-only token gets 403 on writes; a revoked or expired token gets 401; a token of a deactivated user stops working. Tokens are shown once and stored hashed (`e2e/profile-tokens.spec.ts`).
- **CSRF.** Every non-GET request without `x-sm-client: 1` is rejected (403) unless it uses only a bearer token. Cookies are `HttpOnly; SameSite=Strict` (`Secure` with TLS).
- **Host allow-list.** Requests with a foreign `Host` header get 403 (DNS rebinding); check `SM_ALLOWED_HOSTS` when serving colleagues.
- **Secrets never leak.** Grep the logs (stdout JSON), protocols (HTML/PDF/JSON), audit export and browser responses for a known secret value. `$secret()` values must appear as `***`. The platform API returns secret _names_ only.
- **Audit integrity.** `GET /api/audit/verify` must return `ok: true`. Edit one row in the database by hand on a copy: verify must report the break (`?full=true` for a row before the newest signed checkpoint).
- **Headers.** Every page has `content-security-policy` (no inline scripts), `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer` (`e2e/security.spec.ts`).
- **Dependencies.** `npm audit --omit=dev` (runs in CI); review the SBOM of each release.

## 6. Performance and volume

- **Large tenants.** Use a sandbox with thousands of users/assets, or extend the mock. Check pagination page sizes (`pageSize` 100–500), _For each_ with `parallel` (e.g. 4–8) and `delayMs` against rate limits, `maxItems` safety limits, and task tables with >1,000 rows (filter, "showing the first 1000").
- **Long-running schedules.** Let hourly feeders run for a week and watch run duration, memory of the server process, `/api/metrics` (run counts, durations, HTTP errors) and dashboard staleness.
- **Database size and retention.** Settings → Data retention shows database and evidence size. Set _Keep runs_ (e.g. 180 days) and check _Clean up now_. The audit log is never pruned, so estimate its growth (entries per day × size). On PostgreSQL, watch table sizes and vacuum.
- **UI.** Open dashboards with many widgets and long tables on a slow laptop. The run page polls while active and the editor should stay responsive with 100+ nodes.

## 7. Packaging

- **Desktop executable on a locked-down laptop.** Build or download the binary and run `steward --version`, then `--no-open --port 4399 --data-dir <tmp>` and `curl http://127.0.0.1:4399/api/health`. The release workflow does this automatically. Then check by hand on a corporate device:
  - the SmartScreen / Gatekeeper prompt, or none when signed;
  - start without admin rights and the data folder location;
  - the corporate proxy (`HTTPS_PROXY`/`NO_PROXY`) and the corporate CA;
  - `--autostart on`, then sign out and in: the app runs in the background and schedules fire;
  - a second start only opens the window.
- **PWA.** In Edge/Chrome _Install app_ works, and the app window, the shortcuts (Tasks, Dashboards, Runs) and browser notifications work. After an update the new version loads (service worker).
- **Docker.** `docker compose up -d`: the volume persists across `docker compose down/up`, `/api/ready` works as a health check, `SM_MASTER_PASSPHRASE_FILE` points at a Docker secret, the image with `WITH_BROWSER=1` can run browser steps, and the image runs behind your reverse proxy with `SM_PUBLIC_URL`/`SM_ALLOWED_HOSTS`.

## 8. Go-live checklist

- [ ] **Backups** of the data directory (or the PostgreSQL database), tested by restoring them on another machine.
- [ ] **Master passphrase** in the company password manager. Two people know where it is. For unattended start it comes from a file or secret (`SM_MASTER_PASSPHRASE_FILE`), not a script or environment variable.
- [ ] **SSO** configured and tested for each role mapping; password sign-in limited to admins (_SSO only_); at least one local break-glass admin.
- [ ] **Least-privilege credentials** per platform: read-only credential for feeders and dashboards, a separate write credential only where needed, platform access lists for production tenants.
- [ ] **Schedules** owned by a service-desk account (not a personal one), with sensible time zones and _Allow overlap_ off for processes with decisions.
- [ ] **Approvals**: four-eyes and assignees on all destructive steps; dry run done for every process on the sandbox.
- [ ] **Notifications** tested end to end (_Send test_ for e-mail/Teams/webhook; a real task reaches the approver).
- [ ] **Retention** set for runs and notifications; disk space monitored.
- [ ] **Monitoring**: `/api/ready` in your health checks; `/api/metrics` scraped (with an API token or `SM_METRICS_PUBLIC=1` on a private network); alerts on failed runs/checks.
- [ ] **TLS** (`SM_TLS_CERT`/`SM_TLS_KEY` or a reverse proxy) when colleagues connect over the network.
- [ ] **Contract check** baseline recorded; re-run after each Siemens release note.
