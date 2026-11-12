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

## Parallel work rules

Several agents and people work on this repository at the same time. These rules keep their work from colliding.

### Scope

- One issue, one branch, one agent, one pull request.
- Do only what the issue asks. Unrelated problems you notice go into a new issue (`plan-issues` skill), not into this pull request.
- If the issue is unclear or too big for one session, stop and comment on the issue. Do not guess.

### Claiming work

- Before starting, check that the issue has no open pull request and no `in progress` label. Then add the `in progress` label.
- Never work on an issue another agent or person has claimed.

### Branches and worktrees

- Branch from the latest `main`: `task/<issue-number>`.
- Never commit to `main`. Never force-push.
- Local parallel work: one worktree per branch under `../steward-wt/<issue-number>` (`git worktree add ../steward-wt/<issue-number> -b task/<issue-number> origin/main`). Never switch branches inside a worktree someone else uses.
- Rebase on `main` before you first push. Once the branch is pushed, bring in `main` with a merge instead (no force-push). If either conflicts in files outside your issue's scope, stop and report instead of resolving.

### Shared files

- These cause conflicts, so change them only when the issue requires it: `package-lock.json` and the `package.json` files, CI configuration (`.github/`), `AGENTS.md`, `CLAUDE.md`, `.claude/`, migrations (`server/src/migrations/`), the migration table list (`server/src/migration/tables.ts`).
- Generated files – `docs/openapi.json`, `docs/CONFIGURATION.md`, `web/src/i18n/keys.gen.ts` – are regenerated with their command (`npm run openapi`, `npm run config:docs`, `npm run i18n:types`), never merged by hand.
- `CHANGELOG.md`: add your entry under **Unreleased** in its section; do not reorder or reword other entries.
- A new migration goes at the end of its list; if another pull request added one first, move yours after it when you bring in `main`.
- Never reformat files you are not changing.
- New dependencies need a line of justification in the pull request.

### Tests

- There is no single check command: the checks listed under _Checks_ above must pass before any pull request.
- New behaviour needs a test. A bug fix needs a test that failed before the fix.
- Never delete, skip or weaken a test to get green. If a test looks wrong, say so in the pull request.

### Commits and pull requests

- Small commits with Conventional Commits messages.
- Pull request description (`.github/pull_request_template.md`): the issue link (`Closes #<issue-number>`), what changed, how it was tested, anything left open.
- Keep pull requests under about 400 changed lines, not counting generated files, translation files and test fixtures. Larger means the issue should have been split.

### Review

- Every pull request is reviewed by an agent or person that did not write it (the `reviewer` agent, the `review-checklist` skill, or the maintainer).
- Reviewers report findings; they do not push fixes to the author's branch.
- Blocking findings are fixed in the same pull request.

### When to stop

Stop when the checks fail twice after real attempts, when the task needs a decision that is not in the issue, or when you would need to touch files of another open pull request. Then comment on the issue (what you tried, what blocks you) and remove the `in progress` label.

The agents are defined in `.claude/agents/`, the project skills (`task-runner`, `handoff`, `review-checklist`, `plan-issues`) in `.claude/skills/`.
