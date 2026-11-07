# Assurance policy

One place that shows and sets **what is enforced where**: which actions need a second person (_four-eyes_) and which need a fresh confirmation of the signed-in person (_step-up_, see [SECURITY-HARDENING.md](SECURITY-HARDENING.md#step-up-re-authentication)) – and evidence an auditor can check: which rules applied during a period and how each event met them (since 0.5.0, #210).

Contents: [Control points](#control-points) · [The effective rule](#the-effective-rule) · [Changing the policy](#changing-the-policy) · [Multi-factor authentication](#multi-factor-authentication) · [What proves what](#what-proves-what) · [The assurance report](#the-assurance-report) · [Limits of single sign-on step-up](#limits-of-single-sign-on-step-up) · [API](#api)

The page is **Settings → Assurance policy** (`/settings/assurance`). Administrators change it; auditors read it, its history and the report.

## Control points

Every action that can require four-eyes and/or a step-up is a **control point** with a stable key (`shared/src/assurance.ts`). The table is kept in sync with the code by `server/test/assurance.test.ts`.

- **Four-eyes:** `baseline` – always (cannot be changed); `optional` – each item decides (its own switch, see _Overrides_), the policy can make it `required` for all; `off` – only where an item asks for it, the policy can make it `required`; `–` – the point has no four-eyes.
- **Step-up:** `baseline` – always (cannot be turned off); `on` – on by default, an administrator can turn it off (with a second administrator); `off` – a new point of 0.5.0, off until an administrator turns it on; `–` – the point has no step-up.
- **Step-up actions** are the actions sensitive routes name (`config: { stepUp: { action } }`, `server/src/auth/step-up.ts`); each maps to exactly one point.

<!-- control-points:start -->

| Control point            | Group     | Four-eyes | Step-up  | Step-up actions                                            | Overrides    | Where                                                                                                                                          |
| ------------------------ | --------- | --------- | -------- | ---------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiToken.create`        | identity  | –         | baseline | `createToken`                                              | –            | POST /api/me/tokens                                                                                                                            |
| `user.create`            | identity  | –         | baseline | `createUser`                                               | –            | POST /api/users (with roles)                                                                                                                   |
| `user.change`            | identity  | –         | baseline | `changeAccount`                                            | –            | PUT /api/users/:id (roles, provider, activating an administrator)                                                                              |
| `user.resetPassword`     | identity  | –         | baseline | `resetPassword`                                            | –            | POST /api/users/:id/reset-password                                                                                                             |
| `team.members`           | identity  | –         | baseline | `changeTeamMembers`                                        | –            | teams: new members or roles, renames to a granted name                                                                                         |
| `access.grant`           | identity  | –         | baseline | `grantAccess`                                              | –            | access lists of platforms, processes, monitors; owning teams; copies with access settings                                                      |
| `sso.providers`          | identity  | –         | baseline | `addSsoProvider`, `changeSsoProvider`, `deleteSsoProvider` | –            | POST/PUT/DELETE /api/sso/providers                                                                                                             |
| `signIn.settings`        | identity  | –         | baseline | `changeSignInSettings`                                     | –            | password sign-in, outbound policy and allow-list, turning four-eyes dismissals off                                                             |
| `vault.passphrase`       | identity  | –         | baseline | `changeVaultPassphrase`                                    | –            | POST /api/vault/passphrase                                                                                                                     |
| `assurance.policy`       | identity  | baseline  | baseline | `changeAssurancePolicy`                                    | –            | PUT /api/assurance/policy, approving a loosening (a second administrator)                                                                      |
| `accessCheck.decide`     | identity  | off       | off      | `decideAccessCheck`                                        | setting      | documenting or dismissing a reconciliation finding                                                                                             |
| `personReview.decide`    | identity  | optional  | off      | `decidePersonReview`                                       | personReview | submitting and approving a person access review                                                                                                |
| `audit.anchoring`        | audit     | –         | baseline | `changeAuditAnchoring`                                     | –            | PUT /api/audit/anchoring, /api/audit/archive                                                                                                   |
| `audit.export`           | audit     | –         | on       | `exportAuditLog`                                           | –            | GET /api/audit/export, audit archives, the assurance report                                                                                    |
| `evidencePack.export`    | audit     | –         | on       | `exportEvidencePack`                                       | –            | POST /api/compliance/evidence-packs                                                                                                            |
| `credentials.export`     | audit     | –         | on       | `exportCredentials`                                        | –            | GET /api/credentials/export.csv                                                                                                                |
| `record.approve`         | records   | baseline  | off      | `approveRecord`                                            | recordType   | approving or rejecting a record (every workflow with an approval)                                                                              |
| `document.reviewOwner`   | records   | baseline  | –        | –                                                          | –            | an approver who wrote a document cannot make themselves its review owner                                                                       |
| `firewallChange.close`   | records   | –         | off      | `closeFirewallChange`                                      | recordType   | closing a record of the type FWC (#208; inert while the type does not exist)                                                                   |
| `run.decide`             | processes | optional  | –        | –                                                          | processStep  | user tasks of runs (selections and approvals)                                                                                                  |
| `library.publishers`     | processes | –         | baseline | `changeTrustedPublishers`                                  | –            | trusting a library publisher or key, removing one, widening its libraries, lifting an expiry ([LIBRARIES.md](LIBRARIES.md#trusted-publishers)) |
| `library.install`        | processes | off       | –        | –                                                          | –            | installing, updating or rolling back a library release ([LIBRARIES.md](LIBRARIES.md#install-update-rollback))                                  |
| `manualStep.verify`      | processes | baseline  | off      | `verifyManualStep`                                         | manualStep   | verifying a manual step (maker–checker)                                                                                                        |
| `duty.skip`              | processes | baseline  | –        | –                                                          | –            | deciding an exception of a service duty                                                                                                        |
| `mcp.write`              | mcp       | optional  | –        | –                                                          | platformMcp  | approving a changing call an AI assistant asked for                                                                                            |
| `mcp.allowWrites`        | mcp       | –         | on       | `allowMcpWrites`                                           | –            | PUT /api/platforms/:id/mcp-gateway (writes on, or fourEyes → confirm)                                                                          |
| `mcp.allowClient`        | mcp       | –         | on       | `allowMcpClient`                                           | –            | POST /api/oauth/authorize (approve)                                                                                                            |
| `ai.budget`              | mcp       | –         | on       | `changeAiBudget`                                           | –            | PUT /api/ai/budgets when it raises a budget or removes its limit ([AI.md](AI.md#limits))                                                       |
| `catalogue.ciaScale`     | catalogue | –         | on       | `changeCiaScale`                                           | –            | PUT /api/catalogue/cia-scale                                                                                                                   |
| `cost.budget`            | catalogue | –         | on       | `changeCostBudget`                                         | –            | PUT /api/costs/budgets when it raises a budget, changes its currency or removes it ([COSTS.md](COSTS.md#budgets))                              |
| `notifications.delivery` | system    | –         | on       | `changeNotificationDelivery`                               | –            | SMTP, Teams/webhook URLs, link base URL, e-mail domains, emergency alert channels                                                              |
| `backup.settings`        | system    | –         | on       | `changeBackups`                                            | –            | PUT /api/backups/settings, /api/backups/passphrase                                                                                             |
| `migration.export`       | system    | –         | on       | `exportMigration`                                          | –            | POST /api/migration/export                                                                                                                     |
| `migration.apply`        | system    | –         | on       | `applyMigration`                                           | –            | POST /api/migration/imports/staged/:id/apply                                                                                                   |
| `plant.mapSource`        | system    | –         | on       | `changeMapSource`                                          | –            | PUT /api/settings/plant/map when it changes where the map's tiles come from (a source, URL, key or file; not _Off_) ([PLANT.md](PLANT.md#map)) |

<!-- control-points:end -->

**The baseline** – the master passphrase, audit anchoring, API tokens, granting access (accounts with roles, roles, team members, access lists, password resets), single sign-on and sign-in settings, and the policy itself always need a step-up; a record, a manual step, a duty exception and a loosening of the policy are never decided by the person who asked. The page shows these rules locked. A policy stored with less (by hand, in the database) is read with the baseline applied.

**Defaults keep 0.4.0's behaviour:** every step-up of 0.4.0 is on with the age `SM_STEP_UP_MINUTES`, no multi-factor requirement, and the new step-up points (approving records, decisions in access checks and person reviews, verifying manual steps, closing firewall changes) are off.

## The effective rule

For one item the rule is the strictest of three: **max(baseline, instance policy, item override)**.

- **Overrides stay where they are:** a process step's _four-eyes_ switch and a manual step's verification (process editor), a platform's MCP mode (off / confirm / fourEyes), a person review's four-eyes switch, the setting _four-eyes dismissals of findings_ (Settings → Catalogue), a record type's workflow (whether it has an approval). The policy page lists every override with its effective rule and a link.
- An override can only add: a process step with four-eyes keeps it when the policy says `optional`; the policy `required` makes every step need a second person. For MCP writes, `required` turns a platform's _confirm_ (the token owner confirms) into _fourEyes_ (an approver other than the token owner).
- **Step-up per point:** on or off, the **age** of the confirmation in minutes (at most `SM_STEP_UP_MINUTES`, which stays the longest), and **multi-factor** (below). A request that reaches several points gets the strictest of them.
- **Requester ≠ approver by identity:** never by the user name alone. The same person is their account, the former names of a moved account (identity aliases, [MIGRATION.md](MIGRATION.md)) and any other account linked to the same single sign-on identity – issuer and `sub` of the ID token (`users.external_sub`), e.g. one person signing in through two providers of one identity provider (`server/src/auth/aliases.ts` `sameIdentity`).

Enforcement goes through one module, `server/src/auth/assurance.ts`: `requireStepUp(points, user, action)` (the step-up hook of every route with `config.stepUp`) and `checkFourEyes(point, requesters, approver)` / `fourEyesRequired(point, itemRequires)` (the services).

## Changing the policy

- **Every change needs a step-up** (baseline of `assurance.policy`) and is audited as `assurance.policy_changed` with the policy **before and after**, the changes, who asked and – for a loosening – who approved.
- **Tightening applies at once:** turning a step-up on, a shorter age, requiring MFA, four-eyes `required`, removing an amr/acr value from the MFA lists.
- **Loosening waits for a second administrator** (down to the baseline at most): turning a step-up off, a longer age, MFA off, four-eyes lowered, a new amr/acr value that counts as MFA. A change that does both applies its tightening now and waits with the rest. The waiting change is shown on the policy page (with _Approve_ / _Reject_ for another administrator; the one who asked can withdraw it) and on System status. It takes effect on approval – on top of whatever changed in the meantime – and **expires after 7 days** (`assurance.policy_change_expired`). One such request at a time. Audited: `assurance.policy_change_requested`, `…_rejected`, `…_withdrawn`, `…_expired`.
- The stored policy is sealed with the vault's integrity key (like single sign-on providers). A policy changed directly in the database does not count: the version named by the audit log applies, and the server logs an error.
- The policy is not moved with a migration package: the target sets its own (a moved policy would bypass the second administrator).

## Multi-factor authentication

Per point, _require MFA_ means: the step-up must show multi-factor authentication.

- A **password step-up** never does. A password session gets `403 ASSURANCE_MFA_REQUIRED` (audited as `assurance.mfa_refused`); the person signs in with single sign-on.
- A **single sign-on step-up** does when the ID token says so: `amr` contains one of the policy's MFA values (default `mfa`, `mca`, `otp`, `hwk`, `swk`, `sc`, `fido`, `ngcmfa`; RFC 8176), or `acr` is one of the policy's acr values – or the provider's own step-up MFA setting (acr values, Entra authentication context) is met. Steward asks the provider for it (the provider's own setting, else the policy's `acr_values`); a confirmation without it is refused with `STEP_UP_MFA_REQUIRED` in the dialog. A session confirmed without MFA is asked again before such an action.
- **Emergency sessions** pass (they needed the server and the master passphrase); every such event is an exception in the report.

## What proves what

Every event at a control point is recorded **in the audit entry the action writes** (`details.assurance`, a list), so it lies in the HMAC chain and under the signed checkpoints ([ADR 0003](adr/0003-hmac-chained-audit-log.md)). A confirmed step-up whose route writes no entry of its own is recorded as `assurance.confirmed`.

| Field                                          | What it says                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `point`, `policyVersion`                       | Which control point, under which version of the policy                                                                                                       |
| `rule`                                         | The effective rule: step-up, its age, MFA, four-eyes                                                                                                         |
| `actor`, `at`, `session`                       | Who, when, and a reference of the session (a hash of the session id – the same for all entries of one session, `auth.step_up` entries carry it too)          |
| `stepUp.method`                                | `password`, `sso`, `sso+mfa`, `emergency` or `notRequired`                                                                                                   |
| `stepUp.confirmedAt`, `authTime`, `amr`, `acr` | When the session confirmed, and for single sign-on what the identity provider said (`auth_time`, `amr`, `acr`, provider)                                     |
| `fourEyes`                                     | Whether a second person was required, who asked (`requesters`), who decided (`approver`), and how they were told apart (`checks`: user, aliases, ssoSubject) |

**Policy history:** every change is an `assurance.policy_changed` entry with the policy after it, so the policy in force at any time is the one after the last authentic such entry before it (`policyAsOf`, `GET /api/assurance/policy/as-of?at=…`, `…/history`).

## The assurance report

_Download the assurance report_ on the policy page (and in the evidence pack dialog: _Include the assurance report_) gives, for a period:

- the **policy in force** at the end of the period (with the baseline marked) and the version at its start, every **change** in the period with who made and who approved it, and every **request to loosen** it with its outcome;
- **per control point** the number of events and how they were confirmed (password, single sign-on, with MFA, emergency, not required) and how many needed a second person;
- the **exceptions**: emergency sign-ins and confirmations by emergency access, refusals and step-ups without MFA where MFA was required, and loosenings with their second administrator.

As PDF/A (branding as the other reports) from `GET /api/assurance/report?from&to&lang` (auditors and administrators, with the step-up of `audit.export`), as JSON with every event and its audit sequence number (`&format=json`), and in evidence packs as `assurance/assurance-report.pdf` and `.json`, listed in the signed manifest (`steward evidence verify` checks them like every file). It is read from the authentic audit entries only; entries that fail their check are counted and left out.

**Control mappings** (examples, see [COMPLIANCE.md](COMPLIANCE.md#how-it-maps-to-the-standards)): ISO/IEC 27001:2022 **A.5.3** segregation of duties (four-eyes by identity, the second administrator for loosening), **A.8.5** secure authentication (step-up, MFA per point), **A.8.32** change management (record approval with step-up, the policy's own change history).

## Limits of single sign-on step-up

- `prompt=login` and `max_age=0` are requests: **whether the provider really asks again is up to it.** Steward checks `auth_time` and refuses an old one, but a provider that sends no `auth_time` cannot confirm at all ([SSO.md](SSO.md#step-up-re-authentication)); Google ignores `prompt=login` and goes by `max_age`.
- **`amr` and `acr` count only when the provider sends them.** Microsoft Entra ID sends `amr` (e.g. `pwd`, `mfa`) and – with an authentication context – `acrs`; Keycloak and Okta send `acr` and/or `amr` depending on their configuration. Without them MFA cannot be shown, and points that require it cannot be confirmed with single sign-on.
- The values are what the provider says; Steward cannot see how the second factor was given. Choose the MFA values and acr values that your provider only issues after a real second factor.
- Hardware keys or WebAuthn as a step-up of Steward's own, and approval chains of more than two people, are not part of this (later, if wanted).

## API

Internal API (`/api`, may change with every release):

| Route                                                  | Who                                      |
| ------------------------------------------------------ | ---------------------------------------- |
| `GET /api/assurance/policy`                            | administrators, auditors                 |
| `PUT /api/assurance/policy`                            | administrators (session, step-up)        |
| `POST /api/assurance/policy/changes/:changeId/approve` | another administrator (session, step-up) |
| `POST /api/assurance/policy/changes/:changeId/reject`  | administrators (session)                 |
| `GET /api/assurance/policy/history`, `…/as-of?at=`     | administrators, auditors                 |
| `GET /api/assurance/report?from&to&lang&format`        | administrators, auditors (step-up)       |

The public API `/api/v1` has no assurance routes: the policy is an administrator's setting of the instance, and auditors take it – with its history and the proofs – from the report and the evidence packs. API tokens cannot do a step-up, so they could not change the policy anyway.
