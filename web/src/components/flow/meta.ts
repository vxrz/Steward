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
  IconBoxMultiple,
} from '@tabler/icons-react';
import { STEP_META, type FlowNode, type NodeType } from '@sm/shared';
import i18n from '../../i18n';
import { optionLabel } from '../../i18n/meta';

export const NODE_ICONS: Record<NodeType, typeof IconApi> = {
  start: IconPlayerPlayFilled,
  http: IconApi,
  subprocess: IconBoxMultiple,
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

type PortId = 'out' | 'error' | 'true' | 'false' | 'each' | 'done' | 'approved' | 'rejected';
const PORT_IDS = ['out', 'error', 'true', 'false', 'each', 'done', 'approved', 'rejected'];

/** What each output port means – shown in the properties panel. */
export const portHelp = (id: string): string => (PORT_IDS.includes(id) ? i18n.t(`editor:portHelp.${id as PortId}`) : '');

const short = (s: unknown, n = 60): string => {
  const t = typeof s === 'string' ? s : s === undefined || s === null ? '' : JSON.stringify(s);
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** One-line summary shown on the canvas node. */
export function nodeSummary(n: FlowNode): string {
  switch (n.type) {
    case 'start':
      return i18n.t('editor:summary.start');
    case 'http':
      return `${n.method} ${short(n.path, 48)}`;
    case 'set':
      return short(Object.keys(n.values ?? {}).join(', '));
    case 'forEach':
      return i18n.t('editor:summary.forEach', { as: n.as, items: short(n.items, (n.concurrency ?? 1) > 1 ? 30 : 40) });
    case 'if':
      return short(n.condition);
    case 'userTask':
      return `${optionLabel(n.mode)}: ${short(n.title, 44)}`;
    case 'check':
      return short(n.condition);
    case 'log':
      return short(n.message);
    case 'report':
      return short(n.title);
    case 'browser':
      return i18n.t('editor:summary.actions', { count: n.actions?.length ?? 0 });
    case 'publish':
      return `→ ${n.dataset}`;
    case 'subprocess':
      return n.process
        ? i18n.t(n.version ? 'editor:summary.subprocessVersion' : 'editor:summary.subprocess', { process: n.process, version: n.version })
        : i18n.t('editor:summary.noProcess');
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
