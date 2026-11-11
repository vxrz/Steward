# Scheduled exports to S3

From 0.16.0 Steward can write **readable files** of chosen parts of its data to an **S3 bucket on a schedule** – the cost plans of the services for the finance team, the plant registry for an engineering tool, the catalogue for a CMDB, the audit log for an archive; from 0.17.0 also the suppliers, the register of corrective actions and the approved statements of applicability for a GRC tool. Exports are for **sharing and archiving outside Steward**. They are **not backups**: Steward cannot be restored from them – that is what [backups](BACKUPS.md) are for.

Set them up under _Settings → Exports_ (administrators; defining, changing or removing an export asks for your password again – control point `export.settings`, [ASSURANCE.md](ASSURANCE.md)). Design decisions: [ADR 0027](adr/0027-backup-contents-and-exports.md).

## What can be exported

| Part                       | Formats      | Files                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cost plans and entries     | CSV          | `cost-plan-lines-FY-2026.csv`, `cost-entries-FY-2026.csv`, `commitments.csv` | Every service's plan lines and cost entries of the current, previous or next fiscal year, the service first ([COSTS.md](COSTS.md#planning-per-service)) – since 0.18 with the months of part-year lines, prepaid days, the payment schedule and the months not booked, and the entries' supplier, contract and import; `commitments.csv`: what every payment schedule of a service that is not archived still owes as of the run ([COSTS.md](COSTS.md#commitments)). Costs module |
| Plant registry             | YAML or JSON | `plant-registry.yaml` / `.json`                                              | The whole registry in its import format (format 1, [PLANT.md](PLANT.md)) – it imports back unchanged. Plant registry module                                                                                                                                                                                                                                                                                                                                                       |
| Services                   | CSV          | `services.csv`                                                               | The service catalogue, archived services included                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Applications               | CSV          | `applications.csv`                                                           | Archived applications included                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Systems                    | CSV          | `systems.csv`                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Monitors                   | YAML         | `monitors.yaml`                                                              | Every monitor (not the templates) in its import format, one YAML document each – credentials typed into a definition and request bodies are redacted (below)                                                                                                                                                                                                                                                                                                                      |
| Audit log                  | CSV or JSONL | `audit-log.csv` / `.jsonl`                                                   | The entries of the last 1–366 days (default 7), at most the newest 200,000 (a cut is noted, below) – the columns of _Audit log → Export_                                                                                                                                                                                                                                                                                                                                          |
| Suppliers                  | CSV          | `suppliers.csv`, `supplier-contracts.csv`, `supplier-certificates.csv`       | Every supplier (all statuses) with its contracts and certificates ([SUPPLIERS.md](SUPPLIERS.md)) – since 0.18 every contract (exports are instance-wide) with its owners, the services it covers (name and purpose), its master agreement, personal data and DPA with their source; contacts by name and role only, **never their e-mail or phone** (as in `/api/v1`)                                                                                                             |
| Corrective actions         | CSV          | `corrective-actions.csv`                                                     | The register of findings with source, severity, status, service, supplier, controls, owner, due date, actions and the effectiveness check ([COMPLIANCE.md](COMPLIANCE.md#corrective-actions)). Compliance module                                                                                                                                                                                                                                                                  |
| Statement of applicability | JSON         | `soa-<catalogue>-v<n>.json`, `soa-<catalogue>-v<n>.csv`                      | The latest approved version of each statement: the frozen content byte for byte (its SHA-256 is the version's, as in the audit log and the signed export) with its CSV beside it; the part's entry in the manifest lists the versions under `notes.versions`; nothing while no version is approved ([COMPLIANCE.md](COMPLIANCE.md#statement-of-applicability)). Compliance module                                                                                                 |

CSV files are UTF-8 with a byte order mark (Excel reads them as UTF-8), comma separated; a cell that a spreadsheet would read as a formula gets a leading apostrophe. Lists are joined with `; `, nested values are JSON. Each object is uploaded with its content type – `text/csv; charset=utf-8`, `application/json`, `application/x-ndjson`, `application/yaml` (encrypted files: `application/octet-stream`) – so S3 consoles, download links and data tools read it as what it is.

When the audit log has more entries in the period than an export holds, the **newest** are written (oldest first, as always); the part's entry in the manifest then has `notes: { "truncated": true, "entries": …, "firstEntryAt": …, "period": { "from": …, "to": … } }` and the run's message says _Cut to the newest 200000 entries: auditLog_. Choose fewer days, or export more often, to get every entry.

A part whose **module is switched off** (Costs, plant registry, Compliance – _Settings → Modules_) is not written: the run succeeds, says _Not exported: plant (the module plant is switched off)_, and the manifest lists it under `skipped`. The parts are a registry (`server/src/export/parts.ts`): a new part is one entry with its formats and a function that writes its files.

## What a run writes

Each run writes one folder:

```text
<prefix><name>/<UTC time>/
  cost-plan-lines-FY-2026.csv
  commitments.csv
  cost-entries-FY-2026.csv
  plant-registry.yaml
  …
  manifest.json
```

e.g. `exports/finance-share/20261110T023000Z/`. A second run within the same second gets a suffix (`…Z-2/`); nothing is ever overwritten. `manifest.json` names the export, the Steward version, the parts with their format and options, the parts skipped, and every file with its size and SHA-256:

```json
{
  "format": "steward-export",
  "v": 1,
  "name": "finance-share",
  "createdAt": "2026-11-10T02:30:00.000Z",
  "encrypted": false,
  "parts": [
    { "id": "costPlans", "format": "csv", "options": { "fiscalYear": "current" }, "files": ["cost-plan-lines-FY-2026.csv", "cost-entries-FY-2026.csv"] }
  ],
  "skipped": [],
  "files": [{ "name": "cost-plan-lines-FY-2026.csv", "part": "costPlans", "bytes": 1834, "sha256": "…" }]
}
```

Every object also carries the SHA-256 of what is stored as `x-amz-meta-sha256`. _History_ on the export's card shows every run with its status, files, sizes, SHA-256s and – for a failed run – why (an S3 error, a missing passphrase; never a secret). A failed run removes what it had uploaded, so a folder in the bucket is always complete. The administrators get the notification _Export failed_ (`export.failed`, in-app and e-mail by default, [NOTIFICATIONS.md](NOTIFICATIONS.md)).

## Setting it up

1. **The bucket.** The backup bucket with a folder of its own (e.g. `exports/`, the default) or another bucket – any S3 or S3-compatible storage, as for backups ([BACKUPS.md](BACKUPS.md#1-the-bucket)). Give the key `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket` on that folder; readers of the exports get `s3:GetObject` on it – and nothing on the backups.
2. **The storage platform.** A platform with _AWS request signing (SigV4)_ for the service `s3`, over https; its credentials (or a role to assume) are in the vault like every platform's. The backup's platform is suggested.
3. **The export.** A name (letters, digits, `. _ -`; also the folder in the bucket), the folder in the bucket, a five-field cron schedule and its time zone (default `30 3 * * 1`, Mondays 03:30), the parts with their format and options, **encryption** (below) and **runs to keep** (default 10). _Run on the schedule_ off keeps the export for _Run now_ only.

_Run now_ starts a run right away (one run per export at a time).

A scheduled time that falls into a time Steward was not running (an update, a restart) is not lost: at the next start Steward compares each export's schedule with the last time its scheduler ran, audits the missed times (`export.missed`) and – once the vault is unlocked – starts **one** catch-up run, however many times were missed. Requests to S3 are repeated on the platform's retry policy (by default up to 3 times with backoff, for 429/502/503/504 and network errors, the platform's _Retries_ setting); a run that still fails removes what it uploaded and notifies the administrators.

## Readable or encrypted

**By default the files are readable** – the purpose of an export is that people and tools outside Steward read them. Whoever can read the bucket folder can read the files: protect it with a bucket policy (only the readers who need them), server-side encryption and, where it matters, a bucket of its own.

**Encrypt the files with the backup key** encrypts every file – the manifest included – like a backup (AES-256-GCM, [BACKUPS.md](BACKUPS.md#encryption)); the files are named `<file>.smbackup` and read with the backup passphrase:

```bash
npm run backup -- decrypt cost-plan-lines-FY-2026.csv.smbackup --out cost-plan-lines-FY-2026.csv
# desktop: steward backup decrypt …; container: node server/dist/backup.js decrypt …
```

The file is authenticated chunk by chunk; its header says it is an export file (`content: export`, with the file name), so `verify` refuses it as a backup. For encrypted files the manifest (itself encrypted) gives per file the size and SHA-256 of the object as stored (`bytes`, `sha256`) and of the decrypted content (`contentBytes`, `contentSha256`); the object's clear metadata carries only the SHA-256 of what is stored (`x-amz-meta-sha256`) and the key id – a hash of the content would let anyone who can read the bucket confirm a guess of a small or templated file. Encryption needs the backup passphrase to be set (_Settings → Backups_). Choose it when the files pass through hands that must not read them – and give the passphrase only to those who should. The trade-off: encrypted exports need the passphrase and Steward's tool to be read; readable exports rely on the bucket's access rules alone.

## Retention

After each successful run, the **files of older successful runs beyond _Runs to keep_** are removed. Only files a run of this export recorded are removed – from the run history, never by listing the bucket – so other objects in the folder stay. A file that S3 Object Lock keeps, or that the key may not delete (no `s3:DeleteObject`), is reported as such and stays; the run is pruned once all its files are gone. Removing an export removes its definition and history; **its files stay in the bucket** – remove them there.

A run records each file **before it uploads it**, so no file of an export is ever unknown to Steward:

- A **failed** run removes what it had uploaded. What cannot be removed right then (the same S3 outage) stays recorded on the failed run, and the retention rule removes it with the next successful run.
- When the server **stops** during a run, the run ends at its next file and removes what it uploaded (shutdown waits for it within `SM_SHUTDOWN_GRACE_SECONDS`). A run cut off harder (a crash, a kill) is marked _Interrupted (the server stopped)_ at the next start – audited as `export.failed` (code `EXPORT_INTERRUPTED`) and notified – and the files it had uploaded are removed once the vault is unlocked.
- The history keeps the newest 200 runs of an export, and every older run whose files are still in the bucket until they are gone.
- A platform that an export writes to, or whose bucket still holds files a run recorded, cannot be deleted (`PLATFORM_EXPORT_TARGET`, `PLATFORM_EXPORT_FILES`).

## Security

- **Only administrators** define, change, run and remove exports, and a change asks for a step-up (`export.settings`). An export **runs as the system** and holds everything of its parts – also data the administrator would not see on a page (every site of the plant registry, the amounts of every cost plan, every monitor).
- **The target is pinned.** When an administrator saves an export, Steward keeps a fingerprint of its S3 target: the platform, its base URL (the bucket) and variables, region and service, assumed role, proxy and TLS settings, trusted origins, the access key id (as a hash – never a secret) and the folder. Whoever manages the platform can change those without the export's step-up, so each run compares them first: when they differ, the run **fails before it lists or writes anything** (`EXPORT_TARGET_CHANGED`, audited as `export.failed` with that code, notification _Export failed_), and the export's card says _The S3 target changed – confirm it again_. Check the platform, then press **Confirm target** (administrators, step-up; audited as `export.target_confirmed` with the platform, base URL and region). Saving the export confirms the target too. Rotating only the secret access key keeps the target; a new access key id needs a confirmation.
- **No secrets** are ever exported: no vault value, credential, platform key, API or MCP token, heartbeat or webhook secret. The parts write what people read in Steward; `server/test/exports.test.ts` checks the files of every part for the secrets the test installation holds.
- **Credentials typed into a monitor are redacted.** A monitor's definition can hold credentials someone typed into it instead of using a platform: request headers of an HTTP check (`Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key` and any header whose name contains _token_, _secret_, _key_, _auth_, _password_ or _session_), user information in a URL (`https://user:password@host/`), query parameters such as `code`, `token`, `key`, `sig`, `signature`, `secret`, `password`, `apikey`, `api_key`, `access_token`, and the path of webhook services that carry their key in it (Slack, Discord, Microsoft Teams connectors). The **request body** of a check (HTTP, platform and freshness checks that send one) goes as a whole unless it is empty (since 0.18.0): a login form, a GraphQL query or a JSON document can hold a password, and nothing tells those apart from harmless bodies reliably. In `monitors.yaml` each such value is `<redacted>`; the monitors part's entry in the manifest lists where (`notes.redacted`: `<monitor key>: checks[0].headers.Authorization`, `<monitor key>: checks[0].body`, never the value). The monitor in Steward, _Monitors → Export_ and Git sync are unchanged – they must import back. Better still: keep credentials in a platform.
- Exports **leave Steward**: what is in the bucket is outside Steward's access rules and audit log. Treat the folder as you would treat the data itself (see [SECURITY-HARDENING.md](SECURITY-HARDENING.md#exports)).
- **Exports hold personal data and OT inventory.** The audit log has user names and the IP addresses of sign-ins, the catalogue the owners of services, applications and systems, the suppliers the names and roles of their contacts (never their e-mail or phone – `server/test/exports.test.ts` checks it), the plant registry addresses, MAC addresses, VLANs and data paths of the plant network. Unless _Encrypt the files_ is on, anyone who can read the bucket can read all of it. An export is a processing of its own (record it as one): Steward's retention and pseudonymisation (e.g. when a user is pseudonymised) **cannot reach copies already exported**, so the bucket's own lifecycle rules decide how long they stay. Prefer encrypted exports, and give the folder a bucket policy that lets only the readers who need it in – and a lifecycle rule that matches your retention.
- Everything is audited: `export.job_created`, `export.job_changed`, `export.job_removed` (with the definition), `export.target_confirmed`, `export.completed` (folder, files and their SHA-256), `export.failed`, `export.pruned`. The plant registry part also writes the registry's own `plant.exported` entry (actor `system`).
- Exports go through the platform request layer like backups: the platform's proxy and the outbound policy apply ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#outbound-connections)).
- During a run the files are briefly in `<data folder>/.export-work` (0700, 0600 files); the folder is emptied after each file and at start, and is never part of a backup. A part writes its file row by row or page by page and is hashed while it is written – a large audit log is never one string in memory – and the server answers other requests between the pages.
- Exports are per installation: a migration package does not carry them; set them up again on the target.
