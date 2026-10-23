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

| Command                            | What it checks                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                | TypeScript in all workspaces                                                                                                            |
| `npm run lint`                     | ESLint (`eslint.config.js`): no errors and no warnings. `npm run lint:fix` fixes what it can.                                           |
| `npm run format:check`             | Prettier formatting (`.prettierrc.json`). `npm run format` formats all files.                                                           |
| `npm test`                         | API, engine and integration tests (vitest, SQLite)                                                                                      |
| `npm run test:pg`                  | The same suite on PostgreSQL (`SM_TEST_DATABASE_URL`, see [docs/TESTING.md](docs/TESTING.md)). Needed when you touch SQL or migrations. |
| `npm run build && npm run test:ui` | Playwright browser tests, including accessibility (axe) checks                                                                          |
| `npm run validate`                 | Example processes and dashboards                                                                                                        |
| `npm run openapi -- --check`       | `docs/openapi.json` matches the API (run `npm run openapi` to regenerate)                                                               |
| `scripts/security/scan.sh`         | Optional: the security scanners CI runs (see [docs/SECURITY-PIPELINE.md](docs/SECURITY-PIPELINE.md))                                    |

CI runs all of these on every push and pull request: GitHub Actions (`.github/workflows/`), and Woodpecker CI (`.woodpecker/`) on a Forgejo mirror – see [docs/WOODPECKER.md](docs/WOODPECKER.md). A change to one CI system usually needs the same change in the other.

### Pre-commit hooks

`npm install` installs two git hooks (with [husky](https://typicode.github.io/husky/), in `.husky/`):

- **pre-commit:** Prettier and `eslint --fix` on the staged files ([lint-staged](https://github.com/lint-staged/lint-staged), `lint-staged.config.js`), then a [gitleaks](https://github.com/gitleaks/gitleaks) scan of the staged changes (`scripts/gitleaks-staged.sh`; skipped with a notice when gitleaks is not installed, see [docs/SECURITY-PIPELINE.md](docs/SECURITY-PIPELINE.md)).
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

### Code

- TypeScript strict mode. No `any` unless unavoidable and commented.
- Small, focused functions. Comments explain _why_, not _what_.
- **Security first:**
  - Never log, return or put secrets in error messages; use the existing redaction helpers.
  - Check permissions on the server for every route, through the helpers in `server/src/auth/permissions.ts`.
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
  - Build pages from the shared pieces in `web/src/components/common.tsx`: `PageHeader` (with `back` on detail pages), `EmptyState` and `QueryState` for lists, `StatusBadge`/`TONE` for status colours. A new page goes into a sidebar section in `web/src/components/AppNav.tsx`. Clickable cards and rows need a real link inside. See [docs/UX-REVIEW.md](docs/UX-REVIEW.md).
  - Put user-facing text in the translation files (`web/src/locales/<lang>/`), English first, and run `npm run i18n:check` and `npm run i18n:literals` (finds texts that do not go through `t()`). See [docs/I18N.md](docs/I18N.md).
  - Give every error a person can see a code and its details: `new HttpError(400, 'English message', 'CODE', { details })`, plus `errors:codes.CODE` in the locale files ([docs/I18N.md](docs/I18N.md#server-errors)). Format dates and numbers with `web/src/format.ts`.
- **CLIs** follow [clig.dev](https://clig.dev/): `--help`, exit codes 0/1/2, errors to stderr, `--json` for machine-readable output, respect `NO_COLOR`.
- **Dependencies:**
  - Add them only with a good reason. Prefer Node.js built-ins.
  - Pin to a minor range (`~x.y.z`) and pick releases that are at least a couple of weeks old.
  - Check `npm audit --omit=dev`. CI also runs OSV-Scanner and Trivy.
- **Docs:** plain English, short sentences, task-oriented.

### Tests

- New behaviour comes with tests:
  - server: `server/test/*.test.ts`, using `server/test/helpers.ts` to start a test server;
  - UI: `e2e/*.spec.ts`.
- Tests must be independent and parallel-safe: create your own data with unique names.
- Use the mock platforms (`server/src/mock/`) instead of real tenants.
- For an integration with an external system, add a mock and a contract or example test.

## Releasing (maintainers)

1. Move the **Unreleased** entries in `CHANGELOG.md` to a new version section and update `version` in the root `package.json` and `server/src/config.ts` ([Semantic Versioning](https://semver.org/)).
2. Commit: `chore(release): v0.2.0`.
3. Tag and push: `git tag -a v0.2.0 -m v0.2.0 && git push --tags`.
   - The **Release** workflow builds the desktop executables for Windows, macOS and Linux, smoke-tests them, adds SBOMs and checksums, and publishes a GitHub release.
   - A tag with a suffix (`v0.2.0-beta.1`) becomes a pre-release.
   - On the Forgejo mirror, Woodpecker pushes the container image to Harbor (`0.2.0`, `0.2`, `0`, `latest`), sends the SBOMs to Dependency-Track and builds the Linux executable (optionally as a Forgejo release); see [docs/WOODPECKER.md](docs/WOODPECKER.md#9-releases).

## Questions

Open a discussion or an issue. Questions and ideas are welcome.
