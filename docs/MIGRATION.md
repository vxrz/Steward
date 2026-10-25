# Moving an instance

Start with the desktop app on your laptop. Later, move everything to a server – a container with PostgreSQL and Entra ID, for example – without losing anything important, and with a record of which local user became which user on the server.

A **migration package** (`.smig`) carries the whole instance: the data, the stored files (attachments, run screenshots, reports, evidence packs, logos) and the audit log. You export it on the old instance (the **source**) and import it on the new one (the **target**).

## In short

1. **Source:** _Settings → Migration → Export this instance_, or `steward migrate export --out move.smig` with Steward stopped. Choose a **transfer passphrase** and note the **fingerprint** shown – the target asks for it.
2. **Target:** set up as usual – master passphrase, administrator, single sign-on (_Users & teams → Single sign-on_). Sign in with single sign-on as an administrator.
3. **Target:** _Settings → Migration → Import a package_: upload the file, enter the transfer passphrase and check the dry run. Decide for every user and team what they become here, enter the fingerprint you noted on the source (at least its first 16 characters), import.
4. **Target:** review what was imported paused (schedules, triggers, monitors …) and turn it on. Optionally switch password sign-in off ([INSTALL.md](INSTALL.md#locked-out-of-single-sign-on)).

## What moves and what does not

Moves:

- Processes with all versions, runs with journals, decisions, logs and protocols, schedules, webhook triggers, platforms with their credentials, connector types, dashboards and datasets, monitors with their history, heartbeat gateways, records and living documents with editions, reviews and attachments, services, the credentials register, ticket references, access checks, snapshots, findings and access change entries, control catalogues and mappings, evidence packs, reports and report schedules, Gatus sources and their metrics.
- The audit log, unchanged (see [Audit log](#the-audit-log)).
- Settings: the default language, retention, browser options, the four-eyes rule for findings, the theme and logo, report branding, the credential reminders, the ticket settings and the daily summary switch.

Does not move (the dry run lists it):

- **Passwords.** Local passwords never leave the source. New local accounts get a one-time password on the target.
- Sessions, API tokens and MCP tokens: create new ones on the target.
- Single sign-on providers, SMTP and the other notification channels, the outbound allow-list, the sign-in mode, the MCP server setting and Git sync sources: they belong to the instance. Set them up on the target.
- In-app notifications.

Automation is imported **paused**, so the laptop and the server never run the same schedule twice: schedules, webhook triggers, monitors, heartbeat gateways, report schedules, access checks and Gatus sources. Turn them on after a check. Webhook URLs change with the server's address: update the callers (and rotate the webhook secrets if the laptop was shared).

Runs that are still running, queued or waiting for a decision on the source arrive **cancelled**, with a note (and their open decisions cancelled): Steward would otherwise resume them at its next start and carry on with the moved credentials, without anyone on the target deciding to. Start them again on the target if they are still needed. The dry run says so, and the result lists how many there were.

## The identity mapping

Every user of the source becomes one of:

| Choice                       | What happens                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An existing account here     | E.g. the user's single sign-on account. Its roles stay as they are on the target.                                                                                                                                                                                                                                                     |
| A new single sign-on account | An account without a password, with the source user's roles, bound to **one** single sign-on provider (chosen in the mapping; the only enabled one by default). It is linked at the first sign-in through that provider with exactly this user name (the UPN or e-mail your identity provider sends); no other provider can claim it. |
| A new local account          | With the source user's roles and a one-time password (shown once). Not offered while password sign-in is off.                                                                                                                                                                                                                         |
| A former user                | An inactive account without roles: the history stays readable, nobody can sign in with it.                                                                                                                                                                                                                                            |

Every team becomes an existing team, a new team, or is dropped. Team memberships follow the mapping. The importing administrator's own account is never changed.

The dry run suggests a choice for everyone: an account with the same e-mail address, the same user name, or the same name before the `@`; otherwise a new single sign-on account (or a former user for deactivated accounts). A match by e-mail address or by the name before the `@` is a guess – the address of a single sign-on account comes from the identity provider – so mapping a user to such a match needs a confirmation like an administrator does.

Until its first sign-in, a new single sign-on account is claimed by whoever the provider names with that user name, with the roles from the package. Choose the user names carefully (the UPN, not an address users can change), keep the decisions for administrators confirmed, and prefer role mappings from the identity provider: with _Synchronise roles_ the provider's groups replace the imported roles at the first sign-in.

Rules:

- Every user and every team needs a decision.
- Decisions for **administrators of the source**, and mappings **to an administrator of the target**, must be confirmed (a tick in the UI, `"confirm": true` in a mapping file).
- A source user name that is an account on the target must be mapped to that very account – also for administrators. Otherwise the former name would become an alias of another account and match `user:<name>` everywhere, including what the existing account gets in future. If they are different people, give the target account another name before the import (or create it under another name).
- A team name that exists on the target must be mapped to that team.

**Who owns something or may do something** follows the mapping: owners of processes, schedules, dashboards, monitors, triggers, report schedules, access checks, records and services, access lists, assignees of decisions, responsible people of ticket references, credential owners, report recipients and monitor subscribers.

**Who did something** stays as it was: authors, approvers, deciders, the people in the audit log and in run protocols. That is evidence, often inside hashes and signatures, and is never rewritten. Instead, the former names become **aliases** of the target accounts: a process step still assigned to `user:arvid` reaches `arvid@corp.example`, and the four-eyes rules know that `arvid` and `arvid@corp.example` are one person (whoever started a run as `arvid` cannot approve it as `arvid@corp.example`). A former name cannot become a new account. _Settings → Migration_ shows the mapping as _local: arvid → arvid@corp.example (existing account)_, also next to every entry of the imported audit history.

## The audit log

- The source writes `instance.exported` (with the package id) and a signed checkpoint that covers it. The package carries the source's audit log up to that checkpoint, and the source's public key.
- The target keeps it **unchanged** as imported history, in its own table: original entries, hashes and the signed checkpoint. It is checked at the import and again on _Settings → Migration_ (_Verified_): the entries form an unbroken chain and match the checkpoint signed by the source's key.
- The target's own chain gets one entry `instance.imported` with the package's SHA-256, the source's fingerprint and version, the counts, the checkpoint the history ends with, and the mapping table (its SHA-256, and the table itself while it is small). The full table is kept with the import and checked against this entry.
- Evidence that moved stays verifiable: run protocol seals, approvals of living documents, frozen records, report fingerprints and access snapshots are checked against the imported history. Answers that rest on it say so – _verified against the imported audit history of <source fingerprint>_ – so nobody mistakes them for this instance's own evidence: the run report PDF, `protocol.importedHistory` of `GET /api/v1/runs/{runId}`, _Verify a report_, the record page, signed PDFs and _Verify history_ of access checks.

## Security

- The package is encrypted with the transfer passphrase (scrypt N=2^17, r=8, p=1 and AES-256-GCM; the header is authenticated). Credentials inside are encrypted once more with a second key from the passphrase, and re-encrypted with the target's vault on import. Pass the passphrase on separately from the file, and delete the file after the import.
- The manifest – versions, counts and the SHA-256 of every table, every file and the audit log – is signed with the source's Ed25519 key (over the purpose line `steward-migration-manifest-v1` and the manifest, so no other signature of that key – a checkpoint, an emergency grant – can pass as one). The import refuses a package whose signature, content or file list does not match. Since the package names its own key, the import needs that key's fingerprint as **you read it on the source** – the export result, or _Audit log → Anchoring outside the database → Signing key fingerprint_ there – at least the first 16 characters (colons and case do not matter; `MIGRATION_FINGERPRINT_SHORT`, `MIGRATION_FINGERPRINT_MISMATCH`). The target does not display it, so it cannot be confirmed by copying what the package says.
- Export and import are for administrators in a signed-in session (no API tokens, no emergency access session). The export asks for the master passphrase again; failed attempts are audited and slowed down like unlocking.
- Uploads are checked for the package's magic line, limited to `SM_MIGRATION_MAX_MB` (default 2048 MB) and kept in a private folder of the data directory until the import or for 30 minutes. What a package unpacks to (tables, files and audit log together) is limited to `SM_MIGRATION_MAX_UNPACKED_MB` (default 20480 MB, and at most 64 times the package), and Steward checks before unpacking that the disk has room for it (`MIGRATION_DISK_SPACE`; the import needs about twice the unpacked size: the staging database and the files). The audit history is checked and taken over line by line (each entry at most 4 MB), never held in memory as a whole. File paths in the package are checked; nothing is written outside the stored-file folders, and no existing file is overwritten.

## Requirements and limits

- **Target:** a new instance. Before the import it may only hold users, teams, single sign-on providers and settings – anything else is refused (the dry run says which tables hold data). One package per target.
- **Versions:** the target runs the same or a newer Steward version. An older package is loaded as its version wrote it and then migrated with the same database migrations an update would run. A package from a newer version is refused – update the target first.
- **Either database:** SQLite and PostgreSQL work as source and target in any combination.
- An instance that holds an imported package cannot be exported again yet.
- The package is a ZIP inside: at most 4 GB and 65,000 files.
- The export reads the database in one transaction: during an export from the web UI Steward pauses for a moment.

## On the command line

The commands run on the server with Steward stopped, like `steward admin` (data folder and master passphrase; see `steward migrate --help`). The transfer passphrase comes from `--transfer-passphrase-file`, `SM_TRANSFER_PASSPHRASE` or a prompt.

```bash
# source (desktop app: steward.exe migrate …, Node.js: npm run migrate -- …)
steward migrate export --out ~/move.smig

# target
steward migrate inspect move.smig --mapping-template mapping.json   # dry run, writes the suggestions
#   edit mapping.json: check every decision, set "confirm": true for administrators
steward migrate import move.smig --mapping mapping.json --fingerprint 1a2b:3c4d:…
```

In a container: `docker compose stop steward`, then `docker compose run --rm -v "$PWD":/move steward node --import tsx server/src/cli/migrate.ts import /move/move.smig --mapping /move/mapping.json --fingerprint …`, then `docker compose up -d`.

A mapping file:

```json
{
  "users": {
    "admin": { "action": "map", "to": "arvid@corp.example", "confirm": true },
    "erika": { "action": "create-sso", "username": "erika.example@corp.example" },
    "bob": { "action": "create-local" },
    "carol": { "action": "archive" }
  },
  "teams": {
    "Service Desk": { "action": "map", "to": "Service Desk" },
    "Plant team": { "action": "create" },
    "Temp": { "action": "drop" }
  }
}
```

The import writes `instance.imported` with the operating-system account that ran it (`cli:<user>@<host>`) and prints the one-time passwords of new local accounts.
