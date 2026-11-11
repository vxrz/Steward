---
name: review-checklist
description: Use when reviewing a diff or a pull request of this repository – your own before opening a pull request, or someone else's. Checks the change against the issue's acceptance criteria and the repository rules and reports findings with file and line, each marked blocking or minor.
---

# Review checklist

Read the issue (built-in GitHub tools, not `gh`), then the full diff (`git diff main...HEAD`, or the pull request's files) and the code around it.

Check:

1. **Acceptance criteria:** every criterion of the issue is met; nothing the issue did not ask for.
2. **Tests:** new or changed behaviour is covered (`server/test/`, `e2e/` for UI); tests are independent and use the mock platforms; both SQLite and PostgreSQL are considered when SQL or migrations change.
3. **No unrelated edits:** no drive-by refactors, reformatting of untouched code or changes to `.claude/`, `AGENTS.md` or `CLAUDE.md` unless asked.
4. **No secrets or private details:** no credentials, tokens, personal data, real company names, internal hostnames or IP addresses in code, tests, docs, examples or screenshots.
5. **No generated or build files committed** (`web/dist`, `server/dist`, coverage, test results) – except the generated files the repository tracks on purpose (`docs/openapi.json`, `docs/CONFIGURATION.md`, `web/src/i18n/keys.gen.ts`), which must match their source.
6. **Docs:** docs of the area and the **Unreleased** entry in `CHANGELOG.md` updated when behaviour changed; a decision record under `docs/adr/` for a changed decision.
7. **Repository rules** (`AGENTS.md`): migrations additive and appended; English and German texts for new UI texts and error codes; access declared on routes, step-up and audit for anything that widens access; team scope (hidden items neither listed nor counted nor named); Conventional Commits title.
8. **Checks:** the checks in `AGENTS.md` pass (run them, or confirm from CI).

Output: a list of findings, each as

- `path:line` – what is wrong, why it matters, the suggested fix – **blocking** or **minor**

Blocking: an unmet criterion, a bug, a security or privacy problem, a missing test for new behaviour, a failing check. Minor: wording, naming, style. End with a one-line verdict. If there are no findings, say so explicitly.
