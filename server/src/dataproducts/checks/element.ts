import { elementCheckModes, type CheckOf } from '@sm/shared';
import { runAs, type AuthUser } from '../../auth/context.js';
import { db } from '../../db.js';
import { findUserByName, toAuthUser } from '../../auth/users.js';
import { CheckSetupError, platformFor, requireVisiblePlatform } from '../../monitors/platforms.js';
import { moduleEnabled } from '../../modules/registry.js';
import { HttpError } from '../../util.js';
import { elementAccess, usesModule } from '../access.js';
import { bindingsOf, elementRow, elementTeamIds, type ElementRow } from '../store.js';
import { kafkaFreshness, snowflakeFreshness, type CheckResult } from './freshness.js';
import { boundContracts, judgeSchema, readActualSchema } from './schema.js';

/**
 * The monitor check type `data-element` (ADR 0036 part 10, decision 17): the element's platform is read with the
 * monitor **owner's** use right and the platform's default identity, like every platform check; the element itself
 * must be one the owner may see. Saving or trying such a check needs the editor to see the element and to use its
 * platform (requireUsableElement) – one they may not see answers like a missing one.
 */

type Check = CheckOf<'data-element'>;

/** The element, if `u` may see it (owning teams in bulk: one statement). */
export function elementFor(u: AuthUser | null, id: string, job = false): ElementRow | null {
  const row = elementRow(id);
  if (!row) return null;
  // without a caller (an import, Git sync) every element is visible, as every platform is
  if (job && !u) return row;
  return elementAccess(u, elementTeamIds([row.id]).get(row.id) ?? []).permissions.includes('view') ? row : null;
}

/**
 * Saving or trying a check (as the editor): the element exists and they may see it, the mode fits its kind, and they
 * may use its platform. A hidden element answers like a missing one; so does its platform.
 */
export function requireUsableElement(check: string, c: Pick<Check, 'element' | 'mode' | 'qualitySource'>, u: AuthUser | null): ElementRow {
  const el = elementFor(u, c.element, true);
  if (!el) throw new HttpError(400, `Check "${check}": data element "${c.element}" not found`, 'DATA_ELEMENT_NOT_FOUND', { id: c.element });
  if (!elementCheckModes(el.kind).includes(c.mode))
    throw new HttpError(400, `Check "${check}": ${c.mode} is not read for a ${el.kind}`, 'DATA_ELEMENT_CHECK_MODE', { mode: c.mode, kind: el.kind });
  // the quality results Steward recorded are read from its own database: no platform is read
  if (storedResults(c)) return el;
  if (!el.platform_id)
    throw new HttpError(400, `Check "${check}": the element has no platform to read`, 'DATA_ELEMENT_CHECK_MODE', {
      mode: c.mode,
      kind: el.kind,
      context: 'noPlatform',
    });
  const p = requireVisiblePlatform(el.platform_id);
  if (u && !p.permissions.includes('use'))
    throw new HttpError(403, `You are not allowed to use platform "${p.name}"`, 'PLATFORM_USE_FORBIDDEN', { name: p.name });
  return el;
}

/** Runs the check as the monitor owner (monitors/checks.ts). */
export async function dataElementCheck(c: Check, ctx: { owner: string; now: () => number; recorded?: { recorded: boolean } }): Promise<CheckResult> {
  if (!moduleEnabled('dataProducts')) return { status: 'unknown', message: 'The data products module is off' };
  const u = findUserByName(ctx.owner);
  if (!u || !u.active) throw new CheckSetupError(`the monitor owner ${ctx.owner} is missing or deactivated`);
  const owner = toAuthUser(u);
  const el = usesModule(owner) ? elementFor(owner, c.element) : null;
  if (!el) throw new CheckSetupError(`data element ${c.element} does not exist or the monitor owner may not see it`);
  if (!elementCheckModes(el.kind).includes(c.mode))
    return { status: 'unknown', message: `The ${c.mode} of a ${el.kind} is not read – link a check of your own` };
  if (!el.platform_id) return { status: 'unknown', message: `${el.qualified_name} has no platform to read` };
  if (ctx.recorded) return { status: 'unknown', message: `A test run does not read ${el.qualified_name} – try the check in the editor instead` };
  // 0.24.0: the quality results Steward recorded (dbt, contract tests, DMF) – no platform read
  if (storedResults(c)) {
    const { storedQuality } = await import('./quality.js');
    return storedQuality(c, el, ctx.now());
  }
  // the owner's use right on the element's platform, checked again at least once a minute (monitors/platforms.ts)
  const { platform, secrets } = platformFor(ctx.owner, el.platform_id);
  const now = ctx.now();
  try {
    if (c.mode === 'freshness') {
      if (el.kind.startsWith('snowflake.')) {
        if (platform.kind !== 'snowflake') return { status: 'unknown', message: `"${platform.name}" is not a Snowflake platform` };
        const { SnowflakeClient } = await import('../../snowflake/client.js');
        return await snowflakeFreshness(c, el, new SnowflakeClient(platform, secrets), now);
      }
      return await kafkaFreshness(c, el, platform, secrets, now);
    }
    // 0.24.0 (phase 2): volume by metadata, Data Metric Function results
    if (c.mode === 'volume' || c.mode === 'quality') {
      if (el.kind.startsWith('snowflake.')) {
        if (platform.kind !== 'snowflake') return { status: 'unknown', message: `"${platform.name}" is not a Snowflake platform` };
        const { SnowflakeClient } = await import('../../snowflake/client.js');
        const sf = new SnowflakeClient(platform, secrets);
        if (c.mode === 'volume') return await (await import('./volume.js')).snowflakeVolume(c, el, sf, now);
        return await (await import('./quality.js')).snowflakeDmf(c, el, sf);
      }
      if (c.mode === 'volume') return await (await import('./volume.js')).kafkaVolume(c, el, platform, secrets, now);
      return {
        status: 'unknown',
        message: `Data Metric Function results are read for Snowflake tables only – use the recorded quality results for ${el.qualified_name}`,
      };
    }
    const actual = await runAs(owner, () => readActualSchema(el, platform, secrets, { schemaVersion: c.schemaVersion }));
    const bindings = bindingsOf(outputPortIdsOf(el.id));
    return runAs(owner, () => judgeSchema(c, el, actual, boundContracts(el, bindings)));
  } catch (e) {
    if (e instanceof CheckSetupError) throw e;
    const { snowflakeJwtHint } = await import('../../platforms/jwt.js');
    const msg = platform.kind === 'snowflake' ? snowflakeJwtHint((e as Error).message.slice(0, 500), platform.config.variables) : (e as Error).message;
    return { status: 'unknown', message: `${el.qualified_name} could not be read: ${msg}`.slice(0, 1000) };
  }
}

/** The quality mode on Steward's recorded results (the default source): no platform read. */
const storedResults = (c: Pick<Check, 'mode' | 'qualitySource'>): boolean => c.mode === 'quality' && (c.qualitySource ?? 'results') === 'results';

/** The output ports whose bindings expose the element. */
function outputPortIdsOf(elementId: string): string[] {
  return db()
    .all<{ port_id: string }>(
      `SELECT DISTINCT b.port_id FROM dp_port_elements pe JOIN dp_port_bindings b ON b.id = pe.binding_id JOIN dp_ports p ON p.id = b.port_id
       WHERE pe.element_id = ? AND p.direction = 'output'`,
      elementId,
    )
    .map((r) => r.port_id);
}
