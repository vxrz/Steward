import { audit } from '../../audit.js';
import { credentialValues, credentialsAllowed, identityKey } from '../../platforms/http.js';
import { assertNoSecretLeak, assertOutboundAllowed, egressSecretValues, type OutboundContext, type SecretBinding } from '../../platforms/outbound.js';
import { outboundContext } from '../../platforms/policyContext.js';
import { HttpError } from '../../util.js';
import type { StepContext } from './context.js';

/**
 * The checks every process-controlled request passes (ADR 0011: they stay in Steward's step functions, whatever the
 * engine): the outbound policy and the egress scan with the per-connection credential rule.
 */

/** Outbound destination policy context for this server (all configured platforms). */
export function engineOutboundContext(): OutboundContext {
  return outboundContext();
}

/**
 * Secrets of all platforms bound to this run, for egress scanning. The binding a request is sent with (`sender`, its
 * connection slot) may send its secrets to its own origins (credentialsAllowed); every other binding's secrets may not
 * be in the request at all (0.9.0: `foreign` – a platform's credentials only travel through its own connection). Two
 * slots bound to the same platform identity are one binding. A value both bindings have counts as the sender's; of
 * the other bindings only credentials count (credentialValues), not identifiers.
 */
export function secretBindings(ctx: StepContext, sender: string | null): SecretBinding[] {
  const own = sender ? ctx.bindings[sender] : undefined;
  const ownKey = own ? identityKey(own.platform) : null;
  const ownValues = new Set(own ? egressSecretValues(own.secrets) : []);
  return Object.entries(ctx.bindings).map(([slot, b]) =>
    ownKey && identityKey(b.platform) === ownKey
      ? { platformName: b.platform.name, values: egressSecretValues(b.secrets), allowed: (url: string) => credentialsAllowed(b.platform, b.secrets, url) }
      : {
          platformName: b.platform.name,
          // credentials only (no user names or client ids, 6+ characters): they would match ordinary text
          values: credentialValues(b.secrets).filter((v) => !ownValues.has(v)),
          allowed: () => false,
          foreign: { slot, sender: own ? sender : null },
        },
  );
}

/**
 * The egress scan of a process-controlled request (assertNoSecretLeak); a request that carries another connection's
 * credential is refused before anything is sent and audited (0.9.0, `run.secret_refused`, without the value).
 */
export async function scanSecrets(
  ctx: StepContext,
  key: string | undefined,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  bindings: SecretBinding[],
): Promise<void> {
  try {
    await assertNoSecretLeak(url, headers, body, bindings);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'SECRET_OTHER_SLOT') {
      const { slot, sender, platform } = (e.params ?? {}) as { slot?: string; sender?: string; platform?: string };
      audit({
        actor: ctx.actor,
        action: 'run.secret_refused',
        entityType: 'run',
        entityId: ctx.runId,
        runId: ctx.runId,
        summary: `Request ${sender ? `on connection "${sender}"` : 'without a connection'} refused: it contained a credential of connection "${slot}" (platform "${platform}")`,
        details: { stepKey: key ?? null, slot, sender: sender || null, platform, origin: originOfSafe(url) || null },
      });
    }
    throw e;
  }
}

/**
 * Gate a process-controlled outbound request: the destination must pass the
 * outbound policy (SSRF) and must not carry any bound platform's secret to an
 * origin that platform does not allow – nor another connection's secret at all
 * (0.9.0). `sender`: the connection slot the request is sent with. Shared by the
 * http, ai and browser nodes.
 */
export async function enforceOutbound(
  ctx: StepContext,
  url: string,
  o: { headers?: Record<string, string>; body?: unknown; platformOrigins?: string[]; sender: string | null; key?: string },
): Promise<void> {
  await assertOutboundAllowed(url, engineOutboundContext(), { platformOrigins: o.platformOrigins });
  await scanSecrets(ctx, o.key, url, o.headers ?? {}, o.body, secretBindings(ctx, o.sender));
}

export function originOfSafe(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
