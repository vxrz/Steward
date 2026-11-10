# 0022. Privileged access: credentials checked out from a PAM vault

- **Status:** Proposed – everything marked _Recommendation_ is open to change; the questions for the owner are at the end
- **Date:** 2026-11-09
- **Since:** planned for 0.14 – the PAM part of step 4 of platform identities ([ADR 0009](0009-platform-identities.md#migration-and-rollout-plan))

## Context

ADR [0009](0009-platform-identities.md) gives a platform several identities. A **privileged** identity needs a step-up to be used and, where a process or the policy asks, a start approval by a second person. Its credentials are still **stored** in Steward's vault ([ADR 0004](0004-vault-with-master-passphrase.md)) like every other identity's: an administrator's password for a database, a domain account, a cloud admin key – valid all the time, rotated by hand, recorded in the credentials register.

Companies that run a PAM vault want the opposite: privileged credentials live **only** in the PAM, are checked out for a task, checked in afterwards and rotated by the PAM. A copy in Steward is exactly what their PAM policy forbids. ADR 0009 reserved the place for this and asked for its own record:

- `platform_identities.credential_source` exists (migration `platforms-005-identities`, `server/src/migrations/platforms.ts`), is part of the identity seal (`server/src/platforms/integrity.ts`) and is always `NULL` today.
- _Decided after review_, question 4 of ADR 0009: a **separate identity of the vault platform**, flagged _checkout_, reads the value; it may only read the listed secret ids; the value endpoint is allowed only for it, from Steward's own code, never from steps or MCP; values stay in memory for the run.

What the code does today:

- **The PAM Steward knows** is IBM Security Verify Privilege Vault 12.0, the IBM edition of Delinea Secret Server (platform kind `privilege-vault`, `server/src/pvault/`, [IBM-PAM.md](../IBM-PAM.md)). Steward reads metadata only: hygiene, access reviews, the credentials register link, privileged-use evidence from each secret's audit (`VIEW`, `CHECKOUT`, `CHECKIN`, … with `ticketNumber`). It signs in with the OAuth2 password grant and a dedicated `steward-reader` account that may **list**, never **view**.
- **The deny list** (`server/src/platforms/deniedPaths.ts`) refuses `/secrets/{id}` and every sub-resource but `summary`, `audits` and `state` – for every request to the vault's origin, whichever platform sends it, on every redirect hop – and `stripValues` removes `itemValue`, `password`, `privateKey`, … from every answer. `server/test/privilege-vault.test.ts` checks against the simulated vault (`server/src/mock/mockPrivilegeVault.ts`) that the value endpoints are never called.
- **A precedent for "only Steward's own code"**: `ownCall(kind, fn)` (an `AsyncLocalStorage` scope in `deniedPaths.ts`) lets only Steward's data contract tests call `/test` and `/lint`; steps, MCP and monitors are refused the same paths.
- **Resolving credentials**: `getConnection(platformId, identityId)` (`platforms/service.ts`) checks both seals and decrypts `secrets`; `resolveBindings` (`engine/runner.ts`) calls it at run start and again for queued and resumed runs. The `Redactor` (`engine/redact.ts`) masks registered values and their encodings; the egress scan (`scanSecrets`, `steps/outbound.ts`) refuses a binding's credential anywhere but its own slot and origins (`run.secret_refused`). `tokenCache`, `awsCache` (`platforms/http.ts`) and the database pools (`dbms/pool.ts`) are kept **per identity**, across runs.
- **The engine boundary** ([ADR 0011](0011-engine-boundary.md)): secrets stay in Steward whatever the engine; an engine never receives a credential.
- **Non-goals** ([ROADMAP.md](../ROADMAP.md#non-goals), ADR 0004): Steward is no secret store for others and does not rotate platform credentials itself. This record keeps both: Steward stores **less** (nothing, for these identities), and rotation stays the PAM's.

### What the vaults offer (public documentation checked)

| Vault                                | Sign-in of an application                                                                                                                                | Getting a value                                                                                                                                                  | Check-in, lease, rotation                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delinea Secret Server / IBM PV       | `POST /oauth2/token` (password grant, as today)                                                                                                          | `POST /api/v1/secrets/{id}/check-out`; `POST /api/v1/secrets/{id}/restricted/fields/{slug}` with `comment`, `ticketNumber`, `forceCheckIn`, `noAutoCheckout` [1] | `POST /api/v1/secrets/{id}/check-in` [1]; check-out duration and _change password on check-in_ are settings of the secret's policy (_assumption, to confirm on 12.0_) |
| HashiCorp Vault / OpenBao            | `POST /v1/auth/approle/login` (`role_id`, `secret_id`; `secret-id-num-uses`, `secret-id-ttl`, `secret-id-bound-cidrs`), or `POST /v1/auth/jwt/login` [2] | KV v2 `GET /v1/<mount>/data/<path>`; dynamic: `GET /v1/database/creds/<role>` returns `lease_id`, `lease_duration`, `renewable` [2]                              | `POST /v1/sys/leases/renew`, `POST /v1/sys/leases/revoke` [2]; dynamic credentials are created per request and revoked at lease end – the strongest model             |
| CyberArk Central Credential Provider | application id plus client certificate (or allowed machine)                                                                                              | `GET /AIMWebService/api/Accounts?AppID=…&Safe=…&Object=…` with an optional `Reason` [3]                                                                          | no check-in call (_assumption_): exclusive use and one-time passwords are policies of the account in the vault                                                        |
| CyberArk Conjur                      | `POST /authn[-<type>]/<service>/<account>/<login>/authenticate`                                                                                          | `GET /secrets/<account>/variable/<id>` [4]                                                                                                                       | none; rotation by Conjur rotators                                                                                                                                     |
| Azure Key Vault                      | Entra ID token for `https://vault.azure.net` (_from memory, not checked here_)                                                                           | `GET {vault}/secrets/{name}/{version}?api-version=…` (_from memory_)                                                                                             | none: a secret store, not a PAM (no checkout, no exclusive use)                                                                                                       |

Sources: [1] the community PowerShell module for Secret Server, `Get-TssSecretField.ps1`, `Open-TssSecret.ps1`, `Close-TssSecret.ps1` (<https://github.com/thycotic-ps/thycotic.secretserver/tree/main/src/functions/secrets>), the same source [IBM-PAM.md](../IBM-PAM.md#endpoints-and-sources) uses; IBM's own 12.0 documentation was not reachable from where this was written. [2] OpenBao's API documentation (`website/content/docs/api/auth/approle.mdx`, `auth/jwt.mdx`, `secret/kv/kv-v2.mdx`, `secret/databases/index.mdx`, `system/leases.mdx` in <https://github.com/openbao/openbao>); OpenBao is the MPL-licensed fork of HashiCorp Vault with the same API. HashiCorp's own site (developer.hashicorp.com) was not reachable – the paths are assumed identical. [3] CyberArk's Ansible collection, `plugins/modules/cyberark_credential.py` (<https://github.com/cyberark/ansible-security-automation-collection>). [4] `conjurapi/requests.go` of <https://github.com/cyberark/conjur-api-go>. Everything marked _assumption_ is checked against a real installation before its connector is built.

## Decision

### 1. Where a privileged credential comes from

| Option                                                                             | For                                                                                                  | Against                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **A. Stored in Steward's vault** (today)                                           | works offline from the PAM; nothing new                                                              | a standing copy of the most powerful credentials; rotation by hand; violates the PAM policies of the companies that ask |
| **B. Checked out per run** from the PAM, held in memory, checked in at the end     | no copy at rest; the PAM's audit, exclusive use and rotation on check-in apply; works with every PAM | the run depends on the PAM; one more failure mode; check-in can fail                                                    |
| **C. Dynamic credentials** – the PAM creates a short-lived account per run (lease) | the credential exists only for the run; nothing to rotate                                            | only vaults with a secrets engine for the target (HashiCorp/OpenBao database, cloud engines); most OT targets have none |

_Recommendation:_ **B as the model, C as a variant of the same interface** where a vault offers it. An identity has a **credential source**: `vault` (stored, today's behaviour, `credential_source = NULL`) or `pam` (checked out). An identity with source `pam` has **no stored secrets**: saving secrets on it is refused (`IDENTITY_SECRETS_FROM_PAM`), and switching an identity to `pam` deletes its stored blob in the same transaction (audited; a step-up `access.grant`, since the change decides where the credential comes from).

`credential_source` (sealed with the identity, as reserved in ADR 0009):

```json
{
  "kind": "pam",
  "vaultPlatformId": "pl_…",
  "vaultIdentityId": "pi_…",
  "secret": { "id": "1234", "name": "\\Privileged\\db-prod-admin" },
  "fields": { "username": "username", "password": "password" },
  "hold": "whileRunning"
}
```

`fields` maps the vault's field slugs to the identity's credential keys (the names its `auth` expects). `secret.name` is shown and audited; the id is what is checked out.

### 2. Which account reads the value

As decided in ADR 0009: the vault platform gets a second identity flagged **checkout**, separate from the metadata reader. In the vault it is its own account (`steward-checkout`) with _View_ (and check-out) on exactly the secrets privileged identities name – nothing else. Steward adds its own limit on top:

- A request to a value endpoint (`check-out`, `check-in`, `restricted/fields/…`; for HashiCorp `…/data/…`, `…/creds/…`, `sys/leases/…`) passes the deny list **only** inside the new scope `pamCall(vaultIdentityId, secretIds, fn)` – the `ownCall` mechanism, keyed by the checkout identity and the secret ids the calling identity's `credential_source` names. Steps, the request explorer, MCP, monitors, recordings and every other caller stay refused exactly as today; a checkout identity used anywhere else is refused (`IDENTITY_CHECKOUT_ONLY`).
- The checkout identity is **closed** (no access list entries are offered), privileged, MCP off, and cannot be the default identity. Only platform managers configure it, with a step-up.
- `stripValues` still runs on every answer of the vault platform; the checkout code reads the fields it needs from the raw answer **before** that and never hands the answer to a logger, the run log or an error report.

### 3. When a credential is held

| Option                                                                                                                                                               | For                                                   | Against                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **A. Whole run**: check out at start, check in at the end                                                                                                            | simple; one checkout per run                          | a run that waits a day for a decision or a manual step holds the credential a day                                |
| **B. While running**: check out at the first step that uses the slot, check in when the run ends **or starts waiting for a person**, check out again when it resumes | held only while steps execute; matches "just in time" | more checkouts; a credential may change (rotation on check-in) between two parts of one run – which is the point |
| **C. Per step**                                                                                                                                                      | shortest hold                                         | a login per step; tokens and sessions cannot be reused within a run; many PAM audit records                      |

_Recommendation:_ **B** (`hold: "whileRunning"`). "Waiting for a person" is a user task, a manual step, a start or step approval, a debug pause and a `wait` step longer than five minutes. A run that cannot check out again after a wait fails the next step with the reason; it is never resumed with a stored copy.

**Caches follow the hold.** Tokens obtained with a checked-out credential (OAuth logins, AWS sessions) are cached **per run** for a `pam` identity (key `platformId:identityId:runId` instead of the identity alone), and database pools of such an identity are per run and closed at check-in. A token from run A is never reused by run B, and nothing obtained with the credential outlives the hold – except what the target system itself keeps (a session token with its own lifetime), which the docs say.

### 4. The first connector

| Option                                                    | For                                                                                                                                                                                                                                                                                           | Against                                                                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Delinea Secret Server / IBM Verify Privilege Vault** | the PAM the owner runs; Steward already has the kind, its sign-in and token refresh, the simulated vault, the deny list and the audit reader – so a checkout can be correlated with the existing privileged-use evidence; real check-out/check-in with exclusive use and rotation on check-in | checkout semantics partly in the secret's policy, not the API (to confirm on 12.0); no request id in the answer (correlation by comment)             |
| **B. HashiCorp Vault / OpenBao**                          | the cleanest model: leases with ids, renew and revoke, dynamic database credentials (option 1C), AppRole with use limits and CIDR binding                                                                                                                                                     | no known installation among Steward's users; HashiCorp Vault is under the BSL since 2023 (OpenBao is not); a new kind, sign-in and mock from scratch |
| **C. CyberArk CCP**                                       | common in large companies; one GET                                                                                                                                                                                                                                                            | no check-in in the API; client certificate per application; no simulator; no installation known                                                      |

Azure Key Vault and Conjur are secret stores without checkout; they fit source `vault`-like use (fetch at start) and are not candidates for the first PAM connector.

_Recommendation:_ **A, Secret Server / IBM Verify Privilege Vault**, behind a small interface so B follows without changes elsewhere:

```ts
// server/src/platforms/pam/connector.ts
interface PamConnector {
  kind: string; // 'privilege-vault' first, 'hashicorp-vault' later
  describe(ref: SecretRef): Promise<{ name: string; checkoutEnabled: boolean; changesOnCheckIn: boolean | null; requiresApproval: boolean }>;
  checkout(ref: SecretRef, why: CheckoutContext): Promise<{ values: Record<string, string>; vaultRef: string; expiresAt: string | null }>;
  renew?(vaultRef: string): Promise<{ expiresAt: string | null }>;
  checkin(vaultRef: string, why: CheckoutContext): Promise<void>;
}
```

`CheckoutContext` carries the run id, process, the person who started or approved, and a ticket number when the process names one (an input chosen in the slot settings). Secret Server gets `comment: "Steward run <runId> – <process> – started by <user>, approved by <user>"` and `ticketNumber`. `describe` reads the summary the register link already reads (`checkOutEnabled`, `requiresApproval`; _change password on check-in_ to be found on 12.0).

### 5. Failure modes – never a fallback

- **Vault unreachable, sign-in refused, secret locked by someone else, approval required in the PAM:** the step that needs the credential fails with `PAM_CHECKOUT_FAILED` and the vault's reason (`unreachable`, `signInRefused`, `checkedOutByOther`, `approvalRequired`, `refused`). A scheduled or triggered run fails the same way and notifies its owner. **There is no stored copy to fall back to**: an identity with source `pam` has none (section 1), and no code path reads one.
- _Recommendation:_ a secret that needs an **approval inside the PAM** is refused for checkout in the first version (`approvalRequired`, shown on the identity when it is saved): Steward's start approval is the four-eyes check; waiting for a second approval in another system would stall runs without showing why.
- **Check-in fails:** the values are dropped from memory anyway; Steward retries with back-off for an hour, notifies administrators (`pam.checkin_failed`), and the PAM's own check-out expiry is the backstop. The run's result does not change.
- **Steward stops or crashes while holding a checkout:** open checkouts are recorded without values in `pam_checkouts`; after the next unlock Steward checks each one in (`pam.checkin_recovered`). A run found `running` becomes `interrupted` (ADR 0011); its resume checks out again.
- **Vault locked** (Steward's own): nothing that needs a credential runs, as today.
- **The checkout identity's own sign-in password** is a stored credential of the vault platform – the one secret this design keeps. It can view only the listed secrets; the docs ask for an application account without interactive use, as for the reader.

### 6. Break-glass

| Option                                                                                     | For                                                                         | Against                                                                                                          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **A. The PAM's own break-glass**, outside Steward; the work is documented as a manual step | no second path to privileged credentials; the PAM's emergency process holds | Steward cannot automate the work while the PAM is down                                                           |
| **B. A sealed emergency credential in Steward**, behind step-up and four-eyes              | runs work when the PAM is down                                              | the standing copy option 1A removes, under another name; the first thing an attacker targets                     |
| **C. A one-time credential typed in by a person** for one run, four-eyes, memory only      | no copy at rest; automation still possible in an emergency                  | a person handles the raw credential (they have it from the PAM's break-glass anyway); a new input path to secure |

_Recommendation:_ **A** in the first version: when the PAM is down, people use its break-glass and document what they did with a manual step ([MANUAL-STEPS.md](../MANUAL-STEPS.md)) in the run, with evidence files and a second person's verification. C is possible later as control point `platform.breakGlass` (step-up, four-eyes `required`, audited `pam.break_glass`, value never stored); see the open questions.

### 7. Audit and evidence correlation

- Audit entries on the identity's platform (`entityType: 'platform'`, `details.identityId`, never a value): `pam.checked_out` (run, step key, vault platform, secret id and name, `vaultRef` – the lease id or Steward's checkout id –, expiry), `pam.checked_in`, `pam.checkout_failed` (reason), `pam.checkin_failed`, `pam.checkin_recovered`.
- The run protocol and `runs.bindings` show "Database prod · Admin (from PAM: \Privileged\db-prod-admin)" and the hold times. The protocol hash covers these entries; it never covers a value.
- **Run ↔ vault:** HashiCorp returns `request_id` and `lease_id` – stored as `vaultRef`. Secret Server returns no request id (_assumption_): the comment and ticket number carry the run id into the vault's audit, and the privileged-use reader (`pvault/`, evidence packs) matches `CHECKOUT`/`CHECKIN` records of the checkout account to runs by the run id in the comment, falling back to account and time window. The evidence pack's `privileged-use/` section gains a column _Steward run_; a vault checkout by the checkout account with **no** matching run is listed as a finding.

### 8. The value never touches disk or logs

- Values live in the run's in-memory binding only. They are never written to `run_steps`, `run_logs`, artifacts, `runs.bindings`, the journal, `pam_checkouts`, the audit log, settings, backups, migration packages or error reports. ADR 0011 holds: an engine never receives them.
- At checkout they are registered with the run's `Redactor` (with their encodings) and the error-report scrubber, and treated by the egress scan as the identity's credentials: allowed only to the platform's own origins, on its own slot (`SECRET_OTHER_SLOT` otherwise).
- At check-in the binding's values are replaced, its caches and pools for the run cleared. JavaScript cannot zero a string; the references are dropped and the memory is reclaimed by the garbage collector. The hardening guide says so and asks for no core dumps and no swap on the host ([SECURITY-HARDENING.md](../SECURITY-HARDENING.md)).
- Test runs (recordings) never check out. Dry runs **do** check out (they sign in and read), unless the person picks another identity, as ADR 0009 allows.

### 9. Where `pam` identities may be used

- **Runs** (started, scheduled, triggered, sub-processes) – after the step-up and start approval of ADR 0009 step 4, which come first: nothing is checked out for a run that waits for its start approval.
- **Test checkout** on the identity page (managers, step-up): check out, sign in to the platform once, check in – audited like a connection test.
- **Not** in the first version: monitors and Steward's background readers (a monitor every minute would hold a privileged credential permanently – use a read-only identity), the request explorer, MCP approved writes. Each refuses a `pam` identity with `IDENTITY_PAM_RUNS_ONLY`.

### 10. Data model, code

- Migration `platforms-0NN-pam-checkouts` (additive): `pam_checkouts (id, run_id, identity_id, vault_platform_id, vault_identity_id, secret_id, vault_ref, checked_out_at, expires_at, checked_in_at, state, error)` – no value column. Classified in `migration/tables.ts` as history (not moved); `credential_source` already travels with identities.
- `server/src/platforms/pam/` (connector interface, `secret-server.ts`, `checkout.ts` with the hold logic), `deniedPaths.ts` (`pamCall` scope), `getConnection` (source `pam`: no decrypt, a binding that checks out on first use), `engine/runner.ts` (hold and release around waits; release in `cancel`, `drain`, `interruptBusy`), `platforms/http.ts` and `dbms/pool.ts` (per-run keys), `pvault/` (correlation), the identity page and run dialog, [IBM-PAM.md](../IBM-PAM.md) (a second account and its rights), [ASSURANCE.md](../ASSURANCE.md).

## Security analysis

- **Gains:** no privileged credential at rest in Steward (database, backups, migration packages); every use is a checkout in the PAM's audit, correlated to a run with its approver; rotation on check-in invalidates what any run, log or memory dump might have kept.
- **New exposure:** the checkout account can view the listed secrets. Mitigations: an account with no other rights and no interactive use; Steward's own allow list of secret ids, sealed with the identity (a database edit of `credential_source` breaks the seal and is refused); value endpoints only inside `pamCall`; the deny list unchanged for every other caller.
- **Steward compromised while running:** an attacker in the process can wait for checkouts and read memory – as with stored credentials today, but only while runs hold them. The PAM's audit then shows checkouts without matching approved runs (section 7).
- **Database administrator:** cannot point an identity at another secret (seal), cannot read a value (none stored).
- **Replay of a run:** a resumed run checks out again; the PAM decides again.
- **Misuse through a process:** a designer cannot read the value: `$secret()` on a `pam` slot is masked like any secret, and the egress scan refuses it anywhere but the platform's origins; a privileged slot still needs step-up and, where set, a second person.

## Migration and rollout

1. **0.14, with step 4:** the connector interface, the Secret Server connector, `credential_source` in the UI and API, `pam_checkouts`, hold and release, correlation in the privileged-use reader. Opt-in per identity; nothing changes for existing identities.
2. **Later:** HashiCorp Vault / OpenBao (KV and dynamic database credentials with leases); CyberArk CCP if a user asks; break-glass option C if the owner wants it; `pam` identities for the request explorer.
3. Docs: [IBM-PAM.md](../IBM-PAM.md) (the checkout account and how to verify it can view only its secrets), [PLATFORMS.md](../PLATFORMS.md) (identities from a PAM), [SECURITY-HARDENING.md](../SECURITY-HARDENING.md), [ROADMAP.md](../ROADMAP.md) non-goal wording ("does not store or rotate … – it can check out its own privileged credentials from a PAM").

## Test strategy

- **Simulated vault** (`mockPrivilegeVault.ts`) gains check-out, check-in and the restricted field endpoint, answering only the checkout account, with exclusive locks, expiry, a "change on check-in" mode and a failure switch per call.
- **No value at rest:** a run with a `pam` identity, then a scan of the whole database, the data folder, the log output, error reports and an exported migration package for the value and its encodings – none found.
- **Deny list:** the value endpoints stay refused for steps, the explorer, MCP, monitors and recordings, also inside a run that holds a checkout; `pamCall` with a secret id the identity does not name is refused.
- **Failures:** vault down, sign-in refused, locked by another user, approval required → the step fails with the reason and **no** other credential is tried; check-in failure → retries and the notification; crash with an open checkout → check-in after the next unlock.
- **Hold:** check-in when a user task starts and checkout again after the decision; a token cached in run A is not used by run B; a database pool is closed at check-in; cancel, drain and interrupt check in.
- **Egress:** a checked-out password sent on another slot fails with `SECRET_OTHER_SLOT`.
- **Evidence:** the comment carries the run id; the privileged-use reader matches checkouts to runs and flags an unmatched one.
- **Engine contract tests** unchanged (golden hashes: test runs never check out).

## Consequences

- Companies with a PAM can keep privileged credentials out of Steward entirely, and their PAM audit tells which Steward run used which secret, approved by whom.
- Privileged runs now depend on the PAM's availability. That is intended: a run that cannot obtain the credential the PAM way does not run.
- Steward reads secret values from one kind of platform for the first time; the reversal of "Steward never reads a secret value" ([IBM-PAM.md](../IBM-PAM.md)) is limited to one account, listed secrets and Steward's own code, and the docs must say so plainly.
- Revisit when a second PAM is asked for (the interface is built for it), when monitors need privileged reads, or when the PAM-side approval should be awaited instead of refused.

## Open questions for the owner

1. **First connector:** (a) IBM Verify Privilege Vault / Secret Server – recommended, it is the PAM in use and Steward already speaks to it; (b) HashiCorp Vault / OpenBao; (c) CyberArk CCP.
2. **How long a credential is held:** (a) while the run executes steps, checked in during waits for people – recommended; (b) the whole run; (c) per step.
3. **A secret that needs an approval in the PAM:** (a) refused for checkout; Steward's start approval is the second person – recommended; (b) Steward waits for the PAM approval (up to the start approval's 24 hours).
4. **Break-glass:** (a) only the PAM's own break-glass, documented as a manual step – recommended; (b) also a one-time credential typed in for one run with four-eyes; (c) a sealed emergency credential in Steward.
5. **Dry runs with a `pam` identity:** (a) check out like a real run (they sign in and read) – recommended; (b) never check out; dry runs use the default identity only.
6. **What the vault's audit comment names:** (a) run id, process, starter and approver – recommended, it makes the PAM's audit readable on its own; (b) run id only (fewer personal data in the PAM).
7. **Monitors and background readers with `pam` identities:** (a) not allowed – recommended; (b) allowed with a checkout per check.
