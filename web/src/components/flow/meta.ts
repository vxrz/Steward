import {
  IconChartBar,
  IconApi,
  IconArrowsSplit,
  IconBrowser,
  IconChecklist,
  IconClock,
  IconMessage,
  IconNote,
  IconPlayerPlayFilled,
  IconRepeat,
  IconReport,
  IconUserCheck,
  IconVariable,
  IconX,
} from '@tabler/icons-react';
import { STEP_META, type FlowNode, type NodeType } from '@sm/shared';

export const NODE_ICONS: Record<NodeType, typeof IconApi> = {
  start: IconPlayerPlayFilled,
  http: IconApi,
  set: IconVariable,
  forEach: IconRepeat,
  if: IconArrowsSplit,
  userTask: IconUserCheck,
  check: IconChecklist,
  log: IconMessage,
  report: IconReport,
  browser: IconBrowser,
  publish: IconChartBar,
  wait: IconClock,
  fail: IconX,
  note: IconNote,
};

export const nodeColor = (type: NodeType): string => STEP_META[type]?.color ?? 'gray';

/** What each output port means – shown in the properties panel. */
export const PORT_HELP: Record<string, string> = {
  out: 'Continues here when the node has finished.',
  error: 'Taken when the node fails. If unconnected, the run fails (unless "On error" is continue).',
  true: 'Taken when the condition is true.',
  false: 'Taken when the condition is false.',
  each: 'Runs once per item. Leave the last node of the loop body unconnected – the loop then continues with the next item.',
  done: 'Continues here after all items were processed.',
  approved: 'Taken when the task is approved (also when the node is skipped).',
  rejected: 'Taken when the task is rejected. If unconnected, a rejection fails the run.',
};

const short = (s: unknown, n = 60): string => {
  const t = typeof s === 'string' ? s : s === undefined || s === null ? '' : JSON.stringify(s);
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** One-line summary shown on the canvas node. */
export function nodeSummary(n: FlowNode): string {
  switch (n.type) {
    case 'start':
      return 'Run starts here';
    case 'http':
      return `${n.method} ${short(n.path, 48)}`;
    case 'set':
      return short(Object.keys(n.values ?? {}).join(', '));
    case 'forEach':
      return `each ${n.as} in ${short(n.items, 40)}`;
    case 'if':
      return short(n.condition);
    case 'userTask':
      return `${n.mode}: ${short(n.title, 44)}`;
    case 'check':
      return short(n.condition);
    case 'log':
      return short(n.message);
    case 'report':
      return short(n.title);
    case 'browser':
      return `${n.actions?.length ?? 0} action(s)`;
    case 'publish':
      return `→ ${n.dataset}`;
    case 'wait':
      return `${n.seconds}s`;
    case 'fail':
      return short(n.message);
    case 'note':
      return short(n.text);
    default:
      return '';
  }
}
