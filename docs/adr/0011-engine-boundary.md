# 0011. Engine boundary: start, signal, cancel and query runs through one interface

- **Status:** Accepted
- **Date:** 2026-11-07
- **Since:** 0.10.0 (#239), step 1 only (below)

## Context

Steward's process engine lives in one module, `server/src/engine/runner.ts` (about 2,600 lines). It does two different jobs. It decides **what a run is and what it recorded**: the journal, the protocol, redaction, audit entries, evidence. It also decides **how a run is executed**: in memory, in this process, with its own queue and its own way to survive a restart. Nothing separates the two. A durable-execution backend such as Temporal could take over the second job for very long or very many runs, but today it would have to replace the whole module.

What the code does today:

- **Starting.** `startRun(req, opts)` checks that Steward accepts runs, loads the version (`getProcess`), coerces and seals inputs (`coerceInputs`, `sealInputs`), resolves bindings (`resolveBindings` → `getConnection`, the default identity per ADR [0009](0009-platform-identities.md)), inserts the `runs` row and writes `run.started` in one transaction, then either queues the run or calls `launch()`. A test run (`recorded`) is always a dry run.
- **Callers.** Eight modules call `startRun` directly: `routes/processes.ts` (`POST /api/runs`), `scheduler.ts`, `triggers/hook.ts`, `monitors/outputs.ts`, `mcp/requests.ts` (approved `request_run`), `routes/dashboards.ts` (run again), `onboarding/bundles.ts` (one dry run per imported process), `routes/demo.ts`. Each checks rights its own way: `requireProcess` + `requireBindingsUsable` in the route (a second copy of `requireBindingsUsable` sits in `routes/triggers.ts`), the owner's `run` and `use` at each fire in the scheduler, `permissionsFor(...).includes('run')` plus a hand-written `use` loop in the dashboard refresh and the onboarding bundles, `run` at approval time in MCP, and the route's access alone for the demo setup. `execSubprocess` starts child runs through `startRun` with `trigger: 'subprocess'` and checks the actor's `run` right on the child.
- **Signals.** Decisions reach a waiting run through `completeTask`, `completeManualTask`, `verifyManualTask` → `settleTask()`. The route checks `canDecide` and four-eyes (`noteFourEyes('run.decide' | 'manualStep.verify')`) first. `settleTask` calls the in-memory waiter (`taskWaiters`) or, after a restart, `resumeRun()` to replay. A person resumes an interrupted run with `resumeRun()`.
- **Cancel.** `cancelRun()` cancels open tasks, aborts the run's `AbortController` (it reaches `platformRequest`, `sleep`, expressions), takes the run out of the queue, cancels unfinished child runs, and writes `run.cancelled` when no live context reports it.
- **State in memory.** `active` (run id → `RunContext` and its promise), `taskWaiters`, `runQueue`, `starting`, `accepting`, each run's `AbortController` and browser session. `SM_MAX_CONCURRENT_RUNS` counts runs that are active and not waiting (`busyRunIds`). `waitForChild` polls the child's row every 500 ms and races `active.get(child).done`.
- **Durability.** The journal is the run's state. `run_steps` holds each activation by key (`<loop scope>/<node id>#n`); `if` and `forEach` store their decision in `input.decision`. `execNode` replays a finished step from the journal instead of executing it again (a cut-down read is read again). `recoverRuns()` at start-up resumes `waiting` runs, marks `running` ones `interrupted` (a person reviews and resumes or cancels), and re-queues `queued` ones. Shutdown is `stopAcceptingRuns` → `drainRuns` → `interruptBusyRuns` (`bootstrap.ts`).
- **The record.** `store.protocolHash(runId)` fingerprints steps, tasks, artifacts and manual-step entries. `execute()` seals it in the final audit entry (`run.succeeded|failed|cancelled`, `details.protocolHash`); `sealedProtocol()` in `audit.ts` reads it back for reports and evidence packs. The audit log is one HMAC chain written by one process (ADR [0003](0003-hmac-chained-audit-log.md)); one instance is active, held by a lease (ADR [0002](0002-single-active-instance-with-lease-lock.md)).
- **Events.** `emit()` (`events.ts`, an in-process `EventEmitter`) publishes `run.started`, `run.finished`, `step.finished`, `task.created`, `task.verification_needed`, `task.returned`. Notifications, metrics and automatic reports subscribe. The web app polls `GET /api/runs/:id` (every 1.5 s while active); there is no push channel.
- **Expressions.** JSONata (`engine/expr.ts`) with functions that are not deterministic: `$now()`, `$millis()`, `$random()`, and Steward's `$uuid()`, `$daysAgo()`, `$daysSince()`, `$trend()`, `$daysUntil()`, `$systems()` (the last three read the database).
- **Readers of the record.** About fifteen modules outside `engine/` import `engine/store.ts` to read runs, steps, tasks and artifacts (reports, evidence packs, API v1, dashboards, compliance).

## Decision

### One interface, the current engine behind it

A new module `server/src/engine/engine.ts` defines the boundary. `runner.ts` implements it as the **built-in engine**. `server/src/engine/index.ts` exports `engine()`, which returns the configured engine; in 0.10.0 that is always the built-in one. Code outside `engine/` imports `engine/index.ts` and never `engine/runner.ts`; an ESLint `no-restricted-imports` rule enforces it. `engine/store.ts` stays importable: it is the record, not the executor.

```ts
export type RunMode = 'live' | 'dry' | 'test';

export interface StartCommand {
  processId: string;
  version?: number; // the current version when missing
  inputs: Record<string, unknown>; // raw; the engine coerces and seals
  bindings: Record<string, string>; // slot → platform id
  identities?: Record<string, string>; // slot → identity id (ADR 0009 step 2)
  mode: RunMode; // test implies no writes and recorded answers
  actor: string; // whose rights the run carries
  origin: RunOrigin; // trigger, schedule, webhook/monitor, parent run and step key
  debug?: DebugSpec; // ADR 0010; only the built-in engine accepts it
}

export type RunSignal =
  | { type: 'task.decide'; taskId: string; decision: TaskDecision }
  | { type: 'manual.complete'; taskId: string; input: ManualCompletionInput }
  | { type: 'manual.verify'; taskId: string; input: ManualVerification }
  | { type: 'resume' } // a person resumes an interrupted run
  | DebugSignal; // ADR 0010: continue, step, skip, stop, breakpoints

export interface RunState {
  runId: string;
  status: RunStatus;
  mode: RunMode;
  current: string[]; // activation keys running or waiting (several in a parallel for-each)
  waitingTasks: { taskId: string; stepKey: string; mode: string; stage?: 'work' | 'verify' }[];
  queuePosition?: number;
  paused?: DebugPause; // ADR 0010
}

export interface RunEngine {
  readonly id: 'builtin';
  start(cmd: StartCommand): Promise<{ runId: string; status: 'queued' | 'running' }>;
  signal(runId: string, s: RunSignal, actor: string): Promise<SignalResult>;
  cancel(runId: string, reason: string, actor: string): Promise<void>;
  query(runId: string): RunState;
  // host lifecycle, called by bootstrap.ts and main.ts only
  recover(): Promise<void>;
  stopAccepting(): void;
  drain(graceMs: number): Promise<string[]>;
  interruptBusy(): string[];
}
```

- **Events stay `events.ts`.** The interface does not add a second event bus. `DomainEvents` is the event stream; the built-in engine emits as today. `run.started` and `run.finished` gain `mode` and `debug` fields (additive).
- **`StartRunRequest` stays the API shape.** Routes map `dryRun` and `recorded` to `mode` (`recorded` → `test`, `dryRun` → `dry`, else `live`). The `runs` columns `dry_run` and `recorded` stay; no migration.
- **`query` reads the record first.** Status, current keys and open tasks come from `runs`, `run_steps` and `run_tasks`. Only `queuePosition` and `paused` come from the engine's memory. Any engine can answer it the same way.
- **`cancel` takes a reason.** It goes into `run.cancelled` (today the summary is a fixed text). This is the one visible change in step 1: the audit entry says why.

### What stays in Steward, whatever the engine

An engine orders and persists execution. Everything that makes a run trustworthy stays in Steward's own code, in the active instance:

- **Rights and assurance.** Who may start, decide, verify, resume, cancel; step-up and four-eyes (`noteFourEyes`, `checkFourEyes`). They run in the command layer (`engine/commands.ts`) before a command reaches the engine.
- **Secrets.** `getConnection`, the vault, `$secret()`, the `Redactor`. An engine never receives a credential.
- **Every check on a request.** The outbound policy (`assertOutboundAllowed`), the egress scan with the per-connection credential rule (`scanSecrets`, `run.secret_refused`, 0.9.0), the kind rules (`assertKindRules`, `assertBrowserDestination`), dry-run write skipping (`isMutating`), recordings (`findRecording`), and the read-only and operation-filter checks of ADR 0009 step 3 in `platformRequest`. They live in the step functions (`execHttp`, `execQuery`, `execAi`, `execBrowser`, …), and the step functions stay Steward's.
- **The record.** `run_steps`, `run_tasks`, `run_logs`, `run_artifacts`, `run_task_evidence`, `protocolHash`, and the audit chain with its single writer (ADR 0003).
- **What the run feeds.** Datasets (`publishDataset`), access-change entries (`recordStepAccessChanges`), check alerts (`checkOutcome`), notifications, reports.
- **What starts runs.** The scheduler, webhook triggers, monitor outputs and MCP stay as they are and call `start`.

### Invariants every engine keeps

These are what the contract tests check. Each is true of the built-in engine today.

1. **One journal entry per activation**, keyed `<scope>/<node>#n`, in execution order (depth first, wires top to bottom). Control decisions are recorded in `input.decision` before the branch runs.
2. **A finished step is never executed again.** Replay takes its output from the journal. A read whose stored output was cut down may be read again.
3. **At most once for writes without a person.** Automatic recovery never re-runs a step that may have started: a run found `running` after a crash becomes `interrupted`; only a person's `resume` replays it.
4. **The decision is written before the run is woken.** A signal first commits the task decision (`run_tasks`, `task.completed`), then wakes the run. A signal on a task that is no longer open changes nothing (409). That is what "idempotent" means here: repeating a signal never adds to the journal.
5. **Cancel reaches the open request** (the step's `AbortSignal`), cancels open tasks and unfinished child runs, and ends with one `run.cancelled`.
6. **Modes are inherited.** A child run has the parent's mode, actor and recorded flag. Nesting stops at `MAX_SUBPROCESS_DEPTH` (5); a process cannot appear twice in a chain.
7. **The protocol hash does not depend on the engine.** The same run with the same answers gives the same `protocolHash`.

### Contract tests

`server/test/engine-contract.test.ts` takes an engine factory and runs on SQLite and PostgreSQL (the existing `pg-global.ts` setup). It covers:

- protocol ordering and a **golden protocol hash**: example processes as test runs against fixed recordings give the same `protocolHash` before and after the refactor (test runs answer from recordings, so the hash is reproducible);
- idempotent signals: a second decision, a decision on a cancelled task, a decision that arrives while the run is not in memory (replay);
- cancel during a slow request, during a wait, with open tasks and with a running child run;
- resume after a crash: `waiting` runs resume, `running` runs become `interrupted`, `queued` runs keep their place;
- sub-processes: inherited mode and actor, the depth limit, recursion, and AI token budgets that count against the parent processes (#216, `parentProcessIds` in `execAi`);
- dry and test runs: writes skipped and audited (`api.write_skipped`), kind rules checked before a recording is looked up, another connection's credential refused in every mode;
- the queue (`SM_MAX_CONCURRENT_RUNS`; a waiting run frees its slot) and shutdown (`SHUTTING_DOWN` except for sub-process runs, drain, interrupt).

The existing tests (`e2e.test.ts`, `restart.test.ts`, `manual-steps.test.ts`, `recordings.test.ts`, `route-matrix.test.ts`) keep passing unchanged.

### A durable-execution backend (step 2, not built)

This record does not add Temporal or any other backend. It fixes what one would have to respect, so the interface is not drawn in the wrong place:

- **The workflow is an interpreter.** A run pins `process_version` and `definition_hash`, so the definition is data. A workflow per run walks the pinned graph. Changing a process never changes a running workflow; only changing Steward's interpreter needs the backend's versioning (Temporal: patching).
- **Every node is an activity.** Expressions are not deterministic (`$now`, `$uuid`, `$trend`, …), so they are evaluated only inside activities, never in workflow code. The activity runs Steward's `execNode` in Steward's worker and returns ports and the redacted output. This is the journal model the built-in engine already uses.
- **Secrets never in the backend's history.** Activity inputs and results hold ids, ports and redacted outputs. Credentials are resolved inside the activity (`getConnection`). Payloads are encrypted by a codec keyed from the vault (ADR [0004](0004-vault-with-master-passphrase.md)).
- **Signals only wake.** Steward commits the decision first (invariant 4), then signals the workflow. Timers (`wait`, retry delays, for-each `delayMs`) become durable timers.
- **Workers run in the active instance.** The lease (ADR 0002) and the single audit writer (ADR 0003) stay. A backend gives durable waits and very many parked runs; it does not give more than one Steward process executing steps. That would need those two records revisited first.
- **Operating it** (a cluster or Temporal Cloud, which would move run metadata outside the installation) needs its own decision record, written only with a concrete need: runs that wait for weeks, or thousands of runs parked at once.

### Out of scope for 0.10.0

- Any second engine, adapter, SDK dependency, or engine choice per installation or per process.
- A `runs.engine` column (added with the second engine, when a run's owner must be known at recovery).
- A durable event outbox, push updates to the web app, or changes to `run_steps`, `run_tasks` or the protocol hash.
- Changes to the lease, the audit chain or `SM_MAX_CONCURRENT_RUNS`.

## Alternatives considered

- **Leave the engine as it is.** Cheapest now. Each new caller (Teams approvals #237, debugging #235, start approvals of ADR 0009 step 4) would again call `runner.ts` directly and add its own rights check. The boundary is worth drawing for those alone.
- **Move straight to Temporal.** It would solve durability we already have (the journal) and add a cluster to run, while ADR 0002 and 0003 limit what it can scale. No installation has asked for it.
- **A message queue between callers and the engine.** Decouples, but adds delivery and ordering problems the single process does not have, and does not help a later Temporal adapter, which brings its own.
- **Split `runner.ts` into many files in the same step.** Useful later. Doing it together with the boundary would make the golden-hash diff hard to review. Step 1 moves callers, not code.

## Consequences

**Positive**

- One place where runs start, wake and stop. New callers (#235, #237, ADR 0009 step 4) use it instead of `runner.ts`.
- The invariants are written down and tested, for the built-in engine now and any engine later.
- A backend could be added later without touching callers, the record or the security checks.

**Negative**

- An extra layer for a single implementation. It earns its keep through the contract tests and the callers it unifies, not through a second engine.
- Eight callers change. Their rights checks move into the command layer; some callers become stricter.

**Risks**

- The refactor could change the protocol in a way the hash would catch only for covered paths. Mitigation: golden hashes for every example process with recordings, plus `restart.test.ts` unchanged.
- The interface could still be wrong for a real backend. Mitigation: the step-2 constraints above, and the spike (decided question 3).
- Rules that live only in a caller today (the scheduler's owner checks, MCP's re-check at approval) could be lost when the caller moves. Mitigation: one PR per caller, each with its existing tests.

### Migration and rollout plan

Each step is its own PR. None changes what users see, except the reason in `run.cancelled`.

1. **Interface and built-in engine.** `engine/engine.ts`, `engine/index.ts`, the built-in engine wrapping today's functions, `query`, `cancel` with a reason, the ESLint rule (with an allow-list of today's importers that shrinks with each step). Contract tests and golden hashes.
2. **Callers move.** Routes (`processes.ts`, `dashboards.ts`, `demo.ts`), the scheduler, webhook triggers, monitor outputs, MCP, onboarding bundles, sub-processes (`execSubprocess` uses `start` with `origin.parent`), and `bootstrap.ts`/`main.ts` for `recover`, `stopAccepting`, `drain`, `interruptBusy`. The allow-list ends empty.
3. **Rights in one place**: the command layer `engine/commands.ts`.
4. **`docs/ARCHITECTURE.md`**: the boundary, the invariants and the step-2 constraints; a link to this record.

ADR 0010 (debugging) builds on steps 1 and 2: its debug runs start with `start({ debug })` and are driven with `signal` and `query`.

## Security

- The boundary adds no new way in. `start`, `signal` and `cancel` are internal functions; the routes and their access declarations (ADR [0005](0005-route-access-declared-on-routes.md), `route-matrix.test.ts`) stay in front of them.
- The engine trusts its caller for rights, as today. The checks that protect the outside world (outbound policy, egress scan, kind rules, read-only rules, dry-run write skipping) stay inside the step functions, so no caller and no future engine can skip them.
- An engine never sees credentials, unredacted outputs, or the audit key. That is a design rule for any future backend, not only for this step.
- `run.cancelled` with a reason, and `mode` on `run.started`, make the audit log say more, not less.

## Decided after review

1. **Where do rights checks for runs live?** Decided: a command layer in front of the engine. `engine/commands.ts` has `authorizeStart` (process `run`, `use` on each bound platform, slot requirements), `authorizeSignal` (`canDecide`, four-eyes) and `authorizeCancel`; every caller uses it, and the release notes name the callers that became stricter.
2. **Is the in-process event emitter enough as the interface's event stream?** Decided: yes, for 0.10.0. `events.ts` stays; the interface documents the event types and `run.started`/`run.finished` gain `mode` and `debug`. No outbox, no push to the web app.
3. **Do we try the interface against a real durable-execution SDK in 0.10.0?** Decided: a time-boxed spike in a separate branch, not merged (one example process as a Temporal workflow with a decision signal and a cancel). Its result becomes a note in this record.

## Changed while building

1. Steps 1–3 shipped together in 0.10.0: the interface, every caller moved (the ESLint allow-list is empty from the start), and the rights in `engine/commands.ts`.
2. `RunEngine` has one more host call, `counts()` (active, busy and queued run ids), for the shutdown report in `bootstrap.ts`.
3. A signal on a task that is no longer open is refused by the command layer with **403 `TASK_CLOSED`**, as the route answered before, not 409. The invariant holds: it changes nothing.
4. The golden protocol hashes cover examples 70 (endpoint check) and 90 (sub-process building block) and a synthetic process with every control type. A parent run with a sub-process step is not in the golden set: its protocol holds the child's run id, which differs per run.
5. Callers that became stricter: monitor outputs (now also `use` on the bound platforms) and sub-process steps (`use` on the child's platforms, for the run's actor); the demo setup goes through the same check. A schedule whose bound platform was deleted is skipped instead of failing.
6. The durable-execution spike (decided question 3) was not part of this work; it remains open.
7. After the security review of 0.10.0 (review c): the summary of `run.cancelled` names who cancelled the run (its entry's actor stays the run's starter when the run was active), and the reason follows as one line of plain text. `authorizeSignal` re-checks `run` and `use` for every debug signal that drives a run on.
