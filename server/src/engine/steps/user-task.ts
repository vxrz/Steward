import type { NodeOf, TaskDecision, TaskItem, TaskRecord } from '@sm/shared';
import { ANY, INPUT } from '../../ai/provenance.js';
import { audit } from '../../audit.js';
import { emit } from '../../events.js';
import { newId } from '../../util.js';
import { stringify } from '../expr.js';
import { manualSpec } from '../manual.js';
import * as store from '../store.js';
import { Cancelled, type LeafResult, type StepContext, type StepExecutor, type TaskResult } from './context.js';

/**
 * "Ask a person": a decision, a selection or a manual step (MANUAL-STEPS.md). The task is stored with the run; the
 * run waits (and holds no slot) until a signal decides it, or replays up to it after a restart. A debug run answers it
 * in the engine instead (simulated, ADR 0010), from the same view of the task (taskView).
 */
export const userTaskStep: StepExecutor<'userTask'> = {
  type: 'userTask',
  exec: execUserTask,
  // what a person entered counts as an input of the run
  sources: () => [ANY, INPUT],
};

const hasWires = (ctx: StepContext, nodeId: string, port: string): boolean => ctx.def.wires.some((w) => w.from === nodeId && w.port === port);

/** What a decision, selection or manual step shows: its title, instructions and (selection) items. */
export async function taskView(step: NodeOf<'userTask'>, ctx: StepContext) {
  const title = await ctx.str(step.title);
  const instructions = step.instructions ? await ctx.str(step.instructions) : undefined;
  let rawItems: unknown[] = [];
  const items: TaskItem[] = [];
  const columns = step.columns?.length ? step.columns : [{ label: 'Item', value: '$string($)' }];
  if (step.mode === 'select') {
    rawItems = await ctx.list(step.items ?? '[]');
    for (let i = 0; i < rawItems.length; i++) {
      const it = rawItems[i];
      const k = step.itemKey ? stringify(await ctx.item(step.itemKey, it)) : String(i);
      items.push({
        key: k || String(i),
        cells: await Promise.all(columns.map(async (c) => stringify(await ctx.item(c.value, it)))),
        preselected: step.preselect ? Boolean(await ctx.item(step.preselect, it)) : true,
      });
    }
  }
  return { title, instructions, rawItems, items, columns };
}

async function execUserTask(step: NodeOf<'userTask'>, ctx: StepContext, key: string): Promise<LeafResult> {
  const { title, instructions, rawItems, items, columns } = await taskView(step, ctx);
  let task = store.findTask(ctx.runId, key);
  if (!task) {
    const id = newId('task_');
    store.insertTask({
      id,
      runId: ctx.runId,
      stepKey: key,
      mode: step.mode,
      title,
      instructions,
      columns: step.mode === 'manual' ? [] : columns,
      items: ctx.redactor.apply(items),
      assignees: step.assignees ?? [],
      fourEyes: !!step.fourEyes,
      ...(step.mode === 'manual' ? { manual: manualSpec(step) } : {}),
    });
    emit('task.created', {
      taskId: id,
      runId: ctx.runId,
      processId: store.runRow(ctx.runId).process_id,
      processName: ctx.def.name,
      title,
      assignees: step.assignees ?? [],
      fourEyes: !!step.fourEyes,
      runActor: ctx.actor,
      dryRun: ctx.dryRun,
    });
    audit({
      actor: ctx.actor,
      action: 'task.created',
      entityType: 'task',
      entityId: id,
      runId: ctx.runId,
      summary: `${step.mode === 'manual' ? 'Waiting for manual step' : 'Waiting for decision'}: "${title}"${step.mode === 'select' ? ` (${items.length} items)` : ''}`,
    });
    task = store.getTask(id);
  }
  let result: TaskResult | null;
  if (task.status === 'completed' && task.decision) {
    result = { decision: task.decision, by: task.decidedBy ?? '', at: task.decidedAt ?? '' };
  } else if (task.status === 'cancelled') {
    throw new Cancelled();
  } else {
    store.setStepStatus(ctx.runId, key, 'waiting');
    ctx.beginWait();
    ctx.log('info', `${step.mode === 'manual' ? 'Waiting for manual step' : 'Waiting for user decision'}: ${title}`, key);
    try {
      result = await ctx.awaitTask(task.id);
    } finally {
      ctx.endWait();
    }
    if (!result) throw new Cancelled();
    store.setStepStatus(ctx.runId, key, 'running');
  }
  const { decision, by, at } = result;
  if (step.mode === 'manual') return manualOutput(store.getTask(task.id), ctx, key, decision, by);
  if (step.mode === 'approve') {
    ctx.log('info', `${decision.approved ? 'Approved' : 'Rejected'} by ${by}${decision.comment ? `: ${decision.comment}` : ''}`, key);
    if (!decision.approved && !hasWires(ctx, step.id, 'rejected')) throw new Error(`Rejected by ${by}${decision.comment ? `: ${decision.comment}` : ''}`);
    return {
      output: { approved: decision.approved, comment: decision.comment ?? '', decidedBy: by, decidedAt: at },
      summary: `${decision.approved ? 'Approved' : 'Rejected'} by ${by}`,
    };
  }
  const sel = new Set(decision.selectedKeys);
  const selected = rawItems.filter((_, i) => sel.has(items[i]!.key));
  const unselected = rawItems.filter((_, i) => !sel.has(items[i]!.key));
  ctx.log('info', `${by} selected ${selected.length} of ${rawItems.length} item(s)`, key, { selectedKeys: decision.selectedKeys });
  return {
    output: {
      approved: true,
      selected,
      unselected,
      selectedKeys: decision.selectedKeys,
      comment: decision.comment ?? '',
      decidedBy: by,
      decidedAt: at,
    },
    summary: `${by} selected ${selected.length} of ${rawItems.length}`,
  };
}

/** A finished manual step: its entry becomes the node's output (vars.<saveAs>); a rejected verification with onReject "fail" fails the run. */
function manualOutput(t: TaskRecord, ctx: StepContext, key: string, decision: TaskDecision, by: string): LeafResult {
  const m = t.manual!;
  const sub = m.submission;
  const v = m.verification;
  if (!decision.approved) {
    const msg = `Verification rejected by ${v?.by ?? '?'}${v?.comment ? `: ${v.comment}` : ''}`;
    ctx.log('error', msg, key);
    throw new Error(msg);
  }
  ctx.log('info', `Completed by ${by}${v ? `, verified by ${v.by}` : ''}`, key);
  return {
    output: {
      completed: true,
      completedBy: sub?.completedBy ?? by,
      completedAt: sub?.completedAt ?? null,
      doneAt: sub?.doneAt ?? null,
      doneAtReason: sub?.doneAtReason ?? null,
      checklist: m.spec.checklist.map((item, i) => ({ item, checked: !!sub?.checked.includes(i) })),
      fields: Object.fromEntries((sub?.fields ?? []).map((f) => [f.id, f.value])),
      notAvailable: sub?.notAvailable ?? [],
      comment: sub?.comment ?? '',
      evidence: (sub?.evidence ?? []).map((e) => ({ filename: e.filename, size: e.size, sha256: e.sha256 })),
      verifiedBy: v?.by ?? null,
      verifiedAt: v?.at ?? null,
      rounds: m.round,
    },
    summary: `Completed by ${by}${v ? `, verified by ${v.by}` : ''}`,
  };
}
