---
name: handoff
description: Use when a task is finished or a session is ending, to leave what was learned in the repository and on the issue instead of only in the session – architecture notes, decision records and a status comment on the issue.
---

# Hand off a task

Never leave knowledge only in the session. Before you stop:

1. **Architecture:** update `docs/ARCHITECTURE.md` only if the architecture changed (a new module, a new boundary, a changed data flow, a new import rule). Keep it short and factual.
2. **Decisions:** for any non-obvious choice (an option rejected for a reason, a trade-off, a rule others must follow) add a short decision record under `docs/adr/` – this repository's decision records – using `docs/adr/template.md` and the next free number, and add it to the table in `docs/adr/README.md`. A change to an accepted decision gets a new record; the old one is not rewritten.
3. **Docs and changelog:** check that the docs of the area and the **Unreleased** section of `CHANGELOG.md` say what changed for users.
4. **Issue comment** (built-in GitHub tools, not `gh issue`), on the issue you worked on:
   - **Done:** what was implemented, with the pull request and the main files.
   - **Left:** what is not done yet, as concrete next steps (or "nothing").
   - **Open questions:** decisions the maintainer has to take, each with your recommendation.
5. **Label:** remove the `in progress` label once the pull request is open or when you stop without one.
6. If work is left that does not fit this issue, propose a new issue with acceptance criteria and a tier label (see the `plan-issues` skill) instead of extending this one.

No secrets, credentials, personal data or internal hostnames in records or comments.
