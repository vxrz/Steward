import { ActionIcon, Badge, Box, Button, Group, Menu, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconApi,
  IconArrowDown,
  IconArrowUp,
  IconArrowsSplit,
  IconBrowser,
  IconChecklist,
  IconClock,
  IconCopy,
  IconFilter,
  IconFolder,
  IconMessage,
  IconPlus,
  IconRepeat,
  IconReport,
  IconTrash,
  IconUserCheck,
  IconVariable,
  IconX,
} from '@tabler/icons-react';
import { STEP_META, STEP_TYPES, type Step, type StepType } from '@sm/shared';
import { locKey, type BlockRef, type Loc } from './paths';

export const STEP_ICONS: Record<StepType, typeof IconApi> = {
  http: IconApi,
  set: IconVariable,
  forEach: IconRepeat,
  if: IconArrowsSplit,
  group: IconFolder,
  userTask: IconUserCheck,
  check: IconChecklist,
  log: IconMessage,
  report: IconReport,
  browser: IconBrowser,
  wait: IconClock,
  fail: IconX,
};

const CATEGORY_COLORS: Record<string, string> = {
  API: 'blue',
  Data: 'teal',
  Control: 'grape',
  People: 'violet',
  Evidence: 'green',
  Browser: 'orange',
};

const CATEGORIES = ['API', 'Data', 'Control', 'People', 'Evidence', 'Browser'] as const;

export function stepColor(type: StepType): string {
  return CATEGORY_COLORS[STEP_META[type]?.category] ?? 'gray';
}

function clip(s: unknown, n = 70): string {
  const t = typeof s === 'string' ? s : s === undefined ? '' : JSON.stringify(s);
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

export function stepSummary(s: Step): string {
  switch (s.type) {
    case 'http':
      return `${s.method} ${clip(s.path)}`;
    case 'set':
      return Object.keys(s.values ?? {}).join(', ');
    case 'forEach':
      return `each ${s.as} in ${clip(s.items, 50)}`;
    case 'if':
      return clip(s.condition);
    case 'userTask':
      return `${s.mode}: ${clip(s.title, 60)}`;
    case 'check':
      return clip(s.condition);
    case 'log':
      return clip(s.message);
    case 'report':
      return clip(s.title);
    case 'browser':
      return `${s.actions?.length ?? 0} action(s)`;
    case 'wait':
      return `${s.seconds}s`;
    case 'fail':
      return clip(s.message);
    default:
      return '';
  }
}

export interface TreeActions {
  selected: string;
  onSelect: (loc: Loc) => void;
  onAdd: (ref: BlockRef, index: number, type: StepType) => void;
  onMove: (loc: Loc, delta: number) => void;
  onDuplicate: (loc: Loc) => void;
  onRemove: (loc: Loc) => void;
}

export function AddStepMenu({ onPick, label = 'Add step', compact }: { onPick: (t: StepType) => void; label?: string; compact?: boolean }) {
  return (
    <Menu shadow="md" width={260} position="bottom-start" withinPortal>
      <Menu.Target>
        <Button size="compact-xs" variant={compact ? 'subtle' : 'light'} leftSection={<IconPlus size={12} />}>
          {label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {CATEGORIES.map((cat) => {
          const types = STEP_TYPES.filter((t) => STEP_META[t].category === cat);
          return (
            <Box key={cat}>
              <Menu.Label>{cat}</Menu.Label>
              {types.map((t) => {
                const Icon = STEP_ICONS[t];
                return (
                  <Menu.Item key={t} leftSection={<Icon size={14} />} onClick={() => onPick(t)}>
                    <Text size="sm">{STEP_META[t].label}</Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {STEP_META[t].description}
                    </Text>
                  </Menu.Item>
                );
              })}
            </Box>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}

export function StepList({ steps, refBlock, actions }: { steps: Step[]; refBlock: BlockRef; actions: TreeActions }) {
  return (
    <Stack gap={6}>
      {steps.map((s, i) => (
        <StepNode key={`${s.id}-${i}`} step={s} loc={[...refBlock.parent, { block: refBlock.block, index: i }]} count={steps.length} actions={actions} />
      ))}
      <Group gap={4}>
        <AddStepMenu compact={steps.length > 0} label={steps.length ? 'Add step' : 'Add first step'} onPick={(t) => actions.onAdd(refBlock, steps.length, t)} />
      </Group>
    </Stack>
  );
}

function StepNode({ step, loc, count, actions }: { step: Step; loc: Loc; count: number; actions: TreeActions }) {
  const meta = STEP_META[step.type];
  const Icon = STEP_ICONS[step.type] ?? IconApi;
  const key = locKey(loc);
  const selected = actions.selected === key;
  const index = loc[loc.length - 1]!.index;
  const blocks = meta?.blocks ?? [];
  return (
    <Box>
      <Box
        className={`step-row clickable${selected ? ' selected' : ''}`}
        px={8}
        py={6}
        onClick={() => actions.onSelect(loc)}
        role="button"
        aria-pressed={selected}
      >
        <Group gap={8} wrap="nowrap" align="flex-start">
          <Badge size="sm" variant="light" color={stepColor(step.type)} leftSection={<Icon size={12} />} style={{ flexShrink: 0 }}>
            {meta?.label ?? step.type}
          </Badge>
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Group gap={4} wrap="nowrap">
              <Text size="sm" fw={500} truncate>
                {step.name || step.id}
              </Text>
              {step.when && (
                <Tooltip label={`Only when: ${step.when}`} withArrow multiline maw={320}>
                  <IconFilter size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
                </Tooltip>
              )}
              {step.onError === 'continue' && (
                <Badge size="xs" variant="outline" color="gray" style={{ flexShrink: 0 }}>
                  continue on error
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" className="mono" truncate>
              {stepSummary(step)}
            </Text>
          </Box>
          <Group gap={0} wrap="nowrap" onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ActionIcon size="sm" variant="subtle" disabled={index === 0} onClick={() => actions.onMove(loc, -1)} aria-label="Move up">
              <IconArrowUp size={14} />
            </ActionIcon>
            <ActionIcon size="sm" variant="subtle" disabled={index >= count - 1} onClick={() => actions.onMove(loc, 1)} aria-label="Move down">
              <IconArrowDown size={14} />
            </ActionIcon>
            <ActionIcon size="sm" variant="subtle" onClick={() => actions.onDuplicate(loc)} aria-label="Duplicate">
              <IconCopy size={14} />
            </ActionIcon>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              aria-label="Delete"
              onClick={() => {
                if (window.confirm(`Delete step "${step.name || step.id}"${blocks.length ? ' and all nested steps' : ''}?`)) actions.onRemove(loc);
              }}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        </Group>
      </Box>
      {blocks.map((b) => {
        const children = ((step as unknown as Record<string, Step[] | undefined>)[b.key] ?? []) as Step[];
        return (
          <Box key={b.key} className="step-block" mt={6}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
              {b.label}
            </Text>
            <StepList steps={children} refBlock={{ parent: loc, block: b.key }} actions={actions} />
          </Box>
        );
      })}
    </Box>
  );
}
