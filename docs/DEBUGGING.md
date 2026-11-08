# Debugging processes

When a procedure does the wrong thing, you do not have to edit it blindly and start another full run. Steward 0.10.0 offers three tools ([ADR 0010](adr/0010-debugging-procedures.md)):

- **Run this node** – try one node with the data you choose.
- **Step through a run** – walk through a run node by node and look at the variables before each one.
- **Compare two runs** – see what changed between a good and a bad run.

None of them is a way around the rules a real run keeps: they use the same step functions as every run (outbound policy, the per-connection credential rule, kind rules, write skipping, recordings), they never run live, and they never publish, alert, create tasks or notify.

## Debug runs

_Run this node_ and _Step through_ start **debug runs**. A debug run is a run like any other – it has a journal, a protocol with its seal and its audit entries – with these differences:

| A debug run …                                                                                                                                                                                  | because                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| is a test run or a dry run, **never a live run**                                                                                                                                               | a paused live run could hold credentials, locks and half-done changes |
| publishes no dataset (`publish` shows a preview)                                                                                                                                               | repeated tries would pollute dashboards                               |
| raises no check alert and writes no `check.failed`                                                                                                                                             | the result stays in its protocol                                      |
| documents no access changes                                                                                                                                                                    | as in every dry run                                                   |
| creates no task and notifies nobody                                                                                                                                                            | decisions are answered by the debugger, simulated (below)             |
| is left out of run metrics, the daily summary, automatic reports, reports, evidence packs, compliance controls, duties, scorecards and objectives, the start page and the process's last run   | it is a workbench, not a record of what the team did                  |
| is seen only by its starter, the process's managers, administrators and auditors – on every page and route: the run page, node inspection, the expression assistant, run reports, record links | sample data and copied variables may hold personal data               |
| is never served by `/api/v1` or MCP                                                                                                                                                            | the same                                                              |
| is deleted after `retentionDebugRunDays` (default 7)                                                                                                                                           | _Settings → Data & retention_; its audit entries stay                 |

Run lists hide debug runs; choose **Kind → Debug runs** on the _Runs_ page (`/runs?debug=1`) to see yours. An AI call that a debug run really sends (a live read of an _Ask an AI model_ node) spends tokens: it counts against the AI budgets and is marked _debug_ in the usage log.

### Rights

| Action                             | Needs                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| Compare two runs                   | `view` on both runs                                                            |
| Run one node offline               | `edit` on the process (no platform is touched)                                 |
| Run one node with recorded answers | `edit` and `run` on the process, `use` on the node's platform                  |
| Run one node live                  | the same, plus the platform's own rules (read-only, kind rules) at that moment |
| Step through a run                 | `edit` and `run` on the process, `use` on every bound platform                 |
| Variables from an earlier run      | `view` on that run                                                             |
| Drive a paused debug run           | the person who started it (an administrator may stop any debug run)            |

Designers have `edit` and `run` by default, so nobody loses anything.

## Run this node

Select a node in the editor and open the tab **Run this node** beside its properties.

1. **Variables** – _From a run_: the variables just before this node in an earlier run (rebuilt from that run's protocol; secrets stay `***`, and the result names the masked variables). Copied variables keep that run's data sources: an _Ask an AI model_ node sends them only when its gateway's _allowed data_ admits that run's platforms, as in the run itself. Sample data you type or paste counts as a run input. _Sample data_: a JSON object of variables, and the run inputs. _Run inputs_: inputs only. Sample data is limited to 1 MB, and **anything that looks like a credential is refused** (`DEBUG_SAMPLE_SECRET`): use an input of type _secret_ (it is sealed as in a run) or the platform's credentials instead.
2. **Answers** –
   - **Offline**: nothing is contacted, no platform is resolved and `$secret()` fails. For `set`, `if`, `check`, `report`, `log`, `fail`, loops, decisions, and for an http node with a **pasted answer** or an AI node with a sample answer.
   - **Recorded** (the default for a node that calls a platform): the node's connection is resolved, the kind rules are checked, then the platform's [recorded responses](PLATFORMS.md#recorded-responses-and-test-runs) answer – or the pasted answer.
   - **Live read**: the request is really sent as in a dry run, but only for a node that reads: `GET` and `HEAD`, a database query (database platforms are read-only), an AI call, a browser step without clicks or typing. A step's `mutating: false` does not make a `POST` live-able; such a request runs with recorded answers.
3. **Pasted answer** (http nodes): an HTTP status and a JSON body that stand in for the platform. It lives only in this debug run's protocol and is never stored as a recording.
4. **Simulated answer** for a decision, selection or manual step.

At most **two single-node runs per person** run at the same time; a third is refused (`DEBUG_NODE_BUSY`) until one has finished. They do not wait for a slot of `SM_MAX_CONCURRENT_RUNS`.

The node runs once; wires are not followed. A `forEach` evaluates its item list and stops (the body does not run), an `if` shows its decision, a `wait` reports "would wait n s", a `subprocess` starts its child as a debug run in the same mode, a `publish` previews. The result shows the variables the node wrote, the request (redacted), the answer, the duration and, on an error, the message.

**Unsaved changes**: the node runs as it is in the editor. It is checked like a saved definition, and the debug run's definition hash is the hash of the definition with that node – the record stays exact. A new node must be saved once before it can run.

An offline single node touches nothing and is not audited (like the expression assistant); every other debug run writes `run.started` (with `details.debug`: kind, node, answers, where the variables came from – never their values) and `run.succeeded|failed|cancelled` with the sealed protocol hash.

## Step through a run

Choose **Debug** in the editor's header. The panel opens beside the canvas (a bottom sheet on a phone).

1. Choose the connections and inputs, the answers – **Recorded answers** (a test run) or **Dry run** – and where to pause: **Pause before each node** and/or **breakpoints**. Breakpoints belong to the debug run, never to the definition. A step-through run uses the **saved version**; unsaved changes are not used.
2. At a pause the panel shows the next node, the variables now and the node's resolved inputs (request, query, body – redacted). `$now()`, `$uuid()` and the like may give another value when the node actually runs. The canvas centres the paused node.
3. **Continue** runs to the next breakpoint (and stops pausing before every node), **Step** runs one node, **Skip this node** records it as skipped ("Skipped while debugging by …") and follows its pass-through port as for a false condition, **Stop** cancels the run with a reason. Breakpoints can be changed while the run waits. Every _Continue_, _Step_, _Skip_ and answer checks your rights again – `run` on the process and `use` on the platforms of the paused node – so a right taken away meanwhile stops further steps; _Stop_ always works.
4. A **decision, selection or manual step** pauses at itself: answer it in the panel. No task is created and nobody is asked; the step's output carries `simulated: true` and the protocol shows _Simulated_. **From the first simulated or skipped decision on, the rest of the run answers from recordings only** – the run you step through and all its sub-process runs, wherever the decision was (a decision inside a sub-process run is skipped, nobody can answer it there) – so a decision nobody really made never lets data leave Steward. Four-eyes keeps guarding real tasks.

Limits: one step-through run per person (starting another stops the first: "Replaced by a new debug run"); a pause is cancelled after `debugPauseMinutes` (default 30, _Settings → Data & retention_) with the reason "debug pause timed out"; after a restart, open debug runs are cancelled ("Steward restarted"), never resumed. A paused run counts as waiting: it holds no slot of `SM_MAX_CONCURRENT_RUNS`. In a step-through run a parallel loop runs one item at a time.

## Compare two runs

On a failed run (or one with findings) choose **Compare with the last good run**: the latest earlier run of the same process that succeeded without findings, in the same mode, not a debug run. Any run's protocol menu has **Compare with another run**. The comparison page is `/runs/compare?a=<run>&b=<run>`; both runs must belong to the same process (versions may differ).

Activations are aligned by their journal key (`<loop scope>/<node>#n`). For each step you see the status, decisions (`if` and `forEach`, task decisions with who decided), check results, requests (method, path, status, attempts), errors and durations of both runs, and what differs. Open a step to compare the variables before it. Steps only one run reached are marked; across versions nodes match by id and added or removed nodes are named.

The comparison uses only the stored, redacted protocol – nothing is resolved again. A `***` is shown as _masked_, never as equal; inputs of type _secret_ are "secret – not compared". At most the first 2,000 steps of each run are compared, values are cut to 8,000 characters, and the page says when it cut. A comparison is a read: it writes no audit entry.

## API

| Route                                 | What it does                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /api/processes/{id}/debug/node` | Runs one node and answers with its result                                                                 |
| `POST /api/processes/{id}/debug/runs` | Starts a step-through run (`mode`: `test` or `dry`; never `live`)                                         |
| `GET /api/runs/{id}/debug`            | The state the panel polls: status, mode, the pause, the steps                                             |
| `POST /api/runs/{id}/debug`           | A signal: `debug.continue`, `debug.step`, `debug.skip`, `debug.stop`, `debug.breakpoints`, `debug.answer` |
| `GET /api/runs/compare?a=&b=`         | The comparison                                                                                            |
| `GET /api/runs/{id}/last-good`        | The last good run before a run                                                                            |
| `GET /api/runs?debug=1`               | Debug runs the caller may see                                                                             |

These are internal routes; the public `/api/v1` does not serve debug runs. The engine behind them is described in [ARCHITECTURE.md](ARCHITECTURE.md#the-engine-boundary).
