import { DATABASE_KIND, type CheckOf, type DbSchemaChange, type MonitorStatus } from '@sm/shared';
import { runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { CheckSetupError, platformFor } from '../monitors/platforms.js';
import { redactSecrets } from '../platforms/testConnection.js';
import { changesSince, hasSnapshot, newestChange, readForCheck, subjectOf } from './service.js';

/**
 * The monitor check "Database schema changes" (#222): the snapshots of a database platform (the monitor owner may use
 * it) or a system (the owner may see it) taken within the last `withinHours` – a breaking change (mode breaking, the
 * default) or any change (mode changed) fails the check. With `read: true` the platform is read first; a test run
 * never connects and judges the stored snapshots.
 */

export const changeText = (c: DbSchemaChange): string =>
  `${c.table}${c.column ? `.${c.column}` : ''}: ${c.kind.replace(/-/g, ' ')}${c.before || c.after ? ` (${[c.before, c.after].filter((x) => x !== undefined && x !== null).join(' → ')})` : ''}`;

export async function dbSchemaCheck(
  c: CheckOf<'db-schema'>,
  ctx: { owner: string; now: () => number; recorded?: { recorded: boolean } },
): Promise<{ status: MonitorStatus; message: string; value?: unknown }> {
  let kind: 'platform' | 'system';
  let id: string;
  let name: string;
  let secrets: Record<string, string> = {};
  if (!c.platform === !c.system) throw new CheckSetupError('name a database platform or a system (one of them)');
  if (c.platform) {
    const x = platformFor(ctx.owner, c.platform);
    if (x.platform.kind !== DATABASE_KIND) return { status: 'unknown', message: `Check could not run: "${x.platform.name}" is not a database platform` };
    kind = 'platform';
    id = x.platform.id;
    name = x.platform.name;
    secrets = x.secrets;
  } else {
    const u = findUserByName(ctx.owner);
    if (!u || !u.active) throw new CheckSetupError(`the monitor owner ${ctx.owner} is missing or deactivated`);
    let s;
    try {
      s = runAs(toAuthUser(u), () => subjectOf('system', c.system!));
    } catch {
      throw new CheckSetupError(`system ${c.system} does not exist or the monitor owner may not see it`);
    }
    kind = 'system';
    id = s.id;
    name = s.name;
  }
  let readNote = '';
  if (c.read && kind === 'platform' && !ctx.recorded) {
    try {
      const r = await readForCheck(id);
      readNote = r.created ? ' – read: new snapshot' : ' – read: unchanged';
    } catch (e) {
      return { status: 'unknown', message: redactSecrets(`The schema of "${name}" could not be read: ${(e as Error).message}`, secrets).slice(0, 1000) };
    }
  }
  if (!hasSnapshot(kind, id)) return { status: c.noData, message: `"${name}" has no schema snapshot yet${readNote}` };
  const since = new Date(ctx.now() - c.withinHours * 3_600_000).toISOString();
  const x = changesSince(kind, id, since);
  const window = `${c.withinHours} h`;
  const value = { changes: x.changes, breaking: x.breaking, snapshots: x.snapshots.length };
  if (c.mode === 'breaking') {
    if (x.breaking > 0) {
      const first = newestChange(kind, id, since, true);
      return {
        status: c.failAs ?? 'down',
        message: `${x.breaking} breaking schema change(s) in ${window}${first ? `, e.g. ${changeText(first)}` : ''}${readNote}`.slice(0, 1000),
        value,
      };
    }
    return { status: 'up', message: `No breaking schema change in ${window}${x.changes ? ` (${x.changes} other change(s))` : ''}${readNote}`, value };
  }
  if (x.changes > 0) {
    const first = newestChange(kind, id, since, false);
    return {
      status: c.failAs ?? 'degraded',
      message:
        `${x.changes} schema change(s) in ${window}${x.breaking ? `, ${x.breaking} breaking` : ''}${first ? `, e.g. ${changeText(first)}` : ''}${readNote}`.slice(
          0,
          1000,
        ),
      value,
    };
  }
  return { status: 'up', message: `No schema change in ${window}${readNote}`, value };
}
