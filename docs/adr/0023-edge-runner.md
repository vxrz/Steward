# 0023. Steward edge runner: steps run inside an OT segment, control stays in Steward

- **Status:** Accepted (owner decision 2026-11-10) – every _Recommendation_ below was taken as recommended (see _Decided (November 2026)_); not built yet
- **Date:** 2026-11-09
- **Since:** planned after 0.14 (decision record first, [ROADMAP.md](../ROADMAP.md)) – processes ([PROCESSES.md](../PROCESSES.md)), monitors, the plant registry

## Context

Steward sends every request from its own process ([ARCHITECTURE.md](../ARCHITECTURE.md)). That works for cloud APIs and the IT network. It does not work for devices in the plant: a PLC, a PowerMeter, an OPC UA server or a historian sits in a cell or supervisory zone (Purdue levels 1–3) behind a firewall that allows nothing inbound from the enterprise network – on purpose. To read such a device today, someone opens a firewall path from Steward's host into the zone, or runs the procedure by hand on site and documents it as a manual step. The first breaks the zone model of IEC 62443-3-2; the second loses automation and evidence.

What exists today:

- **Push from OT already works for monitors:** gateways report heartbeats to Steward (`POST` to the heartbeat API, token or HMAC, `allowedCidrs`, rate limit; [MONITORS.md](../MONITORS.md#heartbeat-api-for-gateways)). The gateway decides what it sends; Steward cannot ask it to do anything.
- **The engine boundary** ([ADR 0011](0011-engine-boundary.md)): rights, secrets, every check on a request, the record and the audit chain stay in Steward, whatever executes the run; workers run in the active instance (ADR [0002](0002-single-active-instance-with-lease-lock.md), [0003](0003-hmac-chained-audit-log.md)). Step types are modules (`engine/steps/<type>.ts`) that see their run only through `StepContext` and send with `platformRequest` after `enforceOutbound` (outbound policy, address safety, egress scan).
- **What a request must pass** is in Steward's code: the outbound policy and address safety (`platforms/outbound.ts`), the kind rules and deny lists (`deniedPaths.ts`), read-only identities and operation filters (ADR [0009](0009-platform-identities.md) step 3), dry-run write skipping (`isMutating`), the egress scan (`scanSecrets`), the `Redactor`.
- **Step types today**: `http`, `query` (database platforms, read-only, ADR [0008](0008-database-platforms.md)), `browser`, `ai`, `check`, … No OPC UA or Modbus step exists; `ping` and `tcp` exist as monitor check types only (`shared/src/checkTypes.ts`).
- **The plant registry** documents zones and conduits (IEC 62443-3-2) with direction, protocols and controls, and the OT network diagram dashes data paths that cross zones without a documented conduit ([PLANT.md](../PLANT.md#zones-and-conduits)).
- **Node-RED, Kestra, Windmill:** running Steward's procedures on them is parked ([ROADMAP.md](../ROADMAP.md#ideas-parked)) – they lack dry runs, attestation-style decisions and sealed evidence; Steward calls them over HTTP where they run. Node-RED flows are imported as documentation, their code never run ([ADR 0019](0019-data-collections.md)).
- **Precedent for a narrow listener:** the Teams bot gets a listener of its own (`SM_TEAMS_BOT_PORT`) that serves one route and nothing else ([SECURITY-HARDENING.md](../SECURITY-HARDENING.md#the-teams-bot-listener-preview)).

The goal: Steward can read a device inside a segment **without an inbound path into that segment**, while approvals, secrets policy, evidence and the audit trail stay in Steward.

## Decision

### 1. What the runner is

| Option                                                                                                                                                                         | For                                                                                                                                       | Against                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. A relay**: a tunnel over the runner's outbound connection; Steward speaks TCP to devices through it                                                                       | every check stays in Steward unchanged; any protocol                                                                                      | a generic pivot into the zone – exactly what a conduit must not be; the runner cannot tell a Modbus read from a write; nothing on the plant side limits what Steward (or an attacker in it) does |
| **B. A remote executor of typed operations**: Steward sends one allow-listed operation with its parameters; the runner performs only its I/O and returns the signed raw result | the plant side can limit operations and destinations itself; read-only enforced at the protocol level next to the device; signed evidence | a second program to build, release and run; each operation exists twice (Steward decides, the runner executes)                                                                                   |
| **C. A remote engine**: the runner executes whole processes or segments                                                                                                        | works when Steward is unreachable                                                                                                         | breaks ADR 0011 (journal, single audit writer, secrets in Steward); a second engine with its own evidence; approvals would have to travel                                                        |

_Recommendation:_ **B.** The runner is a **remote transport behind the step modules**, not an engine: the step function still runs in Steward – it builds the request, applies every check, skips writes in dry runs, redacts and records – and hands only the final operation to the runner instead of sending it itself. The runner holds no process, no expression, no journal.

### 2. Connection direction and transport

| Option                                                                                             | For                                                                                                         | Against                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **A. Inbound to the runner** (Steward calls the runner's API in the zone)                          | simplest for Steward                                                                                        | needs the inbound firewall path this record exists to avoid                                                   |
| **B. Outbound from the runner, HTTPS long-poll** (`POST …/poll` held up to 25 s, `POST …/results`) | plain HTTPS through a DMZ forward proxy (`CONNECT`); nothing but Fastify on Steward's side; easy to inspect | a little latency (one round trip per job); many idle connections with many runners                            |
| **C. Outbound WebSocket**                                                                          | lowest latency; one connection                                                                              | upgrades are broken by some industrial proxies and firewalls; reconnect and back-pressure logic on both sides |

_Recommendation:_ **B**, outbound only, on a **listener of its own**: `SM_RUNNER_PORT` (bind `SM_RUNNER_HOST`) serves only `/runner/v1/*` – no cookies, sessions, web app or other routes – like the Teams bot listener. Steward terminates TLS on it itself and **requires a client certificate** (mTLS), so the runner listener can be published through a layer-4 pass-through or reached with `CONNECT` through the DMZ proxy without a TLS-terminating reverse proxy in between. A TLS-inspecting proxy breaks mTLS: the runner host must be exempt from inspection (documented). C may come later behind the same messages if latency matters.

The runner pins Steward's certificate (or CA) from its enrolment bundle; it has **no inbound listener** of its own.

### 3. Enrolment, identity, rotation, revocation

| Option                                                                         | For                                                                 | Against                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **A. Steward's own small CA**, keys in the vault; one-time token → certificate | works in every installation; automatic renewal; revocation is local | one more key to protect                                                                       |
| **B. The company PKI** issues the runner's certificate                         | fits companies with an OT PKI                                       | manual renewal in most plants; Steward must trust a CA that also signs unrelated certificates |
| **C. A bearer token**                                                          | trivial                                                             | a copied token is the runner; no key bound to the host; no signed evidence                    |

_Recommendation:_ **A**, with B as a later option.

- An administrator creates a **runner** (_Settings → Edge runners_, step-up, new control point `runner.enrol`): name, site and zone (if the plant registry is on), allowed operations and destinations (section 4). Steward shows an **enrolment bundle** once: Steward's runner URL, its certificate fingerprint and a one-time token (single use, expires after 24 hours).
- The runner generates its key pair locally (P-256 or Ed25519; in a TPM where the host has one – later), sends a certificate request with the token, and receives a client certificate from Steward's **runner CA** (a key wrapped in `vault.json` like the audit signing key, ADR [0004](0004-vault-with-master-passphrase.md)). Lifetime 30 days; the runner renews over mTLS from day 20. The private key never leaves the runner.
- **Revocation:** Steward is the only party that verifies runner certificates, so it checks its own `edge_runners` table on every request – a revoked or disabled runner is refused at the next poll, no CRL needed. Revoking needs no step-up (like revoking a library key).
- Every enrolment, renewal, revocation and refused connection is audited (`runner.enrolled|renewed|revoked|refused`).

### 4. What a runner may run

Allow-listed **operations**, never code: no scripts, no shell, no browser, no AI, no JSONata on the runner (expressions are evaluated in Steward on the returned result).

| Operation     | Phase | What it does                                                                                   |
| ------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `ping`, `tcp` | 1     | reachability, as the monitor check types                                                       |
| `http.read`   | 1     | `GET`/`HEAD` with headers and credentials of the step; redirects only within the same origin   |
| `opcua.read`  | 2     | read attributes and browse; no write, no method call                                           |
| `modbus.read` | 2     | function codes 1–4 only (coils, discrete inputs, holding and input registers)                  |
| `sql.read`    | 2     | a query of a database platform under ADR 0008's rules (read-only session, the statement check) |
| writes        | 3     | `http` writes, OPC UA writes, Modbus 5/6/15/16 – only after a separate decision                |

**Two keys.** What a runner executes is the **intersection** of two lists:

1. **Steward's list** on the runner record: operations and destinations (hosts, CIDRs, ports), changed by administrators with a step-up and audited;
2. **the runner's local list** in its configuration file on the edge box, owned by the plant (OT engineering), not editable from Steward.

A Steward that is compromised, or a wrong setting in it, cannot make the runner read a device the plant did not list, nor write anything. The runner refuses with a signed refusal (`RUNNER_NOT_ALLOWED`) that Steward records.

**Routing is per platform, not per step.** A platform (and a monitor `ping`/`tcp`/`http` check) may say **_reached through runner_** "Hall 2 runner". Process definitions do not change: a step on that platform's slot goes through the runner. Address safety and the outbound policy are checked in Steward as today and again on the runner against its lists (link-local and cloud-metadata addresses refused there too).

### 5. How secrets reach the runner

| Option                                                        | For                                                 | Against                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| **A. Per job, sealed to the runner's key**, valid for one job | nothing stored on the runner; Steward's rules apply | the credential is in clear in the runner's memory during the job              |
| **B. Stored on the runner** (local configuration)             | works without Steward's vault                       | unmanaged copies on edge boxes, outside Steward's seal, rotation and evidence |
| **C. The runner fetches from the PAM itself**                 | no secret passes through Steward                    | a PAM path into the OT zone; the runner needs its own PAM identity            |

_Recommendation:_ **A.** A job carries only the credentials its step needs (resolved by `getConnection`, or checked out per ADR [0022](0022-privileged-access-checkout.md)), encrypted to the runner's public key (ECDH-ES + AES-256-GCM, JWE-style) together with the job id, the run, the allowed origins of the credential, a nonce and an expiry of 60 seconds. The runner decrypts in memory, uses the credential only towards those origins (the egress rule of `credentialsAllowed`, enforced again on the runner), never logs or stores it, and drops it after the job. Where a platform signs in with OAuth and its token URL is reachable from Steward, Steward obtains the token and sends **the token**, not the client secret.

### 6. Evidence

- The runner signs every result with its key: job id, run id, step key, attempt, runner id and certificate fingerprint, the operation and its destination, a digest of what was sent (credentials replaced by their slot names), the answer (status, headers, body – or its digest when large), start and end on the runner's clock, and the job's issue time from Steward.
- Steward verifies the signature against the runner's current certificate, checks the clock difference (more than 60 s → the step is marked _runner clock off_), applies the `Redactor` and records the step as today. The step's output gains `runner: { id, name, certificate, signature }`; the protocol hash covers it; run reports and evidence packs show "read through runner _Hall 2_ (zone _Production cells_, conduit _Cells to DMZ_)" and include the runner's certificate chain.
- A refused or failed job is recorded with the runner's signed reason.

### 7. Offline and queueing

- A job waits for its runner at most the step's timeout (default 60 s, the step can set more). A runner that does not poll in time fails the step with `RUNNER_UNREACHABLE`; retries follow the step's retry settings. Steward does **not** queue jobs beyond that: a run's step needs an answer now, and an old job must not run hours later.
- A result the runner could not deliver is kept **in memory** until Steward acknowledges it (at most 10 minutes), then dropped. Reads may be repeated; writes (phase 3) will need at-most-once with the job id as idempotency key, as ADR 0011's invariant 3 requires.
- Steward restarts: open jobs are abandoned; a run found `running` becomes `interrupted` (ADR 0011). The runner drops jobs whose expiry has passed.
- Store-and-forward of **monitor** results while Steward is unreachable (a ping series, buffered locally) is a later phase.
- Steward shows each runner's last poll, version, certificate expiry and queue; a monitor check type `runner` (alive) makes a silent runner visible, like the gateway liveness check of ADR [0021](0021-monitor-states.md).

### 8. Updates and packaging

- **No silent update** ([ADR 0024](0024-signed-releases.md)): Steward shows "runner version x, y available" and whether the protocol version is still supported (Steward accepts the current and the previous runner protocol). Plant staff update through their own process; a runner Steward no longer supports is refused with a clear message.
- **Packaging** (_Recommendation_): the runner is a Node.js single executable built like the desktop app (`scripts/build-exe.mjs`), from the same repository and release pipeline, with build provenance and SBOM (ADR 0024) – one toolchain, and the operation code (address checks, OPC UA and Modbus clients) shared with Steward. Shipped as a **container image** and a **single binary** for Windows (as a service) and Linux (systemd unit). An **Industrial Edge app** (IE apps are container based) later. A Go binary would be smaller but means a second language and the checks written twice.
- The runner writes a local log of jobs (ids, operation, destination, outcome – never credentials or answers) for the plant's own review.

### 9. The engine boundary

The runner sits **below** `StepContext`, not behind `RunEngine`. ADR 0011 holds unchanged: the step module decides and records; `platformRequest` gets a transport (`direct` or `runner:<id>`) chosen from the platform. Secrets still never enter an engine's history; the journal, the protocol hash and the single audit writer stay in the active instance. Test runs answer from recordings and never contact a runner; dry runs skip writes in Steward before a job is built. The golden hashes of the engine contract tests do not change.

### 10. Node-RED, Kestra, Windmill as runners

| Option                                                                                      | For                                                   | Against                                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. A Node-RED node package** that polls Steward and executes jobs in an existing Node-RED | many plants already run Node-RED next to the machines | Node-RED runs arbitrary function nodes, keeps its own credential store, is edited by others and signs nothing – none of the guarantees of sections 4–6 can be given |
| **B. Steward's own runner only**; Node-RED, Kestra and Windmill stay targets                | one small, auditable program with the two-key rule    | one more box (or container) per segment                                                                                                                             |

_Recommendation:_ **B.** A Node-RED instance in the zone is reached **through** the runner as an HTTP platform, as Steward reaches it today where it can; its flows stay documentation (ADR 0019). This keeps the parked decision on Kestra, Windmill and Node-RED.

### 11. IEC 62443: the runner as a conduit endpoint

- With the plant registry on, a runner is linked to its **site and zone** (the zone its host is in). Its connection to Steward is a **conduit** from that zone to the zone where Steward runs (typically the enterprise network or the industrial DMZ), direction _from the runner's zone_, protocol `https tcp/<SM_RUNNER_PORT>`, controls _mTLS, outbound only_. _Create conduit for this runner_ proposes it (through change sets where the site uses them, ADR [0020](0020-plant-change-sets.md)).
- Destinations of a runner outside its own zone must cross a **documented conduit**; otherwise the runner page and the OT network diagram show the path dashed in orange, like any data path without a conduit. Steward warns, it does not refuse (the plant registry is documentation).
- Without the plant registry, a runner has a free-text location.

## Security analysis

- **No inbound path into the zone.** The runner only connects out, to one host and port; there is no listener on the edge box.
- **No pivot.** No tunnel, only typed operations; read-only enforced by the runner at protocol level (Modbus function codes, OPC UA services); the plant's local list caps what Steward can ask (two keys).
- **Stolen runner key or certificate:** the thief can poll that runner's jobs (credentials for its listed destinations, each sealed for one job) and send forged results. Mitigations: revocation at the next poll, 30-day certificates, keys generated on the box (TPM later), results checked against job ids and expiry, jobs only for that runner. The host itself must be hardened – the docs give a short list.
- **Compromised Steward:** can ask for reads the local list allows, and receives their answers – no writes in phases 1–2, no destinations the plant did not list.
- **Replay and injection:** jobs carry nonces and a 60 s expiry and are bound to the runner's key; results are bound to the job; a result for an unknown or expired job is refused.
- **Denial of service:** rate limits per runner on the listener; body limits per operation; a runner serves at most N jobs at once (configurable on the runner).
- **Evidence integrity:** signatures by a key that never left the runner; the runner's certificate chain in the evidence pack; Steward's audit chain records verification.
- **Supply chain:** runner releases are signed and attested like Steward's (ADR 0024); no auto-update.

## Migration and rollout

Nothing changes for existing platforms; runners are opt-in. _Recommendation – phases:_

1. **Read-only reachability:** enrolment, CA, the runner listener, `ping`, `tcp`, `http.read`; platforms and monitor checks _reached through runner_; signed results in the protocol; runner liveness check; container and Linux binary.
2. **Plant reads:** new step types `opcuaRead` and `modbusRead` (usable directly or through a runner), `sql.read` through a runner; plant registry links (zone, conduit); Windows service; credentials checked out per ADR 0022 sealed to the runner.
3. **Writes, by a separate decision:** write operations only with an approval in the run, the local write list, at-most-once delivery; WebSocket transport; Industrial Edge app; store-and-forward for monitors.

## Test strategy

- **Protocol:** enrolment with a used, expired or wrong token; renewal; revocation refused at the next poll; a certificate from another CA refused; a request on the main port refused (runner routes exist only on `SM_RUNNER_PORT`).
- **Two keys:** an operation or destination missing from either list is refused with a signed reason; Modbus write codes and OPC UA writes are refused by the runner even when Steward's list is edited in the database.
- **Secrets:** the sealed job opens only with the runner's key; an expired or replayed job is refused; a credential sent to an origin outside the job's allowed origins is refused by the runner; no credential appears in the runner's log, Steward's protocol or error reports (scan as in ADR 0022).
- **Evidence:** a tampered result (body, step key, runner id) fails verification and the step; clock skew is flagged; the protocol hash covers the runner fields.
- **Failures:** runner offline → `RUNNER_UNREACHABLE` after the timeout; Steward restart with open jobs → `interrupted` run, expired jobs dropped by the runner.
- **Engine contract tests** unchanged; a test transport (in-process runner) runs the http step suite through the runner path.
- **Simulated devices** for the demo and tests: an OPC UA server and a Modbus TCP server with read and write counters (writes must stay at 0).
- **Packaging smoke tests** in the release workflows, as for the desktop executables.

## Consequences

- Devices inside OT zones become readable by procedures and monitors without opening inbound firewall paths, with the runner documented as a conduit endpoint.
- Evidence gains a second signature: what the runner saw, signed where it saw it.
- A second program to release, support and keep compatible; edge boxes to harden and update by hand.
- New step types for OT protocols, first read-only.
- Revisit when plants ask for writes, when latency of long-poll matters, or when a company PKI must issue runner certificates.

## Decided (November 2026)

The owner took the recommended answer to every open question ("go with your recommendation if it fits Steward's purpose, architecture, UI/UX and best practices"), decided on 2026-11-10:

1. **What the runner is:** a remote executor of allow-listed operations – not a relay or tunnel, not a remote engine; control and state stay in Steward.
2. **Transport:** HTTPS long-poll with mTLS on its own listener; WebSocket only if long-poll proves too slow.
3. **Runner certificates:** Steward's own runner CA, 30-day certificates renewed automatically.
4. **Local allow-list on the runner (two keys):** required – an operation runs only when Steward's list and the runner's own list both allow it.
5. **Routing:** per platform and monitor check ("reached through runner"), not per step in the process.
6. **Packaging:** a Node.js single executable and a container built from Steward's repository.
7. **Node-RED as a runner:** no; Node-RED is a target reached through the runner.
8. **Phase 1 scope:** `ping`, `tcp` and `http.read`; OPC UA and Modbus reads come in a later phase.
