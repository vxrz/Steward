# 0003. HMAC-chained audit log with signed checkpoints

- **Status:** Accepted
- **Date:** 2026-10-23
- **Since:** 0.1.0 (chain); signed checkpoints and anchors since 0.1.2

## Context

Steward's audit log is evidence: auditors use it to show who changed access, who approved a removal, which run wrote what. Evidence that a database administrator could edit without trace is worth little. Writing to an external append-only store (WORM, a SIEM) is not available in every installation, and the desktop app must work on its own.

## Decision

The audit log is **append-only and chained** (`server/src/audit.ts`): every entry carries an HMAC over its content and the previous entry's hash, with a key wrapped in the vault ([0004](0004-vault-with-master-passphrase.md)). Editing, deleting or re-ordering entries breaks the chain, and `verify()` names the first entry that does not match. To detect entries removed **at the end**, the installation signs **checkpoints** (sequence, hash, an unkeyed digest chain, count, time) with its Ed25519 key (`server/src/audit-anchor.ts`) – every hour when there are new entries, after each verification and before each export. A checkpoint is written to the log, to `<data dir>/audit-anchor.json`, to the operational log line `audit checkpoint`, and optionally e-mailed to auditors. A verification compares the chain with every anchor it knows, including one kept outside (`SM_AUDIT_ANCHOR`, `SM_AUDIT_ANCHOR_FILE`, or pasted in the UI). Exports and evidence packs carry the checkpoints and can be verified offline (`steward evidence verify`, `npm run audit:verify-export`).

## Consequences

- Tampering is detectable, not preventable: someone with database and vault access can rewrite the log, but not without contradicting every checkpoint that already left the system. Shipping checkpoints off the system (SIEM, e-mail, write-once share) is what makes the guarantee strong.
- Entries are written in one order by one process ([0002](0002-single-active-instance-with-lease-lock.md)); two processes appending to one chain would break it.
- The audit and signing keys never change, even when the passphrase or data key is rotated, so old entries stay verifiable. Losing the vault file loses the ability to verify (keep backups).
- Retention cannot delete audit entries without breaking the chain; the log grows for the life of the installation.
