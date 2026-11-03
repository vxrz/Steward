# 0004. Credential vault unlocked by a master passphrase

- **Status:** Accepted
- **Date:** 2026-10-23
- **Since:** 0.1.0 (format 2 of the vault file since 0.1.2)

## Context

Steward holds powerful credentials: service credentials of Insights Hub tenants, Industrial Edge, cloud accounts, Git tokens. A copy of the database or a backup must not reveal them. Many installations have no external secret manager or KMS, and the desktop app runs on a laptop.

## Decision

Secrets are encrypted with keys that only exist in memory after an administrator **unlocks the vault with the master passphrase** (`server/src/vault.ts`). A key-encryption key is derived from the passphrase with scrypt and wraps a set of random keys stored in `<data dir>/vault.json`: the AES-256-GCM data key for all secrets in the database, the audit HMAC key, an integrity key that authenticates non-secret settings (such as platform base URLs, `integrity.ts`) and the Ed25519 key that signs audit checkpoints. After a restart the vault is locked: nothing that needs a secret runs, `/api/ready` answers 503, and runs wait. For unattended restarts the passphrase can come from a file only the service account can read (`SM_MASTER_PASSPHRASE_FILE`, a Docker secret or systemd credential); it is removed from the environment at once. Changing the passphrase re-wraps the keys and can replace the data key (`vault-rotation.ts`).

## Consequences

- A stolen database, backup or migration package contains no usable credentials without the passphrase (and backups are encrypted on top).
- Someone must know the passphrase: losing it loses every stored secret (they have to be entered again), and a restart without the passphrase file needs an administrator. The passphrase file trades some of the protection for unattended operation – the host's file permissions protect it then.
- Steward does not integrate an external secret store or rotate platform credentials itself; that is a non-goal ([ROADMAP.md](../ROADMAP.md#non-goals)).
- The keys are in the server's memory while it runs; protecting the host and the process remains necessary ([SECURITY-HARDENING.md](../SECURITY-HARDENING.md)).
