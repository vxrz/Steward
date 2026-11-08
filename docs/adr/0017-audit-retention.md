# 0017. Audit retention: archives keep the chain verifiable

- **Status:** Accepted
- **Date:** 2026-11-08
- **Since:** 0.4.0 (recorded in 0.11.0)

## Context

[ADR 0003](0003-hmac-chained-audit-log.md) made the audit log append-only and chained, and accepted that "retention cannot delete audit entries without breaking the chain; the log grows for the life of the installation". An installation that runs for years writes millions of entries. A full verification then takes longer every month, backups grow, and the database holds evidence that the company's records of processing say should be gone after its retention period ([PRIVACY.md](../PRIVACY.md)).

Since 0.4.0 Steward closes epochs, writes signed archives and can delete archived entries from the database. That changed the consequence of ADR 0003, but no record said so. Auditors read the ADRs, so the record has to match the code.

## Decision

Audit entries leave the database only **after they are archived**, and the archive keeps them verifiable (`server/src/audit-archive.ts`, `server/src/audit-archive-verify.ts`). Everything below is off by default.

- **Epochs.** Every signed checkpoint ([ADR 0003](0003-hmac-chained-audit-log.md)) closes an epoch: the entries since the previous checkpoint.
- **Archives.** Once a month of checkpoints is over, its epochs are written to `<data dir>/audit-archives/` as a ZIP file: the entries, the signed checkpoints in it, the signed checkpoint it continues from, and a manifest with the SHA-256 of each file, signed with the installation's Ed25519 key. The entries are checked against the signed checkpoint before the file is kept. Optionally each archive is also uploaded, encrypted, to the S3 target of the backups. `steward audit verify-archive` checks an archive offline, without the server, the vault or the database, and checks that several archives follow on from each other.
- **Retention.** With a retention period (at least 30 days), the daily cleanup deletes the entries of archives whose newest entry is older than the period. It works archive by archive, only when the archive file is present and unchanged (and uploaded, when uploading is on). Before it deletes, it writes `audit.entries_delete_started` to the chain with the archive, its last entry and the hash and digest of the signed checkpoint it ends at.
- **What stays.** Entries other evidence relies on are never deleted (`KEPT_ON_DELETE_SQL` in `server/src/audit.ts`): approvals and frozen revisions of records, signed PDFs, access checks and findings, `report.generated`, run protocol seals, `instance.imported`, the checkpoints and the deletion records.
- **The chain after a deletion.** The database verifies from the signed checkpoint of the newest deleted archive (the _pruned base_): the first remaining entry links to it. The full verification requires the deletion record in the chain and checks the HMAC of every kept entry. Removing an archive record, changing that checkpoint, or deleting entries without the record is reported as tampering. The JSON export then starts at that checkpoint (`startCheckpoint`), and evidence packs over a deleted period carry the archives of the period.

ADR 0003 stays in force: the chain, the checkpoints and the rule that entries are never edited. This record replaces only its last consequence.

## Consequences

- The database stops growing for ever, and the full verification covers a bounded number of entries.
- The **archive files become the evidence** for the deleted period: they are the only copy of the deleted entries. Operators have to keep them (and their copies) as long as the evidence is needed, and delete them afterwards. Losing an archive loses those entries; the remaining chain still verifies, but the period can no longer be shown.
- Verifying a deleted period needs the archives and the installation's public key, not the server. That is a strength for auditors and a duty for operators: record the public key's fingerprint once.
- Retention is about the size of the database, not about erasure: the archives still hold every entry. Erasing a person's data from the log is a separate question ([PRIVACY.md](../PRIVACY.md)).
- An instance whose entries were deleted cannot be moved with a migration package yet ([MIGRATION.md](../MIGRATION.md)).
- Revisit if archives should go to write-once storage by themselves, or if a trusted timestamp (RFC 3161) is added to checkpoints.
