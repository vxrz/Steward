# AGENTS.md

Instructions for coding agents (and the people who run them) working on Steward. Humans: [CONTRIBUTING.md](CONTRIBUTING.md) has the same rules in more detail.

## Where things are

- **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – C4 diagrams, the module map of `server/src`, import rules. Read it before changing code.
- **Decisions:** [docs/adr/](docs/adr/README.md) – short architecture decision records. A change that alters one gets a new record (`docs/adr/template.md`).
- **Plan:** GitHub Issues. One issue per task, with acceptance criteria and one tier label (see _Task routing_). There is no plan file in the repository.
- **Shipped changes:** [CHANGELOG.md](CHANGELOG.md); direction: [docs/ROADMAP.md](docs/ROADMAP.md).
- **Layout:** `shared/` (process model, API types), `server/` (Fastify API, engine, platforms, auth, audit, migrations), `web/` (React + Mantine), `e2e/` (Playwright), `examples/`, `docs/`, `scripts/`.

## Setup

Node.js 24 (`.nvmrc`; 26 is also supported). `npm install`, then `npm run dev:demo` for a demo with simulated platforms. UI tests need Chromium (`npx playwright install chromium`).

## Checks

There is no single check command. Run these before you push (all must pass; CI runs them too):

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:imports
npm test
```

When relevant, also: `npm run test:pg` (SQL or migrations; needs `SM_TEST_DATABASE_URL`), `npm run build && npm run test:ui` (UI changes), `npm run i18n:check` and `npm run i18n:literals` (texts), `npm run openapi -- --check` (API), `npm run config:docs -- --check` (configuration), `npm run validate` (examples). The full table is in [CONTRIBUTING.md](CONTRIBUTING.md#checks-to-run-before-you-push).

## Rules

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) (`feat(scope): …`, `fix(scope): …`). A pull request is squash-merged; its title becomes the commit.
- **Changelog:** user-visible changes get an entry under **Unreleased** in `CHANGELOG.md`.
- **Migrations** are additive and appended to the end of their list; never edit an existing one. Classify new tables and columns in `server/src/migration/tables.ts`. Both SQLite and PostgreSQL must work.
- **Texts:** English and German in `web/src/locales/<lang>/`; English first, British spelling, sentence case; German uses the formal "Sie" ([docs/I18N.md](docs/I18N.md)). Every new error code needs both texts.
- **Access:** routes declare their access on the route; anything that widens access needs a step-up and an access-change audit entry; team scope means a reader never sees, counts or is told about items they may not see.
- **Tests:** new behaviour comes with tests (`server/test/`, `e2e/`), using the mock platforms in `server/src/mock/`, never real tenants.
- **Public repository:** no secrets, credentials, personal data, real company names, internal hostnames or IP addresses – in code, tests, docs, examples, issues or screenshots. Use invented names (`*.example`, "Invented … AG").
- **Dependencies:** only releases at least 14 days old; no new dependency without a reason in the pull request.
- Do not change files under `.claude/`, `AGENTS.md` or `CLAUDE.md` unless the issue asks for it.

## Task routing

- Issues carry one label: `tier:frontier`, `tier:mid` or `tier:bulk`.
- `tier:bulk` → delegate to the `bulk-runner` agent.
- `tier:mid` → delegate to the `implementer` agent.
- `tier:frontier` → the main session handles it.
- No tier label → ask before starting.
- Always use the `explorer` agent for codebase search instead of reading many files in the main session.
- After implementation, run the `reviewer` agent on the diff before opening the pull request.
- If a subagent fails the checks twice, stop and escalate one tier up. Say so in the pull request.
- One issue per session. Do not start a second.

The agents are defined in `.claude/agents/`, the project skills (`task-runner`, `handoff`, `review-checklist`, `plan-issues`) in `.claude/skills/`.
