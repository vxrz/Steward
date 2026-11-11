import { useState } from 'react';
import { Alert, Button, Code, Group, Paper, Radio, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconArrowBackUp, IconFileImport, IconUserEdit } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantStewardChoice, PlantStewardChoicesInput, PlantStewardFlag, PlantStewardFlags } from '@sm/shared';
import { showValue } from './EntryConflictDialog';

/**
 * The import's fields changed in Steward since the last import (0.19.0, ADR 0020 "Imports versus edits in Steward"):
 * per field the value the last import wrote, Steward's and the file's – keep Steward's (the default) or take the
 * file's, with shortcuts for all. Each field is a radio group with the entry and field as its legend; on a phone the
 * three values stack.
 */

export interface StewardState {
  take: PlantStewardChoice;
  /** Per field (key: kind, scope, id and path as JSON) */
  fields: Record<string, PlantStewardChoice>;
}

export const NO_STEWARD_CHOICES: StewardState = { take: 'steward', fields: {} };

const keyOf = (f: Pick<PlantStewardFlag, 'kind' | 'scope' | 'id' | 'path'>) => JSON.stringify([f.kind, f.scope, f.id, f.path]);

/** The import body's `changedInSteward`. */
export function stewardBody(s: StewardState): PlantStewardChoicesInput {
  return {
    take: s.take,
    fields: Object.entries(s.fields).map(([k, choice]) => {
      const [kind, scope, id, path] = JSON.parse(k) as [PlantStewardFlag['kind'], string, string, string];
      return { kind, scope, id, path, choice };
    }),
  };
}

const PAGE = 50;

export function StewardChoices({
  flags,
  value,
  onChange,
  busy,
}: {
  flags: PlantStewardFlags;
  value: StewardState;
  onChange: (next: StewardState) => void;
  busy: boolean;
}) {
  const { t } = useTranslation('plant');
  const { t: tc } = useTranslation('plantChanges');
  const [shown, setShown] = useState(PAGE);
  const choiceOf = (f: PlantStewardFlag): PlantStewardChoice => value.fields[keyOf(f)] ?? f.choice;
  const all = (take: PlantStewardChoice) => onChange({ take, fields: {} });
  const one = (f: PlantStewardFlag, choice: PlantStewardChoice) => onChange({ ...value, fields: { ...value.fields, [keyOf(f)]: choice } });
  const list = flags.flags.slice(0, shown);
  return (
    <Alert
      color="violet"
      variant="light"
      icon={<IconUserEdit size={18} aria-hidden />}
      title={t('import.steward.title', { count: flags.total })}
      data-testid="import-steward"
    >
      <Stack gap="sm">
        <Text size="sm">{t('import.steward.intro')}</Text>
        <Group gap="xs">
          <Button
            size="xs"
            variant={flags.kept === flags.total ? 'filled' : 'default'}
            leftSection={<IconArrowBackUp size={14} aria-hidden />}
            onClick={() => all('steward')}
            disabled={busy}
            data-testid="steward-keep-all"
          >
            {t('import.steward.keepAll')}
          </Button>
          <Button
            size="xs"
            variant={flags.kept === 0 ? 'filled' : 'default'}
            leftSection={<IconFileImport size={14} aria-hidden />}
            onClick={() => all('file')}
            disabled={busy}
            data-testid="steward-take-all"
          >
            {t('import.steward.takeAll')}
          </Button>
        </Group>
        <Text size="sm" fw={600} data-testid="steward-kept">
          {t('import.steward.kept', { kept: flags.kept, total: flags.total })}
        </Text>
        <Stack gap="xs" component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={t('import.steward.listLabel')}>
          {list.map((f) => (
            <Paper key={keyOf(f)} withBorder p="sm" component="li" data-testid="steward-field">
              <Radio.Group
                label={
                  <Text component="span" fw={600} style={{ overflowWrap: 'anywhere' }}>
                    {t('import.steward.legend', { kind: tc(`kinds.${f.kind}`), name: f.name, path: f.path })}
                  </Text>
                }
                value={choiceOf(f)}
                onChange={(v) => one(f, v as PlantStewardChoice)}
                name={`steward-${keyOf(f)}`}
              >
                <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs" mt={4}>
                  <div>
                    <Text size="xs" c="dimmed">
                      {t('import.steward.lastImport')}
                    </Text>
                    <Code block fz="xs" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {f.wholeEntry ? t('import.steward.unknown') : showValue(f.lastImport)}
                    </Code>
                  </div>
                  <div>
                    <Radio value="steward" label={t('import.steward.keep')} disabled={busy} />
                    <Code block fz="xs" mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {showValue(f.steward)}
                    </Code>
                  </div>
                  <div>
                    <Radio value="file" label={t('import.steward.take')} disabled={busy} />
                    <Code block fz="xs" mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {showValue(f.file)}
                    </Code>
                  </div>
                </SimpleGrid>
                {f.wholeEntry && (
                  <Text size="xs" c="dimmed" mt={4}>
                    {t('import.steward.wholeEntry')}
                  </Text>
                )}
              </Radio.Group>
            </Paper>
          ))}
        </Stack>
        {flags.flags.length > shown && (
          <Button size="xs" variant="subtle" w="fit-content" onClick={() => setShown(shown + PAGE)} data-testid="steward-more">
            {t('import.steward.showMore', { count: Math.min(PAGE, flags.flags.length - shown) })}
          </Button>
        )}
        {flags.total > flags.flags.length && (
          <Text size="xs" c="dimmed">
            {t('import.steward.rest', { count: flags.total - flags.flags.length })}
          </Text>
        )}
      </Stack>
    </Alert>
  );
}
