---
name: task-runner
description: Use when asked to work on a GitHub issue of this repository ("work on #123", "pick up issue …", "implement the issue"). Covers reading the issue, the branch, routing by tier label, implementing, checks, review and the pull request.
argument-hint: '[issue-number]'
---

# Work on one GitHub issue

One issue per session. Do not start a second one.

1. **Read** the issue (with the built-in GitHub tools, not `gh issue`), its acceptance criteria and comments, then `AGENTS.md` and `docs/ARCHITECTURE.md`. Use the `explorer` agent to find the code involved.
2. **Claim and branch** (see _Parallel work rules_ in `AGENTS.md`): stop if the issue has an open pull request or the `in progress` label; otherwise add the `in progress` label. Create `task/<issue-number>` from the latest `main` – for local parallel work in its own worktree under `../steward-wt/<issue-number>`.
3. **Route by the tier label** (see _Task routing_ in `AGENTS.md`):
   - `tier:bulk` → delegate to the `bulk-runner` agent;
   - `tier:mid` → delegate to the `implementer` agent;
   - `tier:frontier` → do it in this session;
   - no tier label → ask before starting.
4. **Implement only what the issue asks.** No unrelated edits; problems you notice go into a new issue. Change shared files (lockfiles, CI, migrations, `AGENTS.md`, `.claude/`) only when the issue requires it. Tests for new behaviour, docs of the area, and an **Unreleased** entry in `CHANGELOG.md` for user-visible changes.
5. **Checks:** there is no single check command. Run the checks listed in `AGENTS.md` (typecheck, lint, format:check, check:imports, test, plus the extra checks that apply) until they all pass. If a subagent fails them twice, stop and escalate one tier up; say so in the pull request.
6. **Review:** run the `reviewer` agent on the diff. Fix every blocking finding and run the checks again.
7. **Pull request** (built-in GitHub tools, not `gh pr`):
   - title in Conventional Commits form (it becomes the squash commit);
   - body following `.github/pull_request_template.md`, with `Closes #<issue-number>`;
   - say which tier did the work and whether it was escalated;
   - list the checks you ran and their results.
8. Finish with the `handoff` skill. If you stop early (checks fail twice, a decision is missing, another pull request's files would be touched): comment on the issue and remove the `in progress` label.

Never put secrets, credentials, personal data or internal hostnames in code, commits, the pull request or comments.
