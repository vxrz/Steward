---
name: plan-issues
description: Use when asked to plan a feature, break down work, or turn a decision record or roadmap item into tasks. Produces GitHub issues small enough for one session, each with acceptance criteria, exactly one tier label and its dependencies. Does not write code.
---

# Plan work as GitHub issues

Do not write code. The plan lives in GitHub Issues, not in a file.

1. **Understand the goal:** read the request, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` and any decision record under `docs/adr/` it touches. Use the `explorer` agent to see what exists. If the work needs a decision first, the first issue is that decision record (`tier:frontier`).
2. **Check for duplicates:** search open and closed issues first (built-in GitHub tools, not `gh issue`).
3. **Split** the work into issues small enough for one session each: one behaviour or one change that can be tested on its own, with its tests and docs.
4. **Write each issue** with:
   - a title that says the outcome;
   - **Context:** why, with links to the decision record or roadmap item;
   - **Acceptance criteria:** a checklist of observable results, including tests and docs;
   - **Out of scope:** what this issue does not do;
   - **Depends on:** the issues that must be done first (`#123`), or "none".
5. **Exactly one tier label** per issue:
   - `tier:bulk` – mechanical: tests for existing code, docs, renames, formatting;
   - `tier:mid` – a well-specified feature or fix with clear criteria;
   - `tier:frontier` – design decisions, security-relevant or cross-cutting work, migrations with risk, or unclear requirements.
6. **Report** the list of issues in order, with their dependencies, so they can be worked one per session.

No secrets, credentials, personal data or internal hostnames in issues.
