# Contributing to Steward

Thanks for helping! This guide covers how to set up the project, the conventions we follow and what a pull request needs before it can be merged.

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the project's licence (section 5 of the licence: inbound = outbound). Please only submit work you have the right to contribute. If your employer may own code you write, check with them first.

Security issues: **do not open a public issue**. Report them privately as described in [SECURITY.md](SECURITY.md).

## Getting started

Requirements:

- Node.js 24 (LTS), the primary version: `.nvmrc`, the container image and the desktop executable use it. Node.js 26 (Current) is supported and tested in CI too (`engines`: `^24.0.0 || ^26.0.0`). Never change V8 flags at runtime (`v8.setFlagsFromString` – undefined behaviour, ESLint refuses it).
- Git.
- For browser automation and the UI tests: Chromium via Playwright (`npx playwright install chromium`).
- Optional: PostgreSQL 16 or newer, to run the test suite on PostgreSQL.

```bash
git clone https://github.com/vxrz/steward.git && cd steward
npm install
npm run dev:demo      # API with auto-reload + UI with hot reload on http://127.0.0.1:5173, simulated platforms
```

On the first start, set a master passphrase and create an admin account. Then click **Load demo platforms & processes**.

## Project layout

The architecture – C4 diagrams, a module map of `server/src` and the decision records – is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). A change that alters one of the decisions in [docs/adr/](docs/adr/README.md) gets a new record.

| Folder      | What it contains                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`   | Process model and validation (zod), API types, branding, scrubbing helpers. Used by server and web.                                                                               |
| `server/`   | Fastify API, engine, platforms, auth, audit, scheduler, reports, triggers, public API v1, database drivers (SQLite/PostgreSQL), CLIs (`server/src/cli`), mocks for demo and tests |
| `web/`      | React + Mantine UI (Vite)                                                                                                                                                         |
| `e2e/`      | Playwright UI tests                                                                                                                                                               |
| `examples/` | Example processes and dashboards, validated in CI                                                                                                                                 |
| `docs/`     | User and operator documentation, generated `openapi.json`                                                                                                                         |
| `scripts/`  | Build of the desktop executable, test helpers, security tooling                                                                                                                   |

## Checks to run before you push

| Command                            | What it checks                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                | TypeScript in all workspaces                                                                                                                                                         |
| `npm run lint`                     | ESLint (`eslint.config.js`): no errors and no warnings. `npm run lint:fix` fixes what it can.                                                                                        |
| `npm run format:check`             | Prettier formatting (`.prettierrc.json`). `npm run format` formats all files.                                                                                                        |
| `npm test`                         | API, engine and integration tests (vitest, SQLite), several test files at once ([docs/TESTING.md](docs/TESTING.md#running-the-server-tests))                                         |
| `npm run test:coverage`            | The same suite with coverage (v8): a summary in the terminal, the HTML report in `server/coverage/`; fails below the minimums in `server/vitest.config.ts` (CI does this on Node 24) |
| `npm run test:pg`                  | The same suite on PostgreSQL (`SM_TEST_DATABASE_URL`, see [docs/TESTING.md](docs/TESTING.md)). Needed when you touch SQL or migrations.                                              |
| `npm run build && npm run test:ui` | Playwright browser tests, including accessibility (axe) checks                                                                                                                       |
| `npm run validate`                 | Example processes and dashboards                                                                                                                                                     |
| `npm run openapi -- --check`       | `docs/openapi.json` matches the API (run `npm run openapi` to regenerate)                                                                                                            |
| `npm run config:docs -- --check`   | The environment-variable reference `docs/CONFIGURATION.md` matches `server/src/config-schema.ts` (run `npm run config:docs`)                                                         |
| `scripts/security/scan.sh`         | Optional: the security scanners CI runs (see [docs/ci/SECURITY-PIPELINE.md](docs/ci/SECURITY-PIPELINE.md))                                                                           |

CI runs all of these on every pull request and every push to `main`: GitHub Actions (`.github/workflows/`), and Woodpecker CI (`.woodpecker/`) on a Forgejo mirror – see [docs/ci/WOODPECKER.md](docs/ci/WOODPECKER.md). A change to one CI system usually needs the same change in the other.

### Pre-commit hooks

`npm install` installs two git hooks (with [husky](https://typicode.github.io/husky/), in `.husky/`):

- **pre-commit:** Prettier and `eslint --fix` on the staged files ([lint-staged](https://github.com/lint-staged/lint-staged), `lint-staged.config.js`), then a [gitleaks](https://github.com/gitleaks/gitleaks) scan of the staged changes (`scripts/gitleaks-staged.sh`; skipped with a notice when gitleaks is not installed, see [docs/ci/SECURITY-PIPELINE.md](docs/ci/SECURITY-PIPELINE.md)).
- **commit-msg:** checks the message against Conventional Commits (`scripts/commit-msg.mjs`, see below). Merge commits, `Revert "…"` and `fixup!`/`squash!` commits pass.

In an emergency, skip them with `git commit --no-verify`; CI still runs lint, formatting and the secret scan. Your editor picks up the basics (UTF-8, LF, two-space indent) from `.editorconfig`.

## Conventions

### Commits: Conventional Commits

We use [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>): <summary in the imperative, lower case, no period>

<optional body: what and why, wrapped at ~100 characters>

<optional footer: BREAKING CHANGE: …, Refs #123>
```

| Type       | Use for                                               |
| ---------- | ----------------------------------------------------- |
| `feat`     | New functionality                                     |
| `fix`      | Bug fixes                                             |
| `perf`     | Performance improvements                              |
| `refactor` | Code changes that neither fix a bug nor add a feature |
| `style`    | Formatting only (no change in behaviour)              |
| `docs`     | Documentation                                         |
| `test`     | Tests                                                 |
| `build`    | Build system, dependencies                            |
| `ci`       | Workflows                                             |
| `chore`    | Other maintenance                                     |
| `revert`   | Reverting an earlier commit                           |

Common scopes: `engine`, `api`, `db`, `auth`, `reports`, `triggers`, `monitors`, `web`, `editor`, `i18n`, `security`, `examples`.

A breaking change gets a `!` after the type/scope (`feat(api)!: …`) and a `BREAKING CHANGE:` footer. Pull requests are **squash-merged**, so the PR title becomes the commit on `main` and must follow the same format.

### Branches and pull requests

- Branch from `main`, e.g. `feat/monitor-maintenance-windows` or `fix/report-page-break`.
- Keep a pull request focused on one topic; split unrelated changes.
- Describe what changed and why, and how you tested it. Add screenshots for UI changes (light and dark, desktop and phone width when layout changes).
- Update the docs and add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

### Changelog entries

[CHANGELOG.md](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): entries go under **Unreleased**, in the sections _Added_, _Changed_, _Deprecated_, _Removed_, _Fixed_ and _Security_.

- **One or two sentences per entry:** what changed for the person using or running Steward, and a link to the docs page with the details. How it works, limits and edge cases belong in the docs, not in the changelog.
- **No nested lists of implementation details.** If an entry needs more than two sentences, the docs page is missing something.
- **Check before updating:** anything an administrator has to know or do before updating – a new default, a migration that takes long, a setting that moves, a deprecated route, a changed permission – gets a short note that starts with **Check before updating:**, so it can be found at a glance.
- Write it for users: name the page or setting (_Settings → Backups_), not the function or table.

Example:

```markdown
### Changed

- **Backups** keep 14 copies by default instead of 30 ([BACKUPS.md](docs/BACKUPS.md#3-passphrase-schedule-retention)). **Check before updating:** an installation that relied on the old default keeps 30 only when it is set under _Settings → Backups_.
```

### Code

- TypeScript strict mode. No `any` unless unavoidable and commented.
- Small, focused functions. Comments explain _why_, not _what_.
- **Errors you catch and drop say why.** An empty `catch` block has a comment with a reason (`/* already gone */`, not `/* ignore */`), and so does `.catch(() => undefined)` (on the same line or the line above). If someone should see the failure, log it instead (`logger.debug` / `logger.warn`). ESLint checks this (`scripts/eslint/catch-reason.js`).
- **Configuration:** read environment variables from `env` in `server/src/config.ts`, never from `process.env`; a new variable goes into `server/src/config-schema.ts` (type, default, description) and `npm run config:docs` updates `docs/CONFIGURATION.md`.
- **Security first:**
  - Never log, return or put secrets in error messages; use the existing redaction helpers.
  - Check permissions on the server for every route. Who may reach a route at all goes into its config – `{ config: { access: ACCESS.admin } }`, `ACCESS.public`, `ACCESS.session` (no API tokens), `statusViewer` – and is checked before the body is read; rights on a given object are checked in the service with `me()`, `forbid()` and the helpers of `server/src/auth/permissions.ts`. Both live in [`server/src/auth/access.ts`](server/src/auth/access.ts); the route permission test (`server/test/route-matrix.test.ts`) compares the declarations with its table.
  - Validate all input with zod.
  - Platform credentials only go to the platform's own origins.
- **Database:**
  - SQL must work on SQLite and PostgreSQL: use `?` placeholders, `lower(x) LIKE lower(?)`, `db().jsonText()` for JSON fields, and quoted camelCase aliases.
  - Schema changes are named migrations in `server/src/migrations/`, registered in `server/src/db.ts`. Never edit an existing migration.
  - `server/test/db.test.ts` scans for SQLite-only SQL.
- **Audit:** every state change a user makes is audited with `audit()`.
- **UI:**
  - Use Mantine components, and make it work in light and dark mode, at 390 px width and with the keyboard.
  - Give icon buttons an `aria-label`.
  - Take TanStack Query keys from the factories in `web/src/queryKeys.ts` (`runKeys.detail(id)`, `platformKeys.all`), so a query and its invalidations use the same key; add a factory for a feature you touch that still writes its keys inline.
  - Build pages from the page templates in `web/src/components/page/`: `ListPage` for lists (title and main action, `search`, `filters` that fold on phones, `view` for the table/card switch of a `DataTable`, `empty` with `whoCanAct`) and `DetailPage`/`DetailHeader` for detail pages (breadcrumb `back`, `status` badges, `actions`, the `menu` of further actions with its `duplicate` slot, `tabs` with `LinkTabs`, `recent` for the command palette, and the save bar for forms that use `useSaveSection`). The pieces in `web/src/components/common.tsx` (`QueryState`, `StatusBadge`/`TONE` …) stay. A new page goes into one of the six areas in `web/src/components/AppNav.tsx`. Clickable cards and rows need a real link inside. See [docs/reviews/UX-REVIEW.md](docs/reviews/UX-REVIEW.md).
  - Put user-facing text in the translation files (`web/src/locales/<lang>/`), English first, and run `npm run i18n:check` and `npm run i18n:literals` (finds texts that do not go through `t()`). See [docs/I18N.md](docs/I18N.md).
  - Give every error a person can see a code and its details: `new HttpError(400, 'English message', 'CODE', { details })`, plus `errors:codes.CODE` in the locale files ([docs/I18N.md](docs/I18N.md#server-errors)). Format dates and numbers with `web/src/format.ts`.
- **CLIs** follow [clig.dev](https://clig.dev/): `--help`, exit codes 0/1/2, errors to stderr, `--json` for machine-readable output, respect `NO_COLOR`.
- **Dependencies:**
  - Add them only with a good reason. Prefer Node.js built-ins.
  - Pin to a minor range (`~x.y.z`) and pick releases that are at least a couple of weeks old.
  - Check `node scripts/security/npm-audit.mjs` (`npm audit --omit=dev` with the accepted risks from `osv-scanner.toml`). CI also runs OSV-Scanner and Trivy.
- **Docs:** plain English, short sentences, task-oriented.

### Tests

- New behaviour comes with tests:
  - server: `server/test/*.test.ts`, using `server/test/helpers.ts` to start a test server;
  - UI: `e2e/*.spec.ts`.
- Tests must be independent and parallel-safe: create your own data with unique names.
- Use the mock platforms (`server/src/mock/`) instead of real tenants.
- For an integration with an external system, add a mock and a contract or example test.

## Releasing (maintainers)

Which versions get fixes and how releases are tested: [docs/RELEASES.md](docs/RELEASES.md). Tag a release only from a commit on `main` whose CI run is green.

1. Move the **Unreleased** entries in `CHANGELOG.md` to a new version section and update `version` in the root `package.json` and `server/src/config.ts` ([Semantic Versioning](https://semver.org/)), and the image tag (`ghcr.io/vxrz/steward:<version>`, also in their comments) in `docker-compose.yml` and `docker-compose.postgres.yml` (a test checks that they match). The deployment docs write `<version>` and need no change.
2. Commit: `chore(release): v0.2.0` and open the release PR with the release template (`?template=release.md`): it carries the checklist and a short OWASP ASVS level 2 security self-review of what changed in the release.
3. Tag and push: `git tag -a v0.2.0 -m v0.2.0 && git push --tags`.
   - The **Release** workflow builds the desktop executables for Windows, macOS and Linux, smoke-tests them, adds SBOMs and checksums, and publishes a GitHub release.
   - A tag with a suffix (`v0.2.0-beta.1`) becomes a pre-release.
   - The **Container** workflow builds the image for linux/amd64 and linux/arm64 (with and without Chromium), scans it, and only then pushes the scanned images to `ghcr.io/vxrz/steward` (`0.2.0`, `0.2`, `latest`, and the same with `-browser`; a pre-release only gets its own tag), signs them with cosign and attests provenance and SBOMs. To try this before a release: _Actions → Container → Run workflow_ with _push_ (pushes only `test-<commit sha>`). Details: [docs/ci/SECURITY-PIPELINE.md](docs/ci/SECURITY-PIPELINE.md#publishing-to-ghcrio).
   - On the Forgejo mirror, Woodpecker pushes the container image to Harbor (`0.2.0`, `0.2`, `0`, `latest`), sends the SBOMs to Dependency-Track and builds the Linux executable (optionally as a Forgejo release); see [docs/ci/WOODPECKER.md](docs/ci/WOODPECKER.md#9-releases).

## Questions

Open a discussion or an issue. Questions and ideas are welcome.
