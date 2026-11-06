import type { NodeOf, StepStatus } from '@sm/shared';
import { db } from '../db.js';
import { runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { permissionsOf, type ContractRow } from './service.js';
import { runContractTest } from './testing.js';

/**
 * The process step "Test a data contract" (#221): the contract's test through its data contract service with the
 * rights of the run's actor, for one-off or scheduled runs. The test run (with its full report) is stored with the
 * contract; the step's result names it. Dry runs test too – a test only reads – but their run neither notifies nor
 * counts as the contract's last test; test runs never call the service. A test that does not pass marks the step failed
 * (like a check) and the run goes on – unless `failRun`, then it fails the run (or its "error" port takes over).
 */

export interface ContractStepContext {
  contract: string;
  server?: string;
  actor: string;
  runId: string;
  dryRun: boolean;
  recorded: boolean;
  signal: AbortSignal;
  setInput: (input: unknown) => void;
  log: (level: 'info' | 'warn', message: string) => void;
}

/** The contract by Steward's id or its ODCS id, as the actor may see it. */
function resolve(ref: string): ContractRow {
  const byId = db().get<ContractRow>('SELECT * FROM data_contracts WHERE id = ?', ref);
  const candidates = byId ? [byId] : db().all<ContractRow>('SELECT * FROM data_contracts WHERE contract_key = ? ORDER BY created_at, id', ref);
  const visible = candidates.filter((r) => permissionsOf(r).includes('view'));
  if (!visible.length) throw new Error(`Data contract "${ref}" not found`);
  if (visible.length > 1) throw new Error(`${visible.length} data contracts have the id "${ref}" – name one by Steward's id (dct_…)`);
  return visible[0]!;
}

export async function runContractTestStep(
  step: NodeOf<'contractTest'>,
  ctx: ContractStepContext,
): Promise<{ output: unknown; summary: string; status?: StepStatus }> {
  const u = findUserByName(ctx.actor);
  if (!u || !u.active) throw new Error(`The run's actor ${ctx.actor} is missing or deactivated`);
  return runAs(toAuthUser(u), async () => {
    const row = resolve(ctx.contract.trim());
    const asked = { contract: { id: row.id, key: row.contract_key, name: row.name }, server: ctx.server || row.test_server || null };
    if (ctx.recorded) {
      ctx.setInput({ ...asked, testRun: true });
      ctx.log('info', 'TEST RUN – the data contract service is not called');
      return { output: { ...asked, result: 'skipped', testRun: true }, summary: `"${row.name}" not tested (test run)` };
    }
    ctx.setInput(asked);
    if (ctx.dryRun) ctx.log('info', 'DRY RUN – the test runs: it only reads; it does not notify and does not count as the last test');
    const run = await runContractTest(row.id, { via: 'process', sourceId: ctx.runId, server: ctx.server || undefined, dryRun: ctx.dryRun, signal: ctx.signal });
    const output = {
      ...asked,
      server: run.server,
      run: run.id,
      version: run.version,
      result: run.result,
      checks: run.checks,
      headline: run.headline,
      link: `/data-contracts/${row.id}/tests?run=${run.id}`,
    };
    const passed = run.result === 'passed' || (run.result === 'warning' && !step.failOnWarning);
    const summary = `"${row.name}" v${run.version} on ${run.server}: ${run.result} (${run.checks.passed}/${run.checks.total} checks passed)`;
    if (!passed) {
      ctx.log('warn', `${summary} – ${run.headline}`);
      if (step.failRun) throw new Error(`Data contract test ${run.result}: ${summary} – ${run.headline}`);
      // like a check: the step is marked failed and the run goes on
      return { output, summary: `✘ ${summary}`, status: 'failed' };
    }
    return { output, summary: `✔ ${summary}` };
  });
}
