import { useState } from 'react';
import { Box, Group, ScrollArea, Stack, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { CATEGORY_ORDER, NODE_TYPES, STEP_META, type NodeType } from '@sm/shared';
import { NODE_ICONS, nodeColor } from './meta';

export const DND_TYPE = 'application/x-sm-node';

/** Node types the user can add (start exists exactly once). */
const ADDABLE = NODE_TYPES.filter((t) => t !== 'start');

export function Palette({ onAdd, compact = false }: { onAdd: (type: NodeType) => void; compact?: boolean }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const match = (t: NodeType) => !needle || STEP_META[t].label.toLowerCase().includes(needle) || STEP_META[t].description.toLowerCase().includes(needle);
  return (
    <Stack gap={6} h="100%">
      <TextInput size="xs" placeholder="Search nodes" leftSection={<IconSearch size={12} />} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
        <Stack gap={8}>
          {CATEGORY_ORDER.map((cat) => {
            const types = ADDABLE.filter((t) => STEP_META[t].category === cat && match(t));
            if (!types.length) return null;
            return (
              <Box key={cat}>
                <Text size="10px" fw={700} tt="uppercase" c="dimmed" mb={4}>
                  {cat}
                </Text>
                <Stack gap={4}>
                  {types.map((t) => {
                    const Icon = NODE_ICONS[t];
                    const color = nodeColor(t);
                    return (
                      <Tooltip key={t} label={STEP_META[t].description} multiline w={260} position="right" withArrow openDelay={500} disabled={compact}>
                        <UnstyledButton
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData(DND_TYPE, t);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          onClick={() => onAdd(t)}
                          style={{
                            display: 'block',
                            borderRadius: 6,
                            border: '1px solid var(--mantine-color-default-border)',
                            background: 'var(--mantine-color-body)',
                            overflow: 'hidden',
                            cursor: 'grab',
                          }}
                        >
                          <Group gap={0} wrap="nowrap">
                            <Box
                              style={{
                                width: 24,
                                alignSelf: 'stretch',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: `var(--mantine-color-${color}-6)`,
                                color: 'white',
                              }}
                            >
                              <Icon size={13} />
                            </Box>
                            <Text size="xs" px={8} py={5} truncate>
                              {STEP_META[t].label}
                            </Text>
                          </Group>
                        </UnstyledButton>
                      </Tooltip>
                    );
                  })}
                </Stack>
              </Box>
            );
          })}
        </Stack>
      </ScrollArea>
      {!compact && (
        <Text size="10px" c="dimmed">
          Drag onto the canvas or click to add.
        </Text>
      )}
    </Stack>
  );
}
