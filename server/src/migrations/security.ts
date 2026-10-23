import type { NamedMigration } from '../db.js';

/** Security hardening (review C). Portable: separate SQLite and PostgreSQL DDL where they differ. */
export const SECURITY_MIGRATIONS: NamedMigration[] = [
  {
    // Audit sequence numbers start at 1. Rows with seq < 1 were never verified by older versions (and are
    // flagged by verify now). Existing rows are not touched: a forged row must stay visible to verify.
    name: 'security-001-audit-seq-positive',
    sql: `
      CREATE TRIGGER audit_log_seq_positive BEFORE INSERT ON audit_log
        WHEN NEW.seq IS NULL OR NEW.seq < 1
        BEGIN SELECT RAISE(ABORT, 'audit_log.seq must be greater than 0'); END;
      CREATE TRIGGER audit_log_seq_positive_update BEFORE UPDATE OF seq ON audit_log
        WHEN NEW.seq < 1
        BEGIN SELECT RAISE(ABORT, 'audit_log.seq must be greater than 0'); END;
    `,
    // NOT VALID: checked for every new or changed row, existing rows are left for verify to report
    pg: `ALTER TABLE audit_log ADD CONSTRAINT audit_log_seq_positive CHECK (seq > 0) NOT VALID;`,
  },
  {
    // Session binding: SHA-256 of a per-session key the web app keeps in localStorage (origin-isolated)
    // and sends as a header – a stolen cookie alone is not enough. NULL = session from an older version.
    name: 'security-002-session-binding',
    sql: `ALTER TABLE sessions ADD COLUMN binding TEXT;`,
  },
  {
    // HMAC (vault integrity key) over the non-secret connection settings of platforms and sign-in
    // providers: changes made directly in the database are detected.
    name: 'security-003-config-integrity',
    sql: `
      ALTER TABLE platforms ADD COLUMN config_mac TEXT;
      ALTER TABLE identity_providers ADD COLUMN config_mac TEXT;
    `,
  },
  {
    // Values of process inputs of type "secret", encrypted with the vault data key (the inputs columns show ***).
    name: 'security-004-sealed-inputs',
    sql: `
      ALTER TABLE runs ADD COLUMN sealed_inputs TEXT;
      ALTER TABLE schedules ADD COLUMN sealed_inputs TEXT;
    `,
  },
];
