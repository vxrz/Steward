import type { CheckOf, DataContractFinding, MonitorStatus } from '@sm/shared';
import { runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { CheckSetupError } from '../monitors/platforms.js';
import { HttpError } from '../util.js';
import { currentDoc, findingsOf, lastRun, linkRows, visibleContract, type RunRow } from './service.js';
import { runContractTest } from './testing.js';

/**
 * The monitor check "Data contract" (#221): mode `test` runs the contract's test through the data contract service with
 * the monitor owner's rights (passed: up; warnings: `warningAs`; failed or error: `failAs`) and stores the full
 * report as a test run of the contract – the evidence the check's value points to; mode `findings` runs Steward's own
 * checks without the service (no owner, not tested within N days, the last test failed, columns of linked datasets and
 * tables that no longer match, lint errors). A test run of the monitor never calls the service: it judges the last
 * stored run.
 */

/** Saving or trying a check: the person doing it must see the contract (a hidden one answers like a missing one). */
export function requireVisibleContract(check: string, id: string): void {
  try {
    visibleContract(id);
  } catch {
    throw new HttpError(400, `Check "${check}": data contract "${id}" not found`, 'DATA_CONTRACT_NOT_FOUND', { id });
  }
}

const findingText = (f: DataContractFinding): string => {
  switch (f.kind) {
    case 'noOwner':
      return 'no owner';
    case 'notTested':
      return f.count === undefined ? 'never tested' : `not tested for ${f.count} days`;
    case 'lastTestFailed':
      return 'the last test failed';
    case 'columnsMissing':
      return `${f.schema}: missing in the source: ${(f.fields ?? []).join(', ')}`;
    case 'columnsExtra':
      return `${f.schema}: not in the contract: ${(f.fields ?? []).join(', ')}`;
    case 'lint':
      return `${f.count} lint error(s)`;
  }
};

function judgeRun(
  c: CheckOf<'data-contract'>,
  r: Pick<RunRow, 'id' | 'result' | 'headline' | 'checks_total' | 'checks_passed' | 'checks_failed' | 'checks_warning'>,
  name: string,
  note = '',
) {
  const status: MonitorStatus = r.result === 'passed' ? 'up' : r.result === 'warning' ? c.warningAs : c.failAs;
  const value = { run: r.id, result: r.result, checks: r.checks_total, passed: r.checks_passed, failed: r.checks_failed, warnings: r.checks_warning };
  return { status, message: `"${name}": ${r.result} – ${r.headline}${note}`.slice(0, 1000), value };
}

export async function dataContractCheck(
  c: CheckOf<'data-contract'>,
  ctx: { owner: string; now: () => number; timeoutMs: number; signal: AbortSignal; recorded?: { recorded: boolean } },
): Promise<{ status: MonitorStatus; message: string; value?: unknown }> {
  const u = findUserByName(ctx.owner);
  if (!u || !u.active) throw new CheckSetupError(`the monitor owner ${ctx.owner} is missing or deactivated`);
  const owner = toAuthUser(u);
  let row;
  try {
    row = runAs(owner, () => visibleContract(c.contract).row);
  } catch {
    throw new CheckSetupError(`data contract ${c.contract} does not exist or the monitor owner may not see it`);
  }
  if (c.mode === 'findings') {
    const findings = runAs(owner, () => findingsOf(row, currentDoc(row).doc, linkRows(row.id), { testedWithinDays: c.testedWithinDays, now: ctx.now() }));
    const errors = findings.filter((f) => f.severity === 'error');
    const value = { findings: findings.map((f) => f.kind), errors: errors.length };
    if (!findings.length) return { status: 'up', message: `"${row.name}": no findings`, value };
    const text = findings.map(findingText).join('; ');
    return { status: errors.length ? c.failAs : c.warningAs, message: `"${row.name}": ${text}`.slice(0, 1000), value };
  }
  if (ctx.recorded) {
    // a test run of the monitor: the last stored run, no call
    const last = lastRun(row.id, { realOnly: true });
    if (!last) return { status: 'unknown', message: `"${row.name}" has not been tested yet – a test run does not call the data contract service` };
    return judgeRun(c, last, row.name, ' (the last stored run – a test run does not call the service)');
  }
  try {
    // a test reads data: at least a minute, whatever the monitor's default time limit is (at most 300 s)
    const run = await runAs(owner, () =>
      runContractTest(row.id, { via: 'monitor', sourceId: null, signal: ctx.signal, timeoutMs: Math.max(ctx.timeoutMs, 60_000) }),
    );
    return judgeRun(
      c,
      {
        ...run,
        result: run.result,
        checks_total: run.checks.total,
        checks_passed: run.checks.passed,
        checks_failed: run.checks.failed,
        checks_warning: run.checks.warning,
      },
      row.name,
    );
  } catch (e) {
    if (e instanceof HttpError) throw new CheckSetupError(e.message);
    throw e;
  }
}
