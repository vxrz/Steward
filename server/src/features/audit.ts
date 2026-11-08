import { CHECKPOINT_INTERVAL_MINUTES } from '../audit-anchor.js';
import { defineFeature, MINUTE } from './define.js';

/** The tamper-evident audit log: checkpoints, archives and the full verification. */
export default defineFeature({
  name: 'audit',
  jobs: [
    // signed audit checkpoints (audit-anchor.ts, SM_AUDIT_CHECKPOINT_MINUTES; nothing is signed while the vault is locked)
    {
      name: 'audit-checkpoint',
      intervalMs: CHECKPOINT_INTERVAL_MINUTES * MINUTE,
      timeoutMs: 5 * MINUTE,
      run: () => import('../audit-anchor.js').then((m) => m.createCheckpoint('interval')),
    },
    // the full verification of the audit chain every SM_AUDIT_FULL_VERIFY_DAYS; it starts a background job and returns (audit-archive.ts)
    {
      name: 'audit-full-verification',
      intervalMs: 60 * MINUTE,
      timeoutMs: 5 * MINUTE,
      run: () => import('../audit-archive.js').then((m) => m.scheduledFullVerification()),
    },
  ],
});
