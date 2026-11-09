import { useEffect, useState } from 'react';
import { Alert, Button, Code, Group, Modal, Radio, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconGitMerge } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { mergeThreeWay, resolveMerge, type PlantEntryChanged } from '@sm/shared';
import { setEntryChangedHandler } from '../../../api';

/** A value as plain text ("–" for nothing). */
export const showValue = (v: unknown): string => (v === null || v === undefined || v === '' ? '–' : typeof v === 'string' ? v : JSON.stringify(v, null, 1));

interface Ask {
  changed: PlantEntryChanged;
  mine: Record<string, unknown>;
  resolve: (body: Record<string, unknown> | null) => void;
}

/**
 * 409 PLANT_ENTRY_CHANGED (0.13.0, docs/PLANT.md "Change sets"), mounted once for the whole app: someone else changed
 * the entry since the form loaded it. What only they changed is taken over, what only the person changed stays; for
 * every field both changed the person chooses _Keep mine_ or _Take theirs_ (a radio group per field, its path as the
 * legend, the three values in words). The save is then sent again with the entry's revision now.
 */
export function EntryConflictDialog() {
  const { t } = useTranslation(['plantChanges', 'common']);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [choice, setChoice] = useState<Record<string, 'mine' | 'theirs'>>({});
  useEffect(() => {
    setEntryChangedHandler(
      (changed, mine) =>
        new Promise((resolve) => {
          setChoice({});
          setAsk({ changed, mine, resolve });
        }),
    );
    return () => setEntryChangedHandler(undefined);
  }, []);
  if (!ask) return null;
  const { changed, mine } = ask;
  const { revision: _r, ...body } = mine;
  const merge = mergeThreeWay(changed.base, changed.current, body);
  const finish = (save: boolean) => {
    ask.resolve(save ? (resolveMerge(merge.merged, merge.conflicts, (c) => choice[c.keys.join('.')] ?? 'mine') as Record<string, unknown>) : null);
    setAsk(null);
  };
  const taken = Object.keys(changed.current).filter(
    (k) => JSON.stringify(changed.current[k]) !== JSON.stringify(changed.base[k]) && JSON.stringify(body[k]) === JSON.stringify(changed.base[k]),
  );
  return (
    <Modal
      opened
      onClose={() => finish(false)}
      size="lg"
      zIndex={1000}
      title={
        <Group gap="xs" wrap="nowrap">
          <IconGitMerge size={18} aria-hidden />
          <Text fw={600}>{t('entryChanged.title')}</Text>
        </Group>
      }
      closeButtonProps={{ 'aria-label': t('common:close') }}
      data-testid="entry-conflict-dialog"
    >
      <Stack gap="sm">
        <Text size="sm">{t('entryChanged.intro')}</Text>
        {taken.length > 0 && (
          <Alert variant="light" color="blue" data-testid="entry-conflict-taken">
            {t('entryChanged.taken', { fields: taken.join(', ') })}
          </Alert>
        )}
        {merge.conflicts.length === 0 && <Text size="sm">{t('entryChanged.none')}</Text>}
        {merge.conflicts.map((c) => {
          const key = c.keys.join('.');
          return (
            <Radio.Group
              key={key}
              label={
                <Text component="span" fw={600} className="mono">
                  {c.path}
                </Text>
              }
              value={choice[key] ?? 'mine'}
              onChange={(v) => setChoice((x) => ({ ...x, [key]: v as 'mine' | 'theirs' }))}
              data-testid={`entry-conflict-${key}`}
            >
              <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs" mt={4}>
                <div>
                  <Text size="xs" c="dimmed">
                    {t('conflict.base')}
                  </Text>
                  <Code block fz="xs" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {showValue(c.base)}
                  </Code>
                </div>
                <div>
                  <Radio value="theirs" label={t('conflict.takeTheirs')} />
                  <Code block fz="xs" mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {showValue(c.theirs)}
                  </Code>
                </div>
                <div>
                  <Radio value="mine" label={t('conflict.keepMine')} />
                  <Code block fz="xs" mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {showValue(c.mine)}
                  </Code>
                </div>
              </SimpleGrid>
            </Radio.Group>
          );
        })}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => finish(false)}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => finish(true)} data-testid="entry-conflict-save">
            {t('entryChanged.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
