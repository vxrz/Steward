import type { InputDef } from '@sm/shared';
import { vault } from '../vault.js';

/**
 * Process inputs of type "secret" (a one-time password, a token for a single run …): the value is
 * only kept encrypted (vault data key) in runs.sealed_inputs / schedules.sealed_inputs. Wherever
 * inputs are shown or recorded – run protocol, reports, audit log, API – they read "***", and the
 * run's redactor masks the value in step inputs, outputs and logs.
 */
export const SECRET_PLACEHOLDER = '***';

export function secretInputNames(defs: InputDef[] | undefined): string[] {
  return (defs ?? []).filter((d) => d.type === 'secret').map((d) => d.name);
}

/** Splits inputs into what may be stored and shown, and the encrypted secret values (null when there are none). */
export function sealInputs(defs: InputDef[] | undefined, inputs: Record<string, unknown>, previous?: string | null): { visible: Record<string, unknown>; sealed: string | null } {
  const names = secretInputNames(defs);
  if (!names.length) return { visible: inputs, sealed: null };
  const kept = previous ? openSealed(previous) : {};
  const secret: Record<string, unknown> = {};
  const visible = { ...inputs };
  for (const n of names) {
    const v = inputs[n];
    // "***" sent back by a form that showed the stored value keeps the stored secret
    if (v === SECRET_PLACEHOLDER && n in kept) secret[n] = kept[n];
    else if (v !== undefined && v !== '') secret[n] = v;
    if (n in visible || n in secret) visible[n] = SECRET_PLACEHOLDER;
  }
  return { visible, sealed: Object.keys(secret).length ? vault().encrypt(secret) : null };
}

function openSealed(blob: string): Record<string, unknown> {
  try {
    return vault().decrypt<Record<string, unknown>>(blob);
  } catch {
    return {};
  }
}

/** The inputs a run works with: stored inputs plus the decrypted secret values. */
export function openInputs(visible: Record<string, unknown>, sealed: string | null | undefined): Record<string, unknown> {
  return sealed ? { ...visible, ...openSealed(sealed) } : visible;
}

/** The secret values of a set of inputs (to register with the run's redactor). */
export function secretValuesOf(defs: InputDef[] | undefined, inputs: Record<string, unknown>): string[] {
  return secretInputNames(defs)
    .map((n) => inputs[n])
    .filter((v) => v !== undefined && v !== null && v !== '' && v !== SECRET_PLACEHOLDER)
    .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
}
