# 0027. Backup contents and scheduled exports

- **Status:** Accepted
- **Date:** 2026-11-10
- **Since:** 0.16.0

## Context

The owner asked: _"Could 0.16.0 also add control over what becomes part of the S3 backup? E.g. to include the service cost information."_ Two wishes hide in it. One is about the **backup**: its data folder grows with run artifacts, archived reports and evidence packs, and an administrator may want smaller backups. The other is about **people outside Steward**: the cost plans of 0.16.0 ([ADR 0026](0026-service-cost-planning.md)) live in the database, which every backup already holds – but encrypted, in a format only a restore can use. What the finance team wants is a readable file.

Forces:

- A backup exists to restore Steward. Without the database, `vault.json` (the keys of the credentials), `audit-anchor.json` and the audit archives a restore is impossible or cannot prove the audit log complete.
- The bulky folders are **evidence**: run artifacts (screenshots, files of manual steps) cannot be made again; an archived report can be generated again only as a new version with another SHA-256; an evidence pack can be built again with a new signature, from the data still there. None of them is a cache.
- A readable copy for sharing is a different thing from a backup: other readers, other formats, another retention, no restore.

## Decision

**Two features, kept apart.**

1. **Backup contents** (`server/src/backup/contents.ts`, [BACKUPS.md](../BACKUPS.md#contents)). The setting `exclude` of the backups names optional parts – only run artifacts, archived reports and evidence packs. Everything else is always included; a required part in `exclude` is refused (`BACKUP_PART_REQUIRED`), never dropped. **The default is everything**, as before. Because each optional part is evidence, leaving one out is never silent: the page warns and says what a restore lacks; `manifest.json` records `excluded` (folder, files, bytes); the unencrypted header names it (`steward backup info`); the run and the restore test show a step _contents_. Record attachments, platform documents and branding stay required: they are originals people uploaded and usually small.

2. **Scheduled exports** (`server/src/export/jobs.ts`, `parts.ts`, [EXPORTS.md](../EXPORTS.md)). An administrator defines an export: a name, a cron schedule, an S3 target (a SigV4 platform – the backup's or another, credentials in the vault as for every platform) with its own folder, and the parts from a **registry of exportable parts** – each declares its formats, its module and a function writing its files: cost plans and entries (CSV per fiscal year), the plant registry (its import format), services, applications and systems (CSV), monitors (YAML), the audit log of the last days (CSV/JSONL). A run writes `<prefix><name>/<UTC time>/` with `manifest.json` (SHA-256 of every file), keeps the newest _n_ successful runs (deleting only files its own runs recorded) and notifies the administrators on failure (`export.failed`).
   - **Readable by default.** Readability is the point; the bucket's access rules protect the files. Encryption with the backup key (the backup file format, read with `steward backup decrypt`) is a switch per export.
   - **Runs as the system, defined by administrators only**, with a step-up on every definition change (new control point `export.settings`, action `changeExports`): an export sends everything of its parts out of Steward. _Run now_ needs no step-up, like _Back up now_.
   - **The confirmed target is pinned.** The S3 platform is shared configuration that whoever manages it can change without the export's step-up – a new base URL and key would send the next run to another bucket. So the export stores a fingerprint of its target when an administrator saves it (platform, base URL with its variables, region and service, role, proxy and TLS settings, trusted origins, a hash of the access key id – never a secret – and the folder). Each run compares it first; a difference fails the run before anything is listed or written (`EXPORT_TARGET_CHANGED`, audited and notified as `export.failed`) until an administrator confirms the target again (step-up, `export.target_confirmed`). Backups are not pinned: their files are always encrypted, so a redirected backup gives no readable data (but stops landing in the real bucket – the restore test notices).
   - **Never a secret**: the parts write what pages show; a test checks every file for the installation's secrets.
   - A part of a switched-off module is skipped and named in the run and the manifest.

New tables `export_jobs` and `export_runs` (migration `ops-015-export-jobs`), instance-specific (not moved by a migration package).

## Consequences

- Backups can be smaller without a restore becoming impossible, and nobody can be surprised by missing evidence after a restore: the backup itself says what it lacks.
- Finance, engineering and archive tools get readable, checksummed files on a schedule without access to Steward.
- Data in an export bucket is outside Steward's access rules and audit log; [SECURITY-HARDENING.md](../SECURITY-HARDENING.md#exports) asks for a bucket policy of its own. An export holds more than its author might see on a page – the reason only administrators define exports.
- The registry makes a new part one entry. Revisit when people other than administrators need exports of their own data (they would then run with their rights, not as the system), or when an optional backup part turns out to be truly regenerable.
