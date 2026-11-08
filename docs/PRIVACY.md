# Personal data, retention and erasure

This page describes which personal data Steward stores, for how long, and how requests to erase data (GDPR Art. 17) relate to an audit log that must not change. It is information for the controller (your company) and its data protection officer, not legal advice.

## What is stored

| Data                                                                                                   | Where                                                        | Why                                      | Retention                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Accounts: user name, display name, e-mail, roles, teams, language, last sign-in                        | `users`, `teams`                                             | sign-in, access control, notifications   | kept – Steward cannot delete accounts yet; deactivate leavers ([below](#leavers-deactivation)); SSO accounts are synchronised from the IdP |
| Sessions: hashed token, IP address, browser (user agent), times                                        | `sessions`                                                   | sign-in                                  | until sign-out, at most 12 hours                                                                                                           |
| Audit log: who did what and when (user name), IP address of sign-ins, summaries and details of actions | `audit_log`                                                  | evidence (change management, compliance) | **kept for good** – see below                                                                                                              |
| Runs: who started/approved, inputs, step results, logs, screenshots                                    | `runs`, `run_*`, `data/artifacts`                            | the protocol of a procedure              | _Settings → Retention_ (runs older than N days are deleted; 0 = keep)                                                                      |
| Data fetched from platforms (e.g. user lists in an access review)                                      | step results, reports, dashboards                            | the procedure itself                     | with the run; dashboards keep the latest dataset and metric history (`SM_METRIC_RETENTION_DAYS`)                                           |
| Notifications                                                                                          | `notifications`                                              | in-app messages                          | read ones after _Settings → Retention_ days                                                                                                |
| Quiet hours and digests of a person; messages held for them (rendered text, never channel URLs)        | `notification_prefs`, `notification_outbox`                  | quiet hours and digests (0.10.0)         | settings until changed (also kept when the account is deactivated); held messages until released, then 7 days                              |
| Microsoft Teams: where the bot is installed (tenant, conversation, a person's chat), cards it posted   | `teams_conversations`, `teams_cards`, `teams_bot_activities` | approvals in Teams (preview)             | conversations until removed; activity ids 24 hours                                                                                         |
| Operational log (stdout)                                                                               | your log system                                              | operations                               | your log retention                                                                                                                         |

## Minimisation built in

- **Failed sign-ins**: if the user name belongs to no account, it is _not_ stored – it is often a password typed into the wrong field. The audit entry says "unknown user name (ref …)" with a keyed pseudonym that only shows whether attempts repeat. For existing accounts the account's own name is used, never the typed text. Repeated failures are summed up per minute.
- **Secret process inputs** (input type _secret_): stored only encrypted; protocols, reports, the audit log and the API show `***`, and the value is masked in step data and logs.
- **Size limits**: free-text fields in the audit log are capped (longer texts are cut, with their length and SHA-256).
- **Map of sites** (plant registry, off by default): the browser loads map tiles only from Steward, never from a map provider; a provider Steward fetches from sees the server's address and the areas asked for, never a user's address or name. Tiles above zoom 12 are cached per user, so nobody can learn from answer times where others looked closely ([PLANT.md](PLANT.md#privacy-and-the-tile-usage-policy)).
- Error reports and traces (off by default) contain no user names, e-mail or IP addresses (see [ERROR-REPORTING.md](ERROR-REPORTING.md)); traces carry a pseudonym instead of the user name – a keyed hash with a per-installation key, so it cannot be reversed by hashing known user names.

## The audit log is immutable – how erasure works

Every audit entry is part of an HMAC chain and of signed checkpoints kept outside the database. Changing or deleting an entry is, by design, detected as tampering – that is what makes the log usable as evidence. Steward therefore never edits audit entries. It deletes them only with the audit retention (0.4.0, off by default): entries that were archived into signed archive files and are older than the retention period leave the database, while the archives keep them and the chain still verifies ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#audit-log-as-evidence)). That is about the size of the database, not erasure: the archives still hold every entry.

Position for erasure requests:

1. **Legal basis and retention**: the audit log is kept to meet legal and contractual obligations and for the establishment, exercise or defence of legal claims (GDPR Art. 6(1)(c)/(f), Art. 17(3)(b) and (e)). Define its retention period in your records of processing (for example the retention period of your change-management evidence, often 6–10 years).
2. **Reduce what is not evidence**: deactivate the account and replace its display name and e-mail ([below](#leavers-deactivation)); configure run retention so that protocols with personal data from platforms are deleted when no longer needed. Steward cannot delete an account or pseudonymise a person's data yet.
3. **Pseudonymise instead of deleting**, where your policy allows: use neutral, non-speaking user names (e.g. personnel numbers or IdP object ids via the SSO user name claim) so that the audit log identifies a person only together with the mapping kept in your HR/IdP system. Deleting that mapping there effectively anonymises the log without breaking the chain.
4. **When the log itself must go** (end of the retention period): with archiving on (_Audit log → Epochs, archives and retention_), the monthly archive files are the evidence – keep them as long as required and delete them (and their copies) afterwards; with the audit retention set, their entries leave the database too. Without archives: archive an export (_Audit log → Export → JSON with signed checkpoint_), then set up a new installation (new database and vault). Deleting single entries is not supported.

## Leavers: deactivation

Steward **cannot delete an account** today: not in the web app, not through the API and not on the command line. For a person who leaves, an administrator deactivates the account under _Users_. Deactivation:

- ends all the person's sessions and MCP OAuth grants at once;
- stops their API tokens and push tokens, and the schedules, webhook triggers and monitor outputs that act in their name;
- shows first where the person is still named (owner, access lists, decider …), so these can be handed over.

What stays, and why:

- **The account row with the user name, roles and team memberships.** Audit entries name people by their user name, and every entry is part of the HMAC chain. The user name stays reserved so it is never given to someone else, and the log keeps meaning the same person. For the same reason, user names cannot be changed.
- **Display name, first and last name and e-mail** stay as they are, unless an administrator changes them under _Users_: replace the display name with a neutral text and clear the first and last name and the e-mail. For a single sign-on account whose fields are synchronised from the provider, change them at the provider, or set the provider's sync rule for the field to _only when the account is created_ first.
- The person's settings (language, quiet hours, digests), notifications, token names and their entries in run protocols, records and reports, until run retention or the other retention settings remove them.

**Planned for 0.11:** pseudonymising a person's data (the profile is removed and replaced by a pseudonymous placeholder, so the audit chain still verifies) and a per-person export of their data.

## Access to personal data

- Auditors and administrators can read the audit log; everyone else only sees entries of runs they may see.
- Exports (CSV, JSON) are audited themselves.
- Credentials are never shown; API tokens are stored as hashes.
- AI assistants (MCP, off by default) receive what their token owner may read – including user names in runs and, for auditors, the audit log – and pass it to the assistant's language model. Decide whether that is acceptable before turning MCP on ([MCP.md](MCP.md)); the first use of each MCP token per day and every platform gateway call are audited.

## Data subject access requests

There is no per-person export yet (planned for 0.11, see [above](#leavers-deactivation)). Collect the data by hand:

- the profile: _Users_ shows user name, display name, e-mail, roles, teams, sign-in method and last sign-in;
- the audit log: search for the user name (_Audit log → Search_) and export the matching entries (CSV);
- runs: run protocols list the people who started or decided a run;
- where the person is still named: _Users → Deactivate_ lists it before anything changes (`GET /api/users/{id}/references`).
