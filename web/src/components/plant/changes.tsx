import { useState } from 'react';
import { Badge, Button, Code, Group, Paper, Stack, Table, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';
import type { PlantChange, PlantChangeAction, PlantChangeKind, PlantFieldDiff, PlantRecordType } from '@sm/shared';
import { usePlantLabel } from './common';

/**
 * What an import changes (the import's preview, and an assistant's plant proposal in the AI requests, 0.12.0): one row
 * per entry, and for a changed entry what differs, field by field. Values are shown as plain text.
 */

const KIND_TYPE: Partial<Record<PlantChangeKind, PlantRecordType>> = {
  site: 'site',
  area: 'area',
  work_center: 'workCenter',
  work_unit: 'workUnit',
  building: 'building',
  asset: 'asset',
};
/** Kinds of part 2 (#219) without an own display name */
type DataKind = 'profile' | 'kpi' | 'assignment' | 'collection_sinks';
export const ACTION_COLOR: Record<PlantChangeAction, string> = { add: 'green', change: 'blue', remove: 'red', mark: 'orange', unchanged: 'gray', skip: 'gray' };

/** The name of an entry's kind: the installation's label of a record type, else the kind's own. */
export function useKindLabel(): (k: PlantChangeKind) => string {
  const { t } = useTranslation('plant');
  const label = usePlantLabel();
  return (k) => {
    const type = KIND_TYPE[k];
    return type ? label(type) : t(`import.kinds.${k as DataKind}`);
  };
}

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '–' : typeof v === 'string' ? v : JSON.stringify(v));

/** A changed entry's differences, field by field: shown on request (they can be many). */
export function FieldDiffs({ diff, open: open0 = false }: { diff: PlantFieldDiff[]; open?: boolean }) {
  const { t } = useTranslation('plant');
  const [open, setOpen] = useState(open0);
  if (!diff.length) return null;
  return (
    <Stack gap={4} mt={4}>
      <Button size="compact-xs" variant="subtle" onClick={() => setOpen(!open)} aria-expanded={open} style={{ alignSelf: 'flex-start' }}>
        {open ? t('import.diff.hide') : t('import.diff.show', { count: diff.length })}
      </Button>
      {open && (
        <Stack gap={4} data-testid="field-diffs">
          {diff.map((d) => (
            <div key={d.path}>
              <Text size="xs" fw={600} className="mono" style={{ overflowWrap: 'anywhere' }}>
                {d.path}
              </Text>
              <Code block fz="xs" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {`${t('import.diff.before')}: ${show(d.before)}\n${t('import.diff.after')}: ${show(d.after)}`}
              </Code>
            </div>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export function ChangeTable({
  changes,
  kindLabel,
  diffsOpen = false,
}: {
  changes: PlantChange[];
  kindLabel: (k: PlantChangeKind) => string;
  diffsOpen?: boolean;
}) {
  const { t } = useTranslation('plant');
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const shown = changes.slice(0, 500);
  const what = (c: PlantChange) => (
    <>
      {c.fields?.length ? (
        <Group gap={4}>
          {c.fields.map((f) => (
            <Badge key={f} size="xs" variant="default">
              {t(`import.fields.${f as 'name'}`, { defaultValue: f })}
            </Badge>
          ))}
        </Group>
      ) : null}
      {c.diff && <FieldDiffs diff={c.diff} open={diffsOpen} />}
      {c.note && (
        <Text size="xs" c="dimmed">
          {noteKey(c.note) === 'other' ? c.note : t(`import.notes.${noteKey(c.note) as Exclude<ReturnType<typeof noteKey>, 'other'>}`)}
        </Text>
      )}
    </>
  );
  const more = changes.length > shown.length && (
    <Text size="xs" c="dimmed" mt={4}>
      {t('import.more', { count: changes.length - shown.length })}
    </Text>
  );
  // a phone: one card per entry, the differences at full width
  if (narrow)
    return (
      <Stack gap="xs" role="list" aria-label={t('import.changes')} data-testid="import-changes">
        {shown.map((c) => (
          <Paper key={`${c.kind}:${c.siteId}:${c.id}:${c.action}`} withBorder p="xs" role="listitem">
            <Group gap="xs" wrap="wrap">
              <Badge size="sm" color={ACTION_COLOR[c.action]} variant="light">
                {t(`import.actions.${c.action}`)}
              </Badge>
              <Text size="xs" c="dimmed">
                {kindLabel(c.kind)}
              </Text>
            </Group>
            <Text size="sm" mt={4} style={{ overflowWrap: 'anywhere' }}>
              {c.name}
            </Text>
            <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
              {c.kind === 'site' || !c.siteId ? c.id : `${c.siteId} / ${c.id}`}
            </Text>
            {what(c)}
          </Paper>
        ))}
        {more}
      </Stack>
    );
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={t('import.changes')}>
      <Table fz="sm" aria-label={t('import.changes')} data-testid="import-changes">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('import.action')}</Table.Th>
            <Table.Th>{t('import.kind')}</Table.Th>
            <Table.Th>{t('form.name')}</Table.Th>
            <Table.Th>{t('import.what')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {shown.map((c) => (
            <Table.Tr key={`${c.kind}:${c.siteId}:${c.id}:${c.action}`}>
              <Table.Td className="nowrap">
                <Badge size="sm" color={ACTION_COLOR[c.action]} variant="light">
                  {t(`import.actions.${c.action}`)}
                </Badge>
              </Table.Td>
              <Table.Td className="nowrap">{kindLabel(c.kind)}</Table.Td>
              <Table.Td>
                <Text size="sm">{c.name}</Text>
                <Text size="xs" c="dimmed" className="mono">
                  {c.kind === 'site' || !c.siteId ? c.id : `${c.siteId} / ${c.id}`}
                </Text>
              </Table.Td>
              <Table.Td>{what(c)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {more}
    </div>
  );
}

/** The server's notes, as keys of their translations. */
function noteKey(note: string): 'exists' | 'notInSource' | 'marked' | 'markedHolds' | 'namesRemoved' | 'other' {
  if (note.startsWith('exists')) return 'exists';
  if (note === 'not in source') return 'notInSource';
  if (note.startsWith('kept, marked "not in source" (')) return 'markedHolds';
  if (note.startsWith('kept, marked')) return 'marked';
  if (note.startsWith('names a')) return 'namesRemoved';
  return 'other';
}
