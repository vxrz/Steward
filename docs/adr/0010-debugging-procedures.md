# 0010. Debugging procedures: one node, step through, compare two runs

- **Status:** Accepted
- **Date:** 2026-11-07
- **Since:** 0.10.0 (#235), planned in steps (below); builds on ADR [0011](0011-engine-boundary.md)

## Context

When a procedure does the wrong thing, designers today edit it and start another full run, often more than once. They need three things: try one node with given data, walk through a run node by node, and see what changed between a good and a bad run. None of these may become a way around the rules a real run keeps.

What the code already offers:

- **Dry runs** (`runs.dry_run`). Reads are sent live; writes are skipped (`isMutating()`, the dry-run branch of `execHttp`) and audited as `api.write_skipped`. Decisions and manual steps are **real tasks**: they notify assignees (marked as a dry run, or in the app only with `dryRunDelivery: 'inAppOnly'`) and keep four-eyes (`noteFourEyes('run.decide', [startedBy], …)`). A dry run still **publishes datasets** (`publishDataset(... dryRun)`, flagged `dry_run`; a key owned by another process gets a preview only), raises **check alerts** (`checkOutcome`, kept apart by `dry_run` in `notify_alerts`), and appears in the **daily summary** (`notifications/summary.ts`). Evidence packs and compliance controls skip dry runs (`dry_run = 0`).
- **Test runs** (#105, `runs.recorded`): dry runs whose platform calls are answered from the platform's recordings (`findRecording`; `missingRecording` when none matches). The kind rules (`assertKindRules`) and the per-connection credential rule (`scanSecrets`, 0.9.0) run before a recording is looked up. Reading recordings needs `use` on the platform. An AI step answers with its `sampleAnswer` in dry runs and in test runs without a recording.
- **The expression assistant**: `GET /api/processes/:id/scope` and `POST /api/processes/:id/evaluate` (`edit` or `run`) evaluate an expression against a past run's variables. `expressionContext()` builds the scope without secrets: `$secret()` throws, and the run's platform secrets are registered with a `Redactor`.
- **Node inspection**: `GET /api/runs/:id/inspect/:nodeId` (`inspectNode`) shows every activation of a node and the variables before the first one. `reconstructVars()` rebuilds variables from the journal (set outputs, `saveAs`, for-each items), so nothing is snapshotted per step and old runs work too.
- **The protocol**: `run_steps` holds per activation the key, type, status, the rendered request (`input`: method, URL, query, headers, body, write flag – all redacted), the output, summary, error and duration. `if` and `forEach` store their decision in `input.decision`. `store.protocolHash()` is sealed in the final audit entry of every run (ADR 0011).
- **Retention**: finished runs are deleted after `retentionRunDays` (default 400) by `deleteRunsBefore()` in `maintenance.ts`; their audit entries stay.
- **Rights**: process rights `view`, `run`, `edit`, `approve`, `manage`. Designers get `view`, `edit`, `run` by default; operators `view`, `run` (`DEFAULT_PROCESS`, `auth/permissions.ts`). Platforms: `use`, `manage`, and identities per ADR [0009](0009-platform-identities.md).

What is missing: one can evaluate an expression against a past run, but not execute a node; no run can be paused; there is no comparison.

## Decision

### Order: compare first, then debug runs on the engine boundary

- **Compare two runs** only reads the record (`run_steps`, `run_tasks`, `run_logs`). It does not need the engine boundary and ships first.
- **Run one node** and **step through a run** are **debug runs**. They are started with `engine().start({ …, debug })` and driven with `signal` and `query` (ADR 0011). They wait for ADR 0011 steps 1 and 2, so the pause gate and the debug signals are written once, behind the interface, and not into `runner.ts` callers that are about to move.
- Debug runs always run on the **built-in engine**. Any other engine refuses `debug` (`ENGINE_DEBUG_NOT_SUPPORTED`).

### Debug runs

- A debug run is a row in `runs` like any other, so it has a journal, a protocol, a seal and retention without new machinery. It is never a live run: `debug` is accepted only with mode `dry` or `test`; a live run with `debug` is refused (`DEBUG_LIVE_RUN`). **A live run is never paused.**
- Named migration `engine-004-debug-runs` adds `runs.debug` (TEXT, NULL for ordinary runs): `{ kind: 'node' | 'step', nodeId?, varsFrom?, draft?, live? }`, and a partial index `runs_debug ON runs(finished_at) WHERE debug IS NOT NULL` for retention (SQLite and PostgreSQL both support it). The run's `trigger` is `'debug'`.
- It runs the **same step functions** as every run (`execNode` → `execLeaf` → `execHttp`, `execQuery`, `execAi`, `execBrowser`, …). There is no second executor. The outbound policy, the egress scan, the kind rules, write skipping, recordings and (from ADR 0009 step 3) the identity's read-only flag and operation filter apply because they sit in those functions.
- **What a debug run does not feed.** Inside a debug run:
  - `publish` returns a preview and writes nothing (the branch `execPublish` already has for a key owned by another process);
  - `check` records its result in the protocol only: no `checkOutcome` (no `notify_alerts`, no check notifications) and no separate `check.failed` entry;
  - `accessChange` documents nothing (as in a dry run);
  - no task is created and nobody is notified (decisions below);
  - `run.started` and `run.finished` carry `debug`; notifications, automatic reports (`reports/auto.ts`), the daily summary, scorecards, objectives, run metrics, evidence packs and compliance controls ignore debug runs. Run lists hide them unless the _Debug_ filter is on;
  - AI calls that are really sent count against the AI budgets and appear in the usage log, marked _debug_: the tokens are spent.
- **Retention.** A new setting `retentionDebugRunDays` (default 7, range 1–90). The cleanup deletes finished debug runs older than that, before the ordinary run cleanup. Audit entries stay (ADR 0003). A setting change is audited like the other retention settings.
- **Limits.** One step-through run per person at a time (starting a second stops the first). A paused run times out after `debugPauseMinutes` (default 30): it is cancelled with the reason "debug pause timed out", its browser session closed, its slot and bindings released. After a restart, `recover` cancels open debug runs with the reason "Steward restarted" instead of resuming them.

### Run one node

`POST /api/processes/:id/debug/node`:

```ts
{
  version?: number;            // the saved version; default current
  nodeId: string;
  node?: FlowNode;             // the editor's unsaved node (decided question 3)
  vars:
    | { from: 'run'; runId: string }                 // variables just before this node in that run
    | { from: 'sample'; vars: object; inputs?: object }
    | { from: 'inputs'; inputs: object };
  answers?: 'offline' | 'recorded' | 'live';         // default 'recorded' when the node calls a platform
  bindings?: Record<string, string>;                 // only the node's own slot is resolved
  answer?: { status: number; headers?: object; body?: unknown };  // a pasted answer for this node's requests
  decision?: TaskDecision | ManualCompletionInput;   // for a decision or manual step node
}
```

- **Variables.** From a previous run: `reconstructVars(runId, def, nodeId)` (needs `view` on that run). The values are the protocol's, so secrets are `***`; the result says which variables were masked. From sample data: JSON up to 1 MB, inputs coerced as at start (`coerceInputs`); inputs of type `secret` are sealed as in a run (`sealInputs`). Free sample data that contains something that looks like a credential is refused (`findSecret` from `credentials/secrets.ts`, error `DEBUG_SAMPLE_SECRET`): use a secret input or a platform's credentials instead.
- **Answers.** Three levels, chosen per execution:
  - **offline**: no binding is resolved, nothing is contacted; `$secret()` fails as in the expression assistant. For `set`, `if`, `check`, `report`, `log`, `fail`, expressions, and any node with a pasted answer or an AI `sampleAnswer`. Mode `test`.
  - **recorded** (default for platform nodes): mode `test`. The node's slot is resolved (`getConnection`), the kind rules run, then the platform's recordings answer, or the pasted answer. The pasted answer lives only in this debug run's protocol; it is not stored as a recording.
  - **live**: mode `dry`, only for a node that reads: `GET` and `HEAD`, a `query` step (database platforms are read-only, ADR [0008](0008-database-platforms.md)), an AI call, a browser step without interaction actions. A step's `mutating: false` does not make a `POST` live-able (as for read-only identities in ADR 0009); such a request is answered from recordings or the pasted answer. A write is always skipped and audited as `api.write_skipped`.
- **Per node type.** `forEach` evaluates its item list and stops (the body is not run); `if` shows its decision; `wait` reports "would wait n s" without waiting; `subprocess` starts the child as a debug run in the same mode, without pauses (the actor's `run` on the child is checked, as today); `userTask` uses the `decision` given in the request, marked simulated (below); `publish` previews. Wires are not followed.
- **The result** is the debug run's single step: variables written, the request and answer (redacted), the decision, the check result, the duration, and on error the message with the expression that failed. The canvas shows it next to the node.

### Step through a run

- `POST /api/processes/:id/debug/runs` with the usual start fields, mode `dry` or `test` (default `test`), `pauseBeforeEach` and `breakpoints` (node ids). Breakpoints belong to the debug run, never to the definition (they would change the definition hash).
- **The pause gate** sits in `runNode`, before `execNode`, for nodes that are not replayed. At a stop, `query` returns `paused`: the next node and its key, the current variables, and a preview of the node's resolved inputs (request, query, body). Everything passes through the run's `Redactor`. The preview says that `$now()`, `$uuid()` and similar may give another value when the node actually runs.
- **Signals** (`signal(runId, …)`, only from the person who started the run): `debug.continue` (to the next breakpoint), `debug.step` (one node), `debug.skip` (the node is recorded as `skipped` with the summary "Skipped while debugging by <user>" and its pass-through ports fire, as for a false condition), `debug.stop` (cancel with a reason), `debug.breakpoints` (replace the list). An administrator may cancel any debug run.
- A paused run counts as **waiting** (`beginWait`): it does not hold a concurrency slot.
- The panel polls `GET /api/runs/:id/debug` (`query`) as the run page polls today. Push updates are not part of this step (ADR 0011, decided question 2).

### Decisions and manual steps in debug runs

As decided (question 2): no real task is created. The person debugging answers a decision, a selection or a manual step in the panel (or in the single-node request). The step's output carries `simulated: true` and `decidedBy` is the debugger; the protocol shows _Simulated_. **From the first simulated or skipped decision on, the rest of the run is answered from recordings or sample answers only** (the run's context answers like a test run from then on; `runs.debug.recordedFrom` holds the step key, and the run log says so). So a decision nobody really made never lets data leave Steward, and four-eyes stays meaningful: it guards real tasks, and debug runs never create one.

### Compare two runs

- `GET /api/runs/compare?a=<runId>&b=<runId>`, computed in a new `server/src/engine/compare.ts` from the stored record only. Both runs must be of the same process (versions may differ) and visible to the caller (`view`).
- **Alignment.** Activations by journal key (`<scope>/<node>#n`), which is deterministic for a given path. Across versions, nodes match by id; added and removed nodes are shown as such.
- **What is compared:** the path (keys present in one run only), decisions (`input.decision` of `if` and `forEach`, task decisions with who and when), check results, variables before each node (`reconstructVars`), requests (method, path, status, duration, attempts – headers and bodies only on request), errors, the duration of each step. Differences are highlighted.
- **Secrets.** Only redacted, stored data is compared; nothing is resolved again. Secret inputs show "secret – not compared". A `***` in both runs is shown as masked, not as equal.
- **Limits.** The first 2,000 activations of each run; values cut to 8,000 characters as in `inspectNode`. The page says when it cut.
- **Compare with the last good run** (from a failed run): the latest earlier run of the same process that succeeded without findings, in the same mode, not a debug run. The person can pick another one.
- A comparison is a read: it writes no audit entry, like opening a run.

### Rights

As decided (question 1):

| Action                             | Needs                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Compare two runs                   | `view` on both runs                                                                      |
| Run one node offline               | `edit` on the process (no platform is touched; like `/evaluate`)                         |
| Run one node with recorded answers | `edit` and `run` on the process, `use` on the node's platform (and identity)             |
| Run one node live                  | the same, plus the platform's own rules (read-only, filter, kind rules) at that moment   |
| Step through a run                 | `edit` and `run` on the process, `use` on every bound platform, as a dry run would check |
| Variables from a previous run      | `view` on that run                                                                       |
| Signal a paused debug run          | the person who started it                                                                |

Rights are checked by the same start check as every run (ADR 0011: the command layer), at start and again for a sub-process child.

### Audit

- Every debug run that resolves a binding writes `run.started` (with `details.debug`: kind, node, `answers`, where the variables came from – never their values) and `run.succeeded|failed|cancelled` with the sealed `protocolHash`. Skipped writes are `api.write_skipped`; a refused credential is `run.secret_refused`, as in any run.
- An **offline** single-node run touches nothing and is not audited, like the expression assistant. It is still stored as a debug run.
- Skips and simulated decisions are in the protocol, so the seal covers them. Pauses and continues go to `run_logs`.

## UI outline

- **Canvas**: on a node, _Run this node_ opens a drawer: variables (_From a run_ with a run picker, _Sample data_ as JSON, _Run inputs_), answers (_Offline_, _Recorded_, _Live read_ – disabled with the reason for a writing node), a pasted answer, the result below.
- **Step-through panel** on the process page: _Debug run_ with mode, _Pause before each node_, breakpoints toggled on nodes; at a stop the variables, the next node and its inputs, buttons _Continue_, _Step_, _Skip this node_, _Stop_; the remaining pause time.
- **Comparison page** `/runs/compare?a=…&b=…`: graph with both paths coloured, then a table per node (decisions, checks, variables, requests, errors). _Compare with the last good run_ on a failed run's page.
- German texts use "Sie", e.g. _Dieser Knoten schreibt. Sie können ihn nur mit aufgezeichneten Antworten ausführen._
- Desktop and phone; the step-through panel collapses to a bottom sheet on a phone.

## Alternatives considered

- **A separate debug executor** (a small interpreter for one node). Faster to build, but it would need its own copy of every check on a request – a second place to forget one. Rejected: debug runs use the step functions.
- **Pausing live runs.** A paused live run can hold credentials, locks and half-done changes for as long as someone looks at it. Decisions and approvals already stop live runs where it matters.
- **Snapshots of variables per step.** More storage for every run; `reconstructVars` already rebuilds them from the journal.
- **Evaluating nodes in the browser.** JSONata runs in the browser, but platform calls, secrets and recordings cannot; two engines would disagree.
- **Debugging in dry runs as they are.** Dry runs publish datasets, raise check alerts and notify assignees. Repeated tries would pollute dashboards and inboxes.

## Consequences

**Positive**

- Designers find faults without blind edits and full runs; operators can compare runs to explain a failure.
- One executor: every guard that protects platforms and credentials applies to debugging by construction.
- Debug runs are evidence of what was tried, with the same seal, for a week.

**Negative**

- A new run kind that every reader of `runs` must know about. Each aggregate gets a filter and a test.
- Simulated decisions and the switch to recorded answers add a rule that needs explaining in the panel and the docs.
- Single-node runs add audit entries (two per run that touches a platform), which stay for the life of the installation.

**Risks**

- An aggregate that forgets the debug filter shows debug results as real. Mitigation: a unit test lists every query on `runs` outside `engine/` and fails when one has neither `debug IS NULL` nor a reason to include debug runs.
- Sample data or copied variables with personal data stay for up to `retentionDebugRunDays`. Mitigation: the short default, and debug runs are visible only to the starter, process managers, administrators and auditors (decided question 4).
- A breakpoint preview could show a value that is not redacted (a secret built inside an expression). Mitigation: the preview uses the run's `Redactor`, which knows every value `$secret()` returned, and the egress scan still runs before sending.

### Migration and rollout plan

Each step is its own PR, with unit tests on SQLite and PostgreSQL and e2e on desktop and phone with axe.

1. **Compare two runs.** `engine/compare.ts`, the route, the comparison page, _Compare with the last good run_. Needs nothing else.
2. **Debug runs as a kind** (after ADR 0011 steps 1–2). Migration `engine-004-debug-runs`, `debug` in `StartCommand`, the exclusions above with the test that lists queries on `runs`, `retentionDebugRunDays`, the _Debug_ filter in run lists.
3. **Run one node.** The route, offline / recorded / live, pasted answers, sample-data checks, the canvas drawer.
4. **Step through.** Pause gate, debug signals and `query.paused`, timeouts, simulated decisions, the panel.
5. **Docs.** A _Debugging_ section in `docs/` with examples; `docs/ARCHITECTURE.md` links this record.

## Security

- **No way around approvals or four-eyes.** Debug runs never create tasks and never write. A simulated decision switches the rest of the run to recorded answers, so nothing after it reaches a platform. Four-eyes keeps guarding real tasks unchanged.
- **No way around read-only rules and the outbound policy.** Debug runs use the step functions, so `assertOutboundAllowed`, `assertKindRules`, `assertBrowserDestination`, write skipping and (ADR 0009 step 3) the identity's read-only flag and operation filter apply. Live single-node runs are limited further to nodes that read; `mutating: false` does not count.
- **The per-connection credential rule.** A single-node run resolves only its node's slot. In step-through runs, `scanSecrets` refuses another connection's credential in every mode, as in any run.
- **Rights.** Executing needs `run` as well as `edit`; contacting a platform or reading its recordings needs `use` on it. A paused run is driven only by its starter.
- **Audit.** Everything that resolves a binding is audited and sealed. Only offline single-node runs are not, like the expression assistant.
- **No evidence, datasets or notifications.** Debug runs never publish datasets, raise check alerts, document access changes, notify, or count for scorecards, objectives, the daily summary or evidence packs.
- **Secrets.** Sample data that looks like a credential is refused; secret inputs are sealed; variables from earlier runs are the redacted protocol values; previews and results pass through the run's `Redactor`; comparisons use stored, redacted data only and never compare secret inputs.

## Decided after review

1. **Who may debug?** Decided: `edit` and `run`, plus `use` for platforms. Offline single-node runs need only `edit`; anything that contacts a platform or its recordings also needs `run` on the process and `use` on the platform; comparing needs `view`.
2. **How are decisions and manual steps handled in debug runs?** Decided: simulated by the debugger in the debug panel and marked _Simulated_; from the first simulated or skipped decision on, the rest of the run uses recorded answers only. No real task is created.
3. **May a debug run execute unsaved changes?** Decided: single node yes, step-through no. The unsaved node is checked like a saved definition, stored in the step's input, and `definition_hash` is the hash of the definition with that node.
4. **Who sees debug runs?** Decided: the starter, process managers (`manage`), administrators and auditors. Everyone else does not see them, not even with `view` on the process.

## Changed while building

1. All steps shipped in 0.10.0 together with ADR 0011.
2. _Run this node_ is a third tab beside a node's properties (next to _Last run_), not a drawer: the editor's side panel already is one on small screens.
3. The comparison page has no graph with both paths coloured; steps only one run reached are marked in the table (cards on a phone).
4. A single-node debug run never waits for a free slot (`SM_MAX_CONCURRENT_RUNS`): it executes one node. Step-through runs queue like any run.
5. A pasted answer stands in for http requests only; database queries, browser steps, sub-processes and contract tests cannot run offline (they need recorded answers).
6. In a step-through run a parallel `forEach` runs one item at a time, so there is one pause at a time. _Continue_ also ends _pause before each node_ (it runs to the next breakpoint).
7. A sub-process run of a debug run has nobody to answer its decisions: they are skipped, and the recorded-answers rule applies from there.
8. A live read of an AI node asks the model although the debug run is a dry run (dry runs otherwise use the sample answer). Its call is marked _debug_ in the usage log by joining the run, without a new column.
9. After the security review of 0.10.0 (review c), decided by the owner:
   - Variables copied from a run carry that run's data sources (`runSources`), so the AI gateway's allowed-data rule holds for them; typed or pasted sample data stays a run input.
   - A debug run is hidden from everyone but its starter, the process's managers, administrators and auditors on every path: node inspection, `/scope` and `/evaluate` with a run id, run reports and their PDFs, and record links answer like a missing run.
   - At most two single-node runs per person run at the same time (429 `DEBUG_NODE_BUSY`); they still do not queue behind other runs.
   - Item 7 is extended: a simulated or skipped decision anywhere – in the run or in one of its sub-process runs – switches the whole run tree to recorded answers.
   - Driving a paused run (_Continue_, _Step_, _Skip_, an answer) checks the person's rights again: `run` on the process and `use` on the platforms of the node it paused before. _Stop_ and breakpoints need no more than before.
