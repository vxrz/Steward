# Personal data, retention and erasure

This page describes which personal data Steward stores, for how long, and how requests to erase data (GDPR Art. 17) relate to an audit log that must not change. It is information for the controller (your company) and its data protection officer, not legal advice.

## What is stored

| Data | Where | Why | Retention |
| --- | --- | --- | --- |
| Accounts: user name, display name, e-mail, roles, teams, language, last sign-in | `users`, `teams` | sign-in, access control, notifications | until the account is deleted by an administrator (deactivate leavers; SSO accounts are synchronised from the IdP) |
| Sessions: hashed token, IP address, browser (user agent), times | `sessions` | sign-in | until sign-out, at most 7 days |
| Audit log: who did what and when (user name), IP address of sign-ins, summaries and details of actions | `audit_log` | evidence (change management, compliance) | **kept for good** – see below |
| Runs: who started/approved, inputs, step results, logs, screenshots | `runs`, `run_*`, `data/artifacts` | the protocol of a procedure | *Settings → Retention* (runs older than N days are deleted; 0 = keep) |
| Data fetched from platforms (e.g. user lists in an access review) | step results, reports, dashboards | the procedure itself | with the run; dashboards keep the latest dataset and metric history (`SM_METRIC_RETENTION_DAYS`) |
| Notifications | `notifications` | in-app messages | read ones after *Settings → Retention* days |
| Operational log (stdout) | your log system | operations | your log retention |

## Minimisation built in

- **Failed sign-ins**: if the user name belongs to no account, it is *not* stored – it is often a password typed into the wrong field. The audit entry says "unknown user name (ref …)" with a keyed pseudonym that only shows whether attempts repeat. For existing accounts the account's own name is used, never the typed text. Repeated failures are summed up per minute.
- **Secret process inputs** (input type *secret*): stored only encrypted; protocols, reports, the audit log and the API show `***`, and the value is masked in step data and logs.
- **Size limits**: free-text fields in the audit log are capped (longer texts are cut, with their length and SHA-256).
- Error reports and traces (off by default) contain no user names, e-mail or IP addresses (see [ERROR-REPORTING.md](ERROR-REPORTING.md)); traces carry a pseudonym instead of the user name.

## The audit log is immutable – how erasure works

Every audit entry is part of an HMAC chain and of signed checkpoints kept outside the database. Changing or deleting an entry is, by design, detected as tampering – that is what makes the log usable as evidence. Steward therefore never deletes or edits audit entries, and has no function to do so.

Position for erasure requests:

1. **Legal basis and retention**: the audit log is kept to meet legal and contractual obligations and for the establishment, exercise or defence of legal claims (GDPR Art. 6(1)(c)/(f), Art. 17(3)(b) and (e)). Define its retention period in your records of processing (for example the retention period of your change-management evidence, often 6–10 years).
2. **Delete what is not evidence**: deleting a user account removes the profile (name, e-mail, roles, team memberships, sessions); configure run retention so that protocols with personal data from platforms are deleted when no longer needed.
3. **Pseudonymise instead of deleting**, where your policy allows: use neutral, non-speaking user names (e.g. personnel numbers or IdP object ids via the SSO user name claim) so that the audit log identifies a person only together with the mapping kept in your HR/IdP system. Deleting that mapping there effectively anonymises the log without breaking the chain.
4. **When the log itself must go** (end of the retention period): archive an export (*Audit log → Export → JSON with signed checkpoint*) as long as required, then set up a new installation (new database and vault). Partial deletion is not supported.

## Access to personal data

- Auditors and administrators can read the audit log; everyone else only sees entries of runs they may see.
- Exports (CSV, JSON) are audited themselves.
- Credentials are never shown; API tokens are stored as hashes.
- AI assistants (MCP, off by default) receive what their token owner may read – including user names in runs and, for auditors, the audit log – and pass it to the assistant's language model. Decide whether that is acceptable before turning MCP on ([MCP.md](MCP.md)); the first use of each MCP token per day and every platform gateway call are audited.

## Data subject access requests

Search the audit log for the user name (*Audit log → Search*), export the matching entries (CSV), and export the profile from *Users*. Run protocols list the people who started or decided a run.
